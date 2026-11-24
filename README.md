# HireMate

HireMate discovers hiring posts from LinkedIn (via the Chrome extension), an authorized HTTPS JSON feed, or direct manual paste; evaluates role fit against your uploaded résumé using server-side Gemini AI; and drafts editable, reviewable application outreach.

## Quick Start (Local Development)

Requires **Node.js 22+** and `npm`:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. The initial sample scan runs automatically on startup in Practice Mode (`DRY_RUN=true`).

1. Open **My résumé** and upload a `.docx`, `.pdf`, or `.txt` résumé.
2. Review generated drafts in **Outreach queue**, edit the subject/body, and click **Approve and queue** or **Skip**.
3. Use **Paste hiring post** to import any LinkedIn or web hiring post directly without an extension.
4. Run unit tests and typechecks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Chrome Extension Mode (`browser/`)

The unpacked Chrome MV3 extension in `browser/` works with **both** your local dashboard (`http://localhost:3000/`) and hosted Cloud Run dashboards (`https://*.run.app/`) without exporting LinkedIn session cookies:

1. Open `chrome://extensions` in the desktop Chrome profile where you are signed in to LinkedIn.
2. Enable **Developer mode**, choose **Load unpacked** (or click **Reload** if already installed), and select the `browser/` directory.
3. Open your HireMate dashboard directly in a top-level Chrome tab and click **Find posts in my browser** (or **Check saved leads again** on unverified previews).

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
