import { authenticate } from "../shopify.server";
import { createReportSchedule, deactivateReportSchedule, listReportSchedules } from "../utils/report-scheduler.server";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = url.searchParams.get("page");
  const schedules = await listReportSchedules(session.shop, page || null);
  return json({ ok: true, schedules });
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "create");

  if (intent === "deactivate") {
    const scheduleId = Number(formData.get("scheduleId") || 0);
    if (!scheduleId) return json({ ok: false, error: "scheduleId is required" }, { status: 400 });
    await deactivateReportSchedule(session.shop, scheduleId);
    return json({ ok: true });
  }

  const email = String(formData.get("email") || "").trim();
  if (!email) {
    return json({ ok: false, error: "Email is required" }, { status: 400 });
  }

  const page = String(formData.get("page") || "home");
  const name = String(formData.get("name") || `${page} report`);
  const frequency = String(formData.get("frequency") || "weekly");
  const format = String(formData.get("format") || "both");

  let filters = {};
  const rawFilters = formData.get("filters");
  if (rawFilters) {
    try {
      const parsed = JSON.parse(String(rawFilters));
      if (parsed && typeof parsed === "object") filters = parsed;
    } catch {
      return json({ ok: false, error: "Invalid filters JSON" }, { status: 400 });
    }
  }

  const created = await createReportSchedule({
    shop: session.shop,
    page,
    name,
    frequency,
    email,
    format,
    filters,
  });

  return json({ ok: true, schedule: created });
}
