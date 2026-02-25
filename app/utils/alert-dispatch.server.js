function getAlertWebhookUrl() {
  return String(process.env.ALERT_WEBHOOK_URL || process.env.DIGEST_WEBHOOK_URL || "").trim();
}

export async function dispatchMonitoringAlert(payload) {
  const webhookUrl = getAlertWebhookUrl();
  if (!webhookUrl) return { ok: false, reason: "ALERT_WEBHOOK_URL is not configured" };

  const body = {
    source: "netcash-monitoring",
    timestamp: new Date().toISOString(),
    ...payload,
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  return {
    ok: response.ok,
    status: response.status,
    body: text.slice(0, 500),
  };
}
