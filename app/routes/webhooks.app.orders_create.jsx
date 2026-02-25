import { authenticate } from "../shopify.server";
import { saveOrder } from "../utils/db.server";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (request.method === "POST") {
    try {
      await saveOrder(shop, payload);
    } catch (error) {
      console.error("Webhook order save failed:", error);
    }
  }

  return new Response();
};
