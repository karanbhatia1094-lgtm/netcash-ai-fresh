import { getBillingSnapshotSummary, refreshBillingSnapshotsForShops } from "../utils/billing-snapshots.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function getCronKey() {
  return process.env.BILLING_CRON_KEY || process.env.JOB_WORKER_KEY || process.env.CONNECTOR_CRON_KEY || "";
}

function authorize(request) {
  const expected = getCronKey();
  if (!expected) return { ok: false, reason: "BILLING_CRON_KEY or JOB_WORKER_KEY or CONNECTOR_CRON_KEY is required" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (!provided || provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function run(request) {
  const auth = authorize(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });
  const url = new URL(request.url);
  const maxShops = Math.max(1, Math.min(500, Number(url.searchParams.get("maxShops") || 100)));
  const shop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || 60)));

  const refresh = await refreshBillingSnapshotsForShops({ shop, maxShops });
  const summary = await getBillingSnapshotSummary(days);
  return json({ ok: true, refresh, summary });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
