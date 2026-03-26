import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { trackUiEvent } from "../utils/telemetry.client";
import {
  createBudgetReallocationDecision,
  createCampaignActionItem,
  getBudgetReallocationSuggestions,
  getCampaignPerformance,
  getCampaignUserInsights,
  getCreativeFatigueRisks,
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
import { enqueueJob } from "../utils/job-queue.server";
import { isDevPreviewEnabled } from "../utils/dev-preview.server";

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
  const devPreview = isDevPreviewEnabled();
  const multiSourceEnabled = await isFeatureEnabledForShopAsync(session.shop, "campaign_multi_source_filters", true);
  const rawSourcesParam = multiSourceEnabled ? url.searchParams.get("sources") : null;
  const rawSourceParam = url.searchParams.get("source");
  const selectedSources = (rawSourcesParam || rawSourceParam || "all")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const normalizedSelectedSources = selectedSources.length ? [...new Set(selectedSources)] : ["all"];
  const effectiveSources = multiSourceEnabled ? normalizedSelectedSources : [normalizedSelectedSources[0] || "all"];
  const sourceForDownstream = normalizedSelectedSources.length === 1 ? normalizedSelectedSources[0] : "all";
  const planContext = await resolvePlanContext(
    billing,
    process.env.NODE_ENV !== "production",
    BILLING_PLANS,
    session.shop,
  );
  if (devPreview) {
    return {
      shop: session.shop,
      planContext,
      days,
      source: "all",
      selectedSources: effectiveSources,
      rollout: {
        multiSourceEnabled,
        channel: planContext?.release?.channel || "stable",
      },
      rows: [],
      sources: [],
      actionItems: [],
      creativeScores: [],
      creativeFatigue: [],
      budgetSuggestions: [],
      campaignUserInsights: [],
      budgetDecisions: [],
      permissions: {
        hasMetaConnector: false,
        hasGoogleConnector: false,
      },
      connectorSnapshotFallback: {
        lastSuccessAt: null,
        lastSuccessProvider: null,
        lastFailedAt: null,
        lastFailedProvider: null,
      },
      scheduledReports: [],
    };
  }
  const data = await getCampaignPerformance(session.shop, days, effectiveSources);
  const creativeScores = await getCreativePerformanceScores(session.shop, days, sourceForDownstream);
  const creativeFatigue = await getCreativeFatigueRisks(session.shop, days, sourceForDownstream);
  const budgetSuggestions = await getBudgetReallocationSuggestions(session.shop, days);
  const campaignUserInsights = await getCampaignUserInsights(session.shop, days, effectiveSources, 120);
  const connectors = await listConnectorCredentials(session.shop);
  const recentConnectorRuns = await getRecentConnectorSyncRuns(session.shop, 20);
  const lastConnectorSuccess = (recentConnectorRuns || []).find((row) => row.status === "success") || null;
  const lastConnectorFailure = (recentConnectorRuns || []).find((row) => row.status === "failed") || null;
  const autoHealEnabled = String(process.env.AUTO_CONNECTOR_SELF_HEAL_ENABLED || "true").toLowerCase() !== "false";
  const selfHealCooldownMins = Math.max(10, Number(process.env.AUTO_CONNECTOR_SELF_HEAL_COOLDOWN_MINUTES || 45));
  const staleThresholdMins = Math.max(30, Number(process.env.AUTO_CONNECTOR_STALE_MINUTES || 180));

  if (autoHealEnabled && connectors.length && !devPreview) {
    const nowMs = Date.now();
    const failedRecently = !!lastConnectorFailure && (nowMs - new Date(lastConnectorFailure.createdAt).getTime()) <= selfHealCooldownMins * 60 * 1000;
    const staleOrMissingSuccess = !lastConnectorSuccess || (nowMs - new Date(lastConnectorSuccess.createdAt).getTime()) > staleThresholdMins * 60 * 1000;

    if (failedRecently || staleOrMissingSuccess) {
      for (const credential of connectors) {
        const provider = String(credential?.provider || "").trim();
        if (!provider || !credential?.accessToken) continue;
        try {
          await enqueueJob({
            type: "connector_sync",
            shop: session.shop,
            payload: { shop: session.shop, provider, force: failedRecently, source: "campaigns_loader_auto_heal" },
            uniqueKey: `connector_sync:${session.shop}:${provider}`,
            maxAttempts: 5,
          });
        } catch (error) {
          console.error(`Failed to enqueue connector self-heal for ${session.shop} provider=${provider}:`, error);
        }
      }
    }
  }

  return {
    shop: session.shop,
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
    creativeFatigue,
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

  if (intent === "apply-autopilot-bundle") {
    const fromSource = String(formData.get("fromSource") || "");
    const fromCampaignId = String(formData.get("fromCampaignId") || "");
    const fromCampaignName = String(formData.get("fromCampaignName") || "");
    const toSource = String(formData.get("toSource") || "");
    const toCampaignId = String(formData.get("toCampaignId") || "");
    const toCampaignName = String(formData.get("toCampaignName") || "");
    const shiftPercent = Number(formData.get("shiftPercent") || 0);
    await createBudgetReallocationDecision(session.shop, {
      fromSource,
      fromCampaignId,
      fromCampaignName,
      toSource,
      toCampaignId,
      toCampaignName,
      shiftPercent,
      reason: "Autopilot bundle approved from campaign workspace",
      status: "approved",
      approvedBy: "autopilot_bundle",
    });
    await createCampaignActionItem(session.shop, {
      source: fromSource || "all",
      campaignId: fromCampaignId || null,
      campaignName: fromCampaignName || "Autopilot bundle",
      priority: "high",
      reason: "Autopilot budget shift executed",
      recommendedAction: `Shift ${Math.round(shiftPercent)}% budget from ${fromCampaignName || fromCampaignId || fromSource} to ${toCampaignName || toCampaignId || toSource}. Monitor for 24h.`,
    });
    return { ok: true, message: "Autopilot bundle applied and logged." };
  }

  if (intent === "create-rollback-log") {
    await createCampaignActionItem(session.shop, {
      source: formData.get("source") || "all",
      campaignId: formData.get("campaignId") || null,
      campaignName: formData.get("campaignName") || "Rollback",
      priority: "high",
      reason: formData.get("reason") || "Rollback requested",
      recommendedAction: formData.get("recommendedAction") || "Revert to prior baseline and observe for next 24h.",
    });
    return { ok: true, message: "Rollback action logged in queue." };
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
    shop,
    planContext,
    days,
    selectedSources,
    rows,
    sources,
    actionItems,
    creativeScores,
    creativeFatigue,
    budgetSuggestions,
    campaignUserInsights,
    budgetDecisions,
    permissions,
    connectorSnapshotFallback,
    scheduledReports,
  } = useLoaderData();
  const tierLabel = String(planContext?.tier || "basic").toUpperCase();
  const hasPro =
    !!planContext?.hasPro ||
    !!planContext?.hasPremium ||
    String(planContext?.tier || "").toLowerCase() === "premium";
  const actionData = useActionData();
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [activeView, setActiveView] = useState("overview");
  const [pinnedInsights, setPinnedInsights] = useState([]);
  const [presetToast, setPresetToast] = useState("");
  const [rowFeedback, setRowFeedback] = useState({});
  const [tableDensity, setTableDensity] = useState("comfortable");
  const [densityMode, setDensityMode] = useState("auto");
  const [quickFilter, setQuickFilter] = useState("all");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const [multiSourceOpen, setMultiSourceOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState({
    campaignId: true,
    items: true,
    gross: true,
    roas: true,
    lastOrder: true,
  });
  const [savedReports, setSavedReports] = useState(Array.isArray(scheduledReports) ? scheduledReports : []);
  const [reportDraft, setReportDraft] = useState({ name: "", frequency: "weekly", email: "" });
  const [savedViews, setSavedViews] = useState([]);
  const [viewDraftName, setViewDraftName] = useState("");
  const [visibleCampaignCount, setVisibleCampaignCount] = useState(120);
  const [visibleInsightCount, setVisibleInsightCount] = useState(80);
  const activeSources = Array.isArray(selectedSources) && selectedSources.length ? selectedSources : ["all"];
  const isAllSources = activeSources.includes("all");
  const queryFor = useCallback((newDays, newSources) => {
    const values = Array.isArray(newSources) ? newSources : [newSources];
    const normalized = values
      .map((row) => String(row || "").trim().toLowerCase())
      .filter(Boolean);
    const unique = normalized.length ? [...new Set(normalized)] : ["all"];
    if (unique.includes("all")) return `?days=${newDays}&sources=all`;
    return `?days=${newDays}&sources=${encodeURIComponent(unique.join(","))}`;
  }, []);
  const savedViewsKey = `nc_campaign_saved_views_${String(shop || "global").toLowerCase()}`;
  const applyViewSessionKey = `nc_campaign_apply_view_${String(shop || "global").toLowerCase()}`;
  const densitySummary = densityMode === "auto" ? `Auto (${tableDensity})` : tableDensity;
  const appliedFilterTokens = [
    `Window: ${days}d`,
    `View: ${activeView.replace("_", " ")}`,
    `Quick filter: ${quickFilter.replace("_", " ")}`,
    `Sources: ${isAllSources ? "all" : activeSources.join(", ")}`,
  ];
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
  const singleSourceValue =
    isAllSources ? "all" : activeSources.length === 1 ? activeSources[0] : "custom";
  const filteredSourceOptions = sources.filter((item) =>
    String(item || "").toLowerCase().includes(sourceSearch.toLowerCase()));
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
  const displayedCampaignRows = filteredRows.slice(0, visibleCampaignCount);
  const hasMoreCampaignRows = filteredRows.length > displayedCampaignRows.length;
  const displayedUserInsights = (campaignUserInsights || []).slice(0, visibleInsightCount);
  const hasMoreUserInsights = (campaignUserInsights || []).length > displayedUserInsights.length;
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
  const campaignsNeedsAction = filteredRows.filter((row) => row.orders > 0 && (row.realRoas < 1 || row.netCash < 0)).length;
  const campaignsHealthy = filteredRows.filter((row) => row.orders > 0 && row.realRoas >= 1 && row.netCash > 0).length;
  const totalFilteredNetCash = filteredRows.reduce((sum, row) => sum + Number(row.netCash || 0), 0);
  const avgFilteredRealRoas = filteredRows.length
    ? filteredRows.reduce((sum, row) => sum + Number(row.realRoas || 0), 0) / filteredRows.length
    : 0;
  const sparklineSeries = filteredRows.slice(0, 12).map((row) => Number(row.realRoas || 0));
  const sparkMax = Math.max(1, ...sparklineSeries);
  const campaignTableColumnCount =
    6 + (visibleColumns.campaignId ? 1 : 0) + (visibleColumns.items ? 1 : 0) + (visibleColumns.gross ? 1 : 0) + (visibleColumns.roas ? 1 : 0) + (visibleColumns.lastOrder ? 1 : 0);
  const emptyStateCta = (() => {
    if (quickFilter === "meta") return { label: "Connect Meta", href: "/app/integrations?wizard=1" };
    if (quickFilter === "winners") return { label: "Open Actions View", href: null };
    if (quickFilter === "needs_action") return { label: "Review Alerts", href: "/app/alerts?severity=warning" };
    return { label: "Setup Campaign Sources", href: "/app/integrations?wizard=1" };
  })();
  const applyDensityMode = (mode) => {
    const normalized = mode === "compact" || mode === "comfortable" ? mode : "auto";
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nc_density_mode", normalized);
      window.dispatchEvent(new CustomEvent("nc-density-change", { detail: { mode: normalized } }));
    }
    setDensityMode(normalized);
  };
  const applySavedView = useCallback((view) => {
    if (!view || typeof view !== "object") return;
    const nextDays = DAY_OPTIONS.includes(Number(view.days)) ? Number(view.days) : days;
    const nextSources = Array.isArray(view.sources) && view.sources.length ? view.sources : ["all"];
    const nextQuickFilter = String(view.quickFilter || "all");
    const nextActiveView = String(view.activeView || "overview");
    const nextColumns = view.visibleColumns && typeof view.visibleColumns === "object" ? view.visibleColumns : null;
    setQuickFilter(nextQuickFilter);
    setActiveView(nextActiveView);
    if (nextColumns) setVisibleColumns((current) => ({ ...current, ...nextColumns }));
    navigate(queryFor(nextDays, nextSources), { preventScrollReset: true });
    setPresetToast(`Applied view: ${view.name || "Saved view"}`);
    setTimeout(() => setPresetToast(""), 1400);
  }, [days, navigate, queryFor]);
  const saveCurrentView = () => {
    const name = String(viewDraftName || "").trim() || `Campaigns ${days}d ${quickFilter}`;
    const nextView = {
      id: `cv-${Date.now()}`,
      name,
      days,
      sources: isAllSources ? ["all"] : activeSources,
      quickFilter,
      activeView,
      visibleColumns,
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
    setShowSkeleton(true);
    const timer = setTimeout(() => setShowSkeleton(false), 240);
    return () => clearTimeout(timer);
  }, [location.search]);
  useEffect(() => {
    setVisibleCampaignCount(120);
    setVisibleInsightCount(80);
  }, [days, quickFilter, selectedSources]);
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
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem(savedViewsKey) || "[]");
    if (Array.isArray(saved)) setSavedViews(saved.slice(0, 20));
  }, [savedViewsKey]);
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
  useEffect(() => {
    if (Array.isArray(scheduledReports)) setSavedReports(scheduledReports);
  }, [scheduledReports]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem("nc_campaign_columns") || "null");
    if (!saved || typeof saved !== "object") return;
    setVisibleColumns((current) => ({ ...current, ...saved }));
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("nc_campaign_columns", JSON.stringify(visibleColumns));
  }, [visibleColumns]);
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
  const selectCampaignView = (view) => {
    setActiveView(view);
    trackUiEvent("view_changed", { page: "campaigns", view });
    const labels = { overview: "Overview", actions: "Actions", deep_dive: "Deep Dive" };
    setPresetToast(`${labels[view] || "View"} selected`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const onChangeView = (event) => selectCampaignView(String(event.target.value || "overview"));
  const onChangeQuickFilter = (event) => setQuickFilter(String(event.target.value || "all"));
  const onChangeWindow = (event) => {
    const nextDays = Number(event.target.value || days);
    if (!DAY_OPTIONS.includes(nextDays)) return;
    navigate(queryFor(nextDays, activeSources), { preventScrollReset: true });
  };
  const showOverview = activeView === "overview";
  const showActions = activeView === "actions";
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
        <div className="nc-campaign-header-meta">
          <span className={`nc-fresh-badge nc-sync-${syncStatus}`} title={syncTitle}>
            Last updated: {latestCampaignAtMs ? new Date(latestCampaignAtMs).toLocaleString() : "No sync yet"}
          </span>
          <div className="nc-plan-pill">Plan: {tierLabel}</div>
        </div>
      </div>
      <p className="nc-subtitle">
        Compare campaign quality using gross revenue, net cash, ROAS <span className="nc-tip-icon" title="Revenue divided by ad spend.">?</span>, and Real ROAS <span className="nc-tip-icon" title="Net-cash aware ROAS after returns and cost impact.">?</span>.
      </p>
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
      <div className="nc-toolbar nc-section nc-filter-bar" style={{ marginBottom: 0 }}>
        <label className="nc-form-field nc-inline-field">
          <span>View</span>
          <select value={activeView} onChange={onChangeView}>
            <option value="overview">Overview</option>
            <option value="actions">Actions</option>
            <option value="deep_dive">Deep Dive</option>
          </select>
        </label>
        <label className="nc-form-field nc-inline-field">
          <span>Quick filter</span>
          <select value={quickFilter} onChange={onChangeQuickFilter}>
            <option value="all">All campaigns</option>
            <option value="needs_action">Needs action</option>
            <option value="winners">Top winners</option>
            <option value="meta">Meta only</option>
          </select>
        </label>
        <label className="nc-form-field nc-inline-field">
          <span>Saved view</span>
          <select
            value=""
            onChange={(event) => {
              const nextId = String(event.target.value || "");
              if (!nextId) return;
              const nextView = savedViews.find((row) => row.id === nextId);
              if (nextView) applySavedView(nextView);
            }}
          >
            <option value="">Select saved view</option>
            {savedViews.map((row) => (
              <option key={`saved-view-${row.id}`} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="nc-note" style={{ marginTop: "6px", marginBottom: 0 }}>
        Tip: Save a view to re-open the same window, filters, and columns in one click.
      </p>
      <div className="nc-card nc-section nc-glass nc-campaign-kpis">
        <div className="nc-campaign-kpi">
          <span>Campaigns (filtered)</span>
          <strong>{filteredRows.length}</strong>
        </div>
        <div className="nc-campaign-kpi">
          <span>Need action</span>
          <strong>{campaignsNeedsAction}</strong>
        </div>
        <div className="nc-campaign-kpi">
          <span>Healthy</span>
          <strong>{campaignsHealthy}</strong>
        </div>
        <div className="nc-campaign-kpi">
          <span>Net cash (filtered)</span>
          <strong>{money(totalFilteredNetCash)}</strong>
        </div>
        <div className="nc-campaign-kpi">
          <span>Avg real ROAS</span>
          <strong>{avgFilteredRealRoas.toFixed(2)}x</strong>
          <div className="nc-sparkline" aria-hidden="true">
            {sparklineSeries.map((value, idx) => (
              <span key={`spark-${idx}`} style={{ height: `${Math.max(12, (value / sparkMax) * 100)}%` }} />
            ))}
          </div>
        </div>
      </div>
      {showOverview ? (
        <div className="nc-card nc-section nc-campaign-primary-actions">
          <button
            type="button"
            className="nc-icon-btn"
            onClick={() => {
              trackUiEvent("refresh_clicked", { page: "campaigns" });
              revalidator.revalidate();
            }}
            disabled={revalidator.state === "loading"}
          >
            {revalidator.state === "loading" ? "Refreshing..." : "Refresh"}
          </button>
          <details className="nc-row-actions">
            <summary>More actions</summary>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="nc-chip"
                onClick={() =>
                  exportCsvFile("all_campaigns.csv", [
                    ["Source", "Campaign", "Campaign ID", "Orders", "Net Cash", "Real ROAS"],
                    ...filteredRows.map((row) => [row.source, row.campaignName || "Unmapped", row.campaignId || "-", row.orders, row.netCash, row.realRoas]),
                  ])
                }
              >
                Export
              </button>
              <button type="button" className="nc-chip" onClick={() => setShowAdvancedFilters((current) => !current)}>
                {showAdvancedFilters ? "Hide filter drawer" : "Open filter drawer"}
              </button>
            </div>
          </details>
        </div>
      ) : null}
      <div className="nc-toolbar nc-section nc-applied-filter-row" style={{ marginBottom: 0 }}>
        {appliedFilterTokens.map((item) => (
          <span key={`applied-filter-${item}`} className="nc-chip">{item}</span>
        ))}
      </div>
      {showAdvancedFilters ? (
        <div className="nc-card nc-section nc-glass nc-filter-drawer">
          <div className="nc-section-head-inline">
            <h3 style={{ margin: 0 }}>Filter Drawer</h3>
            <button
              type="button"
              className="nc-chip"
              onClick={() => {
                setQuickFilter("all");
                navigate(queryFor(days, ["all"]), { preventScrollReset: true });
                setSourceSearch("");
              }}
            >
              Reset all filters
            </button>
          </div>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className={`nc-chip ${quickFilter === "all" ? "is-active" : ""}`} onClick={() => setQuickFilter("all")}>All</button>
            <button type="button" className={`nc-chip ${quickFilter === "needs_action" ? "is-active" : ""}`} onClick={() => setQuickFilter("needs_action")}>Needs action</button>
            <button type="button" className={`nc-chip ${quickFilter === "winners" ? "is-active" : ""}`} onClick={() => setQuickFilter("winners")}>Winners</button>
            <button type="button" className={`nc-chip ${quickFilter === "meta" ? "is-active" : ""}`} onClick={() => setQuickFilter("meta")}>Meta</button>
          </div>
          <div className="nc-grid-4">
            <label className="nc-form-field">Save current view
              <input
                value={viewDraftName}
                onChange={(event) => setViewDraftName(event.target.value)}
                placeholder="Name this filter view"
              />
            </label>
            <div className="nc-form-field">
              <span>Actions</span>
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                <button type="button" className="nc-chip" onClick={saveCurrentView}>Save view</button>
                <button type="button" className="nc-chip" onClick={() => setShowAdvancedFilters(false)}>Close drawer</button>
              </div>
            </div>
          </div>
          {savedViews.length ? (
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {savedViews.slice(0, 6).map((view) => (
                <span key={`saved-view-chip-${view.id}`} className="nc-saved-view-pill">
                  <button type="button" className="nc-chip" onClick={() => applySavedView(view)}>{view.name}</button>
                  <button type="button" className="nc-chip" onClick={() => deleteSavedView(view.id)}>Delete</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="nc-note" style={{ marginBottom: 0 }}>No saved views yet. Save your most-used filter combinations here.</p>
          )}
        </div>
      ) : null}
      {presetToast ? <div className="nc-toast">{presetToast}</div> : null}
      {actionData?.message ? <p className={actionData.ok ? "nc-success" : "nc-danger"}>{actionData.message}</p> : null}
      <div className="nc-card nc-section nc-glass nc-campaign-controls">
        <div className="nc-campaign-controls-head">
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>

        <div className="nc-campaign-controls-grid">
          <div className="nc-campaign-control-group">
            <span className="nc-note">Window</span>
            <select value={days} onChange={onChangeWindow}>
              {DAY_OPTIONS.map((option) => (
                <option key={`days-option-${option}`} value={option}>{option}d</option>
              ))}
            </select>
          </div>

          <div className="nc-campaign-control-group">
            <span className="nc-note">Source</span>
            <select
              value={singleSourceValue}
              onChange={(event) => {
                const next = String(event.target.value || "all");
                if (next === "custom") return;
                navigate(queryFor(days, [next]), { preventScrollReset: true });
              }}
            >
              <option value="all">All sources</option>
              {sources.map((item) => (
                <option key={`source-option-${item}`} value={item}>
                  {String(item || "").replace(/_/g, " ")}
                </option>
              ))}
              {singleSourceValue === "custom" ? <option value="custom">Multiple selected</option> : null}
            </select>
            <button
              type="button"
              className={`nc-chip ${multiSourceOpen ? "is-active" : ""}`}
              onClick={() => setMultiSourceOpen((current) => !current)}
              style={{ marginTop: "6px", justifyContent: "center" }}
            >
              {multiSourceOpen ? "Hide multi-select" : "Multi-select"}
            </button>
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
                  <label key={`source-multi-${item}`} className="nc-inline-field">
                    <input
                      type="checkbox"
                      checked={activeSources.includes(item) && !isAllSources}
                      onChange={() => toggleSource(item)}
                    />
                    <span style={{ textTransform: "capitalize" }}>{item}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          <div className="nc-campaign-control-group">
            <span className="nc-note">Columns</span>
            <details className="nc-source-picker">
              <summary>Display columns</summary>
              <div className="nc-source-picker-panel">
                {[
                  ["campaignId", "Campaign ID"],
                  ["items", "Items"],
                  ["gross", "Gross"],
                  ["roas", "ROAS"],
                  ["lastOrder", "Last order"],
                ].map(([key, label]) => (
                  <label key={`column-${key}`} className="nc-inline-field">
                    <input
                      type="checkbox"
                      checked={!!visibleColumns[key]}
                      onChange={() => setVisibleColumns((current) => ({ ...current, [key]: !current[key] }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>

          <div className="nc-campaign-control-group">
            <span className="nc-note">Density mode</span>
            <select value={densityMode} onChange={(event) => applyDensityMode(String(event.target.value || "auto"))}>
              <option value="auto">Auto</option>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>

          <span className="nc-fresh-badge" title="Set default from Menu > Display Density">
            Density: {densitySummary}
          </span>
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
      {showActions ? <div className="nc-card nc-section nc-glass">
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
      </div> : null}
      {showActions && hasPro && budgetSuggestions.length > 0 ? (
        <div className="nc-card nc-section nc-glass">
          <h2>Autopilot Control</h2>
          <p className="nc-note">Safe apply with rollback audit log for top recommendation.</p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="apply-autopilot-bundle" />
              <input type="hidden" name="fromSource" value={budgetSuggestions[0]?.fromSource || ""} />
              <input type="hidden" name="fromCampaignId" value={budgetSuggestions[0]?.fromCampaignId || ""} />
              <input type="hidden" name="fromCampaignName" value={budgetSuggestions[0]?.fromCampaignName || ""} />
              <input type="hidden" name="toSource" value={budgetSuggestions[0]?.toSource || ""} />
              <input type="hidden" name="toCampaignId" value={budgetSuggestions[0]?.toCampaignId || ""} />
              <input type="hidden" name="toCampaignName" value={budgetSuggestions[0]?.toCampaignName || ""} />
              <input type="hidden" name="shiftPercent" value={String(budgetSuggestions[0]?.shiftPercent || 0)} />
              <button type="submit" className="nc-chip">Apply top bundle</button>
            </Form>
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="create-rollback-log" />
              <input type="hidden" name="source" value={budgetSuggestions[0]?.fromSource || ""} />
              <input type="hidden" name="campaignId" value={budgetSuggestions[0]?.fromCampaignId || ""} />
              <input type="hidden" name="campaignName" value={budgetSuggestions[0]?.fromCampaignName || ""} />
              <input type="hidden" name="reason" value="Rollback prepared for top autopilot shift" />
              <input type="hidden" name="recommendedAction" value="Rollback to prior baseline if net cash trend degrades in 24h." />
              <button type="submit" className="nc-chip">Log rollback plan</button>
            </Form>
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
            <li className="nc-note">No schedules yet. Do this next: choose Daily/Weekly + email, then click `Schedule Export`.</li>
          ) : savedReports.slice(-6).map((row) => (
            <li key={row.id}>{row.label || row.name} {row.frequency ? `(${row.frequency} to ${row.email})` : ""}</li>
          ))}
        </ul>
      </details> : null}

      {showOverview ? <div className="nc-card nc-section nc-glass" id="campaign-stop-list">
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
                    <div className="nc-empty-mini">Try Needs action view or broaden source selection.</div>
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
                    <details className="nc-row-actions">
                      <summary>Actions</summary>
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
                    </details>
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

      {hasPro ? <div className="nc-card nc-section nc-glass" id="budget-reallocation">
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
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {hasPro ? <div className="nc-card nc-section nc-glass" id="campaign-action-queue">
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
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {hasPro ? <div className="nc-card nc-section nc-glass" id="creative-fatigue">
        <h2>Creative Fatigue Watchlist</h2>
        <p className="nc-note">Flags CTR decay vs prior week with frequency/spend thresholds. Sync Meta/Google to populate creative metrics.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Creative</th>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "right" }}>CTR (7d)</th>
              <th style={{ textAlign: "right" }}>CTR Δ</th>
              <th style={{ textAlign: "right" }}>Frequency</th>
              <th style={{ textAlign: "right" }}>Spend (7d)</th>
              <th style={{ textAlign: "right" }}>Age</th>
              <th style={{ textAlign: "left" }}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {(creativeFatigue || []).length === 0 ? (
              <tr><td colSpan={8}>No fatigue signals yet. Connect Meta/Google and sync creatives to populate.</td></tr>
            ) : (
              creativeFatigue.slice(0, 20).map((row) => (
                <tr key={`fatigue-${row.source}-${row.adId}`}>
                  <td data-label="Creative">{row.adName || row.adId || "Unmapped"}</td>
                  <td data-label="Source">{row.source}</td>
                  <td data-label="CTR (7d)" style={{ textAlign: "right" }}>{(Number(row.recentCtr || 0) * 100).toFixed(2)}%</td>
                  <td data-label="CTR Δ" style={{ textAlign: "right" }}>{Number(row.ctrDeltaPct || 0).toFixed(1)}%</td>
                  <td data-label="Frequency" style={{ textAlign: "right" }}>{row.frequencyAvg == null ? "-" : Number(row.frequencyAvg).toFixed(2)}</td>
                  <td data-label="Spend (7d)" style={{ textAlign: "right" }}>{money(row.recentSpend || 0)}</td>
                  <td data-label="Age" style={{ textAlign: "right" }}>{Number(row.ageDays || 0)}d</td>
                  <td data-label="Recommendation">{row.recommendation}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : (
        <div className="nc-card nc-section" id="creative-fatigue">
          <h2>Creative Fatigue Watchlist</h2>
          <p className="nc-note">Upgrade to Pro to unlock creative fatigue detection.</p>
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {hasPro ? <div className="nc-card nc-section nc-glass">
        <h2>Campaign Action Queue</h2>
        <p className="nc-note">Track recommendations and decide what to pause, reduce, or monitor.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Type</th>
              <th style={{ textAlign: "left" }}>Priority</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {openItems.length === 0 ? (
              <tr><td colSpan={6}>No open actions.</td></tr>
            ) : (
              openItems.slice(0, 12).map((item) => {
                const isFatigue = String(item?.reason || "").toLowerCase().includes("creative fatigue");
                return (
                <tr key={`action-${item.id}`}>
                  <td data-label="Campaign">
                    {item.campaignName || item.campaignId || "Unmapped"}
                    {isFatigue ? <span className="nc-badge nc-badge-default" style={{ marginLeft: "8px" }}>Creative fatigue</span> : null}
                  </td>
                  <td data-label="Source">{item.source}</td>
                  <td data-label="Type">{isFatigue ? "creative" : "campaign"}</td>
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
              );
            })
            )}
          </tbody>
        </table>
      </div> : (
        <div className="nc-card nc-section" id="campaign-action-queue">
          <h2>Campaign Action Queue</h2>
          <p className="nc-note">Upgrade to Pro to unlock action queue tracking for underperforming campaigns.</p>
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      )}

      {showOverview ? <div className="nc-card nc-scroll nc-glass nc-campaign-premium-wrap" id="campaign-table">
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
        <p className="nc-note" style={{ marginTop: 0 }}>Showing {displayedCampaignRows.length} of {filteredRows.length} campaigns.</p>
        <table className="nc-campaign-premium-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ padding: "12px", textAlign: "left" }}>Source</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Campaign</th>
              {visibleColumns.campaignId ? <th style={{ padding: "12px", textAlign: "left" }}>Campaign ID</th> : null}
              <th style={{ padding: "12px", textAlign: "right" }}>Orders</th>
              {visibleColumns.items ? <th style={{ padding: "12px", textAlign: "right" }}>Items</th> : null}
              {visibleColumns.gross ? <th style={{ padding: "12px", textAlign: "right" }}>Gross</th> : null}
              <th style={{ padding: "12px", textAlign: "right" }}>Net Cash</th>
              {visibleColumns.roas ? <th style={{ padding: "12px", textAlign: "right" }}>ROAS</th> : null}
              <th style={{ padding: "12px", textAlign: "right" }}>Real ROAS</th>
              {visibleColumns.lastOrder ? <th style={{ padding: "12px", textAlign: "left" }}>Last Order</th> : null}
              <th style={{ padding: "12px", textAlign: "left" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={campaignTableColumnCount} style={{ padding: "12px" }}>
                    <div className="nc-empty-state">
                      <div className="nc-empty-illus nc-empty-illus-campaigns">C</div>
                      <div>No campaigns match this filter set.</div>
                      <div className="nc-empty-mini">
                        Active: {quickFilter.replace("_", " ")} | Sources: {isAllSources ? "all" : activeSources.join(", ")} | {days}d
                      </div>
                      <Link to="/app/campaigns" className="nc-chip" preventScrollReset>Reset Filters</Link>
                      {emptyStateCta.href ? (
                        <Link to={emptyStateCta.href} className="nc-chip" preventScrollReset>{emptyStateCta.label}</Link>
                      ) : (
                        <button type="button" className="nc-chip" onClick={() => setActiveView("actions")}>{emptyStateCta.label}</button>
                      )}
                      <button type="button" className="nc-chip" onClick={() => setShowAdvancedFilters(true)}>Open Filter Drawer</button>
                    </div>
                  </td>
                </tr>
            ) : (
              displayedCampaignRows.map((row) => (
                <tr className={`nc-campaign-premium-row nc-row-severity-${rowSeverityFromCampaign(row)}`} key={`${row.source}-${row.campaignId}-${row.campaignName}`} style={{ borderBottom: "1px solid #e0e0e0" }}>
                  <td style={{ padding: "12px", textTransform: "capitalize" }}>{row.source}</td>
                  <td style={{ padding: "12px" }}>{row.campaignName || "Unmapped"}</td>
                  {visibleColumns.campaignId ? <td style={{ padding: "12px" }}>{row.campaignId || "-"}</td> : null}
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.orders}</td>
                  {visibleColumns.items ? <td style={{ padding: "12px", textAlign: "right" }}>{row.itemUnits}</td> : null}
                  {visibleColumns.gross ? <td style={{ padding: "12px", textAlign: "right" }}>{money(row.grossRevenue)}</td> : null}
                  <td style={{ padding: "12px", textAlign: "right", fontWeight: "bold" }}>{money(row.netCash)}</td>
                  {visibleColumns.roas ? <td style={{ padding: "12px", textAlign: "right" }}>{row.roas.toFixed(2)}x</td> : null}
                  <td style={{ padding: "12px", textAlign: "right" }}>{row.realRoas.toFixed(2)}x</td>
                  {visibleColumns.lastOrder ? (
                    <td style={{ padding: "12px" }}>
                      {row.lastOrderAt ? new Date(row.lastOrderAt).toLocaleDateString() : "-"}
                    </td>
                  ) : null}
                  <td style={{ padding: "12px" }}>
                    <details className="nc-row-actions">
                      <summary>Actions</summary>
                      <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                        {row.orders > 0 && (row.realRoas < 1 || row.netCash < 0) ? (
                          <button
                            type="button"
                            className="nc-chip"
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
                        <Link to="/app/alerts?severity=warning" preventScrollReset className="nc-chip">Open Alerts</Link>
                        <button type="button" className="nc-chip" onClick={() => togglePin(`campaign:${row.source}:${row.campaignId || row.campaignName}`)}>
                          {pinnedInsights.includes(`campaign:${row.source}:${row.campaignId || row.campaignName}`) ? "Unpin" : "Pin"}
                        </button>
                      </div>
                    </details>
                    {rowFeedback[`queue:${row.source}:${row.campaignId || row.campaignName}`] ? (
                      <div className="nc-inline-feedback">{rowFeedback[`queue:${row.source}:${row.campaignId || row.campaignName}`]}</div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {hasMoreCampaignRows ? (
          <div className="nc-toolbar" style={{ marginTop: "10px", marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={() => setVisibleCampaignCount((current) => Math.min(filteredRows.length, current + 100))}>
              Load 100 more
            </button>
            <button type="button" className="nc-chip" onClick={() => setVisibleCampaignCount(filteredRows.length)}>
              Load all visible rows
            </button>
          </div>
        ) : null}
      </div> : null}

      {showDeepDive ? <details className="nc-card nc-section nc-glass" id="campaign-user-truth">
        <summary className="nc-details-summary">Campaign to User Netcash Truth</summary>
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
        <p className="nc-note">Showing {displayedUserInsights.length} of {(campaignUserInsights || []).length} user-truth rows.</p>
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
              displayedUserInsights.map((row) => (
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
        {hasMoreUserInsights ? (
          <div className="nc-toolbar" style={{ marginTop: "10px", marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={() => setVisibleInsightCount((current) => Math.min((campaignUserInsights || []).length, current + 80))}>
              Load 80 more truth rows
            </button>
          </div>
        ) : null}
      </details> : null}
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
