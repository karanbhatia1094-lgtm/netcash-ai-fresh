import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getDataQualitySummary, listConnectorCredentials, prisma } from "../utils/db.server";

function step(label, complete, hint = "") {
  return { label, complete, hint };
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

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
  const quality = await getDataQualitySummary(shop, 30);
  const mappedPct = Number(quality?.totals?.mappedOrdersPct || 0);
  const qualityScore = Math.max(0, Math.min(100, Math.round(
    (mappedPct * 0.6)
    + (Math.min(1, connectedPullConnectors > 0 ? 1 : 0) * 20)
    + (Math.min(1, orderCount > 0 ? 1 : 0) * 20),
  )));

  return json(
    {
      shop,
      progressPercent,
      firstValueScore: qualityScore,
      steps,
      metrics: {
        orderCount,
        connectedPullConnectors,
        destinationCount,
        activeRulesCount,
        mappedOrdersPct: mappedPct,
      },
      nextAction: steps.find((s) => !s.complete)?.hint || "Onboarding complete",
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
