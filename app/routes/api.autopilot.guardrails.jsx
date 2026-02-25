import { authenticate } from "../shopify.server";
import { listProfitGuardrailDecisions, listProfitGuardrailRuns, runProfitGuardrails } from "../utils/profit-guardrails.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

async function handleGet(request) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit") || 10)));
  const runId = String(url.searchParams.get("runId") || "").trim();

  const runs = await listProfitGuardrailRuns(session.shop, limit);
  const decisions = runId
    ? await listProfitGuardrailDecisions(runId, 200)
    : runs[0]?.id
      ? await listProfitGuardrailDecisions(runs[0].id, 200)
      : [];

  return json({
    ok: true,
    shop: session.shop,
    runs,
    selectedRunId: runId || runs[0]?.id || null,
    decisions,
  });
}

async function handlePost(request) {
  const { session } = await authenticate.admin(request);
  const contentType = String(request.headers.get("content-type") || "");
  let days = 30;
  let maxActions = 5;
  let applyActions = false;

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    days = Number(body?.days || 30);
    maxActions = Number(body?.maxActions || 5);
    applyActions = isTrue(body?.applyActions) || body?.mode === "apply";
  } else {
    const formData = await request.formData();
    days = Number(formData.get("days") || 30);
    maxActions = Number(formData.get("maxActions") || 5);
    applyActions = isTrue(formData.get("applyActions")) || formData.get("mode") === "apply";
  }

  const result = await runProfitGuardrails({
    shop: session.shop,
    days: Math.max(7, Math.min(365, days || 30)),
    maxActions: Math.max(1, Math.min(25, maxActions || 5)),
    applyActions,
  });

  const runs = await listProfitGuardrailRuns(session.shop, 10);
  const decisions = result?.runId ? await listProfitGuardrailDecisions(result.runId, 200) : [];
  return json({
    ok: true,
    result,
    runs,
    selectedRunId: result?.runId || runs[0]?.id || null,
    decisions,
  });
}

export async function loader({ request }) {
  return handleGet(request);
}

export async function action({ request }) {
  return handlePost(request);
}
