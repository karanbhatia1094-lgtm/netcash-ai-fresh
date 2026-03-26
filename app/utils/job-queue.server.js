import crypto from "node:crypto";
import { prisma } from "../../prisma.client.js";
import { logError, logInfo, logWarn } from "./logger.server";

const QUEUED = "queued";
const PROCESSING = "processing";
const SUCCEEDED = "succeeded";
const FAILED = "failed";
const DEAD_LETTER_REASON_MAX = 300;

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return nowIso();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildInClause(values = []) {
  const rows = (values || []).map((row) => String(row || "").trim()).filter(Boolean);
  if (rows.length === 0) return "";
  return ` AND type IN (${rows.map((row) => sqlQuote(row)).join(",")}) `;
}

function queueLimitConfig() {
  return {
    maxPendingPerShop: Math.max(10, Number(process.env.JOB_QUEUE_MAX_PENDING_PER_SHOP || 100)),
    maxPendingGlobal: Math.max(100, Number(process.env.JOB_QUEUE_MAX_PENDING_GLOBAL || 50000)),
  };
}

function autoscaleConfig() {
  return {
    enabled: String(process.env.JOB_WORKER_AUTOSCALE_ENABLED || "true").toLowerCase() !== "false",
    targetBacklogPerWorker: Math.max(5, Number(process.env.JOB_WORKER_TARGET_BACKLOG_PER_WORKER || 25)),
    minWorkers: Math.max(1, Number(process.env.JOB_WORKER_MIN_CONCURRENCY || 1)),
    maxWorkers: Math.max(1, Number(process.env.JOB_WORKER_MAX_CONCURRENCY || 20)),
  };
}

function sanitizeWorkerId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "worker";
  return raw.slice(0, 120);
}

function deadLetterConfig() {
  return {
    enabled: String(process.env.JOB_DEAD_LETTER_ENABLED || "true").toLowerCase() !== "false",
    retentionDays: Math.max(7, Math.min(365, Number(process.env.JOB_DEAD_LETTER_RETENTION_DAYS || 45))),
  };
}

function heartbeatConfig() {
  return {
    staleMinutes: Math.max(1, Number(process.env.WORKER_HEARTBEAT_STALE_MINUTES || 3)),
  };
}

export async function ensureJobQueueTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      shop TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT,
      result_json TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      unique_key TEXT,
      run_after TEXT NOT NULL,
      locked_at TEXT,
      locked_by TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_job_queue_status_run_after ON job_queue(status, run_after)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_job_queue_shop_created ON job_queue(shop, created_at)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_job_queue_type_status ON job_queue(type, status)");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS job_dead_letter (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      shop TEXT,
      payload_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      reason TEXT,
      failed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_job_dead_letter_shop_created ON job_dead_letter(shop, created_at)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_job_dead_letter_type_created ON job_dead_letter(type, created_at)");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      worker_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      last_seen_at TEXT NOT NULL,
      started_at TEXT,
      last_error TEXT,
      last_result_json TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_worker_heartbeat_last_seen ON worker_heartbeat(last_seen_at)");
}

export async function enqueueJob({
  type,
  shop = null,
  payload = {},
  maxAttempts = 3,
  uniqueKey = null,
  runAfter = null,
}) {
  await ensureJobQueueTable();
  const safeType = String(type || "").trim();
  if (!safeType) throw new Error("enqueueJob requires type");
  const safeShop = shop ? String(shop).trim().toLowerCase() : null;
  const safeUniqueKey = uniqueKey ? String(uniqueKey).trim().toLowerCase() : null;

  if (safeUniqueKey) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, type, shop, status, payload_json as payloadJson, result_json as resultJson, error_message as errorMessage,
              attempts, max_attempts as maxAttempts, unique_key as uniqueKey, run_after as runAfter, completed_at as completedAt,
              created_at as createdAt, updated_at as updatedAt
       FROM job_queue
       WHERE unique_key = ${sqlQuote(safeUniqueKey)}
         AND status IN (${sqlQuote(QUEUED)}, ${sqlQuote(PROCESSING)})
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (existing?.[0]) {
      return {
        ...existing[0],
        payload: safeJsonParse(existing[0].payloadJson, {}),
        result: safeJsonParse(existing[0].resultJson, null),
      };
    }
  }

  const limits = queueLimitConfig();
  const pendingStates = `${sqlQuote(QUEUED)}, ${sqlQuote(PROCESSING)}`;
  const globalRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS total
     FROM job_queue
     WHERE status IN (${pendingStates})`,
  );
  const globalPending = Number(globalRows?.[0]?.total || 0);
  if (globalPending >= limits.maxPendingGlobal) {
    throw new Error(`Queue is busy. Global pending limit reached (${limits.maxPendingGlobal}).`);
  }

  if (safeShop) {
    const shopRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total
       FROM job_queue
       WHERE shop = ${sqlQuote(safeShop)} AND status IN (${pendingStates})`,
    );
    const shopPending = Number(shopRows?.[0]?.total || 0);
    if (shopPending >= limits.maxPendingPerShop) {
      throw new Error(`Queue is busy for this shop. Pending limit reached (${limits.maxPendingPerShop}).`);
    }
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const safeRunAfter = toIso(runAfter);
  await prisma.$executeRawUnsafe(
    `INSERT INTO job_queue
      (id, type, shop, status, payload_json, attempts, max_attempts, unique_key, run_after, created_at, updated_at)
     VALUES
      (${sqlQuote(id)}, ${sqlQuote(safeType)}, ${sqlQuote(safeShop)}, ${sqlQuote(QUEUED)}, ${sqlQuote(safeJsonStringify(payload))},
       0, ${Math.max(1, Number(maxAttempts) || 3)}, ${sqlQuote(safeUniqueKey)}, ${sqlQuote(safeRunAfter)}, ${sqlQuote(createdAt)}, ${sqlQuote(createdAt)})`,
  );

  logInfo("jobs.enqueued", { id, type: safeType, shop: safeShop, uniqueKey: safeUniqueKey });
  return {
    id,
    type: safeType,
    shop: safeShop,
    status: QUEUED,
    payload,
    attempts: 0,
    maxAttempts: Math.max(1, Number(maxAttempts) || 3),
    uniqueKey: safeUniqueKey,
    runAfter: safeRunAfter,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function listJobs({ shop = null, status = null, limit = 50 } = {}) {
  await ensureJobQueueTable();
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 50));
  const where = [];
  if (shop) where.push(`shop = ${sqlQuote(String(shop).trim().toLowerCase())}`);
  if (status) where.push(`status = ${sqlQuote(String(status).trim().toLowerCase())}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, type, shop, status, payload_json as payloadJson, result_json as resultJson, error_message as errorMessage,
            attempts, max_attempts as maxAttempts, unique_key as uniqueKey, run_after as runAfter, locked_at as lockedAt,
            locked_by as lockedBy, completed_at as completedAt, created_at as createdAt, updated_at as updatedAt
     FROM job_queue
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );

  return (rows || []).map((row) => ({
    ...row,
    payload: safeJsonParse(row.payloadJson, {}),
    result: row.resultJson ? safeJsonParse(row.resultJson, {}) : null,
  }));
}

export async function getQueueBacklogSummary({ recentWindowMinutes = 60 } = {}) {
  await ensureJobQueueTable();
  const windowMinutes = Math.max(5, Math.min(24 * 60, Number(recentWindowMinutes) || 60));
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const totalsRows = await prisma.$queryRawUnsafe(
    `SELECT
        SUM(CASE WHEN status = ${sqlQuote(QUEUED)} THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = ${sqlQuote(PROCESSING)} THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = ${sqlQuote(FAILED)} THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = ${sqlQuote(SUCCEEDED)} THEN 1 ELSE 0 END) AS succeeded,
        MIN(CASE WHEN status = ${sqlQuote(QUEUED)} THEN created_at ELSE NULL END) AS oldest_queued_at
     FROM job_queue`,
  );

  const perShopRows = await prisma.$queryRawUnsafe(
    `SELECT shop, COUNT(*) AS pending
     FROM job_queue
     WHERE status IN (${sqlQuote(QUEUED)}, ${sqlQuote(PROCESSING)})
       AND shop IS NOT NULL
     GROUP BY shop
     ORDER BY pending DESC
     LIMIT 20`,
  );

  const recentRows = await prisma.$queryRawUnsafe(
    `SELECT
        SUM(CASE WHEN status = ${sqlQuote(FAILED)} THEN 1 ELSE 0 END) AS failed_recent,
        SUM(CASE WHEN status = ${sqlQuote(SUCCEEDED)} THEN 1 ELSE 0 END) AS succeeded_recent
     FROM job_queue
     WHERE updated_at >= ${sqlQuote(windowStart)}`,
  );

  const totals = totalsRows?.[0] || {};
  const recent = recentRows?.[0] || {};
  const queued = Number(totals.queued || 0);
  const processing = Number(totals.processing || 0);
  const failed = Number(totals.failed || 0);
  const succeeded = Number(totals.succeeded || 0);
  const failedRecent = Number(recent.failed_recent || 0);
  const succeededRecent = Number(recent.succeeded_recent || 0);
  const oldestQueuedAt = totals.oldest_queued_at || null;
  const oldestQueuedAgeMinutes = oldestQueuedAt
    ? Math.max(0, Math.round((Date.now() - new Date(oldestQueuedAt).getTime()) / 60000))
    : 0;

  const auto = autoscaleConfig();
  const pending = queued + processing;
  const desiredWorkers = !auto.enabled
    ? auto.minWorkers
    : Math.max(
      auto.minWorkers,
      Math.min(auto.maxWorkers, Math.ceil(pending / auto.targetBacklogPerWorker)),
    );

  return {
    pending,
    queued,
    processing,
    failed,
    succeeded,
    failedRecent,
    succeededRecent,
    oldestQueuedAt,
    oldestQueuedAgeMinutes,
    recommendedWorkers: desiredWorkers,
    autoscale: auto,
    topShopsByPending: (perShopRows || []).map((row) => ({
      shop: row.shop,
      pending: Number(row.pending || 0),
    })),
  };
}

async function claimNextJob({ workerId = "worker", types = [] } = {}) {
  await ensureJobQueueTable();
  const dueRows = await prisma.$queryRawUnsafe(
    `SELECT id, type, shop, status, payload_json as payloadJson, attempts, max_attempts as maxAttempts, run_after as runAfter
     FROM job_queue
     WHERE status = ${sqlQuote(QUEUED)}
     ${buildInClause(types)}
     ORDER BY created_at ASC
     LIMIT 30`,
  );

  const now = Date.now();
  for (const row of dueRows || []) {
    if (new Date(row.runAfter).getTime() > now) continue;
    const lockedAt = nowIso();
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE job_queue
       SET status = ${sqlQuote(PROCESSING)}, attempts = attempts + 1, locked_at = ${sqlQuote(lockedAt)},
           locked_by = ${sqlQuote(workerId)}, updated_at = ${sqlQuote(lockedAt)}
       WHERE id = ${sqlQuote(row.id)} AND status = ${sqlQuote(QUEUED)}`,
    );
    if (Number(changed) > 0) {
      return {
        ...row,
        status: PROCESSING,
        attempts: Number(row.attempts || 0) + 1,
        payload: safeJsonParse(row.payloadJson, {}),
      };
    }
  }
  return null;
}

async function completeJob(id, result = {}) {
  const now = nowIso();
  await prisma.$executeRawUnsafe(
    `UPDATE job_queue
     SET status = ${sqlQuote(SUCCEEDED)}, result_json = ${sqlQuote(safeJsonStringify(result))}, error_message = NULL,
         completed_at = ${sqlQuote(now)}, updated_at = ${sqlQuote(now)}
     WHERE id = ${sqlQuote(id)}`,
  );
}

async function moveToDeadLetter(id, { reason = "max_attempts_exhausted" } = {}) {
  const config = deadLetterConfig();
  if (!config.enabled) return;
  const now = nowIso();
  const safeReason = String(reason || "unknown").slice(0, DEAD_LETTER_REASON_MAX);
  await prisma.$executeRawUnsafe(
    `INSERT INTO job_dead_letter
      (id, job_id, type, shop, payload_json, attempts, max_attempts, error_message, reason, failed_at, created_at)
     SELECT
      ${sqlQuote(crypto.randomUUID())}, id, type, shop, payload_json, attempts, max_attempts, error_message,
      ${sqlQuote(safeReason)}, ${sqlQuote(now)}, ${sqlQuote(now)}
     FROM job_queue
     WHERE id = ${sqlQuote(id)}
     LIMIT 1`,
  );
}

async function failJob(id, { error, attempts, maxAttempts, retryDelaySeconds = 30 }) {
  const safeAttempts = Number(attempts || 0);
  const safeMaxAttempts = Math.max(1, Number(maxAttempts || 3));
  const shouldRetry = safeAttempts < safeMaxAttempts;
  const nextRunAt = new Date(Date.now() + Math.max(1, Number(retryDelaySeconds) || 30) * 1000).toISOString();
  const now = nowIso();
  if (shouldRetry) {
    await prisma.$executeRawUnsafe(
      `UPDATE job_queue
       SET status = ${sqlQuote(QUEUED)}, error_message = ${sqlQuote(String(error || "Unknown error").slice(0, 1000))},
           run_after = ${sqlQuote(nextRunAt)}, updated_at = ${sqlQuote(now)}
       WHERE id = ${sqlQuote(id)}`,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE job_queue
       SET status = ${sqlQuote(FAILED)}, error_message = ${sqlQuote(String(error || "Unknown error").slice(0, 1000))},
           completed_at = ${sqlQuote(now)}, updated_at = ${sqlQuote(now)}
       WHERE id = ${sqlQuote(id)}`,
    );
    await moveToDeadLetter(id, { reason: "max_attempts_exhausted" });
  }
}

export async function recordWorkerHeartbeat(workerId, data = {}) {
  await ensureJobQueueTable();
  const now = nowIso();
  const safeWorkerId = sanitizeWorkerId(workerId);
  const status = String(data.status || "active").slice(0, 24);
  const startedAt = toIso(data.startedAt || now);
  const lastSeenAt = toIso(data.lastSeenAt || now);
  const lastError = data.lastError == null ? null : String(data.lastError).slice(0, 1000);
  const lastResultJson = safeJsonStringify(data.lastResult || null);

  await prisma.$executeRawUnsafe(
    `INSERT INTO worker_heartbeat (worker_id, status, last_seen_at, started_at, last_error, last_result_json, updated_at)
     VALUES (
       ${sqlQuote(safeWorkerId)}, ${sqlQuote(status)}, ${sqlQuote(lastSeenAt)},
       ${sqlQuote(startedAt)}, ${sqlQuote(lastError)}, ${sqlQuote(lastResultJson)}, ${sqlQuote(now)}
     )
     ON CONFLICT(worker_id) DO UPDATE SET
       status = EXCLUDED.status,
       last_seen_at = EXCLUDED.last_seen_at,
       last_error = EXCLUDED.last_error,
       last_result_json = EXCLUDED.last_result_json,
       updated_at = EXCLUDED.updated_at`,
  );
}

export async function requeueStuckProcessingJobs({
  staleMinutes = Math.max(2, Number(process.env.JOB_STUCK_REQUEUE_MINUTES || 15)),
  limit = 50,
} = {}) {
  await ensureJobQueueTable();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const staleBefore = new Date(Date.now() - Math.max(1, Number(staleMinutes) || 15) * 60 * 1000).toISOString();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, type, shop, attempts, max_attempts as maxAttempts, locked_at as lockedAt, error_message as errorMessage
     FROM job_queue
     WHERE status = ${sqlQuote(PROCESSING)}
       AND locked_at IS NOT NULL
       AND locked_at <= ${sqlQuote(staleBefore)}
     ORDER BY locked_at ASC
     LIMIT ${safeLimit}`,
  );

  let requeued = 0;
  let deadLettered = 0;
  for (const row of rows || []) {
    const attempts = Number(row.attempts || 0);
    const maxAttempts = Math.max(1, Number(row.maxAttempts || 3));
    const now = nowIso();
    const safeError = `Recovered from stale processing lock at ${row.lockedAt || "unknown"}; previous error: ${String(row.errorMessage || "none").slice(0, 400)}`;
    if (attempts >= maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(
        `UPDATE job_queue
         SET status = ${sqlQuote(FAILED)}, completed_at = ${sqlQuote(now)}, updated_at = ${sqlQuote(now)},
             error_message = ${sqlQuote(safeError)}
         WHERE id = ${sqlQuote(row.id)} AND status = ${sqlQuote(PROCESSING)}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await moveToDeadLetter(row.id, { reason: "stuck_processing_exhausted" });
      deadLettered += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(
        `UPDATE job_queue
         SET status = ${sqlQuote(QUEUED)}, locked_at = NULL, locked_by = NULL, run_after = ${sqlQuote(now)},
             updated_at = ${sqlQuote(now)}, error_message = ${sqlQuote(safeError)}
         WHERE id = ${sqlQuote(row.id)} AND status = ${sqlQuote(PROCESSING)}`,
      );
      requeued += 1;
    }
  }

  return {
    scanned: Number(rows?.length || 0),
    requeued,
    deadLettered,
    staleBefore,
  };
}

export async function cleanupDeadLetter({ retentionDays = null } = {}) {
  await ensureJobQueueTable();
  const config = deadLetterConfig();
  const safeDays = Math.max(1, Number(retentionDays || config.retentionDays));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM job_dead_letter WHERE created_at < ${sqlQuote(cutoff)}`,
  );
  return { deleted: Number(deleted || 0), cutoff, retentionDays: safeDays };
}

export async function getWorkerHeartbeatSummary() {
  await ensureJobQueueTable();
  const staleMinutes = heartbeatConfig().staleMinutes;
  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT worker_id as workerId, status, last_seen_at as lastSeenAt, started_at as startedAt,
            last_error as lastError, last_result_json as lastResultJson
     FROM worker_heartbeat
     ORDER BY last_seen_at DESC
     LIMIT 100`,
  );
  const workers = (rows || []).map((row) => {
    const isStale = !row.lastSeenAt || row.lastSeenAt < staleBefore;
    return {
      workerId: row.workerId,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      startedAt: row.startedAt || null,
      stale: isStale,
      lastError: row.lastError || null,
      lastResult: safeJsonParse(row.lastResultJson, null),
    };
  });
  return {
    staleMinutes,
    activeWorkers: workers.filter((row) => !row.stale).length,
    staleWorkers: workers.filter((row) => row.stale).length,
    workers,
  };
}

export async function getDeadLetterSummary({ shop = null, limit = 25, days = 7 } = {}) {
  await ensureJobQueueTable();
  const safeShop = shop ? String(shop).trim().toLowerCase() : null;
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 25));
  const since = new Date(Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000).toISOString();
  const whereShop = safeShop ? ` AND shop = ${sqlQuote(safeShop)} ` : "";

  const [totalsRows, recentRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN created_at >= ${sqlQuote(since)} THEN 1 ELSE 0 END) AS recent_total
       FROM job_dead_letter
       WHERE 1=1 ${whereShop}`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT job_id as jobId, type, shop, attempts, max_attempts as maxAttempts, error_message as errorMessage,
              reason, failed_at as failedAt, created_at as createdAt
       FROM job_dead_letter
       WHERE 1=1 ${whereShop}
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
    ),
  ]);

  return {
    total: Number(totalsRows?.[0]?.total || 0),
    recentTotal: Number(totalsRows?.[0]?.recent_total || 0),
    rows: (recentRows || []).map((row) => ({
      ...row,
      attempts: Number(row.attempts || 0),
      maxAttempts: Number(row.maxAttempts || 0),
    })),
  };
}

export async function processQueueBatch({
  workerId = "worker",
  handlers = {},
  types = [],
  maxJobs = 20,
} = {}) {
  await ensureJobQueueTable();
  const safeWorkerId = sanitizeWorkerId(workerId);
  const safeMaxJobs = Math.max(1, Math.min(200, Number(maxJobs) || 20));
  const recovered = await requeueStuckProcessingJobs();
  if (Number(recovered.requeued || 0) > 0 || Number(recovered.deadLettered || 0) > 0) {
    logWarn("jobs.stuck.recovered", { workerId: safeWorkerId, ...recovered });
  }
  await cleanupDeadLetter();
  await recordWorkerHeartbeat(safeWorkerId, {
    status: "active",
    startedAt: nowIso(),
    lastSeenAt: nowIso(),
    lastResult: { stage: "before_batch", recovered },
  });

  let attempted = 0;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const results = [];

  while (attempted < safeMaxJobs) {
    attempted += 1;
    const job = await claimNextJob({ workerId: safeWorkerId, types });
    if (!job) break;

    processed += 1;
    const startedAt = Date.now();
    const handler = handlers[job.type];
    if (typeof handler !== "function") {
      await failJob(job.id, {
        error: `No handler registered for job type: ${job.type}`,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        retryDelaySeconds: 5,
      });
      failed += 1;
      results.push({ id: job.id, type: job.type, status: FAILED, error: "No handler registered" });
      logWarn("jobs.handler.missing", { id: job.id, type: job.type });
      continue;
    }

    try {
      const output = await handler(job);
      await completeJob(job.id, output || {});
      succeeded += 1;
      const durationMs = Date.now() - startedAt;
      results.push({ id: job.id, type: job.type, status: SUCCEEDED, durationMs });
      logInfo("jobs.process.success", { id: job.id, type: job.type, durationMs });
    } catch (error) {
      const message = String(error?.message || "Unknown job error");
      await failJob(job.id, {
        error: message,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        retryDelaySeconds: 30,
      });
      failed += 1;
      results.push({ id: job.id, type: job.type, status: FAILED, error: message });
      logError("jobs.process.failed", { id: job.id, type: job.type, error: message });
    }
  }

  await recordWorkerHeartbeat(safeWorkerId, {
    status: "idle",
    lastSeenAt: nowIso(),
    lastResult: { processed, succeeded, failed },
    lastError: failed > 0 ? `${failed} job(s) failed in last batch` : null,
  });

  return {
    workerId: safeWorkerId,
    processed,
    succeeded,
    failed,
    recoveredStuck: recovered,
    results,
  };
}
