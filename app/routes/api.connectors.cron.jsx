import { listAllConnectorCredentials } from "../utils/db.server";
import { listConnectors } from "../utils/connector-sync.server";
import { enqueueJob } from "../utils/job-queue.server";
import { logError, logInfo } from "../utils/logger.server";
import { recordApiMetric } from "../utils/api-metrics.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function runCron(request) {
  const startedAt = Date.now();
  let statusCode = 200;
  let ok = true;
  const cronKey = process.env.CONNECTOR_CRON_KEY;
  if (!cronKey) {
    statusCode = 500;
    ok = false;
    const response = json({ error: "CONNECTOR_CRON_KEY is not set on server" }, { status: statusCode });
    await recordApiMetric({ routeKey: "api.connectors.cron", statusCode, durationMs: Date.now() - startedAt, ok });
    return response;
  }

  const headerKey = request.headers.get("x-netcash-cron-key") || "";
  if (!headerKey || headerKey !== cronKey) {
    statusCode = 401;
    ok = false;
    const response = json({ error: "Unauthorized" }, { status: statusCode });
    await recordApiMetric({ routeKey: "api.connectors.cron", statusCode, durationMs: Date.now() - startedAt, ok });
    return response;
  }

  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") || 1);
  const maxRuns = Number(url.searchParams.get("maxRuns") || 50);

  const pullProviders = listConnectors()
    .filter((connector) => connector.mode === "pull")
    .map((connector) => connector.key);

  const credentials = await listAllConnectorCredentials(pullProviders);
  const scoped = credentials.slice(0, Math.max(1, maxRuns));
  const results = [];
  const errors = [];

  for (const credential of scoped) {
    try {
      const job = await enqueueJob({
        type: "connector_sync",
        shop: credential.shop,
        payload: {
          provider: credential.provider,
          shop: credential.shop,
          days,
        },
        uniqueKey: `connector_sync:${credential.shop}:${credential.provider}`,
        maxAttempts: 4,
      });
      logInfo("api.connectors.cron.shop.enqueued", {
        shop: credential.shop,
        provider: credential.provider,
        days,
        jobId: job.id,
      });
      results.push({
        shop: credential.shop,
        provider: credential.provider,
        jobId: job.id,
      });
    } catch (error) {
      logError("api.connectors.cron.shop.error", {
        shop: credential.shop,
        provider: credential.provider,
        days,
        error: error?.message || "Unknown error",
      });
      errors.push({
        shop: credential.shop,
        provider: credential.provider,
        error: error?.message || "Unknown error",
      });
    }
  }

  logInfo("api.connectors.cron.completed", {
    attempted: scoped.length,
    queued: results.length,
    failed: errors.length,
    days,
  });
  ok = errors.length === 0;
  statusCode = ok ? 200 : 207;
  const response = json({
    success: errors.length === 0,
    attempted: scoped.length,
    queued: results.length,
    failed: errors.length,
    results,
    errors,
  }, { status: statusCode });
  await recordApiMetric({ routeKey: "api.connectors.cron", statusCode, durationMs: Date.now() - startedAt, ok });
  return response;
}

export async function action({ request }) {
  return runCron(request);
}

export async function loader({ request }) {
  return runCron(request);
}
