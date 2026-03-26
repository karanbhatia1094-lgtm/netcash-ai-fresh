import test from "node:test";
import assert from "node:assert/strict";
import {
  detectTierFromSubscriptions,
  featureFlagsForTier,
  PLAN_TIERS,
  resolvePremiumOverrideForShop,
} from "../app/utils/plan.server.js";

test("detectTierFromSubscriptions resolves premium over pro/basic", () => {
  const tier = detectTierFromSubscriptions([
    { name: "Basic Monthly" },
    { name: "Pro Monthly" },
    { name: "Premium Monthly" },
  ]);
  assert.equal(tier, PLAN_TIERS.premium);
});

test("detectTierFromSubscriptions resolves pro when premium missing", () => {
  const tier = detectTierFromSubscriptions([
    { name: "Starter Monthly" },
    { name: "Pro Monthly" },
  ]);
  assert.equal(tier, PLAN_TIERS.pro);
});

test("featureFlagsForTier returns expected flags", () => {
  assert.deepEqual(featureFlagsForTier(PLAN_TIERS.basic), {
    tier: PLAN_TIERS.basic,
    hasPro: false,
    hasPremium: false,
  });
  assert.deepEqual(featureFlagsForTier(PLAN_TIERS.pro), {
    tier: PLAN_TIERS.pro,
    hasPro: true,
    hasPremium: false,
  });
  assert.deepEqual(featureFlagsForTier(PLAN_TIERS.premium), {
    tier: PLAN_TIERS.premium,
    hasPro: true,
    hasPremium: true,
  });
});

test("resolvePremiumOverrideForShop matches PREMIUM_SHOPS entries", () => {
  const previous = process.env.PREMIUM_SHOPS;
  process.env.PREMIUM_SHOPS = "demo.myshopify.com, other.myshopify.com";

  const hit = resolvePremiumOverrideForShop("Demo.MyShopify.com");
  const miss = resolvePremiumOverrideForShop("missing.myshopify.com");

  assert.equal(Boolean(hit), true);
  assert.equal(hit?.hasActivePayment, true);
  assert.equal(hit?.subscriptions?.[0]?.name?.includes("Premium Monthly"), true);
  assert.equal(miss, null);

  if (previous == null) {
    delete process.env.PREMIUM_SHOPS;
  } else {
    process.env.PREMIUM_SHOPS = previous;
  }
});
