export function parseBool(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

export function parseTypes(value) {
  return String(value || "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
}

export function shouldAutoStartWorker(env = process.env) {
  const override = parseBool(env.AUTO_START_WORKER);
  if (override !== null) return override;
  return env.NODE_ENV === "production";
}

