import { json } from "@remix-run/node";
import { prisma } from "../utils/db.server";
import { getEnvHealth } from "../utils/env.server";
import { recordApiMetric } from "../utils/api-metrics.server";
import { getQueueBacklogSummary, getWorkerHeartbeatSummary } from "../utils/job-queue.server";

export async function loader() {
  const startedAt = Date.now();
  const env = getEnvHealth();
  let dbOk = false;
  let dbError = null;
  let queue = null;
  let workers = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    dbError = error?.message || "Database check failed";
  }
  try {
    [queue, workers] = await Promise.all([
      getQueueBacklogSummary({ recentWindowMinutes: 60 }),
      getWorkerHeartbeatSummary(),
    ]);
  } catch {
    queue = null;
    workers = null;
  }

  const queuePendingThreshold = Math.max(200, Number(process.env.READINESS_QUEUE_PENDING_MAX || 3000));
  const workerStaleThreshold = Math.max(0, Number(process.env.READINESS_STALE_WORKERS_MAX || 1));
  const queueOk = !queue || Number(queue.pending || 0) <= queuePendingThreshold;
  const workersOk = !workers || Number(workers.staleWorkers || 0) <= workerStaleThreshold;
  const ready = env.ok && dbOk && queueOk && workersOk;
  const payload = {
    ready,
    environment: process.env.NODE_ENV || "development",
    checks: {
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
      },
      db: {
        ok: dbOk,
        error: dbError,
      },
      queue: {
        ok: queueOk,
        pending: Number(queue?.pending || 0),
        threshold: queuePendingThreshold,
      },
      workers: {
        ok: workersOk,
        active: Number(workers?.activeWorkers || 0),
        stale: Number(workers?.staleWorkers || 0),
        threshold: workerStaleThreshold,
      },
    },
    timestamp: new Date().toISOString(),
  };
  const status = ready ? 200 : 503;
  await recordApiMetric({
    routeKey: "health.readiness",
    statusCode: status,
    durationMs: Date.now() - startedAt,
    ok: ready,
  });

  return json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
