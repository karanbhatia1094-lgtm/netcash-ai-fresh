import { getReleaseContext } from "./release-control.server.js";

export const PLAN_TIERS = {
  basic: "basic",
  pro: "pro",
  premium: "premium",
};

function parseShopList(value) {
  return String(value || "")
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePlanName(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolvePremiumOverrideForShop(shop) {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) return null;
  const premiumShops = parseShopList(process.env.PREMIUM_SHOPS || "");
  if (!premiumShops.includes(safeShop)) return null;
  return {
    subscriptions: [{ name: "Premium Monthly (Premium Shops Override)" }],
    hasActivePayment: true,
  };
}

export function detectTierFromSubscriptions(subscriptions = []) {
  let tier = PLAN_TIERS.basic;
  for (const sub of subscriptions || []) {
    const name = normalizePlanName(sub?.name);
    if (name.includes("premium")) return PLAN_TIERS.premium;
    if (name.includes("pro")) tier = PLAN_TIERS.pro;
    if (name.includes("basic") && tier === PLAN_TIERS.basic) tier = PLAN_TIERS.basic;
  }
  return tier;
}

export function featureFlagsForTier(tier) {
  return {
    tier,
    hasPro: tier === PLAN_TIERS.pro || tier === PLAN_TIERS.premium,
    hasPremium: tier === PLAN_TIERS.premium,
  };
}

export async function resolvePlanContext(billing, isTestMode = false, plans = [], shop = "") {
  // Optional local override for demo mode only.
  if (process.env.BILLING_DEV_OVERRIDE === "true") {
    return {
      subscriptions: [{ name: "Premium Monthly (Dev Override)" }],
      hasActivePayment: true,
      release: getReleaseContext(shop),
      ...featureFlagsForTier(PLAN_TIERS.premium),
    };
  }

  if (String(process.env.DEV_PREVIEW_MODE || "").toLowerCase() === "true") {
    return {
      subscriptions: [{ name: "Premium Monthly (Dev Preview)" }],
      hasActivePayment: true,
      release: getReleaseContext(shop),
      ...featureFlagsForTier(PLAN_TIERS.premium),
    };
  }

  const premiumOverride = resolvePremiumOverrideForShop(shop);
  if (premiumOverride) {
    return {
      ...premiumOverride,
      release: getReleaseContext(shop),
      ...featureFlagsForTier(PLAN_TIERS.premium),
    };
  }

  const check = await billing.check({
    plans,
    isTest: isTestMode,
  });
  const tier = detectTierFromSubscriptions(check?.appSubscriptions || []);
  return {
    subscriptions: check?.appSubscriptions || [],
    hasActivePayment: !!check?.hasActivePayment,
    release: getReleaseContext(shop),
    ...featureFlagsForTier(tier),
  };
}
