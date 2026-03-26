import { Form, useActionData, useLoaderData, useRouteError, isRouteErrorResponse, Link, useFetcher } from "@remix-run/react";
import { useState } from "react";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  createActivationDestination,
  createAudienceSyncRule,
  getConnectorCredential,
  listActivationDestinations,
  listAudienceSyncRules,
  listConnectorCredentials,
  runAudienceSyncRules,
  triggerActivationDestination,
} from "../utils/db.server";
import { resolveShopConfig } from "../utils/release-control.server";
import { enqueueJob } from "../utils/job-queue.server";
import {
  listOnboardingProgressHistory,
  recordOnboardingProgressSnapshot,
} from "../utils/onboarding-progress.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";
import { listIntegrationRequests } from "../utils/integration-requests.server";

const CHANNELS = ["whatsapp", "email", "sms", "rcs"];
const DEFAULT_CHANNELS_CSV = CHANNELS.join(",");

function formatChannelLabel(channel) {
  const key = String(channel || "").toLowerCase();
  if (key === "whatsapp") return "WhatsApp";
  if (key === "sms") return "SMS";
  if (key === "email") return "Email";
  if (key === "rcs") return "RCS";
  return key.toUpperCase();
}

function toWebhookEndpoint(baseUrl, { channel, shop }) {
  const url = new URL(baseUrl);
  url.searchParams.set("channel", String(channel || "email"));
  url.searchParams.set("shop", String(shop || ""));
  return url.toString();
}

function isChannelDestination(channel, endpointUrl) {
  const value = String(endpointUrl || "").toLowerCase();
  if (!value) return false;
  if (value.includes(`/${channel}`)) return true;
  if (value.includes(`channel=${channel}`)) return true;
  return false;
}

function isChannelRule(channel, rule) {
  const audienceName = String(rule?.audienceName || "").toLowerCase();
  const name = String(rule?.name || "").toLowerCase();
  return audienceName.startsWith(`${channel}_`) || name.includes(channel);
}

function getChannelHealth({ channel, connectors, webhookAvailable, destinations, rules }) {
  const channelDestinations = (destinations || []).filter((row) => isChannelDestination(channel, row.endpointUrl));
  const channelRules = (rules || []).filter((row) => isChannelRule(channel, row));
  const routeReady = connectors.meta || connectors.google || webhookAvailable;
  const hasDestination = channelDestinations.length > 0;
  const hasRules = channelRules.length >= 2;
  const missing = [];

  if (!routeReady) missing.push("Connect Meta or Google (or configure webhook fallback).");
  if (!hasDestination) missing.push(`Create a ${formatChannelLabel(channel)} destination.`);
  if (!hasRules) missing.push(`Create ${formatChannelLabel(channel)} audience rules.`);

  let status = "red";
  if (routeReady && hasDestination && hasRules) {
    status = "green";
  } else if (routeReady && (hasDestination || channelRules.length > 0)) {
    status = "yellow";
  }

  return {
    channel,
    status,
    hasDestination,
    rulesCount: channelRules.length,
    destinationCount: channelDestinations.length,
    missing,
  };
}

function parseShopChannels(value) {
  const raw = String(value || DEFAULT_CHANNELS_CSV).trim().toLowerCase();
  if (!raw) return [...CHANNELS];
  const allowed = new Set(raw.split(",").map((row) => row.trim()).filter(Boolean));
  const channels = CHANNELS.filter((channel) => allowed.has(channel));
  return channels.length > 0 ? channels : [...CHANNELS];
}

function parseShopBoolean(value, fallback = true) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function autoSetupChannel({
  shop,
  channel,
  webhookBase,
  meta,
  google,
  destinationsCache,
  rulesCache,
}) {
  let destinationType = "webhook";
  let endpointUrl = "";
  if (meta?.accessToken && meta?.accountId) {
    destinationType = "meta_ads";
    endpointUrl = `meta://${String(meta.accountId).replace(/^act_/, "")}/${channel}`;
  } else if (google?.accessToken && google?.accountId) {
    destinationType = "google_ads";
    endpointUrl = `google://${String(google.accountId)}/${channel}`;
  } else if (webhookBase) {
    destinationType = "webhook";
    endpointUrl = toWebhookEndpoint(webhookBase, { channel, shop });
  } else {
    return {
      ok: false,
      channel,
      error: `No connector/webhook ready for ${formatChannelLabel(channel)}. Connect Meta/Google or set DEFAULT_ACTIVATION_WEBHOOK_URL.`,
    };
  }

  const destinationName = `${formatChannelLabel(channel)} Auto Flow`;
  let destination = destinationsCache.find((row) => String(row.endpointUrl || "") === endpointUrl);
  if (!destination) {
    destination = await createActivationDestination(shop, {
      name: destinationName,
      endpointUrl,
      authHeaderName: null,
      authHeaderValue: null,
      isActive: true,
    });
    destinationsCache.push(destination);
  }

  const defaultRules = [
    {
      name: `${formatChannelLabel(channel)} - High ROAS Winners`,
      audienceName: `${channel}_high_roas_winners`,
      destinationId: destination.id,
      metric: "real_roas",
      comparator: "gte",
      threshold: 1.8,
      source: null,
      isActive: true,
    },
    {
      name: `${formatChannelLabel(channel)} - Margin Safe Segment`,
      audienceName: `${channel}_margin_safe`,
      destinationId: destination.id,
      metric: "profit_margin_pct",
      comparator: "gte",
      threshold: 15,
      source: null,
      isActive: true,
    },
  ];

  let rulesCreated = 0;
  for (const rule of defaultRules) {
    const existing = rulesCache.find((row) => String(row.name || "").toLowerCase() === String(rule.name || "").toLowerCase());
    if (existing) continue;
    // eslint-disable-next-line no-await-in-loop
    const created = await createAudienceSyncRule(shop, rule);
    rulesCache.push(created);
    rulesCreated += 1;
  }

  return {
    ok: true,
    channel,
    destinationType,
    destinationId: destination.id,
    endpointUrl: destination.endpointUrl,
    rulesCreated,
  };
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const credentials = await listConnectorCredentials(session.shop);
  const destinations = await listActivationDestinations(session.shop);
  const rules = await listAudienceSyncRules(session.shop);
  const connectors = {
    meta: !!credentials.find((row) => row.provider === "meta_ads" && row.accessToken),
    google: !!credentials.find((row) => row.provider === "google_ads" && row.accessToken),
  };
  const webhookAvailable = !!String(process.env.DEFAULT_ACTIVATION_WEBHOOK_URL || "").trim();
  const shopConfig = await resolveShopConfig(session.shop, {
    connector_actions_enabled: "true",
    channel_actions_enabled_csv: DEFAULT_CHANNELS_CSV,
  }).catch(() => ({ connector_actions_enabled: "true", channel_actions_enabled_csv: DEFAULT_CHANNELS_CSV }));
  const connectorActionsEnabled = parseShopBoolean(shopConfig.connector_actions_enabled, true);
  const allowedChannels = parseShopChannels(shopConfig.channel_actions_enabled_csv);
  const channelHealth = CHANNELS.map((channel) => getChannelHealth({
    channel,
    connectors,
    webhookAvailable,
    destinations,
    rules,
  }));
  const onboardingSteps = [
    {
      key: "connectors",
      label: "Connect at least one ad platform",
      done: connectors.meta || connectors.google || webhookAvailable,
    },
    {
      key: "channels",
      label: "Setup channel automations",
      done: channelHealth.every((row) => row.status === "green"),
    },
    {
      key: "go-live",
      label: "Verify destinations and rules",
      done: destinations.length > 0 && rules.length > 0,
    },
  ];
  const doneSteps = onboardingSteps.filter((row) => row.done).length;
  const progressPct = Math.round((doneSteps / onboardingSteps.length) * 100);
  await recordOnboardingProgressSnapshot(session.shop, {
    totalSteps: onboardingSteps.length,
    doneSteps,
    progressPct,
    status: {
      connectors,
      webhookAvailable,
      onboardingSteps,
      channelHealth,
    },
  }).catch(() => {});
  const onboardingHistory = await listOnboardingProgressHistory(session.shop, 8).catch(() => []);
  const integrationRequests = await listIntegrationRequests(session.shop, 8).catch(() => []);
  const firstValueScore = Math.round(
    ((connectors.meta || connectors.google ? 35 : 0)
      + (destinations.length > 0 ? 25 : 0)
      + (rules.length > 0 ? 25 : 0)
      + (channelHealth.filter((row) => row.status === "green").length / CHANNELS.length) * 15),
  );
  const missingChannels = channelHealth.filter((row) => row.status !== "green").map((row) => row.channel);

  return {
    shop: session.shop,
    oauth: url.searchParams.get("oauth"),
    oauthError: url.searchParams.get("oauthError"),
    connectors,
    webhookAvailable,
    destinations,
    rules,
    channelHealth,
    onboardingSteps,
    onboardingHistory,
    firstValueScore,
    allowedChannels,
    connectorActionsEnabled,
    missingChannels,
    integrationRequests,
    credentials,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const runNow = ["1", "true", "yes", "on"].includes(String(formData.get("runNow") || "").toLowerCase());
  const webhookBase = String(process.env.DEFAULT_ACTIVATION_WEBHOOK_URL || "").trim();
  const returnTo = "/app/integrations?wizard=1";
  const shopConfig = await resolveShopConfig(session.shop, {
    connector_actions_enabled: "true",
    channel_actions_enabled_csv: DEFAULT_CHANNELS_CSV,
  }).catch(() => ({ connector_actions_enabled: "true", channel_actions_enabled_csv: DEFAULT_CHANNELS_CSV }));
  const connectorActionsEnabled = parseShopBoolean(shopConfig.connector_actions_enabled, true);
  const allowedChannels = parseShopChannels(shopConfig.channel_actions_enabled_csv);

  if (!connectorActionsEnabled && ["connect-meta", "connect-google", "connect-all-recommended", "auto-setup-channel", "auto-setup-all-channels", "run-integration-tests"].includes(intent)) {
    return { ok: false, error: "Integration actions are disabled for this brand by owner controls." };
  }

  if (intent === "connect-meta") {
    await recordFeatureUsageEvent(session.shop, {
      featureKey: "integration_hub",
      eventName: "connect_meta_clicked",
      path: "/app/integrations",
    }).catch(() => {});
    return redirect(`/app/connectors/meta/start?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (intent === "connect-google") {
    await recordFeatureUsageEvent(session.shop, {
      featureKey: "integration_hub",
      eventName: "connect_google_clicked",
      path: "/app/integrations",
    }).catch(() => {});
    return redirect(`/app/connectors/google/start?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (intent === "connect-all-recommended") {
    await recordFeatureUsageEvent(session.shop, {
      featureKey: "integration_hub",
      eventName: "connect_all_recommended_clicked",
      path: "/app/integrations",
    }).catch(() => {});
    const [meta, google] = await Promise.all([
      getConnectorCredential(session.shop, "meta_ads"),
      getConnectorCredential(session.shop, "google_ads"),
    ]);
    const hasMeta = !!meta?.accessToken;
    const hasGoogle = !!google?.accessToken;
    if (!hasMeta && !hasGoogle) {
      return redirect(`/app/connectors/meta/start?next=google_ads&returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (!hasMeta) {
      return redirect(`/app/connectors/meta/start?returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (!hasGoogle) {
      return redirect(`/app/connectors/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    }
    return {
      ok: true,
      warning: "Meta and Google are already connected.",
      result: { mode: "connectors_already_connected", setupResults: [], runNow: false, runResult: null },
    };
  }

  if (intent === "run-integration-tests") {
    const [meta, google, destinations] = await Promise.all([
      getConnectorCredential(session.shop, "meta_ads"),
      getConnectorCredential(session.shop, "google_ads"),
      listActivationDestinations(session.shop),
    ]);
    const report = {
      connectorJobsQueued: [],
      connectorJobErrors: [],
      audienceSync: null,
      destinationTest: null,
    };
    for (const provider of ["meta_ads", "google_ads"]) {
      const cred = provider === "meta_ads" ? meta : google;
      if (!cred?.accessToken) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const job = await enqueueJob({
          type: "connector_sync",
          shop: session.shop,
          payload: { provider, shop: session.shop, days: 30 },
          uniqueKey: `connector_sync:${session.shop}:${provider}`,
          maxAttempts: 4,
        });
        report.connectorJobsQueued.push({ provider, jobId: job.id });
      } catch (error) {
        report.connectorJobErrors.push({ provider, error: error?.message || "queue_failed" });
      }
    }
    try {
      report.audienceSync = await runAudienceSyncRules(session.shop, { days: 30, ruleId: null });
    } catch (error) {
      report.audienceSync = { ok: false, error: error?.message || "audience_sync_failed" };
    }
    const firstDestination = (destinations || []).find((row) => row.isActive);
    if (firstDestination) {
      report.destinationTest = await triggerActivationDestination(session.shop, firstDestination.id, {
        type: "integration_health_test",
        shop: session.shop,
        channel: "all",
        timestamp: new Date().toISOString(),
      });
    } else {
      report.destinationTest = { ok: false, error: "No active destination found." };
    }
    await recordFeatureUsageEvent(session.shop, {
      featureKey: "integration_hub",
      eventName: "run_integration_tests",
      path: "/app/integrations",
      payload: {
        jobsQueued: report.connectorJobsQueued.length,
        destinationOk: !!report.destinationTest?.ok,
      },
    }).catch(() => {});
    return { ok: true, result: { mode: "test_everything", setupResults: [], runNow: false, runResult: report } };
  }

  if (intent === "auto-setup-channel" || intent === "auto-setup-all-channels") {
    const requestedChannel = String(formData.get("channel") || "email").trim().toLowerCase();
    const requested = intent === "auto-setup-all-channels"
      ? CHANNELS
      : CHANNELS.includes(requestedChannel) ? [requestedChannel] : ["email"];
    const channels = requested.filter((row) => allowedChannels.includes(row));
    if (!channels.length) {
      return { ok: false, error: "No allowed channels configured for this brand." };
    }
    await recordFeatureUsageEvent(session.shop, {
      featureKey: "integration_hub",
      eventName: intent === "auto-setup-all-channels" ? "auto_setup_all_channels" : "auto_setup_channel",
      path: "/app/integrations",
      payload: { channels },
    }).catch(() => {});

    const [meta, google, destinations, rules] = await Promise.all([
      getConnectorCredential(session.shop, "meta_ads"),
      getConnectorCredential(session.shop, "google_ads"),
      listActivationDestinations(session.shop),
      listAudienceSyncRules(session.shop),
    ]);

    const setupResults = [];
    for (const channel of channels) {
      // eslint-disable-next-line no-await-in-loop
      const result = await autoSetupChannel({
        shop: session.shop,
        channel,
        webhookBase,
        meta,
        google,
        destinationsCache: destinations,
        rulesCache: rules,
      });
      setupResults.push(result);
    }

    const failed = setupResults.filter((row) => !row.ok);
    if (failed.length === setupResults.length) {
      return { ok: false, error: failed[0].error || "Unable to auto-setup channels." };
    }

    let runResult = null;
    if (runNow) {
      runResult = await runAudienceSyncRules(session.shop, { days: 30, ruleId: null });
    }

    return {
      ok: true,
      result: {
        mode: intent === "auto-setup-all-channels" ? "bulk" : "single",
        setupResults,
        runNow,
        runResult,
      },
      warning: failed.length ? `${failed.length} channel setup(s) could not complete.` : null,
    };
  }

  return { ok: false, error: "Invalid action." };
}

export default function IntegrationsHubPage() {
  const {
    shop,
    oauth,
    oauthError,
    connectors,
    webhookAvailable,
    destinations,
    rules,
    channelHealth,
    onboardingSteps,
    onboardingHistory,
    firstValueScore,
    allowedChannels,
    connectorActionsEnabled,
    integrationRequests,
    credentials,
  } = useLoaderData();
  const connectorMap = new Map((credentials || []).map((row) => [row.provider, row]));
  const parseMetadata = (value) => {
    if (!value) return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };
  const deliveryConnectors = [
    { key: "shiprocket", label: "Shiprocket", kind: "delivery" },
    { key: "delhivery", label: "Delhivery", kind: "delivery" },
    { key: "shipway", label: "Shipway", kind: "delivery" },
    { key: "bluedart", label: "Bluedart", kind: "delivery" },
    { key: "returns_prime", label: "Returns Prime", kind: "delivery" },
  ];
  const omsConnectors = [
    { key: "unicommerce", label: "Unicommerce", kind: "oms" },
    { key: "easycom", label: "Easycom", kind: "oms" },
  ];
  const [deliveryProviders, setDeliveryProviders] = useState([]);
  const [omsProviders, setOmsProviders] = useState([]);
  const [integrationNotes, setIntegrationNotes] = useState("");
  const [integrationToast, setIntegrationToast] = useState("");
  const integrationFetcher = useFetcher();
  const credentialFetcher = useFetcher();
  const actionData = useActionData();
  const setupResults = Array.isArray(actionData?.result?.setupResults) ? actionData.result.setupResults : [];
  const successCount = setupResults.filter((row) => row.ok).length;
  const failedCount = setupResults.filter((row) => !row.ok).length;
  const doneSteps = onboardingSteps.filter((row) => row.done).length;
  const progressPct = Math.round((doneSteps / onboardingSteps.length) * 100);
  const missingChannels = channelHealth.filter((row) => row.status !== "green");
  const onboardingComplete = missingChannels.length === 0 && onboardingSteps.every((row) => row.done);
  const nextAction = !connectorActionsEnabled
    ? { label: "Owner has disabled connector actions", hint: "Enable `connector_actions_enabled` in Owner Console.", cta: null }
    : !connectors.meta || !connectors.google
      ? { label: "Connect ad platforms", hint: "Link Meta and Google to unlock auto-routing.", cta: "connect-all-recommended", ctaLabel: "Connect Platforms" }
      : missingChannels.length > 0
        ? { label: "Setup missing channels", hint: `${missingChannels.length} channel(s) still need setup.`, cta: "auto-setup-all-channels", ctaLabel: "Setup Missing Channels" }
        : { label: "Run final health checks", hint: "Validate sync + destination reachability before scale.", cta: "run-integration-tests", ctaLabel: "Run Health Checks" };
  const getBadgeStyle = (status) => {
    if (status === "green") return { background: "#edfff7", color: "#0d6e4f", border: "1px solid #b9e6d5" };
    if (status === "yellow") return { background: "#fff9e8", color: "#8a5f00", border: "1px solid #f1dfb0" };
    return { background: "#fff1f0", color: "#a1281f", border: "1px solid #f2c7c3" };
  };

  return (
    <div className="nc-shell">
      <h1>Integration Hub</h1>
      <p className="nc-subtitle">One-click setup for Meta, Google, WhatsApp, Email, SMS, and RCS journeys. Minimal manual work.</p>
      {oauthError ? <p className="nc-danger">{oauthError}</p> : null}
      {oauth ? <p className="nc-note" style={{ color: "#0d6e4f", fontWeight: 700 }}>Connected: {oauth}</p> : null}
      {!connectorActionsEnabled ? (
        <p className="nc-danger">Integration actions are disabled for this brand. Contact owner to enable `connector_actions_enabled`.</p>
      ) : null}

      <div className="nc-grid-3">
        <div className="nc-kpi-card"><div className="nc-muted">Shop</div><div className="nc-kpi-value">{shop}</div></div>
        <div className="nc-kpi-card"><div className="nc-muted">Active Destinations</div><div className="nc-kpi-value">{destinations.length}</div></div>
        <div className="nc-kpi-card"><div className="nc-muted">Active Rules</div><div className="nc-kpi-value">{rules.length}</div></div>
      </div>
      <div className="nc-grid-3" style={{ marginTop: "10px" }}>
        <div className="nc-kpi-card"><div className="nc-muted">First Value Score</div><div className="nc-kpi-value">{firstValueScore}%</div></div>
        <div className="nc-kpi-card"><div className="nc-muted">Allowed Channels</div><div className="nc-kpi-value">{allowedChannels.join(", ")}</div></div>
        <div className="nc-kpi-card"><div className="nc-muted">Connector Actions</div><div className="nc-kpi-value">{connectorActionsEnabled ? "Enabled" : "Disabled"}</div></div>
      </div>

      <div id="delivery-integration-guide" className="nc-card nc-section nc-glass nc-integration-onboard" style={{ marginTop: "14px" }}>
        <div className="nc-section-head-inline">
          <div>
            <h2 style={{ marginBottom: "4px" }}>Delivery + OMS Integrations</h2>
            <p className="nc-note" style={{ margin: 0 }}>
              Plug in your logistics stack in minutes. Netcash.ai will sync delivery status, RTO, re-attempts, and OMS fulfillment updates.
            </p>
          </div>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-btn-primary"
              onClick={() => {
                setIntegrationToast("Select providers below, then click Connect Selected.");
                setTimeout(() => setIntegrationToast(""), 2200);
              }}
            >
              Request Assisted Setup
            </button>
            <button
              type="button"
              className="nc-btn-secondary"
              onClick={() => {
                setIntegrationToast("Use sample payloads or send live webhooks to test.");
                setTimeout(() => setIntegrationToast(""), 2200);
              }}
            >
              Test with Sample Data
            </button>
          </div>
        </div>

        <div className="nc-grid-3" style={{ marginTop: "12px" }}>
          <div className="nc-soft-box">
            <strong>Step 1: Choose provider</strong>
            <p className="nc-note">Select your delivery and OMS providers from the list below.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Step 2: Connect or send data</strong>
            <p className="nc-note">Use OAuth/API credentials or send webhook events to the ingest endpoints.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Step 3: Verify updates</strong>
            <p className="nc-note">Track delivery/RTO health on the Home dashboard within minutes.</p>
          </div>
        </div>

        <integrationFetcher.Form method="post" action="/api/integrations/request">
          <div className="nc-grid-2" style={{ marginTop: "12px" }}>
            <div className="nc-soft-box nc-provider-card">
            <div className="nc-provider-header">
              <strong>Delivery Providers</strong>
              <span className="nc-chip">Plug-and-Play</span>
            </div>
            <div className="nc-provider-list">
              {["Shiprocket", "Delhivery", "NimbusPost", "Ecom Express", "Shadowfax", "DTDC", "Blue Dart", "Xpressbees"].map((name) => (
                <label key={`delivery-${name}`} className="nc-provider-item">
                  <input
                    type="checkbox"
                    name="providers"
                    value={name.toLowerCase().replace(/\s+/g, "_")}
                    checked={deliveryProviders.includes(name)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...deliveryProviders, name]
                        : deliveryProviders.filter((item) => item !== name);
                      setDeliveryProviders(next);
                    }}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
            <p className="nc-note" style={{ marginTop: "8px" }}>Fields: AWB, status timeline, RTO status, re-attempt count, delivery timestamps.</p>
          </div>
          <div className="nc-soft-box nc-provider-card">
            <div className="nc-provider-header">
              <strong>OMS Providers</strong>
              <span className="nc-chip">Plug-and-Play</span>
            </div>
            <div className="nc-provider-list">
              {["Unicommerce", "Easycom", "Vinculum", "Increff", "Uniware", "ClickPost"].map((name) => (
                <label key={`oms-${name}`} className="nc-provider-item">
                  <input
                    type="checkbox"
                    name="providers"
                    value={name.toLowerCase().replace(/\s+/g, "_")}
                    checked={omsProviders.includes(name)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...omsProviders, name]
                        : omsProviders.filter((item) => item !== name);
                      setOmsProviders(next);
                    }}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
            <p className="nc-note" style={{ marginTop: "8px" }}>Fields: order status, sub-status, fulfillment status, last updated time.</p>
          </div>
          </div>
          <div className="nc-toolbar" style={{ marginTop: "10px" }}>
            <input type="hidden" name="category" value="delivery_oms" />
            <input type="hidden" name="notes" value={integrationNotes} />
            <button type="submit" className="nc-btn-primary">Connect Selected</button>
            <button
              type="button"
              className="nc-btn-secondary"
              onClick={() => {
                setDeliveryProviders([]);
                setOmsProviders([]);
                setIntegrationNotes("");
              }}
            >
              Clear Selection
            </button>
          </div>
          <div style={{ marginTop: "8px" }}>
            <label className="nc-form-field">Notes or credentials (optional)
              <textarea
                value={integrationNotes}
                onChange={(event) => setIntegrationNotes(event.target.value)}
                placeholder="Add account IDs, login email, or special instructions."
              />
            </label>
          </div>
        </integrationFetcher.Form>

        {integrationFetcher.data?.ok ? (
          <p className="nc-note" style={{ marginTop: "10px", color: "#0d6e4f", fontWeight: 700 }}>
            Request sent. We will reach out to finalize setup.
          </p>
        ) : null}
        {integrationFetcher.data?.error ? (
          <p className="nc-danger" style={{ marginTop: "10px" }}>{integrationFetcher.data.error}</p>
        ) : null}
        {integrationToast ? (
          <p className="nc-note" style={{ marginTop: "8px" }}>{integrationToast}</p>
        ) : null}

        {integrationRequests.length > 0 ? (
          <div className="nc-soft-box" style={{ marginTop: "12px" }}>
            <strong>Recent integration requests</strong>
            <table className="nc-table-card" style={{ marginTop: "8px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Provider</th>
                  <th style={{ textAlign: "left" }}>Category</th>
                  <th style={{ textAlign: "left" }}>Status</th>
                  <th style={{ textAlign: "left" }}>Requested</th>
                </tr>
              </thead>
              <tbody>
                {integrationRequests.map((row) => (
                  <tr key={`integration-request-${row.id}`}>
                    <td>{String(row.provider || "").replace(/_/g, " ")}</td>
                    <td>{row.category}</td>
                    <td>{row.status}</td>
                    <td>{row.created_at ? new Date(row.created_at).toLocaleString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="nc-soft-box" style={{ marginTop: "12px" }}>
          <strong>Ingestion endpoints</strong>
          <p className="nc-note" style={{ marginBottom: "6px" }}>
            Delivery updates: <code>/api/delivery/ingest</code> | OMS updates: <code>/api/oms/ingest</code>
          </p>
          <p className="nc-note">
            Auth header: <code>x-netcash-ingest-key</code> (required if <code>NETCASH_INGEST_KEY</code> is set).
          </p>
        </div>

        <div className="nc-card nc-section nc-glass" style={{ marginTop: "12px" }}>
          <h3 style={{ marginTop: 0 }}>Connector Setup (API key + pull sync)</h3>
          <p className="nc-note">
            Add provider credentials and trigger a pull sync. For OAuth-based providers, share the OAuth credentials and we will wire the flow.
          </p>
          {credentialFetcher.data?.ok ? (
            <p className="nc-note" style={{ color: "#0d6e4f", fontWeight: 700 }}>
              Connector saved. Sync queued.
            </p>
          ) : null}
          {credentialFetcher.data?.error ? (
            <p className="nc-danger">{credentialFetcher.data.error}</p>
          ) : null}
          <div className="nc-grid-2">
            {deliveryConnectors.map((connector) => {
              const cred = connectorMap.get(connector.key);
              const meta = parseMetadata(cred?.metadata);
              return (
                <div key={`delivery-connector-${connector.key}`} className="nc-soft-box nc-provider-card">
                  <div className="nc-provider-header">
                    <strong>{connector.label}</strong>
                    <span className="nc-chip">{cred?.accessToken ? "Connected" : "Not connected"}</span>
                  </div>
                  <credentialFetcher.Form method="post" action="/api/connectors/credentials" className="nc-form-stack">
                    <input type="hidden" name="provider" value={connector.key} />
                    <input type="hidden" name="kind" value={connector.kind} />
                    <label className="nc-form-field">API base URL
                      <input name="baseUrl" defaultValue={meta.baseUrl || ""} placeholder="https://api.provider.com" />
                    </label>
                    <label className="nc-form-field">Endpoint path (optional)
                      <input name="endpoint" defaultValue={meta.endpoint || ""} placeholder="/shipments/status" />
                    </label>
                    <label className="nc-form-field">API key / token
                      <input name="apiKey" defaultValue={meta.apiKey || ""} placeholder="Paste token" />
                    </label>
                    <div className="nc-grid-2">
                      <label className="nc-form-field">Auth header
                        <input name="authHeaderName" defaultValue={meta.authHeaderName || "Authorization"} />
                      </label>
                      <label className="nc-form-field">Auth prefix
                        <input name="authPrefix" defaultValue={meta.authPrefix || "Bearer"} />
                      </label>
                    </div>
                    <label className="nc-form-field">
                      <input type="checkbox" name="runNow" value="true" defaultChecked />
                      Run sync after save
                    </label>
                    <button type="submit" className="nc-btn-primary">Save & Sync</button>
                  </credentialFetcher.Form>
                </div>
              );
            })}
          </div>
          <div className="nc-grid-2" style={{ marginTop: "12px" }}>
            {omsConnectors.map((connector) => {
              const cred = connectorMap.get(connector.key);
              const meta = parseMetadata(cred?.metadata);
              return (
                <div key={`oms-connector-${connector.key}`} className="nc-soft-box nc-provider-card">
                  <div className="nc-provider-header">
                    <strong>{connector.label}</strong>
                    <span className="nc-chip">{cred?.accessToken ? "Connected" : "Not connected"}</span>
                  </div>
                  <credentialFetcher.Form method="post" action="/api/connectors/credentials" className="nc-form-stack">
                    <input type="hidden" name="provider" value={connector.key} />
                    <input type="hidden" name="kind" value={connector.kind} />
                    <label className="nc-form-field">API base URL
                      <input name="baseUrl" defaultValue={meta.baseUrl || ""} placeholder="https://api.provider.com" />
                    </label>
                    <label className="nc-form-field">Endpoint path (optional)
                      <input name="endpoint" defaultValue={meta.endpoint || ""} placeholder="/orders/status" />
                    </label>
                    <label className="nc-form-field">API key / token
                      <input name="apiKey" defaultValue={meta.apiKey || ""} placeholder="Paste token" />
                    </label>
                    <div className="nc-grid-2">
                      <label className="nc-form-field">Auth header
                        <input name="authHeaderName" defaultValue={meta.authHeaderName || "Authorization"} />
                      </label>
                      <label className="nc-form-field">Auth prefix
                        <input name="authPrefix" defaultValue={meta.authPrefix || "Bearer"} />
                      </label>
                    </div>
                    <label className="nc-form-field">
                      <input type="checkbox" name="runNow" value="true" defaultChecked />
                      Run sync after save
                    </label>
                    <button type="submit" className="nc-btn-primary">Save & Sync</button>
                  </credentialFetcher.Form>
                </div>
              );
            })}
          </div>
        </div>

        <details style={{ marginTop: "12px" }}>
          <summary><strong>Show sample payloads</strong></summary>
          <pre className="nc-code-block" style={{ marginTop: "8px" }}>
{`POST /api/delivery/ingest
{
  "shop": "${shop}",
  "provider": "shiprocket",
  "orderId": "1234567890",
  "orderNumber": "#1001",
  "awb": "SR123456",
  "status": "in_transit",
  "statusDetail": "Arrived at hub",
  "attemptCount": 1,
  "events": [
    { "event": "Picked", "eventAt": "2026-03-10T07:10:00Z", "location": "Delhi" },
    { "event": "In Transit", "eventAt": "2026-03-11T09:45:00Z", "location": "Jaipur" }
  ]
}

POST /api/oms/ingest
{
  "shop": "${shop}",
  "provider": "unicommerce",
  "orderId": "1234567890",
  "orderNumber": "#1001",
  "status": "packed",
  "subStatus": "ready_to_ship",
  "fulfillmentStatus": "partially_fulfilled",
  "lastEventAt": "2026-03-11T08:10:00Z"
}`}
          </pre>
        </details>
      </div>

      <div className="nc-card nc-section nc-glass nc-next-action" style={{ marginTop: "12px" }}>
        <h2 style={{ marginBottom: "8px" }}>Next Best Action</h2>
        <p className="nc-note" style={{ marginBottom: "8px" }}>
          <strong>{nextAction.label}</strong>. {nextAction.hint}
        </p>
        {nextAction.cta ? (
          <Form method="post" className="nc-toolbar" style={{ marginBottom: 0 }}>
            <input type="hidden" name="intent" value={nextAction.cta} />
            {nextAction.cta === "auto-setup-all-channels" ? <input type="hidden" name="runNow" value="true" /> : null}
            <button type="submit" className="nc-btn-primary">{nextAction.ctaLabel}</button>
          </Form>
        ) : null}
      </div>

      <div className="nc-card nc-section nc-glass" style={{ marginTop: "14px" }}>
        <h2>Post-Install Onboarding Wizard</h2>
        <p className="nc-note">Progress: {progressPct}% complete. Only missing tasks are shown below.</p>
        <div style={{ height: "8px", borderRadius: "999px", background: "#e7eef9", overflow: "hidden", marginBottom: "10px" }}>
          <span style={{ display: "block", height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg, #1f4ed8 0%, #0b7a6b 100%)" }} />
        </div>
        <div className="nc-grid-3">
          {onboardingSteps.map((step) => (
            <div key={`wizard-step-${step.key}`} className="nc-soft-box">
              <strong>{step.label}</strong>
              <p className="nc-note" style={{ marginBottom: 0 }}>
                {step.done ? "Completed" : "Pending"}
              </p>
            </div>
          ))}
        </div>
        {!missingChannels.length && onboardingSteps.every((row) => row.done) ? (
          <p className="nc-note" style={{ marginTop: "10px", fontWeight: 700, color: "#0d6e4f" }}>
            Onboarding complete. All channels are healthy.
          </p>
        ) : (
          <div style={{ marginTop: "10px" }}>
            <p className="nc-note" style={{ fontWeight: 700, marginBottom: "8px" }}>Suggested next actions</p>
            <div className="nc-toolbar" style={{ marginBottom: "8px" }}>
              {(!connectors.meta || !connectors.google) ? (
                <Form method="post" style={{ marginBottom: 0 }}>
                  <input type="hidden" name="intent" value="connect-all-recommended" />
                  <button type="submit" className="nc-btn-primary">Connect All Recommended</button>
                </Form>
              ) : null}
              {!connectors.meta ? (
                <Form method="post" style={{ marginBottom: 0 }}>
                  <input type="hidden" name="intent" value="connect-meta" />
                  <button type="submit" className="nc-btn-secondary">Connect Meta</button>
                </Form>
              ) : null}
              {!connectors.google ? (
                <Form method="post" style={{ marginBottom: 0 }}>
                  <input type="hidden" name="intent" value="connect-google" />
                  <button type="submit" className="nc-btn-secondary">Connect Google</button>
                </Form>
              ) : null}
              {missingChannels.length > 0 ? (
                <Form method="post" style={{ marginBottom: 0 }}>
                  <input type="hidden" name="intent" value="auto-setup-all-channels" />
                  <input type="hidden" name="runNow" value="true" />
                  <button type="submit" className="nc-btn-primary">Fix Missing Channels</button>
                </Form>
              ) : null}
            </div>
            {missingChannels.length > 0 ? (
              <div className="nc-grid-2">
                {missingChannels.map((row) => (
                  <div key={`missing-${row.channel}`} className="nc-soft-box">
                    <strong>{formatChannelLabel(row.channel)}</strong>
                    <p className="nc-note">
                      Missing: {row.missing.join(" ")}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {onboardingComplete ? (
          <div className="nc-soft-box" style={{ marginTop: "10px", borderColor: "#b9e6d5", background: "#f0fff9" }}>
            <strong>You are live</strong>
            <p className="nc-note" style={{ marginBottom: "6px" }}>
              Connected tools: {(connectors.meta ? 1 : 0) + (connectors.google ? 1 : 0)} | Healthy channels: {channelHealth.filter((row) => row.status === "green").length}/{CHANNELS.length} | Active rules: {rules.length}
            </p>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <Link to="/app/campaigns" className="nc-chip">Review Campaign Actions</Link>
              <Link to="/app/alerts" className="nc-chip">Review Alerts</Link>
            </div>
          </div>
        ) : null}
        {(onboardingHistory || []).length > 0 ? (
          <>
            <hr style={{ margin: "14px 0" }} />
            <h3 style={{ marginTop: 0 }}>Recent Wizard Progress</h3>
            <table className="nc-table-card">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Recorded</th>
                  <th style={{ textAlign: "right" }}>Done Steps</th>
                  <th style={{ textAlign: "right" }}>Progress</th>
                </tr>
              </thead>
              <tbody>
                {(onboardingHistory || []).map((row) => (
                  <tr key={`wiz-history-${row.id}`}>
                    <td>{row.createdAt ? new Date(row.createdAt).toLocaleString() : "-"}</td>
                    <td style={{ textAlign: "right" }}>{row.doneSteps} / {row.totalSteps}</td>
                    <td style={{ textAlign: "right" }}>{row.progressPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>

      <details className="nc-card nc-section nc-glass" style={{ marginTop: "14px" }}>
        <summary><strong>Advanced Options</strong> <span className="nc-note">Connectors, channel setup, go-live checks, and expert controls</span></summary>
        <div style={{ marginTop: "12px" }}>
          <h3>Connect Platforms</h3>
          <p className="nc-note">
            Status: Meta {connectors.meta ? "connected" : "pending"} | Google {connectors.google ? "connected" : "pending"} | Webhook fallback {webhookAvailable ? "available" : "not set"}
          </p>
          <p className="nc-note">
            Consent notice: Meta uses `ads_read,business_management`; Google uses `adwords`. Access is used only for attribution and sync.
          </p>
          <div className="nc-grid-2">
            <div className="nc-soft-box">
              <strong>Meta Ads</strong>
              <p className="nc-note">Status: {connectors.meta ? "Connected" : "Not connected"}</p>
              <Form method="post">
                <input type="hidden" name="intent" value="connect-meta" />
                <button type="submit" className="nc-btn-primary">{connectors.meta ? "Reconnect Meta" : "Connect Meta"}</button>
              </Form>
            </div>
            <div className="nc-soft-box">
              <strong>Google Ads</strong>
              <p className="nc-note">Status: {connectors.google ? "Connected" : "Not connected"}</p>
              <Form method="post">
                <input type="hidden" name="intent" value="connect-google" />
                <button type="submit" className="nc-btn-primary">{connectors.google ? "Reconnect Google" : "Connect Google"}</button>
              </Form>
            </div>
          </div>
          <h3 style={{ marginTop: "14px" }}>Setup Channels</h3>
          <div className="nc-toolbar" style={{ marginBottom: "10px" }}>
            <Form method="post" style={{ marginBottom: 0 }}>
              <input type="hidden" name="intent" value="auto-setup-all-channels" />
              <input type="hidden" name="runNow" value="true" />
              <button type="submit" className="nc-btn-primary">Setup All Channels</button>
            </Form>
          </div>
          <div className="nc-grid-4">
            {CHANNELS.map((channel) => {
              const health = channelHealth.find((row) => row.channel === channel) || { status: "red", rulesCount: 0, destinationCount: 0 };
              const channelAllowed = allowedChannels.includes(channel);
              return (
              <div className="nc-soft-box" key={`channel-${channel}`}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <strong>{formatChannelLabel(channel)}</strong>
                  <span style={{ borderRadius: "999px", padding: "2px 8px", fontSize: "11px", fontWeight: 800, ...getBadgeStyle(health.status) }}>
                    {health.status === "green" ? "Healthy" : health.status === "yellow" ? "Partial" : "Needs setup"}
                  </span>
                </div>
                <p className="nc-note" style={{ marginBottom: "8px" }}>
                  Destinations: {health.destinationCount} | Rules: {health.rulesCount} | {channelAllowed ? "Enabled" : "Blocked"}
                </p>
                <Form method="post" style={{ marginTop: "8px" }}>
                  <input type="hidden" name="intent" value="auto-setup-channel" />
                  <input type="hidden" name="channel" value={channel} />
                  <input type="hidden" name="runNow" value="true" />
                  <button type="submit" className="nc-btn-secondary" disabled={!channelAllowed || !connectorActionsEnabled}>Setup {formatChannelLabel(channel)}</button>
                </Form>
              </div>
            );
            })}
          </div>
          <h3 style={{ marginTop: "14px" }}>Go Live Checks</h3>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Form method="post" style={{ marginBottom: 0 }}>
              <input type="hidden" name="intent" value="run-integration-tests" />
              <button type="submit" className="nc-btn-primary">Run Health Checks</button>
            </Form>
            <Link to="/app/additional#audience-sync" className="nc-chip">Review Rules</Link>
            <Link to="/app/additional#activation-destinations" className="nc-chip">Review Destinations</Link>
            <Link to="/app/additional" className="nc-chip">Review Advanced Integrations</Link>
          </div>
        </div>
      </details>

      {actionData?.error ? <p className="nc-danger">{actionData.error}</p> : null}
      {actionData?.warning ? <p className="nc-note" style={{ color: "#9a5d00", fontWeight: 700 }}>{actionData.warning}</p> : null}
      {actionData?.ok ? (
        <div className="nc-card nc-section" style={{ marginTop: "14px" }}>
          <h2>Run Summary</h2>
          <div className="nc-grid-3">
            <div className="nc-soft-box"><strong>Succeeded</strong><p className="nc-kpi-value">{successCount}</p></div>
            <div className="nc-soft-box"><strong>Failed</strong><p className="nc-kpi-value">{failedCount}</p></div>
            <div className="nc-soft-box"><strong>Mode</strong><p className="nc-kpi-value">{actionData.result?.mode === "bulk" ? "All Channels" : "Single Channel"}</p></div>
          </div>
          <div className="nc-grid-2" style={{ marginTop: "10px" }}>
            {setupResults.map((row) => (
              <div key={`setup-result-${row.channel}`} className="nc-soft-box">
                <strong>{formatChannelLabel(row.channel)}</strong>
                <p className="nc-note" style={{ marginBottom: "6px" }}>
                  {row.ok ? `Ready via ${row.destinationType}` : row.error}
                </p>
                {row.ok ? (
                  <div className="nc-note">
                    Rules added: {row.rulesCreated} | Destination #{row.destinationId}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <details style={{ marginTop: "10px" }}>
            <summary><strong>Show technical details</strong></summary>
            <pre className="nc-code-block" style={{ marginTop: "8px" }}>{JSON.stringify(actionData.result || {}, null, 2)}</pre>
          </details>
        </div>
      ) : null}

      <div className="nc-toolbar" style={{ marginTop: "14px" }}>
        <Link to="/app/additional" className="nc-chip">Review Advanced Integrations</Link>
        <Link to="/app/settings" className="nc-chip">Review Settings</Link>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : String(error?.message || "Integration Hub unavailable.");
  return (
    <div className="nc-shell">
      <h1>Integration Hub unavailable</h1>
      <p className="nc-subtitle">{message}</p>
    </div>
  );
}
