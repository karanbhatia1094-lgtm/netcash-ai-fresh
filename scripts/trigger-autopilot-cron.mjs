import "dotenv/config";

function getBaseUrl() {
  return String(process.env.APP_BASE_URL || process.env.SHOPIFY_APP_URL || "").trim().replace(/\/$/, "");
}

function getCronKey() {
  return String(
    process.env.AUTOPILOT_CRON_KEY
    || process.env.JOB_WORKER_KEY
    || process.env.CONNECTOR_CRON_KEY
    || "",
  ).trim();
}

async function main() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error("APP_BASE_URL or SHOPIFY_APP_URL is required");
  const cronKey = getCronKey();
  if (!cronKey) throw new Error("AUTOPILOT_CRON_KEY, JOB_WORKER_KEY, or CONNECTOR_CRON_KEY is required");

  const days = Math.max(7, Math.min(365, Number(process.env.AUTOPILOT_DAYS || 30)));
  const maxShops = Math.max(1, Math.min(500, Number(process.env.AUTOPILOT_MAX_SHOPS || 100)));
  const maxActions = Math.max(1, Math.min(25, Number(process.env.AUTOPILOT_MAX_ACTIONS || 5)));
  const applyActions = ["1", "true", "yes", "on"].includes(String(process.env.AUTOPILOT_APPLY_ACTIONS || "").toLowerCase());
  const shop = String(process.env.AUTOPILOT_SHOP || "").trim().toLowerCase();

  const params = new URLSearchParams({
    days: String(days),
    maxShops: String(maxShops),
    maxActions: String(maxActions),
  });
  if (applyActions) params.set("applyActions", "true");
  if (shop) params.set("shop", shop);

  const url = `${baseUrl}/api/autopilot/cron?${params.toString()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-netcash-cron-key": cronKey,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  const out = {
    ok: response.ok,
    status: response.status,
    url,
    body,
    triggeredAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
  }, null, 2));
  process.exitCode = 1;
});
