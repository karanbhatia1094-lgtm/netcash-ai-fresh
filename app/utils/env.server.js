const PROD_REQUIRED_ENV_KEYS = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SCOPES",
  "SHOPIFY_APP_URL",
  "DATABASE_PROVIDER",
  "DATABASE_URL",
];

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function safeUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function isSecureKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (raw.length < 24) return false;
  if (/replace_with_secure_random_key/i.test(raw)) return false;
  if (/changeme|example|test|dummy|dev/i.test(raw)) return false;
  return true;
}

export function resolveAppUrl() {
  const raw = process.env.SHOPIFY_APP_URL || process.env.APP_URL || "http://localhost:3000";
  return String(raw).trim();
}

export function getEnvHealth({ includeOptional = false } = {}) {
  const required = PROD_REQUIRED_ENV_KEYS.map((key) => ({
    key,
    required: true,
    present: !isBlank(process.env[key]),
  }));

  const optionalKeys = [
    "ATTRIBUTION_API_KEY",
    "CONNECTOR_CRON_KEY",
    "DIGEST_CRON_KEY",
    "DIGEST_WEBHOOK_URL",
    "META_APP_ID",
    "META_APP_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "REPORTS_CRON_KEY",
    "TRUTH_CRON_KEY",
    "OWNER_SHOPS",
  ];

  const optional = includeOptional
    ? optionalKeys.map((key) => ({
        key,
        required: false,
        present: !isBlank(process.env[key]),
      }))
    : [];

  const appUrl = resolveAppUrl();
  const appUrlObj = safeUrl(appUrl);
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const databaseProvider = String(process.env.DATABASE_PROVIDER || "").trim().toLowerCase();
  const isPostgres =
    databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
  const appUrlChecks = [
    {
      key: "SHOPIFY_APP_URL_VALID_URL",
      required: true,
      present: !!appUrlObj,
    },
    {
      key: "SHOPIFY_APP_URL_HTTPS",
      required: isProduction(),
      present: !!appUrlObj && (!isProduction() || appUrlObj.protocol === "https:"),
    },
    {
      key: "DATABASE_PROVIDER_POSTGRESQL_IN_PRODUCTION",
      required: isProduction(),
      present: !isProduction() || databaseProvider === "postgresql",
    },
    {
      key: "DATABASE_URL_POSTGRES_IN_PRODUCTION",
      required: isProduction(),
      present: !isProduction() || isPostgres,
    },
    {
      key: "BILLING_DEV_OVERRIDE_DISABLED",
      required: isProduction(),
      present: !isProduction() || !String(process.env.BILLING_DEV_OVERRIDE || "").trim(),
    },
    {
      key: "CONNECTOR_OAUTH_STATE_SECRET_SECURE",
      required: isProduction(),
      present: !isProduction() || isSecureKey(process.env.CONNECTOR_OAUTH_STATE_SECRET),
    },
    {
      key: "ATTRIBUTION_API_KEY_SECURE",
      required: isProduction(),
      present: !isProduction() || isSecureKey(process.env.ATTRIBUTION_API_KEY),
    },
    {
      key: "CONNECTOR_CRON_KEY_SECURE",
      required: isProduction(),
      present: !isProduction() || isSecureKey(process.env.CONNECTOR_CRON_KEY),
    },
    {
      key: "JOB_WORKER_KEY_SECURE",
      required: isProduction(),
      present: !isProduction() || isSecureKey(process.env.JOB_WORKER_KEY),
    },
  ];

  const checks = [...required, ...appUrlChecks, ...optional];
  const missingRequired = checks.filter((c) => c.required && !c.present).map((c) => c.key);

  return {
    checks,
    missingRequired,
    ok: missingRequired.length === 0,
    appUrl,
  };
}

export function assertProductionEnv() {
  if (process.env.NODE_ENV !== "production") return;

  const health = getEnvHealth();
  if (!health.ok) {
    throw new Error(
      `Production environment misconfigured. Missing/invalid: ${health.missingRequired.join(", ")}`
    );
  }
}
