import asyncio
import base64
import json
import logging
import random
import time
from datetime import datetime, timezone
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
from .search import Search, saved_search
from .sources import validate
from .post_discovery import application_link, is_linkedin_search, linkedin_id
from .store import EMAIL, import_preview
from .workflow import claim_manual_scan, collect, collect_results, dispatch, prepare, review

__all__ = [
    "app",
    "CloudJsonFormatter",
    "repeat",
    "setup_logging",
]


class CloudJsonFormatter(logging.Formatter):
    SEVERITY_MAP = {
        logging.DEBUG: "DEBUG",
        logging.INFO: "INFO",
        logging.WARNING: "WARNING",
        logging.ERROR: "ERROR",
        logging.CRITICAL: "CRITICAL",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "severity": self.SEVERITY_MAP.get(record.levelno, "DEFAULT"),
            "message": record.getMessage(),
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "logger": record.name,
        }
        if record.exc_info:
            exc = self.formatException(record.exc_info)
            payload["exception"] = exc
            payload["message"] = payload["message"] + "\n" + exc
        return json.dumps(payload)


def setup_logging():
    if cfg.BUCKET:
        handler = logging.StreamHandler()
        handler.setFormatter(CloudJsonFormatter())
        root_logger = logging.getLogger()
        root_logger.handlers = [handler]
        root_logger.setLevel(logging.INFO)


async def repeat(function, seconds):
    while True:
        try:
            await asyncio.to_thread(function)
        except Exception:
            logging.exception("Background %s failed", function.__name__)
        await asyncio.sleep(seconds)


@asynccontextmanager
async def lifespan(app):
    setup_logging()
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
    for row in rows:
        if row["status"] == "Unverified lead":
            row["apply_link"] = application_link(row["text"])
            row["preview_has_email"] = bool(EMAIL.search(row["text"]))
    today = datetime.now(ZoneInfo(cfg.ZONE)).date().isoformat()
    sent_today = sum(p.get("sent_day") == today for p in rows)
    health = read("settings", "linkedin") or {}
    return {"search": saved_search().model_dump(), "sent_today": sent_today, "rotate": bool(cfg.BUCKET and cfg.LINKEDIN_COOKIE and not cfg.FEED),
            "connection": "Reconnect your account" if health.get("expired") else ("Connected" if health.get("connected") else "Awaiting scan"),
            "source": "Connected feed" if cfg.FEED else ("LinkedIn search" if cfg.LINKEDIN_COOKIE else "Sample posts"), "posts": rows,
            "resume": read("settings","resume"), "dry": cfg.DRY, "approval": (read("settings","approval") or {"required":cfg.APPROVAL})["required"]}


@app.post("/api/scan")
def scan_now():
    retry_after = claim_manual_scan()
    if retry_after:
        raise HTTPException(429, f"Please try again in {retry_after} seconds.",
                            headers={"Retry-After": str(retry_after)})
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


@app.post("/api/preferences/search")
def update_search(search: Search):
    transact(lambda get, put: put("settings", "search", search.model_dump()))
    return {"url": search.url()}


class BrowserPost(BaseModel):
    url: str = Field(max_length=2048)
    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=30000)
    published: str = Field(max_length=40)
    date_kind: Literal["published", "observed", "unknown"]
    content_kind: Literal["full", "snippet"]
    verification_note: str = Field(default="", max_length=240)


@app.post("/api/browser-results")
def browser_results(request: Request, posts: list[BrowserPost]):
    if not cfg.DRY or cfg.BUCKET or request.url.hostname not in {"localhost","127.0.0.1","testserver"}:
        raise HTTPException(403, "Browser testing requires a local dashboard in practice mode.")
    if len(posts) > 30 or any(
        not linkedin_id(p.url) and not (p.content_kind == "snippet" and is_linkedin_search(p.url))
        for p in posts
    ):
        raise HTTPException(422, "Expected LinkedIn posts or search previews.")
    rows = validate([p.model_dump() for p in posts])
    for row, post in zip(rows, posts):
        if post.verification_note:
            row["verification_note"] = post.verification_note
    return {"new": collect_results(rows, saved_search()), "checked": len(rows)}
