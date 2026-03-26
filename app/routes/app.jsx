import { redirect } from "@remix-run/node";
import { Link, NavLink, Outlet, useLoaderData, useLocation, useNavigate, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { trackUiEvent } from "../utils/telemetry.client";
import { listConnectorCredentials, getRecentConnectorSyncRuns, prisma } from "../utils/db.server";
import { enqueueJob, ensureJobQueueTable } from "../utils/job-queue.server";
import { resolvePlanContext } from "../utils/plan.server";
import { resolveOnboardingGuide } from "../utils/onboarding-guide.server";
import { isDevPreviewEnabled } from "../utils/dev-preview.server";
import { getEmbeddedPassthrough, withEmbeddedContext } from "../utils/embedded-nav";
import netcashStyles from "../styles/netcash.css?url";

export const links = () => [{ rel: "stylesheet", href: netcashStyles }];

function sanitizeRouteForRecent(pathname, search) {
  const allowed = new Set(["days", "source", "severity", "compare", "view", "qf"]);
  const params = new URLSearchParams(search || "");
  const filtered = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (allowed.has(key)) filtered.set(key, value);
  }
  const query = filtered.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function sanitizeRecentHref(href) {
  try {
    const url = new URL(href, "https://netcash.local");
    if (!url.pathname.startsWith("/app")) return null;

    const badParams = ["hmac", "host", "id_token", "session", "timestamp", "embedded", "token"];
    if (badParams.some((param) => url.searchParams.has(param))) {
      return sanitizeRouteForRecent(url.pathname, url.search);
    }

    const sanitized = sanitizeRouteForRecent(url.pathname, url.search);
    if (sanitized.length > 180) return sanitizeRouteForRecent(url.pathname, "");
    return sanitized;
  } catch {
    return null;
  }
}

function prettyRecentLabel(href) {
  try {
    const url = new URL(href, "https://netcash.local");
    const path = url.pathname;
    const section =
      path === "/app" ? "Home"
        : path.startsWith("/app/campaigns") ? "Campaigns"
          : path.startsWith("/app/alerts") ? "Alerts"
      : path.startsWith("/app/universal") ? "Universal Insights"
      : path.startsWith("/app/autopilot") ? "Autopilot"
      : path.startsWith("/app/integrations") ? "Integrations"
      : path.startsWith("/app/billing") ? "Billing"
        : path.startsWith("/app/intelligence") ? "Intelligence"
        : path.startsWith("/app/additional") ? "Connectors"
          : path.startsWith("/app/settings") ? "Settings"
            : "Workspace";
    const tags = [];
    const days = url.searchParams.get("days");
    const source = url.searchParams.get("source");
    const severity = url.searchParams.get("severity");
    if (days) tags.push(`${days}d`);
    if (source) tags.push(source);
    if (severity) tags.push(severity);
    return tags.length ? `${section} | ${tags.join(" | ")}` : section;
  } catch {
    return "Workspace";
  }
}


function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function getLatestJobCreatedAt({ type, shop = null }) {
  await ensureJobQueueTable();
  const safeType = String(type || "").trim();
  if (!safeType) return null;
  const whereShop = shop ? ` AND shop = ${sqlQuote(String(shop).trim().toLowerCase())} ` : "";
  const rows = await prisma.$queryRawUnsafe(
    `SELECT MAX(created_at) as createdAt
     FROM job_queue
     WHERE type = ${sqlQuote(safeType)}
     ${whereShop}`,
  );
  return rows?.[0]?.createdAt || null;
}

function isOlderThanMinutes(isoValue, minutes) {
  if (!isoValue) return true;
  const ts = new Date(isoValue).getTime();
  if (!Number.isFinite(ts)) return true;
  return (Date.now() - ts) > minutes * 60 * 1000;
}

function pathOnly(href = "/app") {
  const [path] = String(href || "/app").split("?");
  return path || "/app";
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const { billing, session } = await authenticate.admin(request);
  const isProduction = process.env.NODE_ENV === "production";
  const devPreview = isDevPreviewEnabled();
  const panelParam = String(url.searchParams.get("panel") || "").toLowerCase();
  const initialPanel =
    panelParam === "more" || panelParam === "glossary" || panelParam === "notifications"
      ? panelParam
      : null;

  const isBillingRoute = url.pathname.startsWith("/app/billing");
  if (isProduction && !isBillingRoute) {
    await billing.require({
      plans: BILLING_PLANS,
      isTest: !isProduction,
      onFailure: async () => redirect(`/app/billing${url.search}`),
    });
  }

  const autoDaemonEnabled = String(process.env.AUTO_SELF_HEAL_DAEMON_ENABLED || "true").toLowerCase() !== "false";
  if (autoDaemonEnabled && session?.shop && !devPreview) {
    const shop = String(session.shop || "").trim().toLowerCase();
    const connectorCooldownMins = Math.max(10, Number(process.env.AUTO_CONNECTOR_SELF_HEAL_COOLDOWN_MINUTES || 45));
    const connectorStaleMins = Math.max(30, Number(process.env.AUTO_CONNECTOR_STALE_MINUTES || 180));
    const reportsCooldownMins = Math.max(15, Number(process.env.AUTO_REPORTS_SELF_HEAL_COOLDOWN_MINUTES || 60));
    const truthCooldownMins = Math.max(15, Number(process.env.AUTO_TRUTH_SELF_HEAL_COOLDOWN_MINUTES || 90));

    try {
      const [connectors, recentConnectorRuns] = await Promise.all([
        listConnectorCredentials(shop),
        getRecentConnectorSyncRuns(shop, 20),
      ]);
      const lastConnectorSuccess = (recentConnectorRuns || []).find((row) => row.status === "success") || null;
      const lastConnectorFailure = (recentConnectorRuns || []).find((row) => row.status === "failed") || null;
      const failedRecently = !!lastConnectorFailure && !isOlderThanMinutes(lastConnectorFailure.createdAt, connectorCooldownMins);
      const staleOrMissingSuccess = !lastConnectorSuccess || isOlderThanMinutes(lastConnectorSuccess.createdAt, connectorStaleMins);

      if ((failedRecently || staleOrMissingSuccess) && connectors.length) {
        for (const credential of connectors) {
          const provider = String(credential?.provider || "").trim();
          if (!provider || !credential?.accessToken) continue;
          await enqueueJob({
            type: "connector_sync",
            shop,
            payload: { shop, provider, force: failedRecently, source: "app_loader_daemon" },
            uniqueKey: `connector_sync:${shop}:${provider}`,
            maxAttempts: 5,
          });
        }
      }

      const [lastReportsJobAt, lastTruthJobAt] = await Promise.all([
        getLatestJobCreatedAt({ type: "reports_run_due" }),
        getLatestJobCreatedAt({ type: "truth_rollup_refresh", shop }),
      ]);

      if (isOlderThanMinutes(lastReportsJobAt, reportsCooldownMins)) {
        await enqueueJob({
          type: "reports_run_due",
          payload: { source: "app_loader_daemon", shopHint: shop },
          uniqueKey: "reports_run_due",
          maxAttempts: 5,
        });
      }

      if (isOlderThanMinutes(lastTruthJobAt, truthCooldownMins)) {
        await enqueueJob({
          type: "truth_rollup_refresh",
          shop,
          payload: { shop, source: "app_loader_daemon" },
          uniqueKey: `truth_rollup_refresh:${shop}`,
          maxAttempts: 5,
        });
      }
    } catch (error) {
      console.error(`Self-heal daemon failed for ${shop}:`, error);
    }
  }

  let onboarding = null;
  const onboardingAutoguideEnabled = String(process.env.ONBOARDING_AUTOGUIDE_ENABLED || "true").toLowerCase() !== "false";
  if (onboardingAutoguideEnabled && session?.shop) {
    try {
      const planContext = await resolvePlanContext(billing, !isProduction, BILLING_PLANS, session.shop);
      onboarding = await resolveOnboardingGuide({ shop: session.shop, planContext });
      const nextStepPath = onboarding?.nextStep ? pathOnly(onboarding.nextStep.href) : null;
      const isOnboardingRoute = url.pathname.startsWith("/app/onboarding");
      const isOnNextStepRoute = nextStepPath ? url.pathname.startsWith(nextStepPath) : false;
      const forceBypass = String(url.searchParams.get("onboarding") || "").toLowerCase() === "off";

      if (!forceBypass && onboarding?.nextStep && !isOnboardingRoute && !isOnNextStepRoute) {
        const onboardingUrl = new URL("/app/onboarding", "https://netcash.local");
        for (const [key, value] of url.searchParams.entries()) {
          if (key === "returnTo") continue;
          onboardingUrl.searchParams.append(key, value);
        }
        onboardingUrl.searchParams.set("returnTo", `${url.pathname}${url.search || ""}`);
        return redirect(`${onboardingUrl.pathname}?${onboardingUrl.searchParams.toString()}`);
      }
    } catch (error) {
      console.error("Onboarding autoguide failed:", error);
    }
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    onboarding,
    initialPanel,
  };
};

export default function App() {
  const { apiKey, onboarding, initialPanel } = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const searchInputRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [sidePanel, setSidePanel] = useState(initialPanel || null);
  const [densityMode, setDensityMode] = useState("auto");
  const [density, setDensity] = useState("comfortable");
  const [coachVisible, setCoachVisible] = useState(false);
  const [recentPages, setRecentPages] = useState([]);
  const [pinnedInsights, setPinnedInsights] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [searchConversation, setSearchConversation] = useState([]);
  const [recentSearches, setRecentSearches] = useState([]);
  const [searchCategory, setSearchCategory] = useState("all");
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [debugClick, setDebugClick] = useState(null);
  const embeddedPassthroughQuery = getEmbeddedPassthrough(location.search);
  const withEmbedded = (href) => withEmbeddedContext(href, embeddedPassthroughQuery);
  const lastMenuOpenRef = useRef(0);
  const openMenuPanel = useCallback(() => {
    lastMenuOpenRef.current = Date.now();
    setSidePanel("more");
  }, []);
  const clearPanelParam = useCallback(() => {
    const params = new URLSearchParams(location.search || "");
    if (!params.has("panel")) return;
    params.delete("panel");
    const nextSearch = params.toString();
    const next = `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
    navigate(next, { replace: true, preventScrollReset: true });
  }, [location.pathname, location.search, navigate]);
  const panellessHref = (() => {
    const params = new URLSearchParams(location.search || "");
    params.delete("panel");
    const nextSearch = params.toString();
    return `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
  })();
  const closeSidePanel = useCallback(() => {
    setSidePanel(null);
    clearPanelParam();
  }, [clearPanelParam]);

  const navItems = [
    { to: "/app", label: "Home", icon: "home" },
    { to: "/app/campaigns", label: "Campaigns", icon: "campaigns" },
    { to: "/app/universal", label: "Universal Insights", icon: "insights" },
    { to: "/app/intelligence", label: "Intelligence", icon: "intelligence" },
  ];
  const menuPrimaryLinks = [
    { href: "/app/alerts", label: "Alerts" },
    { href: "/app/integrations?wizard=1", label: "Integrations" },
    { href: "/app/autopilot", label: "Autopilot" },
  ];

  const quickActions = [
    { href: "/app", label: "Review Home" },
    { href: "/app/campaigns", label: "Review Campaigns" },
    { href: "/app/alerts", label: "Review Alerts" },
    { href: "/app/universal", label: "Review Universal Insights" },
    { href: "/app/integrations?wizard=1", label: "Review Integrations" },
    { href: "/app/autopilot", label: "Review Profit Guardrails Autopilot" },
    { href: "/app/pricing", label: "Manage Billing" },
    { href: "/app/intelligence", label: "Review Intelligence Studio" },
    { href: "/app/additional#connector-templates", label: "Advanced Integrations Docs" },
    { href: "/app/intelligence", label: "Review UTM & Behavior Intelligence" },
    { href: "/app/settings", label: "Review Settings" },
    { href: "/app/owner", label: "Review Owner Console" },
  ];
  const aiSearchItems = [
    { href: "/app", label: "Home dashboard", section: "Home", keywords: ["overview", "kpi", "founder", "health", "netcash", "home", "dashboard", "summary", "snapshots"] },
    { href: "/app#high-value-customers", label: "Customer 360 cohorts", section: "Home", keywords: ["360", "customer 360", "cohort", "cohorts", "high value", "customer profile", "customer intelligence"] },
    { href: "/app/campaigns", label: "Campaign performance", section: "Campaigns", keywords: ["meta", "google", "roas", "ads", "adset", "creative", "campaign report", "marketing performance"] },
    { href: "/app/campaigns#campaign-stop-list", label: "Stop campaigns list", section: "Campaigns", keywords: ["pause", "waste", "burn", "low roas", "stop ads", "kill campaign", "underperforming"] },
    { href: "/app/alerts", label: "Alerts center", section: "Alerts", keywords: ["anomaly", "risk", "warning", "rto", "drop", "issue", "problem", "red flag"] },
    { href: "/app/universal", label: "Universal insights", section: "Universal", keywords: ["cohort", "funnel", "ltv", "segment", "behavior", "behaviour", "device", "payment", "coupon", "hourly"] },
    { href: "/app/universal#customer-segments", label: "RFM cohorts", section: "Universal", keywords: ["rfm", "segments", "cohorts", "customer segments", "recency", "frequency", "monetary", "champions", "at risk"] },
    { href: "/app/integrations?wizard=1", label: "Integration hub", section: "Integrations", keywords: ["integrations", "meta", "google", "whatsapp", "email", "sms", "rcs", "automation", "connectors"] },
    { href: "/app/autopilot", label: "Profit guardrails autopilot", section: "Autopilot", keywords: ["autopilot", "guardrails", "throttle", "scale", "confidence", "net cash", "burn protection"] },
    { href: "/app/intelligence", label: "Intelligence studio", section: "Intelligence", keywords: ["ai", "nlp", "questions", "analysis", "utm", "insights", "attribution", "prompt"] },
    { href: "/app/integrations?wizard=1", label: "Integrations wizard", section: "Integrations", keywords: ["meta", "api", "signal", "pixel", "webhook", "integration", "connect"] },
    { href: "/app/integrations?wizard=1", label: "Connect ad accounts", section: "Integrations", keywords: ["connect", "account", "auth", "meta", "google", "login", "link"] },
    { href: "/app/additional#connector-templates", label: "Connector templates", section: "Connectors", keywords: ["template", "mapping", "signal capture", "schema", "field mapping"] },
    { href: "/app/pricing", label: "Billing and plans", section: "Billing", keywords: ["plan", "premium", "subscription", "upgrade", "pricing", "starter", "pro"] },
    { href: "/app/settings", label: "Settings", section: "Settings", keywords: ["preferences", "configuration", "workspace", "setup", "env"] },
    { href: "/app/owner", label: "Owner console", section: "Owner", keywords: ["owner", "brands using app", "adoption", "all shops", "merchant count", "multi brand"] },
  ];
  const glossaryTerms = [
    { key: "roas", term: "ROAS", meaning: "Revenue generated for every 1 INR ad spend." },
    { key: "real-roas", term: "Real ROAS", meaning: "Net-cash aware ROAS after returns, RTO and costs." },
    { key: "net-cash", term: "Net Cash", meaning: "Cash retained after discounts, logistics and refund impact." },
    { key: "data-depth", term: "Data Depth", meaning: "How complete your attribution and first-party signals are." },
    { key: "attribution-coverage", term: "Attribution Coverage", meaning: "Share of orders mapped to a source/campaign." },
    { key: "rfm", term: "RFM Segment", meaning: "Customer grouping by recency, frequency and monetary value." },
  ];
  const suggestedSearchPrompts = [
    "Search",
    "High RTO orders",
    "Low real ROAS campaigns",
    "Show RFM cohorts",
    "Connector sync status",
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedMode = String(window.localStorage.getItem("nc_density_mode") || "auto").toLowerCase();
    const mode = savedMode === "compact" || savedMode === "comfortable" ? savedMode : "auto";
    setDensityMode(mode);
    const coachSeen = window.localStorage.getItem("nc_shell_coach_seen_v1") === "1";
    setCoachVisible(!coachSeen);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 980px)");
    const apply = () => {
      const next = densityMode === "auto"
        ? (media.matches ? "compact" : "comfortable")
        : densityMode;
      setDensity(next);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [densityMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("nc_density_mode", densityMode);
    window.dispatchEvent(new CustomEvent("nc-density-change", { detail: { mode: densityMode } }));
  }, [densityMode]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-density", density);
    }
  }, [density]);

  useEffect(() => {
    const current = sanitizeRouteForRecent(location.pathname, location.search);
    setRecentPages((prev) => {
      const next = [current, ...prev.filter((item) => item !== current)].slice(0, 5);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("nc_recent_pages", JSON.stringify(next));
      }
      return next;
    });
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem("nc_recent_pages") || "[]");
    if (!Array.isArray(saved)) return;

    const cleaned = [...new Set(saved.map(sanitizeRecentHref).filter(Boolean))].slice(0, 5);
    setRecentPages(cleaned);
    window.localStorage.setItem("nc_recent_pages", JSON.stringify(cleaned));
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hydratePinned = () => {
      const saved = JSON.parse(window.localStorage.getItem("nc_pinned_insights") || "[]");
      setPinnedInsights(Array.isArray(saved) ? saved.slice(0, 12) : []);
    };
    hydratePinned();
    const onStorage = (event) => {
      if (event.key === "nc_pinned_insights") hydratePinned();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!sidePanel) return;
    const saved = JSON.parse(window.localStorage.getItem("nc_pinned_insights") || "[]");
    setPinnedInsights(Array.isArray(saved) ? saved.slice(0, 12) : []);
  }, [sidePanel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem("nc_recent_searches") || "[]");
    setRecentSearches(Array.isArray(saved) ? saved.slice(0, 6) : []);
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    setVoiceSupported(typeof Recognition === "function");
  }, []);

  const saveRecentSearch = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    setRecentSearches((current) => {
      const next = [text, ...current.filter((row) => row.toLowerCase() !== text.toLowerCase())].slice(0, 6);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("nc_recent_searches", JSON.stringify(next));
      }
      return next;
    });
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const isK = event.key.toLowerCase() === "k";
      const withModifier = event.metaKey || event.ctrlKey;
      if (withModifier && isK) {
        event.preventDefault();
        setSearchOpen(true);
        searchInputRef.current?.focus();
      }
      const targetTag = String(event.target?.tagName || "").toLowerCase();
      const isTypingField = targetTag === "input" || targetTag === "textarea" || event.target?.isContentEditable;
      if (!withModifier && event.key === "/" && !isTypingField) {
        event.preventDefault();
        setSearchOpen(true);
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
    if (event.key === "Escape") closeSidePanel();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSidePanel]);
  useEffect(() => {
    const resolveMenuButton = () => {
      if (menuButtonRef.current) return menuButtonRef.current;
      const fallback = document.querySelector(".nc-page-shortcuts .nc-page-shortcut-link");
      return fallback instanceof HTMLElement ? fallback : null;
    };
    const handleEvent = (event) => {
      const btn = resolveMenuButton();
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        event.preventDefault();
        event.stopPropagation();
        openMenuPanel();
      }
    };
    window.addEventListener("pointerdown", handleEvent, true);
    window.addEventListener("click", handleEvent, true);
    document.addEventListener("pointerdown", handleEvent, true);
    document.addEventListener("click", handleEvent, true);
    return () => {
      window.removeEventListener("pointerdown", handleEvent, true);
      window.removeEventListener("click", handleEvent, true);
      document.removeEventListener("pointerdown", handleEvent, true);
      document.removeEventListener("click", handleEvent, true);
    };
  }, [openMenuPanel]);


  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    if (params.get("debugClicks") !== "1") return undefined;
    const handler = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tag = target.tagName.toLowerCase();
      const id = target.id ? `#${target.id}` : "";
      const classes = target.className ? `.${String(target.className).trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      const text = String(target.textContent || "").trim().slice(0, 80);
      const rect = target.getBoundingClientRect();
      document.querySelectorAll("[data-nc-debug-target]").forEach((el) => el.removeAttribute("data-nc-debug-target"));
      target.setAttribute("data-nc-debug-target", "1");
      setDebugClick({
        tag,
        id,
        classes,
        text,
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [location.search]);
  useEffect(() => {
    setSearchOpen(false);
    setSearchActiveIndex(0);
  }, [location.pathname, location.search]);

  useEffect(() => {
    const path = String(location.pathname || "");
    const page = path === "/app" ? "home" : path.replace(/^\/app\/?/, "") || "home";
    trackUiEvent("page_view", { page });
  }, [location.pathname]);

  useEffect(() => {
    const panelParam = String(new URLSearchParams(location.search || "").get("panel") || "").toLowerCase();
    if (panelParam === "more" || panelParam === "glossary" || panelParam === "notifications") {
      setSidePanel(panelParam);
    }
  }, [location.search]);

  const globalNotifications = [
    { label: "Review latest anomalies", href: "/app/alerts?severity=warning" },
    { label: "Check stop campaigns list", href: "/app/campaigns#campaign-stop-list" },
    { label: "Manage billing plans", href: "/app/pricing" },
  ];

  const formatPinnedInsight = (id) => {
    if (id.startsWith("campaign:")) {
      const parts = id.split(":");
      return `Campaign: ${parts.slice(1).join(" / ")}`;
    }
    if (id.startsWith("alert:")) {
      return `Alert: ${id.replace("alert:", "")}`;
    }
    return id;
  };

  const typoFixMap = {
    rfmn: "rfm",
    rmf: "rfm",
    frm: "rfm",
    roaz: "roas",
    roes: "roas",
    compaign: "campaign",
    campain: "campaign",
    campagin: "campaign",
    alret: "alert",
    allert: "alert",
    alterts: "alerts",
    cohart: "cohort",
    cohrt: "cohort",
    cohots: "cohorts",
    segmant: "segment",
    segmnet: "segment",
    segement: "segment",
    behavour: "behavior",
    behavoural: "behavioral",
    utms: "utm",
    pixle: "pixel",
    billling: "billing",
    setings: "settings",
    dowload: "download",
    downlod: "download",
    exprt: "export",
    exprot: "export",
    fil: "file",
    flie: "file",
    ordres: "orders",
    oders: "orders",
    custmer: "customer",
    purchse: "purchase",
    purchace: "purchase",
    copon: "coupon",
    coupan: "coupon",
    higest: "highest",
  };
  const fillerWords = new Set([
    "show", "me", "please", "plz", "pls", "open", "take", "go", "to", "the", "my", "all", "for", "a", "an", "and", "of", "in",
    "karo", "dikhao", "mujhe", "chahiye",
  ]);
  const normalizeQueryText = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => typoFixMap[token] || token)
      .map((token) => (token === "cohorts" ? "cohort" : token))
      .map((token) => (token === "segments" ? "segment" : token))
      .filter((token) => !fillerWords.has(token))
      .join(" ");
  const includesAny = (value, phrases) => phrases.some((phrase) => value.includes(phrase));
  const navigationIntents = [
    { href: "/app/universal#customer-segments", phrases: ["rfm", "rfm cohort", "rfm segment", "customer segment", "segment", "cohort", "customer 360", "360", "champion", "at risk", "hibernating"] },
    { href: "/app/alerts", phrases: ["alert", "warning", "risk", "rto", "refund", "cancel", "issue", "problem"] },
    { href: "/app/campaigns#campaign-stop-list", phrases: ["stop campaign", "pause campaign", "underperforming", "waste", "burn"] },
    { href: "/app/campaigns", phrases: ["campaign", "ads", "adset", "creative", "media spend", "roas"] },
    { href: "/app/integrations?wizard=1", phrases: ["integrations", "connect meta", "connect google", "whatsapp", "sms", "rcs", "email automation", "connectors"] },
    { href: "/app/autopilot", phrases: ["autopilot", "guardrail", "throttle", "scale", "burn protection", "protect spend", "profit guardrails"] },
    { href: "/app/intelligence", phrases: ["intelligence", "insight", "ai", "nlp", "utm", "attribution", "analysis"] },
    { href: "/app/universal", phrases: ["universal", "ltv", "payment", "coupon", "device", "handset", "hour", "hourly"] },
    { href: "/app/integrations?wizard=1", phrases: ["connector", "connect", "integration", "pixel", "signal", "oauth", "meta connect", "google connect"] },
    { href: "/app/pricing", phrases: ["billing", "plan", "pricing", "upgrade", "subscription", "premium", "starter", "pro"] },
    { href: "/app/settings", phrases: ["settings", "config", "configuration", "setup", "preference"] },
    { href: "/app/owner", phrases: ["owner", "owner console", "brands using", "how many brands", "merchant count", "all brands", "all shops", "multi brand", "adoption"] },
    { href: "/app", phrases: ["home", "dashboard", "overview", "summary", "kpi"] },
  ];
  const downloadIntents = [
    { intent: "export-orders-csv", label: "orders CSV", phrases: ["download order", "download orders", "export order", "export orders", "order csv", "sales csv", "sales report", "order report", "orders data"] },
    { intent: "export-spend-csv", label: "spend CSV", phrases: ["download spend", "export spend", "spend csv", "ad spend csv", "marketing spend", "spend report", "cost report", "ad cost"] },
    { intent: "export-customer-360-pack", label: "Customer 360 pack", phrases: ["download customer 360", "export customer 360", "customer 360 report", "customer profile report", "customer pack", "customer pdf"] },
  ];
  const query = normalizeQueryText(searchQuery);
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const rawTokens = String(searchQuery || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const didYouMean = (() => {
    if (!rawTokens.length) return null;
    let changed = false;
    const next = rawTokens.map((token) => {
      const fixed = typoFixMap[token] || token;
      if (fixed !== token) changed = true;
      return fixed;
    });
    if (!changed) return null;
    return next.join(" ");
  })();
  const coachTip = (() => {
    if (location.pathname.startsWith("/app/campaigns")) {
      return "Use the filter drawer, then save the current filter set as a view for one-click reuse.";
    }
    if (location.pathname.startsWith("/app/alerts")) {
      return "Sort by critical unread first and switch to compact density for faster triage.";
    }
    return "Use Ctrl/Cmd + K for quick navigation and pin key insights from each page.";
  })();
  const dismissCoach = () => {
    setCoachVisible(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nc_shell_coach_seen_v1", "1");
    }
  };
  const actionSearchItems = quickActions.map((row) => ({
    href: row.href,
    label: row.label,
    section: "Actions",
    keywords: String(row.label || "").toLowerCase().split(/\s+/).filter(Boolean),
    kind: "action",
  }));
  const reportSearchItems = downloadIntents.map((row) => ({
    href: "/app",
    label: `Download ${row.label}`,
    section: "Reports",
    keywords: row.phrases || [],
    kind: "report",
    reportIntent: row.intent,
  }));
  const scoreSearchItem = (item) => {
    if (!queryTokens.length) return 0;
    const label = item.label.toLowerCase();
    const section = item.section.toLowerCase();
    const href = item.href.toLowerCase();
    const keywordText = item.keywords.join(" ").toLowerCase();
    let score = 0;
    let matchedTokens = 0;
    for (const token of queryTokens) {
      let matched = false;
      if (label.includes(token)) {
        score += 5;
        matched = true;
      }
      if (keywordText.includes(token)) {
        score += 3;
        matched = true;
      }
      if (section.includes(token)) {
        score += 2;
        matched = true;
      }
      if (href.includes(token)) {
        score += 1;
        matched = true;
      }
      if (matched) matchedTokens += 1;
    }
    if (matchedTokens === queryTokens.length) score += 4;
    if (label.startsWith(query)) score += 2;
    return score;
  };
  const dedupedSearchItems = aiSearchItems.filter((item, index, list) =>
    list.findIndex((row) => row.href === item.href && row.label === item.label) === index,
  );
  const candidateSearchItems = [
    ...dedupedSearchItems.map((item) => ({ ...item, kind: "page" })),
    ...actionSearchItems,
    ...reportSearchItems,
  ];
  const categoryFilteredItems = candidateSearchItems.filter((item) => {
    if (searchCategory === "all") return true;
    if (searchCategory === "pages") return item.kind === "page";
    if (searchCategory === "actions") return item.kind === "action";
    if (searchCategory === "reports") return item.kind === "report";
    return true;
  });
  const searchResults = query
    ? categoryFilteredItems
      .map((item) => ({ item, score: scoreSearchItem(item) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .slice(0, 8)
      .map((row) => row.item)
    : categoryFilteredItems.slice(0, 8);
  const groupedSearchResults = searchResults.reduce((acc, item) => {
    const key = item.section || "General";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
  const groupedSearchEntries = Object.entries(groupedSearchResults);
  const flattenedSearchResults = groupedSearchEntries.flatMap(([section, items]) =>
    items.map((item) => ({ ...item, _section: section })),
  );
  const resolveDownloadIntent = (rawQuery) => {
    const value = normalizeQueryText(rawQuery);
    const asksToDownload = includesAny(value, ["download", "export", "csv", "file", "report", "data"]);
    if (!asksToDownload) return null;
    const matched = downloadIntents.find((row) => includesAny(value, row.phrases));
    if (matched) {
      return { intent: matched.intent, label: matched.label };
    }
    return { intent: "export-orders-csv", label: "orders CSV" };
  };
  const resolveNavigationIntent = (rawQuery) => {
    const value = normalizeQueryText(rawQuery);
    const matched = navigationIntents.find((row) => includesAny(value, row.phrases));
    return matched ? matched.href : null;
  };
  const resolveActionIntent = (rawQuery) => {
    const value = normalizeQueryText(rawQuery);
    if (!value) return null;
    if (includesAny(value, ["connect meta"])) return { intent: "connect-meta", label: "Connecting Meta..." };
    if (includesAny(value, ["connect google"])) return { intent: "connect-google", label: "Connecting Google..." };
    if (includesAny(value, ["connect all", "connect recommended"])) return { intent: "connect-all-recommended", label: "Starting recommended connector setup..." };
    if (includesAny(value, ["fix channels", "setup channels", "setup all channels"])) return { intent: "auto-setup-all-channels", label: "Setting up all channels..." };
    if (includesAny(value, ["run health check", "test everything", "run integration test"])) return { intent: "run-integration-tests", label: "Running integration health checks..." };
    return null;
  };
  const triggerDownload = (intent) => {
    if (typeof document === "undefined") return;
    const params = new URLSearchParams(location.search || "");
    const days = Number(params.get("days") || 30);
    const safeDays = [7, 30, 90, 365].includes(days) ? days : 30;
    const form = document.createElement("form");
    form.method = "post";
    form.action = `/app?days=${safeDays}`;
    form.style.display = "none";

    const intentInput = document.createElement("input");
    intentInput.type = "hidden";
    intentInput.name = "intent";
    intentInput.value = intent;
    form.appendChild(intentInput);

    const daysInput = document.createElement("input");
    daysInput.type = "hidden";
    daysInput.name = "days";
    daysInput.value = String(safeDays);
    form.appendChild(daysInput);

    document.body.appendChild(form);
    form.submit();
    form.remove();
  };
  const triggerIntegrationAction = (intent) => {
    if (typeof document === "undefined") return;
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/app/integrations?wizard=1";
    form.style.display = "none";

    const intentInput = document.createElement("input");
    intentInput.type = "hidden";
    intentInput.name = "intent";
    intentInput.value = intent;
    form.appendChild(intentInput);

    if (intent === "auto-setup-all-channels") {
      const runInput = document.createElement("input");
      runInput.type = "hidden";
      runInput.name = "runNow";
      runInput.value = "true";
      form.appendChild(runInput);
    }

    document.body.appendChild(form);
    form.submit();
    form.remove();
  };
  const goToSearchResult = (href) => {
    navigate(withEmbedded(href), { preventScrollReset: true });
    setSearchOpen(false);
    setSearchActiveIndex(0);
  };
  const executeSearchItem = (item) => {
    if (!item) return;
    if (item.kind === "report" && item.reportIntent) {
      triggerDownload(item.reportIntent);
      setSearchOpen(false);
      return;
    }
    if (item.href) {
      goToSearchResult(item.href);
    }
  };
  const openSearchResultInNewTab = (href) => {
    if (typeof window === "undefined") return;
    window.open(withEmbedded(href), "_blank", "noopener,noreferrer");
  };
  const buildAiResponse = (rawQuery) => {
    const value = normalizeQueryText(rawQuery);
    if (!value) {
      return {
        text: "Ask me anything about ROAS, alerts, campaigns, attribution, billing, or connectors.",
        suggestions: ["/app/intelligence", "/app/universal", "/app/alerts"],
      };
    }
    const has = (words) => words.some((word) => value.includes(word));
    if (has(["roas", "return on ad spend", "profit margin", "net cash"])) {
      return {
        text: "For ROAS and profitability, start with Campaigns for channel ROAS, then Home for net cash and margin quality. Watch sharp ROAS + margin divergence before scaling.",
        suggestions: ["/app/campaigns", "/app", "/app/alerts?severity=warning"],
      };
    }
    if (has(["rto", "cancel", "refund", "risk", "alert"])) {
      return {
        text: "To reduce RTO/refund loss, open Alerts first, then validate high-risk items and pincodes in Home customer intelligence. Prioritize COD control and risk pin suppression.",
        suggestions: ["/app/alerts", "/app", "/app/campaigns#campaign-stop-list"],
      };
    }
    if (has(["utm", "attribution", "meta", "pixel", "signal", "connector"])) {
      return {
        text: "For attribution gaps, setup integrations in Integration Hub and validate UTM/signal flow in Intelligence. This improves campaign decision accuracy and real ROAS confidence.",
        suggestions: ["/app/integrations?wizard=1", "/app/intelligence", "/app/universal"],
      };
    }
    if (has(["billing", "plan", "premium", "upgrade", "subscription"])) {
      return {
        text: "Billing controls are available in Plan & Billing. Premium is best for deeper customer behavior analytics, advanced insights, and enterprise connectors.",
      suggestions: ["/app/pricing", "/app/universal", "/app/intelligence"],
      };
    }
    if (has(["customer", "segment", "cohort", "ltv", "behavior", "repeat"])) {
      return {
        text: "Use Universal Insights for cohorts and behavior segments, then validate purchase patterns and repeat windows in Home customer intelligence.",
        suggestions: ["/app/universal", "/app", "/app/intelligence"],
      };
    }
    if (has(["campaign", "ads", "spend", "scale", "pause"])) {
      return {
        text: "Use Campaigns to find winners and waste. Pause low-efficiency campaigns first, then reallocate to high-margin sources with stable attribution coverage.",
        suggestions: ["/app/campaigns", "/app/campaigns#campaign-stop-list", "/app/alerts"],
      };
    }
    return {
      text: "I understood your intent. Start with Intelligence for deep analysis, then move to Campaigns/Alerts to act on the insights.",
      suggestions: ["/app/intelligence", "/app/campaigns", "/app/alerts"],
    };
  };
  const runAiSearchReply = (rawQuery) => {
    const queryText = rawQuery.trim();
    if (!queryText) return;
    saveRecentSearch(queryText);
    const reply = buildAiResponse(queryText);
    setSearchConversation((current) => {
      const next = [
        ...current.slice(-4),
        { role: "user", text: queryText },
        { role: "assistant", text: reply.text, suggestions: reply.suggestions || [] },
      ];
      return next;
    });
  };
  const onSearchSubmit = (event) => {
    event.preventDefault();
    const queryText = searchQuery.trim();
    if (!queryText) return;
    saveRecentSearch(queryText);
    const downloadIntent = resolveDownloadIntent(queryText);
    if (downloadIntent) {
      setSearchConversation((current) => [
        ...current.slice(-4),
        { role: "user", text: queryText },
        { role: "assistant", text: `Downloading ${downloadIntent.label} now.`, suggestions: ["/app"] },
      ]);
      triggerDownload(downloadIntent.intent);
      return;
    }
    const actionIntent = resolveActionIntent(queryText);
    if (actionIntent) {
      setSearchConversation((current) => [
        ...current.slice(-4),
        { role: "user", text: queryText },
        { role: "assistant", text: actionIntent.label, suggestions: ["/app/integrations?wizard=1"] },
      ]);
      triggerIntegrationAction(actionIntent.intent);
      return;
    }
    const navigationIntent = resolveNavigationIntent(queryText);
    if (navigationIntent) {
      goToSearchResult(navigationIntent);
      return;
    }
    if (flattenedSearchResults.length) {
      const selected = flattenedSearchResults[Math.min(searchActiveIndex, flattenedSearchResults.length - 1)];
      executeSearchItem(selected);
      return;
    }
    runAiSearchReply(queryText);
  };
  const onSearchKeyDown = (event) => {
    if (!searchOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setSearchOpen(true);
      return;
    }
    if (!flattenedSearchResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSearchActiveIndex((current) => (current + 1) % flattenedSearchResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchActiveIndex((current) => (current - 1 + flattenedSearchResults.length) % flattenedSearchResults.length);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!flattenedSearchResults.length) return;
      const selected = flattenedSearchResults[Math.min(searchActiveIndex, flattenedSearchResults.length - 1)];
      if (selected?.href) openSearchResultInNewTab(selected.href);
    }
  };
  useEffect(() => {
    if (!flattenedSearchResults.length) {
      setSearchActiveIndex(0);
      return;
    }
    if (searchActiveIndex >= flattenedSearchResults.length) setSearchActiveIndex(0);
  }, [flattenedSearchResults.length, searchActiveIndex]);
  const iconMarkup = (name) => {
    if (name === "home") return <path d="M3 10.2 10 4l7 6.2V18h-4.6v-4.8H7.6V18H3z" />;
    if (name === "campaigns") return <path d="M3 14.2V6.4h2.3v7.8zm4.4 2.2V3.6h2.3v12.8zm4.4-4V7.6h2.3v4.8zm4.4 5.6V4.2H18V18z" />;
    if (name === "alerts") return <path d="M10 2.8a4 4 0 0 1 4 4V9c0 2 .8 3.2 2 4.2v1H4v-1c1.2-1 2-2.2 2-4.2V6.8a4 4 0 0 1 4-4zm-2.3 13h4.6a2.3 2.3 0 0 1-4.6 0z" />;
    if (name === "insights") return <path d="M3 17.2 8.2 12l3.1 3.1 5.7-6.9 1.8 1.5-7 8.4-3.1-3.1-4 4z" />;
    if (name === "billing") return <path d="M4 4.2h12a1 1 0 0 1 1 1v9.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1zm1.5 3.4h9V6h-9zm0 3h5.2v-1.6H5.5z" />;
    if (name === "intelligence") return <path d="M10 2.8a5.2 5.2 0 0 1 3.4 9.2v2H6.6v-2A5.2 5.2 0 0 1 10 2.8zm-2 12.8h4v1.2H8zm.7 2h2.6V19H8.7z" />;
    if (name === "connectors") return <path d="M6.2 6.2a2.8 2.8 0 0 1 4.8 2h2a2.8 2.8 0 1 1 0 3.6h-2a2.8 2.8 0 1 1-4.8-2h2.1a1.2 1.2 0 1 0 0-1.6z" />;
    if (name === "settings") return <path d="m10 3 1.2 1.4 1.8-.3.7 1.7 1.8.7-.3 1.8L17 9.5l-1.4 1.2.3 1.8-1.8.7-.7 1.7-1.8-.3L10 16l-1.2-1.4-1.8.3-.7-1.7-1.8-.7.3-1.8L3 9.5l1.4-1.2-.3-1.8 1.8-.7.7-1.7 1.8.3zm0 4.1a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z" />;
    if (name === "compact") return <path d="M3 4h6v6H3zm8 0h6v6h-6zM3 12h6v4H3zm8 0h6v4h-6z" />;
    if (name === "quick") return <path d="M9.2 2.8 4 11h4l-1 6.2L16 9h-4.2L13 2.8z" />;
    if (name === "menu") return <path d="M3 5.6h14v1.8H3zm0 4.6h14V12H3zm0 4.6h14v1.8H3z" />;
    if (name === "search") return <path d="M8.6 3.2a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8zm0 1.9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm4.3 8.6 3.9 3.9-1.3 1.3-3.9-3.9z" />;
    if (name === "mic") return <path d="M10 2.6a2.2 2.2 0 0 1 2.2 2.2v4.4a2.2 2.2 0 1 1-4.4 0V4.8A2.2 2.2 0 0 1 10 2.6zm-4 6.6h1.8a2.2 2.2 0 1 0 4.4 0H14a4 4 0 0 1-3.1 3.9v2.1h2.4V17H6.7v-1.8h2.4v-2.1A4 4 0 0 1 6 9.2z" />;
    return <circle cx="10" cy="10" r="5" />;
  };
  const icon = (name, className) => (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      {iconMarkup(name)}
    </svg>
  );

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/campaigns">Campaigns</s-link>
        <s-link href="/app/universal">Universal Insights</s-link>
        <s-link href="/app/intelligence">Intelligence</s-link>
      </s-app-nav>

      <div className="nc-app-toprow">
        <div className="nc-app-shell-search">
          <form
            className="nc-global-search"
            role="search"
            onSubmit={onSearchSubmit}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
          >
            {icon("search", "nc-search-icon")}
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search"
              aria-label="Search"
            />
            {searchQuery.trim() ? (
              <button
                type="button"
                className="nc-global-search-clear"
                aria-label="Clear search"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSearchQuery("");
                  setSearchActiveIndex(0);
                  searchInputRef.current?.focus();
                }}
              >
                Clear
              </button>
            ) : null}
            {voiceSupported ? (
              <button
                type="button"
                className={`nc-global-search-voice${voiceListening ? " is-listening" : ""}`}
                aria-label={voiceListening ? "Listening..." : "Voice search"}
                title={voiceListening ? "Listening..." : "Voice search"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (typeof window === "undefined") return;
                  if (voiceListening) return;
                  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                  if (typeof Recognition !== "function") return;
                  const recognition = new Recognition();
                  recognition.lang = "en-US";
                  recognition.interimResults = false;
                  recognition.continuous = false;
                  setVoiceListening(true);
                  recognition.onresult = (evt) => {
                    const text = evt?.results?.[0]?.[0]?.transcript || "";
                    if (text) {
                      setSearchQuery(String(text));
                      setSearchOpen(true);
                      setSearchActiveIndex(0);
                      saveRecentSearch(String(text));
                    }
                  };
                  recognition.onend = () => setVoiceListening(false);
                  recognition.onerror = () => setVoiceListening(false);
                  recognition.start();
                }}
              >
                {icon("mic", "nc-shortcut-icon")}
              </button>
            ) : null}
            <span className="nc-global-search-kbd" aria-hidden="true">Ctrl K</span>
            {searchOpen ? (
              <div className="nc-global-search-results" role="listbox" aria-label="Search results">
                <div className="nc-global-search-ai-panel">
                  <div className="nc-global-search-ai-head">
                    <strong>AI Assistant</strong>
                    <span>Enter to ask, / or Ctrl/Cmd+K to focus</span>
                  </div>
                  <div className="nc-search-suggestions">
                    {["all", "pages", "actions", "reports"].map((key) => (
                      <button
                        key={`search-category-${key}`}
                        type="button"
                        className={`nc-search-suggestion-pill${searchCategory === key ? " is-active" : ""}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setSearchCategory(key);
                          setSearchActiveIndex(0);
                        }}
                      >
                        {key[0].toUpperCase() + key.slice(1)}
                      </button>
                    ))}
                  </div>
                  {didYouMean ? (
                    <div className="nc-search-didyoumean">
                      Did you mean{" "}
                      <button
                        type="button"
                        className="nc-search-didyoumean-btn"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setSearchQuery(didYouMean);
                          setSearchActiveIndex(0);
                          searchInputRef.current?.focus();
                        }}
                      >
                        {didYouMean}
                      </button>
                      ?
                    </div>
                  ) : null}
                  {recentSearches.length ? (
                    <div className="nc-search-suggestions">
                      <span className="nc-search-suggestions-label">Recent</span>
                      {recentSearches.map((term) => (
                        <button
                          key={`recent-search-${term}`}
                          type="button"
                          className="nc-search-suggestion-pill"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSearchQuery(term);
                            setSearchActiveIndex(0);
                            searchInputRef.current?.focus();
                          }}
                        >
                          {term}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="nc-search-suggestions">
                      <span className="nc-search-suggestions-label">Try</span>
                      {suggestedSearchPrompts.map((term) => (
                        <button
                          key={`suggested-search-${term}`}
                          type="button"
                          className="nc-search-suggestion-pill"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSearchQuery(term);
                            setSearchActiveIndex(0);
                            searchInputRef.current?.focus();
                          }}
                        >
                          {term}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="nc-global-search-chat">
                    {searchConversation.length ? (
                      searchConversation.map((message, index) => (
                        <div key={`${message.role}-${index}`} className={`nc-chat-row is-${message.role}`}>
                          <div className="nc-chat-bubble">{message.text}</div>
                          {message.role === "assistant" && message.suggestions?.length ? (
                            <div className="nc-chat-suggestions">
                              {message.suggestions.map((href) => (
                                <button
                                  key={`${message.role}-${index}-${href}`}
                                  type="button"
                                  className="nc-chat-suggestion"
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    goToSearchResult(href);
                                  }}
                                >
                                  {prettyRecentLabel(href)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="nc-chat-row is-assistant">
                        <div className="nc-chat-bubble">Ask in natural language, for example: "Why did ROAS drop this week?"</div>
                      </div>
                    )}
                  </div>
                </div>
                {flattenedSearchResults.length ? (
                  groupedSearchEntries.map(([section, items]) => (
                    <div key={section} className="nc-global-search-group">
                      <div className="nc-global-search-group-label">{section}</div>
                      {items.map((item) => {
                        const resultIndex = flattenedSearchResults.findIndex((row) => row.href === item.href && row.label === item.label);
                        const isActive = resultIndex === searchActiveIndex;
                        return (
                          <button
                            key={`${item.href}-${item.label}`}
                            type="button"
                            className={`nc-global-search-item${isActive ? " is-active" : ""}`}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              executeSearchItem(item);
                            }}
                          >
                            <span>{item.label}</span>
                            <span className="nc-global-search-meta">{item.section}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))
                ) : (
                  <div className="nc-global-search-empty">No direct match. Press Enter to open Quick Actions.</div>
                )}
              </div>
            ) : null}
          </form>
        </div>
        <div className="nc-app-shell-actions">
          <nav className="nc-app-topnav" aria-label="Workspace">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={withEmbedded(item.to)}
                end={item.to === "/app"}
                className={({ isActive }) => `nc-app-topnav-link${isActive ? " is-active" : ""}`}
                preventScrollReset
                onClick={(event) => {
                  if (item.to !== "/app") return;
                  event.preventDefault();
                  event.stopPropagation();
                  const target = withEmbedded("/app");
                  window.location.href = target;
                }}
              >
                {icon(item.icon, "nc-nav-icon")}
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="nc-page-shortcuts" aria-label="Page shortcuts">
            <a
              href={withEmbedded("/app?panel=more")}
              className="nc-page-shortcut-link"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenuPanel();
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenuPanel();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenuPanel();
              }}
              aria-expanded={sidePanel === "more"}
              ref={menuButtonRef}
            >
              {icon("menu", "nc-shortcut-icon")}
              Menu
            </a>
          </div>
        </div>
      </div>


      {coachVisible ? (
        <div className="nc-shell" style={{ paddingTop: "8px", paddingBottom: "6px" }}>
          <div className="nc-card nc-section nc-coachmark">
            <div>
              <strong>Quick guide</strong>
              <p className="nc-note" style={{ margin: "4px 0 0" }}>{coachTip}</p>
            </div>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <button type="button" className="nc-chip" onClick={() => setSidePanel("more")}>Open menu</button>
              <button type="button" className="nc-chip" onClick={dismissCoach}>Got it</button>
            </div>
          </div>
        </div>
      ) : null}

      {debugClick ? (
        <div className="nc-debug-click">
          <strong>Click Debug</strong>
          <div>{debugClick.tag}{debugClick.id}{debugClick.classes}</div>
          <div>{debugClick.text || "(no text)"}</div>
          <div>Pointer: {debugClick.x},{debugClick.y}</div>
          <div>Rect: {debugClick.rect.left},{debugClick.rect.top} {debugClick.rect.width}x{debugClick.rect.height}</div>
        </div>
      ) : null}

      {sidePanel ? (
        <div
          className="nc-sidepanel-overlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            event.stopPropagation();
            if (Date.now() - lastMenuOpenRef.current < 250) return;
            closeSidePanel();
          }}
        >
          <a
            className="nc-sidepanel-dismiss"
            href={withEmbedded(panellessHref)}
            aria-label="Close menu"
          />
          <aside className="nc-sidepanel" onClick={(event) => event.stopPropagation()}>
            <div className="nc-sidepanel-head">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {sidePanel !== "more" ? (
                  <a
                    className="nc-page-shortcut-link"
                    href={withEmbedded(`${panellessHref}${panellessHref.includes("?") ? "&" : "?"}panel=more`)}
                    onClick={(event) => {
                      event.preventDefault();
                      setSidePanel("more");
                    }}
                  >
                    ← Back
                  </a>
                ) : null}
                <strong>{sidePanel === "notifications" ? "Notifications" : sidePanel === "glossary" ? "Glossary" : "More"}</strong>
              </div>
              <a className="nc-page-shortcut-link" href={withEmbedded(panellessHref)} onClick={(event) => {
                event.preventDefault();
                closeSidePanel();
              }}>Close</a>
            </div>
            <div className="nc-sidepanel-body">
                {sidePanel === "notifications" ? (
                  globalNotifications.map((item) => (
                    <Link key={item.href} to={withEmbedded(item.href)} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>
                      {item.label}
                    </Link>
                  ))
                ) : sidePanel === "glossary" ? (
                <div className="nc-glossary-list">
                  {glossaryTerms.map((row) => (
                    <div key={row.key} className="nc-glossary-item">
                      <strong>{row.term}</strong>
                      <p className="nc-note">{row.meaning}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <a
                    className="nc-shell-menu-item"
                    href={withEmbedded(`${panellessHref}${panellessHref.includes("?") ? "&" : "?"}panel=notifications`)}
                    onClick={(event) => {
                      event.preventDefault();
                      setSidePanel("notifications");
                    }}
                  >
                    Open Notifications
                  </a>
                  <a
                    className="nc-shell-menu-item"
                    href={withEmbedded(`${panellessHref}${panellessHref.includes("?") ? "&" : "?"}panel=glossary`)}
                    onClick={(event) => {
                      event.preventDefault();
                      setSidePanel("glossary");
                    }}
                  >
                    Open Glossary
                  </a>
                  <div className="nc-sidepanel-subhead">Primary</div>
                  {menuPrimaryLinks.map((item) => (
                    <Link
                      key={`menu-primary-${item.href}`}
                      to={withEmbedded(item.href)}
                      preventScrollReset
                      className="nc-shell-menu-item"
                      onClick={closeSidePanel}
                    >
                      {item.label}
                    </Link>
                  ))}
                  <div className="nc-sidepanel-subhead">Quick Actions</div>
                    {quickActions.slice(0, 6).map((action) => (
                      <Link
                        key={`panel-quick-${action.href}`}
                        to={withEmbedded(action.href)}
                        preventScrollReset
                        className="nc-shell-menu-item"
                        onClick={closeSidePanel}
                      >
                        {action.label}
                    </Link>
                  ))}
                  <div className="nc-sidepanel-subhead">Recently Viewed</div>
                  {recentPages.length > 1 ? (
                    recentPages.slice(1).map((href) => (
                      <Link
                        key={`panel-recent-${href}`}
                        to={withEmbedded(href)}
                        preventScrollReset
                        className="nc-shell-menu-item"
                        onClick={closeSidePanel}
                      >
                        {prettyRecentLabel(href)}
                      </Link>
                    ))
                  ) : (
                    <div className="nc-note">No recent pages yet.</div>
                  )}
                  <Link to={withEmbedded("/app/owner")} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>Owner Console</Link>
                  <Link to={withEmbedded("/app/additional#connector-templates")} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>Review API & Connectors</Link>
                  <Link to={withEmbedded("/app/pricing")} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>Plan & Billing</Link>
                  <Link to={withEmbedded("/app/settings")} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>Settings</Link>
                  <div className="nc-sidepanel-subhead">Display Density</div>
                  <div className="nc-density-toggle">
                    <button type="button" className={`nc-chip ${densityMode === "auto" ? "is-active" : ""}`} onClick={() => setDensityMode("auto")}>Auto</button>
                    <button type="button" className={`nc-chip ${densityMode === "comfortable" ? "is-active" : ""}`} onClick={() => setDensityMode("comfortable")}>Comfortable</button>
                    <button type="button" className={`nc-chip ${densityMode === "compact" ? "is-active" : ""}`} onClick={() => setDensityMode("compact")}>Compact</button>
                  </div>
                  <div className="nc-note">Current density: {densityMode === "auto" ? `Auto (${density})` : density}</div>
                  <div className="nc-sidepanel-subhead">Help</div>
                  <div className="nc-note">Use Ctrl/Cmd + K or / to focus search.</div>
                  <div className="nc-note">ROAS: revenue / ad spend. Real ROAS: net-cash aware ROAS.</div>
                  <div className="nc-sidepanel-subhead">Pinned Insights</div>
                    {pinnedInsights.length ? (
                      pinnedInsights.map((id) => (
                        <Link key={id} to={withEmbedded(id.startsWith("alert:") ? "/app/alerts" : "/app/campaigns")} preventScrollReset className="nc-shell-menu-item" onClick={closeSidePanel}>
                          {formatPinnedInsight(id)}
                        </Link>
                      ))
                    ) : (
                    <div className="nc-note">No pinned insights yet.</div>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {onboarding?.nextStep ? (
        <div className="nc-shell" style={{ paddingTop: "0", paddingBottom: "8px" }}>
          <div className="nc-card nc-section">
            <p className="nc-note" style={{ marginBottom: "6px" }}>
              Onboarding {Number(onboarding.progressPercent || 0)}% complete. Next step: <strong>{onboarding.nextStep.label}</strong>
            </p>
            <Link to={withEmbedded("/app/onboarding")} className="nc-chip" preventScrollReset>Open guided onboarding</Link>
          </div>
        </div>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
