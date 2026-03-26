export function isDevPreviewEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  const raw = String(process.env.DEV_PREVIEW_MODE || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}
