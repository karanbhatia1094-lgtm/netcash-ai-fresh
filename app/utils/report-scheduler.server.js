import { prisma } from "../../prisma.client.js";
import { logError, logInfo, logWarn } from "./logger.server";

const ALLOWED_PAGES = new Set(["home", "campaigns", "alerts"]);
const ALLOWED_FREQUENCIES = new Set(["daily", "weekly"]);
const ALLOWED_FORMATS = new Set(["csv", "pdf", "both"]);

function safePage(value) {
  const page = String(value || "").trim().toLowerCase();
  return ALLOWED_PAGES.has(page) ? page : "home";
}

function safeFrequency(value) {
  const frequency = String(value || "").trim().toLowerCase();
  return ALLOWED_FREQUENCIES.has(frequency) ? frequency : "weekly";
}

function safeFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return ALLOWED_FORMATS.has(format) ? format : "both";
}

function safeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeName(value) {
  return String(value || "").trim().slice(0, 120);
}

function asJsonString(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (parsed && typeof parsed === "object") return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function asCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function nextRunFor(frequency, fromDate = new Date()) {
  return frequency === "daily" ? addDays(fromDate, 1) : addDays(fromDate, 7);
}

function buildPdfBuffer(title, lines) {
  const width = 612;
  const height = 792;
  const fontSize = 11;
  const lineHeight = 14;
  const left = 40;
  const top = 760;

  const sanitized = [title, "", ...lines]
    .map((line) => String(line || "").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"))
    .slice(0, 120);

  let content = "BT\n/F1 12 Tf\n";
  sanitized.forEach((line, index) => {
    const y = top - index * lineHeight;
    content += `${left} ${y} Td (${line}) Tj\n`;
    if (index < sanitized.length - 1) content += `${-left} 0 Td\n`;
  });
  content += "ET";

  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Size ${fontSize} >>\nendobj\n`);
  objects.push(`5 0 obj\n<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

export async function ensureReportScheduleTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS report_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      page TEXT NOT NULL,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL,
      email TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'both',
      filters TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS report_delivery_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_report_schedule_shop_page ON report_schedule(shop, page)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_report_schedule_due ON report_schedule(is_active, next_run_at)");
  await prisma.$executeRawUnsafe("CREATE INDEX IF NOT EXISTS idx_report_delivery_run_schedule ON report_delivery_run(schedule_id, created_at)");
}

export async function listReportSchedules(shop, page = null) {
  await ensureReportScheduleTables();
  const safeShop = String(shop || "").trim();
  const safePageValue = page ? safePage(page) : null;
  const rows = safePageValue
    ? await prisma.$queryRawUnsafe(
      `SELECT id, shop, page, name, frequency, email, format, filters, is_active as isActive, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt
       FROM report_schedule
       WHERE shop = ? AND page = ? AND is_active = 1
       ORDER BY created_at DESC`,
      safeShop,
      safePageValue,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT id, shop, page, name, frequency, email, format, filters, is_active as isActive, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt
       FROM report_schedule
       WHERE shop = ? AND is_active = 1
       ORDER BY created_at DESC`,
      safeShop,
    );

  return (rows || []).map((row) => ({
    ...row,
    filters: parseJson(row.filters, {}),
  }));
}

export async function createReportSchedule({ shop, page, name, frequency, email, format = "both", filters = {} }) {
  await ensureReportScheduleTables();
  const safeShop = String(shop || "").trim();
  const safePageValue = safePage(page);
  const safeNameValue = safeName(name || `${safePageValue} report`);
  const safeFrequencyValue = safeFrequency(frequency);
  const safeEmailValue = safeEmail(email);
  const safeFormatValue = safeFormat(format);
  const now = new Date();
  const nextRunAt = nextRunFor(safeFrequencyValue, now).toISOString();

  await prisma.$executeRawUnsafe(
    `INSERT INTO report_schedule (shop, page, name, frequency, email, format, filters, is_active, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    safeShop,
    safePageValue,
    safeNameValue,
    safeFrequencyValue,
    safeEmailValue,
    safeFormatValue,
    asJsonString(filters),
    nextRunAt,
  );

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, shop, page, name, frequency, email, format, filters, is_active as isActive, next_run_at as nextRunAt, last_run_at as lastRunAt, created_at as createdAt
     FROM report_schedule WHERE shop = ? AND page = ? ORDER BY id DESC LIMIT 1`,
    safeShop,
    safePageValue,
  );
  const row = rows?.[0];
  if (!row) return null;
  return { ...row, filters: parseJson(row.filters, {}) };
}

export async function deactivateReportSchedule(shop, scheduleId) {
  await ensureReportScheduleTables();
  await prisma.$executeRawUnsafe(
    `UPDATE report_schedule SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND shop = ?`,
    Number(scheduleId),
    String(shop || "").trim(),
  );
}

async function listDueSchedules(maxRuns = 50) {
  await ensureReportScheduleTables();
  return prisma.$queryRawUnsafe(
    `SELECT id, shop, page, name, frequency, email, format, filters, next_run_at as nextRunAt, last_run_at as lastRunAt
     FROM report_schedule
     WHERE is_active = 1 AND datetime(next_run_at) <= datetime('now')
     ORDER BY datetime(next_run_at) ASC
     LIMIT ?`,
    Math.max(1, Number(maxRuns) || 50),
  );
}

async function recordDeliveryRun(scheduleId, status, message, metadata = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO report_delivery_run (schedule_id, status, message, metadata, created_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    Number(scheduleId),
    String(status || "failed"),
    String(message || ""),
    asJsonString(metadata),
  );
}

async function bumpScheduleRun(schedule) {
  const now = new Date();
  const nextRunAt = nextRunFor(safeFrequency(schedule.frequency), now).toISOString();
  await prisma.$executeRawUnsafe(
    `UPDATE report_schedule
     SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    now.toISOString(),
    nextRunAt,
    Number(schedule.id),
  );
}

function normalizeDays(filters, fallback = 30) {
  const days = Number(filters?.days || fallback);
  if (!Number.isFinite(days)) return fallback;
  if (days <= 0) return fallback;
  return Math.min(365, Math.floor(days));
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

async function buildHomeReport(shop, filters) {
  const days = normalizeDays(filters, 30);
  const since = daysAgo(days);
  const orders = await prisma.netCashOrder.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const gross = orders.reduce((sum, row) => sum + Number(row.grossValue || 0), 0);
  const net = orders.reduce((sum, row) => sum + Number(row.netCash || 0), 0);
  const count = orders.length;
  const topSourcesMap = new Map();
  for (const row of orders) {
    const source = String(row.marketingSource || "unmapped");
    const existing = topSourcesMap.get(source) || { source, orders: 0, netCash: 0 };
    existing.orders += 1;
    existing.netCash += Number(row.netCash || 0);
    topSourcesMap.set(source, existing);
  }
  const topSources = [...topSourcesMap.values()].sort((a, b) => b.netCash - a.netCash).slice(0, 5);
  const csv = asCsv([
    ["Report", "Founder Snapshot"],
    ["Window", `Last ${days} days`],
    ["Orders", count],
    ["Gross Revenue", gross.toFixed(2)],
    ["Net Cash", net.toFixed(2)],
    ["Generated At", new Date().toISOString()],
    [],
    ["Top Source", "Orders", "Net Cash"],
    ...topSources.map((row) => [row.source, row.orders, row.netCash.toFixed(2)]),
    [],
    ["Order #", "Date", "Source", "Campaign", "Gross", "Net Cash"],
    ...orders.map((row) => [
      row.orderNumber,
      new Date(row.createdAt).toISOString(),
      row.marketingSource || "unmapped",
      row.campaignName || row.campaignId || "-",
      Number(row.grossValue || 0).toFixed(2),
      Number(row.netCash || 0).toFixed(2),
    ]),
  ]);
  const pdfLines = [
    `Window: Last ${days} days`,
    `Orders: ${count}`,
    `Gross Revenue: INR ${gross.toFixed(2)}`,
    `Net Cash: INR ${net.toFixed(2)}`,
    "",
    "Top Sources:",
    ...topSources.map((row) => `- ${row.source}: ${row.orders} orders, INR ${row.netCash.toFixed(2)} net`),
  ];
  return { title: `Netcash Founder Snapshot (${days}d)`, csv, pdfLines };
}

async function buildCampaignReport(shop, filters) {
  const days = normalizeDays(filters, 30);
  const source = String(filters?.source || "all").toLowerCase();
  const since = daysAgo(days);
  const orders = await prisma.netCashOrder.findMany({
    where: {
      shop,
      createdAt: { gte: since },
      ...(source !== "all" ? { marketingSource: source } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const grouped = new Map();
  for (const row of orders) {
    const key = `${row.marketingSource || "unmapped"}::${row.campaignId || row.campaignName || "unknown"}`;
    const existing = grouped.get(key) || {
      source: row.marketingSource || "unmapped",
      campaign: row.campaignName || row.campaignId || "unknown",
      orders: 0,
      gross: 0,
      net: 0,
    };
    existing.orders += 1;
    existing.gross += Number(row.grossValue || 0);
    existing.net += Number(row.netCash || 0);
    grouped.set(key, existing);
  }
  const rows = [...grouped.values()]
    .map((row) => ({ ...row, realRoas: row.gross > 0 ? row.net / row.gross : 0 }))
    .sort((a, b) => a.realRoas - b.realRoas)
    .slice(0, 300);

  const csv = asCsv([
    ["Report", "Campaigns"],
    ["Window", `Last ${days} days`],
    ["Source Filter", source],
    ["Generated At", new Date().toISOString()],
    [],
    ["Source", "Campaign", "Orders", "Gross", "Net Cash", "Real ROAS"],
    ...rows.map((row) => [
      row.source,
      row.campaign,
      row.orders,
      row.gross.toFixed(2),
      row.net.toFixed(2),
      row.realRoas.toFixed(2),
    ]),
  ]);
  const pdfLines = [
    `Window: Last ${days} days`,
    `Source filter: ${source}`,
    "",
    "Lowest efficiency campaigns:",
    ...rows.slice(0, 15).map((row) => `- ${row.source}/${row.campaign}: ROAS ${row.realRoas.toFixed(2)}x, Net INR ${row.net.toFixed(2)}`),
  ];
  return { title: `Netcash Campaign Report (${days}d)`, csv, pdfLines };
}

async function buildAlertsReport(shop, filters) {
  const days = normalizeDays(filters, 30);
  const severity = String(filters?.severity || "all").toLowerCase();
  const since = daysAgo(days);
  const rows = await prisma.alertEvent.findMany({
    where: {
      shop,
      lastSeenAt: { gte: since },
      ...(severity !== "all" ? { severity } : {}),
    },
    orderBy: { lastSeenAt: "desc" },
    take: 1000,
  });
  const csv = asCsv([
    ["Report", "Alerts"],
    ["Window", `Last ${days} days`],
    ["Severity Filter", severity],
    ["Generated At", new Date().toISOString()],
    [],
    ["Rule", "Severity", "Title", "Message", "Hits", "Last Seen", "Read"],
    ...rows.map((row) => [
      row.ruleKey,
      row.severity,
      row.title,
      row.message,
      row.hitCount,
      new Date(row.lastSeenAt).toISOString(),
      row.isRead ? "Yes" : "No",
    ]),
  ]);
  const pdfLines = [
    `Window: Last ${days} days`,
    `Severity filter: ${severity}`,
    `Total alerts: ${rows.length}`,
    "",
    "Recent alerts:",
    ...rows.slice(0, 20).map((row) => `- [${row.severity}] ${row.title} (${row.hitCount} hits)`),
  ];
  return { title: `Netcash Alerts Report (${days}d)`, csv, pdfLines };
}

async function buildReportData(schedule) {
  const filters = parseJson(schedule.filters, {});
  const page = safePage(schedule.page);
  if (page === "campaigns") return buildCampaignReport(schedule.shop, filters);
  if (page === "alerts") return buildAlertsReport(schedule.shop, filters);
  return buildHomeReport(schedule.shop, filters);
}

async function sendViaResend({ to, subject, text, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REPORTS_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY and REPORTS_FROM_EMAIL must be configured for scheduled email delivery.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      attachments,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API failed (${response.status}): ${body}`);
  }
}

export async function runDueScheduledReports(maxRuns = 50) {
  const due = await listDueSchedules(maxRuns);
  const results = [];

  for (const schedule of due) {
    const scheduleId = Number(schedule.id);
    try {
      const report = await buildReportData(schedule);
      const attachments = [];
      const format = safeFormat(schedule.format);
      const stamp = new Date().toISOString().replaceAll(":", "-");

      if (format === "csv" || format === "both") {
        attachments.push({
          filename: `${safePage(schedule.page)}_${stamp}.csv`,
          content: Buffer.from(report.csv, "utf8").toString("base64"),
        });
      }
      if (format === "pdf" || format === "both") {
        attachments.push({
          filename: `${safePage(schedule.page)}_${stamp}.pdf`,
          content: buildPdfBuffer(report.title, report.pdfLines).toString("base64"),
        });
      }

      await sendViaResend({
        to: schedule.email,
        subject: `${schedule.name} • Netcash.ai`,
        text: `${report.title}\n\nGenerated at: ${new Date().toISOString()}\nFrequency: ${schedule.frequency}\nShop: ${schedule.shop}`,
        attachments,
      });

      await bumpScheduleRun(schedule);
      await recordDeliveryRun(scheduleId, "success", "Delivered", { attachmentCount: attachments.length });
      results.push({ id: scheduleId, shop: schedule.shop, page: schedule.page, status: "success" });
      logInfo("reports.schedule.delivered", { scheduleId, shop: schedule.shop, page: schedule.page });
    } catch (error) {
      const message = String(error?.message || "Unknown delivery error");
      await recordDeliveryRun(scheduleId, "failed", message, {});
      results.push({ id: scheduleId, shop: schedule.shop, page: schedule.page, status: "failed", error: message });
      logError("reports.schedule.failed", { scheduleId, shop: schedule.shop, page: schedule.page, error: message });
    }
  }

  if (results.length === 0) logWarn("reports.schedule.none_due", {});
  return {
    attempted: due.length,
    delivered: results.filter((row) => row.status === "success").length,
    failed: results.filter((row) => row.status === "failed").length,
    results,
  };
}
