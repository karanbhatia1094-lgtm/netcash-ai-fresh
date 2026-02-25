/*
  Minimal built-in load smoke test for Netcash.ai.
  Usage:
    BASE_URL=https://localhost:3000 node scripts/loadtest-smoke.mjs
*/

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const endpoint = process.env.LOADTEST_ENDPOINT || "/health/readiness";
const concurrency = Math.max(1, Math.min(200, Number(process.env.LOADTEST_CONCURRENCY || 25)));
const totalRequests = Math.max(concurrency, Number(process.env.LOADTEST_TOTAL_REQUESTS || 250));
const timeoutMs = Math.max(500, Number(process.env.LOADTEST_TIMEOUT_MS || 8000));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function runOne(url) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const durationMs = Date.now() - start;
    return {
      ok: response.ok,
      status: response.status,
      durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - start,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const url = `${baseUrl}${endpoint}`;
const workers = [];
const results = [];
let sent = 0;

for (let i = 0; i < concurrency; i += 1) {
  workers.push((async () => {
    while (sent < totalRequests) {
      sent += 1;
      // eslint-disable-next-line no-await-in-loop
      const result = await runOne(url);
      results.push(result);
    }
  })());
}

await Promise.all(workers);

const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
const successful = results.filter((r) => r.ok).length;
const failed = results.length - successful;
const statusBuckets = {};
for (const row of results) {
  const key = String(row.status || "ERR");
  statusBuckets[key] = (statusBuckets[key] || 0) + 1;
}

const summary = {
  url,
  totalRequests: results.length,
  concurrency,
  successful,
  failed,
  successRatePct: results.length ? (successful / results.length) * 100 : 0,
  latencyMs: {
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] || 0,
  },
  statusBuckets,
  slo: {
    target: ">=99% success and p95 < 600ms for readiness endpoint",
    pass: (results.length ? successful / results.length : 0) >= 0.99 && percentile(durations, 95) < 600,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.slo.pass) process.exitCode = 1;
