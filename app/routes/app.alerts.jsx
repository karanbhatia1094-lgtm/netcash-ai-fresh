import { Form, Link, useFetcher, useLoaderData, useLocation, useRevalidator, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { trackUiEvent } from "../utils/telemetry.client";
import {
  evaluateAndStoreAlerts,
  listAlertEvents,
  listAlertRules,
  listAlertRuleSettings,
  markAlertRead,
  upsertAlertRuleSetting,
  listConnectorCredentials,
} from "../utils/db.server";
import { listReportSchedules } from "../utils/report-scheduler.server";

const SEVERITIES = ["all", "critical", "warning", "info"];

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const severity = String(url.searchParams.get("severity") || "all").toLowerCase();
  const safeSeverity = SEVERITIES.includes(severity) ? severity : "all";

  const [rules, settings, evaluation] = await Promise.all([
    listAlertRules(),
    listAlertRuleSettings(session.shop),
    evaluateAndStoreAlerts(session.shop),
  ]);

  const events = await listAlertEvents(session.shop, { severity: safeSeverity, limit: 150 });
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
    permissions: {
      hasMetaConnector: connectors.some((row) => row.provider === "meta_ads" && row.accessToken),
      hasGoogleConnector: connectors.some((row) => row.provider === "google_ads" && row.accessToken),
    },
    scheduledReports: await listReportSchedules(session.shop, "alerts"),
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
  const revalidator = useRevalidator();
  const readFetcher = useFetcher();
  const scheduleFetcher = useFetcher();
  const { severity, events, rules, evaluation, permissions, scheduledReports } = useLoaderData();
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [pinnedInsights, setPinnedInsights] = useState([]);
  const [alertsPreset, setAlertsPreset] = useState("full");
  const [presetToast, setPresetToast] = useState("");
  const [readOverrides, setReadOverrides] = useState({});
  const [rowFeedback, setRowFeedback] = useState({});
  const [tableDensity, setTableDensity] = useState("comfortable");
  const [quickFilter, setQuickFilter] = useState("all");
  const [savedReports, setSavedReports] = useState(Array.isArray(scheduledReports) ? scheduledReports : []);
  const [reportDraft, setReportDraft] = useState({ name: "", frequency: "weekly", email: "" });
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
  const filteredEvents = (events || []).filter((alert) => {
    const isRead = readOverrides[alert.id] ?? alert.isRead;
    if (quickFilter === "all") return true;
    if (quickFilter === "critical_unread") return alert.severity === "critical" && !isRead;
    if (quickFilter === "unread") return !isRead;
    if (quickFilter === "read") return isRead;
    return true;
  });

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
    const savedPreset = window.localStorage.getItem("nc_alerts_preset");
    if (savedPreset) setAlertsPreset(savedPreset);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("nc_alerts_preset", alertsPreset);
  }, [alertsPreset]);
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
  const markReadOptimistic = (alertId, readValue) => {
    setReadOverrides((current) => ({ ...current, [alertId]: readValue }));
    const payload = new FormData();
    payload.append("intent", readValue ? "mark-read" : "mark-unread");
    payload.append("alertId", alertId);
    readFetcher.submit(payload, { method: "post" });
    trackUiEvent("alert_mark_read_toggled", { alertId, readValue });
    pushRowFeedback(`alert:${alertId}`, readValue ? "Marked read" : "Marked unread");
  };
  const selectAlertsPreset = (preset) => {
    setAlertsPreset(preset);
    trackUiEvent("preset_changed", { page: "alerts", preset });
    const labels = { triage: "Triage", "rules-first": "Rules First", full: "Full View" };
    setPresetToast(`${labels[preset] || "Preset"} applied`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const showRules = alertsPreset === "rules-first" || alertsPreset === "full";
  const showFilter = alertsPreset === "rules-first" || alertsPreset === "full";
  const showEvents = alertsPreset === "triage" || alertsPreset === "full";
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
      <div className="nc-toolbar nc-section" style={{ marginBottom: 0 }}>
        <button type="button" className={`nc-chip ${quickFilter === "all" ? "is-active" : ""}`} onClick={() => setQuickFilter("all")}>All alerts</button>
        <button type="button" className={`nc-chip ${quickFilter === "critical_unread" ? "is-active" : ""}`} onClick={() => setQuickFilter("critical_unread")}>Critical unread</button>
        <button type="button" className={`nc-chip ${quickFilter === "unread" ? "is-active" : ""}`} onClick={() => setQuickFilter("unread")}>Unread only</button>
        <button type="button" className={`nc-chip ${quickFilter === "read" ? "is-active" : ""}`} onClick={() => setQuickFilter("read")}>Read only</button>
      </div>
      {presetToast ? <div className="nc-toast">{presetToast}</div> : null}
      <div className="nc-card nc-section nc-glass nc-alert-controls">
        <div className="nc-alert-controls-head">
          <button
            type="button"
            className="nc-icon-btn"
            onClick={() => {
              trackUiEvent("refresh_clicked", { page: "alerts" });
              revalidator.revalidate();
            }}
            disabled={revalidator.state === "loading"}
          >
            {revalidator.state === "loading" ? "Refreshing..." : "Refresh now"}
          </button>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>
        <div className="nc-alert-controls-grid">
          <div className="nc-alert-control-group" aria-label="Alerts presets">
            <span className="nc-note">Mode</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {[
                ["triage", "Triage"],
                ["rules-first", "Rules First"],
                ["full", "Full View"],
              ].map(([key, label]) => (
                <button key={key} type="button" className={`nc-chip ${alertsPreset === key ? "is-active" : ""}`} onClick={() => selectAlertsPreset(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="nc-alert-control-group" aria-label="Alerts table density">
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
          <p className="nc-note">Missing ad connectors can reduce anomaly quality.</p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {!permissions?.hasMetaConnector ? <a className="nc-chip" href="/app/integrations?wizard=1">Connect Meta</a> : null}
            {!permissions?.hasGoogleConnector ? <a className="nc-chip" href="/app/integrations?wizard=1">Connect Google</a> : null}
          </div>
        </div>
      ) : null}
      <div className="nc-card nc-section nc-glass">
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
      </div>

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

      {showFilter ? <div className="nc-card nc-section">
        <h2>Severity Filter</h2>
        <div className="nc-toolbar">
          {SEVERITIES.map((item) => (
            <Link key={item} to={`?severity=${item}`} className={`nc-chip ${severity === item ? "is-active" : ""}`}>
              {item}
            </Link>
          ))}
        </div>
      </div> : null}

      {showEvents ? <div className="nc-card" id="alert-events">
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
                      <a href="/app/alerts" className="nc-chip">Reset Filters</a>
                      <a href="/app/campaigns" className="nc-chip">Review Campaign Health</a>
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
