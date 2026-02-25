import { prisma } from "../utils/db.server";
import { logError, logInfo, logWarn } from "../utils/logger.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function daysAgoStart(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function buildDigest(shop) {
  const since = daysAgoStart(1);
  const orders = await prisma.netCashOrder.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });

  const grossRevenue = orders.reduce((sum, o) => sum + (o.grossValue || 0), 0);
  const netCash = orders.reduce((sum, o) => sum + (o.netCash || 0), 0);
  const orderCount = orders.length;
  const topSources = new Map();
  for (const order of orders) {
    const key = String(order.marketingSource || "unknown").toLowerCase();
    if (!topSources.has(key)) {
      topSources.set(key, { source: key, orders: 0, netCash: 0, grossRevenue: 0 });
    }
    const row = topSources.get(key);
    row.orders += 1;
    row.netCash += order.netCash || 0;
    row.grossRevenue += order.grossValue || 0;
  }

  return {
    shop,
    window: "last_24h",
    orderCount,
    grossRevenue,
    netCash,
    avgOrderValue: orderCount > 0 ? grossRevenue / orderCount : 0,
    topSources: [...topSources.values()].sort((a, b) => b.netCash - a.netCash).slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

async function handleDigest(request) {
  const key = process.env.DIGEST_CRON_KEY || process.env.CONNECTOR_CRON_KEY;
  if (!key) return json({ error: "DIGEST_CRON_KEY or CONNECTOR_CRON_KEY required" }, { status: 500 });

  const header = request.headers.get("x-netcash-cron-key") || "";
  if (header !== key) return json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop) return json({ error: "shop query param required" }, { status: 400 });

  try {
    const digest = await buildDigest(shop);
    const webhook = process.env.DIGEST_WEBHOOK_URL;
    let delivered = false;

    if (webhook) {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(digest),
      });
      delivered = response.ok;
      if (!response.ok) {
        logWarn("api.digest.webhook.failed", { shop, status: response.status });
      }
    }

    logInfo("api.digest.daily.success", { shop, delivered });
    return json({ success: true, delivered, digest });
  } catch (error) {
    logError("api.digest.daily.error", { shop, error: error?.message || "Unknown error" });
    return json({ success: false, error: error?.message || "Unknown error" }, { status: 500 });
  }
}

export async function loader({ request }) {
  return handleDigest(request);
}

export async function action({ request }) {
  return handleDigest(request);
}
