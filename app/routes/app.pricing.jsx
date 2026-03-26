import { json } from "@remix-run/node";
import { Form, Link, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { resolvePlanContext } from "../utils/plan.server";

function inr(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

const PLAN_DETAILS = [
  {
    key: "Basic Monthly",
    label: "Starter",
    price: 2000,
    description: "For early-stage brands needing core visibility and daily health checks.",
    features: [
      "Home dashboard KPIs + mission control",
      "Campaign overview (read-only)",
      "Core alerts + basic filters",
      "CSV exports (orders + spend)",
    ],
  },
  {
    key: "Pro Monthly",
    label: "Pro",
    price: 5000,
    description: "For growth brands optimizing ROAS with actions and advanced workflows.",
    features: [
      "Everything in Starter",
      "Campaign action queue + budget reallocation suggestions",
      "Creative scoring + recommendations",
      "Saved views + scheduled reports",
    ],
  },
  {
    key: "Premium Monthly",
    label: "Premium",
    price: 10000,
    description: "For advanced operators needing full access, intelligence, and priority support.",
    features: [
      "Everything in Pro",
      "Universal Insights + advanced cohorts",
      "Intelligence studio (AI assistant)",
      "Priority onboarding + premium support",
    ],
  },
];

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const planContext = await resolvePlanContext(
    billing,
    process.env.NODE_ENV !== "production",
    BILLING_PLANS,
    session.shop,
  );
  return json({
    shop: session.shop,
    planContext,
  });
}

export default function PricingPage() {
  const { planContext, shop } = useLoaderData();
  const tierLabel = String(planContext?.tier || "starter").toUpperCase();

  return (
    <div className="nc-shell nc-section">
      <div className="nc-card nc-glass nc-section">
        <div className="nc-section-head-inline">
          <div>
            <h1 style={{ marginBottom: "6px" }}>Plan & Billing</h1>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              Choose the plan that matches your growth stage. Current plan: <strong>{tierLabel}</strong>
            </p>
          </div>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Link to="/app" className="nc-chip" preventScrollReset>
              Back to Home
            </Link>
            <Link to="/app/billing?manage=1" className="nc-chip" preventScrollReset>
              Open billing settings
            </Link>
          </div>
        </div>
        <div className="nc-grid-3" style={{ marginTop: "18px" }}>
          {PLAN_DETAILS.map((plan) => (
            <div key={plan.key} className="nc-soft-box">
              <strong>{plan.label}</strong>
              <p className="nc-kpi-value" style={{ margin: "6px 0" }}>
                {inr(plan.price)} / month
              </p>
              <p className="nc-note">{plan.description}</p>
              <ul style={{ margin: "0 0 12px", paddingLeft: "18px" }}>
                {plan.features.map((feature) => (
                  <li key={`${plan.key}-${feature}`}>{feature}</li>
                ))}
              </ul>
              <Form method="post" action="/app/billing">
                <input type="hidden" name="plan" value={plan.key} />
                <button type="submit" className="nc-chip">Choose {plan.label}</button>
              </Form>
            </div>
          ))}
        </div>
        <p className="nc-note" style={{ marginTop: "16px" }}>
          Billing actions will redirect through Shopify approval flows. Need help? Contact support from Settings.
        </p>
        <p className="nc-note" style={{ marginTop: "4px" }}>
          Store: {shop}
        </p>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return (
      <div className="nc-shell nc-section">
        <div className="nc-card">
          <h2>Pricing unavailable</h2>
          <p className="nc-note">{error.status} {error.statusText}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="nc-shell nc-section">
      <div className="nc-card">
        <h2>Pricing unavailable</h2>
        <p className="nc-note">Please refresh or return to Home.</p>
      </div>
    </div>
  );
}
