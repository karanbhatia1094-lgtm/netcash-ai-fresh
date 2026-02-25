function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function getOpsKey() {
  return process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "";
}

function authorized(request) {
  const expected = getOpsKey();
  if (!expected) return { ok: false, reason: "JOB_WORKER_KEY or CONNECTOR_CRON_KEY is not set" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (!provided || provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

function ageDays(isoDate) {
  const dt = new Date(String(isoDate || ""));
  if (Number.isNaN(dt.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24)));
}

function keyRow(name) {
  const value = String(process.env[name] || "");
  const rotatedAt = process.env[`${name}_ROTATED_AT`] || "";
  const age = ageDays(rotatedAt);
  const maxAgeDays = Math.max(7, Number(process.env.SECRET_MAX_AGE_DAYS || 90));
  return {
    key: name,
    configured: Boolean(value),
    rotatedAt: rotatedAt || null,
    ageDays: age,
    maxAgeDays,
    alert: !value || age == null || age > maxAgeDays,
  };
}

async function run(request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });
  }

  const keys = [
    "CONNECTOR_CRON_KEY",
    "JOB_WORKER_KEY",
    "ATTRIBUTION_API_KEY",
    "CONNECTOR_OAUTH_STATE_SECRET",
    "DIGEST_CRON_KEY",
    "REPORTS_CRON_KEY",
  ];
  const rows = keys.map((name) => keyRow(name));
  const billingDevOverride = String(process.env.BILLING_DEV_OVERRIDE || "").trim();
  return json({
    ok: true,
    alerts: rows.filter((row) => row.alert).length,
    rows,
    billingDevOverrideSet: Boolean(billingDevOverride),
    oauthRefreshHandling: {
      googleRefreshTokenFlow: "implemented",
      requireRefreshToken: true,
    },
  });
}

export async function loader({ request }) {
  return run(request);
}
