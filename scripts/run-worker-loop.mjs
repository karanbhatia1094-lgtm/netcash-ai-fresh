import "dotenv/config";

function getBaseUrl() {
  return String(process.env.APP_BASE_URL || process.env.SHOPIFY_APP_URL || "").trim().replace(/\/$/, "");
}

function getCronKey() {
  return String(process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "").trim();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error("APP_BASE_URL or SHOPIFY_APP_URL is required");
  const cronKey = getCronKey();
  if (!cronKey) throw new Error("JOB_WORKER_KEY or CONNECTOR_CRON_KEY is required");

  const maxJobs = Math.max(1, Math.min(500, Number(process.env.WORKER_MAX_JOBS || 50)));
  const intervalMs = Math.max(1000, Number(process.env.WORKER_LOOP_INTERVAL_MS || 5000));
  const workerId = String(process.env.WORKER_ID || "scripts.run-worker-loop");
  const types = String(process.env.WORKER_TYPES || "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean)
    .join(",");

  console.log(JSON.stringify({
    ok: true,
    startedAt: new Date().toISOString(),
    mode: "worker-loop",
    baseUrl,
    maxJobs,
    intervalMs,
    types: types ? types.split(",") : [],
  }));

  while (true) {
    const params = new URLSearchParams({
      maxJobs: String(maxJobs),
      workerId,
    });
    if (types) params.set("types", types);
    const url = `${baseUrl}/api/jobs/worker?${params.toString()}`;
    const startedAt = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "x-netcash-cron-key": cronKey,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }

      console.log(JSON.stringify({
        ok: response.ok,
        status: response.status,
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        body,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: String(error?.message || error),
      }));
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
  }, null, 2));
  process.exitCode = 1;
});
