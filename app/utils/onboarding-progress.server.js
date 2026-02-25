import crypto from "node:crypto";
import { prisma } from "./db.server";

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

export async function ensureOnboardingProgressTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS onboarding_progress_state (
      shop TEXT PRIMARY KEY,
      total_steps INTEGER NOT NULL,
      done_steps INTEGER NOT NULL,
      progress_pct INTEGER NOT NULL,
      status_json TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS onboarding_progress_event (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      total_steps INTEGER NOT NULL,
      done_steps INTEGER NOT NULL,
      progress_pct INTEGER NOT NULL,
      status_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_onboarding_progress_event_shop_created ON onboarding_progress_event(shop, created_at)",
  );
}

export async function getOnboardingProgressState(shop) {
  await ensureOnboardingProgressTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT shop,
            total_steps as totalSteps,
            done_steps as doneSteps,
            progress_pct as progressPct,
            status_json as statusJson,
            updated_at as updatedAt
     FROM onboarding_progress_state
     WHERE shop = ${sqlQuote(safeShop)}
     LIMIT 1`,
  );
  return rows?.[0] || null;
}

export async function listOnboardingProgressHistory(shop, limit = 10) {
  await ensureOnboardingProgressTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return [];
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id,
            shop,
            total_steps as totalSteps,
            done_steps as doneSteps,
            progress_pct as progressPct,
            status_json as statusJson,
            created_at as createdAt
     FROM onboarding_progress_event
     WHERE shop = ${sqlQuote(safeShop)}
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );
  return rows || [];
}

export async function recordOnboardingProgressSnapshot(shop, snapshot = {}) {
  await ensureOnboardingProgressTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return { ok: false, reason: "shop_required" };

  const totalSteps = Math.max(0, Number(snapshot.totalSteps || 0));
  const doneSteps = Math.max(0, Number(snapshot.doneSteps || 0));
  const progressPct = Math.max(0, Math.min(100, Number(snapshot.progressPct || 0)));
  const statusJson = safeJsonStringify(snapshot.status || {});
  const now = new Date().toISOString();
  const previous = await getOnboardingProgressState(safeShop);

  await prisma.$executeRawUnsafe(
    `DELETE FROM onboarding_progress_state WHERE shop = ${sqlQuote(safeShop)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO onboarding_progress_state (shop, total_steps, done_steps, progress_pct, status_json, updated_at)
     VALUES (
       ${sqlQuote(safeShop)},
       ${totalSteps},
       ${doneSteps},
       ${progressPct},
       ${sqlQuote(statusJson)},
       ${sqlQuote(now)}
     )`,
  );

  const previousPct = Number(previous?.progressPct || -1);
  const previousDone = Number(previous?.doneSteps || -1);
  if (previousPct === progressPct && previousDone === doneSteps) {
    return { ok: true, changed: false };
  }

  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO onboarding_progress_event (id, shop, total_steps, done_steps, progress_pct, status_json, created_at)
     VALUES (
       ${sqlQuote(id)},
       ${sqlQuote(safeShop)},
       ${totalSteps},
       ${doneSteps},
       ${progressPct},
       ${sqlQuote(statusJson)},
       ${sqlQuote(now)}
     )`,
  );

  return { ok: true, changed: true, id };
}
