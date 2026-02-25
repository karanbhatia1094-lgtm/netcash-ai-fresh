import { prisma } from "../utils/db.server";
import { getOwnerRollupOverview } from "../utils/owner-rollups.server";
import { getReleaseRuntime, evaluateReleaseContext } from "../utils/release-control.server";
import { getFeatureUsageSummary } from "../utils/feature-usage.server";
import { getDataQualitySummary } from "../utils/db.server";
import { buildOwnerInsights } from "../utils/owner-insights.server";
import { dispatchMonitoringAlert } from "../utils/alert-dispatch.server";

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
  return process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "";
}

function authorize(request) {
  const expected = getCronKey();
  if (!expected) return { ok: false, reason: "JOB_WORKER_KEY or CONNECTOR_CRON_KEY is required" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (!provided || provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function run(request) {
  const auth = authorize(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 30)));
  const shouldDispatch = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("dispatch") || "").toLowerCase());

  const rolloutRuntime = await getReleaseRuntime();
  const rollup = await getOwnerRollupOverview(30).catch(async () => {
    const groupedOrders = await prisma.netCashOrder.groupBy({
      by: ["shop"],
      _count: { _all: true },
      _sum: { grossValue: true, netCash: true },
      _max: { createdAt: true },
      orderBy: { shop: "asc" },
    });
    return {
      stores: groupedOrders.map((row) => ({
        shop: row.shop,
        orderCount: row._count?._all || 0,
        grossValue: row._sum?.grossValue || 0,
        netCash: row._sum?.netCash || 0,
        lastOrderAt: row._max?.createdAt || null,
        connectorCount: 0,
      })),
    };
  });

  const stores = (rollup.stores || []).map((row) => ({
    ...row,
    releaseChannel: evaluateReleaseContext(row.shop, rolloutRuntime).channel,
  }));

  const qualityRows = [];
  for (const row of stores.slice(0, 120)) {
    // eslint-disable-next-line no-await-in-loop
    const quality = await getDataQualitySummary(row.shop, 30).catch(() => ({ totals: {} }));
    qualityRows.push({
      shop: row.shop,
      status: "pass",
      checks: [],
      metrics: {
        mappedOrdersPct: Number(quality?.totals?.mappedOrdersPct || 0),
        invalidRows: Number(quality?.totals?.invalidRows || 0),
        missingSpendRows: Number(quality?.totals?.missingSpendRows || 0),
        syncLagMinutes: 0,
        queuePending: 0,
      },
    });
  }

  const featureUsage = await getFeatureUsageSummary({ days, maxShops: 300, maxFeatures: 300 });
  const ownerInsights = buildOwnerInsights({
    stores,
    pilotReadiness: { rows: qualityRows },
    featureUsage,
    rolloutSummary: {},
    billingShops: [],
  });

  const alerts = [];
  for (const row of ownerInsights.riskRows || []) {
    if (row.risk === "high") {
      alerts.push({
        severity: "warning",
        title: `High churn risk: ${row.shop}`,
        message: `Health ${row.score}, usage ${row.events}, mapped ${row.mappedOrdersPct.toFixed(1)}%, syncLag ${row.syncLagMinutes}m, queue ${row.queuePending}.`,
      });
    }
  }

  const dispatched = [];
  if (shouldDispatch) {
    for (const alert of alerts.slice(0, 50)) {
      // eslint-disable-next-line no-await-in-loop
      const sent = await dispatchMonitoringAlert({ category: "owner_risk", ...alert });
      dispatched.push({ title: alert.title, ok: !!sent?.ok, status: sent?.status || 0 });
    }
  }

  return json({
    ok: true,
    days,
    alerts,
    dispatched,
    counts: {
      highRiskShops: (ownerInsights.riskRows || []).filter((r) => r.risk === "high").length,
      totalAlerts: alerts.length,
    },
  });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
