#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
project=${GCP_PROJECT:-$(gcloud config get-value project)}
region=${GCP_REGION:-us-central1}
bucket=${RESUME_BUCKET:-"$project-hiremate-resumes"}
zone=${OUTREACH_TIMEZONE:-Asia/Kolkata}
model=${GEMINI_MODEL:?Set GEMINI_MODEL to an available Vertex AI model in your region}
dry=${DRY_RUN:-true}
approval=${APPROVAL_MODE:-true}
runtime="hiremate-runtime@$project.iam.gserviceaccount.com"
timer="hiremate-timer@$project.iam.gserviceaccount.com"
gcloud config set project "$project"
gcloud services enable run.googleapis.com aiplatform.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com
for name in hiremate-runtime hiremate-timer; do
  gcloud iam service-accounts describe "$name@$project.iam.gserviceaccount.com" >/dev/null 2>&1 || gcloud iam service-accounts create "$name"
done
for role in roles/datastore.user roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:$runtime" --role="$role" --quiet >/dev/null
done
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || gcloud firestore databases create --location="$region" --type=firestore-native
gcloud storage buckets describe "gs://$bucket" >/dev/null 2>&1 || gcloud storage buckets create "gs://$bucket" --location="$region" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$runtime" --role=roles/storage.objectUser
secrets=()
secret() {
  local key=$1 id="hiremate-${1,,}" value
  if ! gcloud secrets describe "$id" >/dev/null 2>&1; then
    value=${!key:-}
    if [[ -z "$value" ]]; then read -rsp "Enter $key: " value; echo; fi
    [[ -n "$value" ]] || { echo "Missing $key" >&2; exit 1; }
    printf %s "$value" | gcloud secrets create "$id" --data-file=- --replication-policy=automatic
  fi
  gcloud secrets add-iam-policy-binding "$id" --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  secrets+=("$key=$id:latest")
}
secret DASHBOARD_PIN
if [[ "${POST_SOURCE:-feed}" == linkedin ]]; then
  secret LINKEDIN_LI_AT_COOKIE
  gcloud secrets add-iam-policy-binding hiremate-linkedin_li_at_cookie --member="serviceAccount:$runtime" --role=roles/secretmanager.secretVersionAdder --quiet >/dev/null
else
  secret POST_FEED_URL
fi
if [[ "$dry" == false ]]; then secret GMAIL_ADDRESS; secret GMAIL_APP_PASSWORD; fi
secret_args=$(IFS=,; echo "${secrets[*]}")
envs="LINKEDIN_QUERY=${LINKEDIN_QUERY:-hiring},GCP_PROJECT=$project,GCP_REGION=$region,RESUME_BUCKET=$bucket,GEMINI_MODEL=$model,DATABASE_PATH=/tmp/hiremate.sqlite3,SCAN_INTERVAL_MINUTES=480,EXTERNAL_SCHEDULER=true,APPROVAL_MODE=$approval,DRY_RUN=$dry,MAX_EMAILS_PER_DAY=${MAX_EMAILS_PER_DAY:-20},OUTREACH_TIMEZONE=$zone,GEMINI_WORKERS=${GEMINI_WORKERS:-4},FEED_AUTH_HEADER=${FEED_AUTH_HEADER:-}"
common=(--region="$region" --service-account="$runtime" --memory=2Gi --cpu=1 --min-instances=0 --max-instances=1 --set-secrets="$secret_args" --timeout=900 --quiet)
gcloud run deploy hiremate --source=. "${common[@]}" --set-env-vars="$envs,WORKER_ONLY=false" --allow-unauthenticated
image=$(gcloud run services describe hiremate --region="$region" --format='value(spec.template.spec.containers[0].image)')
gcloud run deploy hiremate-worker --image="$image" "${common[@]}" --set-env-vars="$envs,WORKER_ONLY=true" --no-allow-unauthenticated
gcloud run services add-iam-policy-binding hiremate-worker --region="$region" --member="serviceAccount:$timer" --role=roles/run.invoker
worker=$(gcloud run services describe hiremate-worker --region="$region" --format='value(status.url)')
schedule() {
  local op=create
  if gcloud scheduler jobs describe "$1" --location="$region" >/dev/null 2>&1; then op=update; fi
  gcloud scheduler jobs "$op" http "$1" --location="$region" --schedule="$2" --time-zone="$zone" --uri="$worker/api/$3" --http-method=POST --oidc-service-account-email="$timer" --oidc-token-audience="$worker" --attempt-deadline=900s
}
schedule hiremate-scan '0 9,13,17 * * 1-5' scheduled-scan
schedule hiremate-delivery '* * * * *' dispatch
gcloud run services describe hiremate --region="$region" --format='value(status.url)'
