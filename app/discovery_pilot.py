"""Run two independent reads of a configured live source without drafting or delivery."""
import sys
import tempfile
from pathlib import Path

from . import settings as cfg
from .post_discovery import linkedin_id
from .sources import read_posts
from .storage import all_posts
from .workflow import capture

__all__ = [
    "pilot",
    "main",
]


def pilot(fetch):
    with tempfile.TemporaryDirectory() as folder:
        from unittest.mock import patch
        with patch.multiple(cfg, DB=str(Path(folder) / "pilot.sqlite3"), BUCKET=""):
            qualified = set()
            for run in (1, 2):
                rows = [p for p in fetch() if linkedin_id(p["url"])]
                before = {linkedin_id(p["url"]) for p in all_posts()}
                inserted = sum(capture(p, False) for p in rows)
                after = all_posts()
                incoming = {linkedin_id(p["url"]) for p in rows}
                duplicates = before & incoming
                print(f"Scan {run}: {len(incoming)} distinct post IDs, {inserted} new records, {len(duplicates)} previously seen")
                if len(after) != len(before | incoming):
                    raise RuntimeError("Duplicate or missing records")
                if run == 1:
                    qualified = {linkedin_id(p["url"]) for p in after if p["status"] in {"Needs draft", "Apply via link"}}
                    print(f"Recent hiring posts with application instructions: {len(qualified)}")
                else:
                    return bool(qualified & duplicates)


def main():
    if cfg.FEED:
        fetch = lambda: read_posts(cfg.FEED)
    elif cfg.LINKEDIN_COOKIE:
        from .linkedin import collect_posts, current_cookie
        cookie = current_cookie()
        fetch = lambda: collect_posts(cookie, cfg.LINKEDIN_QUERY)
    else:
        sys.exit("Set POST_FEED_URL to an authorized live feed or configure the authorized LinkedIn connector.")
    if not pilot(fetch):
        sys.exit("Live milestone pending: a qualified post must appear on both scans.")
    print("Verified a recurring qualified post and suppressed its duplicate.")


if __name__ == "__main__":
    main()
