import { authenticate } from "../shopify.server";
import { getCampaignPerformance, getCampaignUserInsights } from "../utils/db.server";

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
  const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days") || 30)));
  const source = String(url.searchParams.get("sources") || url.searchParams.get("source") || "all");
  const limit = Math.max(10, Math.min(500, Number(url.searchParams.get("limit") || 100)));

  const campaign = await getCampaignPerformance(session.shop, days, source);
  const users = await getCampaignUserInsights(session.shop, days, source, limit);
  return json({
    ok: true,
    shop: session.shop,
    days,
    sources: source,
    campaignRows: campaign.rows,
    userRows: users,
  });
}
