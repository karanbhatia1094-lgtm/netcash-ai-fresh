import { Link, useLoaderData, useRouteError, isRouteErrorResponse, useLocation, useNavigate } from "@remix-run/react";
import { useEffect, useState } from "react";
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
  const url = new URL(request.url);
  const rawSourcesParam = String(url.searchParams.get("sources") || "all");
  const selectedSources = rawSourcesParam
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const normalizedSelectedSources = selectedSources.length ? [...new Set(selectedSources)] : ["all"];
  const includeAllSources = normalizedSelectedSources.includes("all");
  const sourceFilterSet = new Set(normalizedSelectedSources.filter((row) => row !== "all"));
  const [orders90, orders365, spend30, connectors] = await Promise.all([
    getOrders(shop, 90),
    getOrders(shop, 365),
    getSourceMetrics(30),
    listConnectorCredentials(shop),
  ]);

  const sourceOfOrder = (order) => String(order?.marketingSource || order?.utmSource || "unknown").toLowerCase();
  const orders90Filtered = includeAllSources ? orders90 : (orders90 || []).filter((o) => sourceFilterSet.has(sourceOfOrder(o)));
  const orders365Filtered = includeAllSources ? orders365 : (orders365 || []).filter((o) => sourceFilterSet.has(sourceOfOrder(o)));
  const spend30Filtered = includeAllSources ? spend30 : (spend30 || []).filter((row) => sourceFilterSet.has(String(row.source || "").toLowerCase()));
  const utm = buildUtmAndSourceQuality(orders90Filtered);
  const behavior = buildBehaviorInsights(orders365Filtered);
  const spend30Total = (spend30Filtered || []).reduce((sum, row) => sum + Number(row.adSpend || 0), 0);
  const paidConnectors = (connectors || []).filter((row) => ["meta_ads", "google_ads"].includes(row.provider) && row.accessToken).length;
  const recommendations = buildRecommendations(utm, behavior, paidConnectors, spend30Total);

  return {
    shop,
    utm,
    behavior,
    spend30Total,
    paidConnectors,
    recommendations,
    selectedSources: normalizedSelectedSources,
    availableSources: [...new Set([
      ...(orders90 || []).map((row) => sourceOfOrder(row)),
      ...(spend30 || []).map((row) => String(row.source || "").toLowerCase()),
    ])].filter(Boolean).sort(),
  };
}

export default function IntelligenceStudioPage() {
  const { shop, utm, behavior, paidConnectors, recommendations, spend30Total, selectedSources: selectedSourcesFromLoader, availableSources } = useLoaderData();
  const [sourceSearch, setSourceSearch] = useState("");
  const [multiSourceOpen, setMultiSourceOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState(selectedSourcesFromLoader || ["all"]);
  const sourceOptions = [...new Set((availableSources || []).map((row) => String(row || "").toLowerCase()).filter(Boolean))].sort();
  const location = useLocation();
  const navigate = useNavigate();
  const isAllSources = selectedSources.includes("all");
  const updateSourcesInUrl = (nextSources) => {
    const params = new URLSearchParams(location.search);
    params.set("sources", (nextSources || ["all"]).join(","));
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };
  const toggleSource = (item) => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) return;
    if (normalized === "all") {
      setSelectedSources(["all"]);
      updateSourcesInUrl(["all"]);
      return;
    }
    const current = isAllSources ? [] : [...selectedSources];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((row) => row !== normalized) : [...current, normalized];
    const finalNext = next.length ? next : ["all"];
    setSelectedSources(finalNext);
    updateSourcesInUrl(finalNext);
  };
  const filteredSourceOptions = sourceOptions.filter((item) =>
    item.includes(String(sourceSearch || "").toLowerCase()));
  const singleSourceValue =
    isAllSources ? "all" : selectedSources.length === 1 ? selectedSources[0] : "custom";
  const displayTopSourceCampaigns = isAllSources
    ? (utm.topSourceCampaigns || [])
    : (utm.topSourceCampaigns || []).filter((row) => selectedSources.includes(String(row?.source || "").toLowerCase()));
  const displayQualityRows = isAllSources
    ? (utm.qualityRows || [])
    : (utm.qualityRows || []).filter((row) => selectedSources.includes(String(row?.source || "").toLowerCase()));

  useEffect(() => {
    setSelectedSources(selectedSourcesFromLoader || ["all"]);
  }, [selectedSourcesFromLoader]);

  return (
    <div className="nc-shell nc-intelligence">
      <h1>Intelligence Studio</h1>
      <p className="nc-subtitle">UTM quality, behavior timing, repeat windows, and action-ready recommendations for {shop}.</p>

      <div className="nc-card nc-section nc-glass">
        <h2>Source Filter</h2>
        <div className="nc-toolbar nc-filter-bar">
          <label className="nc-form-field nc-inline-field">
            <span>Source</span>
            <select
              value={singleSourceValue}
              onChange={(event) => {
                const next = String(event.target.value || "all");
                if (next === "custom") return;
                toggleSource(next);
              }}
            >
              <option value="all">All sources</option>
              {sourceOptions.map((item) => (
                <option key={`intel-src-${item}`} value={item}>
                  {String(item || "").replace(/_/g, " ")}
                </option>
              ))}
              {singleSourceValue === "custom" ? <option value="custom">Multiple selected</option> : null}
            </select>
          </label>
          <button
            type="button"
            className={`nc-chip ${multiSourceOpen ? "is-active" : ""}`}
            onClick={() => setMultiSourceOpen((current) => !current)}
          >
            {multiSourceOpen ? "Hide multi-select" : "Multi-select"}
          </button>
        </div>
        {multiSourceOpen ? (
          <div className="nc-source-picker-panel" style={{ marginTop: "8px" }}>
            <input
              type="search"
              value={sourceSearch}
              onChange={(event) => setSourceSearch(event.target.value)}
              placeholder="Search source"
              aria-label="Search sources"
            />
            <label className="nc-inline-field">
              <input
                type="checkbox"
                checked={isAllSources}
                onChange={() => toggleSource("all")}
              />
              <span>All</span>
            </label>
            {filteredSourceOptions.map((item) => (
              <label key={`intel-src-multi-${item}`} className="nc-inline-field">
                <input
                  type="checkbox"
                  checked={selectedSources.includes(item) && !isAllSources}
                  onChange={() => toggleSource(item)}
                />
                <span style={{ textTransform: "capitalize" }}>{item}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="nc-card nc-section nc-glass">
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
            {displayTopSourceCampaigns.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <div className="nc-empty-block">
                    No UTM-tagged campaign data yet.
                  </div>
                </td>
              </tr>
            ) : (
              displayTopSourceCampaigns.map((row, idx) => (
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
            {displayQualityRows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="nc-empty-block">
                    No source quality data yet.
                  </div>
                </td>
              </tr>
            ) : (
              displayQualityRows.map((row) => (
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

      <div className="nc-card nc-section nc-glass">
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
    <div className="nc-shell nc-intelligence">
      <div className="nc-card nc-section">
        <h2>Intelligence Studio unavailable</h2>
        <p className="nc-note">{message}</p>
        <Link className="nc-chip" to="/app/intelligence">Reload</Link>
      </div>
    </div>
  );
}
