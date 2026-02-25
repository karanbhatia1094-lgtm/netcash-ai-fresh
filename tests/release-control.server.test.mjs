import test from "node:test";
import assert from "node:assert/strict";
import { getReleaseContext, isFeatureEnabledForShop } from "../app/utils/release-control.server.js";

test("getReleaseContext resolves internal/canary/stable", () => {
  const prevInternal = process.env.ROLLOUT_INTERNAL_SHOPS;
  const prevCanary = process.env.ROLLOUT_CANARY_SHOPS;
  try {
    process.env.ROLLOUT_INTERNAL_SHOPS = "internal-shop.myshopify.com";
    process.env.ROLLOUT_CANARY_SHOPS = "canary-shop.myshopify.com";
    assert.equal(getReleaseContext("internal-shop.myshopify.com").channel, "internal");
    assert.equal(getReleaseContext("canary-shop.myshopify.com").channel, "canary");
    assert.equal(getReleaseContext("stable-shop.myshopify.com").channel, "stable");
  } finally {
    process.env.ROLLOUT_INTERNAL_SHOPS = prevInternal;
    process.env.ROLLOUT_CANARY_SHOPS = prevCanary;
  }
});

test("isFeatureEnabledForShop respects rollout mode", () => {
  const prevMode = process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT;
  const prevCanary = process.env.ROLLOUT_CANARY_SHOPS;
  const prevAsyncMode = process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_ROLLOUT;
  const prevAsyncShops = process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_SHOPS;
  try {
    process.env.ROLLOUT_CANARY_SHOPS = "canary-shop.myshopify.com";
    process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT = "canary";
    assert.equal(isFeatureEnabledForShop("canary-shop.myshopify.com", "campaign_multi_source_filters", false), true);
    assert.equal(isFeatureEnabledForShop("stable-shop.myshopify.com", "campaign_multi_source_filters", false), false);

    process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_ROLLOUT = "shops";
    process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_SHOPS = "shop-a.myshopify.com";
    assert.equal(isFeatureEnabledForShop("shop-a.myshopify.com", "home_async_order_sync", false), true);
    assert.equal(isFeatureEnabledForShop("shop-b.myshopify.com", "home_async_order_sync", false), false);
  } finally {
    process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT = prevMode;
    process.env.ROLLOUT_CANARY_SHOPS = prevCanary;
    process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_ROLLOUT = prevAsyncMode;
    process.env.FEATURE_HOME_ASYNC_ORDER_SYNC_SHOPS = prevAsyncShops;
  }
});

test("canary-only rollout blocks stable shops", () => {
  const prevCanaryOnly = process.env.ROLLOUT_CANARY_ONLY;
  const prevCanary = process.env.ROLLOUT_CANARY_SHOPS;
  const prevMode = process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT;
  try {
    process.env.ROLLOUT_CANARY_ONLY = "true";
    process.env.ROLLOUT_CANARY_SHOPS = "pilot-shop.myshopify.com";
    process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT = "all";

    assert.equal(isFeatureEnabledForShop("pilot-shop.myshopify.com", "campaign_multi_source_filters", false), true);
    assert.equal(isFeatureEnabledForShop("stable-shop.myshopify.com", "campaign_multi_source_filters", true), false);
  } finally {
    process.env.ROLLOUT_CANARY_ONLY = prevCanaryOnly;
    process.env.ROLLOUT_CANARY_SHOPS = prevCanary;
    process.env.FEATURE_CAMPAIGN_MULTI_SOURCE_FILTERS_ROLLOUT = prevMode;
  }
});
