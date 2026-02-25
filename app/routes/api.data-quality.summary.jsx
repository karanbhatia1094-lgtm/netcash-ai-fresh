import { authenticate } from "../shopify.server";
import { getDataQualitySummary } from "../utils/db.server";

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
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || 30)));
  const summary = await getDataQualitySummary(session.shop, days);
  return json({ ok: true, ...summary });
}
