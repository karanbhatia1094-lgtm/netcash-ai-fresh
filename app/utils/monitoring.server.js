import { getDeadLetterSummary, getQueueBacklogSummary, getWorkerHeartbeatSummary } from "./job-queue.server";
import { getApiLatencyAndErrorSummary } from "./api-metrics.server";
import { getSyncFreshnessByShop } from "./db.server";

export async function buildMonitoringOverview({ windowMinutes = 60, syncDays = 7 } = {}) {
  const safeWindow = Math.max(5, Math.min(24 * 60, Number(windowMinutes) || 60));
  const safeSyncDays = Math.max(1, Math.min(90, Number(syncDays) || 7));
  const [queue, api, syncFreshness, deadLetter, workerHeartbeat] = await Promise.all([
    getQueueBacklogSummary({ recentWindowMinutes: safeWindow }),
    getApiLatencyAndErrorSummary({ windowMinutes: safeWindow }),
    getSyncFreshnessByShop(safeSyncDays),
    getDeadLetterSummary({ days: Math.max(1, Math.ceil(safeWindow / (60 * 24))), limit: 20 }),
    getWorkerHeartbeatSummary(),
  ]);

  const syncLagThresholdMinutes = Math.max(60, Number(process.env.ALERT_SYNC_LAG_MINUTES || 360));
  const queueBacklogThreshold = Math.max(20, Number(process.env.ALERT_QUEUE_BACKLOG || 500));
  const workerFailureThreshold = Math.max(1, Number(process.env.ALERT_WORKER_FAILURES || 5));
  const workerStaleThreshold = Math.max(1, Number(process.env.ALERT_WORKER_STALE_COUNT || 1));
  const apiErrorRateThresholdPct = Math.max(0.1, Number(process.env.ALERT_API_ERROR_RATE_PCT || 5));
  const apiLatencyThresholdMs = Math.max(100, Number(process.env.ALERT_API_LATENCY_MS || 1200));
  const deadLetterThreshold = Math.max(1, Number(process.env.ALERT_DEAD_LETTER_RECENT || 10));

  const staleShops = (syncFreshness || []).filter((row) => {
    const lag = row.connectorLagMinutes ?? row.orderLagMinutes ?? 0;
    return lag >= syncLagThresholdMinutes;
  });

  const monitoring = {
    workerFailures: {
      failedRecent: queue.failedRecent,
      threshold: workerFailureThreshold,
      alert: queue.failedRecent >= workerFailureThreshold,
    },
    workerHeartbeat: {
      staleMinutes: workerHeartbeat.staleMinutes,
      activeWorkers: workerHeartbeat.activeWorkers,
      staleWorkers: workerHeartbeat.staleWorkers,
      threshold: workerStaleThreshold,
      alert: workerHeartbeat.staleWorkers >= workerStaleThreshold,
      rows: workerHeartbeat.workers,
    },
    queueBacklog: {
      pending: queue.pending,
      queued: queue.queued,
      processing: queue.processing,
      oldestQueuedAgeMinutes: queue.oldestQueuedAgeMinutes,
      threshold: queueBacklogThreshold,
      alert: queue.pending >= queueBacklogThreshold,
      recommendedWorkers: queue.recommendedWorkers,
      topShopsByPending: queue.topShopsByPending,
    },
    deadLetterQueue: {
      total: deadLetter.total,
      recentTotal: deadLetter.recentTotal,
      threshold: deadLetterThreshold,
      alert: deadLetter.recentTotal >= deadLetterThreshold,
      rows: deadLetter.rows,
    },
    apiLatencyAndErrorRate: {
      total: api.total,
      errors: api.errors,
      errorRatePct: api.errorRatePct,
      avgDurationMs: api.avgDurationMs,
      thresholds: {
        errorRatePct: apiErrorRateThresholdPct,
        avgDurationMs: apiLatencyThresholdMs,
      },
      alert: api.errorRatePct >= apiErrorRateThresholdPct || api.avgDurationMs >= apiLatencyThresholdMs,
      routes: api.routes,
    },
    syncFreshnessLagPerShop: {
      thresholdMinutes: syncLagThresholdMinutes,
      staleShops: staleShops.length,
      alert: staleShops.length > 0,
      rows: syncFreshness,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    monitoring,
    alerts: {
      any:
        monitoring.workerFailures.alert ||
        monitoring.workerHeartbeat.alert ||
        monitoring.queueBacklog.alert ||
        monitoring.deadLetterQueue.alert ||
        monitoring.apiLatencyAndErrorRate.alert ||
        monitoring.syncFreshnessLagPerShop.alert,
    },
  };
}
