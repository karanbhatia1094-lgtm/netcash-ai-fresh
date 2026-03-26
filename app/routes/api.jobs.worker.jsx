import { getQueueBacklogSummary, processQueueBatch } from "../utils/job-queue.server";
import { recordApiMetric } from "../utils/api-metrics.server";
import { jobHandlers } from "../utils/job-handlers.server";

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
    handlers: jobHandlers,
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
