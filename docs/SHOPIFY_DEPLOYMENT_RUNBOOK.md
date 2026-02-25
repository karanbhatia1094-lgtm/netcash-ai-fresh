# Shopify Deployment Runbook

## 1) Pre-deploy configuration
1. Set production env vars in your host:
- `NODE_ENV=production`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES`
- `SHOPIFY_APP_URL` (same as production domain)
- `APP_BASE_URL` (same as production domain)
- `DATABASE_PROVIDER=postgresql`
- `DATABASE_URL` (Postgres only)
- `JOB_WORKER_KEY`
- `AUTOPILOT_CRON_KEY` (recommended)
- `CONNECTOR_CRON_KEY`
- `ROLLOUT_CANARY_ONLY=true`
- `ROLLOUT_CANARY_SHOPS=shop1.myshopify.com,shop2.myshopify.com`

2. Configure Shopify CLI production TOML:
- Use `shopify.app.production.toml`
- Set:
  - `client_id`
  - `application_url`
  - `auth.redirect_urls`

## 2) Database and build
1. `npm run prisma:generate:prod`
2. `npm run prisma:push:prod`
3. `npm run build`
4. `npm run check:scaling`
5. `npm run check:indexes`

## 3) Operational readiness checks
1. `npm run check:ops`
2. `npm run check:go-no-go`
3. Single-command gate (recommended):
- `npm run check:prod-bootstrap`
- Optional migrations inline:
  - `BOOTSTRAP_RUN_MIGRATIONS=true npm run check:prod-bootstrap`
- Recommended first deploy bootstrap:
  - `BOOTSTRAP_RUN_DB_PUSH=true npm run check:prod-bootstrap`

## 4) Deploy app config to Shopify
1. `shopify app config use shopify.app.production.toml`
2. `shopify app deploy --config shopify.app.production.toml`

## 5) Start runtime processes
1. App web process:
- `npm run start:prod`
2. Worker process:
- `npm run worker:loop`

## 6) Schedule recurring jobs
1. Daily autopilot enqueue cron:
- `npm run autopilot:enqueue`
2. Daily billing snapshot cron:
- call `/api/billing/snapshot/cron?maxShops=100&days=60` with `x-netcash-cron-key`
2. Existing monitoring/reporting/truth cron jobs:
- call their respective `/api/*/cron` endpoints with `x-netcash-cron-key`.

## 7) Post-deploy validation in Shopify
1. Install app in pilot stores.
2. Confirm embedded app loads in admin.
3. Verify:
- `/health` and `/health/readiness`
- `/api/monitoring/overview`
- `/app/autopilot`
- billing status route `/api/billing/status`

## 8) Launch policy
1. Keep rollout canary-only.
2. Run pilot 5-20 shops.
3. Promote to broader rollout only after stable daily ops and quality checks.
