import { Form, useActionData, useFetcher, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { listConnectors } from "../utils/connector-sync.server";
import { getAttributionTemplateCatalog } from "../utils/attribution-templates";
import { getStorefrontSignalDiagnostics } from "../utils/storefront-signal-diagnostics.server";
import { enqueueJob } from "../utils/job-queue.server";
import {
  createActivationDestination,
  createAudienceSyncRule,
  deleteActivationDestination,
  deleteAudienceSyncRule,
  getConnectorCredential,
  getOrders,
  getUniversalShopOverview,
  getSourceMetrics,
  listActivationDestinations,
  listAudienceSyncRules,
  listAudienceSyncRuns,
  listConnectorCredentials,
  listMarketBenchmarks,
  runAudienceSyncRules,
  triggerActivationDestination,
  updateActivationDestination,
  updateAudienceSyncRuleStatus,
  upsertConnectorCredential,
  upsertToolAttribution,
} from "../utils/db.server";

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function formatDestinationDisplay(endpointUrl) {
  const value = String(endpointUrl || "");
  if (value.startsWith("meta://")) {
    const clean = value.replace(/^meta:\/\//, "");
    const [accountId, audienceId] = clean.split("/");
    return `Meta Ads (account: ${accountId || "-"}${audienceId ? `, audience: ${audienceId}` : ""})`;
  }
  if (value.startsWith("google://")) {
    const clean = value.replace(/^google:\/\//, "");
    const [customerId, userListId] = clean.split("/");
    return `Google Ads (customer: ${customerId || "-"}${userListId ? `, list: ${userListId}` : ""})`;
  }
  return value;
}

function getDestinationTypeFromUrl(endpointUrl) {
  const value = String(endpointUrl || "");
  if (value.startsWith("meta://")) return "meta_ads";
  if (value.startsWith("google://")) return "google_ads";
  return "webhook";
}

function parseDestinationUrlForForm(endpointUrl) {
  const value = String(endpointUrl || "");
  if (value.startsWith("meta://")) {
    const clean = value.replace(/^meta:\/\//, "");
    const [accountId, audienceId] = clean.split("/");
    return {
      type: "meta_ads",
      webhookUrl: "",
      metaAccountId: accountId || "",
      metaAudienceId: audienceId || "",
      googleCustomerId: "",
      googleUserListId: "",
    };
  }
  if (value.startsWith("google://")) {
    const clean = value.replace(/^google:\/\//, "");
    const [customerId, userListId] = clean.split("/");
    return {
      type: "google_ads",
      webhookUrl: "",
      metaAccountId: "",
      metaAudienceId: "",
      googleCustomerId: customerId || "",
      googleUserListId: userListId || "",
    };
  }
  return {
    type: "webhook",
    webhookUrl: value,
    metaAccountId: "",
    metaAudienceId: "",
    googleCustomerId: "",
    googleUserListId: "",
  };
}

function toSafeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const oauth = url.searchParams.get("oauth");
  const oauthError = url.searchParams.get("oauthError");
  const credentials = await listConnectorCredentials(session.shop);
  const destinations = await listActivationDestinations(session.shop);
  const benchmarks = await listMarketBenchmarks("ecommerce_d2c");
  const orders30 = await getOrders(session.shop, 30);
  const spendBySource30 = await getSourceMetrics(30);
  const adSpend30 = spendBySource30.reduce((sum, row) => sum + (row.adSpend || 0), 0);
  const gross30 = orders30.reduce((sum, row) => sum + (row.grossValue || 0), 0);
  const net30 = orders30.reduce((sum, row) => sum + (row.netCash || 0), 0);
  const derivedBenchmarks = {
    real_roas: adSpend30 > 0 ? net30 / adSpend30 : 0,
    profit_margin_pct: gross30 > 0 ? (net30 / gross30) * 100 : 0,
    net_cash_per_order: orders30.length > 0 ? net30 / orders30.length : 0,
  };
  const templateCatalog = getAttributionTemplateCatalog({
    shop: session.shop,
    sampleOrder: orders30[0],
  });
  const storefrontSignalDiagnostics = await getStorefrontSignalDiagnostics(session.shop, 30);
  const universalOverview = await getUniversalShopOverview(session.shop, 90);
  return {
    shop: session.shop,
    connectors: listConnectors(),
    credentials,
    destinations,
    benchmarks,
    derivedBenchmarks,
    audienceRules: await listAudienceSyncRules(session.shop),
    audienceRuns: await listAudienceSyncRuns(session.shop, 20),
    oauth,
    oauthError,
    templateCatalog,
    storefrontSignalDiagnostics,
    universalOverview,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const buildDestinationPayload = async () => {
    const name = String(formData.get("name") || "").trim();
    const destinationType = String(formData.get("destinationType") || "webhook").trim().toLowerCase();
    let endpointUrl = "";
    const authHeaderName = String(formData.get("authHeaderName") || "").trim();
    const authHeaderValue = String(formData.get("authHeaderValue") || "").trim();

    if (!name) return { error: "name is required" };

    if (destinationType === "meta_ads") {
      const connected = await getConnectorCredential(session.shop, "meta_ads");
      const accountId = String(formData.get("metaAccountId") || connected?.accountId || "").trim().replace(/^act_/, "");
      const audienceId = String(formData.get("metaAudienceId") || "").trim();
      if (!accountId) return { error: "Meta ad account ID is required (or connect Meta first)." };
      endpointUrl = `meta://${accountId}${audienceId ? `/${audienceId}` : ""}`;
    } else if (destinationType === "google_ads") {
      const connected = await getConnectorCredential(session.shop, "google_ads");
      const customerId = String(formData.get("googleCustomerId") || connected?.accountId || "").trim();
      const userListId = String(formData.get("googleUserListId") || "").trim();
      if (!customerId) return { error: "Google customer ID is required (or connect Google first)." };
      endpointUrl = `google://${customerId}${userListId ? `/${userListId}` : ""}`;
    } else {
      endpointUrl = String(formData.get("endpointUrl") || "").trim();
      if (!endpointUrl) return { error: "Webhook URL is required." };
    }

    return {
      destinationType,
      payload: {
        name,
        endpointUrl,
        authHeaderName: destinationType === "webhook" ? authHeaderName || null : null,
        authHeaderValue: destinationType === "webhook" ? authHeaderValue || null : null,
        isActive: true,
      },
    };
  };

  if (intent === "run-sync") {
    const provider = String(formData.get("provider") || "");
    const days = Number(formData.get("days") || 7);
    try {
      const result = await enqueueJob({
        type: "connector_sync",
        shop: session.shop,
        payload: {
          provider,
          shop: session.shop,
          days,
        },
        uniqueKey: `connector_sync:${session.shop}:${provider}`,
        maxAttempts: 4,
      });
      return { success: true, queued: true, result };
    } catch (error) {
      return { success: false, error: error?.message || "Unknown error" };
    }
  }

  if (intent === "save-account") {
    const provider = String(formData.get("provider") || "");
    const accountId = String(formData.get("accountId") || "").trim();
    const accountName = String(formData.get("accountName") || "").trim();
    if (!provider) {
      return { success: false, error: "provider is required" };
    }
    const existing = await getConnectorCredential(session.shop, provider);
    await upsertConnectorCredential({
      shop: session.shop,
      provider,
      accountId: accountId || null,
      accountName: accountName || null,
      accessToken: existing?.accessToken || null,
      refreshToken: existing?.refreshToken || null,
      tokenType: existing?.tokenType || null,
      scope: existing?.scope || null,
      expiresAt: existing?.expiresAt || null,
      metadata: existing?.metadata ? JSON.parse(existing.metadata) : null,
    });
    return { success: true, result: { provider, accountId, accountName } };
  }

  if (intent === "add-destination") {
    const built = await buildDestinationPayload();
    if (built.error) return { success: false, error: built.error };
    await createActivationDestination(session.shop, built.payload);
    return { success: true, result: { name: built.payload.name, destinationType: built.destinationType, endpointUrl: built.payload.endpointUrl } };
  }

  if (intent === "update-destination") {
    const destinationId = Number(formData.get("destinationId") || 0);
    if (!destinationId) return { success: false, error: "destinationId is required" };
    const built = await buildDestinationPayload();
    if (built.error) return { success: false, error: built.error };
    await updateActivationDestination(session.shop, destinationId, built.payload);
    return { success: true, result: { destinationId, name: built.payload.name, destinationType: built.destinationType } };
  }

  if (intent === "delete-destination") {
    await deleteActivationDestination(session.shop, formData.get("destinationId"));
    return { success: true, result: "Destination deleted" };
  }

  if (intent === "test-destination") {
    const destinationId = Number(formData.get("destinationId") || 0);
    const payload = {
      type: "activation_test",
      shop: session.shop,
      timestamp: new Date().toISOString(),
      message: "Netcash activation test payload",
    };
    const result = await triggerActivationDestination(session.shop, destinationId, payload);
    return { success: result.ok, result };
  }

  if (intent === "add-audience-rule") {
    await createAudienceSyncRule(session.shop, {
      name: formData.get("name"),
      audienceName: formData.get("audienceName"),
      destinationId: Number(formData.get("destinationId") || 0),
      metric: formData.get("metric"),
      comparator: formData.get("comparator"),
      threshold: Number(formData.get("threshold") || 0),
      source: formData.get("source") || null,
      isActive: true,
    });
    return { success: true, result: "Rule created" };
  }

  if (intent === "toggle-audience-rule") {
    const current = String(formData.get("isActive") || "false") === "true";
    await updateAudienceSyncRuleStatus(session.shop, formData.get("ruleId"), !current);
    return { success: true, result: "Rule status updated" };
  }

  if (intent === "delete-audience-rule") {
    await deleteAudienceSyncRule(session.shop, formData.get("ruleId"));
    return { success: true, result: "Rule deleted" };
  }

  if (intent === "run-audience-rules") {
    const ruleIdRaw = String(formData.get("ruleId") || "").trim();
    const runResult = await runAudienceSyncRules(session.shop, {
      days: Number(formData.get("days") || 30),
      ruleId: ruleIdRaw ? Number(ruleIdRaw) : null,
    });
    return { success: true, result: runResult };
  }

  if (intent === "test-attribution-template") {
    const provider = String(formData.get("provider") || "").trim().toLowerCase();
    if (!provider) return { success: false, error: "provider is required" };
    const orders = await getOrders(session.shop, 30);
    const sampleOrder = orders[0];
    if (!sampleOrder) {
      return { success: false, error: "No orders found to map. Create at least one order in dev store and retry." };
    }

    const templateCatalog = getAttributionTemplateCatalog({
      shop: session.shop,
      sampleOrder,
    });
    const template = templateCatalog.find((row) => row.provider === provider);
    if (!template) return { success: false, error: `Unsupported provider: ${provider}` };

    const records = Array.isArray(template.payload?.records) ? template.payload.records : [];
    const results = [];
    for (const record of records) {
      const updated = await upsertToolAttribution({
        shop: record.shop || session.shop,
        tool: template.provider,
        orderId: record.orderId || null,
        orderNumber: record.orderNumber || null,
        campaignId: record.campaignId || null,
        campaignName: record.campaignName || null,
        adSetId: record.adSetId || null,
        adId: record.adId || null,
      });
      results.push({
        provider: template.provider,
        orderId: updated.orderId,
        campaignId: updated.campaignId,
        campaignName: updated.campaignName,
      });
    }

    return {
      success: true,
      type: "attribution_template_test",
      result: {
        provider: template.provider,
        testedRecords: results.length,
        results,
      },
    };
  }

  return { success: false, error: "Invalid action" };
}

export default function AdditionalPage() {
  const {
    shop,
    connectors,
    credentials,
    destinations,
    benchmarks,
    derivedBenchmarks,
    audienceRules,
    audienceRuns,
    oauth,
    oauthError,
    templateCatalog,
    storefrontSignalDiagnostics,
    universalOverview,
  } = useLoaderData();
  const actionData = useActionData();
  const diagnosticsFetcher = useFetcher();
  const pullConnectors = connectors.filter((row) => row.mode === "pull");
  const pushConnectors = connectors.filter((row) => row.mode === "push");
  const byProvider = new Map(credentials.map((row) => [row.provider, row]));
  const [templateSearch, setTemplateSearch] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [destinationType, setDestinationType] = useState("webhook");
  const [editingDestinationId, setEditingDestinationId] = useState(null);
  const editingDestination = destinations.find((item) => item.id === editingDestinationId) || null;
  const parsedEditDestination = editingDestination ? parseDestinationUrlForForm(editingDestination.endpointUrl) : null;
  const [editDestinationType, setEditDestinationType] = useState(
    editingDestination ? getDestinationTypeFromUrl(editingDestination.endpointUrl) : "webhook",
  );
  const diagnostics =
    diagnosticsFetcher.data?.ok && diagnosticsFetcher.data?.diagnostics
      ? diagnosticsFetcher.data.diagnostics
      : storefrontSignalDiagnostics;
  const filteredTemplateCatalog = (templateCatalog || []).filter((row) => {
    const hay = `${row.provider} ${row.name}`.toLowerCase();
    return hay.includes(templateSearch.trim().toLowerCase());
  });

  return (
    <div className="nc-shell">
      <h1>Advanced Integrations</h1>
      <p className="nc-subtitle">
        Shop: <strong>{shop}</strong>
      </p>
      <div className="nc-card nc-section nc-glass">
        <h2>Primary Setup</h2>
        <p className="nc-note">For most brands, use Integration Hub wizard first. This page is for advanced control and diagnostics.</p>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href="/app/integrations?wizard=1">Review Integration Wizard</a>
        </div>
      </div>
      {oauthError ? <p className="nc-danger" style={{ fontWeight: 600 }}>OAuth Error: {oauthError}</p> : null}
      {oauth ? <p className="nc-success" style={{ fontWeight: 600 }}>OAuth Success: {oauth}</p> : null}
      {copyFeedback ? <p className="nc-success" style={{ fontWeight: 600 }}>{copyFeedback}</p> : null}

      <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Universal Customer Graph (90d)</h2>
          <a className="nc-chip" href="/api/universal-overview?days=90" target="_blank" rel="noreferrer">Open API</a>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box"><strong>Total Events</strong><p className="nc-kpi-value">{Number(universalOverview?.totalEvents || 0)}</p></div>
          <div className="nc-soft-box"><strong>Unique Identities</strong><p className="nc-kpi-value">{Number(universalOverview?.uniqueIdentities || 0)}</p></div>
          <div className="nc-soft-box"><strong>Message Opens</strong><p className="nc-kpi-value">{Number(universalOverview?.messageOpens || 0)}</p></div>
          <div className="nc-soft-box"><strong>Ad Views</strong><p className="nc-kpi-value">{Number(universalOverview?.adViews || 0)}</p></div>
        </div>
        <p className="nc-note" style={{ marginBottom: 0 }}>
          Device mix (mobile only): iOS {toSafeNumber(universalOverview?.iosPct).toFixed(1)}% | Android {toSafeNumber(universalOverview?.androidPct).toFixed(1)}%
        </p>
      </div>

      <div className="nc-card nc-section nc-glass">
        <h2>Workspace Navigation</h2>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href="/app/intelligence">Intelligence Studio</a>
          <a className="nc-chip" href="#storefront-signal">Storefront Signal</a>
          <a className="nc-chip" href="#oauth-connections">OAuth</a>
          <a className="nc-chip" href="#connector-templates">Templates</a>
          <a className="nc-chip" href="#audience-sync">Audience Rules</a>
          <a className="nc-chip" href="#activation-destinations">Destinations</a>
        </div>
      </div>

      <div className="nc-card nc-section">
        <h2>DIY Setup Checklist</h2>
        <p className="nc-note">Plug-and-play sequence for a new brand onboarding.</p>
        <ol style={{ marginTop: 0 }}>
          <li>Enable Netcash theme app embed for storefront click-ID capture.</li>
          <li>Connect Meta and Google OAuth first to enable direct spend sync.</li>
          <li>Configure push tools (MoEngage, WebEngage, CleverTap, KwikEngage, Bik.ai, BiteSpeed, Nitro, etc.) to post to <code>/api/attribution</code>.</li>
          <li>Validate UTM coverage and timing signals in Intelligence Studio.</li>
          <li>Create Activation Destinations and at least one Audience Rule to automate messaging.</li>
          <li>Run sync and audience jobs from your scheduler using the cron endpoint.</li>
        </ol>
      </div>
      <div id="storefront-signal" className="nc-card nc-section nc-glass">
        <h2>Storefront Click-ID Capture (Step 1)</h2>
        <p className="nc-note" style={{ marginTop: 0 }}>
          This captures <code>fbclid</code>, <code>gclid</code>, and UTM parameters as first-party data and writes them to Shopify cart attributes.
          When orders sync into Netcash.ai, those values are read from order custom attributes for attribution recovery.
        </p>
        <h3 style={{ marginBottom: "8px" }}>Recommended: Theme App Extension (one-click in theme)</h3>
        <ol style={{ marginTop: 0 }}>
          <li>Deploy app version that includes extension <code>extensions/netcash-signal-capture</code>.</li>
          <li>In Shopify Admin, open <strong>Online Store - Themes - Customize - App embeds</strong>.</li>
          <li>Enable <strong>Netcash.ai Signal Capture</strong> embed and save theme.</li>
        </ol>
        <h3 style={{ marginBottom: "8px" }}>Fallback: Manual snippet (if needed)</h3>
        <ol style={{ marginTop: 0 }}>
          <li>Open <strong>Online Store - Themes - Edit code - Assets</strong>.</li>
          <li>Create <code>netcash-storefront-signal.js</code> and paste <code>public/netcash-storefront-signal.js</code>.</li>
          <li>Add this include before <code>&lt;/body&gt;</code> in <code>theme.liquid</code>.</li>
        </ol>
        <pre className="nc-code-block">{`<script src="{{ 'netcash-storefront-signal.js' | asset_url }}" defer></script>`}</pre>
        <h3 style={{ marginBottom: "8px" }}>Verification</h3>
        <ol style={{ marginTop: 0 }}>
          <li>Open storefront with test params:
            <code style={{ marginLeft: "6px" }}>?utm_source=meta&utm_medium=paid&utm_campaign=test&fbclid=test123</code>
          </li>
          <li>Add any item to cart and start checkout.</li>
          <li>After order sync, confirm order has <code>campaignId/campaignName/clickId</code> and improved attribution coverage on Home.</li>
        </ol>
        <div className="nc-section-head-inline" style={{ marginTop: "8px" }}>
          <h3 style={{ marginBottom: "8px" }}>Signal Diagnostics (last 30 days)</h3>
          <button
            type="button"
            className="nc-chip"
            onClick={() => diagnosticsFetcher.load("/api/storefront/signal-diagnostics?days=30")}
            disabled={diagnosticsFetcher.state !== "idle"}
          >
            {diagnosticsFetcher.state !== "idle" ? "Refreshing..." : "Refresh diagnostics"}
          </button>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Coverage</strong>
            <p className="nc-kpi-value">{toSafeNumber(diagnostics?.coveragePct).toFixed(0)}%</p>
            <p className="nc-note">{diagnostics?.signalOrders || 0}/{diagnostics?.totalOrders || 0} orders with storefront signals.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Click ID Captured</strong>
            <p className="nc-kpi-value">{toSafeNumber(diagnostics?.clickIdPct).toFixed(0)}%</p>
            <p className="nc-note">{diagnostics?.clickIdOrders || 0} orders with click IDs.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Full UTM Coverage</strong>
            <p className="nc-kpi-value">{toSafeNumber(diagnostics?.fullUtmPct).toFixed(0)}%</p>
            <p className="nc-note">{diagnostics?.fullUtmOrders || 0} orders with source/medium/campaign.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Touchpoint Path</strong>
            <p className="nc-kpi-value">{toSafeNumber(diagnostics?.touchpointPct).toFixed(0)}%</p>
            <p className="nc-note">{diagnostics?.touchpointOrders || 0} orders with touchpoint history.</p>
          </div>
        </div>
        <div className="nc-soft-box" style={{ marginTop: "10px" }}>
          <strong>Latest Captured Signal</strong>
          {diagnostics?.latestSignalOrder ? (
            <table className="nc-table-card" style={{ marginTop: "8px" }}>
              <tbody>
                <tr><td style={{ width: "180px" }}>Order</td><td>#{diagnostics.latestSignalOrder.orderNumber || "-"}</td></tr>
                <tr><td>Captured At</td><td>{new Date(diagnostics.latestSignalOrder.createdAt).toLocaleString()}</td></tr>
                <tr><td>Source</td><td>{diagnostics.latestSignalOrder.utmSource || diagnostics.latestSignalOrder.marketingSource || "-"}</td></tr>
                <tr><td>Campaign</td><td>{diagnostics.latestSignalOrder.utmCampaign || diagnostics.latestSignalOrder.campaignName || diagnostics.latestSignalOrder.campaignId || "-"}</td></tr>
                <tr><td>Click ID</td><td>{diagnostics.latestSignalOrder.clickId || "-"}</td></tr>
                <tr><td>Landing URL</td><td style={{ wordBreak: "break-all" }}>{diagnostics.latestSignalOrder.landingSite || "-"}</td></tr>
                <tr><td>Referrer</td><td style={{ wordBreak: "break-all" }}>{diagnostics.latestSignalOrder.referringSite || "-"}</td></tr>
              </tbody>
            </table>
          ) : (
            <p className="nc-note" style={{ margin: "8px 0 0" }}>No captured storefront signal found yet in the selected window.</p>
          )}
          <p className="nc-note" style={{ marginTop: "8px" }}>
            API endpoint: <code>/api/storefront/signal-diagnostics?days=30</code>
          </p>
        </div>
      </div>

      <div id="oauth-connections" className="nc-card nc-section nc-glass">
        <h2>OAuth Connections</h2>
        <div className="nc-toolbar" style={{ marginBottom: "14px" }}>
          <a
            href="/app/connectors/meta/start"
            className="nc-chip"
          >
            {byProvider.get("meta_ads")?.accessToken ? "Reconnect Meta Ads" : "Connect Meta Ads"}
          </a>
          <a
            href="/app/connectors/google/start"
            className="nc-chip"
          >
            {byProvider.get("google_ads")?.accessToken ? "Reconnect Google Ads" : "Connect Google Ads"}
          </a>
        </div>
        <table style={{ marginBottom: "18px" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "10px" }}>Provider</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Status</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Account Id</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {["meta_ads", "google_ads"].map((provider) => {
              const row = byProvider.get(provider);
              return (
                <tr key={provider} style={{ borderBottom: "1px solid #e0e0e0" }}>
                  <td style={{ padding: "10px" }}>{provider}</td>
                  <td style={{ padding: "10px", color: row?.accessToken ? "#027a48" : "#b42318" }}>
                    {row?.accessToken ? "Connected" : "Not connected"}
                  </td>
                  <td style={{ padding: "10px" }}>{row?.accountId || "-"}</td>
                  <td style={{ padding: "10px" }}>
                    {row?.expiresAt ? new Date(row.expiresAt).toLocaleString() : "No expiry / Unknown"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3 style={{ marginTop: 0 }}>Provider Account Settings</h3>
        <p style={{ marginTop: 0 }}>
          Set Meta Ad Account ID and Google Customer ID once connected to avoid relying on env defaults.
        </p>
        <div className="nc-stack-sm" style={{ marginBottom: "20px" }}>
          <Form method="post" className="nc-form-row">
            <input type="hidden" name="intent" value="save-account" />
            <input type="hidden" name="provider" value="meta_ads" />
            <label className="nc-form-field">
              Meta Ad Account ID
              <input
                name="accountId"
                placeholder="without act_"
                defaultValue={byProvider.get("meta_ads")?.accountId || ""}
              />
            </label>
            <label className="nc-form-field">
              Account Name (optional)
              <input
                name="accountName"
                defaultValue={byProvider.get("meta_ads")?.accountName || ""}
              />
            </label>
            <button type="submit">
              Save Meta Settings
            </button>
          </Form>

          <Form method="post" className="nc-form-row">
            <input type="hidden" name="intent" value="save-account" />
            <input type="hidden" name="provider" value="google_ads" />
            <label className="nc-form-field">
              Google Customer ID
              <input
                name="accountId"
                placeholder="1234567890"
                defaultValue={byProvider.get("google_ads")?.accountId || ""}
              />
            </label>
            <label className="nc-form-field">
              Account Name (optional)
              <input
                name="accountName"
                defaultValue={byProvider.get("google_ads")?.accountName || ""}
              />
            </label>
            <button type="submit">
              Save Google Settings
            </button>
          </Form>
        </div>

        <h2>Auto Sync Connectors (Pull)</h2>
        <p style={{ marginTop: 0 }}>
          These connectors can pull spend/campaign data directly using stored OAuth tokens.
        </p>
        <Form method="post" className="nc-form-row">
          <input type="hidden" name="intent" value="run-sync" />
          <label className="nc-form-field">
            Provider
            <select name="provider" defaultValue="meta_ads">
              {pullConnectors.map((connector) => (
                <option value={connector.key} key={connector.key}>
                  {connector.name}
                </option>
              ))}
            </select>
          </label>
          <label className="nc-form-field">
            Lookback days
            <input type="number" name="days" min="1" max="365" defaultValue={7} />
          </label>
          <button type="submit">
            Run Sync Now
          </button>
        </Form>
        {actionData ? (
          <pre
            style={{
              marginTop: "12px",
              padding: "12px",
              background: actionData.success ? "#edfdf3" : "#fff1f0",
              borderRadius: "6px",
              border: `1px solid ${actionData.success ? "#86efac" : "#fca5a5"}`,
              overflow: "auto",
            }}
          >
            {prettyJson(actionData)}
          </pre>
        ) : null}
      </div>

      <div className="nc-card nc-section">
        <h2>Benchmarks & Trend Positioning</h2>
        <p className="nc-note">Compare your latest 30-day performance to D2C benchmark bands.</p>
        <table className="nc-table-card" style={{ marginBottom: "18px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "10px" }}>Metric</th>
              <th style={{ textAlign: "right", padding: "10px" }}>Your 30d</th>
              <th style={{ textAlign: "right", padding: "10px" }}>P50</th>
              <th style={{ textAlign: "right", padding: "10px" }}>P75</th>
              <th style={{ textAlign: "right", padding: "10px" }}>P90</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Position</th>
            </tr>
          </thead>
          <tbody>
            {(benchmarks || []).map((row) => {
              const your = derivedBenchmarks?.[row.metric] || 0;
              const position = your >= row.p90 ? "Top 10%" : your >= row.p75 ? "Top quartile" : your >= row.p50 ? "Median+" : "Below median";
              const isPct = row.metric.includes("pct");
              return (
                <tr key={`bm-${row.metric}`}>
                  <td data-label="Metric" style={{ padding: "10px" }}>{row.metric}</td>
                  <td data-label="Your 30d" style={{ padding: "10px", textAlign: "right" }}>
                    {isPct ? `${your.toFixed(2)}%` : your.toFixed(2)}
                  </td>
                  <td data-label="P50" style={{ padding: "10px", textAlign: "right" }}>{row.p50.toFixed(2)}</td>
                  <td data-label="P75" style={{ padding: "10px", textAlign: "right" }}>{row.p75.toFixed(2)}</td>
                  <td data-label="P90" style={{ padding: "10px", textAlign: "right" }}>{row.p90.toFixed(2)}</td>
                  <td data-label="Position" style={{ padding: "10px" }}>{position}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2>Push Connectors</h2>
        <p style={{ marginTop: 0 }}>
          Configure these tools to send attribution events to <code>/api/attribution</code>.
        </p>
        <table>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ textAlign: "left", padding: "10px" }}>Provider</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Mode</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Endpoint</th>
            </tr>
          </thead>
          <tbody>
            {pushConnectors.map((connector) => (
              <tr key={connector.key} style={{ borderBottom: "1px solid #e0e0e0" }}>
                <td style={{ padding: "10px" }}>{connector.name}</td>
                <td style={{ padding: "10px" }}>Push</td>
                <td style={{ padding: "10px" }}>
                  <code>/api/attribution</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div id="audience-sync" className="nc-card nc-glass">
        <h2>Automated Audience Sync Rules</h2>
        <p style={{ marginTop: 0 }}>
          Define metric-based rules and auto-push audience payloads to active destinations.
        </p>
        <Form method="post" className="nc-form-row" style={{ marginBottom: "14px" }}>
          <input type="hidden" name="intent" value="add-audience-rule" />
          <label className="nc-form-field">
            Rule name
            <input name="name" placeholder="Scale Winners Audience" required />
          </label>
          <label className="nc-form-field">
            Audience name
            <input name="audienceName" placeholder="high_roas_last_30d" required />
          </label>
          <label className="nc-form-field">
            Destination
            <select name="destinationId" required defaultValue="">
              <option value="" disabled>Select destination</option>
              {(destinations || []).map((dest) => (
                <option key={`dest-opt-${dest.id}`} value={dest.id}>{dest.name}</option>
              ))}
            </select>
          </label>
          <label className="nc-form-field">
            Metric
            <select name="metric" defaultValue="real_roas">
              <option value="real_roas">real_roas</option>
              <option value="profit_margin_pct">profit_margin_pct</option>
              <option value="avg_order_value">avg_order_value</option>
              <option value="order_count">order_count</option>
            </select>
          </label>
          <label className="nc-form-field">
            Comparator
            <select name="comparator" defaultValue="gte">
              <option value="gte">&gt;=</option>
              <option value="lte">&lt;=</option>
              <option value="gt">&gt;</option>
              <option value="lt">&lt;</option>
            </select>
          </label>
          <label className="nc-form-field">
            Threshold
            <input name="threshold" type="number" step="0.01" defaultValue="1.5" required />
          </label>
          <label className="nc-form-field">
            Source (optional)
            <input name="source" placeholder="meta / google / tiktok" />
          </label>
          <button type="submit">Create Rule</button>
        </Form>

        <div className="nc-toolbar">
          <Form method="post">
            <input type="hidden" name="intent" value="run-audience-rules" />
            <input type="hidden" name="days" value="30" />
            <button type="submit">Run All Rules Now</button>
          </Form>
        </div>

        <table className="nc-table-card" style={{ marginBottom: "16px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "10px" }}>Rule</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Condition</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Destination</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Status</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(audienceRules || []).length === 0 ? (
              <tr><td colSpan={5}>No audience rules configured.</td></tr>
            ) : (
              audienceRules.map((rule) => {
                const destination = (destinations || []).find((d) => d.id === rule.destinationId);
                return (
                  <tr key={`rule-${rule.id}`}>
                    <td data-label="Rule" style={{ padding: "10px" }}>
                      <strong>{rule.name}</strong>
                      <div className="nc-muted">{rule.audienceName}</div>
                    </td>
                    <td data-label="Condition" style={{ padding: "10px" }}>
                      {rule.metric} {rule.comparator} {rule.threshold}
                      {rule.source ? <div className="nc-muted">source: {rule.source}</div> : null}
                    </td>
                    <td data-label="Destination" style={{ padding: "10px" }}>{destination?.name || `#${rule.destinationId}`}</td>
                    <td data-label="Status" style={{ padding: "10px" }}>{rule.isActive ? "active" : "paused"}</td>
                    <td data-label="Actions" style={{ padding: "10px" }}>
                      <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                        <Form method="post">
                          <input type="hidden" name="intent" value="run-audience-rules" />
                          <input type="hidden" name="ruleId" value={rule.id} />
                          <input type="hidden" name="days" value="30" />
                          <button type="submit">Run</button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle-audience-rule" />
                          <input type="hidden" name="ruleId" value={rule.id} />
                          <input type="hidden" name="isActive" value={rule.isActive ? "true" : "false"} />
                          <button type="submit">{rule.isActive ? "Pause" : "Activate"}</button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete-audience-rule" />
                          <input type="hidden" name="ruleId" value={rule.id} />
                          <button type="submit">Delete</button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        <h3>Audience Sync Run History</h3>
        <table className="nc-table-card" style={{ marginBottom: "18px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "10px" }}>Time</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Rule ID</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Status</th>
              <th style={{ textAlign: "right", padding: "10px" }}>Metric</th>
              <th style={{ textAlign: "right", padding: "10px" }}>Matched</th>
            </tr>
          </thead>
          <tbody>
            {(audienceRuns || []).length === 0 ? (
              <tr><td colSpan={5}>No runs yet.</td></tr>
            ) : (
              audienceRuns.map((run) => (
                <tr key={`run-${run.id}`}>
                  <td data-label="Time" style={{ padding: "10px" }}>{new Date(run.createdAt).toLocaleString()}</td>
                  <td data-label="Rule ID" style={{ padding: "10px" }}>{run.ruleId}</td>
                  <td data-label="Status" style={{ padding: "10px" }}>{run.status}</td>
                  <td data-label="Metric" style={{ padding: "10px", textAlign: "right" }}>{Number(run.metricValue || 0).toFixed(2)}</td>
                  <td data-label="Matched" style={{ padding: "10px", textAlign: "right" }}>{run.matchedCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <h2 id="activation-destinations">Activation Destinations</h2>
        <p style={{ marginTop: 0 }}>
          Push audiences or campaign action events to external tools (CRM/CDP/webhook endpoints).
        </p>
        <Form method="post" className="nc-form-row" style={{ marginBottom: "14px" }}>
          <input type="hidden" name="intent" value="add-destination" />
          <label className="nc-form-field">
            Name
            <input name="name" placeholder="MoEngage Webhook" required />
          </label>
          <label className="nc-form-field">
            Destination Type
            <select name="destinationType" value={destinationType} onChange={(event) => setDestinationType(event.target.value)}>
              <option value="webhook">Webhook URL</option>
              <option value="meta_ads">Meta Ads Audience</option>
              <option value="google_ads">Google Ads Audience</option>
            </select>
          </label>
          {destinationType === "webhook" ? (
            <>
              <label className="nc-form-field" style={{ minWidth: 300 }}>
                Endpoint URL
                <input name="endpointUrl" placeholder="https://..." required />
              </label>
              <label className="nc-form-field">
                Auth Header (optional)
                <input name="authHeaderName" placeholder="Authorization" />
              </label>
              <label className="nc-form-field">
                Auth Value (optional)
                <input name="authHeaderValue" placeholder="Bearer xxxx" />
              </label>
            </>
          ) : null}
          {destinationType === "meta_ads" ? (
            <>
              <label className="nc-form-field">
                Meta Ad Account ID
                <input
                  name="metaAccountId"
                  placeholder="without act_"
                  defaultValue={byProvider.get("meta_ads")?.accountId || ""}
                  required
                />
              </label>
              <label className="nc-form-field">
                Meta Audience ID (optional)
                <input name="metaAudienceId" placeholder="existing audience id" />
              </label>
            </>
          ) : null}
          {destinationType === "google_ads" ? (
            <>
              <label className="nc-form-field">
                Google Customer ID
                <input
                  name="googleCustomerId"
                  placeholder="1234567890"
                  defaultValue={byProvider.get("google_ads")?.accountId || ""}
                  required
                />
              </label>
              <label className="nc-form-field">
                Google User List ID (optional)
                <input name="googleUserListId" placeholder="existing user list id" />
              </label>
            </>
          ) : null}
          <button type="submit">Add Destination</button>
        </Form>
        <table className="nc-table-card" style={{ marginBottom: "18px" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "10px" }}>Name</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Endpoint</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Last Status</th>
              <th style={{ textAlign: "left", padding: "10px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(destinations || []).length === 0 ? (
              <tr><td colSpan={4}>No destinations configured.</td></tr>
            ) : (
              destinations.map((item) => (
                <tr key={`dest-${item.id}`}>
                  <td data-label="Name" style={{ padding: "10px" }}>{item.name}</td>
                  <td data-label="Endpoint" style={{ padding: "10px" }}>{formatDestinationDisplay(item.endpointUrl)}</td>
                  <td data-label="Last Status" style={{ padding: "10px" }}>
                    {item.lastStatus || "Never triggered"}
                  </td>
                  <td data-label="Actions" style={{ padding: "10px" }}>
                    <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="test-destination" />
                        <input type="hidden" name="destinationId" value={item.id} />
                        <button type="submit">Test Push</button>
                      </Form>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingDestinationId(item.id);
                          setEditDestinationType(getDestinationTypeFromUrl(item.endpointUrl));
                        }}
                      >
                        Edit
                      </button>
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete-destination" />
                        <input type="hidden" name="destinationId" value={item.id} />
                        <button type="submit">Delete</button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {editingDestination ? (
          <div className="nc-modal-overlay" role="dialog" aria-modal="true" onClick={() => setEditingDestinationId(null)}>
            <div className="nc-modal" onClick={(event) => event.stopPropagation()}>
              <div className="nc-modal-header">
                <h3 style={{ margin: 0 }}>Edit Destination</h3>
                <button type="button" onClick={() => setEditingDestinationId(null)}>
                  Close
                </button>
              </div>
              <Form method="post" className="nc-form-row">
                <input type="hidden" name="intent" value="update-destination" />
                <input type="hidden" name="destinationId" value={editingDestination.id} />
                <label className="nc-form-field">
                  Name
                  <input name="name" defaultValue={editingDestination.name} required />
                </label>
                <label className="nc-form-field">
                  Destination Type
                  <select name="destinationType" value={editDestinationType} onChange={(event) => setEditDestinationType(event.target.value)}>
                    <option value="webhook">Webhook URL</option>
                    <option value="meta_ads">Meta Ads Audience</option>
                    <option value="google_ads">Google Ads Audience</option>
                  </select>
                </label>
                {editDestinationType === "webhook" ? (
                  <>
                    <label className="nc-form-field" style={{ minWidth: 300 }}>
                      Endpoint URL
                      <input name="endpointUrl" defaultValue={parsedEditDestination?.webhookUrl || ""} required />
                    </label>
                    <label className="nc-form-field">
                      Auth Header (optional)
                      <input name="authHeaderName" defaultValue={editingDestination.authHeaderName || ""} />
                    </label>
                    <label className="nc-form-field">
                      Auth Value (optional)
                      <input name="authHeaderValue" defaultValue={editingDestination.authHeaderValue || ""} />
                    </label>
                  </>
                ) : null}
                {editDestinationType === "meta_ads" ? (
                  <>
                    <label className="nc-form-field">
                      Meta Ad Account ID
                      <input
                        name="metaAccountId"
                        defaultValue={parsedEditDestination?.metaAccountId || byProvider.get("meta_ads")?.accountId || ""}
                        required
                      />
                    </label>
                    <label className="nc-form-field">
                      Meta Audience ID (optional)
                      <input name="metaAudienceId" defaultValue={parsedEditDestination?.metaAudienceId || ""} />
                    </label>
                  </>
                ) : null}
                {editDestinationType === "google_ads" ? (
                  <>
                    <label className="nc-form-field">
                      Google Customer ID
                      <input
                        name="googleCustomerId"
                        defaultValue={parsedEditDestination?.googleCustomerId || byProvider.get("google_ads")?.accountId || ""}
                        required
                      />
                    </label>
                    <label className="nc-form-field">
                      Google User List ID (optional)
                      <input name="googleUserListId" defaultValue={parsedEditDestination?.googleUserListId || ""} />
                    </label>
                  </>
                ) : null}
                <button type="submit">Save Changes</button>
                <button type="button" onClick={() => setEditingDestinationId(null)}>
                  Cancel
                </button>
              </Form>
            </div>
          </div>
        ) : null}

        <h2 id="connector-templates">Connector API & Templates</h2>
        <p style={{ marginTop: 0 }}>
          Plug-and-play payload mappings for Meta, Google, and third-party tools.
        </p>
        <div className="nc-form-row" style={{ marginBottom: "12px" }}>
          <label className="nc-form-field">
            Find provider
            <input
              value={templateSearch}
              onChange={(event) => setTemplateSearch(event.target.value)}
              placeholder="meta, moengage, nitro, google..."
            />
          </label>
        </div>
        <div className="nc-toolbar" style={{ marginBottom: "12px" }}>
          <a href="/api/attribution/templates" target="_blank" rel="noreferrer" className="nc-chip">
            Open Attribution Payload Templates
          </a>
        </div>
        <p style={{ marginBottom: "16px" }}>Ingest endpoint: <code>/api/attribution</code> (POST)</p>

        <div className="nc-grid" style={{ marginBottom: "18px" }}>
          {(filteredTemplateCatalog || []).map((template) => (
            <div key={`tpl-${template.provider}`} className="nc-soft-box">
              <div className="nc-header-row" style={{ gridTemplateColumns: "1fr auto", marginBottom: "8px" }}>
                <h3 style={{ margin: 0 }}>{template.name}</h3>
                <span className="nc-pill">{template.mode}</span>
              </div>
              <p className="nc-note" style={{ marginBottom: "10px" }}>{template.mappingHint}</p>
              <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", fontSize: "12px" }}>{template.payloadJson}</pre>
              <h4 style={{ margin: "10px 0 6px" }}>Field Mapping</h4>
              <table className="nc-table-card">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Source Field</th>
                    <th style={{ textAlign: "left" }}>Netcash Field</th>
                    <th style={{ textAlign: "left" }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {(template.fieldMappings || []).map((mapping, idx) => (
                    <tr key={`map-${template.provider}-${idx}`}>
                      <td data-label="Source Field">{mapping.sourceField}</td>
                      <td data-label="Netcash Field"><code>{mapping.netcashField}</code></td>
                      <td data-label="Notes">{mapping.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4 style={{ margin: "10px 0 6px" }}>Generated cURL</h4>
              <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", fontSize: "12px" }}>{template.curlCommand}</pre>
              <div className="nc-toolbar" style={{ marginTop: "10px", marginBottom: 0 }}>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(template.payloadJson);
                      setCopyFeedback(`${template.name}: payload copied`);
                      setTimeout(() => setCopyFeedback(""), 1500);
                    } catch {
                      setCopyFeedback("Clipboard access blocked by browser");
                      setTimeout(() => setCopyFeedback(""), 1500);
                    }
                  }}
                >
                  Copy Payload
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(template.curlCommand);
                      setCopyFeedback(`${template.name}: cURL copied`);
                      setTimeout(() => setCopyFeedback(""), 1500);
                    } catch {
                      setCopyFeedback("Clipboard access blocked by browser");
                      setTimeout(() => setCopyFeedback(""), 1500);
                    }
                  }}
                >
                  Generate cURL
                </button>
                <Form method="post">
                  <input type="hidden" name="intent" value="test-attribution-template" />
                  <input type="hidden" name="provider" value={template.provider} />
                  <button type="submit">Test Mapping</button>
                </Form>
              </div>
            </div>
          ))}
          {(filteredTemplateCatalog || []).length === 0 ? (
            <div className="nc-soft-box">No providers match your search.</div>
          ) : null}
        </div>

        <h2>Scheduled Sync (Cron)</h2>
        <p style={{ marginTop: 0 }}>
          Run automatic connector sync from your scheduler (GitHub Actions, Render Cron, Cloudflare, etc.).
        </p>
        <p>
          Endpoint: <code>/api/connectors/cron?days=1</code>
        </p>
        <p>
          Header: <code>x-netcash-cron-key: &lt;CONNECTOR_CRON_KEY&gt;</code>
        </p>
        <pre
          style={{
            margin: "0 0 18px",
            padding: "12px",
            background: "#f7f7f7",
            borderRadius: "6px",
            overflow: "auto",
            fontSize: "12px",
          }}
        >{`curl -X POST "https://your-app-domain/api/connectors/cron?days=1" \\
  -H "x-netcash-cron-key: <CONNECTOR_CRON_KEY>"`}</pre>

        <h2>Connector Docs</h2>
        <p>Auth header (recommended): <code>x-netcash-api-key: &lt;ATTRIBUTION_API_KEY&gt;</code></p>
        <pre
          style={{
            margin: 0,
            padding: "12px",
            background: "#f7f7f7",
            borderRadius: "6px",
            overflow: "auto",
            fontSize: "12px",
          }}
        >{`POST /api/attribution
{
  "provider": "moengage",
  "records": [
    {
      "shop": "${shop}",
      "orderNumber": "#1002",
      "campaignId": "campaign_001",
      "campaignName": "Lifecycle Flow Conversion"
    }
  ]
}`}</pre>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Something went wrong while loading Connectors.");
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Connectors Unavailable</h2>
        <p className="nc-note">{message}</p>
        <a className="nc-chip" href="/app/additional">Reload Connectors</a>
      </div>
    </div>
  );
}

