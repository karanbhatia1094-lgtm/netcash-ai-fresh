import { json } from "@remix-run/node";
import { ingestUniversalSignalEvents } from "../utils/db.server";
import { enforceRateLimit } from "../utils/rate-limit.server";

function isAuthorized(request) {
  const required = process.env.ATTRIBUTION_API_KEY;
  if (!required) return true;
  const provided = request.headers.get("x-netcash-api-key") || "";
  return provided === required;
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  const rateLimited = enforceRateLimit(request, { key: "api:universal_signals", limit: 300, windowMs: 60_000 });
  if (rateLimited) return rateLimited;
  if (!isAuthorized(request)) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const shop = String(payload?.shop || "").trim();
  if (!shop) {
    return json({ ok: false, error: "shop is required" }, { status: 400 });
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length === 0) {
    return json({ ok: false, error: "events[] is required" }, { status: 400 });
  }

  const result = await ingestUniversalSignalEvents(shop, events);
  return json({ ok: true, shop, ...result });
}

export async function loader() {
  return json({
    ok: true,
    endpoint: "/api/universal-signals",
    method: "POST",
    authHeader: "x-netcash-api-key (if ATTRIBUTION_API_KEY is set)",
    sample: {
      shop: "example.myshopify.com",
      events: [
        {
          eventType: "message_open",
          eventAt: "2026-02-21T12:30:00.000Z",
          source: "whatsapp",
          campaignId: "flow_001",
          campaignName: "Recovery Flow",
          customerEmail: "user@example.com",
          clickId: "fbclid_xxx",
          messageChannel: "whatsapp",
          messageOpenedAt: "2026-02-21T12:30:00.000Z",
          deviceType: "mobile",
          osName: "android",
          handsetBrand: "Samsung",
          handsetModel: "S23",
          metadata: { provider: "moengage" },
        },
      ],
    },
  });
}
