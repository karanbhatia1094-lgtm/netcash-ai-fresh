import { authenticate } from "../shopify.server";
import { prisma } from "../utils/db.server";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (request.method === "POST") {
    const refund = payload || {};
    const orderIdNumeric = refund.order_id ? String(refund.order_id) : "";
    if (!orderIdNumeric) {
      console.error("No order ID found in refund payload");
      return new Response();
    }

    try {
      // Prefer numeric webhook ID, fallback to GraphQL-style gid.
      const gqlOrderId = `gid://shopify/Order/${orderIdNumeric}`;
      const existingOrder = await prisma.netCashOrder.findFirst({
        where: {
          shop,
          OR: [{ orderId: orderIdNumeric }, { orderId: gqlOrderId }],
        },
      });
      if (existingOrder) {
        const refundFromLines = Array.isArray(refund.refund_line_items)
          ? refund.refund_line_items.reduce((sum, row) => sum + Number(row?.subtotal || row?.subtotal_set?.shop_money?.amount || 0), 0)
          : 0;
        const refundFromTx = Array.isArray(refund.transactions)
          ? refund.transactions.reduce((sum, row) => {
            const kind = String(row?.kind || "").toLowerCase();
            if (kind !== "refund") return sum;
            return sum + Number(row?.amount || 0);
          }, 0)
          : 0;
        const refundAmount = Math.max(refundFromLines, refundFromTx, 0);
        const newRefundTotal = Number(existingOrder.refundTotal || 0) + refundAmount;
        const newNetCash =
          Number(existingOrder.grossValue || 0) -
          Number(existingOrder.discountTotal || 0) -
          Number(existingOrder.shippingTotal || 0) -
          Number(existingOrder.taxTotal || 0) -
          Number(existingOrder.returnTotal || 0) -
          Number(existingOrder.rtoTotal || 0) -
          newRefundTotal +
          Number(existingOrder.exchangeAdjustment || 0);

        await prisma.netCashOrder.update({
          where: { id: existingOrder.id },
          data: {
            refundTotal: newRefundTotal,
            isReturned: true,
            netCash: newNetCash,
          },
        });

        console.log(
          `Refund recorded for order ${orderIdNumeric}: ${refundAmount}. New net cash: ${newNetCash}`
        );
      } else {
        console.warn(`Order ${orderIdNumeric} not found in database`);
      }
    } catch (error) {
      console.error("Error processing refund:", error);
    }
  }

  return new Response();
};
