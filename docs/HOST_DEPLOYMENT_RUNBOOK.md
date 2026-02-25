# Host Deployment Runbook

This repo includes ready templates for:
- Render: `render.yaml`
- Fly.io: `fly.toml`
- Google Cloud Build + Cloud Run: `cloudbuild.yaml`

## Shared prerequisites
1. Configure all production env vars from `.env.production.example`.
2. Provision managed Postgres and set:
   - `DATABASE_PROVIDER=postgresql`
   - `DATABASE_URL=postgresql://...`
3. Keep rollout controlled:
   - `ROLLOUT_CANARY_ONLY=true`
   - `ROLLOUT_CANARY_SHOPS=...`

## Render
1. Create Blueprint from repo root.
2. Render will detect `render.yaml` and create:
   - `netcash-web` (web service)
   - `netcash-worker` (background worker)
3. Set all missing secrets in Render dashboard.
4. Trigger deploy.
5. Validate:
   - `npm run check:go-no-go`
   - `/health`, `/health/readiness`

## Fly.io
1. Create app:
   - `fly launch --no-deploy`
2. Ensure `fly.toml` exists in repo root (already added).
3. Set secrets:
   - `fly secrets set KEY=VALUE ...`
4. Deploy:
   - `fly deploy`
5. Scale process groups:
   - `fly scale count app=1 worker=1`
6. Validate:
   - `fly logs`
   - app health endpoints

## Google Cloud Run
1. Create Artifact Registry repo:
   - `gcloud artifacts repositories create netcash-ai --repository-format=docker --location=asia-south1`
2. Create Cloud Run bootstrap job (one-time) named `netcash-bootstrap`:
   - image: same app image
   - command: `npm`
   - args: `run prisma:push:prod && BOOTSTRAP_RUN_DB_PUSH=true npm run check:prod-bootstrap`
3. Trigger build/deploy:
   - `gcloud builds submit --config cloudbuild.yaml`
4. Validate:
   - service logs for `netcash-web` and `netcash-worker`
   - health/readiness endpoints

## Shopify app deploy (after host is live)
1. `shopify app config use shopify.app.production.toml`
2. `shopify app deploy --config shopify.app.production.toml`
3. Confirm `application_url` and `auth.redirect_urls` match live HTTPS domain.
