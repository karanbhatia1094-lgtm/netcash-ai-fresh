const PROVIDER_ALIASES = {
  meta: "meta_ads",
  "meta ads": "meta_ads",
  facebook: "meta_ads",
  "facebook ads": "meta_ads",
  google: "google_ads",
  "google ads": "google_ads",
  clevertap: "clevertap",
  moengage: "moengage",
  webengage: "webengage",
  kwikengage: "kwikengage",
  bitespeed: "bitespeed",
  "bik.ai": "bik_ai",
  bik: "bik_ai",
  nitro: "nitro",
  "nitro sms": "nitro",
  "nitro engage": "nitro",
  wati: "wati",
  spur: "spur",
  manual: "manual",
};

export const SUPPORTED_PROVIDERS = [
  "meta_ads",
  "google_ads",
  "clevertap",
  "moengage",
  "webengage",
  "kwikengage",
  "bitespeed",
  "bik_ai",
  "nitro",
  "wati",
  "spur",
  "manual",
];

export function normalizeProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "manual";
  return PROVIDER_ALIASES[raw] || raw.replace(/\s+/g, "_");
}

function pickFirst(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null && String(record[key]).trim() !== "") {
      return String(record[key]).trim();
    }
  }
  return null;
}

function normalizeRecord(provider, defaultShop, record) {
  const shop = pickFirst(record, ["shop", "store", "shopDomain"]) || defaultShop || null;
  const orderId = pickFirst(record, ["orderId", "order_id", "shopifyOrderId"]);
  const orderNumber = pickFirst(record, ["orderNumber", "order_number", "name", "shopifyOrderName"]);

  const campaignId = pickFirst(record, [
    "campaignId",
    "campaign_id",
    "utm_id",
    "cid",
  ]);
  const campaignName = pickFirst(record, [
    "campaignName",
    "campaign_name",
    "utm_campaign",
    "campaign",
  ]);

  const adSetId = pickFirst(record, ["adSetId", "ad_set_id", "adgroupId", "ad_group_id"]);
  const adId = pickFirst(record, ["adId", "ad_id", "creativeId", "creative_id"]);

  return {
    provider,
    shop,
    orderId,
    orderNumber,
    campaignId,
    campaignName,
    adSetId,
    adId,
  };
}

export function extractAttributionRecords(payload) {
  const provider = normalizeProvider(payload?.provider || payload?.tool);
  const defaultShop = payload?.shop ? String(payload.shop).trim() : null;

  const sourceRecords = Array.isArray(payload?.records)
    ? payload.records
    : Array.isArray(payload?.data)
      ? payload.data
      : [payload];

  return sourceRecords
    .map((record) => normalizeRecord(provider, defaultShop, record))
    .filter((record) => record.shop && (record.orderId || record.orderNumber));
}
