import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  ensureDeliveryOmsTables,
  upsertOmsStatus,
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
  const record = await upsertOmsStatus(payload);
  return json({ ok: true, record });
}

export async function loader() {
  return json({
    ok: true,
    endpoint: "/api/oms/ingest",
    auth: "x-netcash-ingest-key (optional if NETCASH_INGEST_KEY is unset)",
    example: {
      shop: "netcash-dev-store-2.myshopify.com",
      provider: "unicommerce",
      orderId: "1234567890",
      orderNumber: "#1001",
      status: "packed",
      subStatus: "ready_to_ship",
      fulfillmentStatus: "partially_fulfilled",
      lastEventAt: "2026-03-11T08:10:00Z",
    },
  });
}
