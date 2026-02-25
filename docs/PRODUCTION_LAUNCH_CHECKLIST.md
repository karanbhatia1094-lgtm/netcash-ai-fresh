# Netcash.ai Production Launch Checklist

## 1) Required Infrastructure
- Deploy app to a stable HTTPS domain (`SHOPIFY_APP_URL`).
- Set production database (`DATABASE_URL`) and run Prisma migrations.
- Set `DATABASE_PROVIDER=postgresql`.
- Use PostgreSQL in production (`postgres://` / `postgresql://` only).
- Set required env vars:
  - `SHOPIFY_API_KEY`
  - `SHOPIFY_API_SECRET`
  - `SCOPES`
   - `SHOPIFY_APP_URL`
   - `DATABASE_PROVIDER`
   - `DATABASE_URL`

## 1.1) Migration and Index Verification
1. Bootstrap database on production Postgres:
   - `npm run prisma:generate:prod`
   - `npm run prisma:push:prod`
   - `npm run check:scaling`
   - `npm run check:go-no-go`
2. Verify queue indexes exist:
   - `npm run check:indexes`
   - `idx_job_queue_status_run_after`
   - `idx_job_queue_shop_created`
   - `idx_job_queue_type_status`
3. Verify API metrics index exists:
   - `idx_api_request_metric_route_created`

## 2) Runtime Health & Readiness
- `GET /health` should return 200.
- `GET /health/readiness` should return:
  - `200` when env + DB checks pass
  - `503` when something is missing/broken
- `GET /api/monitoring/overview` (with cron key) should expose:
  - worker failure count
  - queue backlog and recommended worker count
  - API latency + error rate
  - sync freshness lag per shop
- `npm run check:ops` should pass:
  - `/api/autopilot/cron?dryRun=true`
  - `/api/jobs/worker` auth/health

## 3) Merchant Onboarding Automation
- `GET /api/onboarding/status` returns per-shop onboarding progress:
  - order sync status
  - connector connection status
  - activation destination setup status
  - active audience sync rule status

## 4) Shopify Install & Auth
- Verify embedded OAuth install flow for new shops.
- Verify re-auth/scopes update flow.
- Verify uninstall webhook clears access and data policies.

## 5) Compliance & App Store Readiness
- Privacy policy URL
- Data Processing Addendum (DPA)
- Terms of service URL
- Support URL
- Data retention policy
- Data deletion flow (merchant request + uninstall flow) per shop
- Billing plan setup before public app listing

## 6) Final Go-Live Validation
- Smoke test with one dev store + one production-like store
- Webhook event test (orders, refunds, uninstall, scopes update)
- Connector sync test and alerting test
- Dashboard load + AI query + customer 360 flow test
- Confirm support-safe fallback:
  - on connector failure, last successful sync snapshot and timestamp are visible
- Confirm data-quality checks:
  - mapped orders % by campaign/source
  - invalid UTM/campaign IDs
  - missing spend rows by source/date

## 7) Canary-Only Rollout
- Keep `ROLLOUT_CANARY_ONLY=true` until pilot gates are green.
- Set `ROLLOUT_CANARY_SHOPS` with pilot shops only.
- Keep risky features (`FEATURE_*_ROLLOUT`) on `canary` first.

## 8) Pilot Billing and Runbook
- Enable real subscription billing only on 1-2 pilot shops first.
- Pilot cohort size: 5-20 stores.
- Daily checks:
  - truth metrics and data quality
  - queue backlog + worker failures
  - sync freshness lag
- Use fixed feedback loop before widening rollout.
- Build at least 3 case studies using `docs/PILOT_CASE_STUDY_TEMPLATE.md` before broader sales push.
- `GET /api/security/secrets` (with cron key) should confirm:
  - key rotation metadata present (`*_ROTATED_AT`)
  - key age within policy
  - billing dev override disabled

## 9) Worker + Autopilot Scheduling
1. Keep one long-running worker process:
   - `npm run worker:loop`
2. Schedule a daily job trigger:
   - `npm run autopilot:enqueue`
3. Required scheduler env:
   - `APP_BASE_URL` (or `SHOPIFY_APP_URL`)
   - `AUTOPILOT_CRON_KEY` (or `JOB_WORKER_KEY` / `CONNECTOR_CRON_KEY`)
4. Optional scheduler tuning env:
   - `AUTOPILOT_DAYS=30`
   - `AUTOPILOT_MAX_SHOPS=100`
   - `AUTOPILOT_MAX_ACTIONS=5`
   - `AUTOPILOT_APPLY_ACTIONS=false`
   - `AUTOPILOT_SHOP=shop.myshopify.com` (single-shop override)

## 9.1) Billing Snapshot Scheduling
1. Trigger billing snapshot refresh daily:
   - `GET|POST /api/billing/snapshot/cron?maxShops=100&days=60`
2. Use header:
   - `x-netcash-cron-key` with `BILLING_CRON_KEY` (or worker cron key fallback)
3. Owner MRR/churn cards rely on this snapshot history.

## 10) Shopify Deployment Commands
1. `shopify app config use shopify.app.production.toml`
2. `shopify app deploy --config shopify.app.production.toml`
3. Full runbook: `docs/SHOPIFY_DEPLOYMENT_RUNBOOK.md`
4. Single pre-deploy gate:
   - `npm run check:prod-bootstrap`
