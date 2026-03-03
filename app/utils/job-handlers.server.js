import { runConnectorSync } from "./connector-sync.server";
import { runDueScheduledReports } from "./report-scheduler.server";
import { refreshOwnerDailyRollups } from "./owner-rollups.server";
import { syncOrdersForShop } from "./order-sync.server";
import { refreshNetcashTruthRollups } from "./netcash-truth.server";
import { runProfitGuardrails } from "./profit-guardrails.server";

export const jobHandlers = {
  connector_sync: async (job) => {
    const provider = String(job.payload?.provider || "");
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 7);
    if (!provider || !shop) throw new Error("connector_sync requires provider and shop");
    return runConnectorSync({ provider, shop, days });
  },
  reports_run_due: async (job) => {
    const maxRuns = Number(job.payload?.maxRuns || 50);
    return runDueScheduledReports(maxRuns);
  },
  shopify_order_sync: async (job) => {
    const shop = String(job.payload?.shop || "");
    if (!shop) throw new Error("shopify_order_sync requires shop");
    return syncOrdersForShop(shop);
  },
  owner_rollup_refresh: async (job) => {
    const daysBack = Number(job.payload?.daysBack || 7);
    return refreshOwnerDailyRollups(daysBack);
  },
  truth_rollup_refresh: async (job) => {
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 90);
    if (!shop) throw new Error("truth_rollup_refresh requires shop");
    return refreshNetcashTruthRollups(shop, days);
  },
  profit_guardrails_run: async (job) => {
    const shop = String(job.payload?.shop || "");
    const days = Number(job.payload?.days || 30);
    const maxActions = Number(job.payload?.maxActions || 5);
    const applyActions = !!job.payload?.applyActions;
    if (!shop) throw new Error("profit_guardrails_run requires shop");
    return runProfitGuardrails({ shop, days, maxActions, applyActions });
  },
};

