import { listJobs } from "../utils/job-queue.server";
import { authenticate } from "../shopify.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Number(url.searchParams.get("limit") || 30);
  const jobs = await listJobs({ shop: session.shop, status, limit });
  return json({ ok: true, jobs });
}
