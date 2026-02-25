import { enqueueJob } from "../utils/job-queue.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function runCron(request) {
  const key = process.env.REPORTS_CRON_KEY || process.env.CONNECTOR_CRON_KEY;
  if (!key) {
    return json({ ok: false, error: "REPORTS_CRON_KEY or CONNECTOR_CRON_KEY is required" }, { status: 500 });
  }

  const header = request.headers.get("x-netcash-cron-key") || "";
  if (header !== key) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const maxRuns = Number(url.searchParams.get("maxRuns") || 50);
  try {
    const job = await enqueueJob({
      type: "reports_run_due",
      payload: { maxRuns },
      uniqueKey: "reports_run_due",
      maxAttempts: 3,
    });
    return json({ ok: true, queued: true, job });
  } catch (error) {
    const message = String(error?.message || "Unknown error");
    const status = message.toLowerCase().includes("queue is busy") ? 429 : 500;
    return json({ ok: false, error: message }, { status });
  }
}

export async function loader({ request }) {
  return runCron(request);
}

export async function action({ request }) {
  return runCron(request);
}
