"""Read an operator-configured HTTPS JSON feed or bundled sample posts."""
import json
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen


def read_posts(feed_url):
    if feed_url:
        if urlsplit(feed_url).scheme != "https":
            raise ValueError("Feed URL must use HTTPS")
        with urlopen(feed_url, timeout=15) as response:
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
        for field in ("url", "published", "title", "text"):
            if not isinstance(post.get(field), str) or not post[field].strip():
                raise ValueError(f"Missing post field {field}")
        if urlsplit(post["url"]).scheme != "https":
            raise ValueError("Invalid post URL")
        date.fromisoformat(post["published"])
    return [{field: post[field] for field in ("url", "published", "title", "text")} for post in posts]
