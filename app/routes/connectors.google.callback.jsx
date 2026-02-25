import { redirect } from "@remix-run/node";
import { handleGoogleCallback } from "../utils/connector-oauth.server";
import { runConnectorSync } from "../utils/connector-sync.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const fallbackReturnTo = "/app/integrations?wizard=1";
    if (url.searchParams.get("error")) {
      const reason = url.searchParams.get("error_description") || url.searchParams.get("error");
      await recordFeatureUsageEvent("unknown", {
        featureKey: "connector_google",
        eventName: "connector_oauth_fail",
        path: "/connectors/google/callback",
        payload: { reason },
      }).catch(() => {});
      return redirect(`${fallbackReturnTo}&oauthError=${encodeURIComponent(reason || "Google authorization failed")}`);
    }
    const result = await handleGoogleCallback(url);
    await recordFeatureUsageEvent(result.shop, {
      featureKey: "connector_google",
      eventName: "connector_oauth_success",
      path: "/connectors/google/callback",
    }).catch(() => {});
    try {
      await runConnectorSync({ provider: "google_ads", shop: result.shop, days: 30 });
      await recordFeatureUsageEvent(result.shop, {
        featureKey: "connector_google",
        eventName: "connector_oauth_sync_success",
        path: "/connectors/google/callback",
      }).catch(() => {});
    } catch (syncError) {
      console.error("Google auto-sync after OAuth failed:", syncError);
      await recordFeatureUsageEvent(result.shop, {
        featureKey: "connector_google",
        eventName: "connector_oauth_sync_fail",
        path: "/connectors/google/callback",
        payload: { error: syncError?.message || "sync_failed" },
      }).catch(() => {});
    }
    if (result.nextProvider === "meta_ads") {
      return redirect(`/app/connectors/meta/start?returnTo=${encodeURIComponent(result.returnTo || fallbackReturnTo)}`);
    }
    const returnTo = result.returnTo || fallbackReturnTo;
    const joiner = returnTo.includes("?") ? "&" : "?";
    return redirect(`${returnTo}${joiner}oauth=google_connected&shop=${encodeURIComponent(result.shop)}`);
  } catch (error) {
    await recordFeatureUsageEvent("unknown", {
      featureKey: "connector_google",
      eventName: "connector_oauth_fail",
      path: "/connectors/google/callback",
      payload: { error: error?.message || "callback_failed" },
    }).catch(() => {});
    return redirect(`/app/integrations?wizard=1&oauthError=${encodeURIComponent(error?.message || "Google callback failed")}`);
  }
}
