import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect, useState } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { trackUiEvent } from "../utils/telemetry.client";
import {
  createBudgetReallocationDecision,
  createCampaignActionItem,
  getBudgetReallocationSuggestions,
  getCampaignPerformance,
  getCampaignUserInsights,
  getCreativePerformanceScores,
  listCampaignActionItems,
  listBudgetReallocationDecisions,
  getRecentConnectorSyncRuns,
  updateCampaignActionStatus,
  listConnectorCredentials,
} from "../utils/db.server";
import { resolvePlanContext } from "../utils/plan.server";
import { listReportSchedules } from "../utils/report-scheduler.server";
import { isFeatureEnabledForShopAsync } from "../utils/release-control.server";

const DAY_OPTIONS = [7, 30, 90, 365];

function money(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

function rowSeverityFromCampaign(row) {
  const realRoas = Number(row?.realRoas || 0);
  const netCash = Number(row?.netCash || 0);
  if (netCash < 0 || realRoas < 0.75) return "high";
  if (realRoas < 1) return "medium";
  return "low";
}

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get("days") || 30);
  const days = DAY_OPTIONS.includes(requestedDays) ? requestedDays : 30;
  const multiSourceEnabled = await isFeatureEnabledForShopAsync(session.shop, "campaign_multi_source_filters", true);
  const rawSourcesParam = multiSourceEnabled ? url.searchParams.get("sources") : null;
  const rawSourceParam = url.searchParams.get("source");
  const selectedSources = (rawSourcesParam || rawSourceParam || "all")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const normalizedSelectedSources = selectedSources.length ? [...new Set(selectedSources)] : ["all"];
  const effectiveSources = multiSourceEnabled ? normalizedSelectedSources : [normalizedSelectedSources[0] || "all"];
  const data = await getCampaignPerformance(session.shop, days, effectiveSources);
  const sourceForDownstream = normalizedSelectedSources.length === 1 ? normalizedSelectedSources[0] : "all";
  const planContext = await resolvePlanContext(
    billing,
    process.env.NODE_ENV !== "production",
    BILLING_PLANS,
    session.shop,
  );
  const creativeScores = await getCreativePerformanceScores(session.shop, days, sourceForDownstream);
  const budgetSuggestions = await getBudgetReallocationSuggestions(session.shop, days);
  const campaignUserInsights = await getCampaignUserInsights(session.shop, days, effectiveSources, 120);
  const connectors = await listConnectorCredentials(session.shop);
  const recentConnectorRuns = await getRecentConnectorSyncRuns(session.shop, 20);
  const lastConnectorSuccess = (recentConnectorRuns || []).find((row) => row.status === "success") || null;
  const lastConnectorFailure = (recentConnectorRuns || []).find((row) => row.status === "failed") || null;

  return {
    planContext,
    days,
    source: sourceForDownstream,
    selectedSources: effectiveSources,
    rollout: {
      multiSourceEnabled,
      channel: planContext?.release?.channel || "stable",
    },
    rows: data.rows,
    sources: data.sources,
    actionItems: await listCampaignActionItems(session.shop, "all"),
    creativeScores,
    budgetSuggestions,
    campaignUserInsights,
    budgetDecisions: await listBudgetReallocationDecisions(session.shop, 20),
    permissions: {
      hasMetaConnector: connectors.some((row) => row.provider === "meta_ads" && row.accessToken),
      hasGoogleConnector: connectors.some((row) => row.provider === "google_ads" && row.accessToken),
    },
    connectorSnapshotFallback: {
      lastSuccessAt: lastConnectorSuccess?.createdAt || null,
      lastSuccessProvider: lastConnectorSuccess?.provider || null,
      lastFailedAt: lastConnectorFailure?.createdAt || null,
      lastFailedProvider: lastConnectorFailure?.provider || null,
    },
    scheduledReports: await listReportSchedules(session.shop, "campaigns"),
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "create-action") {
    await createCampaignActionItem(session.shop, {
      source: formData.get("source"),
      campaignId: formData.get("campaignId"),
      campaignName: formData.get("campaignName"),
      priority: formData.get("priority") || "medium",
      reason: formData.get("reason") || "Low real ROAS campaign",
      recommendedAction: formData.get("recommendedAction") || "Reduce spend and monitor for 48h",
    });
    return { ok: true, message: "Added to action queue." };
  }

  if (intent === "set-action-status") {
    await updateCampaignActionStatus(session.shop, formData.get("actionId"), formData.get("status"));
    return { ok: true, message: "Action status updated." };
  }

  if (intent === "approve-budget-shift") {
    await createBudgetReallocationDecision(session.shop, {
      fromSource: formData.get("fromSource"),
      fromCampaignId: formData.get("fromCampaignId"),
      fromCampaignName: formData.get("fromCampaignName"),
      toSource: formData.get("toSource"),
      toCampaignId: formData.get("toCampaignId"),
      toCampaignName: formData.get("toCampaignName"),
      shiftPercent: Number(formData.get("shiftPercent") || 0),
      reason: formData.get("reason") || "Approved reallocation",
      status: "approved",
      approvedBy: "merchant_ui",
    });
    return { ok: true, message: "Budget reallocation approved and logged." };
  }

  return { ok: false, message: "Invalid action" };
}

export default function CampaignsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const queueFetcher = useFetcher();
  const scheduleFetcher = useFetcher();
  const {
    planContext,
    days,
    selectedSources,
    rows,
    sources,
    actionItems,
    creativeScores,
    budgetSuggestions,
    campaignUserInsights,
    budgetDecisions,
    permissions,
    connectorSnapshotFallback,
    scheduledReports,
  } = useLoaderData();
  const tierLabel = String(planContext?.tier || "basic").toUpperCase();
  const hasPro = !!planContext?.hasPro;
  const actionData = useActionData();
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [pinnedInsights, setPinnedInsights] = useState([]);
  const [campaignPreset, setCampaignPreset] = useState("optimizer");
  const [presetToast, setPresetToast] = useState("");
  const [rowFeedback, setRowFeedback] = useState({});
  const [tableDensity, setTableDensity] = useState("comfortable");
  const [quickFilter, setQuickFilter] = useState("all");
  const [savedReports, setSavedReports] = useState(Array.isArray(scheduledReports) ? scheduledReports : []);
  const [reportDraft, setReportDraft] = useState({ name: "", frequency: "weekly", email: "" });
  const activeSources = Array.isArray(selectedSources) && selectedSources.length ? selectedSources : ["all"];
  const isAllSources = activeSources.includes("all");
  const queryFor = (newDays, newSources) => {
    const values = Array.isArray(newSources) ? newSources : [newSources];
    const normalized = values
      .map((row) => String(row || "").trim().toLowerCase())
      .filter(Boolean);
    const unique = normalized.length ? [...new Set(normalized)] : ["all"];
    if (unique.includes("all")) return `?days=${newDays}&sources=all`;
    return `?days=${newDays}&sources=${encodeURIComponent(unique.join(","))}`;
  };
  const toggleSource = (item) => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) return;
    if (normalized === "all") {
      navigate(queryFor(days, ["all"]), { preventScrollReset: true });
      return;
    }
    const current = isAllSources ? [] : [...activeSources];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((row) => row !== normalized) : [...current, normalized];
    navigate(queryFor(days, next.length ? next : ["all"]), { preventScrollReset: true });
  };
  const openItems = (actionItems || []).filter((row) => row.status === "open" || row.status === "in_progress");
  const topStopCampaigns = (rows || [])
    .filter((row) => row.orders > 0 && (row.realRoas < 1 || row.netCash < 0))
    .sort((a, b) => a.realRoas - b.realRoas || a.netCash - b.netCash)
    .slice(0, 10);
  const filteredRows = (rows || []).filter((row) => {
    if (quickFilter === "all") return true;
    if (quickFilter === "needs_action") return row.orders > 0 && (row.realRoas < 1 || row.netCash < 0);
    if (quickFilter === "winners") return row.orders > 0 && row.realRoas >= 2 && row.netCash > 0;
    if (quickFilter === "meta") return String(row.source || "").toLowerCase().includes("meta");
    return true;
  });
  const filteredStopCampaigns = topStopCampaigns.filter((row) => {
    if (quickFilter === "all" || quickFilter === "needs_action") return true;
    if (quickFilter === "winners") return false;
    if (quickFilter === "meta") return String(row.source || "").toLowerCase().includes("meta");
    return true;
  });
  const latestCampaignAtMs = (rows || []).reduce((max, row) => {
    const ts = row?.lastOrderAt ? new Date(row.lastOrderAt).getTime() : 0;
    return Number.isFinite(ts) ? Math.max(max, ts) : max;
  }, 0);
  const syncMins = latestCampaignAtMs ? Math.floor((Date.now() - latestCampaignAtMs) / (1000 * 60)) : null;
  const formatSyncAge = (mins) => {
    if (mins == null) return "No recent sync";
    if (mins < 1) return "Synced just now";
    if (mins < 60) return `Synced ${mins}m ago`;
    if (mins < 1440) return `Synced ${Math.floor(mins / 60)}h ago`;
    if (mins < 10080) return `Synced ${Math.floor(mins / 1440)}d ago`;
    return `Synced ${Math.floor(mins / 10080)}w ago`;
  };
  const syncStatus = syncMins == null ? "unknown" : syncMins < 15 ? "fresh" : syncMins < 120 ? "aging" : "stale";
  const syncBadgeClass = `nc-fresh-badge nc-sync-${syncStatus}`;
  const syncLabel = formatSyncAge(syncMins);
  const syncTitle = latestCampaignAtMs ? `Exact sync: ${new Date(latestCampaignAtMs).toLocaleString()}` : "No sync timestamp";

  useEffect(() => {
    setShowSkeleton(true);
    const timer = setTimeout(() => setShowSkeleton(false), 240);
    return () => clearTimeout(timer);
  }, [location.search]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem("nc_pinned_insights") || "[]");
    if (Array.isArray(saved)) setPinnedInsights(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedPreset = window.localStorage.getItem("nc_campaigns_preset");
    if (savedPreset) setCampaignPreset(savedPreset);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("nc_campaigns_preset", campaignPreset);
  }, [campaignPreset]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 980px)");
    const apply = () => setTableDensity(media.matches ? "compact" : "comfortable");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    if (Array.isArray(scheduledReports)) setSavedReports(scheduledReports);
  }, [scheduledReports]);
  useEffect(() => {
    if (scheduleFetcher.state !== "idle") return;
    if (!scheduleFetcher.data?.ok || !scheduleFetcher.data?.schedule) return;
    setSavedReports((current) => [scheduleFetcher.data.schedule, ...current].slice(0, 20));
    setPresetToast(`Scheduled ${scheduleFetcher.data.schedule.frequency} export`);
    setTimeout(() => setPresetToast(""), 1400);
  }, [scheduleFetcher.state, scheduleFetcher.data]);
  const togglePin = (id) => {
    setPinnedInsights((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      if (typeof window !== "undefined") {
        window.localStorage.setItem("nc_pinned_insights", JSON.stringify(next));
      }
      pushRowFeedback(id, next.includes(id) ? "Pinned" : "Unpinned");
      return next;
    });
  };
  const pushRowFeedback = (key, message) => {
    setRowFeedback((current) => ({ ...current, [key]: message }));
    setTimeout(() => {
      setRowFeedback((current) => {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 1800);
  };
  const selectCampaignPreset = (preset) => {
    setCampaignPreset(preset);
    trackUiEvent("preset_changed", { page: "campaigns", preset });
    const labels = { triage: "Triage", optimizer: "Optimizer", full: "Full View" };
    setPresetToast(`${labels[preset] || "Preset"} applied`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const showStopSection = campaignPreset === "triage" || campaignPreset === "optimizer" || campaignPreset === "full";
  const showBudgetSection = campaignPreset === "optimizer" || campaignPreset === "full";
  const showCreativeSection = campaignPreset === "optimizer" || campaignPreset === "full";
  const showQueueSection = campaignPreset === "triage" || campaignPreset === "optimizer" || campaignPreset === "full";
  const showTableSection = campaignPreset === "full" || campaignPreset === "optimizer";
  const exportCsvFile = (filename, rowsCsv) => {
    if (typeof window === "undefined") return;
    const csv = rowsCsv.map((r) => r.map((v) => `"${String(v ?? "").replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const saveReport = () => {
    const sourceLabel = isAllSources ? "all" : activeSources.join("+");
    const label = reportDraft.name.trim() || `Campaigns ${days}d ${sourceLabel}`;
    const next = [...savedReports, { id: `rep-${Date.now()}`, label, config: { days, sources: activeSources }, createdAt: new Date().toISOString() }].slice(-20);
    setSavedReports(next);
    setPresetToast("Report saved");
    trackUiEvent("report_saved", { page: "campaigns", label });
    setTimeout(() => setPresetToast(""), 1400);
  };
  const scheduleExport = () => {
    if (!reportDraft.email) {
      setPresetToast("Add email to schedule export");
      setTimeout(() => setPresetToast(""), 1400);
      return;
    }
    const sourceLabel = isAllSources ? "all" : activeSources.join("+");
    const label = reportDraft.name.trim() || `Campaigns ${days}d ${sourceLabel}`;
    trackUiEvent("report_scheduled", { page: "campaigns", frequency: reportDraft.frequency });
    const payload = new FormData();
    payload.append("intent", "create");
    payload.append("page", "campaigns");
    payload.append("name", label);
    payload.append("frequency", reportDraft.frequency);
    payload.append("email", reportDraft.email);
    payload.append("format", "both");
    payload.append("filters", JSON.stringify({ days, sources: activeSources }));
    scheduleFetcher.submit(payload, { method: "post", action: "/api/reports.schedule" });
  };

  return (
    <div className={`nc-shell nc-campaigns ${tableDensity === "compact" ? "nc-density-compact" : ""}`}>
      {showSkeleton ? (
        <div className="nc-section">
          <div className="nc-skeleton nc-skeleton-title" />
          <div className="nc-skeleton nc-skeleton-card" />
        </div>
      ) : null}
      <div className="nc-header-row nc-section">
        <h1 style={{ marginBottom: 0 }}>Campaign Performance</h1>
        <div className="nc-plan-pill">Plan: {tierLabel}</div>
      </div>
      <p className="nc-subtitle">
        Compare campaign quality using gross revenue, net cash, ROAS <span className="nc-tip-icon" title="Revenue divided by ad spend.">?</span>, and Real ROAS <span className="nc-tip-icon" title="Net-cash aware ROAS after returns and cost impact.">?</span>.
      </p>
      <div className="nc-toolbar nc-section nc-quick-actions" style={{ marginBottom: 0 }}>
        <Link to="/app/campaigns#campaign-stop-list" preventScrollReset className="nc-chip">Review stop list</Link>
        <Link to="/app/campaigns#budget-reallocation" preventScrollReset className="nc-chip">Reallocate budget</Link>
        <Link to="/app/integrations?wizard=1" preventScrollReset className="nc-chip">Connect sources</Link>
        <Link to="/app/campaigns#campaign-table" preventScrollReset className="nc-chip">All campaigns</Link>
      </div>
      <div className="nc-card nc-section nc-first-value">
        <div className="nc-section-head-inline">
          <h3 style={{ margin: 0 }}>First‑value flow</h3>
          <a className="nc-help-link" href="/app/integrations?wizard=1">Why this helps</a>
        </div>
        <ol className="nc-step-list">
          <li>
            <strong>Open stop list</strong>
            <span>Identify the first 3 campaigns to pause.</span>
            <Link to="/app/campaigns#campaign-stop-list" preventScrollReset className="nc-chip">Open list</Link>
          </li>
          <li>
            <strong>Queue actions</strong>
            <span>Add low ROAS campaigns to the action queue.</span>
            <Link to="/app/campaigns#campaign-table" preventScrollReset className="nc-chip">Queue actions</Link>
          </li>
          <li>
            <strong>Save a report</strong>
            <span>Export a snapshot for your daily standup.</span>
            <a className="nc-chip" href="#campaign-reports">Save report</a>
          </li>
        </ol>
      </div>
      {connectorSnapshotFallback?.lastFailedAt ? (
        <div className="nc-card nc-section">
          <h3 style={{ marginTop: 0 }}>Support-Safe Fallback Active</h3>
          <p className="nc-note">
            Latest failure: {connectorSnapshotFallback.lastFailedProvider || "unknown"} at{" "}
            {new Date(connectorSnapshotFallback.lastFailedAt).toLocaleString()}.
          </p>
          <p className="nc-note">
            Last successful snapshot: {connectorSnapshotFallback.lastSuccessProvider || "none"} at{" "}
            {connectorSnapshotFallback.lastSuccessAt ? new Date(connectorSnapshotFallback.lastSuccessAt).toLocaleString() : "not available"}.
          </p>
        </div>
      ) : null}
      <p className="nc-note" style={{ marginTop: "-8px" }}>
        Need period-to-period movement? Review <Link to={`/app?days=${days}&compare=1`} preventScrollReset>Home Compare Mode</Link>.
      </p>
      <div className="nc-toolbar nc-section" style={{ marginBottom: 0 }}>
        <button type="button" className={`nc-chip ${quickFilter === "all" ? "is-active" : ""}`} onClick={() => setQuickFilter("all")}>All campaigns</button>
        <button type="button" className={`nc-chip ${quickFilter === "needs_action" ? "is-active" : ""}`} onClick={() => setQuickFilter("needs_action")}>Needs action</button>
        <button type="button" className={`nc-chip ${quickFilter === "winners" ? "is-active" : ""}`} onClick={() => setQuickFilter("winners")}>Top winners</button>
        <button type="button" className={`nc-chip ${quickFilter === "meta" ? "is-active" : ""}`} onClick={() => setQuickFilter("meta")}>Meta only</button>
        <button type="button" className="nc-chip" onClick={() => { setQuickFilter("all"); navigate(queryFor(days, ["all"]), { preventScrollReset: true }); }}>
          Reset all filters
        </button>
      </div>
      {presetToast ? <div className="nc-toast">{presetToast}</div> : null}
      {actionData?.message ? <p className={actionData.ok ? "nc-success" : "nc-danger"}>{actionData.message}</p> : null}
      <div className="nc-card nc-section nc-glass nc-campaign-controls">
        <div className="nc-campaign-controls-head">
          <button
            type="button"
            className="nc-icon-btn"
            onClick={() => {
              trackUiEvent("refresh_clicked", { page: "campaigns" });
              revalidator.revalidate();
            }}
            disabled={revalidator.state === "loading"}
          >
            {revalidator.state === "loading" ? "Refreshing..." : "Refresh now"}
          </button>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>

        <div className="nc-campaign-controls-grid">
          <div className="nc-campaign-control-group">
            <span className="nc-note">Window</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {DAY_OPTIONS.map((option) => (
                <Link
                  key={option}
                  to={queryFor(option, activeSources)}
                  className={`nc-chip ${option === days ? "is-active" : ""}`}
                  preventScrollReset
                >
                  {option}d
                </Link>
              ))}
            </div>
          </div>

          <div className="nc-campaign-control-group">
            <span className="nc-note">Source</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className={`nc-chip ${isAllSources ? "is-active" : ""}`}
                onClick={() => toggleSource("all")}
              >
                All
              </button>
              {sources.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`nc-chip ${activeSources.includes(item) && !isAllSources ? "is-active" : ""}`}
                  style={{ textTransform: "capitalize" }}
                  onClick={() => toggleSource(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="nc-campaign-control-group" aria-label="Campaign presets">
            <span className="nc-note">Mode</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {[
                ["triage", "Triage"],
                ["optimizer", "Optimizer"],
                ["full", "Full View"],
              ].map(([key, label]) => (
                <button key={key} type="button" className={`nc-chip ${campaignPreset === key ? "is-active" : ""}`} onClick={() => selectCampaignPreset(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="nc-campaign-control-group" aria-label="Campaign table density">
            <span className="nc-note">Density</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <span className="nc-chip is-active">{tableDensity === "compact" ? "Auto: Compact" : "Auto: Comfortable"}</span>
            </div>
          </div>
        </div>
      </div>
      {!permissions?.hasMetaConnector || !permissions?.hasGoogleConnector ? (
        <div className="nc-card nc-section nc-glass">
          <h3>Permission Check</h3>
          <p className="nc-note">Missing connectors reduce campaign diagnostics quality.</p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {!permissions?.hasMetaConnector ? <Link className="nc-chip" to="/app/integrations?wizard=1" preventScrollReset>Connect Meta</Link> : null}
            {!permissions?.hasGoogleConnector ? <Link className="nc-chip" to="/app/integrations?wizard=1" preventScrollReset>Connect Google</Link> : null}
          </div>
        </div>
      ) : null}
      <div className="nc-card nc-section nc-glass">
        <h2>Playbooks</h2>
        <p className="nc-note">Prebuilt actions to accelerate optimization.</p>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          {[
            { key: "low_roas", label: "Low ROAS recovery", reason: "Low real ROAS across active campaigns", action: "Reduce spend by 20%, refresh creative, recheck in 48h" },
            { key: "high_rto", label: "High RTO reduction", reason: "High RTO/returns concentration", action: "Tighten COD eligibility, improve shipping policy by pincode" },
            { key: "hvc_reactivation", label: "High-value customer reactivation", reason: "Gold cohort repeat purchase window due", action: "Launch targeted reactivation sequence via CRM tools" },
          ].map((playbook) => (
            <button
              key={playbook.key}
              type="button"
              className="nc-chip"
              onClick={() => {
                const target = topStopCampaigns[0];
                const payload = new FormData();
                payload.append("intent", "create-action");
                payload.append("source", target?.source || "all");
                payload.append("campaignId", target?.campaignId || "");
                payload.append("campaignName", target?.campaignName || playbook.label);
                payload.append("priority", "high");
                payload.append("reason", playbook.reason);
                payload.append("recommendedAction", playbook.action);
                queueFetcher.submit(payload, { method: "post" });
                trackUiEvent("playbook_applied", { playbook: playbook.key });
                pushRowFeedback(`playbook:${playbook.key}`, `${playbook.label} added to queue`);
              }}
            >
              {playbook.label}
            </button>
          ))}
        </div>
        {Object.keys(rowFeedback).filter((k) => k.startsWith("playbook:")).map((k) => (
          <div key={k} className="nc-inline-feedback">{rowFeedback[k]}</div>
        ))}
      </div>
      <div className="nc-card nc-section nc-glass" id="campaign-reports">
        <div className="nc-section-head-inline">
          <h2>Saved Reports & Scheduled Export</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={saveReport}>Save Report</button>
            <button type="button" className="nc-chip" onClick={scheduleExport}>Schedule Export</button>
          </div>
        </div>
        <div className="nc-toolbar" style={{ marginBottom: "10px" }}>
          <button
            type="button"
            className="nc-chip"
            onClick={() => setReportDraft((c) => ({ ...c, name: "Daily Campaign Triage", frequency: "daily" }))}
          >
            Daily triage template
          </button>
          <button
            type="button"
            className="nc-chip"
            onClick={() => setReportDraft((c) => ({ ...c, name: "Weekly ROAS Summary", frequency: "weekly" }))}
          >
            Weekly ROAS template
          </button>
        </div>
        <div className="nc-grid-4">
          <label className="nc-form-field">Report Name
            <input value={reportDraft.name} onChange={(e) => setReportDraft((c) => ({ ...c, name: e.target.value }))} />
          </label>
          <label className="nc-form-field">Frequency
            <select value={reportDraft.frequency} onChange={(e) => setReportDraft((c) => ({ ...c, frequency: e.target.value }))}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label className="nc-form-field">Email
            <input type="email" value={reportDraft.email} onChange={(e) => setReportDraft((c) => ({ ...c, email: e.target.value }))} />
          </label>
        </div>
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {savedReports.slice(-6).length === 0 ? (
            <li className="nc-note">No schedules yet. Do this next: choose Daily/Weekly + email, then click `Schedule Export`.</li>
          ) : savedReports.slice(-6).map((row) => (
            <li key={row.id}>{row.label || row.name} {row.frequency ? `(${row.frequency} to ${row.email})` : ""}</li>
          ))}
        </ul>
      </div>

      {showStopSection ? <div className="nc-card nc-section nc-glass" id="campaign-stop-list">
        <div className="nc-section-head-inline">
          <h2>Campaigns to Stop Running</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("campaign_stop_list.csv", [
                  ["Source", "Campaign", "Orders", "Net Cash", "Real ROAS"],
                  ...filteredStopCampaigns.map((row) => [row.source, row.campaignName || row.campaignId || "Unmapped", row.orders, row.netCash, row.realRoas]),
                ])
              }
            >
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <p className="nc-note">Priority list based on low real ROAS and weak/negative net cash.</p>
        <table className="nc-table-card nc-campaign-premium-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "right" }}>Orders</th>
              <th style={{ textAlign: "right" }}>Net Cash</th>
              <th style={{ textAlign: "right" }}>Real ROAS</th>
              <th style={{ textAlign: "left" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredStopCampaigns.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="nc-empty-state">
                    <div className="nc-empty-illus nc-empty-illus-campaigns">A</div>
                    <div>No stop candidates for this quick filter.</div>
                    <Link to="/app/campaigns" className="nc-chip" preventScrollReset>Reset Filters</Link>
                    <Link to="/app/additional#utm-intelligence" className="nc-chip" preventScrollReset>Improve UTM Mapping</Link>
                  </div>
                </td>
              </tr>
            ) : (
              filteredStopCampaigns.map((row) => (
                <tr className={`nc-campaign-premium-row nc-row-severity-${rowSeverityFromCampaign(row)}`} key={`stop-${row.source}-${row.campaignId}-${row.campaignName}`}>
                  <td data-label="Source">{row.source}</td>
                  <td data-label="Campaign">{row.campaignName || row.campaignId || "Unmapped"}</td>
                  <td data-label="Orders" style={{ textAlign: "right" }}>{row.orders}</td>
                  <td data-label="Net Cash" style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                  <td data-label="Real ROAS" style={{ textAlign: "right" }}>{row.realRoas.toFixed(2)}x</td>
                  <td data-label="Actions">
                    <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                      <Link
                        to="/app/alerts?severity=warning"
                        preventScrollReset
                        className="nc-chip"
                        onClick={() => pushRowFeedback(`campaign:${row.source}:${row.campaignId || row.campaignName}`, "Alert workflow opened")}
                      >
                        Create Alert
                      </Link>
                      <button type="button" className="nc-chip" onClick={() => togglePin(`campaign:${row.source}:${row.campaignId || row.campaignName}`)}>
                        {pinnedInsights.includes(`campaign:${row.source}:${row.campaignId || row.campaignName}`) ? "Unpin" : "Pin"}
                      </button>
                    </div>
                    {rowFeedback[`campaign:${row.source}:${row.campaignId || row.campaignName}`] ? (
                      <div className="nc-inline-feedback">{rowFeedback[`campaign:${row.source}:${row.campaignId || row.campaignName}`]}</div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : null}

      {showBudgetSection && hasPro ? <div className="nc-card nc-section nc-glass" id="budget-reallocation">
        <h2>Budget Reallocation Suggestions</h2>
        <p className="nc-note">One-click approvals to shift budget from weak to high-quality campaigns.</p>
        <table className="nc-table-card" style={{ marginBottom: "16px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>From</th>
              <th style={{ textAlign: "left" }}>To</th>
              <th style={{ textAlign: "right" }}>Shift %</th>
              <th style={{ textAlign: "left" }}>Reason</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {(budgetSuggestions || []).length === 0 ? (
              <tr><td colSpan={5}>No reallocation suggestions right now.</td></tr>
            ) : (
              budgetSuggestions.map((s, idx) => (
                <tr key={`shift-${idx}-${s.fromCampaignId}-${s.toCampaignId}`}>
                  <td data-label="From">{s.fromCampaignName || s.fromCampaignId || s.fromSource}</td>
                  <td data-label="To">{s.toCampaignName || s.toCampaignId || s.toSource}</td>
                  <td data-label="Shift %" style={{ textAlign: "right" }}>{Number(s.shiftPercent).toFixed(0)}%</td>
                  <td data-label="Reason">{s.reason}</td>
                  <td data-label="Action">
                    <Form method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="approve-budget-shift" />
                      <input type="hidden" name="fromSource" value={s.fromSource} />
                      <input type="hidden" name="fromCampaignId" value={s.fromCampaignId || ""} />
                      <input type="hidden" name="fromCampaignName" value={s.fromCampaignName || ""} />
                      <input type="hidden" name="toSource" value={s.toSource} />
                      <input type="hidden" name="toCampaignId" value={s.toCampaignId || ""} />
                      <input type="hidden" name="toCampaignName" value={s.toCampaignName || ""} />
                      <input type="hidden" name="shiftPercent" value={String(s.shiftPercent)} />
                      <input type="hidden" name="reason" value={s.reason} />
                      <button type="submit">Approve</button>
                    </Form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <h3>Approved Reallocations</h3>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>When</th>
              <th style={{ textAlign: "left" }}>From</th>
              <th style={{ textAlign: "left" }}>To</th>
              <th style={{ textAlign: "right" }}>Shift %</th>
            </tr>
          </thead>
          <tbody>
            {(budgetDecisions || []).length === 0 ? (
              <tr><td colSpan={4}>No approvals yet. Do this next: review suggestions above and click `Approve Shift`.</td></tr>
            ) : (
              budgetDecisions.slice(0, 10).map((row) => (
                <tr key={`decision-${row.id}`}>
                  <td data-label="When">{new Date(row.createdAt).toLocaleString()}</td>
                  <td data-label="From">{row.fromCampaignName || row.fromCampaignId || row.fromSource}</td>
                  <td data-label="To">{row.toCampaignName || row.toCampaignId || row.toSource}</td>
                  <td data-label="Shift %" style={{ textAlign: "right" }}>{Number(row.shiftPercent).toFixed(0)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : (
        <div className="nc-card nc-section" id="budget-reallocation">
          <h2>Budget Reallocation Suggestions</h2>
          <p className="nc-note">Upgrade to Pro to unlock one-click budget reallocation approvals.</p>
          <Link to="/app/billing?manage=1" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {showCreativeSection && hasPro ? <div className="nc-card nc-section nc-glass" id="campaign-action-queue">
        <h2>Creative Performance Scoring</h2>
        <p className="nc-note">Score bands use net cash quality, real ROAS, and order volume proxy.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "right" }}>Score</th>
              <th style={{ textAlign: "left" }}>Band</th>
              <th style={{ textAlign: "left" }}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {(creativeScores || []).length === 0 ? (
              <tr><td colSpan={5}>No creative scores available.</td></tr>
            ) : (
              creativeScores.slice(0, 20).map((row) => (
                <tr key={`creative-${row.source}-${row.campaignId}-${row.campaignName}`}>
                  <td data-label="Campaign">{row.campaignName || row.campaignId || "Unmapped"}</td>
                  <td data-label="Source">{row.source}</td>
                  <td data-label="Score" style={{ textAlign: "right" }}>{row.creativeScore}</td>
                  <td data-label="Band">{row.creativeBand}</td>
                  <td data-label="Recommendation">{row.creativeRecommendation}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : (
        <div className="nc-card nc-section">
          <h2>Creative Performance Scoring</h2>
          <p className="nc-note">Upgrade to Pro to unlock creative scoring and recommendations.</p>
          <Link to="/app/billing?manage=1" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {showQueueSection && hasPro ? <div className="nc-card nc-section nc-glass">
        <h2>Campaign Action Queue</h2>
        <p className="nc-note">Track recommendations and decide what to pause, reduce, or monitor.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Priority</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {openItems.length === 0 ? (
              <tr><td colSpan={5}>No open actions.</td></tr>
            ) : (
              openItems.slice(0, 12).map((item) => (
                <tr key={`action-${item.id}`}>
                  <td data-label="Campaign">{item.campaignName || item.campaignId || "Unmapped"}</td>
                  <td data-label="Source">{item.source}</td>
                  <td data-label="Priority">{item.priority}</td>
                  <td data-label="Status">{item.status}</td>
                  <td data-label="Action">
                    <Form method="post" className="nc-form-row" preventScrollReset>
                      <input type="hidden" name="intent" value="set-action-status" />
                      <input type="hidden" name="actionId" value={item.id} />
                      <select name="status" defaultValue={item.status}>
                        <option value="open">open</option>
                        <option value="in_progress">in_progress</option>
                        <option value="done">done</option>
                        <option value="ignored">ignored</option>
                      </select>
                      <button type="submit">Update</button>
                    </Form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : (
        <div className="nc-card nc-section" id="campaign-action-queue">
          <h2>Campaign Action Queue</h2>
          <p className="nc-note">Upgrade to Pro to unlock action queue tracking for underperforming campaigns.</p>
          <Link to="/app/billing?manage=1" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {showTableSection ? <div className="nc-card nc-scroll nc-glass nc-campaign-premium-wrap" id="campaign-table">
        <div className="nc-section-head-inline" style={{ padding: "0 0 10px" }}>
          <h3 style={{ margin: 0 }}>All Campaigns</h3>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("all_campaigns.csv", [
                  ["Source", "Campaign", "Campaign ID", "Orders", "Net Cash", "Real ROAS"],
                  ...filteredRows.map((row) => [row.source, row.campaignName || "Unmapped", row.campaignId || "-", row.orders, row.netCash, row.realRoas]),
                ])
              }
            >
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <table className="nc-campaign-premium-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ padding: "12px", textAlign: "left" }}>Source</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Campaign</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Campaign ID</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Orders</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Items</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Gross</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Net Cash</th>
              <th style={{ padding: "12px", textAlign: "right" }}>ROAS</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Real ROAS</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Last Order</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={11} style={{ padding: "12px" }}>
                    <div className="nc-empty-state">
                      <div className="nc-empty-illus nc-empty-illus-campaigns">C</div>
                      <div>No campaigns match this filter.</div>
                      <Link to="/app/campaigns" className="nc-chip" preventScrollReset>Reset Filters</Link>
                      <Link to="/app/integrations?wizard=1" className="nc-chip" preventScrollReset>Setup Campaign Sources</Link>
                    </div>
                  </td>
                </tr>
            ) : (
              filteredRows.map((row) => (
                <tr className={`nc-campaign-premium-row nc-row-severity-${rowSeverityFromCampaign(row)}`} key={`${row.source}-${row.campaignId}-${row.campaignName}`} style={{ borderBottom: "1px solid #e0e0e0" }}>
                  <td style={{ padding: "12px", textTransform: "capitalize" }}>{row.source}</td>
                  <td style={{ padding: "12px" }}>{row.campaignName || "Unmapped"}</td>
                  <td style={{ padding: "12px" }}>{row.campaignId || "-"}</td>
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.orders}</td>
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.itemUnits}</td>
                  <td style={{ padding: "12px", textAlign: "right" }}>{money(row.grossRevenue)}</td>
                  <td style={{ padding: "12px", textAlign: "right", fontWeight: "bold" }}>{money(row.netCash)}</td>
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.roas.toFixed(2)}x</td>
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.realRoas.toFixed(2)}x</td>
                  <td style={{ padding: "12px" }}>
                    {row.lastOrderAt ? new Date(row.lastOrderAt).toLocaleDateString() : "-"}
                  </td>
                  <td style={{ padding: "12px" }}>
                    {row.orders > 0 && (row.realRoas < 1 || row.netCash < 0) ? (
                      <button
                        type="button"
                        onClick={() => {
                          const payload = new FormData();
                          payload.append("intent", "create-action");
                          payload.append("source", row.source);
                          payload.append("campaignId", row.campaignId || "");
                          payload.append("campaignName", row.campaignName || "");
                          payload.append("priority", row.netCash < 0 || row.realRoas < 0.75 ? "high" : "medium");
                          payload.append("reason", row.netCash < 0 ? "Campaign is net-cash negative" : "Real ROAS below 1x");
                          payload.append("recommendedAction", "Reduce budget by 20-40%, refresh creative, and re-check in 48h");
                          queueFetcher.submit(payload, { method: "post" });
                          trackUiEvent("queue_action_added", { source: row.source, campaign: row.campaignName || row.campaignId || "unknown" });
                          pushRowFeedback(`queue:${row.source}:${row.campaignId || row.campaignName}`, "Added to action queue");
                        }}
                      >
                        Add to Queue
                      </button>
                    ) : (
                      <span className="nc-muted">Healthy</span>
                    )}
                    {rowFeedback[`queue:${row.source}:${row.campaignId || row.campaignName}`] ? (
                      <div className="nc-inline-feedback">{rowFeedback[`queue:${row.source}:${row.campaignId || row.campaignName}`]}</div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : null}

      <div className="nc-card nc-section nc-glass" id="campaign-user-truth">
        <div className="nc-section-head-inline">
          <h2>Campaign to User Netcash Truth</h2>
          <button
            type="button"
            className="nc-icon-btn"
            onClick={() =>
              exportCsvFile("campaign_user_truth.csv", [
                [
                  "Source",
                  "Campaign",
                  "Campaign ID",
                  "Customer",
                  "Email",
                  "Phone",
                  "Orders",
                  "Gross Revenue",
                  "Net Cash",
                  "RTO Orders",
                  "Returned Orders",
                  "Exchange Orders",
                  "Higher Exchange",
                  "Lower Exchange",
                  "Exchange Refund Orders",
                  "Last Order",
                ],
                ...(campaignUserInsights || []).map((row) => [
                  row.source,
                  row.campaignName || "Unmapped",
                  row.campaignId || "-",
                  row.customerName || "-",
                  row.customerEmail || "-",
                  row.customerPhone || "-",
                  row.orders,
                  row.grossRevenue,
                  row.netCash,
                  row.rtoOrders,
                  row.returnedOrders,
                  row.exchangeOrders,
                  row.exchangeHigherOrders,
                  row.exchangeLowerOrders,
                  row.exchangeRefundOrders,
                  row.lastOrderAt ? new Date(row.lastOrderAt).toISOString() : "",
                ]),
              ])
            }
          >
            Export
          </button>
        </div>
        <p className="nc-note">Campaign-level and user-level net-cash truth including RTO/returns/exchange direction.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "left" }}>Customer</th>
              <th style={{ textAlign: "right" }}>Orders</th>
              <th style={{ textAlign: "right" }}>Net Cash</th>
              <th style={{ textAlign: "right" }}>RTO</th>
              <th style={{ textAlign: "right" }}>Returns</th>
              <th style={{ textAlign: "right" }}>Exch +</th>
              <th style={{ textAlign: "right" }}>Exch -</th>
              <th style={{ textAlign: "right" }}>Exch Refund</th>
              <th style={{ textAlign: "left" }}>Last Order</th>
            </tr>
          </thead>
          <tbody>
            {(campaignUserInsights || []).length === 0 ? (
              <tr><td colSpan={11}>No user-level campaign truth rows yet.</td></tr>
            ) : (
              campaignUserInsights.slice(0, 80).map((row) => (
                <tr key={`${row.source}|${row.campaignId}|${row.customerKey}`}>
                  <td>{row.source}</td>
                  <td>{row.campaignName || row.campaignId || "Unmapped"}</td>
                  <td>{row.customerName || row.customerEmail || row.customerPhone || row.customerKey}</td>
                  <td style={{ textAlign: "right" }}>{row.orders}</td>
                  <td style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                  <td style={{ textAlign: "right" }}>{row.rtoOrders}</td>
                  <td style={{ textAlign: "right" }}>{row.returnedOrders}</td>
                  <td style={{ textAlign: "right" }}>{row.exchangeHigherOrders}</td>
                  <td style={{ textAlign: "right" }}>{row.exchangeLowerOrders}</td>
                  <td style={{ textAlign: "right" }}>{row.exchangeRefundOrders}</td>
                  <td>{row.lastOrderAt ? new Date(row.lastOrderAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Something went wrong while loading Campaigns.");
  return (
    <div className="nc-shell nc-campaigns">
      <div className="nc-card nc-section">
        <h2>Campaigns Unavailable</h2>
        <p className="nc-note">{message}</p>
        <a className="nc-chip" href="/app/campaigns">Reload Campaigns</a>
      </div>
    </div>
  );
}
