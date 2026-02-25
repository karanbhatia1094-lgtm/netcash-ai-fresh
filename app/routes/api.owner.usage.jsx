import { authenticate } from "../shopify.server";
import { getFeatureUsageSummary } from "../utils/feature-usage.server";

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
  const days = Math.max(1, Math.min(180, Number(url.searchParams.get("days") || 30)));
  const format = String(url.searchParams.get("format") || "json").toLowerCase();
  const type = String(url.searchParams.get("type") || "shops").toLowerCase();
  const summary = await getFeatureUsageSummary({ days, maxShops: 500, maxFeatures: 1000 });
  if (format === "csv") {
    const stamp = new Date().toISOString().slice(0, 10);
    if (type === "features") {
      const csv = toCsv([
        ["feature_key", "events", "shops"],
        ...(summary.byFeature || []).map((row) => [row.featureKey, row.events, row.shops]),
      ]);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="owner_usage_features_${days}d_${stamp}.csv"`,
        },
      });
    }
    if (type === "matrix") {
      const csv = toCsv([
        ["shop", "feature_key", "events", "last_seen_at"],
        ...(summary.byShopFeature || []).map((row) => [row.shop, row.featureKey, row.events, row.lastSeenAt]),
      ]);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="owner_usage_matrix_${days}d_${stamp}.csv"`,
        },
      });
    }
    const csv = toCsv([
      ["shop", "events", "distinct_features", "last_seen_at"],
      ...(summary.byShop || []).map((row) => [row.shop, row.events, row.distinctFeatures, row.lastSeenAt]),
    ]);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="owner_usage_shops_${days}d_${stamp}.csv"`,
      },
    });
  }
  return json({ ok: true, ...summary });
}
