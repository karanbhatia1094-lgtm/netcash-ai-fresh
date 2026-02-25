import crypto from "node:crypto";
import { prisma } from "../../prisma.client.js";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ROLE_CAPABILITIES = {
  founder: ["view", "manage_rollout", "manage_overrides", "run_jobs", "export", "manage_team"],
  ops: ["view", "manage_rollout", "manage_overrides", "run_jobs", "export"],
  support: ["view", "manage_overrides", "export"],
  analyst: ["view", "export"],
};

export async function ensureOwnerGovernanceTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS owner_team_access (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS owner_audit_event (
      id TEXT PRIMARY KEY,
      actor_shop TEXT,
      actor_email TEXT,
      actor_role TEXT,
      action_key TEXT NOT NULL,
      target_key TEXT,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_owner_audit_created ON owner_audit_event(created_at)",
  );
}

function parseEnvTeamAccess() {
  const raw = String(process.env.OWNER_TEAM_JSON || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const next = {};
    for (const [email, role] of Object.entries(parsed)) {
      const safeEmail = String(email || "").trim().toLowerCase();
      const safeRole = String(role || "").trim().toLowerCase();
      if (!safeEmail || !ROLE_CAPABILITIES[safeRole]) continue;
      next[safeEmail] = safeRole;
    }
    return next;
  } catch {
    return {};
  }
}

export async function listOwnerTeamAccess() {
  await ensureOwnerGovernanceTables();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT email, role, updated_at as updatedAt
     FROM owner_team_access
     ORDER BY email ASC`,
  );
  return rows || [];
}

export async function upsertOwnerTeamAccess(email, role) {
  await ensureOwnerGovernanceTables();
  const safeEmail = String(email || "").trim().toLowerCase();
  const safeRole = String(role || "").trim().toLowerCase();
  if (!safeEmail || !ROLE_CAPABILITIES[safeRole]) throw new Error("invalid team access row");
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `DELETE FROM owner_team_access
     WHERE email = ${sqlQuote(safeEmail)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO owner_team_access (email, role, updated_at)
     VALUES (${sqlQuote(safeEmail)}, ${sqlQuote(safeRole)}, ${sqlQuote(now)})`,
  );
}

export async function deleteOwnerTeamAccess(email) {
  await ensureOwnerGovernanceTables();
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM owner_team_access
     WHERE email = ${sqlQuote(safeEmail)}`,
  );
}

export async function resolveOwnerRole(session = {}, isOwnerShop = false) {
  const email = String(session?.email || "").trim().toLowerCase();
  const envMap = parseEnvTeamAccess();
  if (email && envMap[email]) return envMap[email];

  await ensureOwnerGovernanceTables();
  if (email) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT role FROM owner_team_access WHERE email = ${sqlQuote(email)} LIMIT 1`,
    );
    const dbRole = String(rows?.[0]?.role || "").trim().toLowerCase();
    if (ROLE_CAPABILITIES[dbRole]) return dbRole;
  }
  return isOwnerShop ? "founder" : "none";
}

export function getRoleCapabilities(role) {
  return ROLE_CAPABILITIES[String(role || "").toLowerCase()] || [];
}

export function canOwner(role, capability) {
  return getRoleCapabilities(role).includes(String(capability || "").toLowerCase());
}

export async function logOwnerAuditEvent({
  actorShop = "",
  actorEmail = "",
  actorRole = "",
  actionKey = "",
  targetKey = "",
  payload = {},
  status = "ok",
} = {}) {
  try {
    await ensureOwnerGovernanceTables();
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO owner_audit_event
       (id, actor_shop, actor_email, actor_role, action_key, target_key, payload_json, status, created_at)
       VALUES (
         ${sqlQuote(id)},
         ${sqlQuote(String(actorShop || "").toLowerCase())},
         ${sqlQuote(String(actorEmail || "").toLowerCase())},
         ${sqlQuote(String(actorRole || ""))},
         ${sqlQuote(String(actionKey || "unknown"))},
         ${sqlQuote(String(targetKey || ""))},
         ${sqlQuote(JSON.stringify(payload || {}))},
         ${sqlQuote(String(status || "ok"))},
         ${sqlQuote(new Date().toISOString())}
       )`,
    );
  } catch {
    // audit must not break request flow
  }
}

export async function listOwnerAuditEvents(limit = 100) {
  await ensureOwnerGovernanceTables();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, actor_shop as actorShop, actor_email as actorEmail, actor_role as actorRole, action_key as actionKey,
            target_key as targetKey, payload_json as payloadJson, status, created_at as createdAt
     FROM owner_audit_event
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );
  return (rows || []).map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(String(row.payloadJson || "{}"));
    } catch {
      payload = {};
    }
    return { ...row, payload };
  });
}
