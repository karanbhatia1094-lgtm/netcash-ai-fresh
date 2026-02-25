import { Form, useActionData, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { getDataQualitySummary, getLastSuccessfulConnectorSyncRun, getRecentConnectorSyncRuns, listConnectorCredentials, prisma } from "../utils/db.server";
import { listConnectors, runConnectorSync } from "../utils/connector-sync.server";
import { getEnvHealth } from "../utils/env.server";
import { resolveShopConfig } from "../utils/release-control.server";

function envStatus() {
  return getEnvHealth({ includeOptional: true }).checks;
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
  const { shop, connectors, credentials, runs, env, onboarding, lastGoodSnapshots, shopConfig } = useLoaderData();
  const actionData = useActionData();
  const pullConnectors = connectors.filter((row) => row.mode === "pull");
  const credByProvider = new Map(credentials.map((row) => [row.provider, row]));

  return (
    <div className="nc-shell">
      <h1>Settings and Health</h1>
      <p className="nc-subtitle">Shop: {shop}</p>

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
