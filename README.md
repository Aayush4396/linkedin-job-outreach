# HireMate

HireMate discovers hiring posts for the roles in your saved search from a configured HTTPS JSON feed, extracts explicit email addresses, and prepares résumé-based email drafts. The phone dashboard lets you upload your résumé, inspect the extracted text, edit a draft, and approve or skip it. Drafts retain their original attachment even if you later replace your résumé.

## Try it locally

Use Python 3.11 or newer. Run these commands from the repository root:

    python -m venv .venv
    .venv\Scripts\activate
    python -m pip install -r requirements.txt
    python -m uvicorn app.main:app

Open http://127.0.0.1:8000. The initial sample scan runs at startup. Upload a résumé, review the sample application, approve it, and reload after 30 seconds to see “Simulated”. With no Vertex model configured, the preview uses a generic template. Sample posts and practice-mode drafts always simulate delivery. Local settings are process environment variables. See .env.example. Store the SQLite database and data/resumes together. The local scheduler runs only while the process is open.

TXT, DOCX, and text-based PDF parsing use Python libraries. Legacy DOC conversion uses LibreOffice. Image-only PDF pages use Poppler and English Tesseract OCR. The supplied Docker image installs all three system tools. For the same environment locally:

    docker build -t hiremate .
    docker run --rm -p 127.0.0.1:8000:8080 -v hiremate-preview:/srv/data -e DATABASE_PATH=/srv/data/hiremate.sqlite3 hiremate

## Connect real hiring posts and drafting

Set POST_FEED_URL to a feed you are authorized to access. The endpoint must return a JSON array of objects with url (HTTPS permalink), published (YYYY-MM-DD), title, and text (full hiring post). app/sample.json shows the contract. The service polls this URL automatically. You must supply a provider that supports LinkedIn hiring posts or adapt app/sources.py to its documented API. LinkedIn account credentials alone do not provide this feed.

If you have authorization from LinkedIn to automate a search, the optional Playwright connector reads visible hiring posts from the search results. Set LINKEDIN_LI_AT_COOKIE and LINKEDIN_QUERY with POST_FEED_URL empty (for Cloud Shell use POST_SOURCE=linkedin). The script stores the cookie in Secret Manager. A checkpoint or changed page layout can stop collection. The date shown for browser search results is the observation date. Refresh an expired connection from the cloud dashboard. The worker reads the latest Secret Manager version at scan time. For this connector outside Docker, install the matching browser with python -m playwright install chromium.

Set GCP_PROJECT, GCP_REGION, and GEMINI_MODEL for Vertex AI drafting. Choose a model available in your project and location. Locally, configure application default credentials. The cloud deployment uses its runtime service account. RESUME_BUCKET selects Cloud Storage and Firestore in place of local storage.

## Cloud Run

Run deploy.sh in Google Cloud Shell from a billing-enabled project. The deploying identity needs permission to enable services, build from source, create the listed resources and IAM bindings, deploy public and private services, and act as the runtime and scheduler accounts. Configure Cloud Build source-deployment permissions for the project's build account. Choose a Firestore-compatible region before the first deploy.

    export GCP_PROJECT=your-project-id
    export GCP_REGION=us-central1
    export GEMINI_MODEL=your-enabled-model-id
    bash deploy.sh

On first use the script prompts for the feed URL and dashboard password. Use a strong random DASHBOARD_PIN. Sign in over HTTPS with username hiremate. Cloud Scheduler invokes a separate IAM-private worker for scans at 09:00, 13:00 and 17:00 on weekdays and for one worker check per minute. Each scheduled scan starts after a randomized 5–35 minute delay. Upload your résumé from the dashboard. Keep initial deployments in practice mode. Use Secret Manager to rotate credentials and redeploy.

To enable real mail after testing, redeploy with DRY_RUN=false and supply GMAIL_ADDRESS and GMAIL_APP_PASSWORD for an eligible Gmail account. Newly created live drafts require approval by default. APPROVAL_MODE=false queues new drafts automatically. The sender reserves capacity transactionally, capped at 20 per configured local day, with a randomized 2–6 minute minimum interval between claims. Scheduler cadence may increase that interval. Simulations consume a slot too. “Check delivery” means a live send was claimed but delivery was not confirmed. Check Gmail Sent before taking further action. The worker never automatically retries an uncertain send.

## Verification

    python -m compileall app
    python -m unittest discover -s tests

The tests use temporary local data and mock external delivery. Production validation requires an authorized live feed, an enabled Vertex model, a Google Cloud project and an eligible sender mailbox.

## LinkedIn discovery pilot

Run `python -m app.discovery_pilot` with an authorized source configured. This command fetches the source twice into a temporary database and never calls Gemini or Gmail. It passes only when a relevant LinkedIn post published within 14 days has explicit application instructions and the second independent fetch returns its ID again without inserting another record. New unrelated posts on the second scan are allowed.

Feed records should carry the original publication date and full post text. Mark excerpts with `content_kind: snippet` and observation dates with `date_kind: observed`. The browser connector marks a scan date as observed when no machine-readable date is available. Such records stay unverified. Posts directing applicants to a form appear as “Apply via link”.

## Saved search and signed-in browser dry run

Open **My saved search** and enter comma-separated role terms and locations. Terms within each field are alternatives. Selected work arrangement and employment type must also appear in the post. Empty fields leave that part of the search open. HireMate compares the responsibilities and requirements against the uploaded résumé before preparing outreach. In practice mode without a model, the comparison uses shared keywords. **Check for posts** saves the settings and scans the configured server source. Settings apply to incoming results; existing review cards remain in your history.

For an interactive local pilot, open the dashboard in the **same Chrome profile** you use for LinkedIn. In Chrome’s extensions page, enable Developer mode, choose **Load unpacked**, and select this repository’s **browser** folder. Reload the dashboard. With practice mode on, upload a résumé and select **Find posts in my browser**. The extension opens a Posts search, reads identifiable result cards and sends them to the local dashboard. Click back to HireMate to review. Posts with missing dates or visibly truncated text remain unverified. LinkedIn layouts can vary; a page the extension cannot read reports an error. The extension needs no exported cookie. It runs on user request on the computer hosting HireMate; the phone dashboard and Cloud Run worker cannot control that desktop tab.
