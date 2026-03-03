import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import { enqueueJob } from "../utils/job-queue.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  try {
    await registerWebhooks({ session });
  } catch (error) {
    console.error("Webhook registration failed after auth:", error);
  }

  try {
    await enqueueJob({
      type: "shopify_order_sync",
      shop: session.shop,
      payload: { shop: session.shop },
      uniqueKey: `shopify_order_sync:${session.shop}`,
      maxAttempts: 5,
    });
  } catch (error) {
    console.error("Initial install sync enqueue failed:", error);
  }

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
