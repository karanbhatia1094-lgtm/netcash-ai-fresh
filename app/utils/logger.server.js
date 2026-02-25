function baseLog(level, event, payload = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
  const message = JSON.stringify(line);
  if (level === "error") {
    console.error(message);
  } else {
    console.log(message);
  }
}

export function logInfo(event, payload = {}) {
  baseLog("info", event, payload);
}

export function logWarn(event, payload = {}) {
  baseLog("warn", event, payload);
}

export function logError(event, payload = {}) {
  baseLog("error", event, payload);
}
