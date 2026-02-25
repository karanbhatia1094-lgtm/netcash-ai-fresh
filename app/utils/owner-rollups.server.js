import { prisma } from "../../prisma.client.js";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dayKey(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function ensureOwnerRollupTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS owner_daily_rollup (
      day_key TEXT NOT NULL,
      shop TEXT NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gross_value REAL NOT NULL DEFAULT 0,
      net_cash REAL NOT NULL DEFAULT 0,
      connector_count INTEGER NOT NULL DEFAULT 0,
      last_order_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (day_key, shop)
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_owner_rollup_day ON owner_daily_rollup(day_key)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_owner_rollup_shop ON owner_daily_rollup(shop)");
}

export async function refreshOwnerDailyRollup(day = new Date()) {
  await ensureOwnerRollupTables();
  const key = dayKey(day);
  if (!key) throw new Error("Invalid rollup day");
  const dayStart = `${key}T00:00:00.000Z`;
  const dayEndDate = new Date(dayStart);
  dayEndDate.setUTCDate(dayEndDate.getUTCDate() + 1);
  const dayEnd = dayEndDate.toISOString();

  const rows = await prisma.netCashOrder.groupBy({
    by: ["shop"],
    where: {
      createdAt: { gte: new Date(dayStart), lt: new Date(dayEnd) },
    },
    _count: { _all: true },
    _sum: { grossValue: true, netCash: true },
    _max: { createdAt: true },
  });
  const connectorCounts = await prisma.connectorCredential.groupBy({
    by: ["shop"],
    _count: { _all: true },
  });
  const connectorMap = new Map(connectorCounts.map((row) => [row.shop, Number(row._count._all || 0)]));
  const now = new Date().toISOString();
  const databaseUrl = String(process.env.DATABASE_URL || "").toLowerCase();
  const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");

  for (const row of rows || []) {
    const shop = String(row.shop || "").toLowerCase();
    if (isPostgres) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO owner_daily_rollup
          (day_key, shop, orders_count, gross_value, net_cash, connector_count, last_order_at, created_at, updated_at)
         VALUES
          (${sqlQuote(key)}, ${sqlQuote(shop)}, ${Number(row._count?._all || 0)}, ${Number(row._sum?.grossValue || 0)},
           ${Number(row._sum?.netCash || 0)}, ${Number(connectorMap.get(shop) || 0)},
           ${sqlQuote(row._max?.createdAt ? new Date(row._max.createdAt).toISOString() : null)},
           ${sqlQuote(now)}, ${sqlQuote(now)})
         ON CONFLICT(day_key, shop) DO UPDATE SET
           orders_count = EXCLUDED.orders_count,
           gross_value = EXCLUDED.gross_value,
           net_cash = EXCLUDED.net_cash,
           connector_count = EXCLUDED.connector_count,
           last_order_at = EXCLUDED.last_order_at,
           updated_at = EXCLUDED.updated_at`,
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT OR REPLACE INTO owner_daily_rollup
          (day_key, shop, orders_count, gross_value, net_cash, connector_count, last_order_at, created_at, updated_at)
         VALUES
          (${sqlQuote(key)}, ${sqlQuote(shop)}, ${Number(row._count?._all || 0)}, ${Number(row._sum?.grossValue || 0)},
           ${Number(row._sum?.netCash || 0)}, ${Number(connectorMap.get(shop) || 0)},
           ${sqlQuote(row._max?.createdAt ? new Date(row._max.createdAt).toISOString() : null)},
           ${sqlQuote(now)}, ${sqlQuote(now)})`,
      );
    }
  }

  return { dayKey: key, shops: rows.length };
}

export async function refreshOwnerDailyRollups(daysBack = 7) {
  const safe = Math.max(1, Math.min(60, Number(daysBack) || 7));
  const results = [];
  for (let i = 0; i < safe; i += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    // eslint-disable-next-line no-await-in-loop
    const result = await refreshOwnerDailyRollup(d);
    results.push(result);
  }
  return { refreshedDays: safe, results };
}

export async function getOwnerRollupOverview(days = 30) {
  await ensureOwnerRollupTables();
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - safeDays + 1);
  const sinceKey = since.toISOString().slice(0, 10);

  const totalsRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT shop) AS brands,
            COALESCE(SUM(orders_count), 0) AS orders,
            COALESCE(SUM(gross_value), 0) AS gross,
            COALESCE(SUM(net_cash), 0) AS net
     FROM owner_daily_rollup
     WHERE day_key >= ${sqlQuote(sinceKey)}`,
  );

  const storesRows = await prisma.$queryRawUnsafe(
    `SELECT shop,
            COALESCE(SUM(orders_count), 0) AS orderCount,
            COALESCE(SUM(gross_value), 0) AS grossValue,
            COALESCE(SUM(net_cash), 0) AS netCash,
            MAX(last_order_at) AS lastOrderAt,
            MAX(connector_count) AS connectorCount
     FROM owner_daily_rollup
     WHERE day_key >= ${sqlQuote(sinceKey)}
     GROUP BY shop
     ORDER BY netCash DESC`,
  );

  const totals = totalsRows?.[0] || { brands: 0, orders: 0, gross: 0, net: 0 };
  return {
    totals: {
      brands: Number(totals.brands || 0),
      orders: Number(totals.orders || 0),
      gross: Number(totals.gross || 0),
      net: Number(totals.net || 0),
    },
    stores: (storesRows || []).map((row) => ({
      shop: row.shop,
      orderCount: Number(row.orderCount || 0),
      grossValue: Number(row.grossValue || 0),
      netCash: Number(row.netCash || 0),
      lastOrderAt: row.lastOrderAt || null,
      connectorCount: Number(row.connectorCount || 0),
    })),
  };
}
