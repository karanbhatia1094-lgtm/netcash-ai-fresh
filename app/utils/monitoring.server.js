import { getQueueBacklogSummary } from "./job-queue.server";
import { getApiLatencyAndErrorSummary } from "./api-metrics.server";
import { getSyncFreshnessByShop } from "./db.server";

export async function buildMonitoringOverview({ windowMinutes = 60, syncDays = 7 } = {}) {
  const safeWindow = Math.max(5, Math.min(24 * 60, Number(windowMinutes) || 60));
  const safeSyncDays = Math.max(1, Math.min(90, Number(syncDays) || 7));
  const [queue, api, syncFreshness] = await Promise.all([
    getQueueBacklogSummary({ recentWindowMinutes: safeWindow }),
    getApiLatencyAndErrorSummary({ windowMinutes: safeWindow }),
    getSyncFreshnessByShop(safeSyncDays),
  ]);

  const syncLagThresholdMinutes = Math.max(60, Number(process.env.ALERT_SYNC_LAG_MINUTES || 360));
  const queueBacklogThreshold = Math.max(20, Number(process.env.ALERT_QUEUE_BACKLOG || 500));
  const workerFailureThreshold = Math.max(1, Number(process.env.ALERT_WORKER_FAILURES || 5));
  const apiErrorRateThresholdPct = Math.max(0.1, Number(process.env.ALERT_API_ERROR_RATE_PCT || 5));
  const apiLatencyThresholdMs = Math.max(100, Number(process.env.ALERT_API_LATENCY_MS || 1200));

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
        monitoring.queueBacklog.alert ||
        monitoring.apiLatencyAndErrorRate.alert ||
        monitoring.syncFreshnessLagPerShop.alert,
    },
  };
}
