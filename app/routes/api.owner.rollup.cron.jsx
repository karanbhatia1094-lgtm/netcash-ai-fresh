import { enqueueJob } from "../utils/job-queue.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function getCronKey() {
  return process.env.OWNER_CRON_KEY || process.env.CONNECTOR_CRON_KEY || process.env.JOB_WORKER_KEY || "";
}

function isAuthorized(request) {
  const expected = getCronKey();
  if (!expected) return { ok: false, reason: "OWNER_CRON_KEY or CONNECTOR_CRON_KEY or JOB_WORKER_KEY is required" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function run(request) {
  const auth = isAuthorized(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });

  const url = new URL(request.url);
  const daysBack = Math.max(1, Math.min(60, Number(url.searchParams.get("daysBack") || 7)));
  try {
    const job = await enqueueJob({
      type: "owner_rollup_refresh",
      payload: { daysBack },
      uniqueKey: "owner_rollup_refresh",
      maxAttempts: 3,
    });
    return json({ ok: true, job });
  } catch (error) {
    const message = String(error?.message || "Unknown error");
    const status = message.toLowerCase().includes("queue is busy") ? 429 : 500;
    return json({ ok: false, error: message }, { status });
  }
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
