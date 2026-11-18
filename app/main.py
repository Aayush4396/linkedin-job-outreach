import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from .sources import read_posts
from .store import recent, scan

DB = os.getenv("DATABASE_PATH", "hiremate.sqlite3")
FEED = os.getenv("POST_FEED_URL", "")
INTERVAL = int(os.getenv("SCAN_INTERVAL_MINUTES", "480"))


def collect():
    return scan(DB, read_posts(FEED))


async def scheduled():
    while True:
        try:
            await asyncio.to_thread(collect)
        except Exception:
            logging.error("Scheduled scan failed. Check feed configuration and database access.")
        await asyncio.sleep(INTERVAL * 60)


@asynccontextmanager
async def lifespan(app):
    if INTERVAL < 1:
        raise ValueError("Choose a positive scan interval")
    scan(DB, [])
    task = asyncio.create_task(scheduled())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(title="HireMate", lifespan=lifespan)


@app.get("/")
def dashboard():
    return FileResponse(Path(__file__).with_name("index.html"))


@app.get("/api/posts")
def posts():
    return {"source": "Connected feed" if FEED else "Sample posts", "posts": recent(DB)}


@app.post("/api/scan")
def scan_now():
    try:
        return {"new": collect()}
    except (ValueError, OSError, AttributeError) as exc:
        raise HTTPException(502, "Could not read the post feed.") from exc
