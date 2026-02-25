function toIsoDaysAgo(days) {
  return new Date(Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000).toISOString();
}

export async function getOwnerLifecycleSummary({
  prisma,
  stores = [],
  featureUsage = {},
  billingSummary = {},
  activeWindowDays = 30,
} = {}) {
  const activeSince = toIsoDaysAgo(activeWindowDays);
  const usageRows = featureUsage?.byShop || [];
  const billingRows = billingSummary?.byShop || [];

  const sessionRows = await prisma.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
  }).catch(() => []);

  const downloadedSet = new Set();
  for (const row of sessionRows || []) {
    const shop = String(row.shop || "").trim().toLowerCase();
    if (shop) downloadedSet.add(shop);
  }
  for (const row of stores || []) {
    const shop = String(row.shop || "").trim().toLowerCase();
    if (shop) downloadedSet.add(shop);
  }

  const activeSet = new Set();
  for (const row of usageRows) {
    if (Number(row?.events || 0) <= 0) continue;
    const shop = String(row?.shop || "").trim().toLowerCase();
    if (shop) activeSet.add(shop);
  }

  if (activeSet.size === 0) {
    for (const row of stores || []) {
      const shop = String(row.shop || "").trim().toLowerCase();
      const last = row.lastOrderAt ? new Date(row.lastOrderAt).toISOString() : "";
      if (shop && last && last >= activeSince) activeSet.add(shop);
    }
  }

  const billingByShop = new Map((billingRows || []).map((row) => [String(row.shop || "").toLowerCase(), row]));
  const churnedSet = new Set();
  for (const row of billingRows || []) {
    if (String(row.status || "").toLowerCase() === "churned") {
      const shop = String(row.shop || "").toLowerCase();
      if (shop) churnedSet.add(shop);
    }
  }

  for (const row of stores || []) {
    const shop = String(row.shop || "").toLowerCase();
    if (!shop) continue;
    if (activeSet.has(shop)) continue;
    const billing = billingByShop.get(shop);
    const hasHistory = Number(row.orderCount || 0) > 0 || !!billing;
    if (hasHistory) churnedSet.add(shop);
  }

  const downloadedBrands = downloadedSet.size;
  const activeBrands = activeSet.size;
  const currentlyUsingBrands = activeBrands;
  const churnedBrands = [...churnedSet].filter((shop) => downloadedSet.has(shop)).length;

  return {
    activeWindowDays: Math.max(1, Number(activeWindowDays) || 30),
    downloadedBrands,
    currentlyUsingBrands,
    activeBrands,
    churnedBrands,
    shops: {
      downloaded: [...downloadedSet].sort(),
      active: [...activeSet].sort(),
      churned: [...churnedSet].filter((shop) => downloadedSet.has(shop)).sort(),
    },
  };
}
