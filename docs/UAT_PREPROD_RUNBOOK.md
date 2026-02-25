# Netcash.ai UAT + Pre-Production Runbook

## Automated checks
1. `npm run check:preprod`
2. `npm run check:go-no-go`
2. Confirm all three pass:
- Build
- Lint
- Tests

## Store-integrated UAT (must be run in Shopify dev/staging store)
1. Start app:
- `npm run dev:shopify:localhost`
2. Install/re-auth in Shopify admin.
3. Validate critical flows:
- Home loads with Premium features.
- NLP search routes correctly:
  - `show me rfm`
  - `show me 360`
  - `download orders csv`
- Export/download actions produce files.
- Campaigns and Alerts pages load and actions work.
- Universal insights and RFM cohorts render.
- Manage plan dropdown appears and submits without UI errors.

## Connector and webhook checks
1. Meta/Google OAuth connect flow.
2. Connector sync endpoint with valid key.
3. Webhook handling:
- orders_create
- orders_updated
- refunds_create
- app/uninstalled

## Readiness endpoints
1. `GET /health` returns 200.
2. `GET /health/readiness` returns:
- `200` for valid env/db setup
- `503` if required env/db is missing

## Production config checks
1. Ensure `BILLING_DEV_OVERRIDE` is **not** set.
2. Use strong random values for:
- `CONNECTOR_CRON_KEY`
- `REPORTS_CRON_KEY`
- `ATTRIBUTION_API_KEY`
- `CONNECTOR_OAUTH_STATE_SECRET`
 - `JOB_WORKER_KEY`
3. Verify production HTTPS app URL is configured.
4. Verify `DATABASE_URL` is Postgres in production.
5. Verify `ROLLOUT_CANARY_ONLY=true` and set `ROLLOUT_CANARY_SHOPS`.

## Monitoring checks
1. Hit `GET /api/monitoring/overview` with `x-netcash-cron-key`.
2. Hit `GET /api/monitoring/alerts` with `x-netcash-cron-key`.
3. Hit `GET /api/security/secrets` with `x-netcash-cron-key`.
4. Validate these are below alert thresholds:
- worker failures
- queue backlog
- API error rate / latency
- sync freshness lag per shop
5. Hit `GET /api/data-quality/summary?days=30` per pilot shop and review:
- mapped order % by campaign/source
- invalid UTM/campaign IDs
- missing spend rows by source/date

## Autopilot operational checks
1. Enqueue an autopilot run:
- `npm run autopilot:enqueue`
2. Process queue once:
- `npm run worker:once`
3. Confirm run exists in UI:
- `/app/autopilot`
4. For production, keep worker running continuously:
- `npm run worker:loop`

## Pilot execution runbook
1. Start with 1-2 billing-enabled test shops for real subscriptions.
2. Expand to 5-20 pilot stores only after 48h stable checks.
3. Daily pilot checklist in Owner Console:
- pass/fail by shop
- queue and sync freshness
- data-quality validation
4. Keep risky features in canary mode until pilot pass criteria are stable.

## Go/No-Go gate
- Go only if all automated checks pass and all store-integrated UAT checks are green.
