import { prisma } from "./db.server";

const DELIVERY_TABLES_SQLITE = [
  `CREATE TABLE IF NOT EXISTS delivery_shipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    awb TEXT,
    provider TEXT,
    status TEXT,
    status_detail TEXT,
    rto_status TEXT,
    attempt_count INTEGER DEFAULT 0,
    delivered_at TEXT,
    rto_initiated_at TEXT,
    last_event_at TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_shipment_shop_awb ON delivery_shipment(shop, awb);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_shipment_shop_order ON delivery_shipment(shop, order_id);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_shipment_shop_status ON delivery_shipment(shop, status);`,
  `CREATE TABLE IF NOT EXISTS delivery_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    awb TEXT,
    provider TEXT,
    event TEXT,
    status_code TEXT,
    location TEXT,
    event_at TEXT,
    raw TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_event_shop_awb ON delivery_event(shop, awb);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_event_shop_order ON delivery_event(shop, order_id);`,
  `CREATE TABLE IF NOT EXISTS oms_order_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    provider TEXT,
    status TEXT,
    sub_status TEXT,
    fulfillment_status TEXT,
    last_event_at TEXT,
    raw TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_order_shop_order_provider ON oms_order_status(shop, order_id, provider);`,
  `CREATE INDEX IF NOT EXISTS idx_oms_order_shop_status ON oms_order_status(shop, status);`,
];

const DELIVERY_TABLES_POSTGRES = [
  `CREATE TABLE IF NOT EXISTS delivery_shipment (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    awb TEXT,
    provider TEXT,
    status TEXT,
    status_detail TEXT,
    rto_status TEXT,
    attempt_count INTEGER DEFAULT 0,
    delivered_at TIMESTAMP NULL,
    rto_initiated_at TIMESTAMP NULL,
    last_event_at TIMESTAMP NULL,
    metadata JSONB,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_shipment_shop_awb ON delivery_shipment(shop, awb);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_shipment_shop_order ON delivery_shipment(shop, order_id);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_shipment_shop_status ON delivery_shipment(shop, status);`,
  `CREATE TABLE IF NOT EXISTS delivery_event (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    awb TEXT,
    provider TEXT,
    event TEXT,
    status_code TEXT,
    location TEXT,
    event_at TIMESTAMP NULL,
    raw JSONB,
    created_at TIMESTAMP NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_event_shop_awb ON delivery_event(shop, awb);`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_event_shop_order ON delivery_event(shop, order_id);`,
  `CREATE TABLE IF NOT EXISTS oms_order_status (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    order_id TEXT,
    order_number TEXT,
    provider TEXT,
    status TEXT,
    sub_status TEXT,
    fulfillment_status TEXT,
    last_event_at TIMESTAMP NULL,
    raw JSONB,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_order_shop_order_provider ON oms_order_status(shop, order_id, provider);`,
  `CREATE INDEX IF NOT EXISTS idx_oms_order_shop_status ON oms_order_status(shop, status);`,
];

function isPostgres() {
  return String(process.env.DATABASE_URL || "").startsWith("postgres");
}

export async function ensureDeliveryOmsTables() {
  const statements = isPostgres() ? DELIVERY_TABLES_POSTGRES : DELIVERY_TABLES_SQLITE;
  for (const stmt of statements) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(stmt);
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeProvider(value) {
  return String(value || "unknown").trim().toLowerCase();
}

function safeString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeAttemptCount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

export function normalizeDeliveryPayload(payload = {}) {
  const record = payload?.shipment || payload;
  const events = Array.isArray(payload?.events) ? payload.events : Array.isArray(record?.events) ? record.events : [];
  return {
    shop: safeString(record?.shop || payload?.shop),
    orderId: safeString(record?.orderId || record?.order_id || record?.shopifyOrderId),
    orderNumber: safeString(record?.orderNumber || record?.order_number || record?.name),
    awb: safeString(record?.awb || record?.trackingNumber || record?.tracking_number),
    provider: normalizeProvider(record?.provider || record?.carrier || record?.courier),
    status: safeString(record?.status || record?.currentStatus || record?.deliveryStatus),
    statusDetail: safeString(record?.statusDetail || record?.status_detail || record?.statusReason),
    rtoStatus: safeString(record?.rtoStatus || record?.rto_status),
    attemptCount: normalizeAttemptCount(record?.attemptCount || record?.attempts || record?.deliveryAttempts),
    deliveredAt: toIso(record?.deliveredAt || record?.delivered_at),
    rtoInitiatedAt: toIso(record?.rtoInitiatedAt || record?.rto_initiated_at),
    lastEventAt: toIso(record?.lastEventAt || record?.last_event_at || (events[0] ? events[0].eventAt : null)),
    metadata: record?.metadata || record?.raw || null,
    events: events.map((event) => ({
      event: safeString(event?.event || event?.status || event?.label),
      statusCode: safeString(event?.statusCode || event?.code),
      location: safeString(event?.location || event?.city),
      eventAt: toIso(event?.eventAt || event?.timestamp || event?.event_at),
      raw: event,
    })),
  };
}

export async function upsertDeliveryShipment(payload) {
  const nowIso = new Date().toISOString();
  const record = normalizeDeliveryPayload(payload);
  if (!record.shop || (!record.orderId && !record.orderNumber && !record.awb)) {
    throw new Error("Missing shop + orderId/orderNumber/awb.");
  }

  const metaValue = record.metadata ? JSON.stringify(record.metadata) : null;
  if (isPostgres()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO delivery_shipment
        (shop, order_id, order_number, awb, provider, status, status_detail, rto_status, attempt_count, delivered_at, rto_initiated_at, last_event_at, metadata, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
       ON CONFLICT (shop, awb)
       DO UPDATE SET
        order_id = COALESCE(EXCLUDED.order_id, delivery_shipment.order_id),
        order_number = COALESCE(EXCLUDED.order_number, delivery_shipment.order_number),
        provider = COALESCE(EXCLUDED.provider, delivery_shipment.provider),
        status = COALESCE(EXCLUDED.status, delivery_shipment.status),
        status_detail = COALESCE(EXCLUDED.status_detail, delivery_shipment.status_detail),
        rto_status = COALESCE(EXCLUDED.rto_status, delivery_shipment.rto_status),
        attempt_count = GREATEST(EXCLUDED.attempt_count, delivery_shipment.attempt_count),
        delivered_at = COALESCE(EXCLUDED.delivered_at, delivery_shipment.delivered_at),
        rto_initiated_at = COALESCE(EXCLUDED.rto_initiated_at, delivery_shipment.rto_initiated_at),
        last_event_at = COALESCE(EXCLUDED.last_event_at, delivery_shipment.last_event_at),
        metadata = COALESCE(EXCLUDED.metadata, delivery_shipment.metadata),
        updated_at = EXCLUDED.updated_at`,
      record.shop,
      record.orderId,
      record.orderNumber,
      record.awb,
      record.provider,
      record.status,
      record.statusDetail,
      record.rtoStatus,
      record.attemptCount,
      record.deliveredAt,
      record.rtoInitiatedAt,
      record.lastEventAt,
      metaValue,
      nowIso,
      nowIso,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO delivery_shipment
        (shop, order_id, order_number, awb, provider, status, status_detail, rto_status, attempt_count, delivered_at, rto_initiated_at, last_event_at, metadata, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shop, awb)
       DO UPDATE SET
        order_id = COALESCE(excluded.order_id, delivery_shipment.order_id),
        order_number = COALESCE(excluded.order_number, delivery_shipment.order_number),
        provider = COALESCE(excluded.provider, delivery_shipment.provider),
        status = COALESCE(excluded.status, delivery_shipment.status),
        status_detail = COALESCE(excluded.status_detail, delivery_shipment.status_detail),
        rto_status = COALESCE(excluded.rto_status, delivery_shipment.rto_status),
        attempt_count = MAX(excluded.attempt_count, delivery_shipment.attempt_count),
        delivered_at = COALESCE(excluded.delivered_at, delivery_shipment.delivered_at),
        rto_initiated_at = COALESCE(excluded.rto_initiated_at, delivery_shipment.rto_initiated_at),
        last_event_at = COALESCE(excluded.last_event_at, delivery_shipment.last_event_at),
        metadata = COALESCE(excluded.metadata, delivery_shipment.metadata),
        updated_at = excluded.updated_at`,
      record.shop,
      record.orderId,
      record.orderNumber,
      record.awb,
      record.provider,
      record.status,
      record.statusDetail,
      record.rtoStatus,
      record.attemptCount,
      record.deliveredAt,
      record.rtoInitiatedAt,
      record.lastEventAt,
      metaValue,
      nowIso,
      nowIso,
    );
  }

  for (const event of record.events || []) {
    if (isPostgres()) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(
        `INSERT INTO delivery_event
          (shop, order_id, order_number, awb, provider, event, status_code, location, event_at, raw, created_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        record.shop,
        record.orderId,
        record.orderNumber,
        record.awb,
        record.provider,
        event.event,
        event.statusCode,
        event.location,
        event.eventAt,
        event.raw ? JSON.stringify(event.raw) : null,
        nowIso,
      );
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(
        `INSERT INTO delivery_event
          (shop, order_id, order_number, awb, provider, event, status_code, location, event_at, raw, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.shop,
        record.orderId,
        record.orderNumber,
        record.awb,
        record.provider,
        event.event,
        event.statusCode,
        event.location,
        event.eventAt,
        event.raw ? JSON.stringify(event.raw) : null,
        nowIso,
      );
    }
  }

  return record;
}

export async function upsertOmsStatus(payload) {
  const nowIso = new Date().toISOString();
  const record = payload?.oms || payload || {};
  const shop = safeString(record?.shop || payload?.shop);
  const orderId = safeString(record?.orderId || record?.order_id || record?.shopifyOrderId);
  const orderNumber = safeString(record?.orderNumber || record?.order_number || record?.name);
  const provider = normalizeProvider(record?.provider || record?.oms || record?.system);
  const status = safeString(record?.status || record?.orderStatus);
  const subStatus = safeString(record?.subStatus || record?.sub_status);
  const fulfillmentStatus = safeString(record?.fulfillmentStatus || record?.fulfillment_status);
  const lastEventAt = toIso(record?.lastEventAt || record?.updatedAt || record?.updated_at);
  const raw = record?.raw || record;

  if (!shop || (!orderId && !orderNumber)) {
    throw new Error("Missing shop + orderId/orderNumber.");
  }

  if (isPostgres()) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO oms_order_status
        (shop, order_id, order_number, provider, status, sub_status, fulfillment_status, last_event_at, raw, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (shop, order_id, provider)
       DO UPDATE SET
        order_number = COALESCE(EXCLUDED.order_number, oms_order_status.order_number),
        status = COALESCE(EXCLUDED.status, oms_order_status.status),
        sub_status = COALESCE(EXCLUDED.sub_status, oms_order_status.sub_status),
        fulfillment_status = COALESCE(EXCLUDED.fulfillment_status, oms_order_status.fulfillment_status),
        last_event_at = COALESCE(EXCLUDED.last_event_at, oms_order_status.last_event_at),
        raw = COALESCE(EXCLUDED.raw, oms_order_status.raw),
        updated_at = EXCLUDED.updated_at`,
      shop,
      orderId,
      orderNumber,
      provider,
      status,
      subStatus,
      fulfillmentStatus,
      lastEventAt,
      JSON.stringify(raw),
      nowIso,
      nowIso,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO oms_order_status
        (shop, order_id, order_number, provider, status, sub_status, fulfillment_status, last_event_at, raw, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shop, order_id, provider)
       DO UPDATE SET
        order_number = COALESCE(excluded.order_number, oms_order_status.order_number),
        status = COALESCE(excluded.status, oms_order_status.status),
        sub_status = COALESCE(excluded.sub_status, oms_order_status.sub_status),
        fulfillment_status = COALESCE(excluded.fulfillment_status, oms_order_status.fulfillment_status),
        last_event_at = COALESCE(excluded.last_event_at, oms_order_status.last_event_at),
        raw = COALESCE(excluded.raw, oms_order_status.raw),
        updated_at = excluded.updated_at`,
      shop,
      orderId,
      orderNumber,
      provider,
      status,
      subStatus,
      fulfillmentStatus,
      lastEventAt,
      JSON.stringify(raw),
      nowIso,
      nowIso,
    );
  }

  return {
    shop,
    orderId,
    orderNumber,
    provider,
    status,
    subStatus,
    fulfillmentStatus,
    lastEventAt,
  };
}

export async function getDeliveryOverview(shop) {
  await ensureDeliveryOmsTables();
  const rows = isPostgres()
    ? await prisma.$queryRawUnsafe(
      `SELECT status, COUNT(*) as count
       FROM delivery_shipment
       WHERE shop = $1
       GROUP BY status`,
      shop,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT status, COUNT(*) as count
       FROM delivery_shipment
       WHERE shop = ?
       GROUP BY status`,
      shop,
    );
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  return {
    total,
    breakdown: rows.map((row) => ({ status: row.status || "unknown", count: Number(row.count || 0) })),
  };
}

export async function getLatestDeliveryEvents(shop, limit = 8) {
  await ensureDeliveryOmsTables();
  const rows = isPostgres()
    ? await prisma.$queryRawUnsafe(
      `SELECT order_number, awb, provider, event, status_code, location, event_at
       FROM delivery_event
       WHERE shop = $1
       ORDER BY event_at DESC, id DESC
       LIMIT $2`,
      shop,
      limit,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT order_number, awb, provider, event, status_code, location, event_at
       FROM delivery_event
       WHERE shop = ?
       ORDER BY event_at DESC, id DESC
       LIMIT ?`,
      shop,
      limit,
    );
  return rows.map((row) => ({
    orderNumber: row.order_number,
    awb: row.awb,
    provider: row.provider,
    event: row.event,
    statusCode: row.status_code,
    location: row.location,
    eventAt: row.event_at,
  }));
}
