import { authenticate } from "../shopify.server";
import { resolveShopConfig } from "../utils/release-control.server";

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
  const config = await resolveShopConfig(session.shop, {});
  return json({
    ok: true,
    shop: session.shop,
    config,
  });
}
