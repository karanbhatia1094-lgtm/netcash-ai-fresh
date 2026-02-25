import test from "node:test";
import assert from "node:assert/strict";
import { detectTierFromSubscriptions, featureFlagsForTier, PLAN_TIERS } from "../app/utils/plan.server.js";

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
