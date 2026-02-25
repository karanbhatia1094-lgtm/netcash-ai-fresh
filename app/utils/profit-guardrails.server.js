import crypto from "node:crypto";
import { prisma } from "../../prisma.client.js";
import { createCampaignActionItem, getCampaignPerformance, getDataQualitySummary, getRecentConnectorSyncRuns } from "./db.server";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export async function ensureProfitGuardrailTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS profit_guardrail_run (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      days INTEGER NOT NULL DEFAULT 30,
      mode TEXT NOT NULL DEFAULT 'dry_run',
      status TEXT NOT NULL DEFAULT 'completed',
      confidence_score REAL NOT NULL DEFAULT 0,
      summary_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS profit_guardrail_decision (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      shop TEXT NOT NULL,
      source TEXT,
      campaign_id TEXT,
      campaign_name TEXT,
      severity TEXT NOT NULL,
      confidence_score REAL NOT NULL DEFAULT 0,
      recommendation_type TEXT NOT NULL,
      recommendation_text TEXT NOT NULL,
      rollback_text TEXT,
      expected_impact_text TEXT,
      action_item_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_profit_guardrail_run_shop_created ON profit_guardrail_run(shop, created_at)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS idx_profit_guardrail_decision_run_created ON profit_guardrail_decision(run_id, created_at)",
  );
}

function scoreDataConfidence({ mappedOrdersPct = 0, invalidRows = 0, missingSpendRows = 0, syncLagMinutes = null }) {
  const mappedScore = Math.max(0, Math.min(100, Number(mappedOrdersPct || 0)));
  const invalidPenalty = Math.min(40, Number(invalidRows || 0) * 3);
  const spendPenalty = Math.min(30, Number(missingSpendRows || 0) * 2);
  const syncPenalty = syncLagMinutes == null ? 12 : Math.min(25, Math.max(0, Math.floor((Number(syncLagMinutes) - 60) / 30)));
  const score = Math.max(0, Math.min(100, mappedScore - invalidPenalty - spendPenalty - syncPenalty + 20));
  return score;
}

function severityFromRow(row) {
  const realRoas = Number(row?.realRoas || 0);
  const netCash = Number(row?.netCash || 0);
  if (netCash < 0 || realRoas < 0.8) return "high";
  if (realRoas < 1.1) return "medium";
  return "low";
}

function buildDecision(row, confidenceScore) {
  const realRoas = Number(row.realRoas || 0);
  const netCash = Number(row.netCash || 0);
  const source = String(row.source || "unknown");
  const campaignName = row.campaignName || row.campaignId || "Unmapped campaign";
  const severity = severityFromRow(row);

  if (realRoas < 0.8 || netCash < 0) {
    return {
      source,
      campaignId: row.campaignId || null,
      campaignName: row.campaignName || null,
      severity,
      confidenceScore,
      recommendationType: "throttle",
      recommendationText: `Throttle ${campaignName} (${source}) spend by 30% for 48h and monitor net-cash recovery.`,
      rollbackText: "If real ROAS recovers above 1.2x and net cash is positive for 2 days, restore previous budget.",
      expectedImpactText: "Reduce avoidable burn while preserving signal for re-optimization.",
      priority: "high",
    };
  }

  if (realRoas >= 2 && netCash > 0 && confidenceScore >= 70) {
    return {
      source,
      campaignId: row.campaignId || null,
      campaignName: row.campaignName || null,
      severity: "low",
      confidenceScore,
      recommendationType: "scale",
      recommendationText: `Scale ${campaignName} (${source}) budget by 10% with daily guardrails.`,
      rollbackText: "If real ROAS drops below 1.5x for 24h, revert to previous budget.",
      expectedImpactText: "Capture incremental net-cash upside from stable, high-efficiency campaigns.",
      priority: "medium",
    };
  }

  return null;
}

function buildSourceImpact(rows = [], decisions = []) {
  const sourceTotals = new Map();
  const campaignAction = new Map();

  for (const decision of decisions || []) {
    const key = `${String(decision.source || "unknown").toLowerCase()}|${String(decision.campaignId || decision.campaignName || "").toLowerCase()}`;
    campaignAction.set(key, decision.recommendationType);
  }

  for (const row of rows || []) {
    const source = String(row.source || "unknown").toLowerCase();
    const sourceRow = sourceTotals.get(source) || {
      source,
      beforeNetCash: 0,
      afterNetCash: 0,
      deltaNetCash: 0,
      campaignsImpacted: 0,
      throttleCount: 0,
      scaleCount: 0,
    };
    const currentNetCash = Number(row.netCash || 0);
    sourceRow.beforeNetCash += currentNetCash;

    const campaignKey = `${source}|${String(row.campaignId || row.campaignName || "").toLowerCase()}`;
    const action = campaignAction.get(campaignKey);
    let projected = currentNetCash;
    if (action === "throttle") {
      sourceRow.campaignsImpacted += 1;
      sourceRow.throttleCount += 1;
      projected = currentNetCash < 0 ? currentNetCash * 0.7 : currentNetCash * 0.9;
    } else if (action === "scale") {
      sourceRow.campaignsImpacted += 1;
      sourceRow.scaleCount += 1;
      projected = currentNetCash > 0 ? currentNetCash * 1.1 : currentNetCash;
    }

    sourceRow.afterNetCash += projected;
    sourceTotals.set(source, sourceRow);
  }

  return [...sourceTotals.values()]
    .map((row) => ({
      ...row,
      deltaNetCash: row.afterNetCash - row.beforeNetCash,
    }))
    .sort((a, b) => Math.abs(b.deltaNetCash) - Math.abs(a.deltaNetCash));
}

async function insertRun({
  id,
  shop,
  days,
  mode,
  status,
  confidenceScore,
  summary,
  errorMessage = null,
}) {
  await ensureProfitGuardrailTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO profit_guardrail_run
      (id, shop, days, mode, status, confidence_score, summary_json, error_message, created_at)
     VALUES
      (${sqlQuote(id)}, ${sqlQuote(shop)}, ${Math.max(1, Number(days) || 30)}, ${sqlQuote(mode)},
       ${sqlQuote(status)}, ${Number(confidenceScore || 0)}, ${sqlQuote(safeJsonStringify(summary))},
       ${sqlQuote(errorMessage)}, ${sqlQuote(new Date().toISOString())})`,
  );
}

async function insertDecision({
  runId,
  shop,
  decision,
  actionItemId = null,
}) {
  await ensureProfitGuardrailTables();
  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO profit_guardrail_decision
      (id, run_id, shop, source, campaign_id, campaign_name, severity, confidence_score,
       recommendation_type, recommendation_text, rollback_text, expected_impact_text, action_item_id, created_at)
     VALUES
      (${sqlQuote(id)}, ${sqlQuote(runId)}, ${sqlQuote(shop)}, ${sqlQuote(decision.source)},
       ${sqlQuote(decision.campaignId)}, ${sqlQuote(decision.campaignName)}, ${sqlQuote(decision.severity)},
       ${Number(decision.confidenceScore || 0)}, ${sqlQuote(decision.recommendationType)},
       ${sqlQuote(decision.recommendationText)}, ${sqlQuote(decision.rollbackText)},
       ${sqlQuote(decision.expectedImpactText)}, ${sqlQuote(actionItemId)}, ${sqlQuote(new Date().toISOString())})`,
  );
}

export async function runProfitGuardrails({
  shop,
  days = 30,
  applyActions = false,
  maxActions = 5,
} = {}) {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) throw new Error("shop is required");
  const safeDays = Math.max(7, Math.min(365, Number(days) || 30));
  const safeMaxActions = Math.max(1, Math.min(25, Number(maxActions) || 5));
  const runId = crypto.randomUUID();
  const mode = applyActions ? "apply" : "dry_run";

  try {
    const [campaign, quality, syncRuns] = await Promise.all([
      getCampaignPerformance(safeShop, safeDays, "all"),
      getDataQualitySummary(safeShop, safeDays),
      getRecentConnectorSyncRuns(safeShop, 20),
    ]);

    const latestSync = (syncRuns || [])[0] || null;
    const syncLagMinutes = latestSync?.createdAt
      ? Math.max(0, Math.round((Date.now() - new Date(latestSync.createdAt).getTime()) / 60000))
      : null;
    const confidenceScore = scoreDataConfidence({
      mappedOrdersPct: quality?.totals?.mappedOrdersPct || 0,
      invalidRows: quality?.totals?.invalidRows || 0,
      missingSpendRows: quality?.totals?.missingSpendRows || 0,
      syncLagMinutes,
    });

    const rows = Array.isArray(campaign?.rows) ? campaign.rows : [];
    const decisions = rows
      .map((row) => buildDecision(row, confidenceScore))
      .filter(Boolean)
      .slice(0, safeMaxActions);

    let applied = 0;
    const savedDecisions = [];
    for (const decision of decisions) {
      let actionItem = null;
      if (applyActions && confidenceScore >= 60) {
        // eslint-disable-next-line no-await-in-loop
        actionItem = await createCampaignActionItem(safeShop, {
          source: decision.source,
          campaignId: decision.campaignId,
          campaignName: decision.campaignName,
          priority: decision.priority || "medium",
          reason: `[Autopilot][Confidence ${Math.round(confidenceScore)}] ${decision.recommendationType.toUpperCase()}`,
          recommendedAction: `${decision.recommendationText} Rollback: ${decision.rollbackText}`,
        });
        if (actionItem?.id != null) applied += 1;
      }

      // eslint-disable-next-line no-await-in-loop
      await insertDecision({
        runId,
        shop: safeShop,
        decision,
        actionItemId: actionItem?.id ? String(actionItem.id) : null,
      });
      savedDecisions.push({
        ...decision,
        actionItemId: actionItem?.id ?? null,
      });
    }

    const summary = {
      confidenceScore,
      decisions: savedDecisions.length,
      applied,
      sourceImpact: buildSourceImpact(rows, savedDecisions),
      quality: {
        mappedOrdersPct: Number(quality?.totals?.mappedOrdersPct || 0),
        invalidRows: Number(quality?.totals?.invalidRows || 0),
        missingSpendRows: Number(quality?.totals?.missingSpendRows || 0),
        syncLagMinutes,
      },
      mode,
      days: safeDays,
    };

    await insertRun({
      id: runId,
      shop: safeShop,
      days: safeDays,
      mode,
      status: "completed",
      confidenceScore,
      summary,
    });

    return {
      ok: true,
      runId,
      ...summary,
      decisionRows: savedDecisions,
    };
  } catch (error) {
    const message = String(error?.message || "Unknown guardrail error");
    await insertRun({
      id: runId,
      shop: safeShop,
      days: safeDays,
      mode,
      status: "failed",
      confidenceScore: 0,
      summary: { mode, days: safeDays },
      errorMessage: message,
    });
    throw error;
  }
}

export async function listProfitGuardrailRuns(shop, limit = 20) {
  await ensureProfitGuardrailTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, shop, days, mode, status, confidence_score as confidenceScore, summary_json as summaryJson,
            error_message as errorMessage, created_at as createdAt
     FROM profit_guardrail_run
     WHERE shop = ${sqlQuote(safeShop)}
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );
  return (rows || []).map((row) => ({
    ...row,
    summary: safeJson(row.summaryJson, {}),
  }));
}

export async function listProfitGuardrailDecisions(runId, limit = 50) {
  await ensureProfitGuardrailTables();
  const safeRunId = String(runId || "").trim();
  if (!safeRunId) return [];
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, run_id as runId, shop, source, campaign_id as campaignId, campaign_name as campaignName, severity,
            confidence_score as confidenceScore, recommendation_type as recommendationType,
            recommendation_text as recommendationText, rollback_text as rollbackText,
            expected_impact_text as expectedImpactText, action_item_id as actionItemId, created_at as createdAt
     FROM profit_guardrail_decision
     WHERE run_id = ${sqlQuote(safeRunId)}
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
  );
  return rows || [];
}

export async function getProfitGuardrailDecisionById(shop, decisionId) {
  await ensureProfitGuardrailTables();
  const safeShop = String(shop || "").trim().toLowerCase();
  const safeDecisionId = String(decisionId || "").trim();
  if (!safeShop || !safeDecisionId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, run_id as runId, shop, source, campaign_id as campaignId, campaign_name as campaignName, severity,
            confidence_score as confidenceScore, recommendation_type as recommendationType,
            recommendation_text as recommendationText, rollback_text as rollbackText,
            expected_impact_text as expectedImpactText, action_item_id as actionItemId, created_at as createdAt
     FROM profit_guardrail_decision
     WHERE id = ${sqlQuote(safeDecisionId)} AND shop = ${sqlQuote(safeShop)}
     LIMIT 1`,
  );
  return rows?.[0] || null;
}
