# HireMate

HireMate discovers hiring posts from LinkedIn (via the Chrome extension), an authorized HTTPS JSON feed, or direct manual paste; evaluates role fit against your uploaded résumé using server-side Gemini AI; and drafts editable, reviewable outreach across email and LinkedIn.

## Key Capabilities

- **Automatic Email Drafting**: Any verified hiring post containing an actionable email address (excluding `no-reply@` / `mailer-daemon@`) automatically receives a résumé-grounded subject and body under **Ready for review**. Each email card supports **Approve and queue**, **Open in email app** (pre-filled `mailto:` link), **Copy email**, **Save edits**, **Redraft**, and **Skip**—and any email lead without a draft can be drafted on demand.
- **Assisted LinkedIn Apply (DM / Connect / Comment)**: Posts asking candidates to DM, send a connection request, or comment (including requested keywords such as `Comment "AI"`) generate three tailored options—a **DM**, a **Connect note** enforced at LinkedIn's 300-character limit with a live counter, and a public-safe **Comment** (never exposing personal email/phone). Use **Copy & open post** to paste directly on LinkedIn, then **Mark as applied** (or **Reopen lead** later).
- **Exact Post Timestamps & Chronological Sorting**: Every post card displays its local publication date, time, and relative age (with exact UTC ISO timestamp on hover), decoded directly from LinkedIn 64-bit activity IDs, sorting same-day posts newest-first.
- **Account-Safe Discovery**: Server-side `li_at` cookie scraping is intentionally not used. Live LinkedIn discovery runs exclusively through your own signed-in Chrome browser via the MV3 extension.

## Quick Start (Local Development)

Requires **Node.js 22+** and `npm`:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The initial sample scan runs automatically on startup in Practice Mode (`DRY_RUN=true`).

1. Open **My résumé** and upload a `.docx`, `.pdf`, or `.txt` résumé.
2. Enter your role, location, workplace, and employment filters in the **LinkedIn search filters** bar at the top of **Outreach queue** and click **Fetch posts** (with the Chrome extension connected), or use **Paste hiring post** to import any hiring post manually.
3. Review generated email drafts in **Ready for review**, or open **Link / DM** for Assisted LinkedIn Apply and external application links.
4. Run unit tests, typecheck, lint, and production build:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Chrome Extension Mode (`browser/`)

The unpacked Chrome MV3 extension in `browser/` works with **both** your local dashboard (`http://localhost:3000/`) and hosted Cloud Run dashboards (`https://*.run.app/`) without exporting LinkedIn session cookies:

1. In HireMate, open **Chrome extension** and click **Download extension ZIP** (or use the local `browser/` folder directly) and unzip it.
2. Open `chrome://extensions` in the desktop Chrome profile where you are signed in to LinkedIn.
3. Enable **Developer mode**, choose **Load unpacked** (or click **Reload** after extension changes), and select the unzipped folder.
4. Open your HireMate dashboard in a top-level Chrome tab, enter your filters in **LinkedIn search filters**, and click **Fetch posts** (or **Check saved leads again** on unverified previews).


## Environment Variables

See `.env.example` for all supported variables. Keep secrets strictly in environment variables or Google Cloud Secret Manager—never hardcode API keys or credentials.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Blank | Server-side Gemini API key (configured via Secret Manager in Cloud Run). |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Preferred Gemini model (automatically falls back to `gemini-3.1-flash-lite` / `gemini-flash-latest` on transient errors). |
| `POST_FEED_URL` | Blank | Public HTTPS JSON feed polled by **Check for posts**. |
| `FEED_AUTH_HEADER` | Blank | Optional `Authorization` header for protected HTTPS feeds (store in Secret Manager). |
| `DASHBOARD_PIN` | Blank | Optional Basic/Bearer authentication PIN for remote deployments (store in Secret Manager). |
| `DRY_RUN` | `true` | Keeps outreach in practice/simulation mode when `true`. |
| `APPROVAL_MODE` | `true` | Requires manual review of new drafts before queuing. |
| `MAX_EMAILS_PER_DAY` | `20` | Daily delivery cap (`0`–`20`). |
| `OUTREACH_TIMEZONE` | `Asia/Kolkata` | Local timezone used for daily cap tracking. |

## Deploying to Google Cloud Run

### 1. Prerequisites & Enable APIs

Install the [Google Cloud SDK (`gcloud`)](https://cloud.google.com/sdk/docs/install) and enable required APIs:

```bash
export GCP_PROJECT="YOUR_PROJECT_ID"
export GCP_REGION="us-central1"

gcloud config set project "$GCP_PROJECT"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com
```

### 2. Secret Manager Setup

Store `GEMINI_API_KEY` (and optional `DASHBOARD_PIN` / `FEED_AUTH_HEADER`) in Google Cloud Secret Manager and grant your Cloud Run runtime service account access:

```bash
# Create and populate the secret
gcloud secrets create GEMINI_API_KEY --replication-policy="automatic"
echo -n "YOUR_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-

# Grant the default Cloud Run service account access to read the secret
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Firestore Security Rules (When Enabling Cloud Persistence)

If you provision Firestore for multi-user cloud persistence, enforce strict owner-bound isolation in `firestore.rules` (never use `allow read, write: if true;`):

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/interactions/{interactionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Deploy rules with `firebase deploy --only firestore:rules`.

### 4. Deploy to Cloud Run

```bash
gcloud run deploy hiremate \
  --source . \
  --region "$GCP_REGION" \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest" \
  --set-env-vars="DRY_RUN=true,APPROVAL_MODE=true,OUTREACH_TIMEZONE=Asia/Kolkata" \
  --allow-unauthenticated
```

### 5. Apply Campaign Verification Label

```bash
gcloud run services update hiremate \
  --update-labels=dev-tutorial=cloud-run-ai-challenge \
  --region="$GCP_REGION"
```
