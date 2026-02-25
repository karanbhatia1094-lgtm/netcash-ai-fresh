import { Form, useActionData, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { createCampaignActionItem } from "../utils/db.server";
import {
  getProfitGuardrailDecisionById,
  listProfitGuardrailDecisions,
  listProfitGuardrailRuns,
  runProfitGuardrails,
} from "../utils/profit-guardrails.server";

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedRunId = String(url.searchParams.get("runId") || "").trim();
  const runs = await listProfitGuardrailRuns(session.shop, 12);
  const runId = selectedRunId || runs[0]?.id || "";
  const decisions = runId ? await listProfitGuardrailDecisions(runId, 200) : [];
  return {
    shop: session.shop,
    runs,
    selectedRunId: runId || null,
    decisions,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "run");

  if (intent === "create-rollback") {
    const decisionId = String(formData.get("decisionId") || "").trim();
    const decision = await getProfitGuardrailDecisionById(session.shop, decisionId);
    if (!decision) {
      return { ok: false, error: "Decision not found for this shop." };
    }
    const rollbackAction = await createCampaignActionItem(session.shop, {
      source: decision.source || "unknown",
      campaignId: decision.campaignId || null,
      campaignName: decision.campaignName || null,
      priority: "high",
      reason: `[Autopilot Rollback] ${String(decision.recommendationType || "action").toUpperCase()}`,
      recommendedAction: decision.rollbackText || "Revert to previous budget/bid baseline and monitor for 24h.",
    });
    const runs = await listProfitGuardrailRuns(session.shop, 12);
    const runId = String(decision.runId || runs[0]?.id || "");
    const decisions = runId ? await listProfitGuardrailDecisions(runId, 200) : [];
    return {
      ok: true,
      rollbackCreated: !!rollbackAction?.id,
      rollbackActionId: rollbackAction?.id || null,
      result: null,
      runs,
      selectedRunId: runId || null,
      decisions,
    };
  }

  const days = Math.max(7, Math.min(365, Number(formData.get("days") || 30)));
  const maxActions = Math.max(1, Math.min(25, Number(formData.get("maxActions") || 5)));
  const mode = String(formData.get("mode") || "dry_run");
  const applyActions = mode === "apply" || isTrue(formData.get("applyActions"));

  const result = await runProfitGuardrails({
    shop: session.shop,
    days,
    maxActions,
    applyActions,
  });

  const runs = await listProfitGuardrailRuns(session.shop, 12);
  const runId = result?.runId || runs[0]?.id || "";
  const decisions = runId ? await listProfitGuardrailDecisions(runId, 200) : [];
  return { ok: true, result, runs, selectedRunId: runId || null, decisions };
}

export default function AutopilotPage() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const data = actionData?.ok ? actionData : loaderData;
  const latestSummary = data?.runs?.[0]?.summary || {};
  const quality = latestSummary?.quality || {};
  const sourceImpact = Array.isArray(latestSummary?.sourceImpact) ? latestSummary.sourceImpact : [];

  return (
    <div className="nc-shell">
      <h1>Profit Guardrails Autopilot</h1>
      <p className="nc-subtitle">
        Confidence-scored throttle/scale recommendations for {data.shop}. Start with dry run, then apply on high-confidence windows.
      </p>

      <div className="nc-grid-3">
        <div className="nc-kpi-card">
          <div className="nc-muted">Latest Confidence</div>
          <div className="nc-kpi-value">{Math.round(Number(latestSummary?.confidenceScore || 0))}/100</div>
        </div>
        <div className="nc-kpi-card">
          <div className="nc-muted">% Mapped Orders</div>
          <div className="nc-kpi-value">{pct(quality?.mappedOrdersPct || 0)}</div>
        </div>
        <div className="nc-kpi-card">
          <div className="nc-muted">Sync Lag (minutes)</div>
          <div className="nc-kpi-value">{Number(quality?.syncLagMinutes ?? 0)}</div>
        </div>
      </div>

      <div className="nc-card nc-section" style={{ marginTop: "14px" }}>
        <h2>Run Guardrails</h2>
        <Form method="post" className="nc-form-row">
          <label className="nc-form-field">
            <span>Lookback days</span>
            <input name="days" type="number" min={7} max={365} defaultValue={30} />
          </label>
          <label className="nc-form-field">
            <span>Max actions</span>
            <input name="maxActions" type="number" min={1} max={25} defaultValue={5} />
          </label>
          <label className="nc-form-field">
            <span>Mode</span>
            <select name="mode" defaultValue="dry_run">
              <option value="dry_run">Dry run</option>
              <option value="apply">Apply (create action items)</option>
            </select>
          </label>
          <button type="submit">Run Autopilot</button>
        </Form>
      </div>

      <div className="nc-grid-2" style={{ marginTop: "14px" }}>
        <section className="nc-card nc-section">
          <h2>Recent Runs</h2>
          {(data.runs || []).length === 0 ? <p className="nc-muted">No runs yet.</p> : (
            <div className="nc-table-wrap">
              <table className="nc-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>Confidence</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.runs || []).map((run) => (
                    <tr key={run.id}>
                      <td>{new Date(run.createdAt).toLocaleString()}</td>
                      <td>{run.mode}</td>
                      <td>{run.status}</td>
                      <td>{Math.round(Number(run.confidenceScore || 0))}</td>
                      <td>{Number(run?.summary?.applied || 0)} / {Number(run?.summary?.decisions || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="nc-card nc-section">
          <h2>Quality Signals</h2>
          <div className="nc-grid-2">
            <div className="nc-soft-box">
              <strong>Invalid IDs</strong>
              <p style={{ marginBottom: 0 }}>{Number(quality?.invalidRows || 0)}</p>
            </div>
            <div className="nc-soft-box">
              <strong>Missing Spend Rows</strong>
              <p style={{ marginBottom: 0 }}>{Number(quality?.missingSpendRows || 0)}</p>
            </div>
          </div>
        </section>
      </div>

      <div className="nc-card nc-section" style={{ marginTop: "14px" }}>
        <h2>Autopilot Impact (Estimated)</h2>
        <p className="nc-muted">Source-level before/after net cash based on latest run recommendations.</p>
        {sourceImpact.length === 0 ? <p className="nc-muted">No impact estimate available yet.</p> : (
          <div className="nc-table-wrap">
            <table className="nc-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Before Net Cash</th>
                  <th>After Net Cash</th>
                  <th>Delta</th>
                  <th>Throttle</th>
                  <th>Scale</th>
                </tr>
              </thead>
              <tbody>
                {sourceImpact.map((row) => (
                  <tr key={row.source}>
                    <td>{row.source}</td>
                    <td>{Number(row.beforeNetCash || 0).toLocaleString()}</td>
                    <td>{Number(row.afterNetCash || 0).toLocaleString()}</td>
                    <td>{Number(row.deltaNetCash || 0).toLocaleString()}</td>
                    <td>{Number(row.throttleCount || 0)}</td>
                    <td>{Number(row.scaleCount || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="nc-card nc-section" style={{ marginTop: "14px" }}>
        <h2>Recommendations</h2>
        {actionData?.rollbackCreated ? (
          <p className="nc-success">Rollback action item created (ID: {String(actionData.rollbackActionId)}).</p>
        ) : null}
        {actionData?.ok === false && actionData?.error ? (
          <p className="nc-danger">{actionData.error}</p>
        ) : null}
        {(data.decisions || []).length === 0 ? <p className="nc-muted">No recommendations for selected run.</p> : (
          <div className="nc-table-wrap">
            <table className="nc-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Campaign</th>
                  <th>Source</th>
                  <th>Recommendation</th>
                  <th>Rollback</th>
                  <th>Impact</th>
                  <th>Action Item</th>
                  <th>Rollback Action</th>
                </tr>
              </thead>
              <tbody>
                {(data.decisions || []).map((row) => (
                  <tr key={row.id}>
                    <td>{row.severity}</td>
                    <td>{row.campaignName || row.campaignId || "Unmapped campaign"}</td>
                    <td>{row.source || "unknown"}</td>
                    <td>{row.recommendationText}</td>
                    <td>{row.rollbackText || "-"}</td>
                    <td>{row.expectedImpactText || "-"}</td>
                    <td>{row.actionItemId || "-"}</td>
                    <td>
                      {row.rollbackText ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="create-rollback" />
                          <input type="hidden" name="decisionId" value={row.id} />
                          <button type="submit">Create Rollback</button>
                        </Form>
                      ) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Unexpected error");
  return (
    <div className="nc-shell">
      <h1>Autopilot unavailable</h1>
      <p className="nc-subtitle">{message}</p>
    </div>
  );
}
