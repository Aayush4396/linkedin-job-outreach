import os

DB = os.getenv("DATABASE_PATH", "hiremate.sqlite3")
FEED = os.getenv("POST_FEED_URL", "")
FEED_AUTH_HEADER = os.getenv("FEED_AUTH_HEADER", "")
INTERVAL = int(os.getenv("SCAN_INTERVAL_MINUTES", "480"))
PROJECT = os.getenv("GCP_PROJECT", "")
REGION = os.getenv("GCP_REGION", "us-central1")
MODEL = os.getenv("GEMINI_MODEL", "")
BUCKET = os.getenv("RESUME_BUCKET", "")
PIN = os.getenv("DASHBOARD_PIN", "")
DRY = os.getenv("DRY_RUN", "true").lower() != "false"
APPROVAL = os.getenv("APPROVAL_MODE", "true").lower() != "false"
CAP = min(20, max(0, int(os.getenv("MAX_EMAILS_PER_DAY", "20"))))
ZONE = os.getenv("OUTREACH_TIMEZONE", "Asia/Kolkata")
ADDRESS = os.getenv("GMAIL_ADDRESS", "")
PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
EXTERNAL = os.getenv("EXTERNAL_SCHEDULER", "false").lower() == "true"

WORKER = os.getenv("WORKER_ONLY", "false").lower() == "true"
LINKEDIN_COOKIE = os.getenv("LINKEDIN_LI_AT_COOKIE", "")
LINKEDIN_QUERY = os.getenv("LINKEDIN_QUERY", "hiring")
GEMINI_WORKERS = max(1, min(16, int(os.getenv("GEMINI_WORKERS", "4"))))
