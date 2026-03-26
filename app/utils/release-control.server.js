async function getPrisma() {
  const mod = await import("./db.server.js");
  return mod.prisma;
}

function parseShopList(value) {
  return String(value || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
}

function toFlagKey(featureKey) {
  return String(featureKey || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ALLOWED_SHOP_SETTING_KEYS = Object.freeze([
  "custom_welcome_title",
  "support_contact_email",
  "brand_priority_tier",
  "custom_alert_webhook",
  "billing_contact_email",
  "billing_status",
  "billing_plan",
  "billing_amount_mrr",
  "billing_previous_amount_mrr",
  "pilot_notes",
  "feature_pack",
  "connector_actions_enabled",
  "channel_actions_enabled_csv",
  "growth_guardrail_max_cac",
  "growth_guardrail_min_margin_pct",
  "growth_guardrail_max_rto_pct",
  "growth_guardrail_max_discount_pct",
  "growth_guardrail_max_refund_pct",
  "growth_experiment_log",
]);

export function getAllowedShopSettingKeys() {
  return [...ALLOWED_SHOP_SETTING_KEYS];
}

export function runtimeFromEnv() {
  const featureMap = {};
  for (const [key, value] of Object.entries(process.env || {})) {
    const modeMatch = key.match(/^FEATURE_(.+)_ROLLOUT$/);
    if (!modeMatch) continue;
    const flagKey = modeMatch[1];
    const shops = process.env[`FEATURE_${flagKey}_SHOPS`] || "";
    featureMap[flagKey] = {
      mode: String(value || "all").trim().toLowerCase(),
      shopsCsv: shops,
    };
  }
  return {
    internalShopsCsv: process.env.ROLLOUT_INTERNAL_SHOPS || "",
    canaryShopsCsv: process.env.ROLLOUT_CANARY_SHOPS || "",
    blockedShopsCsv: process.env.ROLLOUT_BLOCKED_SHOPS || "",
    canaryOnly: parseBool(process.env.ROLLOUT_CANARY_ONLY, false),
    freezeAll: parseBool(process.env.ROLLOUT_FREEZE_ALL, false),
    featureMap,
  };
}

function mergeRuntime(base, override = {}) {
  return {
    internalShopsCsv: override.internalShopsCsv ?? base.internalShopsCsv ?? "",
    canaryShopsCsv: override.canaryShopsCsv ?? base.canaryShopsCsv ?? "",
    blockedShopsCsv: override.blockedShopsCsv ?? base.blockedShopsCsv ?? "",
    canaryOnly: override.canaryOnly ?? base.canaryOnly ?? false,
    freezeAll: override.freezeAll ?? base.freezeAll ?? false,
    featureMap: {
      ...(base.featureMap || {}),
      ...(override.featureMap || {}),
    },
  };
}

export function evaluateReleaseContext(shop, runtime = runtimeFromEnv()) {
  const safeShop = String(shop || "").trim().toLowerCase();
  const internalShops = parseShopList(runtime.internalShopsCsv);
  const canaryShops = parseShopList(runtime.canaryShopsCsv);
  const blockedShops = parseShopList(runtime.blockedShopsCsv);
  const freezeAll = parseBool(runtime.freezeAll, false);

  const isInternal = internalShops.includes(safeShop);
  const isCanary = isInternal || canaryShops.includes(safeShop);
  const canaryOnly = parseBool(runtime.canaryOnly, false);
  const isBlocked = blockedShops.includes(safeShop);
  const channel = isInternal ? "internal" : isCanary ? "canary" : canaryOnly ? "blocked" : "stable";

  return {
    shop: safeShop,
    channel,
    isInternal,
    isCanary,
    isBlocked: isBlocked || (canaryOnly && !isCanary),
    canaryOnly,
    freezeAll,
  };
}

export function evaluateFeatureEnabledForShop(shop, featureKey, runtime = runtimeFromEnv(), fallback = false) {
  const release = evaluateReleaseContext(shop, runtime);
  if (release.isBlocked) return false;
  if (release.freezeAll) return false;

  const key = toFlagKey(featureKey);
  if (!key) return fallback;

  const feature = runtime.featureMap?.[key] || {};
  const mode = String(feature.mode || "all").trim().toLowerCase();
  const explicitShops = parseShopList(feature.shopsCsv || "");

  if (mode === "none") return false;
  if (mode === "all") return true;
  if (mode === "canary") return release.isCanary;
  if (mode === "internal") return release.isInternal;
  if (mode === "shops") return explicitShops.includes(release.shop);
  return fallback;
}

export function getReleaseContext(shop) {
  return evaluateReleaseContext(shop, runtimeFromEnv());
}

export function isFeatureEnabledForShop(shop, featureKey, fallback = false) {
  return evaluateFeatureEnabledForShop(shop, featureKey, runtimeFromEnv(), fallback);
}

export async function ensureReleaseControlTables() {
  const prisma = await getPrisma();
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rollout_setting (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS feature_rollout (
      feature_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      shops_csv TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS shop_setting (
      shop TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop, key)
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_shop_setting_shop_updated ON shop_setting(shop, updated_at)",
  );
}

export async function getReleaseControlState() {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const settings = await prisma.$queryRawUnsafe(
    `SELECT key, value FROM rollout_setting`,
  );
  const features = await prisma.$queryRawUnsafe(
    `SELECT feature_key as featureKey, mode, shops_csv as shopsCsv FROM feature_rollout`,
  );
  return {
    settings: settings || [],
    features: features || [],
  };
}

function runtimeFromDbState(state) {
  const settingsMap = new Map((state.settings || []).map((row) => [String(row.key || ""), row.value]));
  const featureMap = {};
  for (const row of state.features || []) {
    const key = toFlagKey(row.featureKey);
    if (!key) continue;
    featureMap[key] = {
      mode: String(row.mode || "all").trim().toLowerCase(),
      shopsCsv: String(row.shopsCsv || ""),
    };
  }
  return {
    internalShopsCsv: String(settingsMap.get("internal_shops_csv") || ""),
    canaryShopsCsv: String(settingsMap.get("canary_shops_csv") || ""),
    blockedShopsCsv: String(settingsMap.get("blocked_shops_csv") || ""),
    canaryOnly: parseBool(settingsMap.get("canary_only"), undefined),
    freezeAll: parseBool(settingsMap.get("freeze_all"), undefined),
    featureMap,
  };
}

export async function getReleaseRuntime() {
  const base = runtimeFromEnv();
  try {
    const state = await getReleaseControlState();
    const dbRuntime = runtimeFromDbState(state);
    return mergeRuntime(base, dbRuntime);
  } catch {
    return base;
  }
}

export async function getReleaseContextAsync(shop) {
  const runtime = await getReleaseRuntime();
  return evaluateReleaseContext(shop, runtime);
}

export async function isFeatureEnabledForShopAsync(shop, featureKey, fallback = false) {
  const runtime = await getReleaseRuntime();
  return evaluateFeatureEnabledForShop(shop, featureKey, runtime, fallback);
}

export async function upsertRolloutSetting(key, value) {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const safeKey = String(key || "").trim().toLowerCase();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `DELETE FROM rollout_setting WHERE key = ${sqlQuote(safeKey)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO rollout_setting (key, value, updated_at)
     VALUES (${sqlQuote(safeKey)}, ${sqlQuote(String(value ?? ""))}, ${sqlQuote(now)})`,
  );
}

export async function upsertFeatureRollout(featureKey, mode, shopsCsv = "") {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const safeFeatureKey = toFlagKey(featureKey);
  const safeMode = String(mode || "all").trim().toLowerCase();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `DELETE FROM feature_rollout WHERE feature_key = ${sqlQuote(safeFeatureKey)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO feature_rollout (feature_key, mode, shops_csv, updated_at)
     VALUES (${sqlQuote(safeFeatureKey)}, ${sqlQuote(safeMode)}, ${sqlQuote(String(shopsCsv || ""))}, ${sqlQuote(now)})`,
  );
}

export async function listShopSettings(shop) {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT shop, key, value, updated_at as updatedAt
     FROM shop_setting
     WHERE shop = ${sqlQuote(safeShop)}
     ORDER BY key ASC`,
  );
  return rows || [];
}

export async function upsertShopSetting(shop, key, value) {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeKey = String(key || "").trim().toLowerCase();
  if (!safeShop || !safeKey) {
    throw new Error("shop and key are required");
  }
  if (!ALLOWED_SHOP_SETTING_KEYS.includes(safeKey)) {
    throw new Error(`Unsupported setting key: ${safeKey}`);
  }
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `DELETE FROM shop_setting
     WHERE shop = ${sqlQuote(safeShop)} AND key = ${sqlQuote(safeKey)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO shop_setting (shop, key, value, updated_at)
     VALUES (${sqlQuote(safeShop)}, ${sqlQuote(safeKey)}, ${sqlQuote(String(value ?? ""))}, ${sqlQuote(now)})`,
  );
}

export async function deleteShopSetting(shop, key) {
  await ensureReleaseControlTables();
  const prisma = await getPrisma();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeKey = String(key || "").trim().toLowerCase();
  if (!safeShop || !safeKey) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM shop_setting
     WHERE shop = ${sqlQuote(safeShop)} AND key = ${sqlQuote(safeKey)}`,
  );
}

export async function resolveShopConfig(shop, defaults = {}) {
  const settings = await listShopSettings(shop);
  const map = {};
  for (const row of settings) {
    map[String(row.key || "").toLowerCase()] = row.value;
  }
  return {
    ...defaults,
    ...map,
  };
}
