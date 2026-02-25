import { authenticate } from "../shopify.server";
import { getDataQualitySummary, listConnectorCredentials, prisma } from "../utils/db.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [orderCount, connectors, quality] = await Promise.all([
    prisma.netCashOrder.count({ where: { shop } }),
    listConnectorCredentials(shop),
    getDataQualitySummary(shop, 30),
  ]);
  const connectedPullConnectors = (connectors || []).filter((row) => !!row.accessToken).length;
  const mappedPct = Number(quality?.totals?.mappedOrdersPct || 0);
  const firstValueScore = Math.max(0, Math.min(100, Math.round(
    mappedPct * 0.6 + (orderCount > 0 ? 20 : 0) + (connectedPullConnectors > 0 ? 20 : 0),
  )));

  return json({
    ok: true,
    shop,
    firstValueScore,
    checks: [
      { key: "orders_synced", pass: orderCount > 0 },
      { key: "connector_connected", pass: connectedPullConnectors > 0 },
      { key: "mapped_orders_quality", pass: mappedPct >= 80 },
    ],
    metrics: {
      orderCount,
      connectedPullConnectors,
      mappedOrdersPct: mappedPct,
    },
  });
}
