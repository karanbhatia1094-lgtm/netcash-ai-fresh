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
  return process.env.TRUTH_CRON_KEY || process.env.CONNECTOR_CRON_KEY || process.env.JOB_WORKER_KEY || "";
}

function authorize(request) {
  const expected = getCronKey();
  if (!expected) return { ok: false, reason: "TRUTH_CRON_KEY or CONNECTOR_CRON_KEY or JOB_WORKER_KEY is required" };
  const provided = request.headers.get("x-netcash-cron-key") || "";
  if (provided !== expected) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

async function run(request) {
  const auth = authorize(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, { status: auth.reason === "Unauthorized" ? 401 : 500 });

  const url = new URL(request.url);
  const days = Math.max(7, Math.min(3650, Number(url.searchParams.get("days") || 90)));
  const maxShops = Math.max(1, Math.min(500, Number(url.searchParams.get("maxShops") || 100)));
  const singleShop = String(url.searchParams.get("shop") || "").trim().toLowerCase();

  const shops = singleShop
    ? [{ shop: singleShop }]
    : await prisma.netCashOrder.groupBy({
      by: ["shop"],
      orderBy: { shop: "asc" },
      take: maxShops,
    });

  const queued = [];
  const errors = [];
  for (const row of shops) {
    const shop = String(row.shop || "").toLowerCase();
    try {
      // eslint-disable-next-line no-await-in-loop
      const job = await enqueueJob({
        type: "truth_rollup_refresh",
        shop,
        payload: { shop, days },
        uniqueKey: `truth_rollup_refresh:${shop}`,
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
  });
}

export async function loader({ request }) {
  return run(request);
}

export async function action({ request }) {
  return run(request);
}
