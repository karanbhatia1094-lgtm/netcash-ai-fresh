# Netcash.ai Features Built So Far

## 1) Shopify Embedded App Foundation
- Feature:
  - Embedded Shopify admin app with authenticated sessions per store.
- Logic:
  - Uses Shopify Remix auth/session flow and per-shop isolation via `shop` keys in DB models.
- Sources used:
  - `app/shopify.server.js`
  - `app/routes/auth.login/route.jsx`
  - https://shopify.dev/docs/apps/build/authentication-authorization

## 2) Order Ingestion + Net Cash Engine
- Feature:
  - Stores Shopify orders and computes Net Cash after discounts, shipping, tax, refunds, returns, RTO, exchange adjustment.
- Logic:
  - Upsert order by `orderId`.
  - Formula: `netCash = gross - discount - shipping - tax - refunds - returns - rto + exchangeAdjustment`.
  - Saves line items and campaign attribution metadata.
- Sources used:
  - `app/utils/db.js` (`saveOrder`, attribution extractors)
  - `prisma/schema.prisma` (`NetCashOrder`, `OrderLineItem`)
  - https://shopify.dev/docs/api/admin-rest/latest/resources/order

## 3) Campaign/Source Attribution Tracking
- Feature:
  - Captures campaign IDs, names, UTM fields, click IDs, source normalization.
- Logic:
  - Parses landing/referring URLs + custom attributes (`utm_source`, `gclid`, `fbclid`, etc.).
  - Normalizes source labels to canonical values (`meta`, `google`, `direct`, etc.).
- Sources used:
  - `app/utils/db.js` (`extractCampaignData`, `normalizeMarketingSource`)
  - `prisma/schema.prisma` (`ToolAttribution`, campaign fields on `NetCashOrder`)

## 4) Marketing Spend Data Layer
- Feature:
  - Stores ad spend by source/date and aggregates spend totals.
- Logic:
  - Daily upserts in `MarketingSpendEntry`.
  - Source-level rollups for ROAS calculations.
- Sources used:
  - `app/utils/db.js` (`upsertSourceAdSpend`, `addSourceAdSpend`, `getSourceMetrics`)
  - `prisma/schema.prisma` (`MarketingSpendEntry`, `MarketingSourceMetrics`)

## 5) Real ROAS + Dashboard KPIs
- Feature:
  - Gross Revenue, Net Cash, Standard ROAS, Real ROAS, order tables, source/campaign performance.
- Logic:
  - Combines order net-cash data with ad spend totals to compute profitability-first KPIs.
- Sources used:
  - `app/routes/app._index.jsx`
  - `app/utils/db.js` (`getCampaignPerformance`, summaries)

## 6) Connector Hub (Pull + Push)
- Feature:
  - Pull connectors (Meta Ads, Google Ads) and push connectors (Clevertap, MoEngage, WebEngage, KwikEngage, Bitespeed, Bik.ai, Wati, Spur).
- Logic:
  - Pull: OAuth credentials stored server-side; sync jobs fetch spend/campaign data.
  - Push: attribution/events received via API endpoints.
- Sources used:
  - `app/utils/connector-sync.server.js`
  - `app/utils/connector-oauth.server.js`
  - `app/utils/connectors.js`
  - `app/routes/app.additional.jsx`
  - https://developers.facebook.com/docs/marketing-api/
  - https://developers.google.com/google-ads/api

## 7) OAuth for Meta + Google
- Feature:
  - One-click connect/reconnect from app UI.
- Logic:
  - Signed OAuth state payload + callback token exchange + credential upsert.
  - Google refresh-token support for access token renewal.
- Sources used:
  - `app/utils/connector-oauth.server.js`
  - `app/routes/app.connectors.meta.start.jsx`
  - `app/routes/connectors.meta.callback.jsx`
  - `app/routes/app.connectors.google.start.jsx`
  - `app/routes/connectors.google.callback.jsx`
  - https://developers.facebook.com/docs/facebook-login/
  - https://developers.google.com/identity/protocols/oauth2

## 8) Connector Sync Jobs + Cron
- Feature:
  - Manual sync and scheduled sync endpoints.
- Logic:
  - Retry wrapper for connector sync.
  - Writes run logs (`ConnectorSyncRun`) and row-write stats.
- Sources used:
  - `app/utils/connector-sync.server.js`
  - `app/routes/api.connectors.sync.jsx`
  - `app/routes/api.connectors.cron.jsx`
  - `prisma/schema.prisma` (`ConnectorSyncRun`)

## 9) Alerts Engine
- Feature:
  - Operational alerts for drops/spikes and performance anomalies.
- Logic:
  - Rule settings + event fingerprints to avoid duplicate noise.
  - Read/mute workflow.
- Sources used:
  - `app/utils/db.js` (alert rule + event functions)
  - `prisma/schema.prisma` (`AlertRuleSetting`, `AlertEvent`)

## 10) AI Search + Prompt Templates
- Feature:
  - AI query bar + suggestion chips + merchant-specific saved prompt templates and run history.
- Logic:
  - Lightweight intent parser over analytics data.
  - Templates are stored per brand (`shop`) server-side.
- Sources used:
  - `app/routes/api.ai.search.jsx`
  - `app/utils/db.js` (`AiPromptTemplate`, `AiPromptRun` functions)
  - `prisma/schema.prisma` (`AiPromptTemplate`, `AiPromptRun`)

## 11) Market Benchmarks + Positioning
- Feature:
  - Benchmark bands (P50/P75/P90) and your 30-day position vs benchmark.
- Logic:
  - Seed benchmark table if empty and compare derived metrics against percentile bands.
- Sources used:
  - `app/utils/db.js` (`listMarketBenchmarks`)
  - `app/routes/app.additional.jsx`
  - `prisma/schema.prisma` (`MarketBenchmark`)

## 12) Campaign Action Queue
- Feature:
  - Queue for “pause/reduce/investigate” actions by campaign with priority/status workflow.
- Logic:
  - Prevents duplicate open items for same shop/campaign/reason signature.
- Sources used:
  - `app/utils/db.js` (`CampaignActionItem` CRUD)
  - `app/routes/app.campaigns.jsx`
  - `prisma/schema.prisma` (`CampaignActionItem`)

## 13) Budget Reallocation Suggestions + One-Click Approvals
- Feature:
  - Suggests budget shifts from weak to strong campaigns and stores approvals.
- Logic:
  - Detects underperformers and winners using real ROAS/net-cash thresholds, generates pairs and shift percentages.
- Sources used:
  - `app/utils/db.js` (`getBudgetReallocationSuggestions`, decision CRUD)
  - `app/routes/app.campaigns.jsx`
  - `prisma/schema.prisma` (`BudgetReallocationDecision`)

## 14) Creative Performance Scoring Panel
- Feature:
  - Creative score bands (A/B/C/D) with recommendation text.
- Logic:
  - Composite score from ROAS, margin, and volume; maps score to action guidance.
- Sources used:
  - `app/utils/db.js` (`getCreativePerformanceScores`)
  - `app/routes/app.campaigns.jsx`

## 15) Audience Sync Rule Engine
- Feature:
  - Metric-condition audience rules with run history and activation controls.
- Logic:
  - Rule checks (`gte/lte/gt/lt`) over computed metrics.
  - On match, triggers destination and logs each run with status + payload.
- Sources used:
  - `app/utils/db.js` (`runAudienceSyncRules`, `AudienceSyncRule`, `AudienceSyncRun`)
  - `app/routes/app.additional.jsx`
  - `prisma/schema.prisma` (`AudienceSyncRule`, `AudienceSyncRun`)

## 16) Activation Destinations (Webhook + Real Provider Adapters)
- Feature:
  - Destinations now support:
    - Webhooks (`https://...`)
    - Meta audience adapter (`meta://<adAccountId>/<audienceId>`)
    - Google audience adapter (`google://<customerId>/<userListId>`)
- Logic:
  - Same rule engine calls `triggerActivationDestination`.
  - Adapter parser routes to:
    - Meta Graph API audience create + user push (EXTERN_ID hash payload).
    - Google Ads API user-list create/select flow.
  - Run stores status/response for observability.
- Sources used:
  - `app/utils/db.js` (`parseActivationAdapter`, `pushMetaAudience`, `pushGoogleAudience`, `triggerActivationDestination`)
  - `app/routes/app.additional.jsx` (adapter format docs)
  - https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences
  - https://developers.google.com/google-ads/api/reference/rpc/v17/UserListService

## 17) Additional Page as Ops/Connectors Console
- Feature:
  - Connector setup, sync runs, benchmarks, audience rules, destination tests, API docs.
- Logic:
  - Centralized ops page to keep main dashboard focused and premium.
- Sources used:
  - `app/routes/app.additional.jsx`
  - `app/routes/app.settings.jsx`

## 18) Product + Sales Collateral
- Feature:
  - Architecture docs and sales-ready deck content.
- Logic:
  - Documentation tracks data flow, components, and GTM positioning.
- Sources used:
  - `docs/PRODUCT_ARCHITECTURE.md`
  - `docs/ARCHITECTURE_PITCH_DECK.md`
  - `docs/SALES_PITCH_DECK.md`

## 19) Attribution Overlap + Landing Mismatch Diagnostics
- Feature:
  - Highlights multi-source attribution overlap and landing mismatch risk for paid traffic.
- Logic:
  - Overlap risk = orders with touchpoints across multiple sources.
  - Landing mismatch = paid orders landing on home or generic pages.
- Sources used:
  - `app/routes/app._index.jsx`
  - `app/utils/db.js` (touchpoints + landing signal capture)

## 20) Creative Fatigue Watchlist
- Feature:
  - Detects CTR decay and frequency pressure at creative level across Meta/Google.
- Logic:
  - Pulls daily creative metrics, compares last 7 days vs prior 7 days.
  - Flags creatives with CTR drop + spend/impression thresholds and age/frequency checks.
- Sources used:
  - `app/utils/connector-sync.server.js` (creative metrics sync)
  - `app/utils/db.js` (fatigue scoring + alerts)
  - `app/routes/app.campaigns.jsx` (watchlist UI)

---

## Notes on “Triple Whale parity”
- We used Triple Whale as directional inspiration for product scope: unified marketing analytics, attribution-driven decisions, alerts/automation, and campaign actioning.
- Source reviewed:
  - https://www.triplewhale.com/
- Implementation in Netcash.ai is custom and Shopify-embedded with your own data model, connectors, and workflows.
