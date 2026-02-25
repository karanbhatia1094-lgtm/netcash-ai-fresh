import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getUniversalShopOverview } from "../utils/db.server";

export async function loader({ request }) {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const days = Math.max(7, Math.min(365, Number(url.searchParams.get("days") || 90)));
    const overview = await getUniversalShopOverview(session.shop, days);
    return json({ ok: true, shop: session.shop, overview }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ ok: false, error: error?.message || "Failed to load universal overview" }, { status: 500 });
  }
}
