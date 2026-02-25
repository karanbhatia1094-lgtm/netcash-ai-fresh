# Netcash.ai Product Architecture

## 1. Product Summary
Netcash.ai is a Shopify embedded analytics app focused on profit-centric growth.
It combines:
- Order-level economics (gross, deductions, net cash)
- Attribution data (campaign/source mapping)
- Ad spend ingestion (manual + connector sync)
- Alerting and monitoring workflows

Core outcome:
Marketers and founders can optimize for net cash and real ROAS, not only platform ROAS.

## 2. High-Level Architecture
### Frontend
- Remix routes rendered inside Shopify Admin embedded app context.
- Shared design system via `app/styles/netcash.css`.
- Main screens:
  - Dashboard (`app/routes/app._index.jsx`)
  - Campaign performance (`app/routes/app.campaigns.jsx`)
  - Connector hub (`app/routes/app.additional.jsx`)
  - Settings & health (`app/routes/app.settings.jsx`)
  - Alerts center (`app/routes/app.alerts.jsx`)

### Backend
- Remix loaders/actions provide server-side data and mutations.
- Shopify Admin GraphQL is queried from server loaders using authenticated admin session.
- API endpoints support connector ingest, cron sync, templates, and diagnostics.

### Data Layer
- Prisma ORM + SQLite in development.
- Business entities include:
  - Orders and line items
  - Attribution touchpoints
  - Source spend entries
  - Connector credentials and sync run logs
  - Alert rules, settings, and events

## 3. Core Data Flow
### A. Shopify Order Sync
1. Dashboard loader calls Shopify GraphQL for recent orders.
2. Orders are normalized.
3. `saveOrder(...)` upserts order + line item data.
4. Dashboard metrics are computed from persisted records.

### B. Attribution Ingestion
1. External tools send attribution payloads to `/api/attribution`.
2. Payload records map campaign/source identifiers to existing orders.
3. Attribution records are stored and linked to orders.
4. Dashboard and campaign pages use this to compute source/campaign performance.

### B1. Meta Signal-Loss Recovery (Pixel/UTM Gaps)
Meta attribution can be incomplete because of privacy restrictions, cookie loss, and app-web handoff breaks.
Netcash.ai uses a layered recovery model:
1. First-party click capture:
   - Capture `fbclid` (and similar click IDs) on landing page entry.
   - Persist IDs in first-party state and pass into checkout/order metadata.
2. Server-side conversion attribution:
   - Push order-level events from backend/webhooks to `/api/attribution`.
   - Minimum payload: `shop`, `orderId` (or `orderNumber`), `campaignId`/`campaignName`, `provider`.
3. Model fallback for reporting:
   - Use first-click, last-click, linear, and time-decay models when direct pixel matching is missing.
4. Quality scoring:
   - Track click-ID capture %, UTM completeness %, and attributed net-cash coverage on Home/Intelligence pages.

### C. Spend Ingestion
1. Manual spend entries are posted from dashboard forms.
2. Pull connectors can sync spend data through connector sync service.
3. Spend rows are stored per source/date.
4. ROAS and Real ROAS use this spend denominator.

### D. Monitoring and Alerts
1. Alert evaluation runs against recent KPI trends.
2. Alert events are generated with severity and hit counts.
3. Alert center supports filter, mute/unmute, enable/disable, read/unread.

## 4. Key Analytics Modules
- Revenue and net cash KPI rollups
- Source breakdown (orders, gross, net, spend, ROAS, real ROAS)
- Attribution models:
  - Last click
  - First click
  - Linear
  - Time decay
- Incrementality heuristics:
  - Paid vs direct baseline
  - Weekly cohort snapshot

## 4.1 Universal Customer Graph (Cross-Store, Privacy-Safe)
Netcash.ai now supports a universal event model to capture customer behavior across all stores where the app is installed.

### Identity stitching
- Deterministic hashed identity keys:
  - `email:<sha256(normalized_email)>`
  - `phone:<sha256(normalized_phone)>`
  - fallback `click:<sha256(click_id)>` or anonymous key
- No raw PII required for cross-store graphing; hashes are stored for joinability.

### Universal entities
- `UniversalSignalEvent`:
  - generic behavior event envelope (purchase, ad_view, message_open, session_start, etc.)
  - includes source/campaign, device OS/handset, payment method, coupon, timing fields
- `UniversalIdentity`:
  - global identity aggregate across all shops/events
- `UniversalIdentityShop`:
  - identity-level aggregate scoped to a specific shop
- `UniversalCustomerProfile`:
  - shop-level customer behavior profile (orders, net cash, payment/coupon/device recency)

### Ingestion paths
- Automatic purchase event write on order sync (`saveOrder`).
- Generic event API for external systems:
  - `POST /api/universal-signals`
  - supports message open, ad view, and any custom behavioral event.

### Query path
- `GET /api/universal-overview?days=90` for summary metrics:
  - total events, unique identities, message opens, ad views, device mix.
- `GET /app/universal` (Premium plan):
  - purchase hour/day patterns
  - payment method and coupon patterns
  - handset mix and device OS split
  - ad-view/message-open to purchase lag insights
  - COD vs prepaid payment mix
  - coupon sensitivity (usage rate + net impact)
  - order value bands
  - RFM-style customer segments and recency buckets
  - top purchase sources and 24h engagement-to-purchase counts

### Plan gating
- Universal Insights UI is Premium-only.
- Non-premium stores see locked state with upgrade CTA.
- API ingestion can still be enabled ahead of upgrade so historical data is ready on plan upgrade.

## 5. Connector Platform Design
### Modes
- Push connectors:
  - Third-party tool sends data into Netcash API
- Pull connectors:
  - Netcash uses OAuth/API credentials to fetch data

### Current categories
- Ad platforms (Meta Ads, Google Ads)
- Engagement/CRM tools (Clevertap, MoEngage, WebEngage, KwikEngage, Bitespeed, Bik.ai, Wati, Spur)

### Connector operational controls
- OAuth connect/reconnect where supported
- Account ID configuration
- On-demand sync test
- Cron sync support
- Sync run logs and status visibility

## 6. Security and Access Model
- Shopify embedded auth/session gates admin routes.
- Sensitive connector secrets stored server-side.
- API access keys supported for ingestion and cron endpoints.
- Recommended production hardening:
  - Rotate API keys
  - Encrypt secrets at rest
  - Add request signing/validation per connector
  - Add tenant-level RBAC if multi-user admin controls are required

## 7. Reliability and Operations
- Sync runs capture status, counts, errors, duration.
- Alerting detects negative KPI movement.
- Scheduled jobs supported through secure cron endpoints.
- Production recommendations:
  - Move from SQLite to Postgres/MySQL
  - Add queue/retry layer for connector sync jobs
  - Add observability (structured logs + metrics + error tracking)

## 8. Deployment Blueprint
### Dev
- Shopify CLI + ngrok tunnel
- Prisma + local SQLite
- Remix dev/build

### Production target
- Remix app server on cloud runtime
- Managed database
- TLS domain for app URL/callbacks
- Scheduled jobs for connector sync + digest alerts

## 9. Commercial Positioning (Go-To-Market)
### Problem statement
Most brands optimize ad spend to platform-reported ROAS and miss real cash profitability.

### Netcash.ai value proposition
- Unifies order, attribution, and spend data into one profit view.
- Tracks real ROAS and net cash at campaign granularity.
- Reduces blind spend through anomaly alerts and trend monitoring.

### Ideal customer profile
- Shopify stores spending on paid channels
- Performance marketing teams needing profitability clarity
- Founders/operators managing growth and margin pressure

### Packaging suggestion
- Starter: Core dashboard + manual spend + basic attribution
- Growth: Connectors + alerts + campaign analytics
- Pro: Incrementality + advanced attribution + scheduled sync + exports

## 10. Current Scope vs Future Scope
### Built now
- Embedded app analytics core
- Connector framework and key endpoints
- Spend + attribution + order-linked profitability
- Alerts and health monitoring UI

### Next logical roadmap
- Native integrations per platform with robust token refresh
- Real MMM/causal modeling layer
- Scenario planning and budget reallocation simulator
- Team/role access and audit logs
- White-label reporting and stakeholder share links

## 11. Scale-Ready Architecture (Implemented)
### Async job queue (DB-backed)
- Added `job_queue` infrastructure with status lifecycle:
  - `queued -> processing -> succeeded/failed`
- Supports:
  - Retry with capped attempts
  - De-duplication via `unique_key`
  - Worker locking for safe parallel processing
- Operational routes:
  - `GET/POST /api/jobs/worker` to process queued jobs
  - `GET /api/jobs` to inspect latest jobs for a shop

### Heavy paths moved off request cycle
- Home loader no longer runs Shopify order sync inline.
- Home loader now enqueues `shopify_order_sync` jobs when sync is due.
- Connector sync APIs now enqueue `connector_sync` jobs instead of blocking.
- Reports cron now enqueues `reports_run_due` jobs for worker execution.
- Owner rollup cron now enqueues `owner_rollup_refresh`.
- Truth rollup cron enqueues `truth_rollup_refresh` for campaign and campaign-user net-cash truth.

### Owner analytics rollups
- Added `owner_daily_rollup` table and refresh utility.
- Owner Console now reads fast aggregated rollups (30-day window) with fallback to live query.
- Makes multi-brand owner view stable as tenant count grows.

### Production execution model
- Trigger background jobs using secure cron key:
  - Enqueue work with `/api/connectors/cron`, `/api/reports/cron`, `/api/owner/rollup/cron`, `/api/truth/cron`, `/api/autopilot/cron`.
  - Process queue with `/api/jobs/worker`.
- Local/CI worker execution:
  - `npm run worker:once`
  - Long-running worker: `npm run worker:loop`

### Scalability validation tools
- `npm run check:scaling`:
  - Validates Postgres readiness, worker key, and reporting env.
- `npm run loadtest:smoke`:
  - Baseline latency and success smoke test with p95 and pass/fail SLO output.
- `npm run check:ops`:
  - Validates autopilot cron auth/path (`dryRun`)
  - Validates jobs worker auth/path

### Key env controls
- `DATABASE_URL` (Postgres required for production scale)
- `DATABASE_PROVIDER` (`sqlite` for local dev, `postgresql` for production)
- `JOB_WORKER_KEY` (or fallback `CONNECTOR_CRON_KEY`)
- `AUTOPILOT_CRON_KEY` (optional override for `/api/autopilot/cron`)
- `OWNER_CRON_KEY`
- `ORDER_SYNC_MIN_INTERVAL_MINUTES`
- `JOB_QUEUE_MAX_PENDING_PER_SHOP`
- `JOB_QUEUE_MAX_PENDING_GLOBAL`

## 12. Controlled Rollout (Canary-by-Shop)
To avoid shipping changes to all stores at once, Netcash.ai now supports shop-level staged rollout.

### Release channels
- `internal`: highest-priority test stores
- `canary`: limited pilot stores
- `stable`: default production stores

### Rollout env settings
- `ROLLOUT_INTERNAL_SHOPS=shop1.myshopify.com,shop2.myshopify.com`
- `ROLLOUT_CANARY_SHOPS=shop3.myshopify.com`
- `ROLLOUT_BLOCKED_SHOPS=shop4.myshopify.com`
- `ROLLOUT_FREEZE_ALL=true|false`

### Feature-targeting env settings
- `FEATURE_<FEATURE_KEY>_ROLLOUT=all|none|canary|internal|shops`
- `FEATURE_<FEATURE_KEY>_SHOPS=shop-a.myshopify.com,shop-b.myshopify.com`

Implemented feature flag key:
- `FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT`
- `FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_SHOPS`
- `FEATURE_HOME_ASYNC_ORDER_SYNC_ROLLOUT`
- `FEATURE_HOME_ASYNC_ORDER_SYNC_SHOPS`

This enables change deployment to a few stores first, then broad rollout only after explicit confirmation.

## 13. Netcash Truth Layer
Implemented truth tracking for campaign-level and user-level profitability quality:
- Campaign aggregates include:
  - Orders, gross revenue, net cash
  - RTO orders
  - Returned orders
  - Exchange orders
  - Higher-value exchange count
  - Lower-value exchange count
  - Exchange with refund count
- User-level campaign truth table in Campaigns page:
  - Source, campaign, customer
  - Orders and net cash
  - RTO/return/exchange direction/refund markers

Operational endpoints:
- `GET /api/truth/summary?days=30&sources=all&limit=100`
- `GET|POST /api/truth/cron?days=90&maxShops=100` (secured by cron key)

## 14. Pilot Readiness and Operations (New)
### Production runtime hardening
- Production env checks now enforce:
  - `DATABASE_URL` required and Postgres-only in production
  - insecure key placeholders blocked
  - `BILLING_DEV_OVERRIDE` disabled in production
- Queue defaults tightened for safer multi-tenant behavior:
  - `JOB_QUEUE_MAX_PENDING_PER_SHOP=100`
  - `JOB_QUEUE_MAX_PENDING_GLOBAL=50000`

### Worker autoscaling signals
- Queue now exposes backlog telemetry and recommended worker count based on:
  - pending jobs
  - target backlog per worker
  - min/max concurrency caps
- `GET|POST /api/jobs/worker` now returns queue before/after metrics for autoscaling hooks.

### Canary-only rollout mode
- New rollout gate:
  - `ROLLOUT_CANARY_ONLY=true`
- Stable shops are blocked when canary-only is active.
- Risky features should stay in `canary` mode until pilot validation passes.

### Monitoring endpoint
- New endpoint: `GET|POST /api/monitoring/overview` (cron-key secured)
- Covers:
  - worker failures
  - queue backlog
  - API latency and error rate
  - sync freshness lag per shop
- New alert dispatch endpoint:
  - `GET|POST /api/monitoring/alerts` (sends to `ALERT_WEBHOOK_URL` when thresholds are breached)

### Data-quality checks endpoint
- New endpoint: `GET /api/data-quality/summary?days=30`
- Includes:
  - mapped orders % by campaign/source
  - invalid UTM/campaign ID detection
  - missing spend rows by source/date

### Support-safe fallback
- Connector surfaces now expose last successful sync snapshots so support can show last-good data + timestamp on failures (no blank state).

### Owner Console pilot checklist
- Owner Console now includes a pass/fail Pilot Readiness Checklist per brand with:
  - canary enrollment
  - connector readiness
  - sync freshness lag
  - queue backlog
  - mapped-order coverage
  - invalid tracking IDs
  - missing spend rows

### Launch gate automation
- Added `npm run check:go-no-go` to enforce pre-sell launch criteria:
  - scaling checks
  - index verification
  - readiness/monitoring endpoint checks (when app URL is configured)

### Compliance and trust surfaces
- Public legal/support pages available at:
  - `/legal/privacy`
  - `/legal/dpa`
  - `/legal/data-retention`
  - `/legal/deletion`
  - `/support/sla`
  - `/status/known-issues`
  - `/sales/proof-pack`

## 15. Profit Guardrails Autopilot (New)
- New hero capability: `Profit Guardrails Autopilot`
- Objective:
  - protect net cash by throttling poor campaigns
  - scale winners only when confidence is high
- Data confidence combines:
  - mapped-orders coverage
  - invalid UTM/campaign IDs
  - missing spend rows
  - sync freshness lag
- Modes:
  - `dry_run` (recommendations only)
  - `apply` (creates campaign action items with rollback guidance)
- Daily scheduling:
  - queue job type: `profit_guardrails_run`
  - cron enqueue endpoint: `GET|POST /api/autopilot/cron`
- Persistence:
  - `profit_guardrail_run`
  - `profit_guardrail_decision`
- Endpoints and UI:
  - `GET|POST /api/autopilot/guardrails`
  - `/app/autopilot`
  - one-click rollback action generation from any recommendation row
  - source-level estimated before/after net-cash impact panel

## 16. Multi-Brand Compatibility (Per-Shop Overrides)
- Added DB-backed per-shop settings to support one-brand-only updates:
  - table: `shop_setting` (`shop`, `key`, `value`, `updated_at`)
- Owner Console now supports:
  - loading a target shop
  - saving/deleting per-shop key-value overrides
  - previewing effective config for a selected brand
- Shop-level visibility:
  - `/app/settings` shows effective brand-specific overrides
  - `GET /api/shop-config` returns effective config for authenticated shop
- Override governance:
  - strict allowlist enforced for override keys (prevents unsafe/unknown keys)
  - managed through Owner Console `Per-Brand Overrides`
- Intended use:
  - custom copy/labels for one brand
  - support contacts and operational endpoints per brand
  - brand-specific behavior tuning without global regression risk

## 17. Founder Visibility (Per Download Usage Analytics)
- New server-side feature usage telemetry:
  - table: `feature_usage_event`
  - captured per shop, feature key, event name, route path, timestamp
- Events are ingested via:
  - `POST /api/usage/event` (authenticated shop session)
- Owner analytics surfaces:
  - Owner Console section: `Founder Visibility: Feature Usage by Brand`
  - `GET /api/owner/usage?days=30`
  - CSV exports:
    - `GET /api/owner/usage?days=30&format=csv&type=shops`
    - `GET /api/owner/usage?days=30&format=csv&type=features`
    - `GET /api/owner/usage?days=30&format=csv&type=matrix`
- Visibility includes:
  - usage by brand (each installed shop/download)
  - top features across brands
  - brand × feature breakdown with last-seen timestamps

## 18. Owner Command Center v2 (New)
Owner Console now includes founder-grade business and operations controls:
- MRR/Churn dashboard:
  - active paid shops, estimated MRR, churned shops, expansion/contraction placeholders
- Trial funnel:
  - installs, onboarding complete, first-value reached, paid conversion
- Brand health score:
  - score derived from usage, data quality, sync freshness, queue pressure, billing signal
- Risk radar:
  - high/medium risk shops with actionable indicators
- Release impact view:
  - channel-level (stable/canary/internal) event and net-cash impact
- Owner alerts:
  - `GET|POST /api/owner/alerts` with optional webhook dispatch
- Success playbooks:
  - next-best action per brand from health/risk diagnostics
- Feature revenue attribution (correlation):
  - feature usage vs average net-cash and order outcomes
- CS/support ops panel:
  - unread alerts by shop/severity, recent connector failures, queue pressure
- Permissioned team access + audit trail:
  - roles: founder, ops, support, analyst
  - audit log for rollout/override/team/job actions
- Brand lifecycle counters:
  - Downloaded brands
  - Currently using / Active brands
  - Churned brands
  - endpoint: `GET /api/owner/lifecycle?days=30`
  - CSV export: `GET /api/owner/lifecycle?days=30&format=csv`

## 19. Billing Snapshot System (Exact MRR/Churn Baseline)
- New persistent billing snapshot table:
  - `billing_snapshot` (per shop, per day)
- Snapshot writes happen when billing status is fetched for a shop:
  - `GET /api/billing/status`
- Automated refresh endpoint for all installed shops (offline tokens):
  - `GET|POST /api/billing/snapshot/cron?maxShops=100&days=60`
- Owner Console MRR/churn now reads snapshot history (current vs previous) for:
  - active paid shops
  - estimated MRR
  - churn / expansion / contraction signals

## 20. Integration Hub (Click-First, Short Journey Automation)
- New route: `/app/integrations`
- Guided 2-step setup:
  1. Connect Meta/Google (OAuth buttons)
  2. One-click channel setup for WhatsApp, Email, SMS, RCS
- Auto-setup behavior:
  - picks best available destination (Meta/Google/Webhook)
  - auto-creates destination
  - auto-creates default audience sync rules
  - optional immediate rule run
- Goal:
  - no manual schema mapping for common journeys
  - minimal clicks to launch automation playbooks
