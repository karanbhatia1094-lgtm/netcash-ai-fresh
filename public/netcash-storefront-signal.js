/* Netcash.ai storefront signal capture
 * Captures click IDs + UTM params as first-party state
 * and syncs them into Shopify cart attributes so they flow to order metadata.
 */
(function () {
  var STORAGE_KEY = "nc_signal_v1";
  var PUSH_MARKER_KEY = "nc_signal_push_marker_v1";
  var PUSH_COOLDOWN_MS = 30 * 60 * 1000;
  var CLICK_ID_KEYS = ["gclid", "fbclid", "ttclid", "msclkid", "li_fat_id"];
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "campaign_id"];
  var TIMING_KEYS = ["ad_seen_at", "message_opened_at", "whatsapp_opened_at", "sms_opened_at"];

  function safeParse(json) {
    try {
      return JSON.parse(json || "{}");
    } catch (_error) {
      return {};
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getCurrentParams() {
    var params = new URLSearchParams(window.location.search || "");
    var out = {};
    UTM_KEYS.concat(CLICK_ID_KEYS).concat(TIMING_KEYS).forEach(function (key) {
      var value = params.get(key);
      if (value) out[key] = value;
    });
    var msgChannel = params.get("message_channel") || params.get("channel");
    if (msgChannel) out.message_channel = msgChannel;
    return out;
  }

  function deriveTouchpoint(signal) {
    var source = signal.utm_source || "";
    var campaignId = signal.campaign_id || signal.utm_id || "";
    var campaignName = signal.utm_campaign || "";
    if (!source && !campaignId && !campaignName) return null;
    return {
      source: source || "unknown",
      campaignId: campaignId || null,
      campaignName: campaignName || null,
      occurredAt: nowIso(),
    };
  }

  function readState() {
    return safeParse(window.localStorage.getItem(STORAGE_KEY));
  }

  function writeState(state) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state || {}));
  }

  function mergeSignal(existing, incoming) {
    var next = Object.assign({}, existing || {});
    Object.keys(incoming || {}).forEach(function (key) {
      if (incoming[key]) next[key] = String(incoming[key]);
    });
    if (!next.landing_site) next.landing_site = window.location.href;
    if (!next.referring_site && document.referrer) next.referring_site = document.referrer;
    if (!next.first_seen_at) next.first_seen_at = nowIso();
    next.last_seen_at = nowIso();
    try {
      if (navigator && navigator.userAgent && !next.user_agent) next.user_agent = String(navigator.userAgent);
      if (navigator && navigator.platform && !next.device_platform) next.device_platform = String(navigator.platform);
    } catch {
      void 0;
    }
    if (!next.device_type) next.device_type = /Mobi|Android|iPhone|iPad/i.test(String(next.user_agent || "")) ? "mobile" : "desktop";
    if (!next.device_os) {
      var ua = String(next.user_agent || "").toLowerCase();
      next.device_os = ua.indexOf("android") >= 0 ? "android" : (ua.indexOf("iphone") >= 0 || ua.indexOf("ipad") >= 0 ? "ios" : "unknown");
    }
    return next;
  }

  function isPushDue() {
    var marker = safeParse(window.sessionStorage.getItem(PUSH_MARKER_KEY));
    var last = Number(marker.lastPushTs || 0);
    return !last || Date.now() - last > PUSH_COOLDOWN_MS;
  }

  function markPush(attrs) {
    window.sessionStorage.setItem(
      PUSH_MARKER_KEY,
      JSON.stringify({
        lastPushTs: Date.now(),
        attrsDigest: Object.keys(attrs || {}).sort().map(function (k) { return k + ":" + String(attrs[k] || ""); }).join("|"),
      }),
    );
  }

  function buildCartAttributes(signal) {
    if (!signal || typeof signal !== "object") return {};
    var attrs = {};
    UTM_KEYS.concat(CLICK_ID_KEYS).forEach(function (key) {
      if (signal[key]) attrs[key] = String(signal[key]);
    });
    if (signal.landing_site) attrs.landing_site = String(signal.landing_site);
    if (signal.referring_site) attrs.referring_site = String(signal.referring_site);
    if (signal.message_channel) attrs.message_channel = String(signal.message_channel);
    if (signal.ad_seen_at) attrs.ad_seen_at = String(signal.ad_seen_at);
    if (signal.message_opened_at) attrs.message_opened_at = String(signal.message_opened_at);
    if (signal.whatsapp_opened_at) attrs.whatsapp_opened_at = String(signal.whatsapp_opened_at);
    if (signal.sms_opened_at) attrs.sms_opened_at = String(signal.sms_opened_at);
    if (signal.user_agent) attrs.user_agent = String(signal.user_agent);
    if (signal.device_type) attrs.device_type = String(signal.device_type);
    if (signal.device_os) attrs.device_os = String(signal.device_os);
    if (signal.device_platform) attrs.device_platform = String(signal.device_platform);
    var touch = deriveTouchpoint(signal);
    if (touch) {
      attrs.netcash_touchpoints = JSON.stringify([touch]);
      attrs.touchpoint_pipe = [touch.source || "unknown", touch.campaignId || "", touch.campaignName || ""].join(":");
    }
    return attrs;
  }

  function pushToCartAttributes(attrs) {
    if (!attrs || Object.keys(attrs).length === 0) return Promise.resolve(false);
    return fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attributes: attrs }),
      credentials: "same-origin",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("cart attribute update failed");
        return response.json();
      })
      .then(function () {
        markPush(attrs);
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  function run() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (!window.localStorage || !window.sessionStorage || !window.fetch) return;

    var existing = readState();
    var incoming = getCurrentParams();
    var nextState = mergeSignal(existing, incoming);
    writeState(nextState);

    var attrs = buildCartAttributes(nextState);
    if (!isPushDue()) return;
    pushToCartAttributes(attrs);
  }

  run();
})();
