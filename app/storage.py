"""Document transactions shared by the local and Cloud Run backends."""
import json
import sqlite3
from contextlib import closing
from functools import lru_cache

from . import settings as cfg


@lru_cache
def cloud():
    from google.cloud import firestore
    return firestore.Client(project=cfg.PROJECT)


def transact(operation):
    if cfg.BUCKET:
        from google.cloud import firestore
        client = cloud()

        @firestore.transactional
        def execute(tx):
            def ref(group, key):
                return client.collection("hiremate_" + group).document(key)

            def get(group, key):
                return ref(group, key).get(transaction=tx).to_dict()

            def put(group, key, value):
                tx.set(ref(group, key), value)

            return operation(get, put)
        return execute(client.transaction())

    with closing(sqlite3.connect(cfg.DB, timeout=30)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id))")
        db.execute("BEGIN IMMEDIATE")

        def get(group, key):
            row = db.execute("SELECT value FROM records WHERE kind=? AND id=?", (group, key)).fetchone()
            return json.loads(row[0]) if row else None

        def put(group, key, value):
            db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?)", (group, key, json.dumps(value)))

        return operation(get, put)


def read(group, key):
    return transact(lambda get, put: get(group, key))


def iter_posts(status=None):
    if cfg.BUCKET:
        query = cloud().collection("hiremate_posts")
        if status:
            from google.cloud.firestore_v1.base_query import FieldFilter
            if isinstance(status, str):
                query = query.where(filter=FieldFilter("status", "==", status))
            else:
                query = query.where(filter=FieldFilter("status", "in", list(status)))
        for doc in query.stream():
            yield doc.to_dict()
        return

    transact(lambda get, put: None)
    with closing(sqlite3.connect(cfg.DB)) as db:
        sql = "SELECT value FROM records WHERE kind='posts'"
        params = ()
        if status:
            if isinstance(status, str):
                sql += " AND json_extract(value,'$.status')=?"
                params = (status,)
            else:
                status_list = list(status)
                if not status_list:
                    return
                placeholders = ",".join("?" for _ in status_list)
                sql += f" AND json_extract(value,'$.status') IN ({placeholders})"
                params = tuple(status_list)
        rows = [row[0] for row in db.execute(sql, params).fetchall()]
    for value in rows:
        yield json.loads(value)


def all_posts(status=None):
    return list(iter_posts(status))
