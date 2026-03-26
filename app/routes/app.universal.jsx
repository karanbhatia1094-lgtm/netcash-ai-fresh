import { Link, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useState } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { resolvePlanContext } from "../utils/plan.server";
import { getUniversalInsights } from "../utils/db.server";

function num(value, digits = 0) {
  return Number(value || 0).toFixed(digits);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function exportCsvFile(filename, rows) {
  if (typeof window === "undefined") return;
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = Math.max(30, Math.min(365, Number(url.searchParams.get("days") || 90)));
  const compare = String(url.searchParams.get("compare") || "") === "1";
  const planContext = await resolvePlanContext(
    billing,
    process.env.NODE_ENV !== "production",
    BILLING_PLANS,
    session.shop,
  );

  if (!planContext?.hasPremium) {
    return {
      days,
      compare,
      planContext,
      locked: true,
      insights: null,
      baselineDays: null,
      baseline: null,
    };
  }

  const insights = await getUniversalInsights(session.shop, days);
  const baselineDays = Math.max(30, Math.floor(days / 2));
  const baseline = compare ? await getUniversalInsights(session.shop, baselineDays) : null;
  return {
    days,
    compare,
    planContext,
    locked: false,
    insights,
    baselineDays,
    baseline,
  };
}

export default function UniversalInsightsPage() {
  const { days, locked, insights, compare, baselineDays, baseline } = useLoaderData();
  const [visibleHourRows, setVisibleHourRows] = useState(24);
  const [visibleSegmentRows, setVisibleSegmentRows] = useState(8);
  const dayQuery = (nextDays) => `?days=${nextDays}${compare ? "&compare=1" : ""}`;
  const compareQuery = compare ? `?days=${days}` : `?days=${days}&compare=1`;
  const baselinePurchases = Number(baseline?.totals?.purchases || 0);
  const baselineEvents = Number(baseline?.totals?.events || 0);
  const baselineRepeat = Number(baseline?.totals?.repeatCustomers || 0);
  const compareCards = compare ? [
    {
      key: "purchases",
      label: "Purchases vs baseline",
      value: baselinePurchases ? ((Number(insights?.totals?.purchases || 0) - baselinePurchases) / baselinePurchases) * 100 : 0,
    },
    {
      key: "events",
      label: "Events vs baseline",
      value: baselineEvents ? ((Number(insights?.totals?.events || 0) - baselineEvents) / baselineEvents) * 100 : 0,
    },
    {
      key: "repeat",
      label: "Repeat customers vs baseline",
      value: baselineRepeat ? ((Number(insights?.totals?.repeatCustomers || 0) - baselineRepeat) / baselineRepeat) * 100 : 0,
    },
  ] : [];
  const topSource = (insights?.topPurchaseSources || [])[0];
  const topPayment = (insights?.topPaymentMethods || [])[0];
  const topHandset = (insights?.topHandsets || [])[0];
  const whyChanged = [
    topSource ? `Top purchase source is ${topSource.name} (${topSource.count} purchases).` : "Source mix data is still building.",
    topPayment ? `Most buyers used ${topPayment.name}; tune checkout messaging around this payment method.` : "Payment mix is still building.",
    topHandset ? `Handset concentration is highest on ${topHandset.name}; prioritize creative QA for this device.` : "Handset split is still building.",
  ];
  const displayedHourRows = (insights?.purchaseByHour || []).slice(0, visibleHourRows);
  const hasMoreHourRows = (insights?.purchaseByHour || []).length > displayedHourRows.length;
  const displayedRfmRows = (insights?.rfmSegments || []).slice(0, visibleSegmentRows);
  const hasMoreRfmRows = (insights?.rfmSegments || []).length > displayedRfmRows.length;
  const displayedRecencyRows = (insights?.recencyBuckets || []).slice(0, visibleSegmentRows);
  const hasMoreRecencyRows = (insights?.recencyBuckets || []).length > displayedRecencyRows.length;
  const displayedOrderBandRows = (insights?.orderValueBands || []).slice(0, visibleSegmentRows);
  const hasMoreOrderBandRows = (insights?.orderValueBands || []).length > displayedOrderBandRows.length;

  if (locked) {
    return (
      <div className="nc-shell">
        <div className="nc-card nc-section nc-glass">
          <h1>Universal Insights</h1>
          <p className="nc-subtitle">Premium-only feature for cross-store customer behavior intelligence.</p>
          <ul style={{ marginTop: 0, paddingLeft: "18px" }}>
            <li>Cross-store identity stitching (privacy-safe hashed IDs)</li>
            <li>Purchase pattern by hour/day</li>
            <li>Payment method and coupon behavior</li>
            <li>Ad-view and message-open to purchase lag</li>
            <li>Device/OS/handset mix for buying customers</li>
          </ul>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Link to="/app/billing?manage=1" className="nc-chip">Upgrade to Premium</Link>
            <Link to="/app/integrations?wizard=1" className="nc-chip">Review Integration Hub</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nc-shell">
      <div className="nc-card nc-section nc-glass">
        <h1>Universal Insights</h1>
        <p className="nc-subtitle">Cross-store customer behavior graph for last {days} days.</p>
        <div className="nc-toolbar" style={{ marginBottom: "10px" }}>
          {[30, 60, 90, 180].map((option) => (
            <Link key={option} to={dayQuery(option)} className={`nc-chip ${days === option ? "is-active" : ""}`}>
              {option}d
            </Link>
          ))}
          <Link to={compareQuery} className={`nc-chip ${compare ? "is-active" : ""}`}>
            {compare ? "Disable Compare" : "Compare"}
          </Link>
        </div>
        {compare ? (
          <div className="nc-grid-4" style={{ marginBottom: "12px" }}>
            {compareCards.map((item) => (
              <div key={item.key} className="nc-soft-box">
                <strong>{item.label}</strong>
                <p className="nc-kpi-value">{num(item.value, 1)}%</p>
                <p className="nc-note">Compared to trailing {baselineDays}d baseline.</p>
              </div>
            ))}
          </div>
        ) : null}
        <div className="nc-grid-4">
          <div className="nc-soft-box"><strong title="All tracked behavioral and commerce events in this window.">Total Events</strong><p className="nc-kpi-value">{num(insights?.totals?.events)}</p></div>
          <div className="nc-soft-box"><strong title="Purchase events captured from connected stores.">Purchases</strong><p className="nc-kpi-value">{num(insights?.totals?.purchases)}</p></div>
          <div className="nc-soft-box"><strong title="Privacy-safe stitched identities across stores.">Unique Identities</strong><p className="nc-kpi-value">{num(insights?.totals?.uniqueIdentities)}</p></div>
          <div className="nc-soft-box"><strong title="Customers with more than one purchase event.">Repeat Customers</strong><p className="nc-kpi-value">{num(insights?.totals?.repeatCustomers)}</p></div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Why Changed</h2>
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {whyChanged.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
        <p className="nc-note" style={{ marginBottom: 0 }}>
          Drivers are generated from source, payment, and device concentration in the current window.
        </p>
      </div>

      <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Purchase Behavior</h2>
          <button
            type="button"
            className="nc-chip"
            onClick={() =>
              exportCsvFile("universal_purchase_behavior.csv", [
                ["Metric", "Value"],
                ["Avg Discount / Purchase", num(insights?.totals?.avgDiscountPerPurchase, 2)],
                ["iOS Buyer Share %", num(insights?.totals?.iosPct, 1)],
                ["Android Buyer Share %", num(insights?.totals?.androidPct, 1)],
                ["Ad to Purchase Avg Hours", num(insights?.lagHours?.adToPurchaseAvg, 1)],
                ["Message to Purchase Avg Hours", num(insights?.lagHours?.messageToPurchaseAvg, 1)],
              ])
            }
          >
            Export CSV
          </button>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Avg Discount / Purchase</strong>
            <p className="nc-kpi-value">INR {num(insights?.totals?.avgDiscountPerPurchase, 2)}</p>
          </div>
          <div className="nc-soft-box">
            <strong>iOS Buyer Share</strong>
            <p className="nc-kpi-value">{num(insights?.totals?.iosPct, 1)}%</p>
          </div>
          <div className="nc-soft-box">
            <strong>Android Buyer Share</strong>
            <p className="nc-kpi-value">{num(insights?.totals?.androidPct, 1)}%</p>
          </div>
          <div className="nc-soft-box">
            <strong>Time to Buy</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              Ad to purchase: {num(insights?.lagHours?.adToPurchaseAvg, 1)}h
              <br />
              Message to purchase: {num(insights?.lagHours?.messageToPurchaseAvg, 1)}h
            </p>
          </div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Top Payment and Coupon Patterns</h2>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Top Payment Methods</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(insights?.topPaymentMethods || []).slice(0, 6).map((row) => (
                <li key={`pay-${row.name}`}>{row.name} ({row.count})</li>
              ))}
              {(insights?.topPaymentMethods || []).length === 0 ? <li>No payment events yet</li> : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Top Coupons</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(insights?.topCoupons || []).slice(0, 6).map((row) => (
                <li key={`coupon-${row.name}`}>{row.name} ({row.count})</li>
              ))}
              {(insights?.topCoupons || []).length === 0 ? <li>No coupon usage yet</li> : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Top Handsets</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(insights?.topHandsets || []).slice(0, 6).map((row) => (
                <li key={`handset-${row.name}`}>{row.name} ({row.count})</li>
              ))}
              {(insights?.topHandsets || []).length === 0 ? <li>No handset data yet</li> : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Weekday Purchase Pattern</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(insights?.purchaseByWeekday || []).map((row) => (
                <li key={`weekday-${row.day}`}>{row.day}: {row.count}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Relatable Brand Datasets</h2>
          <button
            type="button"
            className="nc-chip"
            onClick={() =>
              exportCsvFile("universal_relatable_datasets.csv", [
                ["Metric", "Value"],
                ["COD Purchases", num(insights?.paymentMix?.codPurchases)],
                ["Prepaid Purchases", num(insights?.paymentMix?.prepaidPurchases)],
                ["COD %", num(insights?.paymentMix?.codPct, 1)],
                ["Prepaid %", num(insights?.paymentMix?.prepaidPct, 1)],
                ["Coupon Usage %", num(insights?.couponStats?.couponUsagePct, 1)],
                ["Avg Net With Coupon", num(insights?.couponStats?.avgNetWithCoupon, 2)],
                ["Avg Net Without Coupon", num(insights?.couponStats?.avgNetWithoutCoupon, 2)],
                ["Avg Discount With Coupon", num(insights?.couponStats?.avgDiscountWithCoupon, 2)],
                ["Purchases After Message <=24h", num(insights?.engagementConversion?.purchasesAfterMessage24h)],
                ["Purchases After Ad <=24h", num(insights?.engagementConversion?.purchasesAfterAd24h)],
                ["Purchases After Any Signal <=24h", num(insights?.engagementConversion?.purchasesAfterAnySignal24h)],
                ...((insights?.topPurchaseSources || []).map((row) => [`Top Source: ${row.name}`, row.count])),
              ])
            }
          >
            Export CSV
          </button>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Payment Mix</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              COD: {num(insights?.paymentMix?.codPct, 1)}% ({num(insights?.paymentMix?.codPurchases)})
              <br />
              Prepaid: {num(insights?.paymentMix?.prepaidPct, 1)}% ({num(insights?.paymentMix?.prepaidPurchases)})
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Coupon Sensitivity</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              Coupon usage: {num(insights?.couponStats?.couponUsagePct, 1)}%
              <br />
              Avg net with coupon: INR {num(insights?.couponStats?.avgNetWithCoupon, 2)}
              <br />
              Avg net without coupon: INR {num(insights?.couponStats?.avgNetWithoutCoupon, 2)}
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Signal to Purchase (24h)</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              After message open: {num(insights?.engagementConversion?.purchasesAfterMessage24h)}
              <br />
              After ad view: {num(insights?.engagementConversion?.purchasesAfterAd24h)}
              <br />
              After any signal: {num(insights?.engagementConversion?.purchasesAfterAnySignal24h)}
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Top Purchase Sources</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(insights?.topPurchaseSources || []).slice(0, 6).map((row) => (
                <li key={`src-${row.name}`}>{row.name} ({row.count})</li>
              ))}
              {(insights?.topPurchaseSources || []).length === 0 ? <li>No source data yet</li> : null}
            </ul>
          </div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass" id="customer-segments">
        <div className="nc-section-head-inline">
          <h2>Customer Segments (RFM + Recency)</h2>
          <button
            type="button"
            className="nc-chip"
            onClick={() =>
              exportCsvFile("universal_customer_segments.csv", [
                ["Segment Type", "Label", "Count"],
                ...((insights?.rfmSegments || []).map((row) => ["RFM", row.segment, row.count])),
                ...((insights?.recencyBuckets || []).map((row) => ["Recency", row.bucket, row.count])),
                ...((insights?.orderValueBands || []).map((row) => ["Order Value Band", row.band, row.count])),
              ])
            }
          >
            Export CSV
          </button>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>RFM Segments</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {displayedRfmRows.map((row) => (
                <li key={`rfm-${row.segment}`}>{row.segment}: {row.count}</li>
              ))}
              {hasMoreRfmRows ? (
                <li><button type="button" className="nc-chip" onClick={() => setVisibleSegmentRows((current) => current + 8)}>Load more</button></li>
              ) : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Recency Buckets</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {displayedRecencyRows.map((row) => (
                <li key={`rec-${row.bucket}`}>{row.bucket}: {row.count}</li>
              ))}
              {hasMoreRecencyRows ? (
                <li><button type="button" className="nc-chip" onClick={() => setVisibleSegmentRows((current) => current + 8)}>Load more</button></li>
              ) : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Order Value Bands</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {displayedOrderBandRows.map((row) => (
                <li key={`aov-${row.band}`}>{row.band}: {row.count}</li>
              ))}
              {hasMoreOrderBandRows ? (
                <li><button type="button" className="nc-chip" onClick={() => setVisibleSegmentRows((current) => current + 8)}>Load more</button></li>
              ) : null}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Action Hint</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              Use segments to run:
              <br />
              Champions: upsell/high-LTV creatives
              <br />
              At-Risk/Hibernating: winback messages by preferred channel
            </p>
            <div className="nc-toolbar" style={{ marginBottom: 0, marginTop: "8px" }}>
              <a className="nc-chip" href="/app/campaigns?source=all">Build champion campaign</a>
              <a className="nc-chip" href="/app/alerts?severity=warning">Run winback playbook</a>
            </div>
          </div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Hour-of-Day Pattern</h2>
          <button
            type="button"
            className="nc-chip"
            onClick={() =>
              exportCsvFile(
                "universal_hourly_pattern.csv",
                [
                  ["Hour", "Purchases", "Ad Views", "Message Opens"],
                  ...((insights?.purchaseByHour || []).map((row) => {
                    const ad = insights?.adViewsByHour?.find((x) => x.hour === row.hour)?.count || 0;
                    const msg = insights?.messageOpensByHour?.find((x) => x.hour === row.hour)?.count || 0;
                    return [String(row.hour).padStart(2, "0") + ":00", row.count, ad, msg];
                  })),
                ],
              )
            }
          >
            Export CSV
          </button>
        </div>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Hour</th>
              <th style={{ textAlign: "right" }}>Purchases</th>
              <th style={{ textAlign: "right" }}>Ad Views</th>
              <th style={{ textAlign: "right" }}>Message Opens</th>
            </tr>
          </thead>
          <tbody>
            {displayedHourRows.map((row) => {
              const ad = insights?.adViewsByHour?.find((x) => x.hour === row.hour)?.count || 0;
              const msg = insights?.messageOpensByHour?.find((x) => x.hour === row.hour)?.count || 0;
              return (
                <tr key={`hour-${row.hour}`}>
                  <td>{String(row.hour).padStart(2, "0")}:00</td>
                  <td style={{ textAlign: "right" }}>{row.count}</td>
                  <td style={{ textAlign: "right" }}>{ad}</td>
                  <td style={{ textAlign: "right" }}>{msg}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {hasMoreHourRows ? (
          <div className="nc-toolbar" style={{ marginTop: "10px", marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={() => setVisibleHourRows((current) => current + 24)}>
              Load 24 more hours
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : String(error?.message || "Something went wrong while loading Universal Insights.");
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Universal Insights unavailable</h2>
        <p className="nc-note">{message}</p>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href="/app">Back to Home</a>
          <a className="nc-chip" href="/app/billing?manage=1">Manage Plan</a>
        </div>
      </div>
    </div>
  );
}
