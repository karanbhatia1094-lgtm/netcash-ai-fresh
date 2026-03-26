import { listConnectorCredentials, prisma } from "./db.server";
import { ensureDeliveryOmsTables } from "./delivery-oms.server";
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

function isPostgres() {
  return String(process.env.DATABASE_URL || "").startsWith("postgres");
}

async function getOmsDeliveryCounts(shop) {
  await ensureDeliveryOmsTables();
  if (isPostgres()) {
    const [deliveryRows, omsRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        "SELECT COUNT(*)::int as count FROM delivery_shipment WHERE shop = $1",
        shop,
      ),
      prisma.$queryRawUnsafe(
        "SELECT COUNT(*)::int as count FROM oms_order_status WHERE shop = $1",
        shop,
      ),
    ]);
    return {
      deliveryCount: Number(deliveryRows?.[0]?.count || 0),
      omsCount: Number(omsRows?.[0]?.count || 0),
    };
  }
  const [deliveryRows, omsRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      "SELECT COUNT(*) as count FROM delivery_shipment WHERE shop = ?",
      shop,
    ),
    prisma.$queryRawUnsafe(
      "SELECT COUNT(*) as count FROM oms_order_status WHERE shop = ?",
      shop,
    ),
  ]);
  return {
    deliveryCount: Number(deliveryRows?.[0]?.count || 0),
    omsCount: Number(omsRows?.[0]?.count || 0),
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
  const needsAudienceRule = tier !== "basic";

  const [orderCount, destinationCount, activeRulesCount, connectorCreds, omsDeliveryCounts] = await Promise.all([
    prisma.netCashOrder.count({ where: { shop: safeShop } }),
    prisma.activationDestination.count({ where: { shop: safeShop } }),
    prisma.audienceSyncRule.count({ where: { shop: safeShop, isActive: true } }),
    listConnectorCredentials(safeShop),
    getOmsDeliveryCounts(safeShop).catch(() => ({ deliveryCount: 0, omsCount: 0 })),
  ]);
  const connectedPullConnectors = (connectorCreds || []).filter((row) => !!row.accessToken).length;
  const metaConnected = !!(connectorCreds || []).find((row) => row.provider === "meta_ads" && row.accessToken);
  const googleConnected = !!(connectorCreds || []).find((row) => row.provider === "google_ads" && row.accessToken);
  const deliveryConnected = (omsDeliveryCounts?.deliveryCount || 0) > 0;
  const omsConnected = (omsDeliveryCounts?.omsCount || 0) > 0;
  const marketingChannelsReady = destinationCount > 0 && (activeRulesCount > 0 || !needsAudienceRule);

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
      key: "connect_meta",
      label: "Connect Meta Ads",
      complete: metaConnected,
      href: "/app/integrations?wizard=1",
      hint: "Authorize Meta to sync spend, ROAS, and creative signals.",
      required: true,
    }),
    createStep({
      key: "connect_google",
      label: "Connect Google Ads",
      complete: googleConnected,
      href: "/app/integrations?wizard=1",
      hint: "Authorize Google to sync spend, ROAS, and search campaign data.",
      required: true,
    }),
    createStep({
      key: "connect_shopify",
      label: "Sync Shopify orders",
      complete: orderCount > 0,
      href: "/app/additional",
      hint: "Run first data sync so dashboards populate with real orders.",
      required: true,
    }),
    createStep({
      key: "connect_marketing_tools",
      label: "Connect marketing tools (WhatsApp/SMS/Email/RCS)",
      complete: marketingChannelsReady,
      href: "/app/integrations?wizard=1",
      hint: "Setup at least one channel destination and rule for automation.",
      required: true,
    }),
    createStep({
      key: "connect_oms_delivery",
      label: "Connect OMS + Delivery tools",
      complete: deliveryConnected || omsConnected,
      href: "/app/integrations?wizard=1#delivery-integration-guide",
      hint: "Connect OMS/Delivery to track RTO, fulfillment, and delivery health.",
      required: true,
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
      metaConnected,
      googleConnected,
      orderCount,
      destinationCount,
      activeRulesCount,
      deliveryConnected,
      omsConnected,
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
      metaConnected,
      googleConnected,
      orderCount,
      destinationCount,
      activeRulesCount,
      deliveryConnected,
      omsConnected,
    },
  };
}
