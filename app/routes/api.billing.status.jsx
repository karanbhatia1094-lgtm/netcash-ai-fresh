import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordBillingSnapshot } from "../utils/billing-snapshots.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  try {
    const response = await admin.graphql(`
      query BillingStatus {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            lineItems {
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    interval
                    price {
                      amount
                      currencyCode
                    }
                  }
                  ... on AppUsagePricing {
                    cappedAmount {
                      amount
                      currencyCode
                    }
                    terms
                  }
                }
              }
            }
          }
        }
      }
    `);
    const payload = await response.json();
    const subscriptions =
      payload?.data?.currentAppInstallation?.activeSubscriptions || [];
    const liveSubscriptions = subscriptions.filter((row) => row.test !== true);
    const testSubscriptions = subscriptions.filter((row) => row.test === true);
    await recordBillingSnapshot(session.shop, subscriptions).catch(() => null);

    return json({
      shop: session.shop,
      hasActiveSubscription: subscriptions.length > 0,
      hasLiveSubscription: liveSubscriptions.length > 0,
      counts: {
        total: subscriptions.length,
        live: liveSubscriptions.length,
        test: testSubscriptions.length,
      },
      subscriptions,
    });
  } catch (error) {
    return json(
      {
        shop: session.shop,
        hasActiveSubscription: false,
        error: error?.message || "Failed to fetch billing status",
      },
      { status: 500 }
    );
  }
}
