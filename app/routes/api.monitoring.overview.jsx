import { buildMonitoringOverview } from "../utils/monitoring.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function getOpsKey() {
  return process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "";
}

function authorized(request) {
  const expected = getOpsKey();
  if (!expected) return { ok: false, reason: "JOB_WORKER_KEY or CONNECTOR_CRON_KEY is not set" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (!provided || provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function run(request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });
  }

  const url = new URL(request.url);
  const windowMinutes = Math.max(5, Math.min(24 * 60, Number(url.searchParams.get("windowMinutes") || 60)));
  const syncDays = Math.max(1, Math.min(90, Number(url.searchParams.get("syncDays") || 7)));
  const overview = await buildMonitoringOverview({ windowMinutes, syncDays });

  return json({
    ok: true,
    ...overview,
  });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
