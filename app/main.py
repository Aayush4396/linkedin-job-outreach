import asyncio
import base64
import logging
import random
import time
from datetime import datetime
from zoneinfo import ZoneInfo
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import settings as cfg
from .resumes import save
from .storage import all_posts, read, transact
from .store import import_preview
from .workflow import collect, dispatch, prepare, review


async def repeat(function, seconds):
    while True:
        try:
            await asyncio.to_thread(function)
        except Exception:
            logging.error("Background %s failed", function.__name__)
        await asyncio.sleep(seconds)


@asynccontextmanager
async def lifespan(app):
    if cfg.INTERVAL < 1 or (cfg.BUCKET and not cfg.PIN):
        raise ValueError("Check the scan interval and dashboard credentials")
    if not cfg.DRY and not all((cfg.MODEL, cfg.FEED or cfg.LINKEDIN_COOKIE, cfg.ADDRESS, cfg.PASSWORD, cfg.PIN)):
        raise ValueError("Live delivery requires a feed, Vertex model, Gmail credentials and dashboard login")
    await asyncio.to_thread(import_preview)
    tasks = [] if cfg.EXTERNAL else [asyncio.create_task(repeat(collect, cfg.INTERVAL * 60)),
                                      asyncio.create_task(repeat(dispatch, 30))]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="HireMate", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def access(request, next_handler):
    path = request.url.path
    if cfg.WORKER:
        # This deployment is IAM-private and only accepts scheduled operations.
        if path not in {"/api/scheduled-scan", "/api/dispatch"} or request.method != "POST":
            return JSONResponse({}, 404)
    else:
        if path in {"/api/scheduled-scan", "/api/dispatch"}:
            return JSONResponse({}, 404)
        if cfg.PIN:
            expected = "Basic " + base64.b64encode(("hiremate:" + cfg.PIN).encode()).decode()
            if not secrets.compare_digest(request.headers.get("authorization", "").encode(), expected.encode()):
                return JSONResponse({}, 401, headers={"WWW-Authenticate": 'Basic realm="HireMate"'})
        elif request.url.hostname not in {"localhost","127.0.0.1","::1","testserver"}:
            return JSONResponse({}, 403)
        if request.method == "POST" and request.headers.get("x-hiremate") != "1":
            return JSONResponse({}, 403)
    response = await next_handler(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/")
def dashboard():
    return FileResponse(Path(__file__).with_name("index.html"))


@app.get("/api/posts")
def posts():
    rows = sorted(all_posts(), key=lambda p: p["published"], reverse=True)
    today = datetime.now(ZoneInfo(cfg.ZONE)).date().isoformat()
    sent_today = sum(p.get("sent_day") == today for p in rows)
    health = read("settings", "linkedin") or {}
    return {"sent_today": sent_today, "rotate": bool(cfg.BUCKET and cfg.LINKEDIN_COOKIE and not cfg.FEED),
            "connection": "Reconnect your account" if health.get("expired") else ("Connected" if health.get("connected") else "Awaiting scan"),
            "source": "Connected feed" if cfg.FEED else ("LinkedIn search" if cfg.LINKEDIN_COOKIE else "Sample posts"), "posts": rows,
            "resume": read("settings","resume"), "dry": cfg.DRY, "approval": (read("settings","approval") or {"required":cfg.APPROVAL})["required"]}


@app.post("/api/scan")
def scan_now():
    try:
        return {"new": collect()}
    except Exception as exc:
        raise HTTPException(502, "Could not finish checking posts. Check the feed and drafting settings.") from exc


@app.post("/api/scheduled-scan")
def schedule_scan():
    due = time.time() + random.randint(5, 35) * 60
    def schedule(get, put):
        if not (get("settings", "scan_timer") or {}).get("due"):
            put("settings", "scan_timer", {"due": due})
    transact(schedule)
    return {"scheduled": True}


@app.post("/api/dispatch")
def send_next():
    processed = dispatch()
    now = time.time()
    def claim(get, put):
        timer = get("settings", "scan_timer") or {}
        if timer.get("due") and timer["due"] <= now:
            # A failed or interrupted scan becomes eligible again after its lease.
            put("settings", "scan_timer", {"due": now + 960})
            return True
        return False
    timer = read("settings", "scan_timer") or {}
    if timer.get("due") and timer["due"] <= now and transact(claim):
        collect()
        transact(lambda get, put: put("settings", "scan_timer", {}))
    return {"processed": processed}


@app.post("/api/resume")
async def upload(request: Request):
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > 8_000_000:
            raise HTTPException(413, "Choose a file smaller than 8 MB.")
        content.extend(chunk)
    try:
        resume = await asyncio.to_thread(save, unquote(request.headers.get("x-filename", "")), bytes(content))
    except Exception as exc:
        raise HTTPException(422, "Could not read this file. Check the file format and the document conversion tools.") from exc
    try:
        await asyncio.to_thread(prepare)
    except Exception as exc:
        raise HTTPException(502, "Résumé saved. Drafting failed. Check the model settings and retry the scan.") from exc
    return {"name": resume["name"]}


class Edit(BaseModel):
    subject: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    message: str = Field(min_length=1, max_length=6000)
    action: Literal["save","approve","skip"]


@app.post("/api/posts/{uid}")
def edit(uid: str, edit: Edit):
    if len(uid) != 64 or not uid.isalnum():
        raise HTTPException(404)
    try:
        review(uid, edit.subject, edit.message, edit.action)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True}




class ApprovalSetting(BaseModel):
    required: bool


@app.post("/api/preferences/approval")
def approval(setting: ApprovalSetting):
    transact(lambda get, put: put("settings", "approval", {"required":setting.required}))
    return {"required": setting.required}


class Connection(BaseModel):
    cookie: str = Field(min_length=10, max_length=8192)


@app.post("/api/connection")
def update_connection(connection: Connection):
    if not cfg.BUCKET or not cfg.LINKEDIN_COOKIE or cfg.FEED:
        raise HTTPException(409, "Connection updates require the cloud LinkedIn connector.")
    from .linkedin import rotate_cookie
    rotate_cookie(connection.cookie)
    transact(lambda get, put: put("settings", "linkedin", {"connected":False}))
    return {"ok": True}
