import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { createIntegrationRequests } from "../utils/integration-requests.server";

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, { status: 405 });
  }
  const formData = await request.formData();
  const category = String(formData.get("category") || "delivery");
  const notes = String(formData.get("notes") || "");
  const providers = formData.getAll("providers").map((item) => String(item || ""));
  if (!providers.length) {
    return json({ ok: false, error: "Select at least one provider." }, { status: 400 });
  }
  const created = await createIntegrationRequests(session.shop, category, providers, notes);
  return json({ ok: true, created });
}

export async function loader() {
  return json({
    ok: true,
    endpoint: "/api/integrations/request",
    method: "POST",
  });
}
