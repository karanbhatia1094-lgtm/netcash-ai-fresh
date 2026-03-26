import { Form, Link, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { trackUiEvent } from "../utils/telemetry.client";
import {
  evaluateAndStoreAlerts,
  getCreativeFatigueRisks,
  getOrders,
  getSourceMetrics,
  listAlertEvents,
  listAlertRules,
  listAlertRuleSettings,
  markAlertRead,
  upsertAlertRuleSetting,
  listConnectorCredentials,
} from "../utils/db.server";
import { listReportSchedules } from "../utils/report-scheduler.server";
import { isDevPreviewEnabled } from "../utils/dev-preview.server";
import { resolveShopConfig } from "../utils/release-control.server";

const SEVERITIES = ["all", "critical", "warning", "info"];
const RISK_WINDOW_DAYS = 90;

function pct(value, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const severity = String(url.searchParams.get("severity") || "all").toLowerCase();
  const safeSeverity = SEVERITIES.includes(severity) ? severity : "all";
  const rawSourcesParam = String(url.searchParams.get("sources") || "all");
  const selectedSources = rawSourcesParam
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const normalizedSelectedSources = selectedSources.length ? [...new Set(selectedSources)] : ["all"];
  const includeAllSources = normalizedSelectedSources.includes("all");
  const sourceFilterSet = new Set(normalizedSelectedSources.filter((row) => row !== "all"));
  const devPreview = isDevPreviewEnabled();

  if (devPreview) {
    return {
      shop: session.shop,
      severity: safeSeverity,
      events: [],
      rules: [],
      evaluation: { created: 0 },
      riskRadar: [],
      nextActions: [],
      permissions: {
        hasMetaConnector: false,
        hasGoogleConnector: false,
      },
      scheduledReports: [],
      selectedSources: normalizedSelectedSources,
    };
  }

  const [rules, settings, evaluation, orders, spendRows, fatigue, shopConfig] = await Promise.all([
    listAlertRules(),
    listAlertRuleSettings(session.shop),
    evaluateAndStoreAlerts(session.shop),
    getOrders(session.shop, RISK_WINDOW_DAYS, { limit: 5000 }),
    getSourceMetrics(RISK_WINDOW_DAYS),
    getCreativeFatigueRisks(session.shop, RISK_WINDOW_DAYS),
    resolveShopConfig(session.shop, {
      growth_guardrail_max_cac: "0",
      growth_guardrail_min_margin_pct: "15",
      growth_guardrail_max_rto_pct: "12",
      growth_guardrail_max_discount_pct: "30",
      growth_guardrail_max_refund_pct: "6",
    }),
  ]);
  const adSpend = (spendRows || []).reduce((sum, row) => sum + Number(row.adSpend || 0), 0);
  const netCash = (orders || []).reduce((sum, row) => sum + Number(row.netCash || 0), 0);
  const gross = (orders || []).reduce((sum, row) => sum + Number(row.grossValue || 0), 0);
  const discount = (orders || []).reduce((sum, row) => sum + Number(row.discountTotal || 0), 0);
  const refunds = (orders || []).reduce((sum, row) => sum + Number(row.refundTotal || 0), 0);
  const rtoCount = (orders || []).filter((row) => row.isRTO).length;
  const blendedRoas = adSpend > 0 ? netCash / adSpend : 0;
  const discountPct = gross > 0 ? (discount / gross) * 100 : 0;
  const marginPct = gross > 0 ? (netCash / gross) * 100 : 0;
  const refundPct = gross > 0 ? (refunds / gross) * 100 : 0;
  const rtoPct = (orders || []).length > 0 ? (rtoCount / orders.length) * 100 : 0;
  const attributionMissing = (orders || []).filter(
    (row) => !row.utmSource && !row.campaignId && !row.campaignName && !row.clickId,
  ).length;
  const attributionGapPct = (orders || []).length > 0 ? (attributionMissing / orders.length) * 100 : 0;
  const guardrails = {
    maxCac: parseNumber(shopConfig.growth_guardrail_max_cac, 0),
    minMarginPct: parseNumber(shopConfig.growth_guardrail_min_margin_pct, 12),
    maxRtoPct: parseNumber(shopConfig.growth_guardrail_max_rto_pct, 15),
    maxDiscountPct: parseNumber(shopConfig.growth_guardrail_max_discount_pct, 25),
    maxRefundPct: parseNumber(shopConfig.growth_guardrail_max_refund_pct, 8),
  };
  const riskRadar = [
    { label: "Attribution Gap", value: attributionGapPct, threshold: 30, higherIsBad: true },
    { label: "Creative Fatigue", value: fatigue?.length || 0, threshold: 3, higherIsBad: true },
    { label: "RTO %", value: rtoPct, threshold: guardrails.maxRtoPct, higherIsBad: true },
    { label: "Refund %", value: refundPct, threshold: guardrails.maxRefundPct, higherIsBad: true },
    { label: "Margin %", value: marginPct, threshold: guardrails.minMarginPct, higherIsBad: false },
    { label: "Discount %", value: discountPct, threshold: guardrails.maxDiscountPct, higherIsBad: true },
  ].map((row) => {
    const bad = row.higherIsBad ? row.value > row.threshold : row.value < row.threshold;
    const status = bad ? "risk" : row.value ? "watch" : "stable";
    return { ...row, status };
  });
  const nextActions = [];
  if (blendedRoas > 0 && blendedRoas < 1) nextActions.push("Blended ROAS below 1.0x — cut weakest campaigns and fix attribution gaps.");
  if (attributionGapPct >= 30) nextActions.push("Attribution gap > 30% — enforce UTM + click ID capture and re-check landing tags.");
  if (fatigue?.length) nextActions.push(`Creative fatigue detected in ${fatigue.length} ads — rotate creative immediately.`);
  if (rtoCount > 0 && rtoPct > 15) nextActions.push("High RTO rate — review delivery partners and pin-code blocks.");
  if (marginPct < 10 && gross > 0) nextActions.push("Margin below 10% — tighten discounting and monitor net cash.");

  let events = await listAlertEvents(session.shop, { severity: safeSeverity, limit: 150 });
  if (!includeAllSources) {
    events = (events || []).filter((alert) => {
      const blob = `${alert?.title || ""} ${alert?.message || ""}`.toLowerCase();
      return [...sourceFilterSet].some((source) => blob.includes(source));
    });
  }
  const connectors = await listConnectorCredentials(session.shop);
  const settingMap = new Map(settings.map((s) => [s.ruleKey, s]));

  const mergedRules = rules.map((rule) => {
    const setting = settingMap.get(rule.key);
    const muted = !!setting?.mutedUntil && new Date(setting.mutedUntil) > new Date();
    return {
      ...rule,
      enabled: setting ? setting.enabled !== false : true,
      mutedUntil: setting?.mutedUntil || null,
      muted,
    };
  });

  return {
    shop: session.shop,
    severity: safeSeverity,
    events,
    rules: mergedRules,
    evaluation,
    riskRadar,
    nextActions: nextActions.slice(0, 4),
    permissions: {
      hasMetaConnector: connectors.some((row) => row.provider === "meta_ads" && row.accessToken),
      hasGoogleConnector: connectors.some((row) => row.provider === "google_ads" && row.accessToken),
    },
    scheduledReports: await listReportSchedules(session.shop, "alerts"),
    selectedSources: normalizedSelectedSources,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "mark-read") {
    await markAlertRead(session.shop, formData.get("alertId"), true);
  }
  if (intent === "mark-unread") {
    await markAlertRead(session.shop, formData.get("alertId"), false);
  }
  if (intent === "mute-rule") {
    const ruleKey = String(formData.get("ruleKey") || "");
    const days = Number(formData.get("days") || 7);
    const mutedUntil = new Date();
    mutedUntil.setDate(mutedUntil.getDate() + days);
    await upsertAlertRuleSetting(session.shop, ruleKey, { enabled: true, mutedUntil });
  }
  if (intent === "unmute-rule") {
    const ruleKey = String(formData.get("ruleKey") || "");
    await upsertAlertRuleSetting(session.shop, ruleKey, { enabled: true, mutedUntil: null });
  }
  if (intent === "disable-rule") {
    const ruleKey = String(formData.get("ruleKey") || "");
    await upsertAlertRuleSetting(session.shop, ruleKey, { enabled: false, mutedUntil: null });
  }
  if (intent === "enable-rule") {
    const ruleKey = String(formData.get("ruleKey") || "");
    await upsertAlertRuleSetting(session.shop, ruleKey, { enabled: true, mutedUntil: null });
  }

  return null;
}

export default function AlertsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const readFetcher = useFetcher();
  const scheduleFetcher = useFetcher();
  const { shop, severity, events, rules, evaluation, permissions, scheduledReports, selectedSources: selectedSourcesFromLoader, riskRadar, nextActions } = useLoaderData();
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [activeView, setActiveView] = useState("overview");
  const [pinnedInsights, setPinnedInsights] = useState([]);
  const [presetToast, setPresetToast] = useState("");
  const [readOverrides, setReadOverrides] = useState({});
  const [rowFeedback, setRowFeedback] = useState({});
  const [densityMode, setDensityMode] = useState("auto");
  const [tableDensity, setTableDensity] = useState("comfortable");
  const [quickFilter, setQuickFilter] = useState("all");
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const [multiSourceOpen, setMultiSourceOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState(selectedSourcesFromLoader || ["all"]);
  const [savedViews, setSavedViews] = useState([]);
  const [viewDraftName, setViewDraftName] = useState("");
  const [savedReports, setSavedReports] = useState(Array.isArray(scheduledReports) ? scheduledReports : []);
  const [reportDraft, setReportDraft] = useState({ name: "", frequency: "weekly", email: "" });
  const savedViewsKey = `nc_alerts_saved_views_${String(shop || "global").toLowerCase()}`;
  const applyViewSessionKey = `nc_alerts_apply_view_${String(shop || "global").toLowerCase()}`;
  const appliedFilterTokens = [
    `View: ${activeView.replace("_", " ")}`,
    `Quick filter: ${quickFilter.replace("_", " ")}`,
    `Severity: ${severity}`,
    `Sources: ${isAllSources ? "all" : selectedSources.join(", ")}`,
  ];
  const latestEventAtMs = (events || []).reduce((max, row) => {
    const ts = row?.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0;
    return Number.isFinite(ts) ? Math.max(max, ts) : max;
  }, 0);
  const syncMins = latestEventAtMs ? Math.floor((Date.now() - latestEventAtMs) / (1000 * 60)) : null;
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
  const syncTitle = latestEventAtMs ? `Exact sync: ${new Date(latestEventAtMs).toLocaleString()}` : "No sync timestamp";
  const sourceCandidates = ["meta", "facebook", "instagram", "google", "youtube", "tiktok", "bing", "whatsapp", "sms", "email", "direct"];
  const sourceOptions = sourceCandidates.filter((source) =>
    (events || []).some((alert) =>
      `${alert?.title || ""} ${alert?.message || ""}`.toLowerCase().includes(source)
    )
  );
  const isAllSources = selectedSources.includes("all");
  const updateSourcesInUrl = (nextSources) => {
    const params = new URLSearchParams(location.search);
    params.set("sources", (nextSources || ["all"]).join(","));
    if (!params.get("severity")) params.set("severity", severity);
    navigate(`/app/alerts?${params.toString()}`, { preventScrollReset: true });
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
  const filteredEvents = (events || []).filter((alert) => {
    const isRead = readOverrides[alert.id] ?? alert.isRead;
    if (quickFilter === "all") return true;
    if (quickFilter === "critical_unread") return alert.severity === "critical" && !isRead;
    if (quickFilter === "unread") return !isRead;
    if (quickFilter === "read") return isRead;
    return true;
  }).filter((alert) => {
    if (isAllSources) return true;
    const blob = `${alert?.title || ""} ${alert?.message || ""}`.toLowerCase();
    return selectedSources.some((source) => blob.includes(source));
  });

  useEffect(() => {
    setSelectedSources(selectedSourcesFromLoader || ["all"]);
  }, [selectedSourcesFromLoader]);

  useEffect(() => {
    setShowSkeleton(true);
    const timer = setTimeout(() => setShowSkeleton(false), 220);
    return () => clearTimeout(timer);
  }, [location.search]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem("nc_pinned_insights") || "[]");
    if (Array.isArray(saved)) setPinnedInsights(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 980px)");
    const readMode = () => {
      const saved = String(window.localStorage.getItem("nc_density_mode") || "auto").toLowerCase();
      return saved === "compact" || saved === "comfortable" ? saved : "auto";
    };
    const apply = (forcedMode) => {
      const mode = forcedMode || readMode();
      setDensityMode(mode);
      setTableDensity(mode === "auto" ? (media.matches ? "compact" : "comfortable") : mode);
    };
    apply();
    const onDensityChange = (event) => apply(event?.detail?.mode);
    media.addEventListener("change", apply);
    window.addEventListener("nc-density-change", onDensityChange);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("nc-density-change", onDensityChange);
    };
  }, []);
  useEffect(() => {
    if (Array.isArray(scheduledReports)) setSavedReports(scheduledReports);
  }, [scheduledReports]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem(savedViewsKey) || "[]");
    if (Array.isArray(saved)) setSavedViews(saved.slice(0, 20));
  }, [savedViewsKey]);
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
  const markReadOptimistic = (alertId, readValue) => {
    setReadOverrides((current) => ({ ...current, [alertId]: readValue }));
    const payload = new FormData();
    payload.append("intent", readValue ? "mark-read" : "mark-unread");
    payload.append("alertId", alertId);
    readFetcher.submit(payload, { method: "post" });
    trackUiEvent("alert_mark_read_toggled", { alertId, readValue });
    pushRowFeedback(`alert:${alertId}`, readValue ? "Marked read" : "Marked unread");
  };
  const selectAlertsView = (view) => {
    setActiveView(view);
    trackUiEvent("view_changed", { page: "alerts", view });
    const labels = { overview: "Overview", rules: "Rules", deep_dive: "Deep Dive" };
    setPresetToast(`${labels[view] || "View"} selected`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const onChangeView = (event) => selectAlertsView(String(event.target.value || "overview"));
  const onChangeQuickFilter = (event) => setQuickFilter(String(event.target.value || "all"));
  const showOverview = activeView === "overview";
  const showRules = activeView === "rules";
  const showDeepDive = activeView === "deep_dive";
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
    const label = reportDraft.name.trim() || `Alerts ${severity}`;
    const next = [...savedReports, { id: `rep-${Date.now()}`, label, config: { severity }, createdAt: new Date().toISOString() }].slice(-20);
    setSavedReports(next);
    setPresetToast("Report saved");
    trackUiEvent("report_saved", { page: "alerts", label });
    setTimeout(() => setPresetToast(""), 1400);
  };
  const scheduleExport = () => {
    if (!reportDraft.email) {
      setPresetToast("Add email to schedule export");
      setTimeout(() => setPresetToast(""), 1400);
      return;
    }
    const label = reportDraft.name.trim() || `Alerts ${severity}`;
    trackUiEvent("report_scheduled", { page: "alerts", frequency: reportDraft.frequency });
    const payload = new FormData();
    payload.append("intent", "create");
    payload.append("page", "alerts");
    payload.append("name", label);
    payload.append("frequency", reportDraft.frequency);
    payload.append("email", reportDraft.email);
    payload.append("format", "both");
    payload.append("filters", JSON.stringify({ severity, days: 30 }));
    scheduleFetcher.submit(payload, { method: "post", action: "/api/reports.schedule" });
  };
  const applyDensityMode = (mode) => {
    const normalized = mode === "compact" || mode === "comfortable" ? mode : "auto";
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nc_density_mode", normalized);
      window.dispatchEvent(new CustomEvent("nc-density-change", { detail: { mode: normalized } }));
    }
    setDensityMode(normalized);
  };
  const saveCurrentView = () => {
    const name = String(viewDraftName || "").trim() || `Alerts ${severity} ${quickFilter}`;
    const nextView = {
      id: `av-${Date.now()}`,
      name,
      severity,
      quickFilter,
      activeView,
      createdAt: new Date().toISOString(),
    };
    setSavedViews((current) => {
      const next = [nextView, ...current.filter((row) => row.name.toLowerCase() !== name.toLowerCase())].slice(0, 20);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(savedViewsKey, JSON.stringify(next));
      }
      return next;
    });
    setViewDraftName("");
    setPresetToast(`Saved view: ${name}`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const applySavedView = useCallback((view) => {
    if (!view) return;
    setQuickFilter(String(view.quickFilter || "all"));
    setActiveView(String(view.activeView || "overview"));
    const targetSeverity = String(view.severity || "all");
    navigate(`/app/alerts?severity=${encodeURIComponent(targetSeverity)}`, { preventScrollReset: true });
    setPresetToast(`Applied view: ${view.name || "Saved view"}`);
    setTimeout(() => setPresetToast(""), 1400);
  }, [navigate]);
  const deleteSavedView = (id) => {
    setSavedViews((current) => {
      const next = current.filter((row) => row.id !== id);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(savedViewsKey, JSON.stringify(next));
      }
      return next;
    });
    setPresetToast("Saved view removed");
    setTimeout(() => setPresetToast(""), 1400);
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(applyViewSessionKey);
    if (!raw) return;
    window.sessionStorage.removeItem(applyViewSessionKey);
    try {
      const view = JSON.parse(raw);
      applySavedView(view);
    } catch {
      // ignore invalid payload
    }
  }, [applyViewSessionKey, applySavedView]);

  return (
    <div className={`nc-shell nc-alerts ${tableDensity === "compact" ? "nc-density-compact" : ""}`}>
      {showSkeleton ? (
        <div className="nc-section">
          <div className="nc-skeleton nc-skeleton-title" />
          <div className="nc-skeleton nc-skeleton-card" />
        </div>
      ) : null}
      <h1>Alerts Center</h1>
      <p className="nc-subtitle">Auto-detected anomalies based on net cash, ROAS, spend and order trends.</p>
      <p className="nc-note" style={{ marginTop: "-8px" }}>
        Need period-to-period movement? Review <a href="/app?compare=1">Home Compare Mode</a>.
      </p>
      {Array.isArray(riskRadar) && riskRadar.length ? (
        <div className="nc-card nc-section nc-glass">
          <div className="nc-section-head-inline">
            <h2>Risk Radar</h2>
            <span className="nc-note">High-level health signals powered by guardrails.</span>
          </div>
          <div className="nc-grid-3">
            {riskRadar.map((row) => (
              <div key={`risk-${row.label}`} className="nc-soft-box">
                <strong>{row.label}</strong>
                <p className="nc-kpi-value">
                  {row.label.includes("%") ? pct(row.value) : row.label === "Creative Fatigue" ? row.value : pct(row.value)}
                </p>
                <p className="nc-note">Status: {row.status}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {Array.isArray(nextActions) && nextActions.length ? (
        <div className="nc-card nc-section nc-glass">
          <div className="nc-section-head-inline">
            <h2>Next Best Actions</h2>
            <span className="nc-note">Quick responses based on current risk signals.</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            {nextActions.map((action, idx) => <li key={`alert-action-${idx}`}>{action}</li>)}
          </ul>
          <div className="nc-toolbar" style={{ marginBottom: 0, marginTop: "10px" }}>
            <Link className="nc-chip" to="/app/campaigns">Open Campaigns</Link>
            <Link className="nc-chip" to="/app/intelligence">Open Intelligence</Link>
          </div>
        </div>
      ) : null}
      <div className="nc-toolbar nc-section nc-filter-bar" style={{ marginBottom: 0 }}>
        <label className="nc-form-field nc-inline-field">
          <span>View</span>
          <select value={activeView} onChange={onChangeView}>
            <option value="overview">Overview</option>
            <option value="rules">Rules</option>
            <option value="deep_dive">Deep Dive</option>
          </select>
        </label>
        <label className="nc-form-field nc-inline-field">
          <span>Quick filter</span>
          <select value={quickFilter} onChange={onChangeQuickFilter}>
            <option value="all">All alerts</option>
            <option value="critical_unread">Critical unread</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
        </label>
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
              <option key={`alerts-src-${item}`} value={item}>{item}</option>
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
        <label className="nc-form-field nc-inline-field">
          <span>Severity</span>
          <select
            value={severity}
            onChange={(event) => {
              const params = new URLSearchParams(location.search);
              params.set("severity", String(event.target.value || "all"));
              params.set("sources", (selectedSources || ["all"]).join(","));
              navigate(`/app/alerts?${params.toString()}`, { preventScrollReset: true });
            }}
          >
            {SEVERITIES.map((item) => (
              <option key={`severity-option-${item}`} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="nc-form-field nc-inline-field">
          <span>Saved view</span>
          <select
            value=""
            onChange={(event) => {
              const selected = savedViews.find((row) => row.id === String(event.target.value || ""));
              if (selected) applySavedView(selected);
            }}
          >
            <option value="">Select saved view</option>
            {savedViews.map((row) => (
              <option key={`alerts-view-${row.id}`} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
      </div>
      {multiSourceOpen ? (
        <div className="nc-card nc-section nc-glass">
          <h3 style={{ marginTop: 0 }}>Multi-source filter</h3>
          <div className="nc-source-picker-panel">
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
              <label key={`alerts-src-multi-${item}`} className="nc-inline-field">
                <input
                  type="checkbox"
                  checked={selectedSources.includes(item) && !isAllSources}
                  onChange={() => toggleSource(item)}
                />
                <span style={{ textTransform: "capitalize" }}>{item}</span>
              </label>
            ))}
            {sourceOptions.length === 0 ? <p className="nc-note">No source-specific alerts detected yet.</p> : null}
          </div>
        </div>
      ) : null}
      {presetToast ? <div className="nc-toast">{presetToast}</div> : null}
      <div className="nc-toolbar nc-section nc-applied-filter-row" style={{ marginBottom: 0 }}>
        {appliedFilterTokens.map((token) => (
          <span key={`alerts-filter-token-${token}`} className="nc-chip">{token}</span>
        ))}
      </div>
      <div className="nc-card nc-section nc-glass nc-alert-controls">
        <div className="nc-alert-controls-head">
          <button type="button" className="nc-icon-btn" onClick={() => {
            trackUiEvent("refresh_clicked", { page: "alerts" });
            revalidator.revalidate();
          }} disabled={revalidator.state === "loading"}>
            {revalidator.state === "loading" ? "Refreshing..." : "Refresh"}
          </button>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>
        <div className="nc-alert-controls-grid">
          <div className="nc-alert-control-group" aria-label="Alerts table density">
            <span className="nc-note">Density</span>
            <select value={densityMode} onChange={(event) => applyDensityMode(String(event.target.value || "auto"))}>
              <option value="auto">Auto</option>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
          <div className="nc-alert-control-group" aria-label="Alerts filter drawer">
            <span className="nc-note">Filters</span>
            <button type="button" className="nc-chip" onClick={() => setShowFilterDrawer((current) => !current)}>
              {showFilterDrawer ? "Hide drawer" : "Open drawer"}
            </button>
          </div>
        </div>
      </div>
      {showFilterDrawer ? (
        <div className="nc-card nc-section nc-glass nc-filter-drawer">
          <div className="nc-section-head-inline">
            <h3 style={{ margin: 0 }}>Filter Drawer</h3>
            <button
              type="button"
              className="nc-chip"
              onClick={() => {
                setQuickFilter("all");
                const params = new URLSearchParams(location.search);
                params.set("severity", "all");
                params.set("sources", (selectedSources || ["all"]).join(","));
                navigate(`/app/alerts?${params.toString()}`, { preventScrollReset: true });
              }}
            >
              Reset all filters
            </button>
          </div>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className={`nc-chip ${quickFilter === "all" ? "is-active" : ""}`} onClick={() => setQuickFilter("all")}>All</button>
            <button type="button" className={`nc-chip ${quickFilter === "critical_unread" ? "is-active" : ""}`} onClick={() => setQuickFilter("critical_unread")}>Critical unread</button>
            <button type="button" className={`nc-chip ${quickFilter === "unread" ? "is-active" : ""}`} onClick={() => setQuickFilter("unread")}>Unread</button>
            <button type="button" className={`nc-chip ${quickFilter === "read" ? "is-active" : ""}`} onClick={() => setQuickFilter("read")}>Read</button>
          </div>
          <div className="nc-grid-4">
            <label className="nc-form-field">Save current view
              <input value={viewDraftName} onChange={(event) => setViewDraftName(event.target.value)} placeholder="Name this alerts view" />
            </label>
            <div className="nc-form-field">
              <span>Actions</span>
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                <button type="button" className="nc-chip" onClick={saveCurrentView}>Save view</button>
                <button type="button" className="nc-chip" onClick={() => setShowFilterDrawer(false)}>Close drawer</button>
              </div>
            </div>
          </div>
          {savedViews.length ? (
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {savedViews.slice(0, 6).map((view) => (
                <span key={`alerts-view-pill-${view.id}`} className="nc-saved-view-pill">
                  <button type="button" className="nc-chip" onClick={() => applySavedView(view)}>{view.name}</button>
                  <button type="button" className="nc-chip" onClick={() => deleteSavedView(view.id)}>Delete</button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!permissions?.hasMetaConnector || !permissions?.hasGoogleConnector ? (
        <div className="nc-card nc-section nc-glass">
          <h3>Permission Check</h3>
          <p className="nc-note">Missing ad connectors can reduce anomaly quality.</p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {!permissions?.hasMetaConnector ? <a className="nc-chip" href="/app/integrations?wizard=1">Connect Meta</a> : null}
            {!permissions?.hasGoogleConnector ? <a className="nc-chip" href="/app/integrations?wizard=1">Connect Google</a> : null}
          </div>
        </div>
      ) : null}
      {showDeepDive ? <details className="nc-card nc-section nc-glass" open>
        <summary className="nc-details-summary">Saved Reports & Scheduled Export</summary>
        <div className="nc-section-head-inline">
          <h2>Saved Reports & Scheduled Export</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={saveReport}>Save Report</button>
            <button type="button" className="nc-chip" onClick={scheduleExport}>Schedule Export</button>
          </div>
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
            <li className="nc-note">No schedules yet. Do this next: add Email + Frequency and click `Schedule Export`.</li>
          ) : savedReports.slice(-6).map((row) => (
            <li key={row.id}>{row.label || row.name} {row.frequency ? `(${row.frequency} to ${row.email})` : ""}</li>
          ))}
        </ul>
      </details> : null}

      {showRules ? <div className="nc-card nc-section nc-glass" id="alert-rules">
        <div className="nc-section-head-inline">
          <h2>Rules</h2>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Rule</th>
              <th style={{ textAlign: "left" }}>Enabled</th>
              <th style={{ textAlign: "left" }}>Muted</th>
              <th style={{ textAlign: "left" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr className={rule.enabled ? (rule.muted ? "nc-row-severity-medium" : "nc-row-severity-low") : "nc-row-severity-high"} key={rule.key}>
                <td>{rule.label}</td>
                <td className={rule.enabled ? "nc-success" : "nc-danger"}>{rule.enabled ? "Yes" : "No"}</td>
                <td>{rule.muted ? `Until ${new Date(rule.mutedUntil).toLocaleString()}` : "No"}</td>
                <td>
                  <div className="nc-toolbar nc-rules-actions" style={{ marginBottom: 0 }}>
                    {rule.enabled ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="disable-rule" />
                        <input type="hidden" name="ruleKey" value={rule.key} />
                        <button type="submit" className="nc-btn-inline">Disable</button>
                      </Form>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="intent" value="enable-rule" />
                        <input type="hidden" name="ruleKey" value={rule.key} />
                        <button type="submit" className="nc-btn-inline">Enable</button>
                      </Form>
                    )}
                    {rule.muted ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="unmute-rule" />
                        <input type="hidden" name="ruleKey" value={rule.key} />
                        <button type="submit" className="nc-btn-inline">Unmute</button>
                      </Form>
                    ) : (
                      <Form method="post" className="nc-form-row nc-rules-mute-form">
                        <input type="hidden" name="intent" value="mute-rule" />
                        <input type="hidden" name="ruleKey" value={rule.key} />
                        <select name="days" defaultValue="7">
                          <option value="1">1 day</option>
                          <option value="7">7 days</option>
                          <option value="30">30 days</option>
                        </select>
                        <button type="submit" className="nc-btn-inline">Mute</button>
                      </Form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}

      {showOverview ? <div className="nc-card" id="alert-events">
        <div className="nc-section-head-inline">
          <h2>Events</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("alerts_events.csv", [
                  ["Time", "Severity", "Title", "Message", "Hits", "Read"],
                  ...filteredEvents.map((event) => [new Date(event.lastSeenAt).toLocaleString(), event.severity, event.title, event.message, event.hitCount, event.isRead ? "Yes" : "No"]),
                ])
              }
            >
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <p className="nc-muted" style={{ marginTop: 0 }}>
          New events generated this refresh: {evaluation?.created || 0}
        </p>
        <div className="nc-scroll">
          <table className="nc-table-card">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Time</th>
                <th style={{ textAlign: "left" }}>Severity</th>
                <th style={{ textAlign: "left" }}>Title</th>
                <th style={{ textAlign: "left" }}>Message</th>
                <th style={{ textAlign: "left" }}>Hits</th>
                <th style={{ textAlign: "left" }}>Read</th>
                <th style={{ textAlign: "left" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="nc-empty-state">
                      <div className="nc-empty-illus nc-empty-illus-alerts">N</div>
                      <div>No alerts for this quick filter.</div>
                      <div className="nc-empty-mini">Try severity = all and critical unread filter in the drawer.</div>
                      <a href="/app/alerts" className="nc-chip">Reset Filters</a>
                      <a href="/app/campaigns" className="nc-chip">Review Campaign Health</a>
                      <button type="button" className="nc-chip" onClick={() => setShowFilterDrawer(true)}>Open Filter Drawer</button>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredEvents.map((alert) => (
                  <tr className={alert.severity === "critical" ? "nc-row-severity-high" : alert.severity === "warning" ? "nc-row-severity-medium" : "nc-row-severity-low"} key={alert.id}>
                    <td>{new Date(alert.lastSeenAt).toLocaleString()}</td>
                    <td className={alert.severity === "critical" ? "nc-danger" : alert.severity === "warning" ? "nc-muted" : "nc-success"}>
                      {alert.severity}
                    </td>
                    <td>{alert.title}</td>
                    <td>{alert.message}</td>
                    <td>{alert.hitCount}</td>
                    <td>{(readOverrides[alert.id] ?? alert.isRead) ? "Yes" : "No"}</td>
                    <td>
                      <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                        {(readOverrides[alert.id] ?? alert.isRead) ? (
                          <button type="button" onClick={() => markReadOptimistic(alert.id, false)}>
                            Mark unread
                          </button>
                        ) : (
                          <button type="button" onClick={() => markReadOptimistic(alert.id, true)}>
                            Mark read
                          </button>
                        )}
                        <Link to="/app/campaigns" className="nc-chip">Review Campaigns</Link>
                        <button type="button" className="nc-chip" onClick={() => togglePin(`alert:${alert.id}`)}>
                          {pinnedInsights.includes(`alert:${alert.id}`) ? "Unpin" : "Pin"}
                        </button>
                      </div>
                      {rowFeedback[`alert:${alert.id}`] ? (
                        <div className="nc-inline-feedback">{rowFeedback[`alert:${alert.id}`]}</div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div> : null}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Something went wrong while loading Alerts.");
  return (
    <div className="nc-shell nc-alerts">
      <div className="nc-card nc-section">
        <h2>Alerts Unavailable</h2>
        <p className="nc-note">{message}</p>
        <a className="nc-chip" href="/app/alerts">Reload Alerts</a>
      </div>
    </div>
  );
}
