import re
import sqlite3
from contextlib import closing


ROLE = re.compile(r"\b(machine learning|artificial intelligence|model evaluation|language models?|computer vision|mlops|nlp|llms?|applied scientist|research engineer|(?:ai|ml) engineer)\b", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.I)


def scan(path, posts):
    with closing(sqlite3.connect(path, timeout=20)) as db, db:
        db.execute("""CREATE TABLE IF NOT EXISTS posts (
            url TEXT PRIMARY KEY, published TEXT, title TEXT, body TEXT,
            recipient TEXT, status TEXT, UNIQUE(recipient))""")
        inserted = 0
        for post in posts:
            recipient = None
            status = "Outside target roles"
            if ROLE.search(post["title"] + " " + post["text"]):
                addresses = sorted(set(x.lower() for x in EMAIL.findall(post["text"])))
                if len(addresses) == 1:
                    recipient = addresses[0]
                    status = "Ready for review"
                else:
                    status = "Check recipients" if addresses else "No email listed"
            if db.execute("SELECT 1 FROM posts WHERE recipient=?", (recipient,)).fetchone():
                recipient, status = None, "Recipient already seen"
            result = db.execute("INSERT OR IGNORE INTO posts VALUES (?,?,?,?,?,?)",
                                (post["url"], post["published"], post["title"], post["text"], recipient, status))
            inserted += result.rowcount
        return inserted


def recent(path):
    with closing(sqlite3.connect(path)) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("SELECT * FROM posts ORDER BY published DESC, rowid LIMIT 200")]
