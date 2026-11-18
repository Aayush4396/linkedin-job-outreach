import re
import sqlite3
from contextlib import closing

from . import settings as cfg


ROLE = re.compile(
    r"\b(machine learning|artificial intelligence|model evaluation|language models?|"
    r"computer vision|generative ai|deep learning|mlops|nlp|llms?|applied scientist|"
    r"research engineer|(?:ai|ml)[ /-](?:engineer|researcher|scientist|developer))\b", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.I)


def import_preview():
    """Import the original local preview once; it never sent any mail."""
    from .workflow import capture
    from .storage import read, transact
    if cfg.BUCKET or read("settings", "imported"):
        return
    with closing(sqlite3.connect(cfg.DB)) as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='posts'").fetchone()
        if exists:
            for url, published, title, body in db.execute("SELECT url,published,title,body FROM posts ORDER BY rowid"):
                capture(dict(url=url, published=published, title=title, text=body), True)
    transact(lambda get, put: put("settings", "imported", {"done": True}))
