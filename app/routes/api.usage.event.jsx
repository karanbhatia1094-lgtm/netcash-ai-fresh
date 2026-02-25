import { authenticate } from "../shopify.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function action({ request }) {
  try {
    const { session } = await authenticate.admin(request);
    const body = await request.json().catch(() => ({}));
    const event = body?.event || {};
    const result = await recordFeatureUsageEvent(session.shop, event);
    return json({ ok: !!result?.ok });
  } catch {
    // Telemetry should not expose or break product flow.
    return json({ ok: false }, { status: 202 });
  }
}

export async function loader() {
  return json({ ok: true });
}
