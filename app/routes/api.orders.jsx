import { authenticate } from "../shopify.server";
import { saveOrder, getOrders } from "../utils/db.server";

export async function loader({ request }) {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;
    const url = new URL(request.url);
    const days = url.searchParams.get('days') || 30;

    const orders = await getOrders(shop, days);
    
    // Return data directly - NO json() wrapper
    return new Response(JSON.stringify({ orders }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function action({ request }) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    
    const response = await admin.graphql(
      `#graphql
      query OrdersForSync {
        orders(first: 50, reverse: true) {
          edges {
            node {
              id
              name
              sourceName
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
              lineItems(first: 50) {
                edges {
                  node {
                    name
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
      }`,
    );

    const data = await response.json();
    const edges = data?.data?.orders?.edges || [];

    for (const { node } of edges) {
      const order = {
        id: node.id,
        order_number: node.name,
        name: node.name,
        source_name: node.sourceName,
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
        shipping_lines: [
          { price: node?.totalShippingPriceSet?.shopMoney?.amount || "0" },
        ],
        line_items: (node?.lineItems?.edges || []).map(({ node: line }) => ({
          title: line?.name || "Item",
          quantity: line?.quantity || 1,
          sku: line?.sku || null,
          price: line?.originalUnitPriceSet?.shopMoney?.amount || "0",
        })),
        financial_status: node.displayFinancialStatus,
        fulfillment_status: node.displayFulfillmentStatus,
      };
      await saveOrder(shop, order);
    }
    
    return new Response(JSON.stringify({ success: true, count: edges.length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
