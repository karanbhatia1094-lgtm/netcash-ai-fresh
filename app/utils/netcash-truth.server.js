import { prisma } from "../../prisma.client.js";
import { getOrders } from "./db.server";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dayKey(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function campaignCustomerKey(order) {
  const email = String(order?.customerEmail || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(order?.customerPhone || "").replace(/\D/g, "");
  if (phone) return `phone:${phone}`;
  const name = String(order?.customerName || "").trim().toLowerCase();
  if (name) return `name:${name}`;
  return null;
}

function orderTouches(order) {
  const touches = [];
  if (order.marketingSource || order.campaignId || order.campaignName) {
    touches.push({
      source: String(order.marketingSource || "unknown").toLowerCase(),
      campaignId: order.campaignId || "",
      campaignName: order.campaignName || "",
    });
  }
  for (const touch of order.toolAttributions || []) {
    touches.push({
      source: String(touch.tool || "unknown").toLowerCase(),
      campaignId: touch.campaignId || "",
      campaignName: touch.campaignName || "",
    });
  }
  if (touches.length === 0) {
    touches.push({
      source: String(order.marketingSource || "unknown").toLowerCase(),
      campaignId: "",
      campaignName: "",
    });
  }
  const deduped = new Map();
  for (const t of touches) {
    const key = `${t.source}|${t.campaignId}|${t.campaignName}`;
    if (!deduped.has(key)) deduped.set(key, t);
  }
  return [...deduped.values()];
}

export async function ensureTruthRollupTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS campaign_daily_rollup (
      shop TEXT NOT NULL,
      day_key TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign_id TEXT,
      campaign_name TEXT,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gross_revenue REAL NOT NULL DEFAULT 0,
      net_cash REAL NOT NULL DEFAULT 0,
      rto_orders INTEGER NOT NULL DEFAULT 0,
      returned_orders INTEGER NOT NULL DEFAULT 0,
      exchange_orders INTEGER NOT NULL DEFAULT 0,
      exchange_higher_orders INTEGER NOT NULL DEFAULT 0,
      exchange_lower_orders INTEGER NOT NULL DEFAULT 0,
      exchange_refund_orders INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop, day_key, source, campaign_id, campaign_name)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS campaign_user_daily_rollup (
      shop TEXT NOT NULL,
      day_key TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign_id TEXT,
      campaign_name TEXT,
      customer_key TEXT NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gross_revenue REAL NOT NULL DEFAULT 0,
      net_cash REAL NOT NULL DEFAULT 0,
      rto_orders INTEGER NOT NULL DEFAULT 0,
      returned_orders INTEGER NOT NULL DEFAULT 0,
      exchange_orders INTEGER NOT NULL DEFAULT 0,
      exchange_higher_orders INTEGER NOT NULL DEFAULT 0,
      exchange_lower_orders INTEGER NOT NULL DEFAULT 0,
      exchange_refund_orders INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop, day_key, source, campaign_id, campaign_name, customer_key)
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_campaign_daily_rollup_shop_day ON campaign_daily_rollup(shop, day_key)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_campaign_user_daily_rollup_shop_day ON campaign_user_daily_rollup(shop, day_key)");
}

export async function refreshNetcashTruthRollups(shop, days = 90) {
  await ensureTruthRollupTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeDays = Math.max(1, Math.min(3650, Number(days) || 90));
  const orders = await getOrders(safeShop, safeDays);
  const campaignDaily = new Map();
  const campaignUserDaily = new Map();
  const now = new Date().toISOString();
  const since = new Date();
  since.setDate(since.getDate() - safeDays);
  const sinceKey = since.toISOString().slice(0, 10);

  for (const order of orders || []) {
    const day = dayKey(order.createdAt);
    if (!day) continue;
    const touches = orderTouches(order);
    const customerKey = campaignCustomerKey(order);
    const adjustment = Number(order.exchangeAdjustment || 0);
    const isExchange = adjustment !== 0;
    const facts = {
      ordersCount: 1,
      grossRevenue: Number(order.grossValue || 0),
      netCash: Number(order.netCash || 0),
      rtoOrders: order.isRTO ? 1 : 0,
      returnedOrders: order.isReturned ? 1 : 0,
      exchangeOrders: isExchange ? 1 : 0,
      exchangeHigherOrders: isExchange && adjustment > 0 ? 1 : 0,
      exchangeLowerOrders: isExchange && adjustment < 0 ? 1 : 0,
      exchangeRefundOrders: isExchange && Number(order.refundTotal || 0) > 0 ? 1 : 0,
    };

    for (const touch of touches) {
      const campaignKey = `${safeShop}|${day}|${touch.source}|${touch.campaignId || ""}|${touch.campaignName || ""}`;
      if (!campaignDaily.has(campaignKey)) {
        campaignDaily.set(campaignKey, {
          shop: safeShop,
          dayKey: day,
          source: touch.source,
          campaignId: touch.campaignId || "",
          campaignName: touch.campaignName || "",
          ...facts,
        });
      } else {
        const row = campaignDaily.get(campaignKey);
        row.ordersCount += facts.ordersCount;
        row.grossRevenue += facts.grossRevenue;
        row.netCash += facts.netCash;
        row.rtoOrders += facts.rtoOrders;
        row.returnedOrders += facts.returnedOrders;
        row.exchangeOrders += facts.exchangeOrders;
        row.exchangeHigherOrders += facts.exchangeHigherOrders;
        row.exchangeLowerOrders += facts.exchangeLowerOrders;
        row.exchangeRefundOrders += facts.exchangeRefundOrders;
      }

      if (!customerKey) continue;
      const userKey = `${campaignKey}|${customerKey}`;
      if (!campaignUserDaily.has(userKey)) {
        campaignUserDaily.set(userKey, {
          shop: safeShop,
          dayKey: day,
          source: touch.source,
          campaignId: touch.campaignId || "",
          campaignName: touch.campaignName || "",
          customerKey,
          ...facts,
        });
      } else {
        const row = campaignUserDaily.get(userKey);
        row.ordersCount += facts.ordersCount;
        row.grossRevenue += facts.grossRevenue;
        row.netCash += facts.netCash;
        row.rtoOrders += facts.rtoOrders;
        row.returnedOrders += facts.returnedOrders;
        row.exchangeOrders += facts.exchangeOrders;
        row.exchangeHigherOrders += facts.exchangeHigherOrders;
        row.exchangeLowerOrders += facts.exchangeLowerOrders;
        row.exchangeRefundOrders += facts.exchangeRefundOrders;
      }
    }
  }

  await prisma.$executeRawUnsafe(
    `DELETE FROM campaign_daily_rollup WHERE shop = ${sqlQuote(safeShop)} AND day_key >= ${sqlQuote(sinceKey)}`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM campaign_user_daily_rollup WHERE shop = ${sqlQuote(safeShop)} AND day_key >= ${sqlQuote(sinceKey)}`,
  );

  for (const row of campaignDaily.values()) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO campaign_daily_rollup (
        shop, day_key, source, campaign_id, campaign_name, orders_count, gross_revenue, net_cash,
        rto_orders, returned_orders, exchange_orders, exchange_higher_orders, exchange_lower_orders, exchange_refund_orders, updated_at
      ) VALUES (
        ${sqlQuote(row.shop)}, ${sqlQuote(row.dayKey)}, ${sqlQuote(row.source)}, ${sqlQuote(row.campaignId)},
        ${sqlQuote(row.campaignName)}, ${Number(row.ordersCount)}, ${Number(row.grossRevenue)}, ${Number(row.netCash)},
        ${Number(row.rtoOrders)}, ${Number(row.returnedOrders)}, ${Number(row.exchangeOrders)},
        ${Number(row.exchangeHigherOrders)}, ${Number(row.exchangeLowerOrders)}, ${Number(row.exchangeRefundOrders)},
        ${sqlQuote(now)}
      )`,
    );
  }
  for (const row of campaignUserDaily.values()) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO campaign_user_daily_rollup (
        shop, day_key, source, campaign_id, campaign_name, customer_key, orders_count, gross_revenue, net_cash,
        rto_orders, returned_orders, exchange_orders, exchange_higher_orders, exchange_lower_orders, exchange_refund_orders, updated_at
      ) VALUES (
        ${sqlQuote(row.shop)}, ${sqlQuote(row.dayKey)}, ${sqlQuote(row.source)}, ${sqlQuote(row.campaignId)},
        ${sqlQuote(row.campaignName)}, ${sqlQuote(row.customerKey)}, ${Number(row.ordersCount)}, ${Number(row.grossRevenue)}, ${Number(row.netCash)},
        ${Number(row.rtoOrders)}, ${Number(row.returnedOrders)}, ${Number(row.exchangeOrders)},
        ${Number(row.exchangeHigherOrders)}, ${Number(row.exchangeLowerOrders)}, ${Number(row.exchangeRefundOrders)},
        ${sqlQuote(now)}
      )`,
    );
  }

  return {
    shop: safeShop,
    days: safeDays,
    campaignRows: campaignDaily.size,
    campaignUserRows: campaignUserDaily.size,
  };
}
