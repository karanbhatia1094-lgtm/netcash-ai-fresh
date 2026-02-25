import { getOrders } from "./db.server";

function safeTouchpoints(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasSignal(order) {
  return Boolean(
    order?.utmSource ||
    order?.utmMedium ||
    order?.utmCampaign ||
    order?.clickId ||
    order?.landingSite ||
    order?.referringSite ||
    safeTouchpoints(order?.touchpointsJson).length > 0,
  );
}

export async function getStorefrontSignalDiagnostics(shop, days = 30) {
  const orders = await getOrders(shop, days);
  const totalOrders = orders.length;
  const signalOrders = orders.filter((order) => hasSignal(order));
  const clickIdOrders = orders.filter((order) => Boolean(order?.clickId));
  const fullUtmOrders = orders.filter((order) => Boolean(order?.utmSource && order?.utmMedium && order?.utmCampaign));
  const touchpointOrders = orders.filter((order) => safeTouchpoints(order?.touchpointsJson).length > 0);

  const signalBySource = new Map();
  for (const row of signalOrders) {
    const source = String(row?.marketingSource || row?.utmSource || "unknown").toLowerCase();
    signalBySource.set(source, (signalBySource.get(source) || 0) + 1);
  }
  const topSignalSources = [...signalBySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }));

  const latestSignalOrder = [...signalOrders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;

  return {
    windowDays: days,
    totalOrders,
    signalOrders: signalOrders.length,
    coveragePct: totalOrders > 0 ? (signalOrders.length / totalOrders) * 100 : 0,
    clickIdOrders: clickIdOrders.length,
    clickIdPct: totalOrders > 0 ? (clickIdOrders.length / totalOrders) * 100 : 0,
    fullUtmOrders: fullUtmOrders.length,
    fullUtmPct: totalOrders > 0 ? (fullUtmOrders.length / totalOrders) * 100 : 0,
    touchpointOrders: touchpointOrders.length,
    touchpointPct: totalOrders > 0 ? (touchpointOrders.length / totalOrders) * 100 : 0,
    topSignalSources,
    latestSignalOrder: latestSignalOrder
      ? {
          orderId: latestSignalOrder.orderId,
          orderNumber: latestSignalOrder.orderNumber,
          createdAt: latestSignalOrder.createdAt,
          marketingSource: latestSignalOrder.marketingSource,
          campaignId: latestSignalOrder.campaignId,
          campaignName: latestSignalOrder.campaignName,
          utmSource: latestSignalOrder.utmSource,
          utmMedium: latestSignalOrder.utmMedium,
          utmCampaign: latestSignalOrder.utmCampaign,
          clickId: latestSignalOrder.clickId,
          landingSite: latestSignalOrder.landingSite,
          referringSite: latestSignalOrder.referringSite,
          touchpointCount: safeTouchpoints(latestSignalOrder.touchpointsJson).length,
        }
      : null,
  };
}
