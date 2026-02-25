import { SUPPORTED_PROVIDERS } from "../utils/connectors";
import { getAttributionTemplateCatalog } from "../utils/attribution-templates";

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function loader() {
  const catalog = getAttributionTemplateCatalog({
    shop: "netcash-dev-store-2.myshopify.com",
    sampleOrder: {
      orderId: "gid://shopify/Order/12345",
      orderNumber: "#1002",
    },
  });
  const templates = Object.fromEntries(catalog.map((item) => [item.provider, item.payload]));

  return json({
    endpoint: "/api/attribution",
    auth: {
      header: "x-netcash-api-key",
      note: "Required if ATTRIBUTION_API_KEY is set on server",
    },
    requiredFields: ["provider/tool", "shop", "orderId or orderNumber", "campaignId or campaignName (recommended)"],
    providers: SUPPORTED_PROVIDERS,
    templates,
    catalog,
  });
}
