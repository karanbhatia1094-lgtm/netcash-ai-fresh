import { json } from "@remix-run/node";
import { listConnectorCredentials, prisma } from "../utils/db.server";

function step(label, complete, hint = "") {
  return { label, complete, hint };
}

function unauthorized() {
  return json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export async function loader({ request }) {
  const key = process.env.REPORTS_CRON_KEY || process.env.CONNECTOR_CRON_KEY;
  if (!key) {
    return json(
      { ok: false, error: "REPORTS_CRON_KEY or CONNECTOR_CRON_KEY is required" },
      { status: 500 },
    );
  }

  const header = request.headers.get("x-netcash-cron-key") || "";
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key") || "";
  if (header !== key && queryKey !== key) return unauthorized();

  const shop = String(url.searchParams.get("shop") || "").trim();
  if (!shop) {
    return json({ ok: false, error: "Missing shop query param" }, { status: 400 });
  }

  const [orderCount, destinationCount, activeRulesCount, connectorCreds] = await Promise.all([
    prisma.netCashOrder.count({ where: { shop } }),
    prisma.activationDestination.count({ where: { shop } }),
    prisma.audienceSyncRule.count({ where: { shop, isActive: true } }),
    listConnectorCredentials(shop),
  ]);

  const connectedPullConnectors = (connectorCreds || []).filter((row) => !!row.accessToken).length;
  const steps = [
    step("Shop installed and authenticated", true),
    step("Order data synced", orderCount > 0, "Run initial sync to populate dashboard data"),
    step("At least one paid connector connected", connectedPullConnectors > 0, "Connect Meta/Google in settings"),
    step("At least one activation destination configured", destinationCount > 0, "Add webhook/Meta/Google destination"),
    step("At least one audience sync rule active", activeRulesCount > 0, "Create an audience rule in Campaigns page"),
  ];

  const completed = steps.filter((s) => s.complete).length;
  const progressPercent = Math.round((completed / steps.length) * 100);

  return json(
    {
      ok: true,
      shop,
      progressPercent,
      steps,
      metrics: {
        orderCount,
        connectedPullConnectors,
        destinationCount,
        activeRulesCount,
      },
      nextAction: steps.find((s) => !s.complete)?.hint || "Onboarding complete",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

