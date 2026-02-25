import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getStorefrontSignalDiagnostics } from "../utils/storefront-signal-diagnostics.server";

export async function loader({ request }) {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") || 30)));
    const diagnostics = await getStorefrontSignalDiagnostics(session.shop, days);
    return json({ ok: true, shop: session.shop, diagnostics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ ok: false, error: error?.message || "Failed to load diagnostics" }, { status: 500 });
  }
}
