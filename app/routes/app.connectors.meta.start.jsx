import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { buildMetaAuthUrl } from "../utils/connector-oauth.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const nextProvider = String(url.searchParams.get("next") || "");
  const returnTo = String(url.searchParams.get("returnTo") || "/app/integrations?wizard=1");
  await recordFeatureUsageEvent(session.shop, {
    featureKey: "connector_meta",
    eventName: "connector_oauth_start",
    path: "/app/connectors/meta/start",
    payload: { nextProvider, returnTo },
  }).catch(() => {});
  const authUrl = buildMetaAuthUrl(session.shop, { nextProvider, returnTo });
  return redirect(authUrl);
}
