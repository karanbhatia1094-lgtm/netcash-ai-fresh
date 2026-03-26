import { listConnectorCredentials, prisma } from "./db.server";
import { recordOnboardingProgressSnapshot } from "./onboarding-progress.server";

function normalizeTier(tier) {
  const value = String(tier || "basic").trim().toLowerCase();
  if (value === "premium") return "premium";
  if (value === "pro") return "pro";
  return "basic";
}

function createStep({
  key,
  label,
  complete,
  href,
  hint,
  required = true,
}) {
  return {
    key,
    label,
    complete: !!complete,
    href: String(href || "/app"),
    hint: String(hint || ""),
    required: !!required,
  };
}

export async function resolveOnboardingGuide({ shop, planContext = {} }) {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) {
    return {
      shop: safeShop,
      tier: "basic",
      progressPercent: 0,
      doneRequiredSteps: 0,
      totalRequiredSteps: 0,
      steps: [],
      nextStep: null,
      completed: false,
      metrics: {},
    };
  }

  const tier = normalizeTier(planContext?.tier);
  const hasActivePayment = !!planContext?.hasActivePayment;
  const requiredConnectorCount = tier === "basic" ? 1 : 2;
  const needsAudienceRule = tier !== "basic";

  const [orderCount, destinationCount, activeRulesCount, connectorCreds] = await Promise.all([
    prisma.netCashOrder.count({ where: { shop: safeShop } }),
    prisma.activationDestination.count({ where: { shop: safeShop } }),
    prisma.audienceSyncRule.count({ where: { shop: safeShop, isActive: true } }),
    listConnectorCredentials(safeShop),
  ]);
  const connectedPullConnectors = (connectorCreds || []).filter((row) => !!row.accessToken).length;

  const steps = [
    createStep({
      key: "select_plan",
      label: "Select and activate your plan",
      complete: hasActivePayment,
      href: "/app/billing?manage=1",
      hint: "Activate plan to unlock onboarding and automations.",
      required: true,
    }),
    createStep({
      key: "connect_sources",
      label: tier === "basic" ? "Connect at least 1 paid source" : "Connect Meta and Google",
      complete: connectedPullConnectors >= requiredConnectorCount,
      href: "/app/integrations?wizard=1",
      hint: tier === "basic"
        ? "Connect one paid source to begin attribution."
        : "Connect both Meta and Google for complete attribution.",
      required: true,
    }),
    createStep({
      key: "run_first_sync",
      label: "Run first data sync",
      complete: orderCount > 0,
      href: "/app/additional",
      hint: "Run initial sync to pull orders and source performance.",
      required: true,
    }),
    createStep({
      key: "setup_destination",
      label: "Setup activation destination",
      complete: destinationCount > 0,
      href: "/app/additional",
      hint: "Add at least one destination (Webhook/Meta/Google).",
      required: true,
    }),
    createStep({
      key: "setup_audience_rule",
      label: "Create and activate audience rule",
      complete: activeRulesCount > 0,
      href: "/app/additional",
      hint: "Create one active audience sync rule for automation.",
      required: needsAudienceRule,
    }),
  ];

  const requiredSteps = steps.filter((step) => step.required);
  const doneRequiredSteps = requiredSteps.filter((step) => step.complete).length;
  const totalRequiredSteps = requiredSteps.length;
  const progressPercent = totalRequiredSteps > 0
    ? Math.round((doneRequiredSteps / totalRequiredSteps) * 100)
    : 100;
  const nextStep = requiredSteps.find((step) => !step.complete) || null;
  const completed = !nextStep;

  await recordOnboardingProgressSnapshot(safeShop, {
    totalSteps: totalRequiredSteps,
    doneSteps: doneRequiredSteps,
    progressPct: progressPercent,
    status: {
      tier,
      hasActivePayment,
      connectedPullConnectors,
      requiredConnectorCount,
      orderCount,
      destinationCount,
      activeRulesCount,
      steps: steps.map((row) => ({
        key: row.key,
        complete: row.complete,
        required: row.required,
      })),
    },
  }).catch(() => null);

  return {
    shop: safeShop,
    tier,
    progressPercent,
    doneRequiredSteps,
    totalRequiredSteps,
    steps,
    nextStep,
    completed,
    metrics: {
      hasActivePayment,
      connectedPullConnectors,
      requiredConnectorCount,
      orderCount,
      destinationCount,
      activeRulesCount,
    },
  };
}
