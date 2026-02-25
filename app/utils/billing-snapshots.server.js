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

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function ensureBillingSnapshotTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS billing_snapshot (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      day_key TEXT NOT NULL,
      has_active_subscription INTEGER NOT NULL DEFAULT 0,
      has_live_subscription INTEGER NOT NULL DEFAULT 0,
      mrr_amount REAL NOT NULL DEFAULT 0,
      currency_code TEXT,
      subscription_count INTEGER NOT NULL DEFAULT 0,
      subscriptions_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_snapshot_shop_day ON billing_snapshot(shop, day_key)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_billing_snapshot_shop_created ON billing_snapshot(shop, created_at)",
  );
}

function extractMrr(subscriptions = []) {
  let mrr = 0;
  let currencyCode = null;
  for (const sub of subscriptions || []) {
    for (const line of sub?.lineItems || []) {
      const pricing = line?.plan?.pricingDetails || {};
      if (pricing.__typename === "AppRecurringPricing") {
        mrr += toNum(pricing?.price?.amount, 0);
        currencyCode = currencyCode || pricing?.price?.currencyCode || null;
      }
    }
  }
  return { mrr, currencyCode: currencyCode || "INR" };
}

export async function recordBillingSnapshot(shop, subscriptions = []) {
  await ensureBillingSnapshotTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return { ok: false, reason: "shop_required" };
  const all = Array.isArray(subscriptions) ? subscriptions : [];
  const live = all.filter((row) => row?.test !== true);
  const hasActive = all.length > 0;
  const hasLive = live.length > 0;
  const { mrr, currencyCode } = extractMrr(live);
  const dayKey = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_snapshot WHERE shop = ${sqlQuote(safeShop)} AND day_key = ${sqlQuote(dayKey)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO billing_snapshot
      (id, shop, day_key, has_active_subscription, has_live_subscription, mrr_amount, currency_code, subscription_count, subscriptions_json, created_at)
     VALUES
      (${sqlQuote(id)}, ${sqlQuote(safeShop)}, ${sqlQuote(dayKey)}, ${hasActive ? 1 : 0}, ${hasLive ? 1 : 0},
       ${toNum(mrr, 0)}, ${sqlQuote(currencyCode)}, ${all.length}, ${sqlQuote(safeJsonStringify(all))}, ${sqlQuote(now)})`,
  );

  return {
    ok: true,
    shop: safeShop,
    dayKey,
    hasActiveSubscription: hasActive,
    hasLiveSubscription: hasLive,
    mrrAmount: toNum(mrr, 0),
    currencyCode,
    subscriptionCount: all.length,
  };
}

export async function getBillingSnapshotSummary(days = 30) {
  await ensureBillingSnapshotTables();
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT shop, day_key as dayKey, has_live_subscription as hasLiveSubscription, mrr_amount as mrrAmount, currency_code as currencyCode, created_at as createdAt
     FROM billing_snapshot
     WHERE created_at >= ${sqlQuote(since)}
     ORDER BY shop ASC, created_at DESC`,
  );

  const byShop = new Map();
  for (const row of rows || []) {
    const shop = String(row.shop || "").toLowerCase();
    const current = byShop.get(shop);
    if (!current) {
      byShop.set(shop, { shop, latest: row, previous: null });
      continue;
    }
    if (!current.previous) current.previous = row;
  }

  const shopRows = [...byShop.values()].map((row) => {
    const latestLive = toNum(row.latest?.hasLiveSubscription, 0) === 1;
    const prevLive = toNum(row.previous?.hasLiveSubscription, 0) === 1;
    const latestMrr = toNum(row.latest?.mrrAmount, 0);
    const prevMrr = toNum(row.previous?.mrrAmount, 0);
    let status = latestLive ? "active" : "inactive";
    if (prevLive && !latestLive) status = "churned";
    if (!prevLive && latestLive) status = "new_paid";
    const deltaMrr = latestMrr - prevMrr;
    return {
      shop: row.shop,
      status,
      currentMrr: latestMrr,
      previousMrr: prevMrr,
      deltaMrr,
      currencyCode: row.latest?.currencyCode || "INR",
      latestAt: row.latest?.createdAt || null,
    };
  });

  return {
    days: safeDays,
    since,
    byShop: shopRows,
    totals: {
      activePaidShops: shopRows.filter((row) => row.status === "active" || row.status === "new_paid").length,
      churnedShops: shopRows.filter((row) => row.status === "churned").length,
      mrr: shopRows.reduce((sum, row) => sum + toNum(row.currentMrr, 0), 0),
      expansionShops: shopRows.filter((row) => row.deltaMrr > 0).length,
      contractionShops: shopRows.filter((row) => row.deltaMrr < 0).length,
    },
  };
}

async function fetchShopSubscriptions(shop, accessToken) {
  const apiVersion = process.env.SHOPIFY_ADMIN_API_VERSION || "2025-10";
  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const query = `
    query BillingStatus {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          test
          lineItems {
            plan {
              pricingDetails {
                __typename
                ... on AppRecurringPricing {
                  interval
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": String(accessToken || ""),
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Billing GraphQL failed (${res.status})`);
  }
  const subscriptions = body?.data?.currentAppInstallation?.activeSubscriptions || [];
  return subscriptions;
}

export async function refreshBillingSnapshotsForShops({ shop = "", maxShops = 100 } = {}) {
  await ensureBillingSnapshotTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeMaxShops = Math.max(1, Math.min(500, Number(maxShops) || 100));
  const sessions = await prisma.session.findMany({
    where: {
      ...(safeShop ? { shop: safeShop } : {}),
      isOnline: false,
      accessToken: { not: null },
    },
    orderBy: { id: "desc" },
    take: safeMaxShops * 5,
  });

  const tokenByShop = new Map();
  for (const row of sessions || []) {
    const s = String(row.shop || "").toLowerCase();
    if (!s || tokenByShop.has(s)) continue;
    tokenByShop.set(s, row.accessToken);
    if (tokenByShop.size >= safeMaxShops) break;
  }

  const results = [];
  for (const [targetShop, token] of tokenByShop.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const subscriptions = await fetchShopSubscriptions(targetShop, token);
      // eslint-disable-next-line no-await-in-loop
      const snapshot = await recordBillingSnapshot(targetShop, subscriptions);
      results.push({ shop: targetShop, ok: true, snapshot });
    } catch (error) {
      results.push({ shop: targetShop, ok: false, error: String(error?.message || "unknown") });
    }
  }

  return {
    attempted: tokenByShop.size,
    succeeded: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    results,
  };
}
