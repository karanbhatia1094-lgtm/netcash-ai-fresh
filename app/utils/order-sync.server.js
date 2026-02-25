import { saveOrder } from "./db.server";
import { logError, logInfo } from "./logger.server";
import { prisma } from "../../prisma.client.js";

const SHOPIFY_API_VERSION = "2025-10";

const ORDERS_FOR_SYNC_QUERY = `#graphql
  query OrdersForSync {
    orders(first: 100, reverse: true) {
      edges {
        node {
          id
          name
          sourceName
          tags
          customAttributes {
            key
            value
          }
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          paymentGatewayNames
          discountCodes {
            code
          }
          clientDetails {
            userAgent
          }
          shippingAddress {
            address1
            address2
            city
            zip
            province
            countryCodeV2
            phone
          }
          lineItems(first: 50) {
            edges {
              node {
                name
                variantTitle
                quantity
                sku
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
          }
          currentTotalPriceSet {
            shopMoney {
              amount
            }
          }
          currentTotalDiscountsSet {
            shopMoney {
              amount
            }
          }
          currentTotalTaxSet {
            shopMoney {
              amount
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
            }
          }
          totalRefundedSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }`;

function mapOrdersToNetcashFormat(edges = []) {
  return (edges || []).map(({ node }) => ({
    id: node.id,
    order_number: node.name,
    name: node.name,
    source_name: node.sourceName,
    tags: node.tags,
    customAttributes: node.customAttributes,
    payment_gateway_names: node.paymentGatewayNames || [],
    discount_codes: (node.discountCodes || []).map((d) => ({ code: d?.code || "" })),
    client_details: {
      user_agent: node?.clientDetails?.userAgent || null,
    },
    created_at: node.createdAt,
    total_price: node?.currentTotalPriceSet?.shopMoney?.amount || "0",
    total_discounts: node?.currentTotalDiscountsSet?.shopMoney?.amount || "0",
    total_tax: node?.currentTotalTaxSet?.shopMoney?.amount || "0",
    total_refunded: node?.totalRefundedSet?.shopMoney?.amount || "0",
    customer: null,
    shipping_address: node.shippingAddress,
    shipping_lines: [{ price: node?.totalShippingPriceSet?.shopMoney?.amount || "0" }],
    line_items: (node?.lineItems?.edges || []).map(({ node: line }) => ({
      title: line?.name || "Item",
      variant_title: line?.variantTitle || null,
      quantity: line?.quantity || 1,
      sku: line?.sku || null,
      price: line?.originalUnitPriceSet?.shopMoney?.amount || "0",
    })),
    financial_status: node.displayFinancialStatus,
    fulfillment_status: node.displayFulfillmentStatus,
  }));
}

async function fetchOrdersByToken({ shop, accessToken }) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: ORDERS_FOR_SYNC_QUERY }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify GraphQL failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  if (data?.errors?.length) {
    throw new Error(`Shopify GraphQL returned errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
  }
  return mapOrdersToNetcashFormat(data?.data?.orders?.edges || []);
}

export async function syncOrdersByAccessToken({ shop, accessToken }) {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) throw new Error("syncOrdersByAccessToken requires shop");
  if (!accessToken) throw new Error("syncOrdersByAccessToken requires accessToken");

  const orders = await fetchOrdersByToken({ shop: safeShop, accessToken: String(accessToken) });
  let synced = 0;
  let failed = 0;
  for (const order of orders) {
    try {
      await saveOrder(safeShop, order);
      synced += 1;
    } catch (error) {
      failed += 1;
      logError("orders.sync.record_failed", {
        shop: safeShop,
        orderId: order.id,
        error: String(error?.message || "Unknown record save error"),
      });
    }
  }

  logInfo("orders.sync.completed", {
    shop: safeShop,
    fetched: orders.length,
    synced,
    failed,
  });
  return { shop: safeShop, fetched: orders.length, synced, failed };
}

export async function syncOrdersForShop(shop) {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop) throw new Error("syncOrdersForShop requires shop");

  const session = await prisma.session.findFirst({
    where: {
      shop: safeShop,
      isOnline: false,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      accessToken: true,
    },
  });
  if (!session?.accessToken) {
    throw new Error(`No offline access token found for shop: ${safeShop}`);
  }

  return syncOrdersByAccessToken({
    shop: safeShop,
    accessToken: session.accessToken,
  });
}
