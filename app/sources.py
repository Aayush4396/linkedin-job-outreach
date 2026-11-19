"""Read an operator-configured HTTPS JSON feed or bundled sample posts."""
import json
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from . import settings as cfg
from .post_discovery import linkedin_id

__all__ = [
    "read_posts",
    "validate",
]


def read_posts(feed_url):
    if feed_url:
        if urlsplit(feed_url).scheme != "https":
            raise ValueError("Feed URL must use HTTPS")
        headers = {"User-Agent": "HireMate/1.0"}
        if cfg.FEED_AUTH_HEADER:
            headers["Authorization"] = cfg.FEED_AUTH_HEADER
        req = Request(feed_url, headers=headers)
        with urlopen(req, timeout=15) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Feed exceeds size limit")
    else:
        raw = Path(__file__).with_name("sample.json").read_bytes()
    return validate(json.loads(raw))


def validate(posts):
    if not isinstance(posts, list):
        raise ValueError("Expected a list of posts")
    for post in posts:
        for field in ("url", "title", "text"):
            if not isinstance(post.get(field), str) or not post[field].strip():
                raise ValueError(f"Missing post field {field}")
        if urlsplit(post["url"]).scheme != "https":
            raise ValueError("Invalid post URL")
        if post.get("date_kind", "published") in {"published", "relative"}:
            try:
                date.fromisoformat(post.get("published", ""))
            except (TypeError, ValueError):
                if not linkedin_id(post["url"]) and post.get("date_kind") != "relative":
                    raise ValueError("Missing or invalid publication date")
                post["date_kind"] = "unknown"
                post["published"] = ""
        post.setdefault("published", "")
    return [{field: post[field] for field in ("url", "published", "title", "text", "date_kind", "content_kind") if field in post} for post in posts]
