import "dotenv/config";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    command: `${command} ${args.join(" ")}`.trim(),
  };
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function requiredEnvChecks() {
  const required = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_APP_URL",
    "APP_BASE_URL",
    "DATABASE_URL",
    "DATABASE_PROVIDER",
    "JOB_WORKER_KEY",
  ];
  const missing = required.filter((key) => !String(process.env[key] || "").trim());
  return {
    ok: missing.length === 0,
    missing,
  };
}

async function main() {
  const env = requiredEnvChecks();
  if (!env.ok) {
    console.error(JSON.stringify({
      ok: false,
      step: "env-check",
      missingEnv: env.missing,
      message: "Set required production env vars before running prod bootstrap.",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runMigrations = isTrue(process.env.BOOTSTRAP_RUN_MIGRATIONS);
  const runDbPush = isTrue(process.env.BOOTSTRAP_RUN_DB_PUSH);
  const steps = [];

  steps.push(["npm", ["run", "prisma:generate:prod"]]);
  if (runMigrations) {
    steps.push(["npx", ["prisma", "migrate", "deploy"]]);
  }
  if (runDbPush) {
    steps.push(["npm", ["run", "prisma:push:prod"]]);
  }
  steps.push(["npm", ["run", "check:scaling"]]);
  steps.push(["npm", ["run", "check:indexes"]]);
  steps.push(["npm", ["run", "check:ops"]]);
  steps.push(["npm", ["run", "check:go-no-go"]]);

  const results = [];
  for (const [command, args] of steps) {
    // eslint-disable-next-line no-await-in-loop
    const row = run(command, args);
    results.push(row);
    if (!row.ok) break;
  }

  const failed = results.find((row) => !row.ok) || null;
  console.log(JSON.stringify({
    ok: !failed,
    failedStep: failed?.command || null,
    results,
    runMigrations,
    runDbPush,
    completedAt: new Date().toISOString(),
  }, null, 2));

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error?.message || error),
  }, null, 2));
  process.exitCode = 1;
});
