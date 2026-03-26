import { Link, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { getOrders, getSourceMetrics, listConnectorCredentials } from "../utils/db.server";

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function money(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

function normalizeSource(value) {
  return String(value || "direct").trim().toLowerCase() || "direct";
}

function dayName(dateLike) {
  return new Date(dateLike).toLocaleDateString("en-US", { weekday: "short" });
}

function hourLabel(hour) {
  const h = Number(hour);
  const suffix = h >= 12 ? "PM" : "AM";
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base}:00 ${suffix}`;
}

function getTopBuckets(map, limit = 3) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function buildUtmAndSourceQuality(orders) {
  const total = orders.length || 0;
  let anyUtm = 0;
  let fullUtm = 0;
  let clickId = 0;
  let mappedNetCash = 0;
  let totalNetCash = 0;
  const sourceCampaignMap = new Map();
  const sourceQuality = new Map();

  for (const order of orders) {
    const netCash = Number(order.netCash || 0);
    totalNetCash += netCash;
    const hasAny = !!(order.utmSource || order.utmMedium || order.utmCampaign || order.campaignId || order.campaignName);
    const hasFull = !!(order.utmSource && order.utmMedium && order.utmCampaign);
    if (hasAny) {
      anyUtm += 1;
      mappedNetCash += netCash;
    }
    if (hasFull) fullUtm += 1;
    if (order.clickId) clickId += 1;

    const source = normalizeSource(order.utmSource || order.marketingSource);
    const campaign = order.utmCampaign || order.campaignName || order.campaignId || "unmapped";
    const key = `${source}|||${campaign}`;
    sourceCampaignMap.set(key, (sourceCampaignMap.get(key) || 0) + 1);

    if (!sourceQuality.has(source)) {
      sourceQuality.set(source, { source, orders: 0, any: 0, full: 0, click: 0, netCash: 0 });
    }
    const row = sourceQuality.get(source);
    row.orders += 1;
    row.netCash += netCash;
    if (hasAny) row.any += 1;
    if (hasFull) row.full += 1;
    if (order.clickId) row.click += 1;
  }

  const topSourceCampaigns = [...sourceCampaignMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, orderCount]) => {
      const [source, campaign] = key.split("|||");
      return { source, campaign, orderCount };
    });

  const qualityRows = [...sourceQuality.values()]
    .map((row) => ({
      ...row,
      anyPct: row.orders > 0 ? (row.any / row.orders) * 100 : 0,
      fullPct: row.orders > 0 ? (row.full / row.orders) * 100 : 0,
      clickPct: row.orders > 0 ? (row.click / row.orders) * 100 : 0,
    }))
    .sort((a, b) => b.orders - a.orders);

  return {
    total,
    anyUtm,
    fullUtm,
    clickId,
    unmappedOrders: Math.max(0, total - anyUtm),
    mappedNetCash,
    totalNetCash,
    mappedNetCashPct: totalNetCash > 0 ? (mappedNetCash / totalNetCash) * 100 : 0,
    anyUtmPct: total > 0 ? (anyUtm / total) * 100 : 0,
    fullUtmPct: total > 0 ? (fullUtm / total) * 100 : 0,
    clickIdPct: total > 0 ? (clickId / total) * 100 : 0,
    topSourceCampaigns,
    qualityRows,
  };
}

function buildBehaviorInsights(orders) {
  const paidSources = new Set(["meta", "facebook", "instagram", "google", "youtube", "tiktok", "bing", "affiliate"]);
  const crmSources = new Set(["whatsapp", "sms", "email", "rcs", "moengage", "webengage", "clevertap", "kwikengage", "bitespeed", "bikai", "nitro", "wati", "spur"]);
  const hourMap = new Map();
  const paidHourMap = new Map();
  const crmHourMap = new Map();
  const dayMap = new Map();
  const customerOrders = new Map();

  for (const order of orders) {
    const orderDate = new Date(order.createdAt);
    if (Number.isNaN(orderDate.getTime())) continue;
    const hour = orderDate.getHours();
    const source = normalizeSource(order.marketingSource);
    const customerKey = String(order.customerEmail || order.customerPhone || order.customerName || "").trim().toLowerCase();

    hourMap.set(hour, (hourMap.get(hour) || 0) + 1);
    const day = dayName(orderDate);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);

    if (paidSources.has(source)) paidHourMap.set(hour, (paidHourMap.get(hour) || 0) + 1);
    if (crmSources.has(source)) crmHourMap.set(hour, (crmHourMap.get(hour) || 0) + 1);

    if (!customerKey) continue;
    if (!customerOrders.has(customerKey)) customerOrders.set(customerKey, []);
    customerOrders.get(customerKey).push(orderDate);
  }

  const repeatCadenceDays = [];
  let lastRepeatOrderAt = null;
  for (const rows of customerOrders.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.getTime() - b.getTime());
    const latest = rows[rows.length - 1];
    if (!lastRepeatOrderAt || latest > lastRepeatOrderAt) lastRepeatOrderAt = latest;
    for (let i = 1; i < rows.length; i += 1) {
      const daysGap = (rows[i].getTime() - rows[i - 1].getTime()) / (24 * 60 * 60 * 1000);
      if (Number.isFinite(daysGap) && daysGap > 0) repeatCadenceDays.push(daysGap);
    }
  }

  repeatCadenceDays.sort((a, b) => a - b);
  const p25 = quantile(repeatCadenceDays, 0.25);
  const p50 = quantile(repeatCadenceDays, 0.5);
  const p75 = quantile(repeatCadenceDays, 0.75);

  const nextWindowFrom = p25 && lastRepeatOrderAt
    ? new Date(lastRepeatOrderAt.getTime() + p25 * 24 * 60 * 60 * 1000)
    : null;
  const nextWindowTo = p75 && lastRepeatOrderAt
    ? new Date(lastRepeatOrderAt.getTime() + p75 * 24 * 60 * 60 * 1000)
    : null;

  const topHours = getTopBuckets(hourMap, 4).map((row) => ({ ...row, label: hourLabel(row.key) }));
  const bestPaidHour = getTopBuckets(paidHourMap, 1)[0] || null;
  const bestCrmHour = getTopBuckets(crmHourMap, 1)[0] || null;
  const bestDays = getTopBuckets(dayMap, 4);

  return {
    topHours,
    bestPaidHour: bestPaidHour ? { ...bestPaidHour, label: hourLabel(bestPaidHour.key) } : null,
    bestCrmHour: bestCrmHour ? { ...bestCrmHour, label: hourLabel(bestCrmHour.key) } : null,
    bestDays,
    repeatP25: p25,
    medianCadenceDays: p50,
    repeatP75: p75,
    nextWindowFrom,
    nextWindowTo,
  };
}

function buildRecommendations(utm, behavior, connectorsCount, spend30) {
  const items = [];
  if (utm.anyUtmPct < 70) {
    items.push("Standardize UTM naming across all paid and CRM channels to improve attribution coverage.");
  }
  if (utm.clickIdPct < 40) {
    items.push("Capture click IDs (gclid/fbclid) on landing pages and pass through checkout metadata.");
  }
  if (utm.unmappedOrders > 0) {
    items.push(`Prioritize fixing ${utm.unmappedOrders} unattributed orders to reduce blind spend decisions.`);
  }
  if (behavior.bestPaidHour?.label) {
    items.push(`Shift paid budget peaks closer to ${behavior.bestPaidHour.label} to match conversion behavior.`);
  }
  if (behavior.bestCrmHour?.label) {
    items.push(`Schedule CRM pushes around ${behavior.bestCrmHour.label} for higher message-to-order efficiency.`);
  }
  if (behavior.medianCadenceDays) {
    items.push(`Create a repeat-purchase automation around day ${Math.round(behavior.medianCadenceDays)}.`);
  }
  if (connectorsCount < 2) {
    items.push("Connect both Meta and Google to improve spend and campaign intelligence completeness.");
  }
  if (spend30 <= 0) {
    items.push("Add recent ad spend to unlock ROAS and spend-efficiency insights on this page.");
  }
  return items.slice(0, 6);
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [orders90, orders365, spend30, connectors] = await Promise.all([
    getOrders(shop, 90),
    getOrders(shop, 365),
    getSourceMetrics(30),
    listConnectorCredentials(shop),
  ]);

  const utm = buildUtmAndSourceQuality(orders90);
  const behavior = buildBehaviorInsights(orders365);
  const spend30Total = (spend30 || []).reduce((sum, row) => sum + Number(row.adSpend || 0), 0);
  const paidConnectors = (connectors || []).filter((row) => ["meta_ads", "google_ads"].includes(row.provider) && row.accessToken).length;
  const recommendations = buildRecommendations(utm, behavior, paidConnectors, spend30Total);

  return {
    shop,
    utm,
    behavior,
    spend30Total,
    paidConnectors,
    recommendations,
  };
}

export default function IntelligenceStudioPage() {
  const { shop, utm, behavior, paidConnectors, recommendations, spend30Total } = useLoaderData();

  return (
    <div className="nc-shell">
      <h1>Intelligence Studio</h1>
      <p className="nc-subtitle">UTM quality, behavior timing, repeat windows, and action-ready recommendations for {shop}.</p>
      <div className="nc-toolbar nc-section nc-quick-actions" style={{ marginBottom: 0 }}>
        <Link to="/app/intelligence#utm-quality" className="nc-chip">UTM quality</Link>
        <Link to="/app/intelligence#behavior-timing" className="nc-chip">Behavior timing</Link>
        <Link to="/app/campaigns" className="nc-chip">Apply to campaigns</Link>
      </div>
      <div className="nc-card nc-section nc-first-value">
        <div className="nc-section-head-inline">
          <h3 style={{ margin: 0 }}>First‑value flow</h3>
          <a className="nc-help-link" href="/app/campaigns">Why this helps</a>
        </div>
        <ol className="nc-step-list">
          <li>
            <strong>Fix attribution gaps</strong>
            <span>Start with unmapped orders and low UTM coverage.</span>
            <a className="nc-chip" href="#utm-quality">View gaps</a>
          </li>
          <li>
            <strong>Pick timing window</strong>
            <span>Use top hours to schedule pushes.</span>
            <a className="nc-chip" href="#behavior-timing">Open timing</a>
          </li>
          <li>
            <strong>Action recommendations</strong>
            <span>Apply next actions in Campaigns.</span>
            <Link to="/app/campaigns" className="nc-chip">Go to campaigns</Link>
          </li>
        </ol>
      </div>
      <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h3 style={{ margin: 0 }}>Suggested questions</h3>
          <span className="nc-note">Use these to guide your review</span>
        </div>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <span className="nc-chip">Where are UTMs missing?</span>
          <span className="nc-chip">Which hours convert best?</span>
          <span className="nc-chip">Which sources need click IDs?</span>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass" id="utm-quality">
        <h2>Attribution Quality</h2>
        <div className="nc-kpi-grid">
          <div className="nc-kpi-card"><div className="nc-muted">Orders with Any UTM</div><div className="nc-kpi-value">{utm.anyUtm} ({pct(utm.anyUtmPct)})</div></div>
          <div className="nc-kpi-card"><div className="nc-muted">Full UTM Coverage</div><div className="nc-kpi-value">{utm.fullUtm} ({pct(utm.fullUtmPct)})</div></div>
          <div className="nc-kpi-card"><div className="nc-muted">Click ID Captured</div><div className="nc-kpi-value">{utm.clickId} ({pct(utm.clickIdPct)})</div></div>
          <div className="nc-kpi-card"><div className="nc-muted">Unmapped Orders</div><div className="nc-kpi-value">{utm.unmappedOrders}</div></div>
        </div>
        <div className="nc-grid-4" style={{ marginTop: "12px" }}>
          <div className="nc-soft-box"><strong>Mapped Net Cash</strong><p style={{ marginBottom: 0 }}>{money(utm.mappedNetCash)} ({pct(utm.mappedNetCashPct)})</p></div>
          <div className="nc-soft-box"><strong>Total Net Cash (90d)</strong><p style={{ marginBottom: 0 }}>{money(utm.totalNetCash)}</p></div>
          <div className="nc-soft-box"><strong>Paid Connectors Active</strong><p style={{ marginBottom: 0 }}>{paidConnectors} / 2</p></div>
          <div className="nc-soft-box"><strong>Ad Spend (30d)</strong><p style={{ marginBottom: 0 }}>{money(spend30Total)}</p></div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Top UTM Source/Campaign Pairs</h2>
        <table className="nc-table-card">
          <thead><tr><th style={{ textAlign: "left" }}>UTM Source</th><th style={{ textAlign: "left" }}>UTM Campaign</th><th style={{ textAlign: "right" }}>Orders</th></tr></thead>
          <tbody>
            {(utm.topSourceCampaigns || []).length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <div className="nc-empty-block">
                    No UTM-tagged campaign data yet.
                  </div>
                </td>
              </tr>
            ) : (
              utm.topSourceCampaigns.map((row, idx) => (
                <tr key={`utm-top-${idx}-${row.source}-${row.campaign}`}>
                  <td data-label="UTM Source" style={{ textTransform: "capitalize" }}>{row.source}</td>
                  <td data-label="UTM Campaign">{row.campaign}</td>
                  <td data-label="Orders" style={{ textAlign: "right" }}>{row.orderCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Source Data Quality</h2>
        <table className="nc-table-card">
          <thead><tr><th style={{ textAlign: "left" }}>Source</th><th style={{ textAlign: "right" }}>Orders</th><th style={{ textAlign: "right" }}>Any UTM</th><th style={{ textAlign: "right" }}>Full UTM</th><th style={{ textAlign: "right" }}>Click ID</th><th style={{ textAlign: "right" }}>Net Cash</th></tr></thead>
          <tbody>
            {(utm.qualityRows || []).length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="nc-empty-block">
                    No source quality data yet.
                  </div>
                </td>
              </tr>
            ) : (
              utm.qualityRows.map((row) => (
                <tr key={`src-q-${row.source}`}>
                  <td data-label="Source" style={{ textTransform: "capitalize" }}>{row.source}</td>
                  <td data-label="Orders" style={{ textAlign: "right" }}>{row.orders}</td>
                  <td data-label="Any UTM" style={{ textAlign: "right" }}>{pct(row.anyPct)}</td>
                  <td data-label="Full UTM" style={{ textAlign: "right" }}>{pct(row.fullPct)}</td>
                  <td data-label="Click ID" style={{ textAlign: "right" }}>{pct(row.clickPct)}</td>
                  <td data-label="Net Cash" style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section nc-glass" id="behavior-timing">
        <h2>Behavior & Timing Intelligence</h2>
        <div className="nc-grid-4">
          <div className="nc-soft-box"><strong>Best Paid Ad Conversion Hour</strong><p style={{ marginBottom: 0 }}>{behavior.bestPaidHour?.label || "Not enough data"}</p></div>
          <div className="nc-soft-box"><strong>Best CRM Message Hour</strong><p style={{ marginBottom: 0 }}>{behavior.bestCrmHour?.label || "Not enough data"}</p></div>
          <div className="nc-soft-box"><strong>Top Conversion Days</strong><p style={{ marginBottom: 0 }}>{(behavior.bestDays || []).map((d) => d.key).join(", ") || "Not enough data"}</p></div>
          <div className="nc-soft-box"><strong>Median Repeat Purchase Gap</strong><p style={{ marginBottom: 0 }}>{behavior.medianCadenceDays ? `${behavior.medianCadenceDays.toFixed(1)} days` : "Not enough repeat data"}</p></div>
        </div>
        <div className="nc-grid-4" style={{ marginTop: "12px" }}>
          <div className="nc-soft-box"><strong>Repeat Window P25</strong><p style={{ marginBottom: 0 }}>{behavior.repeatP25 ? `${behavior.repeatP25.toFixed(1)} days` : "-"}</p></div>
          <div className="nc-soft-box"><strong>Repeat Window P75</strong><p style={{ marginBottom: 0 }}>{behavior.repeatP75 ? `${behavior.repeatP75.toFixed(1)} days` : "-"}</p></div>
          <div className="nc-soft-box"><strong>Next Repeat Window</strong><p style={{ marginBottom: 0 }}>
            {behavior.nextWindowFrom && behavior.nextWindowTo
              ? `${new Date(behavior.nextWindowFrom).toLocaleDateString()} - ${new Date(behavior.nextWindowTo).toLocaleDateString()}`
              : "Not enough repeat data"}
          </p></div>
          <div className="nc-soft-box"><strong>Top Active Hours</strong><p style={{ marginBottom: 0 }}>{(behavior.topHours || []).map((h) => h.label).join(", ") || "-"}</p></div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Recommended Next Actions</h2>
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {(recommendations || []).length === 0 ? (
            <li>Data quality looks healthy. Focus on campaign optimization and incremental testing.</li>
          ) : recommendations.map((row, idx) => <li key={`rec-${idx}`}>{row}</li>)}
        </ul>
        <div className="nc-toolbar" style={{ marginTop: "12px", marginBottom: 0 }}>
          <Link to="/app/campaigns" className="nc-chip">Review Campaigns</Link>
          <Link to="/app/alerts" className="nc-chip">Review Alerts</Link>
          <Link to="/app/integrations?wizard=1" className="nc-chip">Setup Sources</Link>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : String(error?.message || "Something went wrong while loading Intelligence Studio.");
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Intelligence Studio unavailable</h2>
        <p className="nc-note">{message}</p>
        <Link className="nc-chip" to="/app/intelligence">Reload</Link>
      </div>
    </div>
  );
}
