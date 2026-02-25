import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { buildGoogleAuthUrl } from "../utils/connector-oauth.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const nextProvider = String(url.searchParams.get("next") || "");
  const returnTo = String(url.searchParams.get("returnTo") || "/app/integrations?wizard=1");
  await recordFeatureUsageEvent(session.shop, {
    featureKey: "connector_google",
    eventName: "connector_oauth_start",
    path: "/app/connectors/google/start",
    payload: { nextProvider, returnTo },
  }).catch(() => {});
  const authUrl = buildGoogleAuthUrl(session.shop, { nextProvider, returnTo });
  return redirect(authUrl);
}
