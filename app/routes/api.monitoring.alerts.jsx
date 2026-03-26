import { buildMonitoringOverview } from "../utils/monitoring.server";
import { dispatchMonitoringAlert } from "../utils/alert-dispatch.server";
import { scheduleAutonomousRepairs } from "../utils/autonomous-ops.server";

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
  const force = String(url.searchParams.get("force") || "").toLowerCase() === "true";
  const autoRepairRequested = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("autoRepair") || "true").toLowerCase());
  const overview = await buildMonitoringOverview({ windowMinutes, syncDays });
  const autoRepairEnabled = String(process.env.AUTO_REPAIR_ENABLED || "true").toLowerCase() !== "false";
  let repair = null;
  if (autoRepairRequested && autoRepairEnabled) {
    repair = await scheduleAutonomousRepairs({ source: "monitoring_alerts" });
  }

  if (!overview.alerts.any && !force) {
    return json({ ok: true, sent: false, reason: "No active alerts", overview, repair });
  }

  const dispatch = await dispatchMonitoringAlert({
    title: "Netcash Monitoring Alert",
    overview,
  });
  return json({
    ok: dispatch.ok,
    sent: dispatch.ok,
    dispatch,
    overview,
    repair,
  }, { status: dispatch.ok ? 200 : 502 });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
