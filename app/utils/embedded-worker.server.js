import { getQueueBacklogSummary, processQueueBatch } from "./job-queue.server";
import { jobHandlers } from "./job-handlers.server";
import { logError, logInfo } from "./logger.server";
import { parseTypes, shouldAutoStartWorker } from "./worker-config.server";
import { scheduleAutonomousRepairs } from "./autonomous-ops.server";

export function startEmbeddedWorkerLoop() {
  if (!shouldAutoStartWorker()) return;
  if (globalThis.__NETCASH_EMBEDDED_WORKER_STARTED__) return;
  globalThis.__NETCASH_EMBEDDED_WORKER_STARTED__ = true;

  const maxJobs = Math.max(1, Math.min(500, Number(process.env.WORKER_MAX_JOBS || 25)));
  const intervalMs = Math.max(1000, Number(process.env.WORKER_LOOP_INTERVAL_MS || 5000));
  const workerId = String(process.env.WORKER_ID || "embedded.worker");
  const types = parseTypes(process.env.WORKER_TYPES || "");
  let running = false;
  let lastAutoRepairRunAt = 0;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const before = await getQueueBacklogSummary();
      const result = await processQueueBatch({
        workerId,
        handlers: jobHandlers,
        types,
        maxJobs,
      });
      const autoRepairIntervalMinutes = Math.max(5, Number(process.env.AUTO_REPAIR_MIN_INTERVAL_MINUTES || 20));
      if (String(process.env.AUTO_REPAIR_ENABLED || "true").toLowerCase() !== "false") {
        const now = Date.now();
        if (now - lastAutoRepairRunAt >= autoRepairIntervalMinutes * 60 * 1000) {
          lastAutoRepairRunAt = now;
          await scheduleAutonomousRepairs({ source: "embedded_worker" });
        }
      }
      const after = await getQueueBacklogSummary();
      if (result.processed > 0 || before.pending > 0 || after.pending > 0) {
        logInfo("embedded.worker.tick", {
          workerId,
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          pendingBefore: before.pending,
          pendingAfter: after.pending,
        });
      }
    } catch (error) {
      logError("embedded.worker.tick.failed", {
        workerId,
        error: String(error?.message || error),
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => null);
  }, intervalMs);
  if (typeof timer?.unref === "function") timer.unref();

  setTimeout(() => {
    tick().catch(() => null);
  }, 1000);

  logInfo("embedded.worker.started", {
    workerId,
    intervalMs,
    maxJobs,
    types,
  });
}
