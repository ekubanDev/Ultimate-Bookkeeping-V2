#!/usr/bin/env bash
#
# One-time GCP bootstrap for the deploy pipeline (.github/workflows/deploy.yml).
#
# Creates the infrastructure that workflow assumes exists: an Artifact
# Registry repo, two least-privilege service accounts, a Workload Identity
# pool/provider bound to this one GitHub repo, and a Secret Manager entry for
# the database URL.
#
# NOT created here: the Cloud SQL instance. It is the only resource in this
# file that bills continuously from the moment it exists (~$10-25/month on the
# smallest tier, whether or not anything connects), so it stays an explicit,
# deliberate command you run yourself — see `create_cloud_sql` at the bottom.
#
# Idempotent, in the same refuse-rather-than-clobber spirit as
# apps/api/scripts/seed_dev.py: every step checks for the resource first and
# skips if it already exists. Re-running is safe and is the intended way to
# fill in a step that failed partway.
#
# Usage:
#   ./infra/bootstrap-gcp.sh
#   ./infra/bootstrap-gcp.sh --dry-run     # print what would run, change nothing

set -euo pipefail

PROJECT_ID="ultimate-bookkeeping-v2"
PROJECT_NUMBER="1059719871486"
REGION="europe-west1"
REPOSITORY="ultimate-bookkeeping"
SERVICE="ultimate-bookkeeping-api"

# The GitHub repo allowed to impersonate the deploy service account. This
# value is a SECURITY BOUNDARY, not configuration — see the attribute
# condition on the provider below.
GITHUB_REPO="ekubanDev/Ultimate-Bookkeeping-V2"

POOL="github-actions"
PROVIDER="github"
DEPLOY_SA="gh-deploy"
RUNTIME_SA="api-runtime"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

info()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
skip()  { printf '    already exists, skipping: %s\n' "$*"; }

# made/bound report what happened, and must not claim a change that a dry run
# did not make — a bootstrap script whose output can't be taken literally is
# worse than no output.
made()  { if (( DRY_RUN )); then printf '    would create: %s\n' "$*"; else printf '    created: %s\n' "$*"; fi; }
bound() { if (( DRY_RUN )); then printf '    would bind:   %s\n' "$*"; else printf '    bound %s\n' "$*"; fi; }

run() {
  if (( DRY_RUN )); then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# Guard against the single most expensive mistake available here: running this
# against one of the other six "bookkeeping" projects on this account.
info "Target project"
printf '    project: %s (%s)\n' "$PROJECT_ID" "$PROJECT_NUMBER"
actual_number="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
if [[ "$actual_number" != "$PROJECT_NUMBER" ]]; then
  echo "    ERROR: project ${PROJECT_ID} resolves to project number '${actual_number:-<not found>}'," >&2
  echo "    but this script expects ${PROJECT_NUMBER}. Refusing to run against an unexpected" >&2
  echo "    project — check the project id, or update PROJECT_NUMBER if the id was recreated." >&2
  exit 1
fi
printf '    verified\n'

# ---------------------------------------------------------------------------
# Artifact Registry — where `gcloud builds submit` pushes the API image.
# ---------------------------------------------------------------------------
info "Artifact Registry repository"
if gcloud artifacts repositories describe "$REPOSITORY" \
     --project "$PROJECT_ID" --location "$REGION" >/dev/null 2>&1; then
  skip "$REPOSITORY"
else
  run gcloud artifacts repositories create "$REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --repository-format docker \
    --description "Ultimate Bookkeeping v2 container images"
  made "$REPOSITORY"
fi

# ---------------------------------------------------------------------------
# Runtime service account — the identity the Cloud Run SERVICE runs as.
#
# Deliberately separate from the deploy identity: the running API needs to
# reach Cloud SQL and read one secret, and nothing else. It must not be able
# to deploy new revisions of itself, push images, or read other secrets. If
# the API is ever compromised, this is the blast radius.
# ---------------------------------------------------------------------------
info "Runtime service account (${RUNTIME_SA})"
RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$RUNTIME_EMAIL" \
     --project "$PROJECT_ID" >/dev/null 2>&1; then
  skip "$RUNTIME_EMAIL"
else
  run gcloud iam service-accounts create "$RUNTIME_SA" \
    --project "$PROJECT_ID" \
    --display-name "Ultimate Bookkeeping API (Cloud Run runtime)"
  made "$RUNTIME_EMAIL"
fi

for role in \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/firebaseauth.admin
do
  # firebaseauth.admin is what lets app/auth.py verify ID tokens against the
  # real project — this is the permission that replaces the service-account
  # JSON key entirely. The deployed API holds no key file at all; it uses this
  # identity. That is the whole reason GOOGLE_APPLICATION_CREDENTIALS does not
  # appear anywhere in the deploy workflow.
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${RUNTIME_EMAIL}" \
    --role "$role" \
    --condition None \
    --quiet >/dev/null
  bound "$role"
done

# ---------------------------------------------------------------------------
# Deploy service account — the identity GitHub Actions impersonates.
# ---------------------------------------------------------------------------
info "Deploy service account (${DEPLOY_SA})"
DEPLOY_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$DEPLOY_EMAIL" \
     --project "$PROJECT_ID" >/dev/null 2>&1; then
  skip "$DEPLOY_EMAIL"
else
  run gcloud iam service-accounts create "$DEPLOY_SA" \
    --project "$PROJECT_ID" \
    --display-name "GitHub Actions deployer"
  made "$DEPLOY_EMAIL"
fi

for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/firebasehosting.admin \
  roles/storage.admin \
  roles/logging.viewer
do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${DEPLOY_EMAIL}" \
    --role "$role" \
    --condition None \
    --quiet >/dev/null
  bound "$role"
done

# Deploying a Cloud Run service that RUNS AS the runtime account requires the
# deployer to be able to act as that account. Scoped to this one service
# account rather than granted project-wide.
info "Allow deployer to act as the runtime account"
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_EMAIL}" \
  --role roles/iam.serviceAccountUser \
  --quiet >/dev/null
bound "roles/iam.serviceAccountUser (scoped to ${RUNTIME_SA})"

# ---------------------------------------------------------------------------
# Workload Identity Federation — keyless auth from GitHub Actions.
#
# This exists so no service-account JSON key is ever stored in GitHub. A
# stored key is a long-lived credential that works from anywhere, forever,
# for whoever obtains it; a federated token is minted per-run, expires in
# minutes, and only for workflows in the repo named below.
# ---------------------------------------------------------------------------
info "Workload Identity pool"
if gcloud iam workload-identity-pools describe "$POOL" \
     --project "$PROJECT_ID" --location global >/dev/null 2>&1; then
  skip "$POOL"
else
  run gcloud iam workload-identity-pools create "$POOL" \
    --project "$PROJECT_ID" \
    --location global \
    --display-name "GitHub Actions"
  made "$POOL"
fi

info "Workload Identity provider"
if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --project "$PROJECT_ID" --location global \
     --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  skip "$PROVIDER"
else
  # THE ATTRIBUTE CONDITION IS THE SECURITY BOUNDARY. Without it, any GitHub
  # Actions workflow in ANY repository on github.com can present a token this
  # provider accepts, and impersonate the deploy account. It is not a filter
  # for convenience — it is the only thing making this provider specific to
  # this repository. Never relax it to a wildcard.
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project "$PROJECT_ID" \
    --location global \
    --workload-identity-pool "$POOL" \
    --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${GITHUB_REPO}'"
  made "$PROVIDER (restricted to ${GITHUB_REPO})"
fi

info "Bind the GitHub repo to the deploy service account"
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_EMAIL" \
  --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  --quiet >/dev/null
bound "$GITHUB_REPO"

# ---------------------------------------------------------------------------
# Secret Manager — DATABASE_URL, including the database password.
#
# Created empty. The real value is added by you, by hand, after the Cloud SQL
# instance exists — deliberately not generated or echoed by this script, so
# the password never passes through a terminal transcript or shell history.
# (See seed_dev.py's `_seed_firebase_real_users` for the same reasoning about
# one-time reset links.)
# ---------------------------------------------------------------------------
info "Secret Manager entry for DATABASE_URL"
if gcloud secrets describe database-url --project "$PROJECT_ID" >/dev/null 2>&1; then
  skip "database-url"
else
  run gcloud secrets create database-url \
    --project "$PROJECT_ID" \
    --replication-policy automatic
  made "database-url (no version yet — see next steps)"
fi

# ---------------------------------------------------------------------------
info "Done — values for GitHub"
cat <<EOF

Settings -> Secrets and variables -> Actions

  SECRETS (Repository secrets):
    GCP_WORKLOAD_IDENTITY_PROVIDER
      projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}

    GCP_DEPLOY_SERVICE_ACCOUNT
      ${DEPLOY_EMAIL}

    RUNTIME_SERVICE_ACCOUNT
      ${RUNTIME_EMAIL}

    CLOUD_SQL_CONNECTION_NAME
      ${PROJECT_ID}:${REGION}:<instance-name>     # after you create the instance

  VARIABLES (not secrets — these compile into the client bundle and are
  readable by anyone who opens devtools; see deploy.yml):
    VITE_FIREBASE_API_KEY        AIzaSyDtdvXWHuqBc0W0NlBbmuG6DJewdmlmHNM
    VITE_FIREBASE_AUTH_DOMAIN    ${PROJECT_ID}.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID     ${PROJECT_ID}

STILL TO DO, in order:

  1. Create the Cloud SQL instance. THIS STARTS BILLING (~\$10-25/month,
     continuously, from creation — it does not scale to zero).

     Every flag below is load-bearing; an instance was once created here at
     db-perf-optimized-N-8 / us-east1 / POSTGRES_18 / backups off, which is
     30-50x the needed size, in a region that mismatches deploy.yml, on a
     major version CI never tests, with no backups on a financial database.
     Defaults and console clicks do not produce this configuration:

       --database-version POSTGRES_16  matches CI's postgres:16 service
                                       container. Deploy what you test.
       --edition ENTERPRISE            REQUIRED. New instances here default
                                       to ENTERPRISE_PLUS, whose only machine
                                       types are db-perf-optimized-N-* (8
                                       vCPU up, hundreds of dollars a month).
                                       Shared-core tiers do not exist in that
                                       edition, so without this flag a
                                       right-sized instance is uncreatable.
       --tier db-f1-micro              sized for a pilot. Revisit under real
                                       load, deliberately.
       --region ${REGION}          MUST match REGION in deploy.yml and the
                                       rewrite in firebase.json.
       --backup-start-time             enables backups at all. This is the
                                       financial record of a business.
       --deletion-protection           one flag between you and \`sql
                                       instances delete\`.

       gcloud sql instances create ubk-postgres \\
         --project ${PROJECT_ID} \\
         --database-version POSTGRES_16 \\
         --edition ENTERPRISE \\
         --tier db-f1-micro \\
         --region ${REGION} \\
         --storage-size 10GB \\
         --storage-type SSD \\
         --storage-auto-increase \\
         --backup-start-time 02:00 \\
         --retained-backups-count 7 \\
         --availability-type zonal \\
         --deletion-protection

       # Close the plaintext path over the public IP. No authorized networks
       # are added, so the IAM-authenticated Cloud SQL Auth proxy — which is
       # how Cloud Run connects — is the only route in.
       gcloud sql instances patch ubk-postgres \\
         --project ${PROJECT_ID} --ssl-mode ENCRYPTED_ONLY

       gcloud sql databases create ultimate_bookkeeping \\
         --project ${PROJECT_ID} --instance ubk-postgres

       gcloud sql users create ubk_app \\
         --project ${PROJECT_ID} --instance ubk-postgres --prompt-for-password

  2. Add the DATABASE_URL secret version. Note the EMPTY host — the socket
     path comes from CLOUD_SQL_CONNECTION_NAME via connect_args in
     apps/api/app/db.py, not from this URL:

       printf '%s' 'postgresql+asyncpg://ubk_app:PASSWORD@/ultimate_bookkeeping' \\
         | gcloud secrets versions add database-url --project ${PROJECT_ID} --data-file=-

     Use a leading space so the command stays out of shell history, and do
     not put the password in a file.

  3. Set the GitHub secrets and variables above.

  4. Run the Deploy workflow manually (type "deploy" to confirm).

EOF

if (( DRY_RUN )); then
  printf '\n(dry run — nothing was created)\n'
fi
