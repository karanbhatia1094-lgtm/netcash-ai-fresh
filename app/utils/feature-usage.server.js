import crypto from "node:crypto";
import { prisma } from "../../prisma.client.js";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export async function ensureFeatureUsageTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS feature_usage_event (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      event_name TEXT NOT NULL,
      route_path TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_feature_usage_shop_created ON feature_usage_event(shop, created_at)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_feature_usage_feature_created ON feature_usage_event(feature_key, created_at)",
  );
}

function toFeatureKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

export async function recordFeatureUsageEvent(shop, event = {}) {
  try {
    await ensureFeatureUsageTable();
    const id = crypto.randomUUID();
    const safeShop = String(shop || "").trim().toLowerCase();
    if (!safeShop) return { ok: false, reason: "shop_required" };
    const featureKey = toFeatureKey(event.featureKey || event.page || event.event || "unknown");
    const eventName = String(event.event || event.eventName || "view").trim().toLowerCase().slice(0, 80) || "view";
    const routePath = String(event.path || event.routePath || "").slice(0, 300);
    await prisma.$executeRawUnsafe(
      `INSERT INTO feature_usage_event (id, shop, feature_key, event_name, route_path, payload_json, created_at)
       VALUES (
         ${sqlQuote(id)},
         ${sqlQuote(safeShop)},
         ${sqlQuote(featureKey)},
         ${sqlQuote(eventName)},
         ${sqlQuote(routePath)},
         ${sqlQuote(safeJsonStringify(event.payload || {}))},
         ${sqlQuote(new Date().toISOString())}
       )`,
    );
    return { ok: true, id };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

export async function getFeatureUsageSummary({ days = 30, maxShops = 100, maxFeatures = 200 } = {}) {
  await ensureFeatureUsageTable();
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const safeMaxShops = Math.max(1, Math.min(500, Number(maxShops) || 100));
  const safeMaxFeatures = Math.max(1, Math.min(1000, Number(maxFeatures) || 200));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();

  const byShop = await prisma.$queryRawUnsafe(
    `SELECT shop,
            COUNT(*) as events,
            COUNT(DISTINCT feature_key) as distinctFeatures,
            MAX(created_at) as lastSeenAt
     FROM feature_usage_event
     WHERE created_at >= ${sqlQuote(since)}
     GROUP BY shop
     ORDER BY events DESC
     LIMIT ${safeMaxShops}`,
  );

  const byFeature = await prisma.$queryRawUnsafe(
    `SELECT feature_key as featureKey,
            COUNT(*) as events,
            COUNT(DISTINCT shop) as shops
     FROM feature_usage_event
     WHERE created_at >= ${sqlQuote(since)}
     GROUP BY feature_key
     ORDER BY events DESC
     LIMIT ${safeMaxFeatures}`,
  );

  const byShopFeature = await prisma.$queryRawUnsafe(
    `SELECT shop,
            feature_key as featureKey,
            COUNT(*) as events,
            MAX(created_at) as lastSeenAt
     FROM feature_usage_event
     WHERE created_at >= ${sqlQuote(since)}
     GROUP BY shop, feature_key
     ORDER BY events DESC
     LIMIT ${safeMaxFeatures}`,
  );

  const connectorFunnelRows = await prisma.$queryRawUnsafe(
    `SELECT event_name as eventName,
            feature_key as featureKey,
            COUNT(*) as events
     FROM feature_usage_event
     WHERE created_at >= ${sqlQuote(since)}
       AND feature_key IN ('connector_meta', 'connector_google')
       AND event_name IN ('connector_oauth_start', 'connector_oauth_success', 'connector_oauth_fail', 'connector_oauth_sync_success', 'connector_oauth_sync_fail')
     GROUP BY event_name, feature_key`,
  );
  const fullyConnectedRows = await prisma.$queryRawUnsafe(
    `SELECT shop,
            COUNT(DISTINCT feature_key) as providersConnected
     FROM feature_usage_event
     WHERE created_at >= ${sqlQuote(since)}
       AND feature_key IN ('connector_meta', 'connector_google')
       AND event_name = 'connector_oauth_success'
     GROUP BY shop`,
  );
  const connectorFunnel = {
    starts: 0,
    success: 0,
    fail: 0,
    syncSuccess: 0,
    syncFail: 0,
    metaStarts: 0,
    googleStarts: 0,
    fullyConnectedShops: (fullyConnectedRows || []).filter((row) => Number(row.providersConnected || 0) >= 2).length,
  };
  for (const row of connectorFunnelRows || []) {
    const eventName = String(row.eventName || "");
    const featureKey = String(row.featureKey || "");
    const count = Number(row.events || 0);
    if (eventName === "connector_oauth_start") connectorFunnel.starts += count;
    if (eventName === "connector_oauth_success") connectorFunnel.success += count;
    if (eventName === "connector_oauth_fail") connectorFunnel.fail += count;
    if (eventName === "connector_oauth_sync_success") connectorFunnel.syncSuccess += count;
    if (eventName === "connector_oauth_sync_fail") connectorFunnel.syncFail += count;
    if (eventName === "connector_oauth_start" && featureKey === "connector_meta") connectorFunnel.metaStarts += count;
    if (eventName === "connector_oauth_start" && featureKey === "connector_google") connectorFunnel.googleStarts += count;
  }
  connectorFunnel.successRatePct = connectorFunnel.starts > 0
    ? (connectorFunnel.success / connectorFunnel.starts) * 100
    : 0;

  return {
    days: safeDays,
    since,
    byShop: byShop || [],
    byFeature: byFeature || [],
    byShopFeature: byShopFeature || [],
    connectorFunnel,
  };
}
