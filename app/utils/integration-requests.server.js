import { prisma } from "./db.server";

const REQUEST_TABLES_SQLITE = [
  `CREATE TABLE IF NOT EXISTS integration_request (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    category TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_integration_request_shop ON integration_request(shop);`,
  `CREATE INDEX IF NOT EXISTS idx_integration_request_status ON integration_request(status);`,
];

const REQUEST_TABLES_POSTGRES = [
  `CREATE TABLE IF NOT EXISTS integration_request (
    id SERIAL PRIMARY KEY,
    shop TEXT NOT NULL,
    category TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMP NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_integration_request_shop ON integration_request(shop);`,
  `CREATE INDEX IF NOT EXISTS idx_integration_request_status ON integration_request(status);`,
];

function isPostgres() {
  return String(process.env.DATABASE_URL || "").startsWith("postgres");
}

export async function ensureIntegrationRequestTables() {
  const statements = isPostgres() ? REQUEST_TABLES_POSTGRES : REQUEST_TABLES_SQLITE;
  for (const stmt of statements) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(stmt);
  }
}

export async function createIntegrationRequests(shop, category, providers = [], notes = "") {
  await ensureIntegrationRequestTables();
  const nowIso = new Date().toISOString();
  const safeCategory = String(category || "delivery").trim().toLowerCase();
  const safeNotes = String(notes || "").trim() || null;
  const created = [];
  for (const provider of providers) {
    const safeProvider = String(provider || "").trim().toLowerCase();
    if (!safeProvider) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO integration_request (shop, category, provider, status, notes, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      shop,
      safeCategory,
      safeProvider,
      safeNotes,
      nowIso,
    );
    created.push({ provider: safeProvider, category: safeCategory });
  }
  return created;
}

export async function listIntegrationRequests(shop, limit = 20) {
  await ensureIntegrationRequestTables();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, category, provider, status, notes, created_at
     FROM integration_request
     WHERE shop = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    shop,
    limit,
  );
  return rows;
}
