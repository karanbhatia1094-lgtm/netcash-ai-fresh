import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { createAiPromptRun, getOrders, getSourceMetrics } from "../utils/db.server";

const SUPPORTED_DAYS = [7, 30, 90, 365];

function money(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function parseSource(query) {
  const q = normalize(query);
  if (q.includes("meta") || q.includes("facebook") || q.includes("instagram")) return "meta";
  if (q.includes("google")) return "google";
  if (q.includes("tiktok")) return "tiktok";
  if (q.includes("email")) return "email";
  if (q.includes("direct")) return "direct";
  return null;
}

function findTopCampaign(orders) {
  const map = new Map();
  for (const order of orders) {
    const key = `${order.marketingSource || "unknown"}|${order.campaignId || ""}|${order.campaignName || ""}`;
    if (!map.has(key)) {
      map.set(key, {
        source: order.marketingSource || "unknown",
        campaignId: order.campaignId || "",
        campaignName: order.campaignName || "Unmapped",
        gross: 0,
        net: 0,
        orders: 0,
      });
    }
    const row = map.get(key);
    row.gross += order.grossValue || 0;
    row.net += order.netCash || 0;
    row.orders += 1;
  }
  return [...map.values()].sort((a, b) => b.net - a.net)[0] || null;
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({}));

  const query = String(body?.query || "").trim();
  const templateId = body?.templateId ? Number(body.templateId) : null;
  const requestedDays = Number(body?.days || 30);
  const days = SUPPORTED_DAYS.includes(requestedDays) ? requestedDays : 30;

  if (!query) {
    return json({ error: "Query is required." }, { status: 400 });
  }

  const [orders, sourceMetrics] = await Promise.all([
    getOrders(session.shop, days),
    getSourceMetrics(days),
  ]);

  const gross = orders.reduce((sum, row) => sum + (row.grossValue || 0), 0);
  const net = orders.reduce((sum, row) => sum + (row.netCash || 0), 0);
  const spend = sourceMetrics.reduce((sum, row) => sum + (row.adSpend || 0), 0);
  const roas = spend > 0 ? gross / spend : 0;
  const realRoas = spend > 0 ? net / spend : 0;

  const q = normalize(query);
  const source = parseSource(q);

  if (q.includes("top campaign") || q.includes("best campaign")) {
    const top = findTopCampaign(orders);
    if (!top) {
      return json({
        intent: "top_campaign",
        answer: `No campaign data found in the last ${days} days.`,
        cards: [],
      });
    }
    const result = {
      intent: "top_campaign",
      answer: `Top campaign in last ${days} days is "${top.campaignName}" from ${top.source} with net cash ${money(top.net)}.`,
      cards: [
        { label: "Campaign", value: top.campaignName },
        { label: "Source", value: top.source },
        { label: "Orders", value: String(top.orders) },
        { label: "Net Cash", value: money(top.net) },
      ],
      rows: [top],
    };
    await createAiPromptRun(session.shop, {
      templateId,
      promptQuery: query,
      intent: result.intent,
      answer: result.answer,
      summaryJson: { cards: result.cards, rows: result.rows },
    });
    return json(result);
  }

  if (source && (q.includes("orders") || q.includes("source"))) {
    const filtered = orders.filter((row) => String(row.marketingSource || "unknown").toLowerCase() === source);
    const sourceGross = filtered.reduce((sum, row) => sum + (row.grossValue || 0), 0);
    const sourceNet = filtered.reduce((sum, row) => sum + (row.netCash || 0), 0);
    const result = {
      intent: "source_orders",
      answer: `Found ${filtered.length} ${source} orders in last ${days} days with net cash ${money(sourceNet)}.`,
      cards: [
        { label: "Source", value: source },
        { label: "Orders", value: String(filtered.length) },
        { label: "Gross", value: money(sourceGross) },
        { label: "Net Cash", value: money(sourceNet) },
      ],
      rows: filtered.slice(0, 10).map((row) => ({
        orderNumber: row.orderNumber,
        date: row.createdAt,
        gross: row.grossValue,
        net: row.netCash,
        campaign: row.campaignName || row.campaignId || "Unmapped",
      })),
    };
    await createAiPromptRun(session.shop, {
      templateId,
      promptQuery: query,
      intent: result.intent,
      answer: result.answer,
      summaryJson: { cards: result.cards, rows: result.rows },
    });
    return json(result);
  }

  if (q.includes("roas") || q.includes("summary") || q.includes("overview") || q.includes("profit")) {
    const result = {
      intent: "summary",
      answer: `In last ${days} days: gross ${money(gross)}, net cash ${money(net)}, ad spend ${money(spend)}, real ROAS ${realRoas.toFixed(2)}x.`,
      cards: [
        { label: "Gross Revenue", value: money(gross) },
        { label: "Net Cash", value: money(net) },
        { label: "Ad Spend", value: money(spend) },
        { label: "ROAS", value: `${roas.toFixed(2)}x` },
        { label: "Real ROAS", value: `${realRoas.toFixed(2)}x` },
      ],
      suggestions: [
        "Top campaign by net cash",
        "Show meta orders",
        "Show google orders",
      ],
    };
    await createAiPromptRun(session.shop, {
      templateId,
      promptQuery: query,
      intent: result.intent,
      answer: result.answer,
      summaryJson: { cards: result.cards, suggestions: result.suggestions },
    });
    return json(result);
  }

  const fallback = {
    intent: "fallback",
    answer:
      "I can help with: summary, top campaign, or source-specific orders (meta/google/tiktok/email/direct). Example: 'show meta orders last 30 days'.",
    cards: [
      { label: "Orders", value: String(orders.length) },
      { label: "Net Cash", value: money(net) },
    ],
  };
  await createAiPromptRun(session.shop, {
    templateId,
    promptQuery: query,
    intent: fallback.intent,
    answer: fallback.answer,
    summaryJson: { cards: fallback.cards },
  });
  return json(fallback);
}
