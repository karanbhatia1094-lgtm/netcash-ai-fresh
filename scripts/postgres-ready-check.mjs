import "dotenv/config";

const env = process.env.NODE_ENV || "development";
const databaseUrl = String(process.env.DATABASE_URL || "");
const databaseProvider = String(process.env.DATABASE_PROVIDER || "").trim().toLowerCase();
const isSqlite = databaseUrl.startsWith("file:");
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");

const checks = [
  {
    name: "DATABASE_URL set",
    ok: Boolean(databaseUrl),
    message: "Set DATABASE_URL in environment",
  },
  {
    name: "Database engine",
    ok: isPostgres,
    message: "Use PostgreSQL DATABASE_URL",
  },
  {
    name: "DATABASE_PROVIDER set to postgresql",
    ok: databaseProvider === "postgresql",
    message: "Set DATABASE_PROVIDER=postgresql in production",
  },
  {
    name: "Worker key configured",
    ok: Boolean(process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY),
    message: "Set JOB_WORKER_KEY or CONNECTOR_CRON_KEY to run async workers",
  },
  {
    name: "Canary-only rollout enabled",
    ok: String(process.env.ROLLOUT_CANARY_ONLY || "false").toLowerCase() === "true",
    message: "Set ROLLOUT_CANARY_ONLY=true for controlled launch",
  },
  {
    name: "Dev billing override disabled",
    ok: !process.env.BILLING_DEV_OVERRIDE,
    message: "Unset BILLING_DEV_OVERRIDE before production rollout",
  },
  {
    name: "Reports mail config",
    ok: !process.env.REPORTS_ENABLED || Boolean(process.env.RESEND_API_KEY && process.env.REPORTS_FROM_EMAIL),
    message: "Set RESEND_API_KEY and REPORTS_FROM_EMAIL when reports are enabled",
  },
];

if (!isSqlite && !isPostgres && databaseUrl) {
  checks.push({
    name: "Database URL type",
    ok: false,
    message: "DATABASE_URL must be sqlite file: or postgres:// URL",
  });
}

const failed = checks.filter((row) => !row.ok);
console.log(JSON.stringify({
  env,
  databaseProvider: databaseProvider || "unset",
  databaseType: isPostgres ? "postgres" : isSqlite ? "sqlite" : (databaseUrl ? "unknown" : "unset"),
  checks,
  pass: failed.length === 0,
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
