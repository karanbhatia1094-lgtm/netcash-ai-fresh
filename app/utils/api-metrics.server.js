import { prisma } from "../../prisma.client.js";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function ensureApiMetricsTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS api_request_metric (
      id TEXT PRIMARY KEY,
      route_key TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_api_request_metric_route_created ON api_request_metric(route_key, created_at)",
  );
}

export async function recordApiMetric({
  routeKey,
  statusCode = 200,
  durationMs = 0,
  ok = true,
}) {
  try {
    await ensureApiMetricsTable();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO api_request_metric (id, route_key, status_code, duration_ms, ok, created_at)
       VALUES (${sqlQuote(id)}, ${sqlQuote(String(routeKey || "unknown"))}, ${Math.max(100, Number(statusCode) || 200)},
               ${Math.max(0, Number(durationMs) || 0)}, ${ok ? 1 : 0}, ${sqlQuote(nowIso())})`,
    );
  } catch {
    // Metrics should never break the primary request flow.
  }
}

export async function getApiLatencyAndErrorSummary({ windowMinutes = 60 } = {}) {
  try {
    await ensureApiMetricsTable();
    const window = Math.max(5, Math.min(24 * 60, Number(windowMinutes) || 60));
    const since = new Date(Date.now() - window * 60 * 1000).toISOString();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT route_key as routeKey,
              COUNT(*) AS total,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
              AVG(duration_ms) AS avgDurationMs,
              MAX(duration_ms) AS maxDurationMs
       FROM api_request_metric
       WHERE created_at >= ${sqlQuote(since)}
       GROUP BY route_key
       ORDER BY total DESC`,
    );

    const summary = (rows || []).map((row) => {
      const total = Number(row.total || 0);
      const errors = Number(row.errors || 0);
      return {
        routeKey: row.routeKey,
        total,
        errors,
        errorRatePct: total > 0 ? (errors / total) * 100 : 0,
        avgDurationMs: Number(row.avgDurationMs || 0),
        maxDurationMs: Number(row.maxDurationMs || 0),
      };
    });

    const total = summary.reduce((sum, row) => sum + row.total, 0);
    const errors = summary.reduce((sum, row) => sum + row.errors, 0);
    const weightedLatencySum = summary.reduce((sum, row) => sum + row.avgDurationMs * row.total, 0);
    return {
      windowMinutes: window,
      total,
      errors,
      errorRatePct: total > 0 ? (errors / total) * 100 : 0,
      avgDurationMs: total > 0 ? weightedLatencySum / total : 0,
      routes: summary,
    };
  } catch {
    return {
      windowMinutes: Math.max(5, Math.min(24 * 60, Number(windowMinutes) || 60)),
      total: 0,
      errors: 0,
      errorRatePct: 0,
      avgDurationMs: 0,
      routes: [],
    };
  }
}
