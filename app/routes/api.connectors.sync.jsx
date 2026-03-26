import { enqueueJob } from "../utils/job-queue.server";
import { logError, logInfo } from "../utils/logger.server";
import { recordApiMetric } from "../utils/api-metrics.server";
import { getLastSuccessfulConnectorSyncRun } from "../utils/db.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function action({ request }) {
  const startedAt = Date.now();
  let provider = "";
  let shop = "";
  try {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

    const expectedKey = process.env.ATTRIBUTION_API_KEY;
    if (expectedKey) {
      const provided = request.headers.get("x-netcash-api-key") || "";
      if (!provided || provided !== expectedKey) return json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    provider = String(body.provider || "");
    shop = String(body.shop || "");
    const days = Number(body.days || 7);

    if (!provider) return json({ error: "provider is required" }, { status: 400 });
    if (!shop) return json({ error: "shop is required" }, { status: 400 });

    const job = await enqueueJob({
      type: "connector_sync",
      shop,
      payload: { provider, shop, days },
      uniqueKey: `connector_sync:${shop}:${provider}`,
      maxAttempts: 4,
    });
    logInfo("api.connectors.sync.enqueued", { provider, shop, days, jobId: job.id });
    const response = json({ success: true, queued: true, job });
    await recordApiMetric({
      routeKey: "api.connectors.sync",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return response;
  } catch (error) {
    const message = error?.message || "Unknown error";
    const fallbackSnapshot = provider && shop
      ? await getLastSuccessfulConnectorSyncRun(shop, provider)
      : null;
    logError("api.connectors.sync.error", { error: message });
    const status = String(message).toLowerCase().includes("queue is busy") ? 429 : 500;
    const response = json({
      success: false,
      error: message,
      fallbackSnapshot: fallbackSnapshot
        ? {
            provider: fallbackSnapshot.provider,
            createdAt: fallbackSnapshot.createdAt,
            spendRowsWritten: fallbackSnapshot.spendRowsWritten,
            attributionRowsWritten: fallbackSnapshot.attributionRowsWritten,
          }
        : null,
    }, { status });
    await recordApiMetric({
      routeKey: "api.connectors.sync",
      statusCode: status,
      durationMs: Date.now() - startedAt,
      ok: false,
    });
    return response;
  }
}

export async function loader() {
  return json({
    endpoint: "/api/connectors/sync",
    method: "POST",
    requiredBody: {
      provider: "meta_ads | google_ads",
      shop: "your-store.myshopify.com",
      days: 7,
    },
    authHeader: "x-netcash-api-key (if ATTRIBUTION_API_KEY is set)",
    note: "Jobs are queued for async execution. Process using /api/jobs/worker with x-netcash-cron-key.",
  });
}
