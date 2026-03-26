import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  ensureDeliveryOmsTables,
  upsertDeliveryShipment,
} from "../utils/delivery-oms.server";

function getIngestKey(request) {
  return request.headers.get("x-netcash-ingest-key") || request.headers.get("x-netcash-webhook-key");
}

async function allowRequest(request) {
  const configured = String(process.env.NETCASH_INGEST_KEY || "").trim();
  const provided = String(getIngestKey(request) || "").trim();
  if (configured) {
    return configured === provided;
  }
  try {
    await authenticate.admin(request);
    return true;
  } catch (error) {
    return false;
  }
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, { status: 405 });
  }
  const allowed = await allowRequest(request);
  if (!allowed) {
    return json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }
  await ensureDeliveryOmsTables();
  const record = await upsertDeliveryShipment(payload);
  return json({ ok: true, record });
}

export async function loader() {
  return json({
    ok: true,
    endpoint: "/api/delivery/ingest",
    auth: "x-netcash-ingest-key (optional if NETCASH_INGEST_KEY is unset)",
    example: {
      shop: "netcash-dev-store-2.myshopify.com",
      provider: "shiprocket",
      orderId: "1234567890",
      orderNumber: "#1001",
      awb: "SR123456",
      status: "in_transit",
      statusDetail: "Arrived at hub",
      attemptCount: 1,
      deliveredAt: null,
      rtoStatus: null,
      events: [
        { event: "Picked", eventAt: "2026-03-10T07:10:00Z", location: "Delhi" },
        { event: "In Transit", eventAt: "2026-03-11T09:45:00Z", location: "Jaipur" },
      ],
    },
  });
}
