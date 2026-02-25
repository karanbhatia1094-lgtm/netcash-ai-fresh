import { authenticate } from "../shopify.server";
import { prisma } from "../utils/db.server";
import { getOwnerRollupOverview } from "../utils/owner-rollups.server";
import { getFeatureUsageSummary } from "../utils/feature-usage.server";
import { getBillingSnapshotSummary } from "../utils/billing-snapshots.server";
import { getOwnerLifecycleSummary } from "../utils/owner-lifecycle.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function isOwnerShop(shop) {
  const allowed = String(process.env.OWNER_SHOPS || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(shop || "").toLowerCase());
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  if (!isOwnerShop(session.shop)) {
    return json({ ok: false, error: "Owner access required" }, { status: 403 });
  }
  const url = new URL(request.url);
  const days = Math.max(7, Math.min(90, Number(url.searchParams.get("days") || 30)));
  const format = String(url.searchParams.get("format") || "json").toLowerCase();
  const usage = await getFeatureUsageSummary({ days, maxShops: 500, maxFeatures: 1000 });
  const billing = await getBillingSnapshotSummary(60);
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
      })),
    };
  });
  const summary = await getOwnerLifecycleSummary({
    prisma,
    stores: rollup.stores || [],
    featureUsage: usage,
    billingSummary: billing,
    activeWindowDays: days,
  });
  if (format === "csv") {
    const stamp = new Date().toISOString().slice(0, 10);
    const lifecycleByShop = [];
    const downloaded = new Set(summary?.shops?.downloaded || []);
    const active = new Set(summary?.shops?.active || []);
    const churned = new Set(summary?.shops?.churned || []);
    for (const shop of downloaded) {
      let status = "downloaded";
      if (active.has(shop)) status = "active";
      else if (churned.has(shop)) status = "churned";
      lifecycleByShop.push([shop, status]);
    }
    const csv = toCsv([
      ["shop", "status"],
      ...lifecycleByShop.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [],
      ["metric", "value"],
      ["downloaded_brands", summary.downloadedBrands],
      ["currently_using_brands", summary.currentlyUsingBrands],
      ["active_brands", summary.activeBrands],
      ["churned_brands", summary.churnedBrands],
      ["active_window_days", summary.activeWindowDays],
    ]);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="owner_lifecycle_${days}d_${stamp}.csv"`,
      },
    });
  }
  return json({ ok: true, ...summary });
}
