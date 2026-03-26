import { authenticate } from "../shopify.server";
import { prisma } from "../utils/db.server";
import { ensureJobQueueTable } from "../utils/job-queue.server";

function sqlQuote(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  const safeShop = String(shop || "").trim().toLowerCase();

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }
  if (prisma.connectorCredential) {
    await prisma.connectorCredential.deleteMany({ where: { shop: safeShop } }).catch(() => null);
  }
  try {
    await ensureJobQueueTable();
    await prisma.$executeRawUnsafe(
      `UPDATE job_queue
       SET status = 'failed', completed_at = ${sqlQuote(new Date().toISOString())}, updated_at = ${sqlQuote(new Date().toISOString())},
           error_message = 'Shop uninstalled app'
       WHERE shop = ${sqlQuote(safeShop)} AND status IN ('queued', 'processing')`,
    );
  } catch {
    // best-effort queue cleanup
  }

  return new Response();
};
