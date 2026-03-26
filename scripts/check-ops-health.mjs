import "dotenv/config";

function getBaseUrl() {
  return String(process.env.APP_BASE_URL || process.env.SHOPIFY_APP_URL || "").trim().replace(/\/$/, "");
}

function getCronKey() {
  return String(process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || process.env.AUTOPILOT_CRON_KEY || "").trim();
}

async function check(url, headers = {}) {
  try {
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return {
      ok: res.ok,
      status: res.status,
      url,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: { error: String(error?.message || error) },
    };
  }
}

async function main() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error("APP_BASE_URL or SHOPIFY_APP_URL is required");
  const cronKey = getCronKey();
  if (!cronKey) throw new Error("JOB_WORKER_KEY, CONNECTOR_CRON_KEY, or AUTOPILOT_CRON_KEY is required");

  const headers = { "x-netcash-cron-key": cronKey };
  const checks = [];

  checks.push(await check(`${baseUrl}/api/autopilot/cron?dryRun=true&maxShops=1`, headers));
  checks.push(await check(`${baseUrl}/api/jobs/worker?maxJobs=1&types=__ops_healthcheck_noop`, headers));
  checks.push(await check(`${baseUrl}/api/monitoring/overview?windowMinutes=60&syncDays=7`, headers));
  checks.push(await check(`${baseUrl}/api/monitoring/alerts?windowMinutes=60&syncDays=7&autoRepair=true`, headers));

  const failed = checks.filter((row) => !row.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    failedCount: failed.length,
  }, null, 2));

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
