import crypto from "node:crypto";
import { getConnectorCredential, upsertConnectorCredential } from "./db.server";

function getBaseUrl() {
  return process.env.SHOPIFY_APP_URL || process.env.APP_URL || "http://localhost:3000";
}

function getStateSecret() {
  return process.env.CONNECTOR_OAUTH_STATE_SECRET || process.env.SHOPIFY_API_SECRET || "dev-state-secret";
}

function signStatePayload(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getStateSecret()).update(body).digest("hex");
  return `${body}.${signature}`;
}

function verifyStatePayload(value) {
  const [body, signature] = String(value || "").split(".");
  if (!body || !signature) throw new Error("Invalid OAuth state");
  const expected = crypto.createHmac("sha256", getStateSecret()).update(body).digest("hex");
  if (expected !== signature) throw new Error("OAuth state signature mismatch");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed?.shop || !parsed?.provider) throw new Error("OAuth state missing fields");
  if (Date.now() - Number(parsed.ts || 0) > 1000 * 60 * 15) throw new Error("OAuth state expired");
  return parsed;
}

function sanitizeReturnTo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "/app/integrations?wizard=1";
  if (!raw.startsWith("/")) return "/app/integrations?wizard=1";
  if (!raw.startsWith("/app")) return "/app/integrations?wizard=1";
  return raw;
}

function normalizeNextProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "meta" || raw === "meta_ads") return "meta_ads";
  if (raw === "google" || raw === "google_ads") return "google_ads";
  return null;
}

export function buildMetaAuthUrl(shop, options = {}) {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new Error("Missing META_APP_ID");
  const state = signStatePayload({
    provider: "meta_ads",
    shop,
    returnTo: sanitizeReturnTo(options.returnTo),
    nextProvider: normalizeNextProvider(options.nextProvider),
    nonce: crypto.randomUUID(),
    ts: Date.now(),
  });
  const redirectUri = `${getBaseUrl()}/connectors/meta/callback`;
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "ads_read,business_management",
    state,
  });
  return `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;
}

export async function handleMetaCallback(url) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Missing META_APP_ID or META_APP_SECRET");

  const code = url.searchParams.get("code");
  if (!code) throw new Error("Missing OAuth code");
  const state = verifyStatePayload(url.searchParams.get("state"));
  const redirectUri = `${getBaseUrl()}/connectors/meta/callback`;

  const shortUrl = new URL("https://graph.facebook.com/v20.0/oauth/access_token");
  shortUrl.searchParams.set("client_id", appId);
  shortUrl.searchParams.set("client_secret", appSecret);
  shortUrl.searchParams.set("redirect_uri", redirectUri);
  shortUrl.searchParams.set("code", code);

  const shortRes = await fetch(shortUrl);
  const shortData = await shortRes.json();
  if (!shortRes.ok || !shortData?.access_token) {
    throw new Error(`Meta token exchange failed: ${shortData?.error?.message || shortRes.statusText}`);
  }

  const longUrl = new URL("https://graph.facebook.com/v20.0/oauth/access_token");
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortData.access_token);
  const longRes = await fetch(longUrl);
  const longData = await longRes.json();

  const finalAccessToken = longData?.access_token || shortData.access_token;
  const expiresIn = Number(longData?.expires_in || shortData?.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

  let accountId = null;
  let accountName = null;
  try {
    const accountsUrl = new URL("https://graph.facebook.com/v20.0/me/adaccounts");
    accountsUrl.searchParams.set("fields", "id,name");
    accountsUrl.searchParams.set("access_token", finalAccessToken);
    const accountsRes = await fetch(accountsUrl);
    const accountsData = await accountsRes.json();
    const first = accountsData?.data?.[0];
    if (first) {
      accountId = String(first.id || "").replace(/^act_/, "");
      accountName = first.name || null;
    }
  } catch {
    // Ignore account discovery failure and keep token only.
  }

  await upsertConnectorCredential({
    shop: state.shop,
    provider: "meta_ads",
    accountId,
    accountName,
    accessToken: finalAccessToken,
    refreshToken: null,
    tokenType: "Bearer",
    scope: "ads_read,business_management",
    expiresAt,
    metadata: { connectedAt: new Date().toISOString() },
  });

  return { shop: state.shop, returnTo: sanitizeReturnTo(state.returnTo), nextProvider: normalizeNextProvider(state.nextProvider) };
}

export function buildGoogleAuthUrl(shop, options = {}) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("Missing GOOGLE_CLIENT_ID");
  const state = signStatePayload({
    provider: "google_ads",
    shop,
    returnTo: sanitizeReturnTo(options.returnTo),
    nextProvider: normalizeNextProvider(options.nextProvider),
    nonce: crypto.randomUUID(),
    ts: Date.now(),
  });
  const redirectUri = `${getBaseUrl()}/connectors/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "https://www.googleapis.com/auth/adwords",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleGoogleCallback(url) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");

  const code = url.searchParams.get("code");
  if (!code) throw new Error("Missing OAuth code");
  const state = verifyStatePayload(url.searchParams.get("state"));
  const redirectUri = `${getBaseUrl()}/connectors/google/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData?.access_token) {
    throw new Error(`Google token exchange failed: ${tokenData?.error || tokenRes.statusText}`);
  }

  const existing = await getConnectorCredential(state.shop, "google_ads");
  const expiresIn = Number(tokenData.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

  await upsertConnectorCredential({
    shop: state.shop,
    provider: "google_ads",
    accountId: existing?.accountId || process.env.GOOGLE_ADS_CUSTOMER_ID || null,
    accountName: existing?.accountName || null,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || existing?.refreshToken || null,
    tokenType: tokenData.token_type || "Bearer",
    scope: tokenData.scope || null,
    expiresAt,
    metadata: { connectedAt: new Date().toISOString() },
  });

  return { shop: state.shop, returnTo: sanitizeReturnTo(state.returnTo), nextProvider: normalizeNextProvider(state.nextProvider) };
}

export async function refreshGoogleAccessToken(shop) {
  const credential = await getConnectorCredential(shop, "google_ads");
  if (!credential?.refreshToken) throw new Error("Google refresh token missing. Reconnect Google Ads.");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credential.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData?.access_token) {
    throw new Error(`Google refresh failed: ${tokenData?.error || tokenRes.statusText}`);
  }

  const expiresIn = Number(tokenData.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;
  return upsertConnectorCredential({
    shop,
    provider: "google_ads",
    accountId: credential.accountId,
    accountName: credential.accountName,
    accessToken: tokenData.access_token,
    refreshToken: credential.refreshToken,
    tokenType: tokenData.token_type || credential.tokenType || "Bearer",
    scope: tokenData.scope || credential.scope || null,
    expiresAt,
    metadata: credential.metadata ? JSON.parse(credential.metadata) : null,
  });
}
