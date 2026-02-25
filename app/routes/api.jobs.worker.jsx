import { getQueueBacklogSummary, processQueueBatch } from "../utils/job-queue.server";
import { runConnectorSync } from "../utils/connector-sync.server";
import { runDueScheduledReports } from "../utils/report-scheduler.server";
import { refreshOwnerDailyRollups } from "../utils/owner-rollups.server";
import { syncOrdersForShop } from "../utils/order-sync.server";
import { refreshNetcashTruthRollups } from "../utils/netcash-truth.server";
import { recordApiMetric } from "../utils/api-metrics.server";
import { runProfitGuardrails } from "../utils/profit-guardrails.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function parseTypes(value) {
  const raw = String(value || "");
  return raw
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
}

function getWorkerKey() {
  return process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "";
}

function authorize(request) {
  const expected = getWorkerKey();
  if (!expected) return { ok: false, reason: "JOB_WORKER_KEY or CONNECTOR_CRON_KEY is not set" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (!provided || provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

const handlers = {
  connector_sync: async (job) => {
    const provider = String(job.payload?.provider || "");
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 7);
    if (!provider || !shop) throw new Error("connector_sync requires provider and shop");
    return runConnectorSync({ provider, shop, days });
  },
  reports_run_due: async (job) => {
    const maxRuns = Number(job.payload?.maxRuns || 50);
    return runDueScheduledReports(maxRuns);
  },
  shopify_order_sync: async (job) => {
    const shop = String(job.payload?.shop || "");
    if (!shop) throw new Error("shopify_order_sync requires shop");
    return syncOrdersForShop(shop);
  },
  owner_rollup_refresh: async (job) => {
    const daysBack = Number(job.payload?.daysBack || 7);
    return refreshOwnerDailyRollups(daysBack);
  },
  truth_rollup_refresh: async (job) => {
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 90);
    if (!shop) throw new Error("truth_rollup_refresh requires shop");
    return refreshNetcashTruthRollups(shop, days);
  },
  profit_guardrails_run: async (job) => {
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 30);
    const maxActions = Number(job.payload?.maxActions || 5);
    const applyActions = !!job.payload?.applyActions;
    if (!shop) throw new Error("profit_guardrails_run requires shop");
    return runProfitGuardrails({ shop, days, maxActions, applyActions });
  },
};

async function run(request) {
  const startedAt = Date.now();
  let statusCode = 200;
  let ok = true;
  const auth = authorize(request);
  if (!auth.ok) {
    statusCode = auth.reason === "Unauthorized" ? 401 : 500;
    ok = false;
    const response = json({ ok: false, error: auth.reason }, { status: statusCode });
    await recordApiMetric({
      routeKey: "api.jobs.worker",
      statusCode,
      durationMs: Date.now() - startedAt,
      ok,
    });
    return response;
  }

  const url = new URL(request.url);
  const maxJobs = Math.max(1, Math.min(500, Number(url.searchParams.get("maxJobs") || 25)));
  const types = parseTypes(url.searchParams.get("types") || "");
  const workerId = String(url.searchParams.get("workerId") || "api.jobs.worker");
  const before = await getQueueBacklogSummary();
  const result = await processQueueBatch({
    workerId,
    handlers,
    types,
    maxJobs,
  });
  const after = await getQueueBacklogSummary();
  const response = json({ ok: true, ...result, queue: { before, after } });
  await recordApiMetric({
    routeKey: "api.jobs.worker",
    statusCode,
    durationMs: Date.now() - startedAt,
    ok,
  });
  return response;
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
