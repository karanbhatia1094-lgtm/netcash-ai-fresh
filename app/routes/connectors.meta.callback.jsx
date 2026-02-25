import { redirect } from "@remix-run/node";
import { handleMetaCallback } from "../utils/connector-oauth.server";
import { runConnectorSync } from "../utils/connector-sync.server";
import { recordFeatureUsageEvent } from "../utils/feature-usage.server";

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const fallbackReturnTo = "/app/integrations?wizard=1";
    if (url.searchParams.get("error")) {
      const reason = url.searchParams.get("error_description") || url.searchParams.get("error");
      await recordFeatureUsageEvent("unknown", {
        featureKey: "connector_meta",
        eventName: "connector_oauth_fail",
        path: "/connectors/meta/callback",
        payload: { reason },
      }).catch(() => {});
      return redirect(`${fallbackReturnTo}&oauthError=${encodeURIComponent(reason || "Meta authorization failed")}`);
    }
    const result = await handleMetaCallback(url);
    await recordFeatureUsageEvent(result.shop, {
      featureKey: "connector_meta",
      eventName: "connector_oauth_success",
      path: "/connectors/meta/callback",
    }).catch(() => {});
    try {
      await runConnectorSync({ provider: "meta_ads", shop: result.shop, days: 30 });
      await recordFeatureUsageEvent(result.shop, {
        featureKey: "connector_meta",
        eventName: "connector_oauth_sync_success",
        path: "/connectors/meta/callback",
      }).catch(() => {});
    } catch (syncError) {
      console.error("Meta auto-sync after OAuth failed:", syncError);
      await recordFeatureUsageEvent(result.shop, {
        featureKey: "connector_meta",
        eventName: "connector_oauth_sync_fail",
        path: "/connectors/meta/callback",
        payload: { error: syncError?.message || "sync_failed" },
      }).catch(() => {});
    }
    if (result.nextProvider === "google_ads") {
      return redirect(`/app/connectors/google/start?returnTo=${encodeURIComponent(result.returnTo || fallbackReturnTo)}`);
    }
    const returnTo = result.returnTo || fallbackReturnTo;
    const joiner = returnTo.includes("?") ? "&" : "?";
    return redirect(`${returnTo}${joiner}oauth=meta_connected&shop=${encodeURIComponent(result.shop)}`);
  } catch (error) {
    await recordFeatureUsageEvent("unknown", {
      featureKey: "connector_meta",
      eventName: "connector_oauth_fail",
      path: "/connectors/meta/callback",
      payload: { error: error?.message || "callback_failed" },
    }).catch(() => {});
    return redirect(`/app/integrations?wizard=1&oauthError=${encodeURIComponent(error?.message || "Meta callback failed")}`);
  }
}
