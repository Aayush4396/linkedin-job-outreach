#!/usr/bin/env bash
# Local preview launcher until the persistent Cloud Run backend is implemented.
set -eu
cd "$(dirname "$0")"
export DATABASE_PATH="${DATABASE_PATH:-hiremate.sqlite3}"
export POST_FEED_URL="${POST_FEED_URL:-}"
export SCAN_INTERVAL_MINUTES="${SCAN_INTERVAL_MINUTES:-480}"
export APPROVAL_MODE=true DRY_RUN=true MAX_EMAILS_PER_DAY=20
exec python -m uvicorn app.main:app --host 127.0.0.1
