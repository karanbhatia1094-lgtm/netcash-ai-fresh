import "dotenv/config";
import { spawnSync } from "node:child_process";

function runCommand(command, args) {
  const cmd = [command, ...args].join(" ");
  const result = spawnSync(cmd, { stdio: "pipe", encoding: "utf8", shell: true });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    command: cmd,
  };
}

async function checkEndpoint(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url, body: text.slice(0, 300) };
  } catch (error) {
    return { ok: false, status: 0, url, body: String(error?.message || error) };
  }
}

async function main() {
  const checks = [];
  checks.push(runCommand("npm", ["run", "check:scaling"]));
  checks.push(runCommand("npm", ["run", "check:indexes"]));

  const appBaseUrl = String(process.env.APP_BASE_URL || process.env.SHOPIFY_APP_URL || "").trim();
  const cronKey = String(process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "").trim();
  if (appBaseUrl) {
    checks.push(await checkEndpoint(`${appBaseUrl.replace(/\/$/, "")}/health`));
    checks.push(await checkEndpoint(`${appBaseUrl.replace(/\/$/, "")}/health/readiness`));
    if (cronKey) {
      checks.push(await checkEndpoint(
        `${appBaseUrl.replace(/\/$/, "")}/api/monitoring/overview`,
        { "x-netcash-cron-key": cronKey },
      ));
      checks.push(await checkEndpoint(
        `${appBaseUrl.replace(/\/$/, "")}/api/autopilot/cron?dryRun=true&maxShops=1`,
        { "x-netcash-cron-key": cronKey },
      ));
      checks.push(await checkEndpoint(
        `${appBaseUrl.replace(/\/$/, "")}/api/jobs/worker?maxJobs=1&types=__go_no_go_noop`,
        { "x-netcash-cron-key": cronKey },
      ));
    }
  }

  const failed = checks.filter((row) => !row.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    checks,
    failedCount: failed.length,
    checkedAt: new Date().toISOString(),
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
