import { addSourceAdSpend, createConnectorSyncRun, getConnectorCredential, upsertToolAttribution } from "./db.server";
import { normalizeProvider } from "./connectors";
import { refreshGoogleAccessToken } from "./connector-oauth.server";
import { logError, logInfo, logWarn } from "./logger.server";

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
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta Ads sync failed: ${data?.error?.message || response.statusText}`);
  }

  const rows = Array.isArray(data?.data) ? data.data : [];
  const spendRows = rows.map((row) => ({
    source: "meta",
    spendDate: row.date_start,
    adSpend: Number(row.spend || 0),
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
  }));

  return {
    provider: "meta_ads",
    spendRows,
    attributionRows: [],
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

  return {
    provider: "google_ads",
    spendRows,
    attributionRows: [],
  };
}

const CONNECTOR_REGISTRY = {
  meta_ads: {
    name: "Meta Ads",
    mode: "pull",
    sync: syncMetaAdsSpend,
    requiredEnv: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
  },
  google_ads: {
    name: "Google Ads",
    mode: "pull",
    sync: syncGoogleAdsSpend,
    requiredEnv: ["GOOGLE_ADS_ACCESS_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_DEVELOPER_TOKEN"],
  },
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
    for (const row of result.spendRows || []) {
      const spend = Number(row.adSpend || 0);
      if (spend <= 0) continue;
      await addSourceAdSpend(row.source, spend, row.spendDate ? new Date(row.spendDate) : new Date());
      spendWrites += 1;
    }

    let attributionWrites = 0;
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

    const output = {
      provider: normalized,
      mode: connector.mode,
      spendRowsFetched: (result.spendRows || []).length,
      spendRowsWritten: spendWrites,
      attributionRowsFetched: (result.attributionRows || []).length,
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
