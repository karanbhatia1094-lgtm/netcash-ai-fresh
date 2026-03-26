import { AppProvider } from "@shopify/shopify-app-remix/react";
import { useEffect, useRef, useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { redirect } from "@remix-run/node";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

function normalizeShopDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let normalized = raw.toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, "");
  normalized = normalized.split("/")[0];

  if (!normalized) return "";
  if (!normalized.includes(".")) {
    normalized = `${normalized}.myshopify.com`;
  }

  return normalized;
}

function decodeBase64Url(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  try {
    return Buffer.from(`${base64}${pad}`, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function inferShopFromRequest(request, url) {
  const directShop = normalizeShopDomain(url.searchParams.get("shop"));
  if (directShop) return directShop;

  const hostParam = String(url.searchParams.get("host") || "").trim();
  const decodedHost = decodeBase64Url(hostParam);
  const hostMatch = decodedHost.match(/\/store\/([a-z0-9-]+)/i);
  if (hostMatch?.[1]) return normalizeShopDomain(`${hostMatch[1]}.myshopify.com`);

  const referer = String(request.headers.get("referer") || "");
  const refererMatch = referer.match(/\/store\/([a-z0-9-]+)/i);
  if (refererMatch?.[1]) return normalizeShopDomain(`${refererMatch[1]}.myshopify.com`);

  return "";
}

export const loader = async ({ request }) => {
  const loginResult = await login(request);
  if (loginResult instanceof Response) {
    return loginResult;
  }
  const url = new URL(request.url);
  const shop = inferShopFromRequest(request, url);
  if (shop) {
    throw redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  const errors = loginErrorMessage(loginResult);

  return { errors, shop };
};

export const action = async ({ request }) => {
  const formData = await request.clone().formData();
  const normalizedShop = normalizeShopDomain(formData.get("shop"));

  if (normalizedShop) {
    throw redirect(`/auth?shop=${encodeURIComponent(normalizedShop)}`);
  }

  const loginResult = await login(request);
  if (loginResult instanceof Response) {
    return loginResult;
  }
  const errors = loginErrorMessage(loginResult);

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState(loaderData?.shop || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoLoginTried, setAutoLoginTried] = useState(false);
  const formRef = useRef(null);
  const normalizedPreview = normalizeShopDomain(shop);
  const { errors } = actionData || loaderData;
  const hasShopError = !!errors?.shop;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (autoLoginTried || isSubmitting || shop || hasShopError) return;
    const lastShop = normalizeShopDomain(window.localStorage.getItem("nc_last_shop") || "");
    if (!lastShop) {
      setAutoLoginTried(true);
      return;
    }
    setShop(lastShop);
    setIsSubmitting(true);
    setAutoLoginTried(true);
    window.setTimeout(() => formRef.current?.requestSubmit(), 30);
  }, [autoLoginTried, hasShopError, isSubmitting, shop]);

  useEffect(() => {
    if (!hasShopError) return;
    if (typeof window === "undefined") return;
    window.localStorage.removeItem("nc_last_shop");
  }, [hasShopError]);

  return (
    <AppProvider isEmbeddedApp={false}>
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        background:
          "radial-gradient(900px 420px at -10% -20%, rgba(33, 96, 193, 0.16), transparent 65%), radial-gradient(820px 360px at 110% -20%, rgba(8, 136, 116, 0.13), transparent 62%), linear-gradient(180deg, #f3f8ff 0%, #eaf2ff 100%)",
      }}
      >
        <div style={{
          width: "100%",
          maxWidth: "520px",
          borderRadius: "18px",
          border: "1px solid #c7d8ef",
          background: "linear-gradient(180deg, #ffffff 0%, #f4f9ff 100%)",
          boxShadow: "0 18px 40px rgba(12, 43, 84, 0.14)",
          padding: "28px",
        }}
        >
          <h2 style={{ margin: 0, color: "#0d2b53", fontSize: "34px", lineHeight: 1.1 }}>Log in</h2>
          <p style={{ marginTop: "8px", marginBottom: "18px", color: "#3f5f84", fontSize: "14px" }}>
            Enter your Shopify shop domain to continue. You can type only the shop name and we will complete it automatically.
          </p>
          <Form
            method="post"
            target="_top"
            reloadDocument
            ref={formRef}
            onSubmit={() => {
              const normalizedShop = normalizeShopDomain(shop);
              if (typeof window !== "undefined" && normalizedShop) {
                window.localStorage.setItem("nc_last_shop", normalizedShop);
              }
              setIsSubmitting(true);
            }}
          >
            <label htmlFor="shop" style={{ display: "block", marginBottom: "8px", fontWeight: 700, color: "#123a69" }}>
              Shop domain
            </label>
            <input
              id="shop"
              name="shop"
              type="text"
              placeholder="example.myshopify.com"
              value={shop}
              onBlur={(e) => setShop(normalizeShopDomain(e.currentTarget.value))}
              onChange={(e) => setShop(e.currentTarget.value)}
              disabled={isSubmitting}
              autoComplete="on"
              style={{
                width: "100%",
                border: errors.shop ? "1px solid #d43f2f" : "1px solid #afc7e6",
                borderRadius: "10px",
                padding: "12px 14px",
                background: "#fdfefe",
                color: "#0a2b50",
                fontSize: "15px",
              }}
            />
            <div style={{ marginTop: "7px", marginBottom: "12px", color: "#52739a", fontSize: "12px" }}>
              {normalizedPreview ? `Using: ${normalizedPreview}` : "Example: your-brand.myshopify.com"}
            </div>
            {errors.shop ? (
              <p style={{ color: "#b42318", marginTop: 0, marginBottom: "12px", fontWeight: 600 }}>{errors.shop}</p>
            ) : null}
            <button
              type="submit"
              style={{
                width: "100%",
                border: 0,
                borderRadius: "10px",
                padding: "11px 14px",
                color: "#fff",
                fontWeight: 800,
                fontSize: "14px",
                cursor: "pointer",
                background: "linear-gradient(180deg, #0f5fd3 0%, #0b4ea9 100%)",
                boxShadow: "0 12px 24px rgba(15, 95, 211, 0.28)",
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Connecting..." : "Continue to Shopify Auth"}
            </button>
            {isSubmitting ? (
              <div style={{ marginTop: "10px", color: "#386596", fontSize: "12px", fontWeight: 700 }}>
                Redirecting securely to Shopify. This usually takes a few seconds.
              </div>
            ) : null}
          </Form>
          <div style={{ marginTop: "14px", color: "#4a678d", fontSize: "12px" }}>
            Need help? Contact support from your Owner Console or via support policy links on the home page.
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
