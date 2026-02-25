export function trackUiEvent(eventName, payload = {}) {
  if (typeof window === "undefined") return;
  try {
    const entry = {
      event: eventName,
      payload,
      path: window.location.pathname + window.location.search,
      at: new Date().toISOString(),
    };
    const key = "nc_ui_events";
    const current = JSON.parse(window.localStorage.getItem(key) || "[]");
    const next = Array.isArray(current) ? [...current.slice(-199), entry] : [entry];
    window.localStorage.setItem(key, JSON.stringify(next));
    const body = JSON.stringify({ event: entry });
    if (navigator?.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/usage/event", blob);
    } else {
      fetch("/api/usage/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
    if (typeof console !== "undefined" && console.info) console.info("[nc-ui-event]", entry);
  } catch {
    // no-op
  }
}
