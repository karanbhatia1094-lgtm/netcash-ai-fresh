import { redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { authenticate, BASIC_PLAN, PRO_PLAN, PREMIUM_PLAN } from "../shopify.server";
import { resolvePremiumOverrideForShop } from "../utils/plan.server";

const PLAN_DETAILS = {
  [BASIC_PLAN]: {
    key: BASIC_PLAN,
    label: "Starter",
    monthlyINR: 2000,
    description: "Strong foundation for net-cash analytics + attribution dashboard",
    features: [
      "Net cash dashboard + core KPIs",
      "Campaign performance overview",
      "Basic alerts and health score",
      "CSV exports (orders + spend)",
      "Shopify order sync",
    ],
  },
  [PRO_PLAN]: {
    key: PRO_PLAN,
    label: "Pro",
    monthlyINR: 5000,
    description: "Advanced campaign analytics + automation rules",
    features: [
      "Everything in Starter",
      "Campaign stop list + actions",
      "Attribution model comparisons",
      "RFM cohorts + customer 360",
      "Scheduled reports",
    ],
  },
  [PREMIUM_PLAN]: {
    key: PREMIUM_PLAN,
    label: "Premium",
    monthlyINR: 10000,
    description: "Full growth OS with AI workflow + enterprise controls",
    features: [
      "Everything in Pro",
      "Universal Insights + behavior graph",
      "AI insights assistant",
      "Advanced connector health + syncs",
      "Priority support + onboarding",
    ],
  },
};

function inr(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function presentPlanName(value) {
  const text = String(value || "");
  if (text.toLowerCase().includes("basic")) {
    return text.replace(/basic/gi, "Starter");
  }
  return text;
}

export async function loader({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const premiumOverride = resolvePremiumOverrideForShop(session?.shop);

  if (premiumOverride) {
    if (url.searchParams.get("manage") !== "1") {
      return redirect(`/app${url.search}`);
    }

    return {
      plans: Object.values(PLAN_DETAILS),
      hasActivePayment: true,
      subscriptions: premiumOverride.subscriptions,
      isTestMode: process.env.NODE_ENV !== "production",
    };
  }

  const check = await billing.check({
    plans: [BASIC_PLAN, PRO_PLAN, PREMIUM_PLAN],
    isTest: process.env.NODE_ENV !== "production",
  });

  // After successful plan payment/approval, land merchants directly in the app.
  // Use ?manage=1 to keep billing page accessible for manual plan changes.
  if (check.hasActivePayment && url.searchParams.get("manage") !== "1") {
    return redirect(`/app${url.search}`);
  }

  return {
    plans: Object.values(PLAN_DETAILS),
    hasActivePayment: check.hasActivePayment,
    subscriptions: check.appSubscriptions || [],
    isTestMode: process.env.NODE_ENV !== "production",
  };
}

export async function action({ request }) {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "");
  const requestUrl = new URL(request.url);
  const returnUrl = new URL(`/app${requestUrl.search}`, requestUrl.origin).toString();

  if (!Object.prototype.hasOwnProperty.call(PLAN_DETAILS, plan)) {
    return { ok: false, error: "Invalid billing plan selected." };
  }

  try {
    return await billing.request({
      plan,
      isTest: process.env.NODE_ENV !== "production",
      returnUrl,
    });
  } catch (error) {
    const errorData = error?.errorData;
    let detailed = "";

    if (Array.isArray(errorData) && errorData.length > 0) {
      detailed = errorData
        .map((row) => String(row?.message || row?.code || JSON.stringify(row)))
        .filter(Boolean)
        .join(" | ");
    }

    return {
      ok: false,
      error: detailed || String(error?.message || "Billing request failed."),
    };
  }
}

export default function AppBillingRoute() {
  const data = useLoaderData();
  const actionData = useActionData();

  return (
    <div className="nc-shell">
      <h1>Choose Your Plan</h1>
      <p className="nc-subtitle">
        Activate a monthly plan to use Netcash.ai in production stores.
      </p>

      {data.hasActivePayment ? (
        <div className="nc-card nc-section nc-glass">
          <h2>Current Active Subscription</h2>
          {(data.subscriptions || []).length === 0 ? (
            <p className="nc-note">Active payment found.</p>
          ) : (
            <table className="nc-table-card">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Plan</th>
                  <th style={{ textAlign: "left" }}>Status</th>
                  <th style={{ textAlign: "left" }}>Test</th>
                </tr>
              </thead>
              <tbody>
                {data.subscriptions.map((sub) => (
                  <tr key={sub.id}>
                    <td>{presentPlanName(sub.name)}</td>
                    <td>{sub.status}</td>
                    <td>{sub.test ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {actionData?.error ? (
        <div className="nc-card nc-section">
          <p className="nc-danger">{actionData.error}</p>
        </div>
      ) : null}

      <div className="nc-grid-4 nc-section">
        {data.plans.map((plan) => (
          <div key={plan.key} className="nc-card nc-glass">
            <h2 style={{ marginBottom: "8px" }}>{plan.label}</h2>
            <p className="nc-kpi-value" style={{ marginTop: 0 }}>
              {inr(plan.monthlyINR)}
              <span className="nc-note"> / month</span>
            </p>
            <p className="nc-note">{plan.description}</p>
            <ul style={{ margin: "10px 0 12px", paddingLeft: "18px" }}>
              {(plan.features || []).map((feature) => (
                <li key={`${plan.key}-${feature}`}>{feature}</li>
              ))}
            </ul>
            <Form method="post">
              <input type="hidden" name="plan" value={plan.key} />
              <button type="submit">{plan.label}</button>
            </Form>
          </div>
        ))}
      </div>

      <div className="nc-card nc-section">
        <h3 style={{ marginTop: 0 }}>Notes</h3>
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          <li>Development stores typically use test billing.</li>
          <li>When approved, merchants are redirected back to your embedded app.</li>
          <li>This page is shown automatically if no active paid plan exists.</li>
        </ul>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : String(error?.message || "Something went wrong while loading Billing.");

  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h2>Billing is temporarily unavailable</h2>
        <p className="nc-note">{message}</p>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href="/app">Back to Home</a>
          <a className="nc-chip" href="/app/billing?manage=1">Retry Billing</a>
        </div>
      </div>
    </div>
  );
}
