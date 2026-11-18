# HireMate local discovery preview

From this directory with Python 3.11 or later:

    python -m pip install -r requirements.txt
    python -m uvicorn app.main:app

Open http://127.0.0.1:8000. Keep the service on loopback for this unauthenticated preview. It checks three sample posts on startup and repeats every eight hours while running. SQLite persists the results across restarts. Use “Check for posts” to run another scan immediately.

To connect an authorized JSON feed, set POST_FEED_URL in the process environment to its HTTPS endpoint. The expected list of objects is illustrated in app/sample.json. Use a different DATABASE_PATH for real data. The adapter expects the upstream provider to return hiring posts. Provider authentication, pagination and live LinkedIn access require selecting a provider.

The local matcher uses keywords and identifies explicit email addresses. Review candidates before any outreach. This milestone has no sending code. Résumé upload, Vertex AI drafting, approved delivery, authentication and Cloud Run deployment are future milestones.
