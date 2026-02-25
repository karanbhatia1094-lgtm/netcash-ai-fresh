import { getQueueBacklogSummary } from "./job-queue.server";

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function buildOwnerInsights({
  stores = [],
  pilotReadiness = {},
  featureUsage = {},
  rolloutSummary = {},
  billingSummary = { byShop: [], totals: {} },
} = {}) {
  const byShopUsage = new Map((featureUsage?.byShop || []).map((row) => [String(row.shop || "").toLowerCase(), row]));
  const byShopQuality = new Map((pilotReadiness?.rows || []).map((row) => [String(row.shop || "").toLowerCase(), row]));
  const billingByShop = new Map((billingSummary?.byShop || []).map((row) => [String(row.shop || "").toLowerCase(), row]));

  const healthRows = (stores || []).map((store) => {
    const shop = String(store.shop || "").toLowerCase();
    const usage = byShopUsage.get(shop) || {};
    const quality = byShopQuality.get(shop) || { metrics: {} };
    const usageScore = Math.min(30, Math.round(Math.log10(toNum(usage.events, 0) + 1) * 12));
    const qualityScore = Math.max(0, Math.min(35, Math.round((toNum(quality.metrics?.mappedOrdersPct, 0) / 100) * 35)));
    const freshnessScore = Math.max(0, 20 - Math.round(Math.min(20, toNum(quality.metrics?.syncLagMinutes, 0) / 30)));
    const queueScore = Math.max(0, 10 - Math.round(Math.min(10, toNum(quality.metrics?.queuePending, 0) / 20)));
    const billingRow = billingByShop.get(shop);
    const billingScore = billingRow?.status === "active" || billingRow?.status === "new_paid" ? 5 : 0;
    const score = Math.max(0, Math.min(100, usageScore + qualityScore + freshnessScore + queueScore + billingScore));

    let risk = "low";
    if (score < 45 || toNum(usage.events, 0) < 5 || toNum(quality.metrics?.syncLagMinutes, 0) > 720) risk = "high";
    else if (score < 65 || toNum(quality.metrics?.queuePending, 0) > 120) risk = "medium";

    return {
      shop,
      score,
      risk,
      events: toNum(usage.events, 0),
      mappedOrdersPct: toNum(quality.metrics?.mappedOrdersPct, 0),
      syncLagMinutes: toNum(quality.metrics?.syncLagMinutes, 0),
      queuePending: toNum(quality.metrics?.queuePending, 0),
      netCash: toNum(store.netCash, 0),
      orderCount: toNum(store.orderCount, 0),
      releaseChannel: store.releaseChannel || "stable",
    };
  });

  const funnel = {
    installs: (stores || []).length,
    onboardingComplete: healthRows.filter((row) => row.mappedOrdersPct >= 70 && row.syncLagMinutes <= 360).length,
    firstValue: healthRows.filter((row) => row.events >= 20 && row.orderCount > 0 && row.mappedOrdersPct >= 75).length,
    paid: healthRows.filter((row) => {
      const status = billingByShop.get(row.shop)?.status;
      return status === "active" || status === "new_paid";
    }).length,
  };

  const mrrRows = healthRows.map((row) => ({
    shop: row.shop,
    amountMrr: toNum(billingByShop.get(row.shop)?.currentMrr, 0),
    previousMrr: toNum(billingByShop.get(row.shop)?.previousMrr, 0),
    status: billingByShop.get(row.shop)?.status || "unknown",
  }));
  const activePaid = mrrRows.filter((row) => row.status === "active" || row.status === "new_paid");
  const mrr = activePaid.reduce((sum, row) => sum + row.amountMrr, 0);
  const churned = mrrRows.filter((row) => row.status === "churned").length;
  const expansion = mrrRows.filter((row) => row.amountMrr > row.previousMrr).length;
  const contraction = mrrRows.filter((row) => row.amountMrr < row.previousMrr).length;

  const byChannel = ["stable", "canary", "internal"].map((channel) => {
    const rows = healthRows.filter((r) => r.releaseChannel === channel);
    const events = rows.reduce((sum, row) => sum + row.events, 0);
    const netCash = rows.reduce((sum, row) => sum + row.netCash, 0);
    return { channel, shops: rows.length, events, netCash };
  });

  const featureRevenue = [];
  const byFeature = featureUsage?.byFeature || [];
  const byShopFeature = featureUsage?.byShopFeature || [];
  for (const feature of byFeature.slice(0, 40)) {
    const linked = byShopFeature.filter((row) => row.featureKey === feature.featureKey);
    const shops = [...new Set(linked.map((row) => String(row.shop || "").toLowerCase()))];
    const rows = shops.map((shop) => healthRows.find((h) => h.shop === shop)).filter(Boolean);
    const avgNetCash = rows.length ? rows.reduce((sum, row) => sum + row.netCash, 0) / rows.length : 0;
    const avgOrders = rows.length ? rows.reduce((sum, row) => sum + row.orderCount, 0) / rows.length : 0;
    featureRevenue.push({
      featureKey: feature.featureKey,
      shopsUsing: feature.shops,
      events: feature.events,
      avgNetCashPerShop: avgNetCash,
      avgOrdersPerShop: avgOrders,
    });
  }

  const playbooks = healthRows
    .map((row) => {
      let action = "Maintain current setup and continue weekly optimization.";
      if (row.mappedOrdersPct < 70) action = "Fix UTM/campaign mapping and connector payload quality.";
      else if (row.syncLagMinutes > 360) action = "Stabilize connector sync freshness and worker cadence.";
      else if (row.events < 15) action = "Drive product adoption with guided playbook and owner review.";
      else if (row.queuePending > 100) action = "Increase worker throughput and clear queue backlog.";
      return {
        shop: row.shop,
        risk: row.risk,
        healthScore: row.score,
        action,
      };
    })
    .sort((a, b) => a.healthScore - b.healthScore);

  return {
    mrr: {
      activePaidShops: activePaid.length,
      mrr,
      churnedShops: churned,
      expansionShops: expansion,
      contractionShops: contraction,
    },
    trialFunnel: funnel,
    healthRows: healthRows.sort((a, b) => b.score - a.score),
    riskRows: healthRows.filter((row) => row.risk !== "low").sort((a, b) => a.score - b.score),
    releaseImpact: { byChannel, rolloutSummary },
    featureRevenue,
    playbooks,
  };
}

export async function buildSupportOpsSnapshot(prisma) {
  const unreadRaw = await prisma.alertEvent.findMany({
    where: { isRead: false },
    orderBy: { lastSeenAt: "desc" },
    take: 300,
    select: { shop: true, severity: true, lastSeenAt: true },
  }).catch(() => []);
  const unreadMap = new Map();
  for (const row of unreadRaw) {
    const key = `${String(row.shop || "").toLowerCase()}|${String(row.severity || "info").toLowerCase()}`;
    const prev = unreadMap.get(key) || { shop: row.shop, severity: row.severity, count: 0, lastSeenAt: row.lastSeenAt };
    prev.count += 1;
    if (!prev.lastSeenAt || (row.lastSeenAt && new Date(row.lastSeenAt).getTime() > new Date(prev.lastSeenAt).getTime())) {
      prev.lastSeenAt = row.lastSeenAt;
    }
    unreadMap.set(key, prev);
  }
  const unread = [...unreadMap.values()].sort((a, b) => b.count - a.count).slice(0, 120);

  const failedSync = await prisma.connectorSyncRun.findMany({
    where: { status: { not: "success" } },
    orderBy: { createdAt: "desc" },
    take: 120,
  }).catch(() => []);

  const queue = await getQueueBacklogSummary({ recentWindowMinutes: 60 }).catch(() => ({
    pending: { total: 0 },
    failedRecent: { total: 0 },
  }));

  return {
    unreadAlerts: unread.map((row) => ({
      shop: row.shop,
      severity: row.severity,
      count: Number(row.count || 0),
      lastSeenAt: row.lastSeenAt || null,
    })),
    failedSync: failedSync.map((row) => ({
      shop: row.shop,
      provider: row.provider,
      status: row.status,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
    })),
    queue,
  };
}
