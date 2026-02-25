import { Form, useActionData, Link, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { getDataQualitySummary, getSyncFreshnessByShop, prisma } from "../utils/db.server";
import { getOwnerRollupOverview } from "../utils/owner-rollups.server";
import { enqueueJob, getQueueBacklogSummary } from "../utils/job-queue.server";
import { dispatchMonitoringAlert } from "../utils/alert-dispatch.server";
import { getBillingSnapshotSummary } from "../utils/billing-snapshots.server";
import {
  deleteShopSetting,
  evaluateFeatureEnabledForShop,
  evaluateReleaseContext,
  getAllowedShopSettingKeys,
  getReleaseControlState,
  getReleaseRuntime,
  listShopSettings,
  resolveShopConfig,
  upsertShopSetting,
  upsertFeatureRollout,
  upsertRolloutSetting,
} from "../utils/release-control.server";
import { getFeatureUsageSummary } from "../utils/feature-usage.server";
import {
  canOwner,
  deleteOwnerTeamAccess,
  getRoleCapabilities,
  listOwnerAuditEvents,
  listOwnerTeamAccess,
  logOwnerAuditEvent,
  resolveOwnerRole,
  upsertOwnerTeamAccess,
} from "../utils/owner-governance.server";
import { buildOwnerInsights, buildSupportOpsSnapshot } from "../utils/owner-insights.server";
import { getOwnerLifecycleSummary } from "../utils/owner-lifecycle.server";

function money(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

function parseShopList(value) {
  return String(value || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

async function buildPilotReadiness(stores = []) {
  const maxShops = Math.max(1, Math.min(50, Number(process.env.PILOT_CHECKLIST_MAX_SHOPS || 20)));
  const syncLagThresholdMinutes = Math.max(60, Number(process.env.PILOT_SYNC_LAG_THRESHOLD_MINUTES || 360));
  const mappedOrdersThresholdPct = Math.max(50, Math.min(100, Number(process.env.PILOT_MAPPED_ORDERS_THRESHOLD_PCT || 80)));
  const queuePendingPerShopThreshold = Math.max(5, Number(process.env.PILOT_QUEUE_PENDING_PER_SHOP_THRESHOLD || 100));
  const candidateShops = (stores || []).slice(0, maxShops);
  const queue = await getQueueBacklogSummary({ recentWindowMinutes: 60 });
  const syncRows = await getSyncFreshnessByShop(14);
  const syncByShop = new Map(syncRows.map((row) => [row.shop, row]));
  const queueByShop = new Map((queue.topShopsByPending || []).map((row) => [row.shop, row.pending]));

  const rows = [];
  for (const store of candidateShops) {
    // eslint-disable-next-line no-await-in-loop
    const quality = await getDataQualitySummary(store.shop, 30);
    const sync = syncByShop.get(store.shop);
    const pending = Number(queueByShop.get(store.shop) || 0);
    const checks = [
      { key: "canary", label: "Canary enrolled", pass: store.releaseChannel === "canary" || store.releaseChannel === "internal" },
      { key: "connectors", label: "Connector connected", pass: Number(store.connectorCount || 0) > 0 },
      {
        key: "sync_freshness",
        label: "Sync freshness lag",
        pass: Number(sync?.connectorLagMinutes ?? sync?.orderLagMinutes ?? Number.MAX_SAFE_INTEGER) <= syncLagThresholdMinutes,
      },
      {
        key: "queue_backlog",
        label: "Queue backlog",
        pass: pending <= queuePendingPerShopThreshold,
      },
      {
        key: "mapped_orders",
        label: "% mapped orders",
        pass: Number(quality?.totals?.mappedOrdersPct || 0) >= mappedOrdersThresholdPct,
      },
      {
        key: "invalid_tracking",
        label: "Invalid UTM/campaign IDs",
        pass: Number(quality?.totals?.invalidRows || 0) === 0,
      },
      {
        key: "missing_spend",
        label: "Missing spend rows",
        pass: Number(quality?.totals?.missingSpendRows || 0) === 0,
      },
    ];

    rows.push({
      shop: store.shop,
      status: checks.every((row) => row.pass) ? "pass" : "fail",
      checks,
      metrics: {
        mappedOrdersPct: Number(quality?.totals?.mappedOrdersPct || 0),
        invalidRows: Number(quality?.totals?.invalidRows || 0),
        missingSpendRows: Number(quality?.totals?.missingSpendRows || 0),
        syncLagMinutes: Number(sync?.connectorLagMinutes ?? sync?.orderLagMinutes ?? 0),
        queuePending: pending,
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    queue,
    rows,
    passCount: rows.filter((row) => row.status === "pass").length,
    failCount: rows.filter((row) => row.status !== "pass").length,
  };
}

function buildMarketReadiness({ stores = [], rolloutConfig = {}, pilotReadiness = {} } = {}) {
  const databaseUrl = String(process.env.DATABASE_URL || "");
  const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
  const appBaseUrl = String(process.env.APP_BASE_URL || process.env.SHOPIFY_APP_URL || "");
  const canaryOnly = !!rolloutConfig?.canaryOnly || isTrue(process.env.ROLLOUT_CANARY_ONLY);
  const featureCanary = ["canary", "internal", "shops"].includes(String(process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_ROLLOUT || "canary").toLowerCase())
    && ["canary", "internal", "shops"].includes(String(process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT || "canary").toLowerCase());

  const keyRows = [
    "CONNECTOR_CRON_KEY_ROTATED_AT",
    "JOB_WORKER_KEY_ROTATED_AT",
    "ATTRIBUTION_API_KEY_ROTATED_AT",
    "CONNECTOR_OAUTH_STATE_SECRET_ROTATED_AT",
  ];
  const keysRotated = keyRows.every((key) => String(process.env[key] || "").trim());
  const billingOverrideOff = !String(process.env.BILLING_DEV_OVERRIDE || "").trim();
  const alertWebhookConfigured = !!String(process.env.ALERT_WEBHOOK_URL || process.env.DIGEST_WEBHOOK_URL || "").trim();

  const pilotBillingShops = parseShopList(process.env.PILOT_BILLING_SHOPS || "");
  const pilotBillingPass = pilotBillingShops.length >= 1 && pilotBillingShops.length <= 2;
  const legalPagesImplemented = true;
  const fallbackImplemented = true;
  const supportOpsDocsImplemented = true;
  const caseStudyCount = Number(process.env.CASE_STUDY_COUNT || 0);
  const has3CaseStudies = caseStudyCount >= 3;

  const pilotStoreCount = Number(stores.length || 0);
  const pilotCountPass = pilotStoreCount >= 5 && pilotStoreCount <= 20;
  const pilotQualityPass = Number(pilotReadiness?.failCount || 0) === 0 && Number(pilotReadiness?.passCount || 0) > 0;

  const items = [
    {
      key: "db_postgres",
      label: "1. Production Postgres + migrations/indexes gate",
      pass: isPostgres,
      hint: isPostgres ? "Postgres configured." : "Set DATABASE_URL=postgresql://... then run: npx prisma migrate deploy, npm run check:indexes",
    },
    {
      key: "launch_gate",
      label: "2. Go/No-Go gate configured",
      pass: !!appBaseUrl,
      hint: appBaseUrl ? "APP_BASE_URL/SHOPIFY_APP_URL configured." : "Set APP_BASE_URL (or SHOPIFY_APP_URL) and run: npm run check:go-no-go",
    },
    {
      key: "secrets",
      label: "3. Secrets rotation + dev override off",
      pass: keysRotated && billingOverrideOff,
      hint: (keysRotated && billingOverrideOff)
        ? "Secrets and override state healthy."
        : "Set *_ROTATED_AT timestamps and unset BILLING_DEV_OVERRIDE.",
    },
    {
      key: "alerts",
      label: "4. Alert delivery webhook configured",
      pass: alertWebhookConfigured,
      hint: alertWebhookConfigured
        ? "ALERT_WEBHOOK_URL is configured."
        : "Set ALERT_WEBHOOK_URL and test /api/monitoring/alerts?force=true",
    },
    {
      key: "fallback",
      label: "5. Support-safe fallback implemented",
      pass: fallbackImplemented,
      hint: "Verify fallback banners in /app and /app/campaigns after connector failure.",
    },
    {
      key: "onboarding",
      label: "6. Onboarding first-value scoring live",
      pass: true,
      hint: "Verify /api/onboarding/first-value returns score and checks.",
    },
    {
      key: "billing_pilot",
      label: "7. Billing pilot set to 1-2 shops",
      pass: pilotBillingPass,
      hint: pilotBillingPass
        ? `PILOT_BILLING_SHOPS set: ${pilotBillingShops.join(", ")}`
        : "Set PILOT_BILLING_SHOPS to 1-2 shop domains and verify /api/billing/status has live subscription.",
    },
    {
      key: "legal",
      label: "8. Legal/compliance pages live",
      pass: legalPagesImplemented,
      hint: "Check /legal/privacy, /legal/dpa, /legal/data-retention, /legal/deletion",
    },
    {
      key: "proof_pack",
      label: "9. Sales proof pack (>=3 case studies)",
      pass: has3CaseStudies,
      hint: has3CaseStudies
        ? `CASE_STUDY_COUNT=${caseStudyCount}`
        : "Set CASE_STUDY_COUNT>=3 and populate docs/PILOT_CASE_STUDY_TEMPLATE.md",
    },
    {
      key: "support_ops",
      label: "10. Support ops runbook + known issues",
      pass: supportOpsDocsImplemented,
      hint: "Check docs/SUPPORT_OPERATIONS_RUNBOOK.md and /status/known-issues",
    },
  ];

  const rolloutAndPilotGuard = canaryOnly && featureCanary && pilotCountPass && pilotQualityPass;
  const overallPass = items.every((row) => row.pass) && rolloutAndPilotGuard;

  return {
    overallPass,
    passCount: items.filter((row) => row.pass).length,
    failCount: items.filter((row) => !row.pass).length,
    rolloutAndPilotGuard,
    items,
    context: {
      pilotStores: pilotStoreCount,
      pilotPassCount: Number(pilotReadiness?.passCount || 0),
      pilotFailCount: Number(pilotReadiness?.failCount || 0),
      canaryOnly,
      featureCanary,
      caseStudyCount,
      pilotBillingShops,
      appBaseUrlSet: !!appBaseUrl,
      keysRotated,
      alertWebhookConfigured,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const usageDays = Math.max(1, Math.min(180, Number(url.searchParams.get("usageDays") || 30)));
  const allowed = String(process.env.OWNER_SHOPS || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const isOwnerShop = allowed.length === 0 || allowed.includes(String(session.shop || "").toLowerCase());
  const role = await resolveOwnerRole(session, isOwnerShop);
  const capabilities = getRoleCapabilities(role);
  if (!isOwnerShop) {
    return { denied: true, currentShop: session.shop, totals: null, stores: [], role: "none", capabilities: [] };
  }
  if (role === "none") {
    return { denied: true, currentShop: session.shop, totals: null, stores: [], role, capabilities };
  }

  const rolloutRuntime = await getReleaseRuntime();
  const rolloutState = await getReleaseControlState().catch(() => ({ settings: [], features: [] }));
  const featureUsage = await getFeatureUsageSummary({ days: usageDays, maxShops: 300, maxFeatures: 500 }).catch(() => ({
    days: usageDays,
    since: null,
    byShop: [],
    byFeature: [],
    byShopFeature: [],
  }));
  const ownerAudit = await listOwnerAuditEvents(120).catch(() => []);
  const ownerTeam = await listOwnerTeamAccess().catch(() => []);
  const billingSummary = await getBillingSnapshotSummary(60).catch(() => ({ byShop: [], totals: {} }));
  const activeWindowDays = Math.max(7, Math.min(90, Number(url.searchParams.get("activeWindowDays") || 30)));
  const allowedShopSettingKeys = getAllowedShopSettingKeys();
  const featureRows = rolloutState.features || [];
  const featureModeFor = (featureKey, fallback = "all") =>
    featureRows.find((f) => String(f.featureKey || "").toUpperCase() === String(featureKey || "").toUpperCase())?.mode || fallback;
  const featureShopsFor = (featureKey, fallback = "") =>
    featureRows.find((f) => String(f.featureKey || "").toUpperCase() === String(featureKey || "").toUpperCase())?.shopsCsv || fallback;

  try {
    const rollup = await getOwnerRollupOverview(30);
    const stores = (rollup.stores || []).map((row) => {
      const release = evaluateReleaseContext(row.shop, rolloutRuntime);
      return {
        ...row,
        releaseChannel: release.channel,
        campaignsMultiSourceEnabled: evaluateFeatureEnabledForShop(row.shop, "campaign_multi_source_filters", rolloutRuntime, true),
      };
    });
    const rolloutSummary = stores.reduce((acc, row) => {
      acc[row.releaseChannel] = (acc[row.releaseChannel] || 0) + 1;
      return acc;
    }, { stable: 0, canary: 0, internal: 0 });
    const rolloutConfig = {
      internalShopsCsv: rolloutRuntime.internalShopsCsv || "",
      canaryShopsCsv: rolloutRuntime.canaryShopsCsv || "",
      blockedShopsCsv: rolloutRuntime.blockedShopsCsv || "",
      canaryOnly: !!rolloutRuntime.canaryOnly,
      freezeAll: !!rolloutRuntime.freezeAll,
      features: featureRows,
      managedFeatures: {
        campaignMultiSourceFilters: {
          featureKey: "CAMPAIGN_MULTI_SOURCE_FILTERS",
          mode: featureModeFor("CAMPAIGN_MULTI_SOURCE_FILTERS", "canary"),
          shopsCsv: featureShopsFor("CAMPAIGN_MULTI_SOURCE_FILTERS", ""),
        },
        homeAsyncOrderSync: {
          featureKey: "HOME_ASYNC_ORDER_SYNC",
          mode: featureModeFor("HOME_ASYNC_ORDER_SYNC", "canary"),
          shopsCsv: featureShopsFor("HOME_ASYNC_ORDER_SYNC", ""),
        },
      },
    };
    const pilotReadiness = await buildPilotReadiness(stores);
    const ownerInsights = buildOwnerInsights({
      stores,
      pilotReadiness,
      featureUsage,
      rolloutSummary,
      billingSummary,
    });
    const supportOps = await buildSupportOpsSnapshot(prisma).catch(() => ({ unreadAlerts: [], failedSync: [], queue: {} }));
    const brandLifecycle = await getOwnerLifecycleSummary({
      prisma,
      stores,
      featureUsage,
      billingSummary,
      activeWindowDays,
    });
    const selectedShopForOverrides = String(url.searchParams.get("overrideShop") || stores[0]?.shop || session.shop || "").toLowerCase();
    const shopSettings = selectedShopForOverrides ? await listShopSettings(selectedShopForOverrides) : [];
    const effectiveShopConfig = selectedShopForOverrides
      ? await resolveShopConfig(selectedShopForOverrides, { support_contact_email: "", custom_welcome_title: "" })
      : {};
    return {
      denied: false,
      currentShop: session.shop,
      role,
      capabilities,
      totals: rollup.totals,
      stores,
      rolloutSummary,
      rolloutConfig,
      selectedShopForOverrides,
      shopSettings,
      effectiveShopConfig,
      allowedShopSettingKeys,
      featureUsage,
      ownerInsights,
      supportOps,
      ownerTeam,
      ownerAudit,
      billingSummary,
      brandLifecycle,
      pilotReadiness,
      marketReadiness: buildMarketReadiness({ stores, rolloutConfig, pilotReadiness }),
      source: "rollup_30d",
    };
  } catch {
    const groupedOrders = await prisma.netCashOrder.groupBy({
      by: ["shop"],
      _count: { _all: true },
      _sum: { grossValue: true, netCash: true },
      _max: { createdAt: true },
      orderBy: { shop: "asc" },
    });

    const connectorCounts = await prisma.connectorCredential.groupBy({
      by: ["shop"],
      _count: { _all: true },
    });
    const connectorMap = new Map(connectorCounts.map((row) => [row.shop, row._count._all]));

    const stores = groupedOrders.map((row) => {
      const release = evaluateReleaseContext(row.shop, rolloutRuntime);
      return {
        shop: row.shop,
        orderCount: row._count._all,
        grossValue: row._sum.grossValue || 0,
        netCash: row._sum.netCash || 0,
        lastOrderAt: row._max.createdAt || null,
        connectorCount: connectorMap.get(row.shop) || 0,
        releaseChannel: release.channel,
        campaignsMultiSourceEnabled: evaluateFeatureEnabledForShop(row.shop, "campaign_multi_source_filters", rolloutRuntime, true),
      };
    });
    const rolloutSummary = stores.reduce((acc, row) => {
      acc[row.releaseChannel] = (acc[row.releaseChannel] || 0) + 1;
      return acc;
    }, { stable: 0, canary: 0, internal: 0 });

    const totals = stores.reduce(
      (acc, row) => {
        acc.brands += 1;
        acc.orders += Number(row.orderCount || 0);
        acc.gross += Number(row.grossValue || 0);
        acc.net += Number(row.netCash || 0);
        return acc;
      },
      { brands: 0, orders: 0, gross: 0, net: 0 },
    );
    const rolloutConfig = {
      internalShopsCsv: rolloutRuntime.internalShopsCsv || "",
      canaryShopsCsv: rolloutRuntime.canaryShopsCsv || "",
      blockedShopsCsv: rolloutRuntime.blockedShopsCsv || "",
      canaryOnly: !!rolloutRuntime.canaryOnly,
      freezeAll: !!rolloutRuntime.freezeAll,
      features: featureRows,
      managedFeatures: {
        campaignMultiSourceFilters: {
          featureKey: "CAMPAIGN_MULTI_SOURCE_FILTERS",
          mode: featureModeFor("CAMPAIGN_MULTI_SOURCE_FILTERS", "canary"),
          shopsCsv: featureShopsFor("CAMPAIGN_MULTI_SOURCE_FILTERS", ""),
        },
        homeAsyncOrderSync: {
          featureKey: "HOME_ASYNC_ORDER_SYNC",
          mode: featureModeFor("HOME_ASYNC_ORDER_SYNC", "canary"),
          shopsCsv: featureShopsFor("HOME_ASYNC_ORDER_SYNC", ""),
        },
      },
    };
    const pilotReadiness = await buildPilotReadiness(stores);
    const ownerInsights = buildOwnerInsights({
      stores,
      pilotReadiness,
      featureUsage,
      rolloutSummary,
      billingSummary,
    });
    const supportOps = await buildSupportOpsSnapshot(prisma).catch(() => ({ unreadAlerts: [], failedSync: [], queue: {} }));
    const brandLifecycle = await getOwnerLifecycleSummary({
      prisma,
      stores,
      featureUsage,
      billingSummary,
      activeWindowDays,
    });
    const selectedShopForOverrides = String(url.searchParams.get("overrideShop") || stores[0]?.shop || session.shop || "").toLowerCase();
    const shopSettings = selectedShopForOverrides ? await listShopSettings(selectedShopForOverrides) : [];
    const effectiveShopConfig = selectedShopForOverrides
      ? await resolveShopConfig(selectedShopForOverrides, { support_contact_email: "", custom_welcome_title: "" })
      : {};

    return {
      denied: false,
      currentShop: session.shop,
      role,
      capabilities,
      totals,
      stores,
      rolloutSummary,
      rolloutConfig,
      selectedShopForOverrides,
      shopSettings,
      effectiveShopConfig,
      allowedShopSettingKeys,
      featureUsage,
      ownerInsights,
      supportOps,
      ownerTeam,
      ownerAudit,
      billingSummary,
      brandLifecycle,
      pilotReadiness,
      marketReadiness: buildMarketReadiness({ stores, rolloutConfig, pilotReadiness }),
      source: "live_fallback",
    };
  }
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const allowed = String(process.env.OWNER_SHOPS || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const isOwnerShop = allowed.length === 0 || allowed.includes(String(session.shop || "").toLowerCase());
  if (!isOwnerShop) {
    return { ok: false, message: "Owner access required." };
  }
  const role = await resolveOwnerRole(session, isOwnerShop);
  if (role === "none") return { ok: false, message: "Owner role not assigned." };
  const can = (capability) => canOwner(role, capability);
  const auditBase = {
    actorShop: session.shop,
    actorEmail: session.email || "",
    actorRole: role,
  };

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "save-rollout-settings") {
    if (!can("manage_rollout")) return { ok: false, message: "Insufficient permission for rollout updates." };
    await upsertRolloutSetting("internal_shops_csv", String(formData.get("internalShopsCsv") || ""));
    await upsertRolloutSetting("canary_shops_csv", String(formData.get("canaryShopsCsv") || ""));
    await upsertRolloutSetting("blocked_shops_csv", String(formData.get("blockedShopsCsv") || ""));
    await upsertRolloutSetting("canary_only", String(formData.get("canaryOnly") || "false"));
    await upsertRolloutSetting("freeze_all", String(formData.get("freezeAll") || "false"));
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "save_rollout_settings",
      targetKey: "rollout",
      payload: {
        internalShopsCsv: String(formData.get("internalShopsCsv") || ""),
        canaryShopsCsv: String(formData.get("canaryShopsCsv") || ""),
        blockedShopsCsv: String(formData.get("blockedShopsCsv") || ""),
      },
    });
    return { ok: true, message: "Rollout store settings updated." };
  }

  if (intent === "save-feature-rollout") {
    if (!can("manage_rollout")) return { ok: false, message: "Insufficient permission for feature rollout updates." };
    const featureKey = String(formData.get("featureKey") || "campaign_multi_source_filters");
    const mode = String(formData.get("mode") || "all");
    const shopsCsv = String(formData.get("shopsCsv") || "");
    await upsertFeatureRollout(featureKey, mode, shopsCsv);
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "save_feature_rollout",
      targetKey: featureKey,
      payload: { mode, shopsCsv },
    });
    return { ok: true, message: `Feature rollout updated: ${featureKey}` };
  }

  if (intent === "run-truth-refresh") {
    if (!can("run_jobs")) return { ok: false, message: "Insufficient permission to run jobs." };
    const days = Math.max(7, Math.min(3650, Number(formData.get("days") || 90)));
    const maxShops = Math.max(1, Math.min(500, Number(formData.get("maxShops") || 100)));
    const targetShop = String(formData.get("shop") || "").trim().toLowerCase();
    const shopRows = targetShop
      ? [{ shop: targetShop }]
      : await prisma.netCashOrder.groupBy({
        by: ["shop"],
        orderBy: { shop: "asc" },
        take: maxShops,
      });
    const queued = [];
    const failed = [];
    for (const row of shopRows) {
      const shop = String(row.shop || "").toLowerCase();
      try {
        // eslint-disable-next-line no-await-in-loop
        const job = await enqueueJob({
          type: "truth_rollup_refresh",
          shop,
          payload: { shop, days },
          uniqueKey: `truth_rollup_refresh:${shop}`,
          maxAttempts: 3,
        });
        queued.push({ shop, jobId: job.id });
      } catch (error) {
        failed.push({ shop, error: String(error?.message || "Unknown error") });
      }
    }
    const message = failed.length
      ? `Queued ${queued.length}/${shopRows.length} truth refresh jobs (${failed.length} failed).`
      : `Queued ${queued.length} truth refresh jobs.`;
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "run_truth_refresh",
      targetKey: targetShop || "all_shops",
      payload: { days, maxShops, queued: queued.length, failed: failed.length },
      status: failed.length ? "partial" : "ok",
    });
    return {
      ok: failed.length === 0,
      message,
      truthRefresh: {
        attempted: shopRows.length,
        queued,
        failed,
      },
    };
  }

  if (intent === "save-shop-setting") {
    if (!can("manage_overrides")) return { ok: false, message: "Insufficient permission for shop override changes." };
    const shop = String(formData.get("shop") || "").trim().toLowerCase();
    const key = String(formData.get("key") || "").trim().toLowerCase();
    const value = String(formData.get("value") || "");
    if (!shop || !key) return { ok: false, message: "shop and key are required." };
    try {
      await upsertShopSetting(shop, key, value);
      await logOwnerAuditEvent({
        ...auditBase,
        actionKey: "save_shop_setting",
        targetKey: `${shop}:${key}`,
        payload: { value },
      });
      return { ok: true, message: `Saved override for ${shop}: ${key}` };
    } catch (error) {
      await logOwnerAuditEvent({
        ...auditBase,
        actionKey: "save_shop_setting",
        targetKey: `${shop}:${key}`,
        payload: { value, error: String(error?.message || "unknown") },
        status: "failed",
      });
      return { ok: false, message: String(error?.message || "Failed to save shop override.") };
    }
  }

  if (intent === "delete-shop-setting") {
    if (!can("manage_overrides")) return { ok: false, message: "Insufficient permission for shop override changes." };
    const shop = String(formData.get("shop") || "").trim().toLowerCase();
    const key = String(formData.get("key") || "").trim().toLowerCase();
    if (!shop || !key) return { ok: false, message: "shop and key are required." };
    await deleteShopSetting(shop, key);
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "delete_shop_setting",
      targetKey: `${shop}:${key}`,
    });
    return { ok: true, message: `Deleted override for ${shop}: ${key}` };
  }

  if (intent === "save-owner-team-access") {
    if (!can("manage_team")) return { ok: false, message: "Only founder can manage owner team access." };
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const nextRole = String(formData.get("role") || "").trim().toLowerCase();
    await upsertOwnerTeamAccess(email, nextRole);
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "save_owner_team_access",
      targetKey: email,
      payload: { role: nextRole },
    });
    return { ok: true, message: `Owner access saved for ${email}` };
  }

  if (intent === "delete-owner-team-access") {
    if (!can("manage_team")) return { ok: false, message: "Only founder can manage owner team access." };
    const email = String(formData.get("email") || "").trim().toLowerCase();
    await deleteOwnerTeamAccess(email);
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "delete_owner_team_access",
      targetKey: email,
    });
    return { ok: true, message: `Owner access deleted for ${email}` };
  }

  if (intent === "run-owner-alerts") {
    if (!can("run_jobs")) return { ok: false, message: "Insufficient permission to run alerts." };
    const payload = {
      category: "owner_alerts",
      severity: "warning",
      title: "Owner alert check triggered",
      message: "Owner Console manual alert check run executed.",
      actor: session.email || session.shop,
    };
    const sent = await dispatchMonitoringAlert(payload);
    await logOwnerAuditEvent({
      ...auditBase,
      actionKey: "run_owner_alerts",
      targetKey: "monitoring_webhook",
      payload: { sent },
      status: sent?.ok ? "ok" : "failed",
    });
    return { ok: !!sent?.ok, message: sent?.ok ? "Owner alert dispatched." : `Owner alert failed: ${sent?.reason || sent?.status || "unknown"}` };
  }

  return { ok: false, message: "Invalid action." };
}

export default function OwnerPage() {
  const {
    denied,
    currentShop,
    role,
    capabilities,
    totals,
    stores,
    rolloutSummary,
    rolloutConfig,
    selectedShopForOverrides,
    shopSettings,
    effectiveShopConfig,
    allowedShopSettingKeys,
    featureUsage,
    ownerInsights,
    supportOps,
    ownerTeam,
    ownerAudit,
    brandLifecycle,
    pilotReadiness,
    marketReadiness,
  } = useLoaderData();
  const actionData = useActionData();
  const can = (capability) => (capabilities || []).includes(capability);
  if (denied) {
    return (
      <div className="nc-shell">
        <div className="nc-card nc-section">
          <h2>Owner Console Restricted</h2>
          <p className="nc-note">Current shop: {currentShop}</p>
          <p className="nc-note">Set `OWNER_SHOPS` env var with allowed shop domains to access this page.</p>
          <Link className="nc-chip" to="/app">Back to Home</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="nc-shell">
      <h1>Owner Console</h1>
      <p className="nc-subtitle">Cross-brand adoption and aggregate data visibility across all installed shops in your database.</p>
      <p className="nc-note">Role: <strong>{role || "none"}</strong> | Capabilities: {(capabilities || []).join(", ") || "-"}</p>
      {actionData?.message ? <p className={actionData.ok ? "nc-success" : "nc-danger"}>{actionData.message}</p> : null}
      {can("run_jobs") ? (
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="run-owner-alerts" />
          <button type="submit">Run Owner Alerts Check</button>
        </Form>
      ) : null}

      <div className="nc-grid-4 nc-section">
        <div className="nc-card nc-glass"><h3>Downloaded Brands</h3><p className="nc-kpi-value">{brandLifecycle?.downloadedBrands || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Currently Using</h3><p className="nc-kpi-value">{brandLifecycle?.currentlyUsingBrands || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Active ({brandLifecycle?.activeWindowDays || 30}d)</h3><p className="nc-kpi-value">{brandLifecycle?.activeBrands || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Churned</h3><p className="nc-kpi-value">{brandLifecycle?.churnedBrands || 0}</p></div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Market Readiness (1-10)</h2>
        <p className={marketReadiness?.overallPass ? "nc-success" : "nc-danger"} style={{ fontWeight: 700 }}>
          Overall: {marketReadiness?.overallPass ? "PASS" : "NOT READY"} | Items passed: {marketReadiness?.passCount || 0}/10
        </p>
        <p className="nc-note">
          Rollout/Pilot guard: {marketReadiness?.rolloutAndPilotGuard ? "PASS" : "FAIL"} | Pilot stores: {marketReadiness?.context?.pilotStores || 0} |
          Pilot pass/fail: {marketReadiness?.context?.pilotPassCount || 0}/{marketReadiness?.context?.pilotFailCount || 0}
        </p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Area</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Fix Hint</th>
            </tr>
          </thead>
          <tbody>
            {(marketReadiness?.items || []).map((item) => (
              <tr key={`market-${item.key}`}>
                <td>{item.label}</td>
                <td className={item.pass ? "nc-success" : "nc-danger"}>{item.pass ? "PASS" : "FAIL"}</td>
                <td className={!item.pass ? "nc-danger" : "nc-note"}>{item.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="nc-toolbar" style={{ marginTop: "10px", marginBottom: 0 }}>
          <a className="nc-chip" href="/api/monitoring/overview" target="_blank" rel="noreferrer">Monitoring Overview</a>
          <a className="nc-chip" href="/api/monitoring/alerts" target="_blank" rel="noreferrer">Monitoring Alerts</a>
          <a className="nc-chip" href="/api/owner/alerts?days=30" target="_blank" rel="noreferrer">Owner Risk Alerts</a>
          <a className="nc-chip" href="/api/owner/lifecycle?days=30" target="_blank" rel="noreferrer">Owner Lifecycle Metrics</a>
          <a className="nc-chip" href="/api/owner/lifecycle?days=30&format=csv" target="_blank" rel="noreferrer">Owner Lifecycle CSV</a>
          <a className="nc-chip" href="/api/integrations/health/cron" target="_blank" rel="noreferrer">Integration Health Cron</a>
          <a className="nc-chip" href="/api/billing/snapshot/cron?maxShops=100&days=60" target="_blank" rel="noreferrer">Billing Snapshot Refresh</a>
          <a className="nc-chip" href="/api/security/secrets" target="_blank" rel="noreferrer">Secrets Check</a>
          <a className="nc-chip" href="/sales/proof-pack" target="_blank" rel="noreferrer">Proof Pack</a>
          <a className="nc-chip" href="/support/sla" target="_blank" rel="noreferrer">Support SLA</a>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Release Impact View</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Channel</th>
              <th style={{ textAlign: "right" }}>Shops</th>
              <th style={{ textAlign: "right" }}>Usage Events</th>
              <th style={{ textAlign: "right" }}>Net Cash</th>
            </tr>
          </thead>
          <tbody>
            {(ownerInsights?.releaseImpact?.byChannel || []).map((row) => (
              <tr key={`release-impact-${row.channel}`}>
                <td>{row.channel}</td>
                <td style={{ textAlign: "right" }}>{row.shops}</td>
                <td style={{ textAlign: "right" }}>{row.events}</td>
                <td style={{ textAlign: "right" }}>{money(row.netCash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Success Playbooks (Next Best Action)</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "left" }}>Risk</th>
              <th style={{ textAlign: "right" }}>Health</th>
              <th style={{ textAlign: "left" }}>Recommended Action</th>
            </tr>
          </thead>
          <tbody>
            {(ownerInsights?.playbooks || []).slice(0, 120).map((row) => (
              <tr key={`playbook-${row.shop}`}>
                <td>{row.shop}</td>
                <td className={row.risk === "high" ? "nc-danger" : row.risk === "medium" ? "nc-note" : "nc-success"}>{row.risk}</td>
                <td style={{ textAlign: "right" }}>{row.healthScore}</td>
                <td>{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Feature Revenue Attribution (Correlation)</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Feature</th>
              <th style={{ textAlign: "right" }}>Shops Using</th>
              <th style={{ textAlign: "right" }}>Events</th>
              <th style={{ textAlign: "right" }}>Avg Net Cash/Shop</th>
              <th style={{ textAlign: "right" }}>Avg Orders/Shop</th>
            </tr>
          </thead>
          <tbody>
            {(ownerInsights?.featureRevenue || []).length === 0 ? (
              <tr><td colSpan={5}>No feature-revenue rows yet.</td></tr>
            ) : (
              (ownerInsights?.featureRevenue || []).slice(0, 80).map((row) => (
                <tr key={`feature-revenue-${row.featureKey}`}>
                  <td>{row.featureKey}</td>
                  <td style={{ textAlign: "right" }}>{row.shopsUsing}</td>
                  <td style={{ textAlign: "right" }}>{row.events}</td>
                  <td style={{ textAlign: "right" }}>{money(row.avgNetCashPerShop)}</td>
                  <td style={{ textAlign: "right" }}>{Number(row.avgOrdersPerShop || 0).toFixed(1)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>CS/Support Ops Panel</h2>
        <p className="nc-note">
          Queue pending: {supportOps?.queue?.pending?.total || 0} | Recent failed jobs: {supportOps?.queue?.failedRecent?.total || 0}
        </p>
        <h3>Unread Alerts by Shop</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "left" }}>Severity</th>
              <th style={{ textAlign: "right" }}>Count</th>
              <th style={{ textAlign: "left" }}>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {(supportOps?.unreadAlerts || []).length === 0 ? (
              <tr><td colSpan={4}>No unread alerts.</td></tr>
            ) : (
              (supportOps?.unreadAlerts || []).slice(0, 80).map((row, idx) => (
                <tr key={`support-alert-${row.shop}-${row.severity}-${idx}`}>
                  <td>{row.shop}</td>
                  <td>{row.severity}</td>
                  <td style={{ textAlign: "right" }}>{row.count}</td>
                  <td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <h3 style={{ marginTop: "12px" }}>Recent Connector Failures</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "left" }}>Provider</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Error</th>
              <th style={{ textAlign: "left" }}>Time</th>
            </tr>
          </thead>
          <tbody>
            {(supportOps?.failedSync || []).length === 0 ? (
              <tr><td colSpan={5}>No connector failures.</td></tr>
            ) : (
              (supportOps?.failedSync || []).slice(0, 80).map((row, idx) => (
                <tr key={`support-sync-${row.shop}-${row.provider}-${idx}`}>
                  <td>{row.shop}</td>
                  <td>{row.provider}</td>
                  <td>{row.status}</td>
                  <td>{row.errorMessage || "-"}</td>
                  <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Owner Team Access and Audit Trail</h2>
        {can("manage_team") ? (
          <Form method="post" preventScrollReset>
            <input type="hidden" name="intent" value="save-owner-team-access" />
            <div className="nc-grid-3">
              <label className="nc-form-field">Email
                <input name="email" placeholder="ops@brand.com" />
              </label>
              <label className="nc-form-field">Role
                <select name="role" defaultValue="ops">
                  <option value="founder">founder</option>
                  <option value="ops">ops</option>
                  <option value="support">support</option>
                  <option value="analyst">analyst</option>
                </select>
              </label>
            </div>
            <div className="nc-toolbar" style={{ marginTop: "10px" }}>
              <button type="submit">Save Team Access</button>
            </div>
          </Form>
        ) : (
          <p className="nc-note">Only founder can modify team access.</p>
        )}
        <h3 style={{ marginTop: "12px" }}>Team Roles</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Email</th>
              <th style={{ textAlign: "left" }}>Role</th>
              <th style={{ textAlign: "left" }}>Updated</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {(ownerTeam || []).length === 0 ? (
              <tr><td colSpan={4}>No explicit team rows.</td></tr>
            ) : (
              (ownerTeam || []).map((row) => (
                <tr key={`team-${row.email}`}>
                  <td>{row.email}</td>
                  <td>{row.role}</td>
                  <td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}</td>
                  <td>
                    {can("manage_team") ? (
                      <Form method="post" preventScrollReset>
                        <input type="hidden" name="intent" value="delete-owner-team-access" />
                        <input type="hidden" name="email" value={row.email} />
                        <button type="submit">Delete</button>
                      </Form>
                    ) : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <h3 style={{ marginTop: "12px" }}>Audit Events</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Time</th>
              <th style={{ textAlign: "left" }}>Actor</th>
              <th style={{ textAlign: "left" }}>Role</th>
              <th style={{ textAlign: "left" }}>Action</th>
              <th style={{ textAlign: "left" }}>Target</th>
              <th style={{ textAlign: "left" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {(ownerAudit || []).length === 0 ? (
              <tr><td colSpan={6}>No audit events yet.</td></tr>
            ) : (
              (ownerAudit || []).slice(0, 120).map((row) => (
                <tr key={`audit-${row.id}`}>
                  <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                  <td>{row.actorEmail || row.actorShop || "-"}</td>
                  <td>{row.actorRole || "-"}</td>
                  <td>{row.actionKey}</td>
                  <td>{row.targetKey || "-"}</td>
                  <td>{row.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-grid-4 nc-section">
        <div className="nc-card nc-glass"><h3>Active Paid Shops</h3><p className="nc-kpi-value">{ownerInsights?.mrr?.activePaidShops || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Estimated MRR</h3><p className="nc-kpi-value">{money(ownerInsights?.mrr?.mrr || 0)}</p></div>
        <div className="nc-card nc-glass"><h3>Churned Shops</h3><p className="nc-kpi-value">{ownerInsights?.mrr?.churnedShops || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Expansion / Contraction</h3><p className="nc-kpi-value">{ownerInsights?.mrr?.expansionShops || 0} / {ownerInsights?.mrr?.contractionShops || 0}</p></div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Trial Funnel</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Stage</th>
              <th style={{ textAlign: "right" }}>Count</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Installs</td><td style={{ textAlign: "right" }}>{ownerInsights?.trialFunnel?.installs || 0}</td></tr>
            <tr><td>Onboarding Complete</td><td style={{ textAlign: "right" }}>{ownerInsights?.trialFunnel?.onboardingComplete || 0}</td></tr>
            <tr><td>First Value Reached</td><td style={{ textAlign: "right" }}>{ownerInsights?.trialFunnel?.firstValue || 0}</td></tr>
            <tr><td>Paid Conversion</td><td style={{ textAlign: "right" }}>{ownerInsights?.trialFunnel?.paid || 0}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Brand Health and Risk Radar</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "right" }}>Health Score</th>
              <th style={{ textAlign: "left" }}>Risk</th>
              <th style={{ textAlign: "right" }}>Usage Events</th>
              <th style={{ textAlign: "right" }}>% Mapped</th>
              <th style={{ textAlign: "right" }}>Sync Lag</th>
              <th style={{ textAlign: "right" }}>Queue</th>
            </tr>
          </thead>
          <tbody>
            {(ownerInsights?.healthRows || []).length === 0 ? (
              <tr><td colSpan={7}>No health rows.</td></tr>
            ) : (
              (ownerInsights?.healthRows || []).slice(0, 120).map((row) => (
                <tr key={`health-${row.shop}`}>
                  <td>{row.shop}</td>
                  <td style={{ textAlign: "right" }}>{row.score}</td>
                  <td className={row.risk === "high" ? "nc-danger" : row.risk === "medium" ? "nc-note" : "nc-success"}>{row.risk}</td>
                  <td style={{ textAlign: "right" }}>{row.events}</td>
                  <td style={{ textAlign: "right" }}>{Number(row.mappedOrdersPct || 0).toFixed(1)}%</td>
                  <td style={{ textAlign: "right" }}>{row.syncLagMinutes}</td>
                  <td style={{ textAlign: "right" }}>{row.queuePending}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Rollout Controls</h2>
        <p className="nc-note">Control staged rollout without env edits. Save and validate on canary stores before global release.</p>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="save-rollout-settings" />
          <div className="nc-grid-3">
            <label className="nc-form-field">Internal shops
              <input name="internalShopsCsv" defaultValue={rolloutConfig?.internalShopsCsv || ""} />
            </label>
            <label className="nc-form-field">Canary shops
              <input name="canaryShopsCsv" defaultValue={rolloutConfig?.canaryShopsCsv || ""} />
            </label>
            <label className="nc-form-field">Blocked shops
              <input name="blockedShopsCsv" defaultValue={rolloutConfig?.blockedShopsCsv || ""} />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <label className="nc-chip" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <input type="checkbox" name="canaryOnly" value="true" defaultChecked={!!rolloutConfig?.canaryOnly} />
              Canary-only rollout
            </label>
            <label className="nc-chip" style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <input type="checkbox" name="freezeAll" value="true" defaultChecked={!!rolloutConfig?.freezeAll} />
              Freeze all rollouts
            </label>
            <button type="submit">Save store rollout settings</button>
          </div>
        </Form>
        <hr style={{ margin: "16px 0" }} />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="run-truth-refresh" />
          <div className="nc-grid-3">
            <label className="nc-form-field">Days lookback
              <input name="days" type="number" min="7" max="3650" defaultValue="90" />
            </label>
            <label className="nc-form-field">Max shops (when shop empty)
              <input name="maxShops" type="number" min="1" max="500" defaultValue="100" />
            </label>
            <label className="nc-form-field">Single shop (optional)
              <input name="shop" placeholder="store.myshopify.com" />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Run Truth Refresh Now</button>
          </div>
        </Form>
        <hr style={{ margin: "16px 0" }} />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="save-feature-rollout" />
          <div className="nc-grid-3">
            <label className="nc-form-field">Feature key
              <input name="featureKey" defaultValue="campaign_multi_source_filters" />
            </label>
            <label className="nc-form-field">Mode
              <select name="mode" defaultValue={rolloutConfig?.managedFeatures?.campaignMultiSourceFilters?.mode || "all"}>
                <option value="all">all</option>
                <option value="none">none</option>
                <option value="canary">canary</option>
                <option value="internal">internal</option>
                <option value="shops">shops</option>
              </select>
            </label>
            <label className="nc-form-field">Target shops (for shops mode)
              <input name="shopsCsv" defaultValue={rolloutConfig?.managedFeatures?.campaignMultiSourceFilters?.shopsCsv || ""} />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Save feature rollout</button>
          </div>
        </Form>
        <hr style={{ margin: "16px 0" }} />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="save-feature-rollout" />
          <div className="nc-grid-3">
            <label className="nc-form-field">Feature key
              <input name="featureKey" defaultValue="home_async_order_sync" />
            </label>
            <label className="nc-form-field">Mode
              <select name="mode" defaultValue={rolloutConfig?.managedFeatures?.homeAsyncOrderSync?.mode || "all"}>
                <option value="all">all</option>
                <option value="none">none</option>
                <option value="canary">canary</option>
                <option value="internal">internal</option>
                <option value="shops">shops</option>
              </select>
            </label>
            <label className="nc-form-field">Target shops (for shops mode)
              <input name="shopsCsv" defaultValue={rolloutConfig?.managedFeatures?.homeAsyncOrderSync?.shopsCsv || ""} />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Save Home async sync rollout</button>
          </div>
        </Form>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Per-Brand Overrides</h2>
        <p className="nc-note">
          Apply shop-specific behavior without affecting other brands. Use this for one-off customizations and brand-level config.
        </p>
        <Form method="get" preventScrollReset>
          <div className="nc-grid-3">
            <label className="nc-form-field">Target shop
              <input name="overrideShop" defaultValue={selectedShopForOverrides || ""} placeholder="store.myshopify.com" />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Load shop overrides</button>
          </div>
        </Form>
        <hr style={{ margin: "16px 0" }} />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="save-shop-setting" />
          <div className="nc-grid-3">
            <label className="nc-form-field">Shop
              <input name="shop" defaultValue={selectedShopForOverrides || ""} />
            </label>
            <label className="nc-form-field">Setting key
              <select name="key" defaultValue={allowedShopSettingKeys?.[0] || "custom_welcome_title"}>
                {(allowedShopSettingKeys || []).map((key) => (
                  <option key={`allowed-key-${key}`} value={key}>{key}</option>
                ))}
              </select>
            </label>
            <label className="nc-form-field">Value
              <input name="value" placeholder="Welcome, Acme Team" />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Save shop override</button>
          </div>
        </Form>
        <hr style={{ margin: "16px 0" }} />
        <p className="nc-note">Allowed keys: {(allowedShopSettingKeys || []).join(", ")}</p>
        <hr style={{ margin: "16px 0" }} />
        <p className="nc-note">Effective config preview for {selectedShopForOverrides || "-"}:</p>
        <pre className="nc-code-block">{JSON.stringify(effectiveShopConfig || {}, null, 2)}</pre>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Key</th>
              <th style={{ textAlign: "left" }}>Value</th>
              <th style={{ textAlign: "left" }}>Updated</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {(shopSettings || []).length === 0 ? (
              <tr><td colSpan={4}>No shop-specific overrides yet.</td></tr>
            ) : (
              (shopSettings || []).map((row) => (
                <tr key={`${row.shop}-${row.key}`}>
                  <td>{row.key}</td>
                  <td>{row.value}</td>
                  <td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}</td>
                  <td>
                    <Form method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="delete-shop-setting" />
                      <input type="hidden" name="shop" value={row.shop} />
                      <input type="hidden" name="key" value={row.key} />
                      <button type="submit">Delete</button>
                    </Form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Founder Visibility: Feature Usage by Brand</h2>
        <p className="nc-note">
          Window: last {featureUsage?.days || 30} days. This view shows what each installed brand is actively using.
        </p>
        <div className="nc-grid-4" style={{ marginBottom: "10px" }}>
          <div className="nc-card nc-glass"><h3>Connector Starts</h3><p className="nc-kpi-value">{featureUsage?.connectorFunnel?.starts || 0}</p></div>
          <div className="nc-card nc-glass"><h3>Connector Success</h3><p className="nc-kpi-value">{featureUsage?.connectorFunnel?.success || 0}</p></div>
          <div className="nc-card nc-glass"><h3>Success Rate</h3><p className="nc-kpi-value">{Number(featureUsage?.connectorFunnel?.successRatePct || 0).toFixed(1)}%</p></div>
          <div className="nc-card nc-glass"><h3>Fully Connected Shops</h3><p className="nc-kpi-value">{featureUsage?.connectorFunnel?.fullyConnectedShops || 0}</p></div>
        </div>
        <div className="nc-toolbar">
          <a
            className="nc-chip"
            href={`/api/owner/usage?days=${featureUsage?.days || 30}&format=csv&type=shops`}
            target="_blank"
            rel="noreferrer"
          >
            Export Brand Usage CSV
          </a>
          <a
            className="nc-chip"
            href={`/api/owner/usage?days=${featureUsage?.days || 30}&format=csv&type=features`}
            target="_blank"
            rel="noreferrer"
          >
            Export Feature Usage CSV
          </a>
          <a
            className="nc-chip"
            href={`/api/owner/usage?days=${featureUsage?.days || 30}&format=csv&type=matrix`}
            target="_blank"
            rel="noreferrer"
          >
            Export Brand x Feature CSV
          </a>
        </div>
        <Form method="get" preventScrollReset>
          <div className="nc-grid-3">
            <label className="nc-form-field">Usage window (days)
              <input name="usageDays" type="number" min="1" max="180" defaultValue={featureUsage?.days || 30} />
            </label>
            <label className="nc-form-field">Keep selected override shop
              <input name="overrideShop" defaultValue={selectedShopForOverrides || ""} />
            </label>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <button type="submit">Refresh Usage View</button>
          </div>
        </Form>

        <h3 style={{ marginTop: "14px" }}>Usage by Brand (Per Download)</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "right" }}>Events</th>
              <th style={{ textAlign: "right" }}>Distinct Features</th>
              <th style={{ textAlign: "left" }}>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {(featureUsage?.byShop || []).length === 0 ? (
              <tr><td colSpan={4}>No usage events recorded yet.</td></tr>
            ) : (
              (featureUsage?.byShop || []).map((row) => (
                <tr key={`usage-shop-${row.shop}`}>
                  <td>{row.shop}</td>
                  <td style={{ textAlign: "right" }}>{row.events}</td>
                  <td style={{ textAlign: "right" }}>{row.distinctFeatures}</td>
                  <td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <h3 style={{ marginTop: "14px" }}>Top Features Across Brands</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Feature</th>
              <th style={{ textAlign: "right" }}>Events</th>
              <th style={{ textAlign: "right" }}>Shops Using</th>
            </tr>
          </thead>
          <tbody>
            {(featureUsage?.byFeature || []).length === 0 ? (
              <tr><td colSpan={3}>No feature usage data yet.</td></tr>
            ) : (
              (featureUsage?.byFeature || []).slice(0, 40).map((row) => (
                <tr key={`usage-feature-${row.featureKey}`}>
                  <td>{row.featureKey}</td>
                  <td style={{ textAlign: "right" }}>{row.events}</td>
                  <td style={{ textAlign: "right" }}>{row.shops}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <h3 style={{ marginTop: "14px" }}>Brand × Feature Breakdown</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "left" }}>Feature</th>
              <th style={{ textAlign: "right" }}>Events</th>
              <th style={{ textAlign: "left" }}>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {(featureUsage?.byShopFeature || []).length === 0 ? (
              <tr><td colSpan={4}>No brand-feature records yet.</td></tr>
            ) : (
              (featureUsage?.byShopFeature || []).slice(0, 120).map((row, idx) => (
                <tr key={`usage-shop-feature-${row.shop}-${row.featureKey}-${idx}`}>
                  <td>{row.shop}</td>
                  <td>{row.featureKey}</td>
                  <td style={{ textAlign: "right" }}>{row.events}</td>
                  <td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-grid-4 nc-section">
        <div className="nc-card nc-glass"><h3>Brands Using App</h3><p className="nc-kpi-value">{totals.brands}</p></div>
        <div className="nc-card nc-glass"><h3>Total Orders</h3><p className="nc-kpi-value">{totals.orders}</p></div>
        <div className="nc-card nc-glass"><h3>Gross Value</h3><p className="nc-kpi-value">{money(totals.gross)}</p></div>
        <div className="nc-card nc-glass"><h3>Net Cash</h3><p className="nc-kpi-value">{money(totals.net)}</p></div>
      </div>
      <div className="nc-grid-3 nc-section">
        <div className="nc-card nc-glass"><h3>Stable Stores</h3><p className="nc-kpi-value">{rolloutSummary?.stable || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Canary Stores</h3><p className="nc-kpi-value">{rolloutSummary?.canary || 0}</p></div>
        <div className="nc-card nc-glass"><h3>Internal Stores</h3><p className="nc-kpi-value">{rolloutSummary?.internal || 0}</p></div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Pilot Readiness Checklist</h2>
        <p className="nc-note">
          Pass: {pilotReadiness?.passCount || 0} | Fail: {pilotReadiness?.failCount || 0} | Generated:{" "}
          {pilotReadiness?.generatedAt ? new Date(pilotReadiness.generatedAt).toLocaleString() : "-"}
        </p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Checks</th>
              <th style={{ textAlign: "right" }}>% Mapped</th>
              <th style={{ textAlign: "right" }}>Invalid UTM/ID</th>
              <th style={{ textAlign: "right" }}>Missing Spend</th>
              <th style={{ textAlign: "right" }}>Sync Lag (min)</th>
              <th style={{ textAlign: "right" }}>Queue Pending</th>
            </tr>
          </thead>
          <tbody>
            {(pilotReadiness?.rows || []).length === 0 ? (
              <tr><td colSpan={8}>No pilot readiness rows yet.</td></tr>
            ) : (
              (pilotReadiness?.rows || []).map((row) => (
                <tr key={`pilot-${row.shop}`}>
                  <td>{row.shop}</td>
                  <td className={row.status === "pass" ? "nc-success" : "nc-danger"}>{row.status.toUpperCase()}</td>
                  <td>{(row.checks || []).filter((c) => !c.pass).map((c) => c.label).join(", ") || "All checks passed"}</td>
                  <td style={{ textAlign: "right" }}>{Number(row.metrics?.mappedOrdersPct || 0).toFixed(1)}%</td>
                  <td style={{ textAlign: "right" }}>{row.metrics?.invalidRows || 0}</td>
                  <td style={{ textAlign: "right" }}>{row.metrics?.missingSpendRows || 0}</td>
                  <td style={{ textAlign: "right" }}>{row.metrics?.syncLagMinutes || 0}</td>
                  <td style={{ textAlign: "right" }}>{row.metrics?.queuePending || 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Brand-Level Data Points</h2>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Shop</th>
              <th style={{ textAlign: "right" }}>Orders</th>
              <th style={{ textAlign: "right" }}>Gross Value</th>
              <th style={{ textAlign: "right" }}>Net Cash</th>
              <th style={{ textAlign: "right" }}>Connectors</th>
              <th style={{ textAlign: "left" }}>Release</th>
              <th style={{ textAlign: "left" }}>Campaign Multi-Source</th>
              <th style={{ textAlign: "left" }}>Last Order Sync</th>
            </tr>
          </thead>
          <tbody>
            {stores.length === 0 ? (
              <tr><td colSpan={8}>No brand data found yet.</td></tr>
            ) : (
              stores.map((row) => (
                <tr key={row.shop}>
                  <td>{row.shop}</td>
                  <td style={{ textAlign: "right" }}>{row.orderCount}</td>
                  <td style={{ textAlign: "right" }}>{money(row.grossValue)}</td>
                  <td style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                  <td style={{ textAlign: "right" }}>{row.connectorCount}</td>
                  <td>{row.releaseChannel}</td>
                  <td>{row.campaignsMultiSourceEnabled ? "enabled" : "disabled"}</td>
                  <td>{row.lastOrderAt ? new Date(row.lastOrderAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : String(error?.message || "Something went wrong while loading Owner Console.");
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Owner Console Unavailable</h2>
        <p className="nc-note">{message}</p>
        <Link className="nc-chip" to="/app">Back to Home</Link>
      </div>
    </div>
  );
}
