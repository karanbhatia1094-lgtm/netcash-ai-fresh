import { Form, useActionData, useLoaderData, useLocation, useNavigate, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { getDataQualitySummary, getLastSuccessfulConnectorSyncRun, getRecentConnectorSyncRuns, listConnectorCredentials, prisma } from "../utils/db.server";
import { listConnectors, runConnectorSync } from "../utils/connector-sync.server";
import { getEnvHealth } from "../utils/env.server";
import { ensureJobQueueTable, getDeadLetterSummary, getQueueBacklogSummary, getWorkerHeartbeatSummary } from "../utils/job-queue.server";
import { resolveShopConfig } from "../utils/release-control.server";
import { getEmbeddedPassthrough, withEmbeddedContext } from "../utils/embedded-nav";

function envStatus() {
  return getEnvHealth({ includeOptional: true }).checks;
}

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function getAutonomousModeStatus({ shop, connectors, credentials, runs }) {
  const enabled = String(process.env.AUTO_SELF_HEAL_DAEMON_ENABLED || "true").toLowerCase() !== "false";
  await ensureJobQueueTable();
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since6h = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const safeShop = String(shop || "").trim().toLowerCase();

  const [latestDaemonRows, daemonActionRows, daemonFailedRows, recentSuccessfulRows, queueSummary, deadLetter, workerHeartbeat] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT type, created_at as createdAt, status
       FROM job_queue
       WHERE (shop = ${sqlQuote(safeShop)} OR shop IS NULL)
         AND payload_json LIKE '%app_loader_daemon%'
       ORDER BY created_at DESC
       LIMIT 1`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT type, COUNT(*) as total
       FROM job_queue
       WHERE created_at >= ${sqlQuote(since24h)}
         AND (shop = ${sqlQuote(safeShop)} OR shop IS NULL)
         AND payload_json LIKE '%app_loader_daemon%'
       GROUP BY type`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as total
       FROM job_queue
       WHERE created_at >= ${sqlQuote(since24h)}
         AND (shop = ${sqlQuote(safeShop)} OR shop IS NULL)
         AND payload_json LIKE '%app_loader_daemon%'
         AND status = 'failed'`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT type, created_at as createdAt, status
       FROM job_queue
       WHERE created_at >= ${sqlQuote(since24h)}
         AND (shop = ${sqlQuote(safeShop)} OR shop IS NULL)
         AND payload_json LIKE '%app_loader_daemon%'
         AND status = 'succeeded'
       ORDER BY created_at DESC
       LIMIT 10`,
    ),
    getQueueBacklogSummary(),
    getDeadLetterSummary({ shop: safeShop, days: 7, limit: 10 }),
    getWorkerHeartbeatSummary(),
  ]);

  const actionCounts = Object.fromEntries(
    (daemonActionRows || []).map((row) => [String(row.type || "unknown"), Number(row.total || 0)]),
  );
  const pullConnectors = (connectors || []).filter((row) => row.mode === "pull");
  const credsByProvider = new Map((credentials || []).map((row) => [row.provider, row]));
  const disconnectedPull = pullConnectors.filter((row) => !credsByProvider.get(row.key)?.accessToken).length;
  const recentConnectorFailures = (runs || []).filter(
    (row) => row.status === "failed" && new Date(row.createdAt).toISOString() >= since6h,
  ).length;

  const blockedIssues = [];
  if (disconnectedPull > 0) blockedIssues.push(`${disconnectedPull} pull connector(s) disconnected`);
  if (recentConnectorFailures > 0) blockedIssues.push(`${recentConnectorFailures} connector sync failure(s) in last 6h`);
  if (Number(queueSummary?.pending || 0) > Math.max(50, Number(process.env.AUTO_DAEMON_QUEUE_PENDING_WARN || 200))) {
    blockedIssues.push(`Queue backlog high (${Number(queueSummary?.pending || 0)} pending jobs)`);
  }
  if (Number(daemonFailedRows?.[0]?.total || 0) > 0) {
    blockedIssues.push(`${Number(daemonFailedRows?.[0]?.total || 0)} autonomous action(s) failed in last 24h`);
  }

  return {
    enabled,
    lastDaemonRunAt: latestDaemonRows?.[0]?.createdAt || null,
    lastDaemonJobType: latestDaemonRows?.[0]?.type || null,
    actions24h: actionCounts,
    failedActions24h: Number(daemonFailedRows?.[0]?.total || 0),
    queuePending: Number(queueSummary?.pending || 0),
    blockedIssues,
    deadLetterRecent: Number(deadLetter?.recentTotal || 0),
    staleWorkers: Number(workerHeartbeat?.staleWorkers || 0),
    activeWorkers: Number(workerHeartbeat?.activeWorkers || 0),
    workerHeartbeatRows: workerHeartbeat?.workers || [],
    deadLetterRows: deadLetter?.rows || [],
    successTimeline: (recentSuccessfulRows || []).map((row, index) => ({
      id: `${row.type || "job"}-${row.createdAt || index}`,
      type: String(row.type || "unknown"),
      createdAt: row.createdAt || null,
      status: String(row.status || "success"),
    })),
  };
}

async function dailyDigestPreview(shop) {
  const since = new Date();
  since.setDate(since.getDate() - 1);
  const orders = await prisma.netCashOrder.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });
  const grossRevenue = orders.reduce((sum, o) => sum + (o.grossValue || 0), 0);
  const netCash = orders.reduce((sum, o) => sum + (o.netCash || 0), 0);
  return {
    shop,
    orderCount: orders.length,
    grossRevenue,
    netCash,
    avgOrderValue: orders.length > 0 ? grossRevenue / orders.length : 0,
    generatedAt: new Date().toISOString(),
  };
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const connectors = listConnectors();
  const credentials = await listConnectorCredentials(session.shop);
  const runs = await getRecentConnectorSyncRuns(session.shop, 30);
  const lastGoodSnapshots = {};
  for (const connector of connectors.filter((row) => row.mode === "pull")) {
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await getLastSuccessfulConnectorSyncRun(session.shop, connector.key);
    if (snapshot) lastGoodSnapshots[connector.key] = snapshot;
  }
  const [orderCount, destinationCount, activeRulesCount] = await Promise.all([
    prisma.netCashOrder.count({ where: { shop: session.shop } }),
    prisma.activationDestination.count({ where: { shop: session.shop } }),
    prisma.audienceSyncRule.count({ where: { shop: session.shop, isActive: true } }),
  ]);
  const connectedPullConnectors = credentials.filter((row) => !!row.accessToken).length;
  const quality = await getDataQualitySummary(session.shop, 30);
  const shopConfig = await resolveShopConfig(session.shop, {
    custom_welcome_title: "",
    support_contact_email: "",
    brand_priority_tier: "",
    custom_alert_webhook: "",
  });
  const mappedPct = Number(quality?.totals?.mappedOrdersPct || 0);
  const firstValueScore = Math.max(0, Math.min(100, Math.round(
    mappedPct * 0.6
      + (orderCount > 0 ? 20 : 0)
      + (connectedPullConnectors > 0 ? 20 : 0),
  )));
  const onboardingSteps = [
    { label: "Order data synced", complete: orderCount > 0 },
    { label: "Paid connector connected", complete: connectedPullConnectors > 0 },
    { label: "Activation destination configured", complete: destinationCount > 0 },
    { label: "Audience sync rule active", complete: activeRulesCount > 0 },
  ];
  const onboardingProgress = Math.round(
    (onboardingSteps.filter((step) => step.complete).length / onboardingSteps.length) * 100
  );
  const autonomousMode = await getAutonomousModeStatus({
    shop: session.shop,
    connectors,
    credentials,
    runs,
  });
  return {
    shop: session.shop,
    connectors,
    credentials,
    runs,
    env: envStatus(),
    lastGoodSnapshots,
    onboarding: {
      progress: onboardingProgress,
      steps: onboardingSteps,
      metrics: {
        orderCount,
        connectedPullConnectors,
        destinationCount,
        activeRulesCount,
        mappedOrdersPct: mappedPct,
        firstValueScore,
      },
    },
    shopConfig,
    autonomousMode,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "test-sync") {
    const provider = String(formData.get("provider") || "meta_ads");
    const days = Number(formData.get("days") || 1);
    try {
      const result = await runConnectorSync({ provider, shop: session.shop, days });
      return { success: true, type: "sync", result };
    } catch (error) {
      return { success: false, type: "sync", error: error?.message || "Unknown error" };
    }
  }

  if (intent === "test-digest-preview") {
    try {
      const digest = await dailyDigestPreview(session.shop);
      return { success: true, type: "digest", digest };
    } catch (error) {
      return { success: false, type: "digest", error: error?.message || "Unknown error" };
    }
  }

  return { success: false, error: "Invalid action" };
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { shop, connectors, credentials, runs, env, onboarding, lastGoodSnapshots, shopConfig, autonomousMode } = useLoaderData();
  const actionData = useActionData();
  const pullConnectors = connectors.filter((row) => row.mode === "pull");
  const credByProvider = new Map(credentials.map((row) => [row.provider, row]));
  const shopKey = String(shop || "global").toLowerCase();
  const landingKey = `nc_default_landing_${shopKey}`;
  const savedViewKeys = useMemo(
    () => ({
      home: `nc_home_saved_views_${shopKey}`,
      campaigns: `nc_campaign_saved_views_${shopKey}`,
      alerts: `nc_alerts_saved_views_${shopKey}`,
    }),
    [shopKey],
  );
  const applyViewSessionKeys = useMemo(
    () => ({
      home: `nc_home_apply_view_${shopKey}`,
      campaigns: `nc_campaign_apply_view_${shopKey}`,
      alerts: `nc_alerts_apply_view_${shopKey}`,
    }),
    [shopKey],
  );
  const embeddedPassthroughQuery = getEmbeddedPassthrough(location.search);
  const withEmbedded = (href) => withEmbeddedContext(href, embeddedPassthroughQuery);
  const [defaultLanding, setDefaultLanding] = useState("/app");
  const [savedViews, setSavedViews] = useState({ home: [], campaigns: [], alerts: [] });

  const loadSavedViews = useCallback(() => {
    if (typeof window === "undefined") return;
    const read = (key) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
      } catch {
        return [];
      }
    };
    setSavedViews({
      home: read(savedViewKeys.home),
      campaigns: read(savedViewKeys.campaigns),
      alerts: read(savedViewKeys.alerts),
    });
  }, [savedViewKeys]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const landing = String(window.localStorage.getItem(landingKey) || "/app");
    setDefaultLanding(landing.startsWith("/app") ? landing : "/app");
    loadSavedViews();
    const onStorage = (event) => {
      if (!event.key) return;
      if (event.key === landingKey || Object.values(savedViewKeys).includes(event.key)) {
        const nextLanding = String(window.localStorage.getItem(landingKey) || "/app");
        setDefaultLanding(nextLanding.startsWith("/app") ? nextLanding : "/app");
        loadSavedViews();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [landingKey, loadSavedViews, savedViewKeys]);

  const saveDefaultLanding = () => {
    if (typeof window === "undefined") return;
    const safe = String(defaultLanding || "/app");
    const next = safe.startsWith("/app") ? safe : "/app";
    window.localStorage.setItem(landingKey, next);
  };

  const deleteSavedView = (page, id) => {
    if (typeof window === "undefined") return;
    const key = savedViewKeys[page];
    if (!key) return;
    const current = savedViews?.[page] || [];
    const next = current.filter((row) => row.id !== id);
    window.localStorage.setItem(key, JSON.stringify(next));
    setSavedViews((prev) => ({ ...prev, [page]: next }));
  };

  const clearSavedViewsPage = (page) => {
    if (typeof window === "undefined") return;
    const key = savedViewKeys[page];
    if (!key) return;
    window.localStorage.setItem(key, "[]");
    setSavedViews((prev) => ({ ...prev, [page]: [] }));
  };

  const openSavedView = (page, view) => {
    if (typeof window === "undefined") return;
    if (!view || !page) return;
    const key = applyViewSessionKeys[page];
    if (key) window.sessionStorage.setItem(key, JSON.stringify(view));
    const base = page === "home" ? "/app" : page === "campaigns" ? "/app/campaigns" : "/app/alerts";
    navigate(withEmbedded(base), { preventScrollReset: true });
  };

  return (
    <div className="nc-shell">
      <h1>Settings and Health</h1>
      <p className="nc-subtitle">Shop: {shop}</p>

      <div className="nc-card nc-section nc-glass">
        <h2>Workspace Defaults</h2>
        <div className="nc-grid-4">
          <label className="nc-form-field">
            Default landing page
            <select value={defaultLanding} onChange={(event) => setDefaultLanding(String(event.target.value || "/app"))}>
              <option value="/app">Home</option>
              <option value="/app/campaigns">Campaigns</option>
              <option value="/app/alerts">Alerts</option>
              <option value="/app/universal">Universal Insights</option>
              <option value="/app/intelligence">Intelligence</option>
              <option value="/app/integrations">Integrations</option>
            </select>
          </label>
          <div className="nc-form-field">
            <span>Actions</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <button type="button" className="nc-chip" onClick={saveDefaultLanding}>Save default</button>
              <button type="button" className="nc-chip" onClick={() => { setDefaultLanding("/app"); if (typeof window !== "undefined") window.localStorage.setItem(landingKey, "/app"); }}>Reset to Home</button>
            </div>
          </div>
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Global Saved Views Manager</h2>
        <p className="nc-note">Manage saved views for Home, Campaigns, and Alerts in one place.</p>
        {["home", "campaigns", "alerts"].map((page) => (
          <div key={`saved-views-${page}`} className="nc-soft-box" style={{ marginBottom: "10px" }}>
            <div className="nc-section-head-inline">
              <strong style={{ textTransform: "capitalize" }}>{page}</strong>
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                <button type="button" className="nc-chip" onClick={() => clearSavedViewsPage(page)}>Clear all</button>
              </div>
            </div>
            {(savedViews?.[page] || []).length === 0 ? (
              <p className="nc-note" style={{ marginBottom: 0 }}>No saved views.</p>
            ) : (
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                {(savedViews[page] || []).slice(0, 12).map((view) => (
                  <span key={`settings-view-${page}-${view.id}`} className="nc-saved-view-pill">
                    <button type="button" className="nc-chip" onClick={() => openSavedView(page, view)}>{view.name || "Untitled"}</button>
                    <button type="button" className="nc-chip" onClick={() => deleteSavedView(page, view.id)}>Delete</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Autonomous Mode</h2>
        <p className="nc-note">
          Status: <span className={autonomousMode?.enabled ? "nc-success" : "nc-danger"}>{autonomousMode?.enabled ? "Enabled" : "Disabled"}</span>
        </p>
        <p className="nc-note">
          Last self-heal run: {autonomousMode?.lastDaemonRunAt ? new Date(autonomousMode.lastDaemonRunAt).toLocaleString() : "No run recorded yet"}
          {autonomousMode?.lastDaemonJobType ? ` (${autonomousMode.lastDaemonJobType})` : ""}
        </p>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Actions (24h)</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              {Object.keys(autonomousMode?.actions24h || {}).length === 0
                ? "No autonomous actions in last 24h"
                : Object.entries(autonomousMode.actions24h).map(([type, count]) => `${type}: ${count}`).join(" | ")}
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Failed Actions (24h)</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>{Number(autonomousMode?.failedActions24h || 0)}</p>
          </div>
          <div className="nc-soft-box">
            <strong>Queue Pending</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>{Number(autonomousMode?.queuePending || 0)} jobs</p>
          </div>
          <div className="nc-soft-box">
            <strong>Blocked Issues</strong>
            {(autonomousMode?.blockedIssues || []).length === 0 ? (
              <p className="nc-note" style={{ marginBottom: 0 }}>None detected</p>
            ) : (
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                {autonomousMode.blockedIssues.map((issue) => (
                  <li key={issue} className="nc-note">{issue}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="nc-grid-4" style={{ marginTop: "12px" }}>
          <div className="nc-soft-box">
            <strong>Active Workers</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>{Number(autonomousMode?.activeWorkers || 0)}</p>
          </div>
          <div className="nc-soft-box">
            <strong>Stale Workers</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>{Number(autonomousMode?.staleWorkers || 0)}</p>
          </div>
          <div className="nc-soft-box">
            <strong>Dead-Letter (7d)</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>{Number(autonomousMode?.deadLetterRecent || 0)}</p>
          </div>
          <div className="nc-soft-box">
            <strong>Worker Heartbeats</strong>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              {(autonomousMode?.workerHeartbeatRows || []).length === 0 ? "No workers reported yet" : "Live telemetry available"}
            </p>
          </div>
        </div>
        <div className="nc-soft-box" style={{ marginTop: "12px" }}>
          <strong>Last Successful Auto-Fix Timeline (24h)</strong>
          {(autonomousMode?.successTimeline || []).length === 0 ? (
            <p className="nc-note" style={{ marginBottom: 0, marginTop: "6px" }}>
              No successful autonomous actions recorded in the last 24 hours.
            </p>
          ) : (
            <div className="nc-scroll" style={{ marginTop: "8px" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Time</th>
                    <th style={{ textAlign: "left" }}>Action</th>
                    <th style={{ textAlign: "left" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {autonomousMode.successTimeline.map((row) => (
                    <tr key={row.id}>
                      <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                      <td>{row.type}</td>
                      <td className="nc-success">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="nc-soft-box" style={{ marginTop: "12px" }}>
          <strong>Dead-Letter Events (Recent)</strong>
          {(autonomousMode?.deadLetterRows || []).length === 0 ? (
            <p className="nc-note" style={{ marginBottom: 0, marginTop: "6px" }}>
              No dead-letter events in this window.
            </p>
          ) : (
            <div className="nc-scroll" style={{ marginTop: "8px" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Time</th>
                    <th style={{ textAlign: "left" }}>Type</th>
                    <th style={{ textAlign: "left" }}>Reason</th>
                    <th style={{ textAlign: "right" }}>Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {autonomousMode.deadLetterRows.map((row) => (
                    <tr key={`${row.jobId}-${row.createdAt}`}>
                      <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                      <td>{row.type}</td>
                      <td>{row.reason || "-"}</td>
                      <td style={{ textAlign: "right" }}>{Number(row.attempts || 0)}/{Number(row.maxAttempts || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Connector Health</h2>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Provider</th>
              <th style={{ textAlign: "left" }}>Mode</th>
              <th style={{ textAlign: "left" }}>Connected</th>
              <th style={{ textAlign: "left" }}>Token Expires</th>
              <th style={{ textAlign: "left" }}>Account</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((connector) => {
              const cred = credByProvider.get(connector.key);
              const connected = connector.mode === "push" ? true : !!cred?.accessToken;
              return (
                <tr key={connector.key}>
                  <td>{connector.name}</td>
                  <td>{connector.mode}</td>
                  <td className={connected ? "nc-success" : "nc-danger"}>{connected ? "Yes" : "No"}</td>
                  <td>{cred?.expiresAt ? new Date(cred.expiresAt).toLocaleString() : "-"}</td>
                  <td>{cred?.accountId || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section">
        <h2>Support-Safe Last Good Snapshots</h2>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Provider</th>
              <th style={{ textAlign: "left" }}>Last Successful Sync</th>
              <th style={{ textAlign: "right" }}>Spend Rows</th>
              <th style={{ textAlign: "right" }}>Attribution Rows</th>
            </tr>
          </thead>
          <tbody>
            {pullConnectors.map((connector) => {
              const snap = lastGoodSnapshots?.[connector.key];
              return (
                <tr key={`snapshot-${connector.key}`}>
                  <td>{connector.name}</td>
                  <td>{snap?.createdAt ? new Date(snap.createdAt).toLocaleString() : "No successful snapshot yet"}</td>
                  <td style={{ textAlign: "right" }}>{snap?.spendRowsWritten ?? 0}</td>
                  <td style={{ textAlign: "right" }}>{snap?.attributionRowsWritten ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section">
        <h2>Brand-Specific Overrides</h2>
        <p className="nc-note">Effective per-shop configuration for this brand.</p>
        <pre className="nc-code-block">{JSON.stringify(shopConfig || {}, null, 2)}</pre>
      </div>

      <div className="nc-card nc-section">
        <h2>Cron and Digest Tester</h2>
        <div className="nc-toolbar">
          <Form method="post" className="nc-form-row">
            <input type="hidden" name="intent" value="test-sync" />
            <label className="nc-form-field">
              Provider
              <select name="provider" defaultValue="meta_ads">
                {pullConnectors.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="nc-form-field">
              Days
              <input type="number" name="days" defaultValue={1} min={1} max={30} />
            </label>
            <button type="submit">Run Test Sync</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="test-digest-preview" />
            <button type="submit">Generate Digest Preview</button>
          </Form>
        </div>
        {actionData ? (
          <pre
            style={{
              marginTop: "12px",
              padding: "12px",
              background: actionData.success ? "#edfdf3" : "#fff1f0",
              borderRadius: "8px",
              border: `1px solid ${actionData.success ? "#86efac" : "#fca5a5"}`,
              overflow: "auto",
            }}
          >
            {JSON.stringify(actionData, null, 2)}
          </pre>
        ) : null}
      </div>

      <div className="nc-card nc-section">
        <h2>Launch Readiness</h2>
        <p className="nc-note">Onboarding progress: {onboarding.progress}%</p>
        <p className="nc-note">Time-to-first-value score: {onboarding.metrics.firstValueScore}%</p>
        <div className="nc-toolbar">
          <a className="nc-chip" href="/health" target="_blank" rel="noreferrer">Open /health</a>
          <a className="nc-chip" href="/health/readiness" target="_blank" rel="noreferrer">Open /health/readiness</a>
          <a className="nc-chip" href="/api/onboarding/status" target="_blank" rel="noreferrer">Open /api/onboarding/status</a>
          <a className="nc-chip" href="/api/onboarding/first-value" target="_blank" rel="noreferrer">Open /api/onboarding/first-value</a>
          <a className="nc-chip" href="/api/billing/status" target="_blank" rel="noreferrer">Open /api/billing/status</a>
          <a className="nc-chip" href="/api/data-quality/summary?days=30" target="_blank" rel="noreferrer">Open /api/data-quality/summary</a>
          <a className="nc-chip" href="/api/monitoring/overview" target="_blank" rel="noreferrer">Open /api/monitoring/overview</a>
          <a className="nc-chip" href="/api/monitoring/alerts" target="_blank" rel="noreferrer">Open /api/monitoring/alerts</a>
          <a className="nc-chip" href="/api/security/secrets" target="_blank" rel="noreferrer">Open /api/security/secrets</a>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Step</th>
              <th style={{ textAlign: "left" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {onboarding.steps.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className={row.complete ? "nc-success" : "nc-danger"}>{row.complete ? "Done" : "Pending"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="nc-card nc-section">
        <h2>Compliance and Trust Links</h2>
        <div className="nc-toolbar">
          <a className="nc-chip" href="/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>
          <a className="nc-chip" href="/legal/dpa" target="_blank" rel="noreferrer">DPA</a>
          <a className="nc-chip" href="/legal/data-retention" target="_blank" rel="noreferrer">Data Retention</a>
          <a className="nc-chip" href="/legal/deletion" target="_blank" rel="noreferrer">Deletion Flow</a>
          <a className="nc-chip" href="/support/sla" target="_blank" rel="noreferrer">Support SLA</a>
          <a className="nc-chip" href="/status/known-issues" target="_blank" rel="noreferrer">Known Issues</a>
          <a className="nc-chip" href="/sales/proof-pack" target="_blank" rel="noreferrer">Proof Pack</a>
        </div>
      </div>

      <div className="nc-card nc-section">
        <h2>Environment Readiness</h2>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Variable</th>
              <th style={{ textAlign: "left" }}>Required</th>
              <th style={{ textAlign: "left" }}>Present</th>
            </tr>
          </thead>
          <tbody>
            {env.map((item) => (
              <tr key={item.key}>
                <td>{item.key}</td>
                <td>{item.required ? "Yes" : "Optional"}</td>
                <td className={item.present ? "nc-success" : item.required ? "nc-danger" : "nc-muted"}>
                  {item.present ? "Configured" : "Missing"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="nc-card">
        <h2>Recent Sync Runs</h2>
        <div className="nc-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Time</th>
                <th style={{ textAlign: "left" }}>Provider</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "right" }}>Days</th>
                <th style={{ textAlign: "right" }}>Spend Written</th>
                <th style={{ textAlign: "right" }}>Attribution Written</th>
                <th style={{ textAlign: "right" }}>Duration</th>
                <th style={{ textAlign: "left" }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="nc-empty-block">
                      No sync runs yet.
                    </div>
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.createdAt).toLocaleString()}</td>
                    <td>{run.provider}</td>
                    <td className={run.status === "success" ? "nc-success" : "nc-danger"}>{run.status}</td>
                    <td style={{ textAlign: "right" }}>{run.lookbackDays}</td>
                    <td style={{ textAlign: "right" }}>{run.spendRowsWritten}</td>
                    <td style={{ textAlign: "right" }}>{run.attributionRowsWritten}</td>
                    <td style={{ textAlign: "right" }}>{run.durationMs} ms</td>
                    <td>{run.errorMessage || "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Something went wrong while loading Settings.");
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Settings Unavailable</h2>
        <p className="nc-note">{message}</p>
        <a className="nc-chip" href="/app/settings">Reload Settings</a>
      </div>
    </div>
  );
}
