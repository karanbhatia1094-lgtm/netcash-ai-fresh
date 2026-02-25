import {
  shopifyApp,
  ApiVersion,
  AppDistribution,
  BillingInterval,
  DeliveryMethod,
} from "@shopify/shopify-app-remix/server";
import dns from "node:dns";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { prisma } from "./utils/db.server";
import { assertProductionEnv, resolveAppUrl } from "./utils/env.server";

assertProductionEnv();

function clearInvalidProxyEnvForDev() {
  if (process.env.NODE_ENV === "production") return;

  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];

  for (const key of proxyKeys) {
    const value = String(process.env[key] || "").trim();
    if (!value) continue;

    // Shopify CLI can inject local/tunnel URLs; these are not valid outbound proxies
    // for Shopify API calls and can cause ENOTFOUND on values like "https://localhost:3000".
    if (value.includes("localhost") || value.includes("127.0.0.1") || value.includes("trycloudflare.com")) {
      delete process.env[key];
    }
  }
}

clearInvalidProxyEnvForDev();

function patchDnsLookupForDev() {
  if (process.env.NODE_ENV === "production") return;
  if (globalThis.__NETCASH_DNS_PATCHED__) return;

  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = function patchedLookup(hostname, ...args) {
    let safeHostname = hostname;

    if (typeof safeHostname === "string" && /^https?:\/\//i.test(safeHostname)) {
      try {
        safeHostname = new URL(safeHostname).hostname;
      } catch {
        safeHostname = safeHostname.replace(/^https?:\/\//i, "").split("/")[0];
      }
    }

    return originalLookup(safeHostname, ...args);
  };

  globalThis.__NETCASH_DNS_PATCHED__ = true;
}

patchDnsLookupForDev();

export const BASIC_PLAN = "Basic Monthly";
export const PRO_PLAN = "Pro Monthly";
export const PREMIUM_PLAN = "Premium Monthly";
export const BILLING_PLANS = [BASIC_PLAN, PRO_PLAN, PREMIUM_PLAN];

function resolveDistribution() {
  const raw = String(process.env.SHOPIFY_DISTRIBUTION || "").trim().toLowerCase();
  if (raw === "single_merchant" || raw === "singlemerchant" || raw === "single") {
    return AppDistribution.SingleMerchant;
  }
  return AppDistribution.AppStore;
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: resolveAppUrl(),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: resolveDistribution(),
  webhooks: {
    APP_UNINSTALLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/uninstalled",
    },
    APP_SCOPES_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/scopes_update",
    },
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/orders_create",
    },
    ORDERS_UPDATED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/orders_updated",
    },
    REFUNDS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/refunds_create",
    },
  },
  billing: {
    [BASIC_PLAN]: {
      lineItems: [
        {
          amount: 2000,
          currencyCode: "INR",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PRO_PLAN]: {
      lineItems: [
        {
          amount: 5000,
          currencyCode: "INR",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PREMIUM_PLAN]: {
      lineItems: [
        {
          amount: 10000,
          currencyCode: "INR",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: false,
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
