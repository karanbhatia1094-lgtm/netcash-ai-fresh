import { getSyncFreshnessByShop, listAllConnectorCredentials } from "./db.server";
import { enqueueJob, getQueueBacklogSummary } from "./job-queue.server";
import { logError, logInfo } from "./logger.server";

function parseBool(value, fallback = false) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function nowHourBucket() {
  const iso = new Date().toISOString();
  return iso.slice(0, 13); // YYYY-MM-DDTHH
}

function toShop(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueForHour(type, shop, suffix = "") {
  const safeType = String(type || "").trim().toLowerCase();
  const safeShop = toShop(shop);
  const hour = nowHourBucket();
  const tail = suffix ? `:${String(suffix).trim().toLowerCase()}` : "";
  return `${safeType}:${safeShop}:${hour}${tail}`;
}

function autonomousOpsConfig() {
  return {
    enabled: parseBool(process.env.AUTO_REPAIR_ENABLED, true),
    staleSyncMinutes: Math.max(60, Number(process.env.AUTO_REPAIR_STALE_SYNC_MINUTES || 240)),
    backlogPerShopThreshold: Math.max(25, Number(process.env.AUTO_REPAIR_PENDING_PER_SHOP || 120)),
    maxShopsPerRun: Math.max(1, Math.min(500, Number(process.env.AUTO_REPAIR_MAX_SHOPS_PER_RUN || 50))),
    connectorLookbackDays: Math.max(1, Math.min(90, Number(process.env.AUTO_REPAIR_CONNECTOR_DAYS || 7))),
    truthLookbackDays: Math.max(7, Math.min(365, Number(process.env.AUTO_REPAIR_TRUTH_DAYS || 90))),
    maxConnectorRepairsPerShop: Math.max(1, Math.min(5, Number(process.env.AUTO_REPAIR_MAX_CONNECTOR_PER_SHOP || 2))),
  };
}

async function selectCandidateShops(config) {
  const [syncFreshness, queueSummary] = await Promise.all([
    getSyncFreshnessByShop(7),
    getQueueBacklogSummary(),
  ]);

  const candidates = new Map();
  for (const row of syncFreshness || []) {
    const shop = toShop(row.shop);
    if (!shop) continue;
    const lag = Number(row.connectorLagMinutes ?? row.orderLagMinutes ?? 0);
    if (lag >= config.staleSyncMinutes) {
      candidates.set(shop, {
        shop,
        reasons: [`sync_lag_${lag}m`],
      });
    }
  }

  for (const row of queueSummary?.topShopsByPending || []) {
    const shop = toShop(row.shop);
    if (!shop) continue;
    const pending = Number(row.pending || 0);
    if (pending < config.backlogPerShopThreshold) continue;
    const existing = candidates.get(shop) || { shop, reasons: [] };
    existing.reasons.push(`queue_backlog_${pending}`);
    candidates.set(shop, existing);
  }

  return [...candidates.values()]
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, config.maxShopsPerRun);
}

export async function scheduleAutonomousRepairs({ source = "monitoring_daemon", forceShops = [] } = {}) {
  const config = autonomousOpsConfig();
  if (!config.enabled) {
    return {
      ok: true,
      enabled: false,
      reason: "AUTO_REPAIR_ENABLED=false",
      queued: 0,
      shops: [],
    };
  }

  const forced = (forceShops || []).map((row) => toShop(row)).filter(Boolean);
  const candidates = forced.length > 0
    ? forced.map((shop) => ({ shop, reasons: ["forced"] }))
    : await selectCandidateShops(config);

  if (candidates.length === 0) {
    return { ok: true, enabled: true, queued: 0, shops: [], reason: "no_candidates" };
  }

  const creds = await listAllConnectorCredentials();
  const credsByShop = new Map();
  for (const row of creds || []) {
    const shop = toShop(row.shop);
    if (!shop || !row.accessToken) continue;
    if (!credsByShop.has(shop)) credsByShop.set(shop, []);
    credsByShop.get(shop).push(String(row.provider || "").trim().toLowerCase());
  }

  const queued = [];
  const errors = [];

  for (const candidate of candidates) {
    const shop = toShop(candidate.shop);
    const reasons = candidate.reasons || [];
    try {
      // eslint-disable-next-line no-await-in-loop
      const orderJob = await enqueueJob({
        type: "shopify_order_sync",
        shop,
        payload: { shop, source, reasons, autonomousRepair: true },
        uniqueKey: uniqueForHour("shopify_order_sync", shop, "autofix"),
        maxAttempts: 5,
      });
      queued.push({ shop, type: orderJob.type, id: orderJob.id, uniqueKey: orderJob.uniqueKey || null });

      // eslint-disable-next-line no-await-in-loop
      const truthJob = await enqueueJob({
        type: "truth_rollup_refresh",
        shop,
        payload: { shop, days: config.truthLookbackDays, source, reasons, autonomousRepair: true },
        uniqueKey: uniqueForHour("truth_rollup_refresh", shop, "autofix"),
        maxAttempts: 4,
      });
      queued.push({ shop, type: truthJob.type, id: truthJob.id, uniqueKey: truthJob.uniqueKey || null });

      const providers = [...new Set(credsByShop.get(shop) || [])].slice(0, config.maxConnectorRepairsPerShop);
      for (const provider of providers) {
        // eslint-disable-next-line no-await-in-loop
        const connectorJob = await enqueueJob({
          type: "connector_sync",
          shop,
          payload: {
            shop,
            provider,
            days: config.connectorLookbackDays,
            force: true,
            source,
            reasons,
            autonomousRepair: true,
          },
          uniqueKey: uniqueForHour("connector_sync", shop, provider),
          maxAttempts: 5,
        });
        queued.push({ shop, type: connectorJob.type, id: connectorJob.id, provider, uniqueKey: connectorJob.uniqueKey || null });
      }
    } catch (error) {
      const message = String(error?.message || error);
      errors.push({ shop, error: message, reasons });
      logError("autonomous.repair.enqueue.failed", { shop, reasons, error: message });
    }
  }

  const result = {
    ok: errors.length === 0,
    enabled: true,
    source,
    attemptedShops: candidates.length,
    queued: queued.length,
    failed: errors.length,
    queuedJobs: queued,
    errors,
  };
  logInfo("autonomous.repair.scheduled", {
    source,
    attemptedShops: result.attemptedShops,
    queued: result.queued,
    failed: result.failed,
  });
  return result;
}
