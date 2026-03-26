import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

function isValidShopDomain(value) {
  const shop = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  const hasShopContext =
    url.searchParams.get("shop") ||
    url.searchParams.get("host") ||
    url.searchParams.get("embedded") === "1";

  if (hasShopContext) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // If this app is opened directly without query context but a default dev store is configured,
  // start auth automatically so no manual domain input is required in local/dev flows.
  const defaultShop = String(process.env.SHOPIFY_SHOP_DOMAIN || "").trim().toLowerCase();
  if (isValidShopDomain(defaultShop)) {
    throw redirect(`/auth/login?shop=${encodeURIComponent(defaultShop)}`);
  }

  // Auto-resume to latest known authenticated shop when opened directly in dev/local.
  try {
    const { prisma } = await import("../../utils/db.server");
    const recentSession = await prisma.session.findFirst({
      where: { accessToken: { not: null } },
      select: { shop: true },
      orderBy: { id: "desc" },
    });
    const recentShop = String(recentSession?.shop || "").trim().toLowerCase();
    if (isValidShopDomain(recentShop)) {
      throw redirect(`/auth/login?shop=${encodeURIComponent(recentShop)}`);
    }
  } catch {
    // If session lookup fails, keep the fallback landing page.
  }

  return { defaultShop };
};

export default function App() {
  const { defaultShop } = useLoaderData();
  const ui = {
    page: {
      minHeight: "100vh",
      background: "linear-gradient(135deg, #f7fbff 0%, #eef6ff 100%)",
      display: "flex",
      justifyContent: "center",
      padding: "48px 20px",
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
    },
    card: {
      width: "100%",
      maxWidth: "920px",
      background: "#ffffff",
      border: "1px solid #dbe6f2",
      borderRadius: "16px",
      padding: "36px",
      boxShadow: "0 10px 30px rgba(20, 41, 77, 0.08)",
    },
    heading: {
      margin: 0,
      fontSize: "2rem",
      lineHeight: 1.2,
      color: "#0f1e33",
    },
    text: {
      marginTop: "14px",
      marginBottom: "24px",
      fontSize: "1.05rem",
      lineHeight: 1.6,
      color: "#314a66",
      maxWidth: "760px",
    },
    list: {
      margin: 0,
      paddingLeft: "20px",
      color: "#1f3550",
      display: "grid",
      gap: "10px",
      lineHeight: 1.6,
    },
  };

  return (
    <div style={ui.page}>
      <div style={ui.card}>
        <h1 style={ui.heading}>Track Real ROAS, Not Just Revenue</h1>
        <p style={ui.text}>
          Netcash.ai helps Shopify brands measure net cash after discounts,
          shipping, taxes, refunds, and returns so ad decisions are based on
          true profitability.
        </p>
        <div
          style={{
            marginBottom: "26px",
            border: "1px solid #c8d9ef",
            background: "linear-gradient(180deg, #f8fbff 0%, #edf5ff 100%)",
            borderRadius: "12px",
            padding: "12px 14px",
            color: "#1c3f67",
            fontWeight: 600,
          }}
        >
          Open this app from Shopify Admin to continue. Shop context is auto-detected and sign-in is automatic.
          {defaultShop ? ` (Dev default: ${defaultShop})` : ""}
        </div>
        <ul style={ui.list}>
          <li>
            <strong>Order-level net cash insights</strong>. Automatically
            calculate true contribution per order after all deductions.
          </li>
          <li>
            <strong>Real ROAS by marketing source</strong>. Compare platform
            ROAS with actual cash realized in your account.
          </li>
          <li>
            <strong>Returns and refund impact tracking</strong>. See how
            post-purchase losses affect campaign profitability over time.
          </li>
        </ul>
        <div style={{ marginTop: "24px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <a href="/legal/privacy">Privacy</a>
          <a href="/legal/dpa">DPA</a>
          <a href="/legal/data-retention">Data Retention</a>
          <a href="/legal/deletion">Deletion Flow</a>
          <a href="/support/sla">Support SLA</a>
        </div>
      </div>
    </div>
  );
}
