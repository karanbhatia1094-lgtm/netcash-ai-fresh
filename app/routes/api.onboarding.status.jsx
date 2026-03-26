import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { BILLING_PLANS } from "../shopify.server";
import { getDataQualitySummary } from "../utils/db.server";
import { resolveOnboardingGuide } from "../utils/onboarding-guide.server";
import { resolvePlanContext } from "../utils/plan.server";

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isProduction = process.env.NODE_ENV === "production";
  const planContext = await resolvePlanContext(billing, !isProduction, BILLING_PLANS, shop);
  const guide = await resolveOnboardingGuide({ shop, planContext });
  const quality = await getDataQualitySummary(shop, 30);
  const mappedPct = Number(quality?.totals?.mappedOrdersPct || 0);
  const qualityScore = Math.max(0, Math.min(100, Math.round(
    (mappedPct * 0.6)
    + (Math.min(1, guide.metrics.connectedPullConnectors > 0 ? 1 : 0) * 20)
    + (Math.min(1, guide.metrics.orderCount > 0 ? 1 : 0) * 20),
  )));

  return json(
    {
      shop,
      tier: guide.tier,
      progressPercent: guide.progressPercent,
      doneRequiredSteps: guide.doneRequiredSteps,
      totalRequiredSteps: guide.totalRequiredSteps,
      firstValueScore: qualityScore,
      steps: guide.steps.map((step) => ({
        label: step.label,
        complete: step.complete,
        hint: step.hint,
        href: step.href,
        required: step.required,
        key: step.key,
      })),
      metrics: {
        ...guide.metrics,
        mappedOrdersPct: mappedPct,
      },
      nextStep: guide.nextStep,
      nextAction: guide.nextStep?.hint || "Onboarding complete",
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
