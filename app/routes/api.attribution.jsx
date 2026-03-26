import { upsertToolAttribution } from "../utils/db.server";
import { enforceRateLimit } from "../utils/rate-limit.server";
import { extractAttributionRecords, SUPPORTED_PROVIDERS } from "../utils/connectors";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function action({ request }) {
  try {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }
    const rateLimited = enforceRateLimit(request, { key: "api:attribution", limit: 300, windowMs: 60_000 });
    if (rateLimited) return rateLimited;

    const expectedKey = process.env.ATTRIBUTION_API_KEY;
    if (expectedKey) {
      const provided = request.headers.get("x-netcash-api-key") || "";
      if (!provided || provided !== expectedKey) {
        return json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = await request.json();
    const records = extractAttributionRecords(body);

    if (records.length === 0) {
      return json(
        {
          error:
            "No valid attribution records. Provide shop + (orderId or orderNumber) and provider/tool. You can send one record or bulk records[].",
        },
        { status: 400 },
      );
    }

    const results = [];
    const errors = [];

    for (const record of records) {
      try {
        const updated = await upsertToolAttribution({
          shop: record.shop,
          tool: record.provider,
          orderId: record.orderId,
          orderNumber: record.orderNumber,
          campaignId: record.campaignId,
          campaignName: record.campaignName,
          adSetId: record.adSetId,
          adId: record.adId,
        });
        results.push({
          shop: record.shop,
          orderId: updated.orderId,
          campaignId: updated.campaignId || null,
          provider: record.provider,
        });
      } catch (error) {
        errors.push({
          shop: record.shop,
          orderId: record.orderId || null,
          orderNumber: record.orderNumber || null,
          provider: record.provider,
          error: error?.message || "Unknown error",
        });
      }
    }

    return json({
      success: errors.length === 0,
      processed: records.length,
      updated: results.length,
      failed: errors.length,
      results,
      errors,
    });
  } catch (error) {
    return json({ error: error?.message || "Unknown error" }, { status: 500 });
  }
}

export async function loader() {
  return json({
    endpoint: "/api/attribution",
    method: "POST",
    supportedProviders: SUPPORTED_PROVIDERS,
    payloadExamples: [
      {
        provider: "meta_ads",
        shop: "netcash-dev-store-2.myshopify.com",
        orderNumber: "#1002",
        campaignId: "1201234567890",
        campaignName: "Summer Sale",
        adSetId: "1201234567000",
        adId: "1201234567999",
      },
      {
        provider: "google_ads",
        records: [
          {
            shop: "netcash-dev-store-2.myshopify.com",
            orderId: "gid://shopify/Order/12345",
            campaignId: "201001",
            campaignName: "Search Brand",
          },
        ],
      },
    ],
  });
}
