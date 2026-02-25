import { prisma } from "../utils/db.server";
import { enqueueJob } from "../utils/job-queue.server";

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
  return process.env.AUTOPILOT_CRON_KEY || process.env.CONNECTOR_CRON_KEY || process.env.JOB_WORKER_KEY || "";
}

function authorize(request) {
  const expected = getCronKey();
  if (!expected) return { ok: false, reason: "AUTOPILOT_CRON_KEY or CONNECTOR_CRON_KEY or JOB_WORKER_KEY is required" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function resolveTargetShops(singleShop, maxShops) {
  if (singleShop) return [{ shop: singleShop }];

  const connectorShops = await prisma.connectorCredential.groupBy({
    by: ["shop"],
    where: {
      accessToken: { not: null },
    },
    orderBy: { shop: "asc" },
    take: maxShops,
  }).catch(() => []);

  if (connectorShops.length > 0) return connectorShops;

  return prisma.netCashOrder.groupBy({
    by: ["shop"],
    orderBy: { shop: "asc" },
    take: maxShops,
  });
}

async function run(request) {
  const auth = authorize(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });

  const url = new URL(request.url);
  const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days") || 30)));
  const maxShops = Math.max(1, Math.min(500, Number(url.searchParams.get("maxShops") || 100)));
  const maxActions = Math.max(1, Math.min(25, Number(url.searchParams.get("maxActions") || 5)));
  const applyActions = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("applyActions") || "").toLowerCase());
  const dryRun = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("dryRun") || "").toLowerCase());
  const singleShop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  const dateKey = new Date().toISOString().slice(0, 10);

  const shops = await resolveTargetShops(singleShop, maxShops);
  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      candidateShops: shops.map((row) => String(row.shop || "").toLowerCase()).filter(Boolean),
      attempted: shops.length,
      config: { days, maxActions, applyActions, dateKey },
    });
  }
  const queued = [];
  const errors = [];

  for (const row of shops) {
    const shop = String(row.shop || "").trim().toLowerCase();
    if (!shop) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const job = await enqueueJob({
        type: "profit_guardrails_run",
        shop,
        payload: { shop, days, maxActions, applyActions },
        uniqueKey: `profit_guardrails_run:${shop}:${dateKey}`,
        maxAttempts: 3,
      });
      queued.push({ shop, jobId: job.id });
    } catch (error) {
      errors.push({ shop, error: String(error?.message || "Unknown error") });
    }
  }

  return json({
    ok: errors.length === 0,
    attempted: shops.length,
    queued: queued.length,
    failed: errors.length,
    queuedJobs: queued,
    errors,
    config: { days, maxActions, applyActions, dateKey },
  });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
