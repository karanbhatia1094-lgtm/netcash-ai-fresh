const EMBEDDED_PASSTHROUGH_KEYS = [
  "embedded",
  "host",
  "shop",
  "hmac",
  "session",
  "id_token",
  "timestamp",
  "locale",
];

export function buildEmbeddedPassthrough(search) {
  const params = new URLSearchParams(search || "");
  const passthrough = new URLSearchParams();
  for (const key of EMBEDDED_PASSTHROUGH_KEYS) {
    const value = params.get(key);
    if (value) passthrough.set(key, value);
  }
  return passthrough.toString();
}

export function getEmbeddedPassthrough(search) {
  const direct = buildEmbeddedPassthrough(search);
  if (typeof window === "undefined") return direct;
  if (direct && (direct.includes("host=") || direct.includes("embedded="))) {
    window.sessionStorage.setItem("nc_embedded_passthrough", direct);
    return direct;
  }
  return String(window.sessionStorage.getItem("nc_embedded_passthrough") || "");
}

export function withEmbeddedContext(href, passthroughQuery) {
  const value = String(href || "/app");
  if (!passthroughQuery) return value;
  const merged = new URL(value, "https://netcash.local");
  const passthrough = new URLSearchParams(passthroughQuery);
  for (const [key, rawValue] of passthrough.entries()) {
    if (!merged.searchParams.has(key)) {
      merged.searchParams.set(key, rawValue);
    }
  }
  const query = merged.searchParams.toString();
  return `${merged.pathname}${query ? `?${query}` : ""}${merged.hash || ""}`;
}
