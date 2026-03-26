import {
  addSourceAdSpend,
  createConnectorSyncRun,
  getConnectorCredential,
  upsertCreativeMetricBatch,
  upsertToolAttribution,
} from "./db.server";
import { normalizeProvider } from "./connectors";
import { refreshGoogleAccessToken } from "./connector-oauth.server";
import { logError, logInfo, logWarn } from "./logger.server";
import { ensureDeliveryOmsTables, upsertDeliveryShipment, upsertOmsStatus } from "./delivery-oms.server";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function getMetaAccessToken(shop) {
  const credential = await getConnectorCredential(shop, "meta_ads");
  if (credential?.accessToken) return credential.accessToken;
  return requiredEnv("META_ACCESS_TOKEN");
}

async function getGoogleAccessToken(shop) {
  const credential = await getConnectorCredential(shop, "google_ads");
  if (!credential) return requiredEnv("GOOGLE_ADS_ACCESS_TOKEN");
  const expTime = credential.expiresAt ? new Date(credential.expiresAt).getTime() : 0;
  const needsRefresh = !!credential.refreshToken && (!expTime || expTime <= Date.now() + 60_000);
  if (needsRefresh) {
    const refreshed = await refreshGoogleAccessToken(shop);
    if (refreshed?.accessToken) return refreshed.accessToken;
  }
  if (credential.accessToken) return credential.accessToken;
  return requiredEnv("GOOGLE_ADS_ACCESS_TOKEN");
}

function toIsoDate(daysBack = 7) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Number(daysBack));
  return {
    since: start.toISOString().slice(0, 10),
    until: end.toISOString().slice(0, 10),
  };
}

function jsonHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchMetaInsights(url, maxPages = 20) {
  const rows = [];
  let next = url;
  let page = 0;
  while (next && page < maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(next);
    // eslint-disable-next-line no-await-in-loop
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Meta Ads sync failed: ${data?.error?.message || response.statusText}`);
    }
    if (Array.isArray(data?.data)) rows.push(...data.data);
    next = data?.paging?.next || null;
    page += 1;
  }
  return rows;
}

async function syncMetaAdsSpend({ days, shop }) {
  const token = await getMetaAccessToken(shop);
  const credential = await getConnectorCredential(shop, "meta_ads");
  const adAccountId = credential?.accountId || requiredEnv("META_AD_ACCOUNT_ID");
  const { since, until } = toIsoDate(days);

  const params = new URLSearchParams({
    level: "campaign",
    fields: "campaign_id,campaign_name,spend,date_start",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    access_token: token,
  });

  const url = `https://graph.facebook.com/v20.0/act_${adAccountId}/insights?${params.toString()}`;
  const rows = await fetchMetaInsights(url);
  const spendRows = rows.map((row) => ({
    source: "meta",
    spendDate: row.date_start,
    adSpend: Number(row.spend || 0),
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
  }));

  const creativeParams = new URLSearchParams({
    level: "ad",
    fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,frequency,actions,date_start",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    access_token: token,
  });
  const creativeUrl = `https://graph.facebook.com/v20.0/act_${adAccountId}/insights?${creativeParams.toString()}`;
  const creativeRowsRaw = await fetchMetaInsights(creativeUrl);
  const creativeRows = creativeRowsRaw.map((row) => {
    const actions = Array.isArray(row.actions) ? row.actions : [];
    const conversions = actions.reduce((sum, action) => {
      const type = String(action?.action_type || "").toLowerCase();
      if (["purchase", "omni_purchase", "offsite_conversion.purchase", "offsite_conversion.fb_pixel_purchase"].includes(type)) {
        return sum + Number(action?.value || 0);
      }
      return sum;
    }, 0);
    return {
      source: "meta",
      reportDate: row.date_start,
      adId: row.ad_id,
      adName: row.ad_name,
      adSetId: row.adset_id,
      adSetName: row.adset_name,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      spend: Number(row.spend || 0),
      ctr: Number(row.ctr || 0),
      frequency: row.frequency == null ? null : Number(row.frequency || 0),
      conversions,
    };
  });

  return {
    provider: "meta_ads",
    spendRows,
    attributionRows: [],
    creativeRows,
  };
}

async function syncGoogleAdsSpend({ days, shop }) {
  const accessToken = await getGoogleAccessToken(shop);
  const credential = await getConnectorCredential(shop, "google_ads");
  const customerId = credential?.accountId || requiredEnv("GOOGLE_ADS_CUSTOMER_ID");
  const developerToken = requiredEnv("GOOGLE_ADS_DEVELOPER_TOKEN");
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "";
  const { since, until } = toIsoDate(days);

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      segments.date,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `.replace(/\s+/g, " ").trim();

  const headers = jsonHeaders({
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
  });
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const url = `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:searchStream`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google Ads sync failed: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const chunks = Array.isArray(data) ? data : [];
  const spendRows = [];
  for (const chunk of chunks) {
    for (const row of chunk?.results || []) {
      const micros = Number(row?.metrics?.costMicros || 0);
      const spend = micros > 0 ? micros / 1_000_000 : 0;
      spendRows.push({
        source: "google",
        spendDate: row?.segments?.date,
        adSpend: spend,
        campaignId: row?.campaign?.id ? String(row.campaign.id) : null,
        campaignName: row?.campaign?.name || null,
      });
    }
  }

  const creativeQuery = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.conversions
    FROM ad_group_ad
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `.replace(/\s+/g, " ").trim();

  const creativeResponse = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: creativeQuery }),
  });
  const creativeData = await creativeResponse.json();
  if (!creativeResponse.ok) {
    throw new Error(`Google Ads creative sync failed: ${JSON.stringify(creativeData).slice(0, 200)}`);
  }
  const creativeChunks = Array.isArray(creativeData) ? creativeData : [];
  const creativeRows = [];
  for (const chunk of creativeChunks) {
    for (const row of chunk?.results || []) {
      const micros = Number(row?.metrics?.costMicros || 0);
      creativeRows.push({
        source: "google",
        reportDate: row?.segments?.date,
        adId: row?.adGroupAd?.ad?.id ? String(row.adGroupAd.ad.id) : null,
        adName: row?.adGroupAd?.ad?.name || null,
        adSetId: row?.adGroup?.id ? String(row.adGroup.id) : null,
        adSetName: row?.adGroup?.name || null,
        campaignId: row?.campaign?.id ? String(row.campaign.id) : null,
        campaignName: row?.campaign?.name || null,
        impressions: Number(row?.metrics?.impressions || 0),
        clicks: Number(row?.metrics?.clicks || 0),
        spend: micros > 0 ? micros / 1_000_000 : 0,
        ctr: Number(row?.metrics?.ctr || 0),
        frequency: null,
        conversions: Number(row?.metrics?.conversions || 0),
      });
    }
  }

  return {
    provider: "google_ads",
    spendRows,
    attributionRows: [],
    creativeRows,
  };
}

function normalizeGenericConfig(metadata = {}, providerKey) {
  const upper = String(providerKey || "").toUpperCase();
  const baseUrl = metadata.baseUrl || process.env[`${upper}_API_BASE`] || "";
  const endpoint = metadata.endpoint || process.env[`${upper}_API_ENDPOINT`] || "";
  const apiKey = metadata.apiKey || process.env[`${upper}_API_KEY`] || "";
  const authHeaderName = metadata.authHeaderName || "Authorization";
  const authPrefix = metadata.authPrefix || "Bearer";
  const kind = metadata.kind || metadata.category || "delivery";
  return {
    baseUrl: String(baseUrl || "").trim(),
    endpoint: String(endpoint || "").trim(),
    apiKey: String(apiKey || "").trim(),
    authHeaderName: String(authHeaderName || "").trim() || "Authorization",
    authPrefix: String(authPrefix || "").trim(),
    kind: String(kind || "").trim().toLowerCase(),
  };
}

function buildGenericUrl(baseUrl, endpoint) {
  if (!endpoint) return baseUrl;
  if (endpoint.startsWith("http")) return endpoint;
  if (!baseUrl) return endpoint;
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

async function syncDeliveryOmsGeneric({ provider, shop }) {
  const credential = await getConnectorCredential(shop, provider);
  let metadata = {};
  if (credential?.metadata) {
    try {
      metadata = JSON.parse(credential.metadata);
    } catch {
      metadata = {};
    }
  }
  const config = normalizeGenericConfig(metadata, provider);
  if (!config.baseUrl && !config.endpoint) {
    throw new Error(`Missing API base/endpoint for ${provider}.`);
  }
  if (!config.apiKey) {
    throw new Error(`Missing API key for ${provider}.`);
  }
  const url = buildGenericUrl(config.baseUrl, config.endpoint);
  const headers = {
    "Content-Type": "application/json",
  };
  if (config.authHeaderName) {
    headers[config.authHeaderName] = config.authPrefix
      ? `${config.authPrefix} ${config.apiKey}`
      : config.apiKey;
  }
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Connector ${provider} sync failed: ${response.status} ${response.statusText}`);
  }

  const payloads = Array.isArray(data)
    ? data
    : Array.isArray(data?.shipments)
      ? data.shipments
      : Array.isArray(data?.orders)
        ? data.orders
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.results)
            ? data.results
            : [];

  await ensureDeliveryOmsTables();
  let written = 0;
  for (const row of payloads) {
    const merged = { ...row, shop, provider };
    if (config.kind === "oms") {
      // eslint-disable-next-line no-await-in-loop
      await upsertOmsStatus(merged);
      written += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await upsertDeliveryShipment(merged);
      written += 1;
    }
  }

  return {
    provider,
    kind: config.kind,
    deliveryRows: config.kind === "oms" ? [] : payloads,
    omsRows: config.kind === "oms" ? payloads : [],
    rowsWritten: written,
  };
}

const CONNECTOR_REGISTRY = {
  meta_ads: {
    name: "Meta Ads",
    mode: "pull",
    sync: syncMetaAdsSpend,
    requiredEnv: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
    kind: "ads",
  },
  google_ads: {
    name: "Google Ads",
    mode: "pull",
    sync: syncGoogleAdsSpend,
    requiredEnv: ["GOOGLE_ADS_ACCESS_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_DEVELOPER_TOKEN"],
    kind: "ads",
  },
  shiprocket: { name: "Shiprocket", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "delivery" },
  delhivery: { name: "Delhivery", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "delivery" },
  shipway: { name: "Shipway", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "delivery" },
  bluedart: { name: "Bluedart", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "delivery" },
  unicommerce: { name: "Unicommerce", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "oms" },
  easycom: { name: "Easycom", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "oms" },
  returns_prime: { name: "Returns Prime", mode: "pull", sync: syncDeliveryOmsGeneric, kind: "delivery" },
  clevertap: { name: "Clevertap", mode: "push" },
  moengage: { name: "MoEngage", mode: "push" },
  webengage: { name: "WebEngage", mode: "push" },
  kwikengage: { name: "KwikEngage", mode: "push" },
  bitespeed: { name: "Bitespeed", mode: "push" },
  bik_ai: { name: "Bik.ai", mode: "push" },
  nitro: { name: "Nitro", mode: "push" },
  wati: { name: "Wati", mode: "push" },
  spur: { name: "Spur", mode: "push" },
};

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(fn, { attempts = 3, baseDelayMs = 500, context = {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts;
      logWarn("connector.sync.retry", {
        attempt,
        attempts,
        isLast,
        error: error?.message || "Unknown error",
        ...context,
      });
      if (!isLast) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  throw lastError;
}

export function listConnectors() {
  return Object.entries(CONNECTOR_REGISTRY).map(([key, value]) => ({
    key,
    ...value,
  }));
}

export async function runConnectorSync({ provider, shop, days = 7 }) {
  const startedAt = Date.now();
  const normalized = normalizeProvider(provider);
  const connector = CONNECTOR_REGISTRY[normalized];
  if (!connector) throw new Error(`Unsupported provider: ${normalized}`);
  if (connector.mode !== "pull") {
    throw new Error(
      `${connector.name} is configured as push connector. Send records to /api/attribution from your ${connector.name} workflow.`,
    );
  }
  try {
    const result = await runWithRetry(() => connector.sync({ days, shop }), {
      attempts: 3,
      baseDelayMs: 700,
      context: { provider: normalized, shop },
    });

    let spendWrites = 0;
    let attributionWrites = 0;
    let creativeWrites = 0;
    if (connector.kind === "ads") {
      for (const row of result.spendRows || []) {
        const spend = Number(row.adSpend || 0);
        if (spend <= 0) continue;
        await addSourceAdSpend(row.source, spend, row.spendDate ? new Date(row.spendDate) : new Date());
        spendWrites += 1;
      }

      for (const row of result.attributionRows || []) {
        await upsertToolAttribution({
          shop,
          tool: normalized,
          orderId: row.orderId,
          orderNumber: row.orderNumber,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          adSetId: row.adSetId,
          adId: row.adId,
        });
        attributionWrites += 1;
      }

      if (Array.isArray(result.creativeRows) && result.creativeRows.length > 0) {
        creativeWrites = await upsertCreativeMetricBatch(shop, result.creativeRows);
      }
    } else {
      spendWrites = result.rowsWritten || 0;
    }

    const output = {
      provider: normalized,
      mode: connector.mode,
      spendRowsFetched: connector.kind === "ads" ? (result.spendRows || []).length : 0,
      spendRowsWritten: spendWrites,
      attributionRowsFetched: connector.kind === "ads" ? (result.attributionRows || []).length : 0,
      attributionRowsWritten: attributionWrites,
      requiredEnv: connector.requiredEnv || [],
    };
    await createConnectorSyncRun({
      shop,
      provider: normalized,
      status: "success",
      lookbackDays: days,
      ...output,
      durationMs: Date.now() - startedAt,
    });
    logInfo("connector.sync.completed", {
      provider: normalized,
      shop,
      days,
      spendRowsWritten: spendWrites,
      attributionRowsWritten: attributionWrites,
      creativeRowsWritten: creativeWrites,
    });
    return output;
  } catch (error) {
    await createConnectorSyncRun({
      shop,
      provider: normalized,
      status: "failed",
      lookbackDays: days,
      errorMessage: error?.message || "Unknown error",
      durationMs: Date.now() - startedAt,
    });
    logError("connector.sync.failed", {
      provider: normalized,
      shop,
      days,
      error: error?.message || "Unknown error",
    });
    throw error;
  }
}
