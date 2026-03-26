import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { upsertConnectorCredential } from "../utils/db.server";
import { enqueueJob } from "../utils/job-queue.server";

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, { status: 405 });
  }
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const provider = String(formData.get("provider") || "").trim().toLowerCase();
  const accountName = String(formData.get("accountName") || "").trim() || null;
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  const endpoint = String(formData.get("endpoint") || "").trim();
  const apiKey = String(formData.get("apiKey") || "").trim();
  const authHeaderName = String(formData.get("authHeaderName") || "Authorization").trim() || "Authorization";
  const authPrefix = String(formData.get("authPrefix") || "Bearer").trim();
  const kind = String(formData.get("kind") || "delivery").trim().toLowerCase();
  const runNow = ["1", "true", "yes", "on"].includes(String(formData.get("runNow") || "").toLowerCase());

  if (!provider) {
    return json({ ok: false, error: "Provider is required." }, { status: 400 });
  }
  if (!apiKey) {
    return json({ ok: false, error: "API key/token is required." }, { status: 400 });
  }
  if (!baseUrl && !endpoint) {
    return json({ ok: false, error: "Base URL or endpoint is required." }, { status: 400 });
  }

  const metadata = {
    baseUrl,
    endpoint,
    apiKey,
    authHeaderName,
    authPrefix,
    kind,
  };

  const credential = await upsertConnectorCredential({
    shop: session.shop,
    provider,
    accountName,
    accessToken: apiKey,
    metadata,
  });

  let job = null;
  if (runNow) {
    job = await enqueueJob({
      type: "connector_sync",
      shop: session.shop,
      payload: { provider, shop: session.shop, days: 7 },
      uniqueKey: `connector_sync:${session.shop}:${provider}`,
      maxAttempts: 3,
    });
  }

  return json({ ok: true, credentialId: credential.id, jobId: job?.id || null });
}

export async function loader() {
  return json({
    ok: true,
    endpoint: "/api/connectors/credentials",
    method: "POST",
  });
}
