import { redirect } from "@remix-run/node";
import { Link, useLoaderData, useNavigate } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { resolveOnboardingGuide } from "../utils/onboarding-guide.server";
import { resolvePlanContext } from "../utils/plan.server";

function firstPathname(href) {
  const value = String(href || "/app");
  const [path] = value.split("?");
  return path || "/app";
}

const EMBEDDED_PASSTHROUGH_KEYS = [
  "embedded",
  "host",
  "shop",
  "hmac",
  "session",
  "id_token",
  "timestamp",
  "locale",
];

function buildEmbeddedPassthrough(url) {
  const params = new URLSearchParams();
  for (const key of EMBEDDED_PASSTHROUGH_KEYS) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  return params.toString();
}

function withEmbeddedContext(href, passthroughQuery) {
  const value = String(href || "/app");
  if (!passthroughQuery) return value;

  const merged = new URL(value, "https://netcash.local");
  const passthrough = new URLSearchParams(passthroughQuery);
  for (const [key, rawValue] of passthrough.entries()) {
    if (!merged.searchParams.has(key)) {
      merged.searchParams.set(key, rawValue);
    }
  }
  const query = merged.searchParams.toString();
  return `${merged.pathname}${query ? `?${query}` : ""}${merged.hash || ""}`;
}

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const url = new URL(request.url);
  const isProduction = process.env.NODE_ENV === "production";
  const planContext = await resolvePlanContext(billing, !isProduction, BILLING_PLANS, session.shop);
  const guide = await resolveOnboardingGuide({ shop: session.shop, planContext });
  const disableAuto = String(url.searchParams.get("auto") || "").toLowerCase() === "off";
  const embeddedPassthroughQuery = buildEmbeddedPassthrough(url);

  if (guide.completed) {
    const returnToRaw = String(url.searchParams.get("returnTo") || "/app").trim();
    const returnTo = returnToRaw.startsWith("/app") ? returnToRaw : "/app";
    return redirect(withEmbeddedContext(returnTo, embeddedPassthroughQuery));
  }

  const stepsWithContext = (guide.steps || []).map((step) => ({
    ...step,
    href: withEmbeddedContext(step.href, embeddedPassthroughQuery),
  }));
  const nextStepWithContext = guide.nextStep
    ? {
      ...guide.nextStep,
      href: withEmbeddedContext(guide.nextStep.href, embeddedPassthroughQuery),
    }
    : null;

  return {
    shop: session.shop,
    tier: guide.tier,
    progressPercent: guide.progressPercent,
    doneRequiredSteps: guide.doneRequiredSteps,
    totalRequiredSteps: guide.totalRequiredSteps,
    steps: stepsWithContext,
    nextStep: nextStepWithContext,
    autoNavigate: !disableAuto,
    autoNavigatePath: firstPathname(nextStepWithContext?.href),
    pauseAutoHref: withEmbeddedContext("/app/onboarding?auto=off", embeddedPassthroughQuery),
  };
}

export default function OnboardingWizardPage() {
  const data = useLoaderData();
  const navigate = useNavigate();

  useEffect(() => {
    if (!data?.autoNavigate || !data?.nextStep?.href) return;
    const timer = setTimeout(() => {
      navigate(data.nextStep.href);
    }, 1200);
    return () => clearTimeout(timer);
  }, [data?.autoNavigate, data?.nextStep?.href, navigate]);

  return (
    <div className="nc-shell">
      <div className="nc-card nc-section nc-glass">
        <h1>Guided Onboarding</h1>
        <p className="nc-subtitle">Shop: {data.shop}</p>
        <p className="nc-note">
          Plan: <strong>{String(data.tier || "basic").toUpperCase()}</strong> | Progress:{" "}
          <strong>{data.progressPercent}%</strong> ({data.doneRequiredSteps}/{data.totalRequiredSteps})
        </p>
        {data.nextStep ? (
          <div className="nc-soft-box" style={{ marginTop: "10px" }}>
            <strong>Next step</strong>
            <p className="nc-note" style={{ marginTop: "6px", marginBottom: "6px" }}>
              {data.nextStep.label}
            </p>
            <p className="nc-note" style={{ marginTop: 0 }}>
              {data.nextStep.hint}
            </p>
            <Link className="nc-chip" to={data.nextStep.href}>Continue now</Link>
            <Link className="nc-chip" to={data.pauseAutoHref} style={{ marginLeft: "8px" }}>Pause Auto-Navigation</Link>
          </div>
        ) : null}
      </div>

      <div className="nc-card nc-section">
        <h2>Step-by-step checklist</h2>
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Step</th>
              <th style={{ textAlign: "left" }}>Required</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.steps.map((step) => (
              <tr key={step.key}>
                <td>{step.label}</td>
                <td>{step.required ? "Yes" : "Optional"}</td>
                <td className={step.complete ? "nc-success" : "nc-danger"}>{step.complete ? "Done" : "Pending"}</td>
                <td>
                  <Link className="nc-chip" to={step.href}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
