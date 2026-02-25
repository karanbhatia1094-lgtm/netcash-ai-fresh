import { prisma, listAllConnectorCredentials } from "../utils/db.server";
import { dispatchMonitoringAlert } from "../utils/alert-dispatch.server";
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

async function runHealthCron(request) {
  const startedAt = Date.now();
  let statusCode = 200;
  let ok = true;
  const cronKey = String(process.env.INTEGRATION_HEALTH_CRON_KEY || process.env.CONNECTOR_CRON_KEY || "").trim();
  if (!cronKey) {
    statusCode = 500;
    ok = false;
    await recordApiMetric({ routeKey: "api.integrations.health.cron", statusCode, durationMs: Date.now() - startedAt, ok });
    return json({ ok: false, error: "INTEGRATION_HEALTH_CRON_KEY not configured." }, { status: statusCode });
  }
  const provided = String(request.headers.get("x-netcash-cron-key") || "").trim();
  if (!provided || provided !== cronKey) {
    statusCode = 401;
    ok = false;
    await recordApiMetric({ routeKey: "api.integrations.health.cron", statusCode, durationMs: Date.now() - startedAt, ok });
    return json({ ok: false, error: "Unauthorized" }, { status: statusCode });
  }

  const credentials = await listAllConnectorCredentials(["meta_ads", "google_ads"]);
  const destinations = await prisma.activationDestination.findMany({
    where: { isActive: true },
    select: { id: true, shop: true, endpointUrl: true, lastStatus: true, updatedAt: true },
  });

  const soonMs = Number(process.env.CONNECTOR_TOKEN_EXPIRY_WARNING_HOURS || 72) * 60 * 60 * 1000;
  const now = Date.now();
  const tokenWarnings = [];
  for (const row of credentials || []) {
    const expiresAt = row?.expiresAt ? new Date(row.expiresAt).getTime() : null;
    if (expiresAt && expiresAt <= now + soonMs) {
      tokenWarnings.push({
        shop: row.shop,
        provider: row.provider,
        expiresAt: row.expiresAt,
      });
    }
  }

  const destinationWarnings = (destinations || []).filter((row) =>
    String(row.lastStatus || "").toLowerCase().includes("fail")
    || String(row.lastStatus || "").toLowerCase().includes("error"));

  const alerts = [];
  if (tokenWarnings.length > 0) {
    alerts.push({
      category: "integration_health",
      level: "warning",
      title: "Connector token expiry risk",
      body: `${tokenWarnings.length} connector tokens expiring soon.`,
      metadata: { tokenWarnings },
    });
  }
  if (destinationWarnings.length > 0) {
    alerts.push({
      category: "integration_health",
      level: "warning",
      title: "Activation destination failures detected",
      body: `${destinationWarnings.length} destination endpoints have failure status.`,
      metadata: { destinationWarnings: destinationWarnings.slice(0, 50) },
    });
  }
  for (const alert of alerts) {
    // eslint-disable-next-line no-await-in-loop
    await dispatchMonitoringAlert(alert).catch(() => null);
  }

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    connectorsChecked: credentials.length,
    destinationsChecked: destinations.length,
    tokenWarnings,
    destinationWarnings,
    alertsSent: alerts.length,
  };
  await recordApiMetric({ routeKey: "api.integrations.health.cron", statusCode, durationMs: Date.now() - startedAt, ok });
  return json(result);
}

export async function loader({ request }) {
  return runHealthCron(request);
}

export async function action({ request }) {
  return runHealthCron(request);
}
