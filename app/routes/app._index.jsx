import { json, redirect } from "@remix-run/node";
import { Form, Link, useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { authenticate, BILLING_PLANS } from "../shopify.server";
import { resolvePlanContext } from "../utils/plan.server";
import { trackUiEvent } from "../utils/telemetry.client";
import {
  deleteSpendEntry,
  deleteAiPromptTemplate,
  getCampaignPerformance,
  getOrders,
  getSourceMetrics,
  getSpendEntries,
  createAiPromptTemplate,
  getDashboardPreference,
  setAiPromptTemplatePinned,
  updateSpendEntry,
  upsertDashboardPreference,
  upsertSourceAdSpend,
  listConnectorCredentials,
  getRecentConnectorSyncRuns,
  getCreativeFatigueRisks,
  prisma,
} from "../utils/db.server";
import { listReportSchedules } from "../utils/report-scheduler.server";
import { enqueueJob } from "../utils/job-queue.server";
import { isFeatureEnabledForShopAsync, resolveShopConfig, upsertShopSetting } from "../utils/release-control.server";
import { isDevPreviewEnabled } from "../utils/dev-preview.server";
import { getEmbeddedPassthrough, withEmbeddedContext } from "../utils/embedded-nav";
import { getDeliveryOverview, getLatestDeliveryEvents } from "../utils/delivery-oms.server";

const DAY_OPTIONS = [7, 30, 90, 365];
const CUSTOMER_360_LOOKBACK_MIN_DAYS = 30;
const CUSTOMER_360_LOOKBACK_MAX_DAYS = 730;
const DASHBOARD_ORDERS_MAX = Math.max(500, Number(process.env.HOME_DASHBOARD_ORDERS_MAX || 2500));
const CUSTOMER_360_ANALYSIS_MAX = Math.max(1000, Number(process.env.HOME_CUSTOMER_360_ANALYSIS_MAX || 6000));

function resolveCustomer360LookbackDays() {
  const raw = Number(process.env.CUSTOMER_360_LOOKBACK_DAYS || 365);
  if (!Number.isFinite(raw)) return 365;
  return Math.max(CUSTOMER_360_LOOKBACK_MIN_DAYS, Math.min(CUSTOMER_360_LOOKBACK_MAX_DAYS, Math.floor(raw)));
}

function normalizeCustomerKey(order) {
  const email = String(order?.customerEmail || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(order?.customerPhone || "").replace(/\D/g, "");
  if (phone) return `phone:${phone}`;
  const name = String(order?.customerName || "").trim().toLowerCase();
  if (name) return `name:${name}`;
  return null;
}

function inferCategoryFromTitle(title) {
  const value = String(title || "").toLowerCase();
  if (value.includes("t-shirt") || value.includes("tee")) return "T-Shirts";
  if (value.includes("shirt")) return "Shirts";
  if (value.includes("jeans") || value.includes("denim")) return "Denim";
  if (value.includes("pant") || value.includes("trouser")) return "Bottomwear";
  if (value.includes("dress")) return "Dresses";
  if (value.includes("shoe") || value.includes("sneaker")) return "Footwear";
  if (value.includes("hoodie") || value.includes("sweatshirt")) return "Outerwear";
  if (value.includes("kurta")) return "Kurtas";
  return "Other";
}

function inferSizeFromVariant(variantTitle) {
  const value = String(variantTitle || "").toUpperCase();
  if (!value) return null;
  const match = value.match(/\b(XXS|XS|S|M|L|XL|XXL|XXXL)\b/);
  if (match?.[1]) return match[1];
  const numMatch = value.match(/\b(24|26|28|30|32|34|36|38|40|42|44)\b/);
  if (numMatch?.[1]) return numMatch[1];
  return null;
}

function deriveLtvTier(totalOrders, lifetimeNet) {
  const orders = Number(totalOrders || 0);
  const net = Number(lifetimeNet || 0);
  if (orders >= 8 && net >= 50000) return "gold";
  if (orders >= 4 && net >= 15000) return "silver";
  return "bronze";
}

function buildCustomerProfilesFromOrders(allOrders) {
  const ordersByCustomer = new Map();
  for (const order of allOrders || []) {
    const key = normalizeCustomerKey(order);
    if (!key) continue;
    if (!ordersByCustomer.has(key)) ordersByCustomer.set(key, []);
    ordersByCustomer.get(key).push(order);
  }

  const byOrderId = {};
  const profiles = [];

  for (const [key, list] of ordersByCustomer.entries()) {
    const sortedDesc = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const sortedAsc = [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const latest = sortedDesc[0];

    const lifetimeGross = sortedDesc.reduce((sum, row) => sum + (row.grossValue || 0), 0);
    const lifetimeNet = sortedDesc.reduce((sum, row) => sum + (row.netCash || 0), 0);
    const totalOrders = sortedDesc.length;

    const sizeMap = new Map();
    const categoryMap = new Map();
    for (const row of sortedDesc) {
      for (const item of row.lineItems || []) {
        const size = inferSizeFromVariant(item.variantTitle);
        if (size) sizeMap.set(size, (sizeMap.get(size) || 0) + Number(item.quantity || 0));
        const category = inferCategoryFromTitle(item.title);
        categoryMap.set(category, (categoryMap.get(category) || 0) + Number(item.quantity || 0));
      }
    }

    const preferredSizes = [...sizeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([size, qty]) => ({ size, qty }));
    const preferredCategories = [...categoryMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category, qty]) => ({ category, qty }));

    const gaps = [];
    for (let i = 1; i < sortedAsc.length; i += 1) {
      const prev = new Date(sortedAsc[i - 1].createdAt).getTime();
      const curr = new Date(sortedAsc[i].createdAt).getTime();
      const diffDays = Math.max(0, Math.round((curr - prev) / (1000 * 60 * 60 * 24)));
      gaps.push(diffDays);
    }
    const avgDaysBetweenOrders =
      gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null;
    const lastOrderAt = sortedAsc.length ? new Date(sortedAsc[sortedAsc.length - 1].createdAt) : null;
    const predictedNextOrderFrom = avgDaysBetweenOrders && lastOrderAt
      ? new Date(lastOrderAt.getTime() + avgDaysBetweenOrders * 0.75 * 24 * 60 * 60 * 1000)
      : null;
    const predictedNextOrderTo = avgDaysBetweenOrders && lastOrderAt
      ? new Date(lastOrderAt.getTime() + avgDaysBetweenOrders * 1.25 * 24 * 60 * 60 * 1000)
      : null;
    const ltvTier = deriveLtvTier(totalOrders, lifetimeNet);

    const profile = {
      customerKey: key,
      customerName: latest?.customerName || "Guest Customer",
      customerEmail: latest?.customerEmail || null,
      customerPhone: latest?.customerPhone || null,
      totalOrders,
      lifetimeGross,
      lifetimeNet,
      avgDaysBetweenOrders,
      predictedNextOrderFrom,
      predictedNextOrderTo,
      preferredSizes,
      preferredCategories,
      ltvTier,
      lastOrderAt: latest?.createdAt || null,
      orders: sortedDesc.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        createdAt: row.createdAt,
        grossValue: row.grossValue,
        netCash: row.netCash,
        financialStatus: row.financialStatus,
      })),
    };
    profiles.push(profile);

    for (const row of sortedDesc) {
      byOrderId[row.id] = {
        totalOrders,
        lifetimeGross,
        lifetimeNet,
        previousOrders: profile.orders.filter((item) => item.orderId !== row.orderId).slice(0, 8),
        preferredSizes,
        preferredCategories,
        avgDaysBetweenOrders,
        predictedNextOrderFrom,
        predictedNextOrderTo,
        ltvTier,
      };
    }
  }

  profiles.sort((a, b) => b.lifetimeNet - a.lifetimeNet || b.totalOrders - a.totalOrders);
  return { profiles, byOrderId };
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (stringValue.includes(",") || stringValue.includes("\"") || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }
  return stringValue;
}

function asCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function buildSnapshot(shop, days = 30) {
  const [orders, spendRows] = await Promise.all([
    getOrders(shop, days, { limit: 5000 }),
    getSourceMetrics(days),
  ]);
  const gross = (orders || []).reduce((sum, row) => sum + Number(row.grossValue || 0), 0);
  const net = (orders || []).reduce((sum, row) => sum + Number(row.netCash || 0), 0);
  const spend = (spendRows || []).reduce((sum, row) => sum + Number(row.adSpend || 0), 0);
  const blendedRoas = spend > 0 ? net / spend : 0;
  const marginPct = gross > 0 ? (net / gross) * 100 : 0;
  return {
    days,
    gross,
    net,
    spend,
    blendedRoas,
    marginPct,
  };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const days = Number(formData.get("days") || 30);
  const safeDays = DAY_OPTIONS.includes(days) ? days : 30;
  const stamp = new Date().toISOString().slice(0, 10);

  if (intent === "export-orders-csv") {
    const orders = await getOrders(shop, safeDays);
    const csv = asCsv([
      [
        "order_id",
        "order_number",
        "date",
        "source",
        "campaign_id",
        "campaign_name",
        "items",
        "gross_value",
        "net_cash",
        "financial_status",
      ],
      ...orders.map((order) => [
        order.orderId,
        order.orderNumber,
        new Date(order.createdAt).toISOString(),
        order.marketingSource || "unknown",
        order.campaignId || "",
        order.campaignName || "",
        (order.lineItems || [])
          .map((line) => `${line.title} x${line.quantity}`)
          .join(" | "),
        order.grossValue,
        order.netCash,
        order.financialStatus || "",
      ]),
    ]);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orders_${safeDays}d_${stamp}.csv"`,
      },
    });
  }

  if (intent === "export-spend-csv") {
    const spendHistory = await getSpendEntries(safeDays);
    const csv = asCsv([
      ["id", "date", "source", "ad_spend"],
      ...spendHistory.map((entry) => [
        entry.id,
        new Date(entry.spendDate).toISOString(),
        entry.source,
        entry.adSpend,
      ]),
    ]);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="spend_${safeDays}d_${stamp}.csv"`,
      },
    });
  }

  if (intent === "export-customer-360-pack") {
    const limit = Math.min(100, Math.max(1, Number(formData.get("limit") || 100)));
    const allOrders = await getOrders(shop, 3650);
    const { profiles } = buildCustomerProfilesFromOrders(allOrders);
    const topProfiles = profiles.slice(0, limit);

    const blocks = topProfiles
      .map((profile, index) => {
        const previousOrdersRows = (profile.orders || [])
          .slice(0, 12)
          .map(
            (row) =>
              `<tr><td>#${row.orderNumber}</td><td>${new Date(row.createdAt).toLocaleDateString()}</td><td>${row.financialStatus || "-"}</td><td style="text-align:right;">${row.grossValue.toFixed(2)}</td><td style="text-align:right;">${row.netCash.toFixed(2)}</td></tr>`,
          )
          .join("");
        const preferredSizes = (profile.preferredSizes || []).map((row) => `${row.size} (${row.qty})`).join(", ") || "-";
        const preferredCategories =
          (profile.preferredCategories || []).map((row) => `${row.category} (${row.qty})`).join(", ") || "-";
        const frequency =
          profile.avgDaysBetweenOrders != null ? `${profile.avgDaysBetweenOrders.toFixed(1)} days` : "Not enough history";
        const nextWindow =
          profile.predictedNextOrderFrom && profile.predictedNextOrderTo
            ? `${new Date(profile.predictedNextOrderFrom).toLocaleDateString()} - ${new Date(profile.predictedNextOrderTo).toLocaleDateString()}`
            : "Not enough history";
        return `
          <section style="margin-bottom:28px; page-break-inside:avoid;">
            <h2 style="margin:0 0 8px;">${index + 1}. ${profile.customerName} (${profile.ltvTier.toUpperCase()})</h2>
            <p style="margin:2px 0;"><strong>Email:</strong> ${profile.customerEmail || "-"}</p>
            <p style="margin:2px 0;"><strong>Phone:</strong> ${profile.customerPhone || "-"}</p>
            <p style="margin:2px 0;"><strong>Total Orders:</strong> ${profile.totalOrders} | <strong>Lifetime Gross:</strong> INR ${profile.lifetimeGross.toFixed(2)} | <strong>Lifetime Net:</strong> INR ${profile.lifetimeNet.toFixed(2)}</p>
            <p style="margin:2px 0;"><strong>Repeat Frequency:</strong> ${frequency} | <strong>Predicted Next Order:</strong> ${nextWindow}</p>
            <p style="margin:2px 0;"><strong>Preferred Sizes:</strong> ${preferredSizes}</p>
            <p style="margin:2px 0;"><strong>Preferred Categories:</strong> ${preferredCategories}</p>
            <table style="width:100%; border-collapse:collapse; margin-top:10px;">
              <thead><tr><th style="text-align:left;">Order</th><th style="text-align:left;">Date</th><th style="text-align:left;">Status</th><th style="text-align:right;">Gross</th><th style="text-align:right;">Net</th></tr></thead>
              <tbody>${previousOrdersRows || "<tr><td colspan='5'>No order history</td></tr>"}</tbody>
            </table>
          </section>
        `;
      })
      .join("");

    const html = `
      <html>
        <head>
          <title>Customer 360 Pack - ${shop}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { margin: 0 0 8px; }
            p { line-height: 1.4; }
            table, th, td { border: 1px solid #ddd; }
            th, td { padding: 6px; font-size: 12px; }
            th { background: #f5f7fb; }
          </style>
        </head>
        <body>
          <h1>Customer 360 Pack</h1>
          <p><strong>Shop:</strong> ${shop} | <strong>Generated:</strong> ${new Date().toLocaleString()}</p>
          <p>Use browser Print -> Save as PDF to export this pack.</p>
          ${blocks || "<p>No customer profiles available.</p>"}
        </body>
      </html>
    `;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="customer_360_pack_${stamp}.html"`,
      },
    });
  }

  if (intent === "update-ad-spend") {
    const source = String(formData.get("source") || "");
    const adSpend = Number(formData.get("adSpend") || 0);
    const spendDate = String(formData.get("spendDate") || "");

    if (source) {
      await upsertSourceAdSpend(source, adSpend, spendDate || new Date());
      console.log(`Updated ad spend for ${shop} source=${source} date=${spendDate} value=${adSpend}`);
    }
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "edit-spend-entry") {
    const entryId = Number(formData.get("entryId"));
    const adSpend = Number(formData.get("adSpend") || 0);
    if (entryId) {
      await updateSpendEntry(entryId, adSpend);
      console.log(`Edited spend entry ${entryId} for ${shop} value=${adSpend}`);
    }
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "delete-spend-entry") {
    const entryId = Number(formData.get("entryId"));
    if (entryId) {
      await deleteSpendEntry(entryId);
      console.log(`Deleted spend entry ${entryId} for ${shop}`);
    }
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "create-ai-template") {
    const title = String(formData.get("title") || "").trim();
    const query = String(formData.get("query") || "").trim();
    const category = String(formData.get("category") || "custom").trim().toLowerCase();
    const isPinned = String(formData.get("isPinned") || "") === "on";
    if (!title || !query) {
      return redirect(`/app?days=${safeDays}`);
    }
    await createAiPromptTemplate(shop, { title, query, category, isPinned });
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "delete-ai-template") {
    const id = Number(formData.get("templateId") || 0);
    if (id > 0) {
      await deleteAiPromptTemplate(shop, id);
    }
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "toggle-ai-template-pin") {
    const id = Number(formData.get("templateId") || 0);
    const isPinned = String(formData.get("isPinned") || "") === "true";
    if (id > 0) {
      await setAiPromptTemplatePinned(shop, id, !isPinned);
    }
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "add-experiment") {
    const title = String(formData.get("title") || "").trim();
    const hypothesis = String(formData.get("hypothesis") || "").trim();
    const expected = String(formData.get("expected") || "").trim();
    const startDate = String(formData.get("start_date") || "").trim();
    if (!title) {
      return redirect(`/app?days=${safeDays}`);
    }
    const config = await resolveShopConfig(shop, { growth_experiment_log: "[]" });
    const current = safeJsonParse(config.growth_experiment_log, []);
    const baseline = await buildSnapshot(shop, 30);
    const next = [
      {
        id: `exp_${Date.now()}`,
        title,
        hypothesis,
        expected,
        startDate: startDate || new Date().toISOString().slice(0, 10),
        status: "active",
        createdAt: new Date().toISOString(),
        baseline,
      },
      ...current,
    ].slice(0, 25);
    await upsertShopSetting(shop, "growth_experiment_log", JSON.stringify(next));
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "close-experiment") {
    const id = String(formData.get("id") || "");
    const config = await resolveShopConfig(shop, { growth_experiment_log: "[]" });
    const current = safeJsonParse(config.growth_experiment_log, []);
    const next = current.map((row) => (row.id === id ? { ...row, status: "closed" } : row));
    await upsertShopSetting(shop, "growth_experiment_log", JSON.stringify(next));
    return redirect(`/app?days=${safeDays}`);
  }

  if (intent === "save-layout") {
    const raw = String(formData.get("layout") || "{}");
    let layout = {};
    try {
      layout = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "Invalid layout payload" }, { status: 400 });
    }
    await upsertDashboardPreference(shop, layout);
    return json({ ok: true });
  }

  return redirect(`/app?days=${safeDays}`);
}

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get("days") || 30);
  const days = DAY_OPTIONS.includes(requestedDays) ? requestedDays : 30;
  const rawSourcesParam = String(url.searchParams.get("sources") || "all");
  const selectedSources = rawSourcesParam
    .split(",")
    .map((row) => row.trim().toLowerCase())
    .filter(Boolean);
  const normalizedSelectedSources = selectedSources.length ? [...new Set(selectedSources)] : ["all"];
  const includeAllSources = normalizedSelectedSources.includes("all");
  const sourceFilterSet = new Set(normalizedSelectedSources.filter((row) => row !== "all"));
  const planContext = await resolvePlanContext(
    billing,
    process.env.NODE_ENV !== "production",
    BILLING_PLANS,
    shop,
  );
  const devPreview = isDevPreviewEnabled();
  const asyncOrderSyncEnabled = await isFeatureEnabledForShopAsync(shop, "home_async_order_sync", true);
  const syncIntervalMins = Math.max(5, Number(process.env.ORDER_SYNC_MIN_INTERVAL_MINUTES || 30));
  const lookbackDays = resolveCustomer360LookbackDays();

  if (devPreview) {
    const zeroWindow = (windowDays) => ({
      windowDays,
      currentNet: 0,
      prevNet: 0,
      netDeltaPct: 0,
      currentRoas: 0,
      prevRoas: 0,
      roasDeltaPct: 0,
      weekdayMixDeltaPct: 0,
    });
    return {
      shop,
      planContext,
      sync: {
        asyncOrderSyncEnabled: false,
        enqueued: false,
        lastSyncAt: null,
        intervalMinutes: syncIntervalMins,
      },
      days,
      defaultSpendDate: new Date().toISOString().slice(0, 10),
      orders: [],
      metrics: {
        grossRevenue: 0,
        netCash: 0,
        adSpend: 0,
        roas: 0,
        realRoas: 0,
        blendedRoas: 0,
        orderCount: 0,
        netCashPerOrder: 0,
        avgOrderValue: 0,
        profitMarginPct: 0,
        attributionGapPct: 0,
        rtoPct: 0,
        refundPct: 0,
        discountPct: 0,
        creativeFatigueCount: 0,
      },
      sourceBreakdown: [],
      selectedSources: normalizedSelectedSources,
      availableSources: [],
      customerProfiles: [],
      customerHistoryByOrderId: {},
      highRtoItems: [],
      highRtoPincodes: [],
      spendHistory: [],
      alerts: [],
      campaignAnomalies: [],
      attributionModels: [],
      incrementality: {
        paidOrders: 0,
        directOrders: 0,
        paidNetAvg: 0,
        directNetAvg: 0,
        estimatedIncrementalNet: 0,
        estimatedUpliftPct: 0,
        cohorts: [],
      },
      savedLayout: null,
      stopCampaigns: [],
      permissions: {
        hasMetaConnector: false,
        hasGoogleConnector: false,
      },
      connectorSnapshotFallback: {
        lastSuccessAt: null,
        lastSuccessProvider: null,
        lastFailedAt: null,
        lastFailedProvider: null,
      },
      benchmarkMode: {
        seven: zeroWindow(7),
        thirty: zeroWindow(30),
      },
      dataMode: {
        dashboardOrdersLoaded: 0,
        dashboardOrdersAvailable: 0,
        customerOrdersLoaded: 0,
        customerOrdersAvailable: 0,
        dashboardIsSampled: false,
        customerAnalysisIsSampled: false,
        dashboardLimit: DASHBOARD_ORDERS_MAX,
        customerAnalysisLimit: CUSTOMER_360_ANALYSIS_MAX,
        lookbackDays,
      },
      scheduledReports: [],
      experiments: [],
      deliveryOverview: { total: 0, breakdown: [] },
      deliveryEvents: [],
      previewMode: devPreview,
    };
  }
  const latestOrder = await prisma.netCashOrder.findFirst({
    where: { shop },
    select: { updatedAt: true, createdAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const lastSyncAt = latestOrder?.updatedAt || latestOrder?.createdAt || null;
  const isSyncDue = !lastSyncAt || (Date.now() - new Date(lastSyncAt).getTime()) > syncIntervalMins * 60 * 1000;
  let syncEnqueued = false;

  if (isSyncDue && asyncOrderSyncEnabled) {
    try {
      const job = await enqueueJob({
        type: "shopify_order_sync",
        shop,
        payload: {
          shop,
        },
        uniqueKey: `shopify_order_sync:${shop}`,
        maxAttempts: 5,
      });
      syncEnqueued = Boolean(job?.id);
    } catch (error) {
      console.error("Failed to enqueue shopify_order_sync job:", error);
    }
  }

  const orderSourceFilter = includeAllSources ? {} : { marketingSource: { in: [...sourceFilterSet] } };
  const [ordersRaw, allOrdersRaw, totalOrdersInWindow, totalOrdersInLookback] = await Promise.all([
    getOrders(shop, days, { limit: DASHBOARD_ORDERS_MAX }),
    getOrders(shop, lookbackDays, { limit: CUSTOMER_360_ANALYSIS_MAX }),
    prisma.netCashOrder.count({
      where: {
        shop,
        createdAt: {
          gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
        },
        ...orderSourceFilter,
      },
    }),
    prisma.netCashOrder.count({
      where: {
        shop,
        createdAt: {
          gte: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000),
        },
        ...orderSourceFilter,
      },
    }),
  ]);
  const sourceOfOrder = (order) => String(order?.marketingSource || "unknown").toLowerCase();
  const orders = includeAllSources
    ? ordersRaw
    : ordersRaw.filter((order) => sourceFilterSet.has(sourceOfOrder(order)));
  const allOrders = includeAllSources
    ? allOrdersRaw
    : allOrdersRaw.filter((order) => sourceFilterSet.has(sourceOfOrder(order)));
  const { profiles: customerProfiles, byOrderId: customerHistoryByOrderId } = buildCustomerProfilesFromOrders(allOrders);
  const sourceMetricsAll = await getSourceMetrics(days);
  const sourceMetrics = includeAllSources
    ? sourceMetricsAll
    : sourceMetricsAll.filter((row) => sourceFilterSet.has(String(row.source || "").toLowerCase()));
  const spendHistoryAll = await getSpendEntries(days);
  const spendHistory = includeAllSources
    ? spendHistoryAll
    : spendHistoryAll.filter((row) => sourceFilterSet.has(String(row.source || "").toLowerCase()));
  const adSpendBySource = new Map(
    sourceMetrics.map((metric) => [metric.source.toLowerCase(), metric.adSpend || 0]),
  );
  const adSpend = sourceMetrics.reduce((sum, metric) => sum + (metric.adSpend || 0), 0);

  const totals = orders.reduce(
    (acc, order) => {
      acc.grossRevenue += order.grossValue || 0;
      acc.netCash += order.netCash || 0;
      return acc;
    },
    { grossRevenue: 0, netCash: 0 },
  );

  const roas = adSpend > 0 ? totals.grossRevenue / adSpend : 0;
  const realRoas = adSpend > 0 ? totals.netCash / adSpend : 0;
  const orderCount = orders.length;
  const discountTotal = orders.reduce((sum, row) => sum + Number(row.discountTotal || 0), 0);
  const refundTotal = orders.reduce((sum, row) => sum + Number(row.refundTotal || 0), 0);
  const rtoCount = orders.filter((row) => row.isRTO || row.rtoTotal > 0).length;
  const discountPct = totals.grossRevenue > 0 ? (discountTotal / totals.grossRevenue) * 100 : 0;
  const refundPct = totals.grossRevenue > 0 ? (refundTotal / totals.grossRevenue) * 100 : 0;
  const rtoPct = orderCount > 0 ? (rtoCount / orderCount) * 100 : 0;
  const attributionMissingCount = orders.filter(
    (row) => !row.utmSource && !row.campaignId && !row.campaignName && !row.clickId,
  ).length;
  const attributionGapPct = orderCount > 0 ? (attributionMissingCount / orderCount) * 100 : 0;
  const blendedRoas = realRoas;
  const netCashPerOrder = orderCount > 0 ? totals.netCash / orderCount : 0;
  const avgOrderValue = orderCount > 0 ? totals.grossRevenue / orderCount : 0;
  const profitMarginPct = totals.grossRevenue > 0 ? (totals.netCash / totals.grossRevenue) * 100 : 0;

  const sourceMap = new Map();
  for (const order of orders) {
    const source = (order.marketingSource || "unknown").toLowerCase();
    if (!sourceMap.has(source)) {
      sourceMap.set(source, { source, orders: 0, grossRevenue: 0, netCash: 0, adSpend: 0 });
    }
    const row = sourceMap.get(source);
    row.orders += 1;
    row.grossRevenue += order.grossValue || 0;
    row.netCash += order.netCash || 0;
  }

  for (const [source, spend] of adSpendBySource) {
    if (!sourceMap.has(source)) {
      sourceMap.set(source, { source, orders: 0, grossRevenue: 0, netCash: 0, adSpend: spend });
    }
  }

  for (const row of sourceMap.values()) {
    row.adSpend = adSpendBySource.get(row.source) || 0;
    row.roas = row.adSpend > 0 ? row.grossRevenue / row.adSpend : 0;
    row.realRoas = row.adSpend > 0 ? row.netCash / row.adSpend : 0;
  }

  const sourceBreakdown = [...sourceMap.values()].sort((a, b) => b.netCash - a.netCash);
  const availableSources = [...new Set([
    ...(sourceMetricsAll || []).map((row) => String(row.source || "").toLowerCase()),
    ...(allOrdersRaw || []).map((row) => String(row.marketingSource || "unknown").toLowerCase()),
  ])].filter(Boolean).sort();

  const riskOrders = orders.filter(
    (order) => order.isRTO || order.rtoTotal > 0 || order.isReturned || order.returnTotal > 0 || order.refundTotal > 0,
  );
  const rtoItemMap = new Map();
  const rtoPincodeMap = new Map();

  for (const order of riskOrders) {
    const pincode = String(order.shippingPincode || "unknown").trim() || "unknown";
    if (!rtoPincodeMap.has(pincode)) {
      rtoPincodeMap.set(pincode, { pincode, orders: 0, rtoOrders: 0, returnedOrders: 0, riskLoss: 0 });
    }
    const pincodeRow = rtoPincodeMap.get(pincode);
    pincodeRow.orders += 1;
    if (order.isRTO || order.rtoTotal > 0) pincodeRow.rtoOrders += 1;
    if (order.isReturned || order.returnTotal > 0 || order.refundTotal > 0) pincodeRow.returnedOrders += 1;
    pincodeRow.riskLoss += (order.rtoTotal || 0) + (order.returnTotal || 0) + (order.refundTotal || 0);

    for (const line of order.lineItems || []) {
      const key = `${line.title}__${line.variantTitle || ""}`;
      if (!rtoItemMap.has(key)) {
        rtoItemMap.set(key, {
          item: line.title,
          variant: line.variantTitle || "-",
          qtyAtRisk: 0,
          orders: 0,
          riskLoss: 0,
        });
      }
      const itemRow = rtoItemMap.get(key);
      itemRow.qtyAtRisk += Number(line.quantity || 0);
      itemRow.orders += 1;
      itemRow.riskLoss += (order.rtoTotal || 0) + (order.returnTotal || 0) + (order.refundTotal || 0);
    }
  }

  const highRtoItems = [...rtoItemMap.values()].sort((a, b) => b.riskLoss - a.riskLoss).slice(0, 10);
  const highRtoPincodes = [...rtoPincodeMap.values()]
    .map((row) => ({ ...row, rtoRate: row.orders > 0 ? (row.rtoOrders / row.orders) * 100 : 0 }))
    .sort((a, b) => b.rtoRate - a.rtoRate || b.riskLoss - a.riskLoss)
    .slice(0, 10);

  const now = new Date();
  const recentStart = new Date(now);
  recentStart.setDate(recentStart.getDate() - 3);
  const previousStart = new Date(now);
  previousStart.setDate(previousStart.getDate() - 6);

  const recentOrders = orders.filter((o) => new Date(o.createdAt) >= recentStart);
  const previousOrders = orders.filter((o) => {
    const d = new Date(o.createdAt);
    return d >= previousStart && d < recentStart;
  });

  const recentNet = recentOrders.reduce((sum, o) => sum + (o.netCash || 0), 0);
  const prevNet = previousOrders.reduce((sum, o) => sum + (o.netCash || 0), 0);
  const recentGross = recentOrders.reduce((sum, o) => sum + (o.grossValue || 0), 0);
  const prevGross = previousOrders.reduce((sum, o) => sum + (o.grossValue || 0), 0);
  const recentSpend = spendHistory
    .filter((s) => new Date(s.spendDate) >= recentStart)
    .reduce((sum, s) => sum + (s.adSpend || 0), 0);
  const prevSpend = spendHistory
    .filter((s) => {
      const d = new Date(s.spendDate);
      return d >= previousStart && d < recentStart;
    })
    .reduce((sum, s) => sum + (s.adSpend || 0), 0);

  const changePct = (current, previous) => {
    if (previous <= 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  };

  const alerts = [];
  const netChange = changePct(recentNet, prevNet);
  const grossChange = changePct(recentGross, prevGross);
  const spendChange = changePct(recentSpend, prevSpend);

  if (netChange <= -30) alerts.push(`Net cash dropped ${netChange.toFixed(1)}% vs prior 3 days`);
  if (grossChange <= -30) alerts.push(`Gross revenue dropped ${grossChange.toFixed(1)}% vs prior 3 days`);
  if (spendChange >= 40) alerts.push(`Ad spend increased ${spendChange.toFixed(1)}% vs prior 3 days`);

  const sourceAnomalyMap = new Map();
  const recentSourceOrders = orders.filter((order) => new Date(order.createdAt) >= recentStart);
  const previousSourceOrders = orders.filter((order) => {
    const d = new Date(order.createdAt);
    return d >= previousStart && d < recentStart;
  });
  const addSourceWindowMetric = (bucket, source, field, value) => {
    const key = String(source || "unknown").toLowerCase();
    if (!sourceAnomalyMap.has(key)) {
      sourceAnomalyMap.set(key, {
        source: key,
        recentSpend: 0,
        previousSpend: 0,
        recentGross: 0,
        previousGross: 0,
        recentNet: 0,
        previousNet: 0,
      });
    }
    sourceAnomalyMap.get(key)[`${bucket}${field}`] += value || 0;
  };

  for (const row of spendHistory) {
    const d = new Date(row.spendDate);
    const bucket = d >= recentStart ? "recent" : d >= previousStart && d < recentStart ? "previous" : null;
    if (!bucket) continue;
    addSourceWindowMetric(bucket, row.source, "Spend", row.adSpend || 0);
  }
  for (const row of recentSourceOrders) addSourceWindowMetric("recent", row.marketingSource, "Gross", row.grossValue || 0);
  for (const row of recentSourceOrders) addSourceWindowMetric("recent", row.marketingSource, "Net", row.netCash || 0);
  for (const row of previousSourceOrders) addSourceWindowMetric("previous", row.marketingSource, "Gross", row.grossValue || 0);
  for (const row of previousSourceOrders) addSourceWindowMetric("previous", row.marketingSource, "Net", row.netCash || 0);

  const campaignAnomalies = [];
  for (const row of sourceAnomalyMap.values()) {
    const recentRealRoas = row.recentSpend > 0 ? row.recentNet / row.recentSpend : 0;
    const previousRealRoas = row.previousSpend > 0 ? row.previousNet / row.previousSpend : 0;
    const spendSpikePct = row.previousSpend > 0 ? ((row.recentSpend - row.previousSpend) / row.previousSpend) * 100 : 0;
    const roasDropPct =
      previousRealRoas > 0 ? ((row.recentNet / Math.max(1, row.recentSpend || 1)) - previousRealRoas) / previousRealRoas * 100 : 0;

    if (spendSpikePct >= 50) {
      campaignAnomalies.push({
        source: row.source,
        type: "spend_spike",
        severity: spendSpikePct >= 100 ? "high" : "medium",
        message: `Spend spike: ${spendSpikePct.toFixed(1)}% vs prior 3 days`,
        why: `Recent spend ${money(row.recentSpend)} vs previous ${money(row.previousSpend)}`,
        confidence: row.previousSpend > 2000 ? "high" : "medium",
        support: [
          `Recent spend: ${money(row.recentSpend)}`,
          `Previous spend: ${money(row.previousSpend)}`,
          `Delta: ${spendSpikePct.toFixed(1)}%`,
        ],
      });
    }
    if (previousRealRoas > 0 && recentRealRoas <= previousRealRoas * 0.6 && row.recentSpend > 0) {
      campaignAnomalies.push({
        source: row.source,
        type: "roas_drop",
        severity: recentRealRoas < 1 ? "high" : "medium",
        message: `Real ROAS dropped ${Math.abs(roasDropPct).toFixed(1)}% (${previousRealRoas.toFixed(2)}x -> ${recentRealRoas.toFixed(2)}x)`,
        why: `Net cash did not keep pace with spend in the last 3 days`,
        confidence: row.recentSpend > 1500 ? "high" : "medium",
        support: [
          `Recent real ROAS: ${recentRealRoas.toFixed(2)}x`,
          `Previous real ROAS: ${previousRealRoas.toFixed(2)}x`,
          `Recent net cash: ${money(row.recentNet)}`,
        ],
      });
    }
  }

  const toTouchpoints = (order) => {
    const touches = [];
    if (order.marketingSource || order.campaignId || order.campaignName) {
      touches.push({
        source: order.marketingSource || "unknown",
        campaignId: order.campaignId || "",
        campaignName: order.campaignName || "",
      });
    }
    for (const attr of order.toolAttributions || []) {
      touches.push({
        source: attr.tool || "unknown",
        campaignId: attr.campaignId || "",
        campaignName: attr.campaignName || "",
      });
    }
    if (touches.length === 0) {
      touches.push({ source: "direct", campaignId: "", campaignName: "" });
    }
    return touches;
  };

  const aggregateModel = (modelName) => {
    const map = new Map();
    for (const order of orders) {
      const touches = toTouchpoints(order);
      let weights = [];
      if (modelName === "last_click") {
        weights = touches.map((_, idx) => (idx === touches.length - 1 ? 1 : 0));
      } else if (modelName === "first_click") {
        weights = touches.map((_, idx) => (idx === 0 ? 1 : 0));
      } else if (modelName === "time_decay") {
        const raw = touches.map((_, idx) => Math.pow(0.6, touches.length - idx - 1));
        const total = raw.reduce((sum, v) => sum + v, 0) || 1;
        weights = raw.map((v) => v / total);
      } else {
        const w = 1 / touches.length;
        weights = touches.map(() => w);
      }

      touches.forEach((touch, idx) => {
        const key = `${touch.source}|${touch.campaignId}|${touch.campaignName}`;
        if (!map.has(key)) {
          map.set(key, {
            source: touch.source,
            campaignId: touch.campaignId,
            campaignName: touch.campaignName,
            grossRevenue: 0,
            netCash: 0,
            orders: 0,
          });
        }
        const row = map.get(key);
        row.grossRevenue += (order.grossValue || 0) * weights[idx];
        row.netCash += (order.netCash || 0) * weights[idx];
        row.orders += weights[idx];
      });
    }
    return [...map.values()].sort((a, b) => b.netCash - a.netCash).slice(0, 8);
  };

  const attributionModels = {
    lastClick: aggregateModel("last_click"),
    firstClick: aggregateModel("first_click"),
    linear: aggregateModel("linear"),
    timeDecay: aggregateModel("time_decay"),
  };

  const paidOrders = orders.filter((o) => {
    const src = String(o.marketingSource || "").toLowerCase();
    return src && src !== "direct" && src !== "unknown";
  });
  const directOrders = orders.filter((o) => {
    const src = String(o.marketingSource || "").toLowerCase();
    return !src || src === "direct" || src === "unknown";
  });
  const paidNetAvg = paidOrders.length ? paidOrders.reduce((s, o) => s + (o.netCash || 0), 0) / paidOrders.length : 0;
  const directNetAvg = directOrders.length
    ? directOrders.reduce((s, o) => s + (o.netCash || 0), 0) / directOrders.length
    : 0;
  const estimatedIncrementalNet = Math.max(0, paidNetAvg - directNetAvg) * paidOrders.length;
  const estimatedUpliftPct = directNetAvg > 0 ? ((paidNetAvg - directNetAvg) / directNetAvg) * 100 : 0;

  const weekKey = (dateValue) => {
    const d = new Date(dateValue);
    const day = d.getDay();
    const diff = (day + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  };

  const cohortMap = new Map();
  for (const order of orders) {
    const key = weekKey(order.createdAt);
    if (!cohortMap.has(key)) {
      cohortMap.set(key, {
        cohortWeek: key,
        paidOrders: 0,
        directOrders: 0,
        paidNetTotal: 0,
        directNetTotal: 0,
      });
    }
    const cohort = cohortMap.get(key);
    const src = String(order.marketingSource || "").toLowerCase();
    const isPaid = src && src !== "direct" && src !== "unknown";
    if (isPaid) {
      cohort.paidOrders += 1;
      cohort.paidNetTotal += order.netCash || 0;
    } else {
      cohort.directOrders += 1;
      cohort.directNetTotal += order.netCash || 0;
    }
  }

  const cohortIncrementality = [...cohortMap.values()]
    .map((cohort) => {
      const paidAvg = cohort.paidOrders > 0 ? cohort.paidNetTotal / cohort.paidOrders : 0;
      const directAvg = cohort.directOrders > 0 ? cohort.directNetTotal / cohort.directOrders : 0;
      const incrementalNet = Math.max(0, paidAvg - directAvg) * cohort.paidOrders;
      const upliftPct = directAvg > 0 ? ((paidAvg - directAvg) / directAvg) * 100 : 0;
      return {
        ...cohort,
        paidAvg,
        directAvg,
        incrementalNet,
        upliftPct,
      };
    })
    .sort((a, b) => b.cohortWeek.localeCompare(a.cohortWeek))
    .slice(0, 8);

  const dashboardPreference = await getDashboardPreference(shop);
  const connectorCredentials = await listConnectorCredentials(shop);
  const recentConnectorRuns = await getRecentConnectorSyncRuns(shop, 20);
  const lastConnectorSuccess = (recentConnectorRuns || []).find((row) => row.status === "success") || null;
  const lastConnectorFailure = (recentConnectorRuns || []).find((row) => row.status === "failed") || null;
  const campaignPerformance = await getCampaignPerformance(
    shop,
    days,
    includeAllSources ? "all" : [...sourceFilterSet],
  );
  const creativeFatigue = await getCreativeFatigueRisks(shop, days, "all");
  const stopCampaigns = (campaignPerformance?.rows || [])
    .filter((row) => row.orders >= 1 && (row.realRoas < 1 || row.netCash < 0))
    .sort((a, b) => {
      if (a.realRoas !== b.realRoas) return a.realRoas - b.realRoas;
      return a.netCash - b.netCash;
    })
    .slice(0, 8);

  let savedLayout = null;
  try {
    savedLayout = dashboardPreference?.layout ? JSON.parse(dashboardPreference.layout) : null;
  } catch {
    savedLayout = null;
  }

  const hasMetaConnector = connectorCredentials.some((row) => row.provider === "meta_ads" && row.accessToken);
  const hasGoogleConnector = connectorCredentials.some((row) => row.provider === "google_ads" && row.accessToken);

  const benchmarkSpendAll = await getSpendEntries(120);
  const benchmarkSpend = includeAllSources
    ? benchmarkSpendAll
    : benchmarkSpendAll.filter((row) => sourceFilterSet.has(String(row.source || "").toLowerCase()));
  let deliveryOverview = { total: 0, breakdown: [] };
  let deliveryEvents = [];
  try {
    [deliveryOverview, deliveryEvents] = await Promise.all([
      getDeliveryOverview(shop),
      getLatestDeliveryEvents(shop, 8),
    ]);
  } catch (error) {
    deliveryOverview = { total: 0, breakdown: [] };
    deliveryEvents = [];
  }
  const compareWindow = (windowDays) => {
    const nowTs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const currentStart = nowTs - windowDays * dayMs;
    const prevStart = nowTs - windowDays * 2 * dayMs;
    const currentOrders = allOrders.filter((o) => new Date(o.createdAt).getTime() >= currentStart);
    const prevOrders = allOrders.filter((o) => {
      const ts = new Date(o.createdAt).getTime();
      return ts >= prevStart && ts < currentStart;
    });
    const currentNet = currentOrders.reduce((sum, o) => sum + Number(o.netCash || 0), 0);
    const prevNet = prevOrders.reduce((sum, o) => sum + Number(o.netCash || 0), 0);
    const currentSpend = benchmarkSpend
      .filter((s) => new Date(s.spendDate).getTime() >= currentStart)
      .reduce((sum, s) => sum + Number(s.adSpend || 0), 0);
    const prevSpend = benchmarkSpend
      .filter((s) => {
        const ts = new Date(s.spendDate).getTime();
        return ts >= prevStart && ts < currentStart;
      })
      .reduce((sum, s) => sum + Number(s.adSpend || 0), 0);
    const currentRoas = currentSpend > 0 ? currentNet / currentSpend : 0;
    const prevRoas = prevSpend > 0 ? prevNet / prevSpend : 0;
    const weekdayCurrentAvg =
      currentOrders.length > 0 ? currentOrders.reduce((sum, o) => sum + Number(o.netCash || 0), 0) / currentOrders.length : 0;
    const weekdayPrevAvg =
      prevOrders.length > 0 ? prevOrders.reduce((sum, o) => sum + Number(o.netCash || 0), 0) / prevOrders.length : 0;
    return {
      windowDays,
      currentNet,
      prevNet,
      netDeltaPct: prevNet > 0 ? ((currentNet - prevNet) / prevNet) * 100 : 0,
      currentRoas,
      prevRoas,
      roasDeltaPct: prevRoas > 0 ? ((currentRoas - prevRoas) / prevRoas) * 100 : 0,
      weekdayMixDeltaPct: weekdayPrevAvg > 0 ? ((weekdayCurrentAvg - weekdayPrevAvg) / weekdayPrevAvg) * 100 : 0,
    };
  };

  const shopConfig = await resolveShopConfig(shop, { growth_experiment_log: "[]" });
  const experimentSnapshot = await buildSnapshot(shop, 30);
  const experiments = safeJsonParse(shopConfig.growth_experiment_log, []).map((row) => {
    const baseline = row.baseline || null;
    if (!baseline) return row;
    const deltaNet = experimentSnapshot.net - baseline.net;
    const deltaRoas = experimentSnapshot.blendedRoas - baseline.blendedRoas;
    const deltaMargin = experimentSnapshot.marginPct - baseline.marginPct;
    return {
      ...row,
      current: experimentSnapshot,
      delta: {
        net: deltaNet,
        blendedRoas: deltaRoas,
        marginPct: deltaMargin,
      },
    };
  });

  return {
    shop,
    planContext,
    sync: {
      asyncOrderSyncEnabled,
      enqueued: syncEnqueued,
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      intervalMinutes: syncIntervalMins,
    },
    days,
    defaultSpendDate: new Date().toISOString().slice(0, 10),
    orders,
    metrics: {
      grossRevenue: totals.grossRevenue,
      netCash: totals.netCash,
      adSpend,
      roas,
      realRoas,
      blendedRoas,
      orderCount,
      netCashPerOrder,
      avgOrderValue,
      profitMarginPct,
      attributionGapPct,
      rtoPct,
      refundPct,
      discountPct,
      creativeFatigueCount: Array.isArray(creativeFatigue) ? creativeFatigue.length : 0,
    },
      sourceBreakdown,
      selectedSources: normalizedSelectedSources,
      availableSources,
      customerProfiles,
    customerHistoryByOrderId,
    highRtoItems,
    highRtoPincodes,
    spendHistory,
    alerts,
    campaignAnomalies,
    attributionModels,
    incrementality: {
      paidOrders: paidOrders.length,
      directOrders: directOrders.length,
      paidNetAvg,
      directNetAvg,
      estimatedIncrementalNet,
      estimatedUpliftPct,
      cohorts: cohortIncrementality,
    },
    savedLayout,
    stopCampaigns,
    permissions: {
      hasMetaConnector,
      hasGoogleConnector,
    },
    connectorSnapshotFallback: {
      lastSuccessAt: lastConnectorSuccess?.createdAt || null,
      lastSuccessProvider: lastConnectorSuccess?.provider || null,
      lastFailedAt: lastConnectorFailure?.createdAt || null,
      lastFailedProvider: lastConnectorFailure?.provider || null,
    },
    benchmarkMode: {
      seven: compareWindow(7),
      thirty: compareWindow(30),
    },
    dataMode: {
      dashboardOrdersLoaded: orders.length,
      dashboardOrdersAvailable: Number(totalOrdersInWindow || 0),
      customerOrdersLoaded: allOrders.length,
      customerOrdersAvailable: Number(totalOrdersInLookback || 0),
      dashboardIsSampled: Number(totalOrdersInWindow || 0) > orders.length,
      customerAnalysisIsSampled: Number(totalOrdersInLookback || 0) > allOrders.length,
      dashboardLimit: DASHBOARD_ORDERS_MAX,
      customerAnalysisLimit: CUSTOMER_360_ANALYSIS_MAX,
      lookbackDays,
    },
    scheduledReports: await listReportSchedules(shop, "home"),
    experiments,
    deliveryOverview,
    deliveryEvents,
    previewMode: devPreview,
  };
}

function money(value) {
  return `INR ${Number(value || 0).toLocaleString()}`;
}

function wilsonCi(successes, total, z = 1.96) {
  const n = Math.max(0, Number(total || 0));
  if (n <= 0) return { low: 0, high: 0, mean: 0 };
  const s = Math.max(0, Math.min(n, Number(successes || 0)));
  const p = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    mean: p,
  };
}

function normalCi(mean, stdDev, n, z = 1.96) {
  const safeN = Math.max(1, Number(n || 0));
  const safeStd = Math.max(0, Number(stdDev || 0));
  const margin = z * (safeStd / Math.sqrt(safeN));
  return {
    low: mean - margin,
    high: mean + margin,
    mean,
  };
}

function parseTouchpoints(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function landingPathType(value) {
  if (!value) return "unknown";
  try {
    const path = new URL(value, "https://example.com").pathname || "";
    const normalized = path.toLowerCase();
    if (!normalized || normalized === "/") return "home";
    if (normalized.startsWith("/products/")) return "product";
    if (normalized.startsWith("/collections/")) return "collection";
    if (normalized.startsWith("/pages/")) return "page";
    return "other";
  } catch {
    return "unknown";
  }
}

function touchpointSources(order) {
  const sources = new Set();
  const base = String(order?.marketingSource || "").toLowerCase();
  if (base) sources.add(base);
  for (const touch of parseTouchpoints(order?.touchpointsJson)) {
    const source = String(touch?.source || touch?.tool || "").toLowerCase();
    if (source) sources.add(source);
  }
  return sources;
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function buildCustomerTimeline(order) {
  const timeline = [
    {
      type: "order_created",
      title: "Order Created",
      time: order.createdAt,
      detail: `Order #${order.orderNumber} created with gross value ${money(order.grossValue)}`,
    },
  ];

  if (order.firstClickSource || order.firstClickCampaignId || order.firstClickCampaignName) {
    timeline.push({
      type: "first_click",
      title: "First Click Attribution",
      time: order.createdAt,
      detail: `${order.firstClickSource || "-"} | ${order.firstClickCampaignName || "-"} | ${order.firstClickCampaignId || "-"}`,
    });
  }

  if (order.lastClickSource || order.lastClickCampaignId || order.lastClickCampaignName) {
    timeline.push({
      type: "last_click",
      title: "Last Click Attribution",
      time: order.createdAt,
      detail: `${order.lastClickSource || "-"} | ${order.lastClickCampaignName || "-"} | ${order.lastClickCampaignId || "-"}`,
    });
  }

  for (const touch of parseTouchpoints(order.touchpointsJson)) {
    timeline.push({
      type: "touchpoint",
      title: "Touchpoint",
      time: touch.occurredAt || order.createdAt,
      detail: `${touch.source || "unknown"} | ${touch.campaignName || "-"} | ${touch.campaignId || "-"}`,
    });
  }

  for (const touch of order.toolAttributions || []) {
    timeline.push({
      type: "tool_touch",
      title: `Tool Attribution (${touch.tool || "unknown"})`,
      time: touch.createdAt || order.createdAt,
      detail: `${touch.campaignName || "-"} | ${touch.campaignId || "-"} | ${touch.adSetId || "-"} | ${touch.adId || "-"}`,
    });
  }

  if (order.refundTotal > 0) {
    timeline.push({
      type: "refund",
      title: "Refund Recorded",
      time: order.updatedAt || order.createdAt,
      detail: `Refund amount: ${money(order.refundTotal)}`,
    });
  }
  if (order.returnTotal > 0 || order.isReturned) {
    timeline.push({
      type: "return",
      title: "Return Recorded",
      time: order.updatedAt || order.createdAt,
      detail: `Return loss: ${money(order.returnTotal || 0)}`,
    });
  }
  if (order.rtoTotal > 0 || order.isRTO) {
    timeline.push({
      type: "rto",
      title: "RTO Recorded",
      time: order.updatedAt || order.createdAt,
      detail: `RTO loss: ${money(order.rtoTotal || 0)}`,
    });
  }
  if (order.exchangeAdjustment !== 0) {
    timeline.push({
      type: "exchange",
      title: "Exchange Adjustment",
      time: order.updatedAt || order.createdAt,
      detail: `Adjustment: ${money(order.exchangeAdjustment)}`,
    });
  }

  return timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function getTimelineBadge(eventType) {
  const key = String(eventType || "").toLowerCase();
  if (key === "order_created") return { label: "Conversion", className: "nc-badge-conversion" };
  if (key === "first_click" || key === "last_click" || key === "touchpoint" || key === "tool_touch") {
    return { label: "Attribution", className: "nc-badge-attribution" };
  }
  if (key === "refund" || key === "return") return { label: "Return", className: "nc-badge-return" };
  if (key === "rto") return { label: "RTO", className: "nc-badge-rto" };
  if (key === "exchange") return { label: "Exchange", className: "nc-badge-exchange" };
  return { label: "Event", className: "nc-badge-default" };
}

export default function Index() {
  const location = useLocation();
  const revalidator = useRevalidator();
  const {
    shop,
    planContext,
    days,
    defaultSpendDate,
    orders,
    metrics,
    sourceBreakdown,
    selectedSources: selectedSourcesFromLoader,
    availableSources,
    customerProfiles,
    customerHistoryByOrderId,
    highRtoItems,
    highRtoPincodes,
    spendHistory,
    alerts,
    campaignAnomalies,
    attributionModels,
    incrementality,
    savedLayout,
    stopCampaigns,
    permissions,
    deliveryOverview,
    deliveryEvents,
      connectorSnapshotFallback,
      benchmarkMode,
      dataMode,
      scheduledReports,
      experiments,
      previewMode,
    } = useLoaderData();
  const tierKey = String(planContext?.tier || "basic").toLowerCase();
  const tierLabelMap = { basic: "Starter", pro: "Pro", premium: "Premium" };
  const tierLabel = (tierLabelMap[tierKey] || "Starter").toUpperCase();
  const hasPro =
    !!planContext?.hasPro ||
    !!planContext?.hasPremium ||
    String(planContext?.tier || "").toLowerCase() === "premium";
  const hasPremium =
    !!planContext?.hasPremium ||
    String(planContext?.tier || "").toLowerCase() === "premium";
  const [expandedOrderId, setExpandedOrderId] = useState(null);
  const [selectedOrder360Id, setSelectedOrder360Id] = useState(null);
  const layoutSaver = useFetcher();
  const scheduleFetcher = useFetcher();
  const embeddedPassthroughQuery = getEmbeddedPassthrough(location.search);
  const withEmbedded = useCallback((href) => withEmbeddedContext(href, embeddedPassthroughQuery), [embeddedPassthroughQuery]);
  const [layout, setLayout] = useState({
    ai: true,
    alerts: true,
    attribution: true,
    incrementality: true,
    stopCampaigns: false,
    anomalies: false,
    sourceBreakdown: false,
    spendHistory: false,
    orders: true,
    ...(savedLayout || {}),
  });
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  const [dashboardView, setDashboardView] = useState("overview");
  const [dashboardPreset, setDashboardPreset] = useState("founder");
  const [presetToast, setPresetToast] = useState("");
  const [densityMode, setDensityMode] = useState("auto");
  const [tableDensity, setTableDensity] = useState("comfortable");
  const [goalTargets, setGoalTargets] = useState({ netCash: 500000, roas: 3, cac: 800 });
  const [benchmarkWindow, setBenchmarkWindow] = useState("seven");
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [savedViews, setSavedViews] = useState([]);
  const [viewDraftName, setViewDraftName] = useState("");
  const [savedReports, setSavedReports] = useState(Array.isArray(scheduledReports) ? scheduledReports : []);
  const [reportDraft, setReportDraft] = useState({ name: "", frequency: "weekly", email: "" });
  const [customerColumns, setCustomerColumns] = useState({
    contact: true,
    nextWindow: true,
  });
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [installPromptOpen, setInstallPromptOpen] = useState(false);
  const planMenuButtonRef = useRef(null);
  const refreshButtonRef = useRef(null);
  const [visibleOrdersCount, setVisibleOrdersCount] = useState(100);
  const [sourceSearch, setSourceSearch] = useState("");
  const [multiSourceOpen, setMultiSourceOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState(selectedSourcesFromLoader || ["all"]);
  const navigate = useNavigate();
  const isOverviewView = dashboardView === "overview";
  const isActionsView = dashboardView === "operations";
  const isDeepDiveView = dashboardView === "insights";
  const experimentRows = Array.isArray(experiments) ? experiments : [];
  const savedViewsKey = `nc_home_saved_views_${String(shop || "global").toLowerCase()}`;
  const applyViewSessionKey = `nc_home_apply_view_${String(shop || "global").toLowerCase()}`;
  const defaultLandingKey = `nc_default_landing_${String(shop || "global").toLowerCase()}`;

  const sourceOptions = [...new Set((availableSources || []).map((row) => String(row || "").toLowerCase()).filter(Boolean))].sort();
  const isAllSources = selectedSources.includes("all");
  const updateSourcesInUrl = (nextSources) => {
    const params = new URLSearchParams(location.search);
    params.set("sources", (nextSources || ["all"]).join(","));
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };
  const toggleSource = (item) => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) return;
    if (normalized === "all") {
      setSelectedSources(["all"]);
      updateSourcesInUrl(["all"]);
      return;
    }
    const current = isAllSources ? [] : [...selectedSources];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((row) => row !== normalized) : [...current, normalized];
    const finalNext = next.length ? next : ["all"];
    setSelectedSources(finalNext);
    updateSourcesInUrl(finalNext);
  };
  const filteredSourceOptions = sourceOptions.filter((item) =>
    item.includes(String(sourceSearch || "").toLowerCase()));
  const singleSourceValue =
    isAllSources ? "all" : selectedSources.length === 1 ? selectedSources[0] : "custom";
  const displaySourceBreakdown = isAllSources
    ? (sourceBreakdown || [])
    : (sourceBreakdown || []).filter((row) => selectedSources.includes(String(row?.source || "").toLowerCase()));
  const displayCampaignAnomalies = isAllSources
    ? (campaignAnomalies || [])
    : (campaignAnomalies || []).filter((row) => selectedSources.includes(String(row?.source || "").toLowerCase()));

  useEffect(() => {
    if (!layoutHydrated) {
      setLayoutHydrated(true);
      return;
    }
    const form = new FormData();
    form.append("intent", "save-layout");
    form.append("layout", JSON.stringify(layout));
    form.append("days", String(days));
    layoutSaver.submit(form, { method: "post" });
  }, [days, layout, layoutHydrated, layoutSaver]);

  useEffect(() => {
    setShowSkeleton(true);
    const timer = setTimeout(() => setShowSkeleton(false), 320);
    return () => clearTimeout(timer);
  }, [days]);
  useEffect(() => {
    setSelectedSources(selectedSourcesFromLoader || ["all"]);
  }, [selectedSourcesFromLoader]);
  useEffect(() => {
    const handler = (event) => {
      const x = event.clientX;
      const y = event.clientY;
      const within = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      };
      if (within(planMenuButtonRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        const target = withEmbedded("/app/pricing");
        window.location.href = target;
      } else if (within(refreshButtonRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        trackUiEvent("refresh_clicked", { page: "home" });
        revalidator.revalidate();
      }
    };
    window.addEventListener("pointerdown", handler, true);
    window.addEventListener("click", handler, true);
    document.addEventListener("pointerdown", handler, true);
    document.addEventListener("click", handler, true);
    return () => {
      window.removeEventListener("pointerdown", handler, true);
      window.removeEventListener("click", handler, true);
      document.removeEventListener("pointerdown", handler, true);
      document.removeEventListener("click", handler, true);
    };
  }, [revalidator, withEmbedded]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedPreset = window.localStorage.getItem("nc_home_preset");
    if (savedPreset) setDashboardPreset(savedPreset);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = JSON.parse(window.localStorage.getItem(savedViewsKey) || "[]");
    if (Array.isArray(saved)) setSavedViews(saved.slice(0, 20));
  }, [savedViewsKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedGoals = JSON.parse(window.localStorage.getItem("nc_goal_targets") || "null");
    if (savedGoals && typeof savedGoals === "object") {
      setGoalTargets((current) => ({
        ...current,
        netCash: Number(savedGoals.netCash || current.netCash),
        roas: Number(savedGoals.roas || current.roas),
        cac: Number(savedGoals.cac || current.cac),
      }));
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 980px)");
    const readMode = () => {
      const saved = String(window.localStorage.getItem("nc_density_mode") || "auto").toLowerCase();
      return saved === "compact" || saved === "comfortable" ? saved : "auto";
    };
    const apply = (forcedMode) => {
      const mode = forcedMode || readMode();
      setDensityMode(mode);
      setTableDensity(mode === "auto" ? (media.matches ? "compact" : "comfortable") : mode);
    };
    apply();
    const onDensityChange = (event) => apply(event?.detail?.mode);
    media.addEventListener("change", apply);
    window.addEventListener("nc-density-change", onDensityChange);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("nc-density-change", onDensityChange);
    };
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("nc_goal_targets", JSON.stringify(goalTargets));
  }, [goalTargets]);
  useEffect(() => {
    if (Array.isArray(scheduledReports)) setSavedReports(scheduledReports);
  }, [scheduledReports]);
  useEffect(() => {
    if (scheduleFetcher.state !== "idle") return;
    if (!scheduleFetcher.data?.ok || !scheduleFetcher.data?.schedule) return;
    setSavedReports((current) => [scheduleFetcher.data.schedule, ...current].slice(0, 20));
    setPresetToast(`Scheduled ${scheduleFetcher.data.schedule.frequency} export`);
    setTimeout(() => setPresetToast(""), 1400);
  }, [scheduleFetcher.state, scheduleFetcher.data]);

  const applyPreset = (preset) => {
    setDashboardPreset(preset);
    if (typeof window !== "undefined") window.localStorage.setItem("nc_home_preset", preset);
    trackUiEvent("preset_changed", { page: "home", preset });
    const labels = { founder: "Founder", growth: "Growth", ops: "Ops", crm: "CRM Manager" };
    setPresetToast(`${labels[preset] || "Preset"} preset applied`);
    setTimeout(() => setPresetToast(""), 1400);
    if (preset === "founder") {
      setDashboardView("overview");
      setCustomerColumns({ contact: true, nextWindow: true });
    } else if (preset === "growth") {
      setDashboardView("insights");
      setCustomerColumns({ contact: false, nextWindow: true });
    } else if (preset === "crm") {
      setDashboardView("insights");
      setCustomerColumns({ contact: true, nextWindow: true });
    } else {
      setDashboardView("operations");
      setCustomerColumns({ contact: true, nextWindow: false });
    }
  };
  const exportCsvFile = (filename, rows) => {
    if (typeof window === "undefined") return;
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const applyDensityMode = (mode) => {
    const normalized = mode === "compact" || mode === "comfortable" ? mode : "auto";
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nc_density_mode", normalized);
      window.dispatchEvent(new CustomEvent("nc-density-change", { detail: { mode: normalized } }));
    }
    setDensityMode(normalized);
  };
  const sectionViews = {
    alerts: ["overview"],
    anomalies: [],
    attribution: [],
    stopCampaigns: [],
    incrementality: [],
    sourceBreakdown: [],
    spendHistory: [],
    orders: [],
  };

  const isSectionVisible = (key) => layout[key] && sectionViews[key]?.includes(dashboardView);
  const getCampaignSeverity = (row) => {
    if (row.netCash < 0) return { label: "High", reason: "Negative net cash", className: "nc-risk-high" };
    if (row.realRoas < 0.75) return { label: "High", reason: "Real ROAS below 0.75x", className: "nc-risk-high" };
    if (row.realRoas < 1) return { label: "Medium", reason: "Real ROAS below 1x", className: "nc-risk-medium" };
    return { label: "Watch", reason: "Low efficiency trend", className: "nc-risk-watch" };
  };
  const selectedOrder360 = orders.find((order) => order.id === selectedOrder360Id) || null;
  const highValueCustomers = (customerProfiles || []).filter((row) => row.ltvTier === "gold").slice(0, 10);
  const customerTableColSpan = 3 + (customerColumns.contact ? 1 : 0) + (customerColumns.nextWindow ? 1 : 0);
  const latestOrderAtMs = (orders || []).reduce((max, row) => {
    const ts = row?.createdAt ? new Date(row.createdAt).getTime() : 0;
    return Number.isFinite(ts) ? Math.max(max, ts) : max;
  }, 0);
  const syncedMins = latestOrderAtMs ? Math.floor((Date.now() - latestOrderAtMs) / (1000 * 60)) : null;
  const formatSyncAge = (mins) => {
    if (mins == null) return "No recent sync";
    if (mins < 1) return "Synced just now";
    if (mins < 60) return `Synced ${mins}m ago`;
    if (mins < 1440) return `Synced ${Math.floor(mins / 60)}h ago`;
    if (mins < 10080) return `Synced ${Math.floor(mins / 1440)}d ago`;
    return `Synced ${Math.floor(mins / 10080)}w ago`;
  };
  const syncStatus = syncedMins == null ? "unknown" : syncedMins < 15 ? "fresh" : syncedMins < 120 ? "aging" : "stale";
  const syncBadgeClass = `nc-fresh-badge nc-sync-${syncStatus}`;
  const syncLabel = formatSyncAge(syncedMins);
  const syncTitle = latestOrderAtMs ? `Exact sync: ${new Date(latestOrderAtMs).toLocaleString()}` : "No sync timestamp";
  const totalOrdersCount = Number(orders?.length || 0);
  const mappedOrdersCount = Number((sourceBreakdown || []).filter((row) => row.source !== "unmapped").reduce((sum, row) => sum + Number(row.orders || 0), 0));
  const utmMappedPct = totalOrdersCount ? (orders.filter((row) => row.campaignId || row.campaignName).length / totalOrdersCount) * 100 : 0;
  const attributionCoveragePct = totalOrdersCount ? (mappedOrdersCount / totalOrdersCount) * 100 : 0;
  const fullUtmCount = (orders || []).filter((row) => row.utmSource && row.utmMedium && row.utmCampaign).length;
  const clickIdCount = (orders || []).filter((row) => !!row.clickId).length;
  const firstPartySignalCount = (orders || []).filter((row) => !!row.landingSite || !!row.referringSite || !!row.clickId).length;
  const touchpointRichCount = (orders || []).filter((row) => parseTouchpoints(row.touchpointsJson).length >= 2).length;
  const paidOrdersWithLanding = (orders || []).filter((row) => {
    const source = String(row?.marketingSource || "").toLowerCase();
    const isPaid = source && source !== "direct" && source !== "unknown";
    return isPaid && row?.landingSite;
  });
  const landingMismatchCount = paidOrdersWithLanding.filter((row) => {
    const type = landingPathType(row.landingSite);
    return type === "home" || type === "other";
  }).length;
  const landingMismatchPct = paidOrdersWithLanding.length
    ? (landingMismatchCount / paidOrdersWithLanding.length) * 100
    : 0;
  const multiSourceTouchpointCount = (orders || []).filter((row) => touchpointSources(row).size > 1).length;
  const multiSourceTouchpointPct = totalOrdersCount
    ? (multiSourceTouchpointCount / totalOrdersCount) * 100
    : 0;
  const unattributedOrdersCount = Math.max(0, totalOrdersCount - mappedOrdersCount);
  const attributedNetCash = (orders || [])
    .filter((row) => row.campaignId || row.campaignName || row.clickId || parseTouchpoints(row.touchpointsJson).length > 0)
    .reduce((sum, row) => sum + Number(row.netCash || 0), 0);
  const unattributedNetCash = Math.max(0, Number(metrics?.netCash || 0) - attributedNetCash);
  const fullUtmPct = totalOrdersCount ? (fullUtmCount / totalOrdersCount) * 100 : 0;
  const clickIdPct = totalOrdersCount ? (clickIdCount / totalOrdersCount) * 100 : 0;
  const firstPartySignalPct = totalOrdersCount ? (firstPartySignalCount / totalOrdersCount) * 100 : 0;
  const touchpointRichPct = totalOrdersCount ? (touchpointRichCount / totalOrdersCount) * 100 : 0;
  const dataDepthScore = Math.max(
    0,
    Math.min(100, (fullUtmPct * 0.25) + (clickIdPct * 0.3) + (firstPartySignalPct * 0.25) + (touchpointRichPct * 0.2)),
  );
  const freshDataScore = syncedMins == null ? 25 : Math.max(0, 100 - Math.min(100, syncedMins));
  const truthConfidenceScore = Math.max(
    0,
    Math.min(100, (attributionCoveragePct * 0.4) + (dataDepthScore * 0.35) + (freshDataScore * 0.25)),
  );
  const dominantSourceSharePct = Number(metrics?.netCash || 0) > 0
    ? ((Number(sourceBreakdown?.[0]?.netCash || 0) / Number(metrics.netCash)) * 100)
    : 0;
  const totalRiskLoss = Number((orders || []).reduce((sum, row) => sum + Number(row.returnTotal || 0) + Number(row.rtoTotal || 0) + Number(row.refundTotal || 0), 0));
  const grossSafe = Math.max(1, Number(metrics?.grossRevenue || 0));
  const cashLeakagePct = (totalRiskLoss / grossSafe) * 100;
  const customerOrderCounts = new Map();
  for (const row of orders || []) {
    const key = normalizeCustomerKey(row);
    if (!key) continue;
    customerOrderCounts.set(key, (customerOrderCounts.get(key) || 0) + 1);
  }
  const repeatOrdersCount = (orders || []).filter((row) => {
    const key = normalizeCustomerKey(row);
    return key ? (customerOrderCounts.get(key) || 0) > 1 : false;
  }).length;
  const riskOrdersCount = (orders || []).filter((row) => row.isRTO || row.rtoTotal > 0 || row.isReturned || row.returnTotal > 0 || row.refundTotal > 0).length;
  const repeatOrderSharePct = totalOrdersCount > 0 ? (repeatOrdersCount / totalOrdersCount) * 100 : 0;
  const burnVsCashRatio = Number(metrics?.netCash || 0) > 0 ? Number(metrics?.adSpend || 0) / Number(metrics.netCash) : 0;
  const repeatShareCi = wilsonCi(repeatOrdersCount, totalOrdersCount);
  const riskShareCi = wilsonCi(riskOrdersCount, totalOrdersCount);
  const dailyNetByDay = new Map();
  for (const row of orders || []) {
    const dayKey = new Date(row.createdAt).toISOString().slice(0, 10);
    dailyNetByDay.set(dayKey, (dailyNetByDay.get(dayKey) || 0) + Number(row.netCash || 0));
  }
  const dailyNetSeries = [...dailyNetByDay.values()];
  const meanDailyNet = dailyNetSeries.length ? dailyNetSeries.reduce((sum, value) => sum + value, 0) / dailyNetSeries.length : 0;
  const varianceDailyNet = dailyNetSeries.length > 1
    ? dailyNetSeries.reduce((sum, value) => sum + Math.pow(value - meanDailyNet, 2), 0) / (dailyNetSeries.length - 1)
    : 0;
  const stdDailyNet = Math.sqrt(Math.max(0, varianceDailyNet));
  const next7dNetMean = meanDailyNet * 7;
  const next7dNetCi = normalCi(next7dNetMean, stdDailyNet * Math.sqrt(7), Math.max(1, dailyNetSeries.length));
  const predictiveModels = [
    {
      label: "Next 7d Net Cash",
      value: money(next7dNetMean),
      range: `${money(next7dNetCi.low)} to ${money(next7dNetCi.high)} (95% CI)`,
      status: next7dNetMean >= 0 ? "strong" : "risk",
    },
    {
      label: "Repeat Order Probability",
      value: `${(repeatShareCi.mean * 100).toFixed(1)}%`,
      range: `${(repeatShareCi.low * 100).toFixed(1)}% to ${(repeatShareCi.high * 100).toFixed(1)}% (95% CI)`,
      status: repeatShareCi.mean >= 0.35 ? "strong" : repeatShareCi.mean >= 0.2 ? "watch" : "risk",
    },
    {
      label: "Return/RTO Risk Probability",
      value: `${(riskShareCi.mean * 100).toFixed(1)}%`,
      range: `${(riskShareCi.low * 100).toFixed(1)}% to ${(riskShareCi.high * 100).toFixed(1)}% (95% CI)`,
      status: riskShareCi.mean <= 0.1 ? "strong" : riskShareCi.mean <= 0.18 ? "watch" : "risk",
    },
  ];
  const premiumSignals = [
    {
      label: "Truth Confidence",
      value: `${truthConfidenceScore.toFixed(0)} / 100`,
      detail: "Blends attribution coverage, signal depth, and sync freshness.",
      status: truthConfidenceScore >= 75 ? "strong" : truthConfidenceScore >= 55 ? "watch" : "risk",
    },
    {
      label: "Cash Leakage",
      value: `${cashLeakagePct.toFixed(1)}%`,
      detail: `${money(totalRiskLoss)} lost to returns/RTO/refunds in selected window.`,
      status: cashLeakagePct <= 8 ? "strong" : cashLeakagePct <= 14 ? "watch" : "risk",
    },
    {
      label: "Repeat Revenue Engine",
      value: `${repeatOrderSharePct.toFixed(0)}%`,
      detail: `${repeatOrdersCount} repeat orders out of ${totalOrdersCount}. 95% CI ${(repeatShareCi.low * 100).toFixed(1)}-${(repeatShareCi.high * 100).toFixed(1)}%.`,
      status: repeatOrderSharePct >= 35 ? "strong" : repeatOrderSharePct >= 20 ? "watch" : "risk",
    },
    {
      label: "Burn vs Net Cash",
      value: `${burnVsCashRatio.toFixed(2)}x`,
      detail: "Ad spend as a multiple of net cash in current period.",
      status: burnVsCashRatio <= 0.8 ? "strong" : burnVsCashRatio <= 1.2 ? "watch" : "risk",
    },
  ];
  const metaOrders = (orders || []).filter((row) => {
    const src = String(row?.marketingSource || "").toLowerCase();
    return src.includes("meta") || src.includes("facebook") || src.includes("instagram");
  });
  const metaOrdersCount = metaOrders.length;
  const metaSignalOrders = metaOrders.filter((row) =>
    !!row.clickId ||
    !!row.campaignId ||
    !!row.campaignName ||
    parseTouchpoints(row.touchpointsJson).length > 0 ||
    (row.toolAttributions || []).length > 0,
  ).length;
  const metaSignalCoveragePct = metaOrdersCount ? (metaSignalOrders / metaOrdersCount) * 100 : 0;
  const metaRecoveryStatus = permissions?.hasMetaConnector && metaSignalCoveragePct >= 70
    ? "Strong"
    : permissions?.hasMetaConnector
      ? "Partial"
      : "Not started";
  const lastImportSource = (sourceBreakdown || [])
    .filter((row) => row.source && row.source !== "unmapped")
    .sort((a, b) => new Date(b.lastOrderAt || 0).getTime() - new Date(a.lastOrderAt || 0).getTime())[0]?.source || "Unknown";
  const onboardingSteps = [
    { label: "Setup integrations", done: (sourceBreakdown || []).length > 0, actionHref: "/app/integrations?wizard=1" },
    { label: "Validate UTM", done: (orders || []).some((order) => order.campaignId || order.campaignName), actionHref: "/app/additional#utm-intelligence" },
    { label: "First insight", done: (campaignAnomalies || []).length > 0 || (highValueCustomers || []).length > 0, actionHref: "/app/alerts" },
    { label: "First action", done: (stopCampaigns || []).length > 0, actionHref: "/app/campaigns#campaign-stop-list" },
  ];
  const onboardingDone = onboardingSteps.filter((step) => step.done).length;
  const onboardingPct = Math.round((onboardingDone / onboardingSteps.length) * 100);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seenKey = `nc_onboarding_prompt_seen_${shop}`;
    const seen = window.localStorage.getItem(seenKey);
    const shouldPrompt =
      onboardingDone < onboardingSteps.length ||
      !permissions?.hasMetaConnector ||
      !permissions?.hasGoogleConnector;
    if (!seen && shouldPrompt) {
      setInstallPromptOpen(true);
    }
  }, [onboardingDone, onboardingSteps.length, permissions?.hasMetaConnector, permissions?.hasGoogleConnector, shop]);
  useEffect(() => {
    setVisibleOrdersCount(100);
    setExpandedOrderId(null);
  }, [days]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (location.search || location.hash) return;
    const preferred = String(window.localStorage.getItem(defaultLandingKey) || "/app");
    if (preferred && preferred.startsWith("/app") && preferred !== "/app") {
      navigate(preferred, { replace: true, preventScrollReset: true });
    }
  }, [defaultLandingKey, location.hash, location.search, navigate]);
  const dismissInstallPrompt = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`nc_onboarding_prompt_seen_${shop}`, "1");
    }
    setInstallPromptOpen(false);
  };
  const params = new URLSearchParams(location.search || "");
  const compareMode = params.get("compare") === "1";
  const quickFilter = String(params.get("quickFilter") || "all").toLowerCase();
  const quickFilterHref = (value) => {
    const next = new URLSearchParams(location.search || "");
    if (!value || value === "all") next.delete("quickFilter");
    else next.set("quickFilter", value);
    return `?${next.toString()}`;
  };
  const onChangeHomeWindow = (event) => {
    const nextDays = Number(event.target.value || days);
    if (!DAY_OPTIONS.includes(nextDays)) return;
    const next = new URLSearchParams(location.search || "");
    next.set("days", String(nextDays));
    next.set("sources", (selectedSources || ["all"]).join(","));
    navigate(`?${next.toString()}`, { preventScrollReset: true });
  };
  const onChangeHomeView = (event) => {
    const value = String(event.target.value || "overview");
    setDashboardView(value);
  };
  const onChangeHomeQuickFilter = (event) => {
    const value = String(event.target.value || "all");
    if (value === "reset") {
      navigate(resetHomeFiltersHref, { preventScrollReset: true });
      return;
    }
    navigate(quickFilterHref(value), { preventScrollReset: true });
  };
  const resetHomeFiltersHref = `?days=${days}&sources=${encodeURIComponent((selectedSources || ["all"]).join(","))}`;
  const appliedFilterTokens = [
    `Window: ${days}d`,
    `View: ${dashboardView === "operations" ? "actions" : dashboardView === "insights" ? "deep dive" : "overview"}`,
    `Traffic: ${quickFilter.replace("_", " ")}`,
    `Sources: ${isAllSources ? "all" : selectedSources.join(", ")}`,
  ];
  const saveCurrentView = () => {
    const name = String(viewDraftName || "").trim() || `Home ${days}d ${quickFilter}`;
    const nextView = {
      id: `hv-${Date.now()}`,
      name,
      days,
      quickFilter,
      dashboardView,
      dashboardPreset,
      benchmarkWindow,
      createdAt: new Date().toISOString(),
    };
    setSavedViews((current) => {
      const next = [nextView, ...current.filter((row) => row.name.toLowerCase() !== name.toLowerCase())].slice(0, 20);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(savedViewsKey, JSON.stringify(next));
      }
      return next;
    });
    setViewDraftName("");
    setPresetToast(`Saved view: ${name}`);
    setTimeout(() => setPresetToast(""), 1400);
  };
  const applySavedView = useCallback((view) => {
    if (!view) return;
    const nextDays = DAY_OPTIONS.includes(Number(view.days)) ? Number(view.days) : days;
    const nextQuickFilter = String(view.quickFilter || "all");
    setDashboardView(String(view.dashboardView || "overview"));
    setDashboardPreset(String(view.dashboardPreset || "founder"));
    setBenchmarkWindow(String(view.benchmarkWindow || "seven"));
    const next = new URLSearchParams();
    next.set("days", String(nextDays));
    if (nextQuickFilter !== "all") next.set("quickFilter", nextQuickFilter);
    navigate(`?${next.toString()}`, { preventScrollReset: true });
    setPresetToast(`Applied view: ${view.name || "Saved view"}`);
    setTimeout(() => setPresetToast(""), 1400);
  }, [days, navigate]);
  const deleteSavedView = (id) => {
    setSavedViews((current) => {
      const next = current.filter((row) => row.id !== id);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(savedViewsKey, JSON.stringify(next));
      }
      return next;
    });
    setPresetToast("Saved view removed");
    setTimeout(() => setPresetToast(""), 1400);
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(applyViewSessionKey);
    if (!raw) return;
    window.sessionStorage.removeItem(applyViewSessionKey);
    try {
      const view = JSON.parse(raw);
      applySavedView(view);
    } catch {
      // ignore invalid payload
    }
  }, [applyViewSessionKey, applySavedView]);
  const setupWizardSteps = [
    { label: "Store connected", done: totalOrdersCount > 0, href: "/app" },
    { label: "Signal capture enabled", done: clickIdCount > 0 || firstPartySignalCount > 0, href: "/app/additional#storefront-signal" },
    { label: "Paid connectors linked", done: !!permissions?.hasMetaConnector && !!permissions?.hasGoogleConnector, href: "/app/integrations?wizard=1" },
    { label: "First sync complete", done: syncedMins != null, href: "/app/integrations?wizard=1" },
    { label: "Attribution validated", done: attributionCoveragePct >= 60, href: "/app/intelligence" },
    { label: "First campaign action", done: (stopCampaigns || []).length > 0, href: "/app/campaigns#campaign-stop-list" },
    { label: "Reports scheduled", done: (savedReports || []).some((r) => !!r.frequency), href: "#goal-tracking" },
  ];
  const setupDone = setupWizardSteps.filter((s) => s.done).length;
  const setupPct = Math.round((setupDone / setupWizardSteps.length) * 100);
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      (attributionCoveragePct * 0.3) +
      (utmMappedPct * 0.2) +
      ((100 - Math.min(100, syncedMins || 0)) * 0.2) +
      ((permissions?.hasMetaConnector ? 15 : 0) + (permissions?.hasGoogleConnector ? 15 : 0)) +
      ((100 - Math.min(100, dominantSourceSharePct)) * 0.15),
    ),
  );
  const smartAlerts = [
    {
      title: "COD share watch",
      reason: "If COD rises sharply, cancellation/RTO risk usually follows.",
      href: "/app/universal",
            cta: "Review Universal Insights",
    },
    {
      title: "Coupon dependency",
      reason: "High coupon dependency may reduce net cash quality.",
      href: "/app/universal",
      cta: "Review Coupon Patterns",
    },
    {
      title: "Attribution decay",
      reason: "Low click/UTM capture makes campaign decisions less reliable.",
      href: "/app/additional#storefront-signal",
            cta: "Setup Signal Capture",
    },
  ];
  const benchmark = benchmarkWindow === "seven" ? benchmarkMode?.seven : benchmarkMode?.thirty;
  const whyChanged = [
    `${sourceBreakdown?.[0]?.source || "Top source"} contributes ${dominantSourceSharePct.toFixed(0)}% of net cash.`,
    `UTM mapped ${utmMappedPct.toFixed(0)}%, attribution coverage ${attributionCoveragePct.toFixed(0)}%.`,
    `Recent ROAS delta ${Number(benchmark?.roasDeltaPct || 0).toFixed(1)}%, net delta ${Number(benchmark?.netDeltaPct || 0).toFixed(1)}%.`,
  ];
  const selectedOrderTimeline = selectedOrder360 ? buildCustomerTimeline(selectedOrder360) : [];
  const displayedOrders = (orders || []).slice(0, visibleOrdersCount);
  const hasMoreOrders = Number(orders?.length || 0) > displayedOrders.length;
  const selectedCustomerHistory =
    selectedOrder360 && customerHistoryByOrderId ? customerHistoryByOrderId[selectedOrder360.id] : null;
  const exportCustomer360Pdf = () => {
    if (!selectedOrder360) return;
    const history = selectedCustomerHistory || {
      totalOrders: 1,
      lifetimeGross: selectedOrder360.grossValue || 0,
      lifetimeNet: selectedOrder360.netCash || 0,
      previousOrders: [],
      preferredSizes: [],
      preferredCategories: [],
      avgDaysBetweenOrders: null,
      predictedNextOrderFrom: null,
      predictedNextOrderTo: null,
      ltvTier: "bronze",
    };
    const timelineHtml = selectedOrderTimeline
      .map(
        (event) =>
          `<tr><td>${formatDateTime(event.time)}</td><td>${event.title}</td><td>${String(event.detail || "").replaceAll("<", "&lt;")}</td></tr>`,
      )
      .join("");
    const itemsHtml = (selectedOrder360.lineItems || [])
      .map(
        (item) =>
          `<tr><td>${item.title}</td><td>${item.variantTitle || "-"}</td><td>${item.quantity}</td><td>${money(item.lineTotal)}</td></tr>`,
      )
      .join("");
    const previousOrdersHtml = (history.previousOrders || [])
      .map(
        (row) =>
          `<tr><td>#${row.orderNumber}</td><td>${new Date(row.createdAt).toLocaleDateString()}</td><td>${money(row.grossValue)}</td><td>${money(row.netCash)}</td><td>${row.financialStatus || "-"}</td></tr>`,
      )
      .join("");
    const preferredSizes = (history.preferredSizes || []).map((row) => `${row.size} (${row.qty})`).join(", ") || "-";
    const preferredCategories =
      (history.preferredCategories || []).map((row) => `${row.category} (${row.qty})`).join(", ") || "-";
    const repeatFrequency =
      history.avgDaysBetweenOrders != null ? `${history.avgDaysBetweenOrders.toFixed(1)} days` : "Not enough history";
    const nextOrderWindow =
      history.predictedNextOrderFrom && history.predictedNextOrderTo
        ? `${new Date(history.predictedNextOrderFrom).toLocaleDateString()} - ${new Date(history.predictedNextOrderTo).toLocaleDateString()}`
        : "Not enough history";
    const popup = window.open("", "_blank", "width=1000,height=800");
    if (!popup) return;
    popup.document.write(`
      <html>
        <head>
          <title>Customer 360 - #${selectedOrder360.orderNumber}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
            h1, h2 { margin: 0 0 10px; }
            p { margin: 4px 0; }
            table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
            th { background: #f3f6fb; }
          </style>
        </head>
        <body>
          <h1>Customer 360</h1>
          <p><strong>Order:</strong> #${selectedOrder360.orderNumber}</p>
          <p><strong>Name:</strong> ${selectedOrder360.customerName || "-"}</p>
          <p><strong>Email:</strong> ${selectedOrder360.customerEmail || "-"}</p>
          <p><strong>Phone:</strong> ${selectedOrder360.customerPhone || "-"}</p>
          <p><strong>Address:</strong> ${[
            selectedOrder360.shippingAddress1,
            selectedOrder360.shippingAddress2,
            selectedOrder360.shippingCity,
            selectedOrder360.shippingPincode,
          ]
            .filter(Boolean)
            .join(", ") || "-"}</p>
          <p><strong>Total Orders:</strong> ${history.totalOrders}</p>
          <p><strong>Lifetime Gross:</strong> ${money(history.lifetimeGross)}</p>
          <p><strong>Lifetime Net:</strong> ${money(history.lifetimeNet)}</p>
          <p><strong>LTV Tier:</strong> ${String(history.ltvTier || "bronze").toUpperCase()}</p>
          <p><strong>Repeat Purchase Frequency:</strong> ${repeatFrequency}</p>
          <p><strong>Predicted Next Order Window:</strong> ${nextOrderWindow}</p>
          <p><strong>Preferred Sizes:</strong> ${preferredSizes}</p>
          <p><strong>Preferred Categories:</strong> ${preferredCategories}</p>
          <h2>Order Items</h2>
          <table>
            <thead><tr><th>Item</th><th>Variant</th><th>Qty</th><th>Line Total</th></tr></thead>
            <tbody>${itemsHtml || "<tr><td colspan='4'>No items</td></tr>"}</tbody>
          </table>
          <h2>Previous Orders</h2>
          <table>
            <thead><tr><th>Order</th><th>Date</th><th>Gross</th><th>Net</th><th>Status</th></tr></thead>
            <tbody>${previousOrdersHtml || "<tr><td colspan='5'>No previous orders</td></tr>"}</tbody>
          </table>
          <h2>Timeline</h2>
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
            <tbody>${timelineHtml || "<tr><td colspan='3'>No timeline events</td></tr>"}</tbody>
          </table>
        </body>
      </html>
    `);
    popup.document.close();
    popup.focus();
    popup.print();
  };
  const netCashValue = Number(metrics?.netCash || 0);
  const realRoasValue = Number(metrics?.realRoas || 0);
  const profitMarginValue = Number(metrics?.profitMarginPct || 0);
  const orderCountValue = Number(metrics?.orderCount || 0);
  const currentMonthDays = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const runRateNet = netCashValue / Math.max(1, Number(days || 30));
  const forecastNetCash = runRateNet * currentMonthDays;
  const forecastRoas = realRoasValue;
  const forecastCac = orderCountValue > 0 ? Number(metrics?.adSpend || 0) / orderCountValue : 0;
  const goalProgress = {
    netCash: goalTargets.netCash > 0 ? (forecastNetCash / goalTargets.netCash) * 100 : 0,
    roas: goalTargets.roas > 0 ? (forecastRoas / goalTargets.roas) * 100 : 0,
    cac: goalTargets.cac > 0 ? (goalTargets.cac / Math.max(1, forecastCac)) * 100 : 0,
  };
  const prevHalfStart = new Date();
  prevHalfStart.setDate(prevHalfStart.getDate() - Number(days || 30));
  const halfSplit = new Date();
  halfSplit.setDate(halfSplit.getDate() - Math.max(1, Math.floor(Number(days || 30) / 2)));
  const previousHalfOrders = (orders || []).filter((row) => {
    const ts = new Date(row.createdAt).getTime();
    return ts >= prevHalfStart.getTime() && ts < halfSplit.getTime();
  });
  const currentHalfOrders = (orders || []).filter((row) => new Date(row.createdAt).getTime() >= halfSplit.getTime());
  const previousHalfGross = previousHalfOrders.reduce((sum, row) => sum + Number(row.grossValue || 0), 0);
  const previousHalfMargin = previousHalfGross > 0
    ? (previousHalfOrders.reduce((sum, row) => sum + Number(row.netCash || 0), 0) / previousHalfGross) * 100
    : 0;
  const toPctDelta = (currentValue, previousValue) => {
    if (!Number.isFinite(previousValue) || previousValue === 0) return currentValue > 0 ? 100 : 0;
    return ((currentValue - previousValue) / previousValue) * 100;
  };
  const trendValueFor = (key) => {
    if (key === "netCash") return Number(benchmark?.netDeltaPct || 0);
    if (key === "realRoas") return Number(benchmark?.roasDeltaPct || 0);
    if (key === "margin") return toPctDelta(profitMarginValue, previousHalfMargin);
    if (key === "orders") return toPctDelta(currentHalfOrders.length, previousHalfOrders.length);
    return 0;
  };
  const trendToneFor = (key, value) => {
    if (key === "margin") return value >= 0 ? "up" : "down";
    if (key === "orders") return value >= 0 ? "up" : "down";
    return value >= 0 ? "up" : "down";
  };
  const dailyBrief = {
    changed: `Net cash is ${benchmark?.netDeltaPct >= 0 ? "up" : "down"} ${Math.abs(Number(benchmark?.netDeltaPct || 0)).toFixed(1)}% vs previous ${benchmarkWindow === "seven" ? "7" : "30"} days.`,
    risk: campaignAnomalies[0]?.message || alerts[0] || "No major risks detected right now.",
    growthAction:
      stopCampaigns.length > 0
        ? `Review "${stopCampaigns[0].campaignName || stopCampaigns[0].campaignId || stopCampaigns[0].source}" and reallocate budget.`
        : "Review Campaigns and activate Low ROAS recovery playbook.",
  };
  const unifiedTimeline = [
    ...alerts.slice(0, 4).map((item, idx) => ({
      time: new Date(Date.now() - idx * 2 * 60 * 1000).toISOString(),
      type: "alert",
      title: "Lighthouse Alert",
      detail: item,
      actionHref: "/app/alerts",
      actionLabel: "Review Alerts",
    })),
    ...campaignAnomalies.slice(0, 4).map((item, idx) => ({
      time: new Date(Date.now() - (idx + 1) * 4 * 60 * 1000).toISOString(),
      type: "campaign",
      title: `Campaign anomaly (${item.source})`,
      detail: item.message,
      actionHref: "/app/campaigns#campaign-stop-list",
      actionLabel: "Review Campaigns",
    })),
    {
      time: new Date().toISOString(),
      type: "sync",
      title: "Data sync checkpoint",
      detail: syncLabel,
      actionHref: "/app",
      actionLabel: "Refresh now",
    },
    {
      time: new Date().toISOString(),
      type: "billing",
      title: "Billing status",
      detail: `${tierLabel} tier active`,
      actionHref: "/app/pricing",
      actionLabel: "Manage Billing",
    },
  ]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 10);
  const actionCenter = {
    openRisks: (campaignAnomalies || []).filter((row) => row.severity === "high" || row.severity === "medium").length + (alerts || []).length,
    stopCandidates: (stopCampaigns || []).length,
    connectorsMissing: Number(!permissions?.hasMetaConnector) + Number(!permissions?.hasGoogleConnector),
  };
  const deliveryBreakdown = (deliveryOverview?.breakdown || [])
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  const todayTasks = [
    { label: "Connect Meta + Google", done: !!permissions?.hasMetaConnector && !!permissions?.hasGoogleConnector, href: "/app/integrations?wizard=1" },
    { label: "Review active risk alerts", done: (actionCenter.openRisks || 0) === 0, href: "/app/alerts" },
    { label: "Handle stop-campaign candidates", done: (actionCenter.stopCandidates || 0) === 0, href: "/app/campaigns#campaign-stop-list" },
    { label: "Set at least one report schedule", done: (savedReports || []).some((row) => !!row.frequency), href: "#goal-tracking" },
  ];
  const saveCurrentReport = () => {
    const label = reportDraft.name.trim() || `Home ${days}d snapshot`;
    const next = [
      ...savedReports,
      {
        id: `rep-${Date.now()}`,
        label,
        page: "home",
        createdAt: new Date().toISOString(),
        config: { days, dashboardView, dashboardPreset, benchmarkWindow },
      },
    ].slice(-20);
    setSavedReports(next);
    setPresetToast("Report saved");
    trackUiEvent("report_saved", { page: "home", label });
    setTimeout(() => setPresetToast(""), 1400);
  };
  const scheduleExport = () => {
    if (!reportDraft.email) {
      setPresetToast("Add email to schedule export");
      setTimeout(() => setPresetToast(""), 1400);
      return;
    }
    const label = reportDraft.name.trim() || `Home ${days}d snapshot`;
    trackUiEvent("report_scheduled", { page: "home", frequency: reportDraft.frequency });
    const payload = new FormData();
    payload.append("intent", "create");
    payload.append("page", "home");
    payload.append("name", label);
    payload.append("frequency", reportDraft.frequency);
    payload.append("email", reportDraft.email);
    payload.append("format", "both");
    payload.append("filters", JSON.stringify({ days, dashboardView, dashboardPreset, benchmarkWindow }));
    scheduleFetcher.submit(payload, { method: "post", action: "/api/reports.schedule" });
  };

  return (
    <div className={`nc-shell nc-home ${tableDensity === "compact" ? "nc-density-compact" : ""}`}>
      {!previewMode && showSkeleton ? (
        <div className="nc-section">
          <div className="nc-skeleton nc-skeleton-title" />
          <div className="nc-skeleton nc-skeleton-subtitle" />
          <div className="nc-grid">
            <div className="nc-skeleton nc-skeleton-card" />
            <div className="nc-skeleton nc-skeleton-card" />
          </div>
        </div>
      ) : null}
      {installPromptOpen ? (
        <div className="nc-modal-overlay" role="dialog" aria-modal="true" onClick={dismissInstallPrompt}>
          <div className="nc-modal" onClick={(event) => event.stopPropagation()}>
            <div className="nc-modal-header">
              <div>
                <h3 style={{ margin: 0 }}>Finish Setup in 2 Minutes</h3>
                <p className="nc-note" style={{ margin: "6px 0 0" }}>
                  Netcash.ai already synced your Shopify order data. Connect paid channels next to unlock full attribution and campaign intelligence.
                </p>
              </div>
            </div>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <Link to="/app/integrations?wizard=1" className="nc-chip" preventScrollReset onClick={dismissInstallPrompt}>
                Connect Meta + Google
              </Link>
              <Link to="/app/intelligence" className="nc-chip" preventScrollReset onClick={dismissInstallPrompt}>
                Review Intelligence
              </Link>
              <button type="button" className="nc-chip" onClick={dismissInstallPrompt}>
                Continue to Dashboard
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="nc-header-row nc-section">
        <h1 className="nc-title-stack" style={{ marginBottom: 0 }}>
          <span className="nc-brand-wordmark">Netcash<span className="nc-brand-dot">.</span><span className="nc-brand-ai">ai</span></span>
        </h1>
        <div className="nc-top-actions">
          <span className="nc-fresh-badge">{tierLabel} tier</span>
          <a
            href={withEmbedded("/app/pricing")}
            className="nc-icon-btn"
            ref={planMenuButtonRef}
            onClick={(event) => {
              event.preventDefault();
              const target = withEmbedded("/app/pricing");
              window.location.href = target;
            }}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="nc-btn-icon">
              <path d="M4 4.2h12a1 1 0 0 1 1 1v9.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1zm1.5 3.4h9V6h-9zm0 3h5.2v-1.6H5.5z" />
            </svg>
            Manage Billing
          </a>
          <a
            href={withEmbedded(`/app?days=${days}`)}
            className="nc-icon-btn"
            onClick={(event) => {
              event.preventDefault();
              trackUiEvent("refresh_clicked", { page: "home" });
              revalidator.revalidate();
            }}
            ref={refreshButtonRef}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="nc-btn-icon">
              <path d="M10 3a7 7 0 1 1-5.8 3.1H2.6V3.2h2.9v2.1A5.4 5.4 0 1 0 10 4.6c1.1 0 2.1.3 3 .9L12 6.8A3.7 3.7 0 0 0 10 6.2 3.8 3.8 0 1 0 13.8 10h1.8A5.6 5.6 0 1 1 10 4.4z" />
            </svg>
            {revalidator.state === "loading" ? "Refreshing..." : "Refresh now"}
          </a>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>
      </div>
      <p className="nc-subtitle">Profit command center with attribution depth, campaign actions, and connector health in one place.</p>
      <div className="nc-card nc-section nc-glass nc-mission-control">
        <div className="nc-section-head-inline">
          <h2 style={{ marginBottom: 0 }}>Mission Control</h2>
          <span className="nc-note">Premium D2C signal layer</span>
        </div>
        <div className="nc-grid-4">
          {premiumSignals.map((signal) => (
            <div key={signal.label} className={`nc-soft-box nc-premium-signal is-${signal.status}`}>
              <strong>{signal.label}</strong>
              <p className="nc-kpi-value" style={{ marginBottom: "4px" }}>{signal.value}</p>
              <p className="nc-note" style={{ marginBottom: 0 }}>{signal.detail}</p>
            </div>
          ))}
        </div>
        <div className="nc-grid-4" style={{ marginTop: "10px" }}>
          {predictiveModels.map((model) => (
            <div key={model.label} className={`nc-soft-box nc-premium-signal is-${model.status}`}>
              <strong>{model.label}</strong>
              <p className="nc-kpi-value" style={{ marginBottom: "4px" }}>{model.value}</p>
              <p className="nc-note" style={{ marginBottom: 0 }}>{model.range}</p>
            </div>
          ))}
        </div>
        {(dataMode?.dashboardIsSampled || dataMode?.customerAnalysisIsSampled) ? (
          <p className="nc-note" style={{ marginTop: "10px", marginBottom: 0 }}>
            Big-data mode: showing {dataMode.dashboardOrdersLoaded}/{dataMode.dashboardOrdersAvailable} recent orders and {dataMode.customerOrdersLoaded}/{dataMode.customerOrdersAvailable} customer-analysis orders to keep navigation fast. Export still supports full datasets.
          </p>
        ) : null}
      </div>
      {connectorSnapshotFallback?.lastFailedAt ? (
        <div className="nc-card nc-section">
          <h3 style={{ marginTop: 0 }}>Connector Recovery Snapshot</h3>
          <p className="nc-note">
            Latest connector failure: {connectorSnapshotFallback.lastFailedProvider || "unknown"} at{" "}
            {new Date(connectorSnapshotFallback.lastFailedAt).toLocaleString()}.
          </p>
          <p className="nc-note">
            Last good snapshot: {connectorSnapshotFallback.lastSuccessProvider || "none"} at{" "}
            {connectorSnapshotFallback.lastSuccessAt ? new Date(connectorSnapshotFallback.lastSuccessAt).toLocaleString() : "not available"}.
          </p>
          <p className="nc-note">Dashboard remains available using the latest successful synced snapshot.</p>
        </div>
      ) : null}
      <div className="nc-card nc-glass nc-section" id="founder-view">
        <div className="nc-section-head-inline">
          <h2 style={{ marginBottom: "8px" }}>Founder&apos;s View</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("founder_snapshot.csv", [
                  ["Metric", "Value"],
                  ["Net Cash", money(metrics.netCash)],
                  ["Real ROAS", `${realRoasValue.toFixed(2)}x`],
                  ["Profit Margin", `${profitMarginValue.toFixed(2)}%`],
                  ["Orders", metrics.orderCount],
                ])
              }
            >
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="nc-btn-icon">
                <path d="M10 3 4.8 8.3h3.1v4.3h4.2V8.3h3.1zM4.2 14h11.6v2H4.2z" />
              </svg>
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <p className="nc-note" style={{ marginBottom: "12px" }}>Decision snapshot for the selected time window.</p>
        <div className="nc-control-strip" id="home-kpis" style={{ marginBottom: "12px" }}>
          <div className="nc-control-group">
            <span className="nc-note">Time window</span>
            <select value={days} onChange={onChangeHomeWindow}>
              {DAY_OPTIONS.map((option) => (
                <option key={`home-days-${option}`} value={option}>{option}d</option>
              ))}
            </select>
          </div>
          <div className="nc-control-group">
            <span className="nc-note">View</span>
            <select value={dashboardView} onChange={onChangeHomeView}>
              <option value="overview">Overview</option>
              <option value="operations">Actions</option>
              <option value="insights">Deep Dive</option>
            </select>
          </div>
          <div className="nc-control-group">
            <span className="nc-note">Source</span>
            <select
              value={singleSourceValue}
              onChange={(event) => {
                const next = String(event.target.value || "all");
                if (next === "custom") return;
                toggleSource(next);
              }}
            >
              <option value="all">All sources</option>
              {sourceOptions.map((item) => (
                <option key={`home-source-${item}`} value={item}>
                  {String(item || "").replace(/_/g, " ")}
                </option>
              ))}
              {singleSourceValue === "custom" ? <option value="custom">Multiple selected</option> : null}
            </select>
            <button
              type="button"
              className={`nc-chip ${multiSourceOpen ? "is-active" : ""}`}
              onClick={() => setMultiSourceOpen((current) => !current)}
              style={{ marginTop: "6px", justifyContent: "center" }}
            >
              {multiSourceOpen ? "Hide multi-select" : "Multi-select"}
            </button>
            {multiSourceOpen ? (
              <div className="nc-source-picker-panel" style={{ marginTop: "8px" }}>
                <input
                  type="search"
                  value={sourceSearch}
                  onChange={(event) => setSourceSearch(event.target.value)}
                  placeholder="Search source"
                  aria-label="Search sources"
                />
                <label className="nc-inline-field">
                  <input
                    type="checkbox"
                    checked={isAllSources}
                    onChange={() => toggleSource("all")}
                  />
                  <span>All</span>
                </label>
                {filteredSourceOptions.map((item) => (
                  <label key={`home-source-multi-${item}`} className="nc-inline-field">
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(item) && !isAllSources}
                      onChange={() => toggleSource(item)}
                    />
                    <span style={{ textTransform: "capitalize" }}>{item}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <div className="nc-control-group">
            <span className="nc-note">Display</span>
            <select value={densityMode} onChange={(event) => applyDensityMode(String(event.target.value || "auto"))}>
              <option value="auto">Auto</option>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </div>
        <div className="nc-kpi-grid">
          <div className="nc-kpi-card">
            <h3>Net Cash</h3>
            <p className="nc-kpi-value nc-kpi-positive">{money(metrics.netCash)}</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Real ROAS</h3>
            <p className="nc-kpi-value">{realRoasValue.toFixed(2)}x</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Profit Margin</h3>
            <p className="nc-kpi-value">{profitMarginValue.toFixed(2)}%</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Orders</h3>
            <p className="nc-kpi-value">{metrics.orderCount}</p>
          </div>
        </div>
      </div>
        <div className="nc-toolbar nc-section nc-filter-bar" style={{ marginBottom: 0 }}>
          <label className="nc-form-field nc-inline-field">
            <span>Traffic filter</span>
            <select value={quickFilter} onChange={onChangeHomeQuickFilter}>
              <option value="all">All traffic</option>
              <option value="paid">Only paid traffic</option>
              <option value="repeat">Only repeat buyers</option>
            <option value="coupon">Only coupon users</option>
            <option value="mobile">Only mobile</option>
            <option value="reset">Reset all filters</option>
          </select>
        </label>
        <label className="nc-form-field nc-inline-field">
          <span>Saved view</span>
          <select
            value=""
            onChange={(event) => {
              const selected = savedViews.find((row) => row.id === String(event.target.value || ""));
              if (selected) applySavedView(selected);
            }}
          >
            <option value="">Select saved view</option>
            {savedViews.map((row) => (
              <option key={`home-view-${row.id}`} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
          <button type="button" className="nc-chip" onClick={() => setShowFilterDrawer((current) => !current)}>
            {showFilterDrawer ? "Hide drawer" : "Open drawer"}
          </button>
        </div>
        <p className="nc-note" style={{ marginTop: "6px", marginBottom: 0 }}>
          Tip: Use saved views to keep your preferred filters ready.
        </p>
      <div className="nc-toolbar nc-section nc-applied-filter-row" style={{ marginBottom: 0 }}>
        {appliedFilterTokens.map((token) => (
          <button
            type="button"
            key={`home-filter-token-${token}`}
            className="nc-chip"
            onClick={() => setShowFilterDrawer(true)}
          >
            {token}
          </button>
        ))}
      </div>
      {showFilterDrawer ? (
        <div className="nc-card nc-section nc-glass nc-filter-drawer">
          <div className="nc-section-head-inline">
            <h3 style={{ margin: 0 }}>Filter Drawer</h3>
            <button type="button" className="nc-chip" onClick={() => navigate(resetHomeFiltersHref, { preventScrollReset: true })}>
              Reset all filters
            </button>
          </div>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className={`nc-chip ${quickFilter === "all" ? "is-active" : ""}`} onClick={() => navigate(quickFilterHref("all"), { preventScrollReset: true })}>All</button>
            <button type="button" className={`nc-chip ${quickFilter === "paid" ? "is-active" : ""}`} onClick={() => navigate(quickFilterHref("paid"), { preventScrollReset: true })}>Paid</button>
            <button type="button" className={`nc-chip ${quickFilter === "repeat" ? "is-active" : ""}`} onClick={() => navigate(quickFilterHref("repeat"), { preventScrollReset: true })}>Repeat</button>
            <button type="button" className={`nc-chip ${quickFilter === "coupon" ? "is-active" : ""}`} onClick={() => navigate(quickFilterHref("coupon"), { preventScrollReset: true })}>Coupon</button>
            <button type="button" className={`nc-chip ${quickFilter === "mobile" ? "is-active" : ""}`} onClick={() => navigate(quickFilterHref("mobile"), { preventScrollReset: true })}>Mobile</button>
          </div>
          <div className="nc-grid-4">
            <label className="nc-form-field">Save current view
              <input value={viewDraftName} onChange={(event) => setViewDraftName(event.target.value)} placeholder="Name this home view" />
            </label>
            <div className="nc-form-field">
              <span>Actions</span>
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                <button type="button" className="nc-chip" onClick={saveCurrentView}>Save view</button>
                <button type="button" className="nc-chip" onClick={() => setShowFilterDrawer(false)}>Close drawer</button>
              </div>
            </div>
          </div>
          {savedViews.length ? (
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {savedViews.slice(0, 6).map((view) => (
                <span key={`home-view-pill-${view.id}`} className="nc-saved-view-pill">
                  <button type="button" className="nc-chip" onClick={() => applySavedView(view)}>{view.name}</button>
                  <button type="button" className="nc-chip" onClick={() => deleteSavedView(view.id)}>Delete</button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {compareMode ? (
        <div className="nc-card nc-section nc-glass">
          <h3 style={{ marginTop: 0 }}>Compare Periods</h3>
          <p className="nc-note" style={{ marginBottom: 0 }}>
            Comparing selected window against previous equal window. Net {Number(benchmark?.netDeltaPct || 0).toFixed(1)}%, ROAS {Number(benchmark?.roasDeltaPct || 0).toFixed(1)}%.
          </p>
        </div>
      ) : null}
      {presetToast ? <div className="nc-toast">{presetToast}</div> : null}
      {false ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>
            Health Score <span className="nc-tip-icon" title="Combined quality score from attribution coverage, sync freshness, and connector readiness.">?</span>
          </h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Link to={`?days=${days}&compare=1`} className="nc-chip">Compare periods</Link>
          </div>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Overall Health</strong>
            <p className="nc-kpi-value">{healthScore.toFixed(0)} / 100</p>
            <p className="nc-note">Based on signal quality, sync freshness, connector readiness, and source concentration.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Why changed</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {whyChanged.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Smart Alerts</strong>
            <ul className="nc-smart-alerts-list" style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {smartAlerts.map((item) => (
                <li key={item.title}>
                  <span>{item.title}: {item.reason} </span>
                  <a className="nc-chip" href={withEmbedded(item.href)} style={{ marginLeft: "6px" }}>{item.cta}</a>
                </li>
              ))}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>First 7 Days Setup Wizard</strong>
            <p className="nc-note" style={{ marginBottom: "6px" }}>{setupDone}/{setupWizardSteps.length} complete</p>
            <div className="nc-onboarding-bar"><span style={{ width: `${setupPct}%` }} /></div>
            <ul style={{ margin: "10px 0 0", paddingLeft: "18px" }}>
              {setupWizardSteps.map((step) => (
                <li key={step.label}>
                  {step.done ? "Done" : "Open"}: <a href={withEmbedded(step.href)}>{step.label}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div> : null}
      {(isOverviewView || isActionsView) ? <div className="nc-card nc-section nc-glass nc-action-center">
        <div className="nc-section-head-inline">
          <h2>Action Center</h2>
          <span className="nc-note">Fast daily workflow for founders</span>
        </div>
        <div className="nc-grid">
          <div className="nc-soft-box">
            <strong title="Review risk alerts and anomaly checks with one-click fixes.">Need attention now</strong>
            <p className="nc-note">{actionCenter.openRisks} risk signals need review.</p>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <a className="nc-chip" href={withEmbedded("/app/alerts")}>Review Alerts</a>
              <a className="nc-chip" href={withEmbedded("/app/campaigns#campaign-stop-list")}>Review Campaign Fixes</a>
            </div>
          </div>
          <div className="nc-soft-box">
            <strong title="Daily actions that keep attribution and campaign quality healthy.">Today's checklist</strong>
            <p className="nc-note">{actionCenter.stopCandidates} campaigns flagged, {actionCenter.connectorsMissing} connectors missing.</p>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <Link className="nc-chip" to={withEmbedded("/app/campaigns#campaign-stop-list")} preventScrollReset>Stop List</Link>
              <Link className="nc-chip" to={withEmbedded("/app/integrations?wizard=1")} preventScrollReset>Connect Sources</Link>
            </div>
          </div>
          <div className="nc-soft-box">
            <strong title="Suggested order of operations for faster decisions.">Recommended daily flow</strong>
            <p className="nc-note">1) Read Brief, 2) Validate KPIs, 3) Act from Campaigns/Alerts.</p>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <a className="nc-chip" href="#goal-tracking">Review Goals</a>
            </div>
          </div>
        </div>
      </div> : null}
      {(isOverviewView || isActionsView) ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Delivery Ops & OMS</h2>
          <span className="nc-note">Live delivery/RTO and OMS status coverage</span>
        </div>
        <div className="nc-grid">
          <div className="nc-soft-box">
            <strong>Delivery status overview</strong>
            <p className="nc-note">Shipments tracked: {deliveryOverview?.total || 0}</p>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {deliveryBreakdown.length === 0 ? (
                <span className="nc-note">No delivery events yet. Connect courier/OMS feeds.</span>
              ) : (
                deliveryBreakdown.map((row) => (
                  <span key={`del-status-${row.status}`} className="nc-chip">{row.status}: {row.count}</span>
                ))
              )}
            </div>
            <p className="nc-note" style={{ marginTop: "8px" }}>
              Ingest endpoint: <code>/api/delivery/ingest</code>
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Latest delivery events</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {(deliveryEvents || []).length === 0 ? (
                <li>No recent delivery updates.</li>
              ) : (
                (deliveryEvents || []).map((event, idx) => (
                  <li key={`del-event-${idx}`}>
                    {event.orderNumber || event.awb || "Unknown"} · {event.provider || "provider"} · {event.event || "update"} · {event.location || "-"}
                  </li>
                ))
              )}
            </ul>
            <p className="nc-note" style={{ marginTop: "8px" }}>
              OMS endpoint: <code>/api/oms/ingest</code>
            </p>
          </div>
          <div className="nc-soft-box">
            <strong>Supported connectors (ready for data)</strong>
            <p className="nc-note" style={{ marginBottom: "6px" }}>
              Delivery: Shiprocket, Delhivery, NimbusPost, Ecom Express, Shadowfax, DTDC, Blue Dart, Xpressbees.
            </p>
            <p className="nc-note" style={{ marginBottom: 0 }}>
              OMS: Unicommerce, Easycom, Vinculum, Increff, Uniware, ClickPost.
            </p>
            <div className="nc-toolbar" style={{ marginTop: "8px", marginBottom: 0 }}>
              <Link className="nc-chip" to="/app/integrations?wizard=1" preventScrollReset>Configure Integrations</Link>
              <a className="nc-chip" href="#delivery-integration-guide">View integration guide</a>
            </div>
          </div>
        </div>
      </div> : null}
      {isActionsView ? <div className="nc-home-top-split nc-section">
        <div className="nc-card nc-glass nc-today-tasks">
          <div className="nc-section-head-inline">
            <h3 style={{ margin: 0 }}>Today Tasks</h3>
            <span className="nc-note">{todayTasks.filter((t) => t.done).length}/{todayTasks.length} done</span>
          </div>
          <ul className="nc-task-list">
            {todayTasks.map((task) => (
              <li key={task.label} className={task.done ? "is-done" : "is-open"}>
                <span className="nc-task-tick" aria-hidden="true">{task.done ? "v" : "."}</span>
                <span className="nc-task-label">{task.label}</span>
                <Link to={task.href} preventScrollReset className="nc-task-action">{task.done ? "Review" : "Start"}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="nc-card nc-glass nc-daily-brief">
          <h2 title="A concise summary of what changed, biggest risk, and next action.">Daily Brief</h2>
          <div className="nc-grid nc-daily-brief-grid">
            <div className="nc-soft-box">
              <strong>What changed since yesterday</strong>
              <p className="nc-note">{dailyBrief.changed}</p>
              <a className="nc-chip" href={withEmbedded("/app?days=7")}>Review 7d trend</a>
            </div>
            <div className="nc-soft-box">
              <strong>Top risk</strong>
              <p className="nc-note">{dailyBrief.risk}</p>
              <a className="nc-chip" href={withEmbedded("/app/alerts")}>Review risk</a>
            </div>
            <div className="nc-soft-box">
              <strong>Top growth action</strong>
              <p className="nc-note">{dailyBrief.growthAction}</p>
              <a className="nc-chip" href={withEmbedded("/app/campaigns")}>Apply action</a>
            </div>
          </div>
        </div>
      </div> : null}
      {isOverviewView ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Health Score</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <Link to={`?days=${days}&compare=1`} className="nc-chip">Compare periods</Link>
          </div>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Overall Health</strong>
            <p className="nc-kpi-value">{healthScore.toFixed(0)} / 100</p>
            <p className="nc-note">Based on signal quality, sync freshness, connector readiness, and source concentration.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Why changed</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {whyChanged.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>Smart Alerts</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
              {smartAlerts.map((item) => (
                <li key={item.title}>
                  <span>{item.title}: {item.reason} </span>
                  <a className="nc-chip" href={item.href} style={{ marginLeft: "6px" }}>{item.cta}</a>
                </li>
              ))}
            </ul>
          </div>
          <div className="nc-soft-box">
            <strong>First 7 Days Setup Wizard</strong>
            <p className="nc-note" style={{ marginBottom: "6px" }}>{setupDone}/{setupWizardSteps.length} complete</p>
            <div className="nc-onboarding-bar"><span style={{ width: `${setupPct}%` }} /></div>
            <ul style={{ margin: "10px 0 0", paddingLeft: "18px" }}>
              {setupWizardSteps.map((step) => (
                <li key={step.label}>
                  {step.done ? "Done" : "Open"}: <a href={step.href}>{step.label}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div> : null}
      {isOverviewView ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2 title="Compare current period vs previous period baseline.">Benchmark Mode</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className={`nc-chip ${benchmarkWindow === "seven" ? "is-active" : ""}`} onClick={() => setBenchmarkWindow("seven")}>7d</button>
            <button type="button" className={`nc-chip ${benchmarkWindow === "thirty" ? "is-active" : ""}`} onClick={() => setBenchmarkWindow("thirty")}>30d</button>
          </div>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box"><strong>Net Cash Delta</strong><p className="nc-note">{Number(benchmark?.netDeltaPct || 0).toFixed(1)}%</p></div>
          <div className="nc-soft-box"><strong>ROAS Delta</strong><p className="nc-note">{Number(benchmark?.roasDeltaPct || 0).toFixed(1)}%</p></div>
          <div className="nc-soft-box"><strong>Weekday Mix Delta</strong><p className="nc-note">{Number(benchmark?.weekdayMixDeltaPct || 0).toFixed(1)}%</p></div>
          <div className="nc-soft-box"><strong>Current Net</strong><p className="nc-note">{money(benchmark?.currentNet || 0)}</p></div>
        </div>
      </div> : null}
      {isOverviewView ? <div id="goal-tracking" className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2 title="Set monthly goals and monitor projected completion.">Goal Tracking</h2>
          <span className="nc-note">Forecast to month-end</span>
        </div>
        <div className="nc-grid-4">
          <label className="nc-form-field">Net Cash Target
            <input type="number" value={goalTargets.netCash} onChange={(e) => setGoalTargets((c) => ({ ...c, netCash: Number(e.target.value || 0) }))} />
          </label>
          <label className="nc-form-field">ROAS Target
            <input type="number" step="0.1" value={goalTargets.roas} onChange={(e) => setGoalTargets((c) => ({ ...c, roas: Number(e.target.value || 0) }))} />
          </label>
          <label className="nc-form-field">CAC Target
            <input type="number" value={goalTargets.cac} onChange={(e) => setGoalTargets((c) => ({ ...c, cac: Number(e.target.value || 0) }))} />
          </label>
        </div>
        <div className="nc-stack-sm">
          <div className="nc-note">Net Cash forecast: {money(forecastNetCash)} ({goalProgress.netCash.toFixed(0)}%)</div>
          <progress max="100" value={Math.min(100, Math.max(0, goalProgress.netCash))} />
          <div className="nc-note">ROAS forecast: {forecastRoas.toFixed(2)}x ({goalProgress.roas.toFixed(0)}%)</div>
          <progress max="100" value={Math.min(100, Math.max(0, goalProgress.roas))} />
          <div className="nc-note">CAC forecast: {money(forecastCac)} ({goalProgress.cac.toFixed(0)}%)</div>
          <progress max="100" value={Math.min(100, Math.max(0, goalProgress.cac))} />
        </div>
      </div> : null}
      {isOverviewView ? <div id="experiment-tracker" className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Experiment Tracker</h2>
          <span className="nc-note">Log tests and track net-cash impact over time.</span>
        </div>
        <Form method="post" className="nc-grid-3" preventScrollReset>
          <input type="hidden" name="intent" value="add-experiment" />
          <label className="nc-form-field nc-inline-field">
            <span>Experiment Title</span>
            <input name="title" placeholder="Landing hero test" />
          </label>
          <label className="nc-form-field nc-inline-field">
            <span>Hypothesis</span>
            <input name="hypothesis" placeholder="Improve conversion by 10%" />
          </label>
          <label className="nc-form-field nc-inline-field">
            <span>Expected Outcome</span>
            <input name="expected" placeholder="+0.2x ROAS / +2% CVR" />
          </label>
          <label className="nc-form-field nc-inline-field">
            <span>Start Date</span>
            <input name="start_date" type="date" />
          </label>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="submit" className="nc-chip">Add Experiment</button>
          </div>
        </Form>
        <div style={{ marginTop: "12px" }}>
          {experimentRows.length === 0 ? (
            <div className="nc-empty-block">No experiments logged yet.</div>
          ) : (
            <table className="nc-table-card">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Title</th>
                  <th style={{ textAlign: "left" }}>Hypothesis</th>
                  <th style={{ textAlign: "left" }}>Expected</th>
                  <th style={{ textAlign: "left" }}>Start</th>
                  <th style={{ textAlign: "right" }}>Δ Net</th>
                  <th style={{ textAlign: "right" }}>Δ ROAS</th>
                  <th style={{ textAlign: "left" }}>Status</th>
                  <th style={{ textAlign: "left" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {experimentRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.title}</td>
                    <td>{row.hypothesis || "-"}</td>
                    <td>{row.expected || "-"}</td>
                    <td>{row.startDate || "-"}</td>
                    <td style={{ textAlign: "right" }}>{row.delta ? money(row.delta.net) : "-"}</td>
                    <td style={{ textAlign: "right" }}>{row.delta ? `${row.delta.blendedRoas.toFixed(2)}x` : "-"}</td>
                    <td>{row.status}</td>
                    <td>
                      {row.status === "active" ? (
                        <Form method="post" preventScrollReset>
                          <input type="hidden" name="intent" value="close-experiment" />
                          <input type="hidden" name="id" value={row.id} />
                          <button type="submit" className="nc-chip">Close</button>
                        </Form>
                      ) : (
                        <span className="nc-note">Closed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div> : null}
      {isOverviewView ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Executive Digest</h2>
          <span className="nc-note">Copy-ready snapshot for founders.</span>
        </div>
        <div className="nc-soft-box">
          <p className="nc-note" style={{ marginBottom: "6px" }}>
            Net Cash: {money(metrics.netCash)} · Blended ROAS: {metrics.blendedRoas ? `${metrics.blendedRoas.toFixed(2)}x` : "-"} ·
            Attribution Gap: {Number(metrics.attributionGapPct || 0).toFixed(1)}% · RTO: {Number(metrics.rtoPct || 0).toFixed(1)}% ·
            Refund: {Number(metrics.refundPct || 0).toFixed(1)}% · Discount: {Number(metrics.discountPct || 0).toFixed(1)}% ·
            Creative Fatigue: {Number(metrics.creativeFatigueCount || 0)}
          </p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-chip"
              onClick={() => {
                if (typeof window === "undefined") return;
                const text = `Executive Digest: Net Cash ${money(metrics.netCash)}, Blended ROAS ${metrics.blendedRoas ? metrics.blendedRoas.toFixed(2) : "-"}x, Attribution Gap ${Number(metrics.attributionGapPct || 0).toFixed(1)}%, RTO ${Number(metrics.rtoPct || 0).toFixed(1)}%, Refund ${Number(metrics.refundPct || 0).toFixed(1)}%, Discount ${Number(metrics.discountPct || 0).toFixed(1)}%, Creative Fatigue ${Number(metrics.creativeFatigueCount || 0)}.`;
                navigator.clipboard?.writeText(text);
              }}
            >
              Copy Digest
            </button>
            <button type="button" className="nc-chip" onClick={() => setDashboardView("operations")}>
              Schedule Export
            </button>
          </div>
        </div>
      </div> : null}
      {isOverviewView ? <div className="nc-card nc-section nc-glass">
        <div className="nc-section-head-inline">
          <h2>Unified Timeline</h2>
          <span className="nc-note">Alerts, campaigns, billing, sync</span>
        </div>
        <table className="nc-table-card">
          <thead><tr><th style={{ textAlign: "left" }}>Time</th><th style={{ textAlign: "left" }}>Event</th><th style={{ textAlign: "left" }}>Detail</th><th style={{ textAlign: "left" }}>Action</th></tr></thead>
          <tbody>
            {unifiedTimeline.map((row, idx) => (
              <tr key={`timeline-${idx}-${row.type}`}>
                <td>{new Date(row.time).toLocaleString()}</td>
                <td>{row.title}</td>
                <td>{row.detail}</td>
                <td><a className="nc-chip" href={row.actionHref}>{row.actionLabel}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
      {isActionsView ? <details className="nc-card nc-section nc-glass" open>
        <summary className="nc-details-summary">Saved Reports & Scheduled Export</summary>
        <div className="nc-section-head-inline">
          <h2>Saved Reports & Scheduled Export</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button type="button" className="nc-chip" onClick={saveCurrentReport}>Save Report</button>
            <button type="button" className="nc-chip" onClick={scheduleExport}>Schedule Export</button>
          </div>
        </div>
        <div className="nc-grid-4">
          <label className="nc-form-field">Report Name
            <input value={reportDraft.name} onChange={(e) => setReportDraft((c) => ({ ...c, name: e.target.value }))} />
          </label>
          <label className="nc-form-field">Frequency
            <select value={reportDraft.frequency} onChange={(e) => setReportDraft((c) => ({ ...c, frequency: e.target.value }))}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label className="nc-form-field">Email
            <input type="email" value={reportDraft.email} onChange={(e) => setReportDraft((c) => ({ ...c, email: e.target.value }))} />
          </label>
        </div>
        <ul style={{ margin: 0, paddingLeft: "18px" }}>
          {savedReports.slice(-6).length === 0 ? (
            <li className="nc-note">No schedules yet. Do this next: set Frequency + Email and click `Schedule Export`.</li>
          ) : savedReports.slice(-6).map((row) => (
            <li key={row.id}>{row.label || row.name} {row.frequency ? `(${row.frequency} to ${row.email})` : ""}</li>
          ))}
        </ul>
      </details> : null}
      {!permissions?.hasMetaConnector || !permissions?.hasGoogleConnector ? (
        <div className="nc-card nc-section nc-glass">
          <h3>Permission Check</h3>
          <p className="nc-note">Some connectors are missing. Connect now to unlock full attribution and campaign sync.</p>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {!permissions?.hasMetaConnector ? <a className="nc-chip" href={withEmbedded("/app/integrations?wizard=1")}>Connect Meta</a> : null}
            {!permissions?.hasGoogleConnector ? <a className="nc-chip" href={withEmbedded("/app/integrations?wizard=1")}>Connect Google</a> : null}
          </div>
        </div>
      ) : null}
      {isOverviewView ? <div className="nc-card nc-section nc-glass nc-health-row">
        <div className="nc-health-item"><span>Orders connected</span><strong>{totalOrdersCount}</strong></div>
        <div className="nc-health-item"><span>UTM mapped</span><strong>{utmMappedPct.toFixed(0)}%</strong></div>
        <div className="nc-health-item"><span>Attribution coverage</span><strong>{attributionCoveragePct.toFixed(0)}%</strong></div>
        <div className="nc-health-item"><span>Last import source</span><strong style={{ textTransform: "capitalize" }}>{lastImportSource}</strong></div>
      </div> : null}
      {isDeepDiveView ? <div className="nc-card nc-section nc-glass nc-depth-grid">
        <div className="nc-section-head-inline">
          <h2 title="How complete and reliable your attribution data is.">Data Depth</h2>
          <span className="nc-note">Signal quality for reliable decision-making</span>
        </div>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Depth Score</strong>
            <p className="nc-kpi-value">{dataDepthScore.toFixed(0)} / 100</p>
            <p className="nc-note">Weighted from UTM, click IDs, first-party signal, and touchpoint richness.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Full UTM + Click ID</strong>
            <p className="nc-kpi-value">{fullUtmPct.toFixed(0)}% / {clickIdPct.toFixed(0)}%</p>
            <p className="nc-note">{fullUtmCount} with full UTM, {clickIdCount} with click IDs.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Unattributed Net Cash</strong>
            <p className="nc-kpi-value">{money(unattributedNetCash)}</p>
            <p className="nc-note">{unattributedOrdersCount} orders still partially blind.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Source Concentration Risk</strong>
            <p className="nc-kpi-value">{dominantSourceSharePct.toFixed(0)}%</p>
            <p className="nc-note">Share of net cash from your top source.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Attribution Overlap Risk</strong>
            <p className="nc-kpi-value">{multiSourceTouchpointPct.toFixed(0)}%</p>
            <p className="nc-note">{multiSourceTouchpointCount} orders show multi-source touchpoints.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Landing Mismatch</strong>
            <p className="nc-kpi-value">{landingMismatchPct.toFixed(0)}%</p>
            <p className="nc-note">{landingMismatchCount} paid orders landed on home or generic pages.</p>
          </div>
        </div>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href={withEmbedded("/app/intelligence")}>Review Intelligence Studio</a>
          <a className="nc-chip" href={withEmbedded("/app/additional#utm-intelligence")}>Improve UTM Mapping</a>
        </div>
      </div> : null}
      {isDeepDiveView ? <div className="nc-card nc-section nc-glass nc-meta-recovery">
        <div className="nc-section-head-inline">
          <h2 title="Fallback workflow when Meta pixel/UTM visibility is incomplete.">Meta Signal Recovery</h2>
          <span className={`nc-fresh-badge ${metaRecoveryStatus === "Strong" ? "nc-sync-fresh" : metaRecoveryStatus === "Partial" ? "nc-sync-aging" : "nc-sync-stale"}`}>
            {metaRecoveryStatus}
          </span>
        </div>
        <p className="nc-note">
          Meta pixel/UTM visibility can be incomplete due to browser privacy and app-web handoffs. Netcash uses server-side attribution ingestion and first-party click signal capture as fallback.
        </p>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <strong>Meta Connector</strong>
            <p className="nc-kpi-value">{permissions?.hasMetaConnector ? "Connected" : "Missing"}</p>
            <p className="nc-note">OAuth sync for campaign metadata and spend context.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Meta Signal Coverage</strong>
            <p className="nc-kpi-value">{metaSignalCoveragePct.toFixed(0)}%</p>
            <p className="nc-note">{metaSignalOrders}/{metaOrdersCount || 0} meta orders with recoverable IDs/touchpoints.</p>
          </div>
          <div className="nc-soft-box">
            <strong>First-Party Signal</strong>
            <p className="nc-kpi-value">{firstPartySignalPct.toFixed(0)}%</p>
            <p className="nc-note">Orders carrying landing/referrer/click IDs.</p>
          </div>
          <div className="nc-soft-box">
            <strong>Attribution Endpoint</strong>
            <p className="nc-kpi-value">/api/attribution</p>
            <p className="nc-note">Push order-level campaign IDs from server/webhook tools.</p>
          </div>
        </div>
        <div className="nc-meta-solve">
          <strong>Recommended solve</strong>
          <ol>
            <li>Capture `fbclid` on landing pages and persist it as first-party metadata through checkout.</li>
            <li>Send server-side conversions with `orderId + campaignId + campaignName` to `/api/attribution`.</li>
            <li>Use Netcash attribution models (last/first/linear/time-decay) for resilient performance reads.</li>
          </ol>
        </div>
        <div className="nc-toolbar" style={{ marginBottom: 0 }}>
          <a className="nc-chip" href={withEmbedded("/app/integrations?wizard=1")}>Connect Meta</a>
          <a className="nc-chip" href={withEmbedded("/app/additional#tool-connectors")}>Review Attribution Templates</a>
        </div>
      </div> : null}
      {isOverviewView ? <div className="nc-kpi-ribbon nc-section" aria-label="Sticky KPI ribbon">
        <div className={`nc-kpi-ribbon-item is-${trendToneFor("netCash", trendValueFor("netCash"))}`}>
          <span>Net Cash</span>
          <strong>{money(netCashValue)}</strong>
          <div className="nc-kpi-trend-row">
            <span className={`nc-kpi-trend is-${trendToneFor("netCash", trendValueFor("netCash"))}`}>
              {trendValueFor("netCash") >= 0 ? "▲" : "▼"} {Math.abs(trendValueFor("netCash")).toFixed(1)}%
            </span>
            <span className="nc-kpi-trend-mini">
              <span style={{ width: `${Math.min(100, Math.abs(trendValueFor("netCash")))}%` }} />
            </span>
          </div>
        </div>
        <div className={`nc-kpi-ribbon-item is-${trendToneFor("realRoas", trendValueFor("realRoas"))}`}>
          <span>Real ROAS</span>
          <strong>{realRoasValue.toFixed(2)}x</strong>
          <div className="nc-kpi-trend-row">
            <span className={`nc-kpi-trend is-${trendToneFor("realRoas", trendValueFor("realRoas"))}`}>
              {trendValueFor("realRoas") >= 0 ? "▲" : "▼"} {Math.abs(trendValueFor("realRoas")).toFixed(1)}%
            </span>
            <span className="nc-kpi-trend-mini">
              <span style={{ width: `${Math.min(100, Math.abs(trendValueFor("realRoas")))}%` }} />
            </span>
          </div>
        </div>
        <div className={`nc-kpi-ribbon-item is-${trendToneFor("margin", trendValueFor("margin"))}`}>
          <span>Margin</span>
          <strong>{profitMarginValue.toFixed(2)}%</strong>
          <div className="nc-kpi-trend-row">
            <span className={`nc-kpi-trend is-${trendToneFor("margin", trendValueFor("margin"))}`}>
              {trendValueFor("margin") >= 0 ? "▲" : "▼"} {Math.abs(trendValueFor("margin")).toFixed(1)}%
            </span>
            <span className="nc-kpi-trend-mini">
              <span style={{ width: `${Math.min(100, Math.abs(trendValueFor("margin")))}%` }} />
            </span>
          </div>
        </div>
        <div className={`nc-kpi-ribbon-item is-${trendToneFor("orders", trendValueFor("orders"))}`}>
          <span>Orders</span>
          <strong>{orderCountValue}</strong>
          <div className="nc-kpi-trend-row">
            <span className={`nc-kpi-trend is-${trendToneFor("orders", trendValueFor("orders"))}`}>
              {trendValueFor("orders") >= 0 ? "▲" : "▼"} {Math.abs(trendValueFor("orders")).toFixed(1)}%
            </span>
            <span className="nc-kpi-trend-mini">
              <span style={{ width: `${Math.min(100, Math.abs(trendValueFor("orders")))}%` }} />
            </span>
          </div>
        </div>
      </div> : null}
      {isActionsView ? <div className="nc-card nc-section nc-glass nc-onboarding-strip">
        <div className="nc-onboarding-head">
          <h3 style={{ margin: 0 }}>Onboarding</h3>
          <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
        </div>
        <p className="nc-note" style={{ marginBottom: "8px" }}>{onboardingDone}/{onboardingSteps.length} steps complete</p>
        <div className="nc-onboarding-bar"><span style={{ width: `${onboardingPct}%` }} /></div>
        <div className="nc-toolbar" style={{ marginBottom: 0, marginTop: "10px" }}>
          {onboardingSteps.map((step) => (
            <a key={step.label} href={step.actionHref} className={`nc-chip ${step.done ? "is-active" : ""}`}>
              {step.done ? "Done" : "Do"}: {step.label}
            </a>
          ))}
        </div>
      </div> : null}
      {false ? <div className="nc-card nc-glass nc-section" id="founder-view">
        <div className="nc-section-head-inline">
          <h2 style={{ marginBottom: "8px" }}>Founder&apos;s View</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("founder_snapshot.csv", [
                  ["Metric", "Value"],
                  ["Net Cash", money(metrics.netCash)],
                  ["Real ROAS", `${realRoasValue.toFixed(2)}x`],
                  ["Profit Margin", `${profitMarginValue.toFixed(2)}%`],
                  ["Orders", metrics.orderCount],
                ])
              }
            >
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <p className="nc-note" style={{ marginBottom: "12px" }}>Decision snapshot for the selected time window.</p>
        <div className="nc-control-strip" id="home-kpis" style={{ marginBottom: "12px" }}>
          <div className="nc-control-group">
            <span className="nc-note">Time window</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {DAY_OPTIONS.map((option) => (
                <Link
                  key={option}
                  to={`?days=${option}`}
                  className={`nc-chip ${option === days ? "is-active" : ""}`}
                  preventScrollReset
                >
                  {option}d
                </Link>
              ))}
            </div>
          </div>
          <div className="nc-control-group">
            <span className="nc-note">View</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {[
                ["overview", "Overview"],
                ["insights", "Insights"],
                ["operations", "Operations"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`nc-chip ${dashboardView === key ? "is-active" : ""}`}
                  onClick={() => setDashboardView(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="nc-control-group">
            <span className="nc-note">Preset</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              {[
                ["founder", "Founder", "F"],
                ["growth", "Growth", "G"],
                ["ops", "Ops", "O"],
                ["crm", "CRM", "C"],
              ].map(([key, label, icon]) => (
                <button
                  key={key}
                  type="button"
                  className={`nc-chip ${dashboardPreset === key ? "is-active" : ""}`}
                  onClick={() => applyPreset(key)}
                >
                  <span className="nc-chip-icon" aria-hidden="true">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="nc-control-group">
            <span className="nc-note">Table density</span>
            <div className="nc-toolbar" style={{ marginBottom: 0 }}>
              <span className="nc-chip is-active">
                {densityMode === "auto" ? `Auto: ${tableDensity === "compact" ? "Compact" : "Comfortable"}` : densityMode}
              </span>
            </div>
          </div>
        </div>
        <div className="nc-kpi-grid">
          <div className="nc-kpi-card">
            <h3>Net Cash</h3>
            <p className="nc-kpi-value nc-kpi-positive">{money(metrics.netCash)}</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Real ROAS <span className="nc-tip-icon" title="Net-cash aware ROAS after returns and cost impact.">?</span></h3>
            <p className="nc-kpi-value">{realRoasValue.toFixed(2)}x</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Profit Margin</h3>
            <p className="nc-kpi-value">{profitMarginValue.toFixed(2)}%</p>
          </div>
          <div className="nc-kpi-card">
            <h3>Orders</h3>
            <p className="nc-kpi-value">{metrics.orderCount}</p>
          </div>
        </div>
      </div> : null}

      {isDeepDiveView ? <div id="high-value-customers" className="nc-card nc-section nc-glass nc-customer-intel">
        <div className="nc-section-head-inline">
          <h2>Customer Intelligence</h2>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={() =>
                exportCsvFile("customer_intelligence.csv", [
                  ["Customer", "Orders", "Lifetime Net"],
                  ...highValueCustomers.map((row) => [row.customerName || "Guest", row.totalOrders, row.lifetimeNet]),
                ])
              }
            >
              Export
            </button>
            <span className={syncBadgeClass} title={syncTitle}>{syncLabel}</span>
          </div>
        </div>
        <p className="nc-note">High-value cohorts and risk hotspots from recent order behavior.</p>
        <div className="nc-soft-box nc-customer-intel-main" style={{ marginBottom: "12px" }}>
          <h3 style={{ marginTop: 0 }}>High-Value Customers</h3>
          <div className="nc-mobile-column-toggles">
            <button
              type="button"
              className={`nc-chip ${customerColumns.contact ? "is-active" : ""}`}
              onClick={() => setCustomerColumns((current) => ({ ...current, contact: !current.contact }))}
            >
              Contact
            </button>
            <button
              type="button"
              className={`nc-chip ${customerColumns.nextWindow ? "is-active" : ""}`}
              onClick={() => setCustomerColumns((current) => ({ ...current, nextWindow: !current.nextWindow }))}
            >
              Next Window
            </button>
          </div>
          <table className="nc-table-card nc-customer-intel-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Customer</th>
                {customerColumns.contact ? <th style={{ textAlign: "left" }}>Contact</th> : null}
                <th style={{ textAlign: "right" }}>Orders</th>
                <th style={{ textAlign: "right" }}>Lifetime Net</th>
                {customerColumns.nextWindow ? <th style={{ textAlign: "left" }}>Next Order Window</th> : null}
              </tr>
            </thead>
            <tbody>
              {highValueCustomers.length === 0 ? (
                <tr>
                  <td colSpan={customerTableColSpan}>
                    <div className="nc-empty-state">
                      <div className="nc-empty-illus nc-empty-illus-home">C</div>
                      <div>No high-value cohort yet. Capture more attributed orders.</div>
                      <a href={withEmbedded("/app/campaigns")} className="nc-chip">Review Campaigns</a>
                    </div>
                  </td>
                </tr>
              ) : (
                highValueCustomers.map((row) => (
                  <tr key={`hvc-summary-${row.customerKey}`}>
                    <td data-label="Customer">{row.customerName || "Guest Customer"}</td>
                    {customerColumns.contact ? <td data-label="Contact">{row.customerEmail || row.customerPhone || "-"}</td> : null}
                    <td data-label="Orders" style={{ textAlign: "right" }}>{row.totalOrders}</td>
                    <td data-label="Lifetime Net" style={{ textAlign: "right" }}>{money(row.lifetimeNet)}</td>
                    {customerColumns.nextWindow ? <td data-label="Next Order Window">
                      {row.predictedNextOrderFrom && row.predictedNextOrderTo
                        ? `${new Date(row.predictedNextOrderFrom).toLocaleDateString()} - ${new Date(row.predictedNextOrderTo).toLocaleDateString()}`
                        : "Not enough history"}
                    </td> : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="nc-grid-4 nc-customer-intel-risk-grid">
          <div className="nc-soft-box nc-customer-intel-risk-card">
            <h3 style={{ marginTop: 0 }}>High Risk Items</h3>
            <table className="nc-customer-intel-mini-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Item</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Loss</th>
                </tr>
              </thead>
              <tbody>
                {highRtoItems.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <div className="nc-empty-state">
                        <div className="nc-empty-illus nc-empty-illus-home">H</div>
                        <div className="nc-empty-mini">No risk items yet.</div>
                        <a href={withEmbedded("/app/alerts")} className="nc-chip">Review Alerts</a>
                      </div>
                    </td>
                  </tr>
                ) : (
                  highRtoItems.slice(0, 8).map((row) => (
                    <tr key={`risk-item-summary-${row.item}-${row.variant}`}>
                      <td>{row.item}{row.variant && row.variant !== "-" ? ` (${row.variant})` : ""}</td>
                      <td style={{ textAlign: "right" }}>{row.qtyAtRisk}</td>
                      <td style={{ textAlign: "right" }}>{money(row.riskLoss)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="nc-soft-box nc-customer-intel-risk-card">
            <h3 style={{ marginTop: 0 }}>High Risk Pincodes</h3>
            <table className="nc-customer-intel-mini-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Pincode</th>
                  <th style={{ textAlign: "right" }}>RTO Rate</th>
                  <th style={{ textAlign: "right" }}>Loss</th>
                </tr>
              </thead>
              <tbody>
                {highRtoPincodes.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <div className="nc-empty-state">
                        <div className="nc-empty-illus nc-empty-illus-home">P</div>
                        <div className="nc-empty-mini">No risk pincodes yet.</div>
                        <a href={withEmbedded("/app/alerts")} className="nc-chip">Review Alerts</a>
                      </div>
                    </td>
                  </tr>
                ) : (
                  highRtoPincodes.slice(0, 8).map((row) => (
                    <tr key={`risk-pin-summary-${row.pincode}`}>
                      <td>{row.pincode}</td>
                      <td style={{ textAlign: "right" }}>{row.rtoRate.toFixed(1)}%</td>
                      <td style={{ textAlign: "right" }}>{money(row.riskLoss)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div> : null}

      {false ? <div className="nc-card nc-section nc-control-strip" id="home-kpis">
        <div className="nc-control-group">
          <span className="nc-note">Time window</span>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {DAY_OPTIONS.map((option) => (
              <Link
                key={option}
                to={`?days=${option}`}
                className={`nc-chip ${option === days ? "is-active" : ""}`}
                preventScrollReset
              >
                {option}d
              </Link>
            ))}
          </div>
        </div>
        <div className="nc-control-group">
          <span className="nc-note">View</span>
          <div className="nc-toolbar" style={{ marginBottom: 0 }}>
            {[
              ["overview", "Overview"],
              ["insights", "Insights"],
              ["operations", "Operations"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`nc-chip ${dashboardView === key ? "is-active" : ""}`}
                onClick={() => setDashboardView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div> : null}

      {false ? <div className="nc-kpi-grid nc-section">
        <div className="nc-kpi-card">
          <h3>Gross Revenue</h3>
          <p className="nc-kpi-value">{money(metrics.grossRevenue)}</p>
        </div>
        <div className="nc-kpi-card">
          <h3>Net Cash</h3>
          <p className="nc-kpi-value nc-kpi-positive">{money(metrics.netCash)}</p>
        </div>
        <div className="nc-kpi-card">
          <h3>Standard ROAS</h3>
          <p className="nc-kpi-value">{metrics.roas}x</p>
        </div>
        <div className="nc-kpi-card">
          <h3>Real ROAS</h3>
          <p className={`nc-kpi-value ${Number(metrics.realRoas) >= Number(metrics.roas) ? "nc-kpi-positive" : "nc-kpi-negative"}`}>
            {metrics.realRoas}x
          </p>
        </div>
        <div className="nc-kpi-card">
          <h3>Profit Margin</h3>
          <p className="nc-kpi-value">{metrics.profitMarginPct}%</p>
        </div>
        <div className="nc-kpi-card">
          <h3>Net Cash / Order</h3>
          <p className="nc-kpi-value">{money(metrics.netCashPerOrder)}</p>
          <p style={{ marginTop: "8px", opacity: 0.75 }}>Orders: {metrics.orderCount}</p>
        </div>
        <div className="nc-kpi-card">
          <h3>Avg Order Value</h3>
          <p className="nc-kpi-value">{money(metrics.avgOrderValue)}</p>
        </div>
      </div> : null}

      {false ? <details className="nc-card nc-section">
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Customize Sections (optional)</summary>
        <p className="nc-note" style={{ marginTop: "10px" }}>Choose what you want to see in each view. Saved per shop.</p>
        <div className="nc-grid-4">
          {[
            ["ai", "AI Search"],
            ["alerts", "Lighthouse Alerts"],
            ["attribution", "Attribution Models"],
            ["incrementality", "Incrementality"],
            ["stopCampaigns", "Stop Campaigns"],
            ["anomalies", "Campaign Anomalies"],
            ["sourceBreakdown", "Source Breakdown"],
            ["spendHistory", "Spend History"],
            ["orders", "Recent Orders"],
          ].map(([key, label]) => (
            <label key={key} className="nc-pill" style={{ gap: "6px" }}>
              <input
                type="checkbox"
                checked={layout[key]}
                onChange={(event) =>
                  setLayout((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
              />
              {label}
            </label>
          ))}
        </div>
      </details> : null}

      

      {false && isSectionVisible("alerts") ? <div id="lighthouse-alerts" className="nc-card nc-section nc-glass">
        <h2>Lighthouse Alerts</h2>
        {alerts.length === 0 ? (
          <p style={{ margin: 0, color: "#027a48" }}>No major anomalies detected in the last 3 days.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            {alerts.map((alert) => (
              <li key={alert} style={{ color: "#b42318", marginBottom: "6px" }}>
                {alert}
              </li>
            ))}
          </ul>
        )}
      </div> : null}

      {isSectionVisible("anomalies") ? <div id="campaign-anomalies" className="nc-card nc-section nc-glass">
        <h2>Campaign Anomalies</h2>
        <p className="nc-note">Detected using rolling 3-day vs prior 3-day comparison.</p>
        <table className="nc-table-card">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Type</th>
              <th style={{ textAlign: "left" }}>Severity</th>
              <th style={{ textAlign: "left" }}>Message</th>
              <th style={{ textAlign: "left" }}>Why Fired</th>
              <th style={{ textAlign: "left" }}>Confidence</th>
              <th style={{ textAlign: "left" }}>Supporting Metrics</th>
            </tr>
          </thead>
          <tbody>
            {displayCampaignAnomalies.length === 0 ? (
              <tr>
                <td colSpan={7}>No major anomalies detected right now.</td>
              </tr>
            ) : (
              displayCampaignAnomalies.map((row, idx) => (
                <tr className={row.severity === "high" ? "nc-row-severity-high" : "nc-row-severity-medium"} key={`anomaly-${row.source}-${row.type}-${idx}`}>
                  <td data-label="Source">{row.source}</td>
                  <td data-label="Type">{row.type}</td>
                  <td data-label="Severity">
                    <span className={`nc-pill ${row.severity === "high" ? "nc-risk-high" : "nc-risk-medium"}`}>
                      {row.severity}
                    </span>
                  </td>
                  <td data-label="Message">{row.message}</td>
                  <td data-label="Why Fired">{row.why || "-"}</td>
                  <td data-label="Confidence">{row.confidence || "-"}</td>
                  <td data-label="Supporting Metrics">{Array.isArray(row.support) ? row.support.join(" | ") : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div> : null}

      {isSectionVisible("orders") ? (
        <div id="high-value-customers" className="nc-card nc-section nc-glass">
          <h2>High-Value Customers</h2>
          <p className="nc-note">Top gold-tier customers by lifetime net cash.</p>
          <table className="nc-table-card">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Customer</th>
                <th style={{ textAlign: "left" }}>Contact</th>
                <th style={{ textAlign: "right" }}>Orders</th>
                <th style={{ textAlign: "right" }}>Lifetime Net</th>
                <th style={{ textAlign: "left" }}>Next Order Window</th>
                <th style={{ textAlign: "left" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {highValueCustomers.length === 0 ? (
                <tr>
                  <td colSpan={6}>No gold-tier customers yet. Do this next: open Campaigns and improve UTM mapping + retention flows.</td>
                </tr>
              ) : (
                highValueCustomers.map((row) => (
                  <tr key={`hvc-${row.customerKey}`}>
                    <td data-label="Customer">{row.customerName || "Guest Customer"}</td>
                    <td data-label="Contact">{row.customerEmail || row.customerPhone || "-"}</td>
                    <td data-label="Orders" style={{ textAlign: "right" }}>{row.totalOrders}</td>
                    <td data-label="Lifetime Net" style={{ textAlign: "right" }}>{money(row.lifetimeNet)}</td>
                    <td data-label="Next Order Window">
                      {row.predictedNextOrderFrom && row.predictedNextOrderTo
                        ? `${new Date(row.predictedNextOrderFrom).toLocaleDateString()} - ${new Date(row.predictedNextOrderTo).toLocaleDateString()}`
                        : "Not enough history"}
                    </td>
                    <td data-label="Action">
                      <button
                        type="button"
                        onClick={() => {
                          const firstOrderId = row.orders?.[0]?.id || null;
                          if (firstOrderId) setSelectedOrder360Id(firstOrderId);
                        }}
                      >
                        Review 360
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {isSectionVisible("attribution") && hasPremium ? <div className="nc-card nc-section nc-glass">
        <h2>Attribution Models (Beta)</h2>
        <p className="nc-note">
          Compare top campaign contributions by Last Click, First Click, and Linear models.
        </p>
        <div className="nc-grid-4">
          {[
            ["Last Click", attributionModels.lastClick],
            ["First Click", attributionModels.firstClick],
            ["Linear", attributionModels.linear],
            ["Time Decay", attributionModels.timeDecay],
          ].map(([title, rows]) => (
            <div key={title} className="nc-soft-box">
              <h3 style={{ marginTop: 0 }}>{title}</h3>
              {(rows || []).length === 0 ? (
                <p style={{ margin: 0 }}>No data. Do this next: connect channels and run a sync from Connectors.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Source</th>
                      <th style={{ textAlign: "right" }}>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((row) => (
                      <tr key={`${title}-${row.source}-${row.campaignId}-${row.campaignName}`}>
                        <td>{row.campaignName || row.source}</td>
                        <td style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </div> : isSectionVisible("attribution") ? (
        <div className="nc-card nc-section">
          <h2>Attribution Models (Beta)</h2>
          <p className="nc-note">Upgrade to Premium to unlock first-click, linear, and time-decay attribution views.</p>
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      ) : null}

      {false && isSectionVisible("stopCampaigns") && hasPro ? <div id="stop-campaigns-old" className="nc-card nc-section nc-glass">
        <h2>Campaigns to Stop Running</h2>
        <p className="nc-note">Heuristic list based on low real ROAS and low/negative net cash in selected time window.</p>
        <table className="nc-table-card nc-sticky-table">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Source</th>
              <th style={{ textAlign: "left" }}>Campaign</th>
              <th style={{ textAlign: "right" }}>Orders</th>
              <th style={{ textAlign: "right" }}>Net Cash</th>
              <th style={{ textAlign: "right" }}>Real ROAS</th>
              <th style={{ textAlign: "left" }}>Priority</th>
              <th style={{ textAlign: "left" }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {stopCampaigns.length === 0 ? (
              <tr>
                <td colSpan={7}>No immediate stop candidates found.</td>
              </tr>
            ) : (
              stopCampaigns.map((row) => {
                const severity = getCampaignSeverity(row);
                return (
                <tr className={severity.label === "High" ? "nc-row-severity-high" : severity.label === "Medium" ? "nc-row-severity-medium" : "nc-row-severity-low"} key={`stop-${row.source}-${row.campaignId}-${row.campaignName}`}>
                  <td data-label="Source">{row.source}</td>
                  <td data-label="Campaign">{row.campaignName || row.campaignId || "Unmapped"}</td>
                  <td data-label="Orders" style={{ textAlign: "right" }}>{row.orders}</td>
                  <td data-label="Net Cash" style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                  <td data-label="Real ROAS" style={{ textAlign: "right" }}>{row.realRoas.toFixed(2)}x</td>
                  <td data-label="Priority">
                    <span className={`nc-pill ${severity.className}`}>{severity.label}</span>
                  </td>
                  <td data-label="Reason">{severity.reason}</td>
                </tr>
              )})
            )}
          </tbody>
        </table>
      </div> : false ? (
        <div id="stop-campaigns" className="nc-card nc-section">
          <h2>Campaigns to Stop Running</h2>
          <p className="nc-note">Upgrade to Pro to unlock campaign stop recommendations and priority signals.</p>
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      ) : null}

      {false ? <div className="nc-card nc-section nc-glass">
        <h2>High RTO / Returns Risk Zones</h2>
        <p className="nc-note">
          Automatically flags high-risk items and pincodes based on recorded RTO/return/refund losses.
        </p>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <h3 style={{ marginTop: 0 }}>High Risk Items</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Item</th>
                  <th style={{ textAlign: "right" }}>Qty</th>
                  <th style={{ textAlign: "right" }}>Loss</th>
                </tr>
              </thead>
              <tbody>
                {highRtoItems.length === 0 ? (
                  <tr><td colSpan={3}>No risk items yet.</td></tr>
                ) : (
                  highRtoItems.slice(0, 8).map((row) => (
                    <tr key={`risk-item-${row.item}-${row.variant}`}>
                      <td>{row.item}{row.variant && row.variant !== "-" ? ` (${row.variant})` : ""}</td>
                      <td style={{ textAlign: "right" }}>{row.qtyAtRisk}</td>
                      <td style={{ textAlign: "right" }}>{money(row.riskLoss)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="nc-soft-box">
            <h3 style={{ marginTop: 0 }}>High Risk Pincodes</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Pincode</th>
                  <th style={{ textAlign: "right" }}>RTO Rate</th>
                  <th style={{ textAlign: "right" }}>Loss</th>
                </tr>
              </thead>
              <tbody>
                {highRtoPincodes.length === 0 ? (
                  <tr><td colSpan={3}>No risk pincodes yet.</td></tr>
                ) : (
                  highRtoPincodes.slice(0, 8).map((row) => (
                    <tr key={`risk-pin-${row.pincode}`}>
                      <td>{row.pincode}</td>
                      <td style={{ textAlign: "right" }}>{row.rtoRate.toFixed(1)}%</td>
                      <td style={{ textAlign: "right" }}>{money(row.riskLoss)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div> : null}

      {isSectionVisible("incrementality") && hasPremium ? <div className="nc-card nc-section">
        <h2>Incrementality Snapshot (Heuristic)</h2>
        <p className="nc-note">
          Estimated using paid-source average net cash versus direct baseline in selected window.
        </p>
        <div className="nc-grid-4">
          <div className="nc-soft-box">
            <div>Estimated Incremental Net</div>
            <div className="nc-stat">{money(incrementality.estimatedIncrementalNet)}</div>
          </div>
          <div className="nc-soft-box">
            <div>Estimated Uplift</div>
            <div className="nc-stat">{incrementality.estimatedUpliftPct.toFixed(2)}%</div>
          </div>
          <div className="nc-soft-box">
            <div>Paid vs Direct Orders</div>
            <div className="nc-stat">
              {incrementality.paidOrders} / {incrementality.directOrders}
            </div>
          </div>
        </div>
        <div style={{ marginTop: "16px" }}>
          <h3 style={{ marginBottom: "8px" }}>Cohort-Based Incrementality (Weekly)</h3>
          <table className="nc-table-card nc-sticky-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th style={{ padding: "8px", textAlign: "left" }}>Week</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Paid Orders</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Direct Orders</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Paid Avg Net</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Direct Avg Net</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Incremental Net</th>
                <th style={{ padding: "8px", textAlign: "right" }}>Uplift</th>
              </tr>
            </thead>
            <tbody>
              {(incrementality.cohorts || []).length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: "8px" }}>
                    Not enough cohort data.
                  </td>
                </tr>
              ) : (
                incrementality.cohorts.map((cohort) => (
                  <tr key={cohort.cohortWeek}>
                    <td data-label="Week" style={{ padding: "8px" }}>{cohort.cohortWeek}</td>
                    <td data-label="Paid Orders" style={{ padding: "8px", textAlign: "right" }}>{cohort.paidOrders}</td>
                    <td data-label="Direct Orders" style={{ padding: "8px", textAlign: "right" }}>{cohort.directOrders}</td>
                    <td data-label="Paid Avg Net" style={{ padding: "8px", textAlign: "right" }}>{money(cohort.paidAvg)}</td>
                    <td data-label="Direct Avg Net" style={{ padding: "8px", textAlign: "right" }}>{money(cohort.directAvg)}</td>
                    <td data-label="Incremental Net" style={{ padding: "8px", textAlign: "right" }}>{money(cohort.incrementalNet)}</td>
                    <td data-label="Uplift" style={{ padding: "8px", textAlign: "right" }}>{cohort.upliftPct.toFixed(2)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div> : isSectionVisible("incrementality") ? (
        <div className="nc-card nc-section">
          <h2>Incrementality Snapshot (Heuristic)</h2>
          <p className="nc-note">Upgrade to Premium to unlock incrementality estimation and cohort-level uplift views.</p>
          <Link to="/app/pricing" className="nc-chip">Upgrade plan</Link>
        </div>
      ) : null}

      {false ? <div className="nc-toolbar">
        <Form method="post">
          <input type="hidden" name="intent" value="export-orders-csv" />
          <input type="hidden" name="days" value={days} />
          <button type="submit">
            Export Orders CSV
          </button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="export-spend-csv" />
          <input type="hidden" name="days" value={days} />
          <button type="submit">
            Export Spend CSV
          </button>
        </Form>
        <Form method="post" target="_blank">
          <input type="hidden" name="intent" value="export-customer-360-pack" />
          <input type="hidden" name="limit" value="100" />
          <input type="hidden" name="days" value={days} />
          <button type="submit">
            Export Customer 360 Pack (Top 100)
          </button>
        </Form>
      </div> : null}

      {isSectionVisible("sourceBreakdown") ? <div className="nc-card nc-section">
        <h2>Add Daily Ad Spend</h2>
        <Form method="post" className="nc-form-row" style={{ marginBottom: "16px" }}>
          <input type="hidden" name="intent" value="update-ad-spend" />
          <input type="hidden" name="days" value={days} />
          <label className="nc-form-field">
            Source
            <input name="source" placeholder="google, meta, tiktok" required />
          </label>
          <label className="nc-form-field">
            Date
            <input type="date" name="spendDate" defaultValue={defaultSpendDate} required />
          </label>
          <label className="nc-form-field">
            Spend
            <input type="number" min="0" step="0.01" name="adSpend" required />
          </label>
          <button type="submit">
            Save Spend
          </button>
        </Form>

        <h2>Source Breakdown</h2>
        <table className="nc-table-card nc-sticky-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ padding: "12px", textAlign: "left" }}>Source</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Orders</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Gross</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Net Cash</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Ad Spend</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Std ROAS</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Real ROAS</th>
            </tr>
          </thead>
          <tbody>
            {displaySourceBreakdown.length === 0 && (
              <tr>
                <td style={{ padding: "12px" }} colSpan={7}>
                  No source data yet.
                </td>
              </tr>
            )}
            {displaySourceBreakdown.map((row) => (
              <tr key={row.source} style={{ borderBottom: "1px solid #e0e0e0" }}>
                <td data-label="Source" style={{ padding: "12px", textTransform: "capitalize" }}>{row.source}</td>
                <td data-label="Orders" style={{ padding: "12px", textAlign: "right" }}>{row.orders}</td>
                <td data-label="Gross" style={{ padding: "12px", textAlign: "right" }}>{money(row.grossRevenue)}</td>
                <td data-label="Net Cash" style={{ padding: "12px", textAlign: "right", fontWeight: "bold" }}>{money(row.netCash)}</td>
                <td data-label="Ad Spend" style={{ padding: "12px", textAlign: "right" }}>{money(row.adSpend)}</td>
                <td data-label="Std ROAS" style={{ padding: "12px", textAlign: "right" }}>{row.roas.toFixed(2)}x</td>
                <td data-label="Real ROAS" style={{ padding: "12px", textAlign: "right" }}>{row.realRoas.toFixed(2)}x</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}

      {isSectionVisible("spendHistory") ? <div className="nc-card nc-section">
        <h2>Ad Spend History</h2>
        <table className="nc-table-card nc-sticky-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ padding: "12px", textAlign: "left" }}>Date</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Source</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Ad Spend</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {spendHistory.length === 0 && (
              <tr>
                <td style={{ padding: "12px" }} colSpan={4}>
                  No spend entries in this period.
                </td>
              </tr>
            )}
            {spendHistory.map((entry) => (
              <tr key={entry.id} style={{ borderBottom: "1px solid #e0e0e0" }}>
                <td data-label="Date" style={{ padding: "12px" }}>{new Date(entry.spendDate).toLocaleDateString()}</td>
                <td data-label="Source" style={{ padding: "12px", textTransform: "capitalize" }}>{entry.source}</td>
                <td data-label="Ad Spend" style={{ padding: "12px", textAlign: "right" }}>{money(entry.adSpend)}</td>
                <td data-label="Actions" style={{ padding: "12px" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <Form method="post" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input type="hidden" name="intent" value="edit-spend-entry" />
                      <input type="hidden" name="entryId" value={entry.id} />
                      <input type="hidden" name="days" value={days} />
                      <input
                        type="number"
                        name="adSpend"
                        min="0"
                        step="0.01"
                        defaultValue={Number(entry.adSpend || 0).toFixed(2)}
                        style={{ width: "100px", padding: "6px" }}
                      />
                      <button type="submit" style={{ padding: "6px 10px", cursor: "pointer" }}>
                        Update
                      </button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-spend-entry" />
                      <input type="hidden" name="entryId" value={entry.id} />
                      <input type="hidden" name="days" value={days} />
                      <button type="submit" style={{ padding: "6px 10px", cursor: "pointer", color: "#b42318" }}>
                        Delete
                      </button>
                    </Form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}

      {isSectionVisible("orders") ? <div className="nc-card">
        <h2>Recent Orders</h2>
        <p className="nc-note" style={{ marginTop: 0 }}>
          Showing {displayedOrders.length} of {orders.length} orders for this window.
        </p>
        <table className="nc-table-card nc-sticky-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f5f5f5" }}>
              <th style={{ padding: "12px", textAlign: "left" }}>Order</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Date</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Campaign</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Items</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Gross Value</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Status</th>
              <th style={{ padding: "12px", textAlign: "right" }}>Net Cash</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Journey</th>
              <th style={{ padding: "12px", textAlign: "left" }}>Customer 360</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td style={{ padding: "12px" }} colSpan={9}>
                  No orders in this period.
                </td>
              </tr>
            )}
            {displayedOrders.map((order) => {
              const isExpanded = expandedOrderId === order.id;
              return (
                <Fragment key={order.id}>
                  <tr key={`row-${order.id}`} style={{ borderBottom: "1px solid #e0e0e0" }}>
                    <td data-label="Order" style={{ padding: "12px" }}>#{order.orderNumber}</td>
                    <td data-label="Date" style={{ padding: "12px" }}>{new Date(order.createdAt).toLocaleDateString()}</td>
                    <td data-label="Campaign" style={{ padding: "12px" }}>
                      {order.campaignName || order.campaignId ? (
                        <>
                          <div>{order.campaignName || "-"}</div>
                          <div style={{ opacity: 0.75 }}>{order.campaignId || "-"}</div>
                        </>
                      ) : (
                        "Unmapped"
                      )}
                    </td>
                    <td data-label="Items" style={{ padding: "12px" }}>
                      {(order.lineItems || []).length === 0
                        ? "-"
                        : order.lineItems
                            .map(
                              (item) =>
                                `${item.title}${item.variantTitle ? ` (${item.variantTitle})` : ""} x${item.quantity}`,
                            )
                            .join(", ")}
                    </td>
                    <td data-label="Gross Value" style={{ padding: "12px", textAlign: "right" }}>{money(order.grossValue)}</td>
                    <td data-label="Status" style={{ padding: "12px" }}>{order.financialStatus || "pending"}</td>
                    <td data-label="Net Cash" style={{ padding: "12px", textAlign: "right", fontWeight: "bold" }}>{money(order.netCash)}</td>
                    <td data-label="Journey" style={{ padding: "12px" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                        style={{ padding: "6px 10px", cursor: "pointer" }}
                      >
                        {isExpanded ? "Hide" : "View"}
                      </button>
                    </td>
                    <td data-label="Customer 360" style={{ padding: "12px" }}>
                      <button type="button" onClick={() => setSelectedOrder360Id(order.id)}>
                        Review 360
                      </button>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr key={`detail-${order.id}`} style={{ borderBottom: "1px solid #e0e0e0", background: "#fafafa" }}>
                      <td data-label="Journey Details" colSpan={9} style={{ padding: "12px" }}>
                        <div style={{ display: "grid", gap: "8px" }}>
                          <div>
                            <strong>Primary Attribution:</strong>{" "}
                            {order.marketingSource || "unknown"} | {order.campaignName || "-"} | {order.campaignId || "-"}
                          </div>
                          <div>
                            <strong>First Click:</strong>{" "}
                            {order.firstClickSource || "-"} | {order.firstClickCampaignName || "-"} |{" "}
                            {order.firstClickCampaignId || "-"}
                          </div>
                          <div>
                            <strong>Last Click:</strong>{" "}
                            {order.lastClickSource || "-"} | {order.lastClickCampaignName || "-"} |{" "}
                            {order.lastClickCampaignId || "-"}
                          </div>
                          <div>
                            <strong>Customer:</strong>{" "}
                            {order.customerName || "-"} | {order.customerEmail || "-"} | {order.customerPhone || "-"}
                          </div>
                          <div>
                            <strong>Address:</strong>{" "}
                            {[order.shippingAddress1, order.shippingAddress2, order.shippingCity, order.shippingPincode]
                              .filter(Boolean)
                              .join(", ") || "-"}
                          </div>
                          <div>
                            <strong>Touchpoint Path:</strong>
                            <ul style={{ margin: "6px 0 0 16px" }}>
                              {parseTouchpoints(order.touchpointsJson).length === 0 ? (
                                <li>No explicit touchpoint path captured.</li>
                              ) : (
                                parseTouchpoints(order.touchpointsJson).map((touch, idx) => (
                                  <li key={`${order.id}-path-${idx}`}>
                                    {touch.source || "unknown"} | {touch.campaignName || "-"} |{" "}
                                    {touch.campaignId || "-"} | {touch.occurredAt || "-"}
                                  </li>
                                ))
                              )}
                            </ul>
                          </div>
                          <div>
                            <strong>Tool Touchpoints:</strong>
                            <ul style={{ margin: "6px 0 0 16px" }}>
                              {(order.toolAttributions || []).length === 0 ? (
                                <li>No tool touchpoints mapped.</li>
                              ) : (
                                (order.toolAttributions || []).map((touch) => (
                                  <li key={`${order.id}-${touch.tool}-${touch.id || touch.campaignId || "tp"}`}>
                                    {touch.tool} | {touch.campaignName || "-"} | {touch.campaignId || "-"} |{" "}
                                    {touch.adSetId || "-"} | {touch.adId || "-"}
                                  </li>
                                ))
                              )}
                            </ul>
                          </div>
                          <div>
                            <strong>Items:</strong>
                            <ul style={{ margin: "6px 0 0 16px" }}>
                              {(order.lineItems || []).length === 0 ? (
                                <li>No line items.</li>
                              ) : (
                                (order.lineItems || []).map((item, idx) => (
                                  <li key={`${order.id}-line-${idx}-${item.sku || item.title}`}>
                                    {item.title} | Variant: {item.variantTitle || "-"} | SKU: {item.sku || "-"} | Qty: {item.quantity} | Unit:{" "}
                                    {money(item.unitPrice)} | Line: {money(item.lineTotal)}
                                  </li>
                                ))
                              )}
                            </ul>
                          </div>
                          <div>
                            <strong>Risk Flags:</strong> Returned: {order.isReturned ? "Yes" : "No"} | RTO:{" "}
                            {order.isRTO ? "Yes" : "No"} | Return Loss: {money(order.returnTotal || 0)} | RTO Loss:{" "}
                            {money(order.rtoTotal || 0)} | Exchange Adj: {money(order.exchangeAdjustment || 0)}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {hasMoreOrders ? (
          <div className="nc-toolbar" style={{ marginBottom: 0, marginTop: "10px" }}>
            <button
              type="button"
              className="nc-chip"
              onClick={() => setVisibleOrdersCount((current) => Math.min(orders.length, current + 100))}
            >
              Load 100 more
            </button>
            <button
              type="button"
              className="nc-chip"
              onClick={() => setVisibleOrdersCount(orders.length)}
            >
              Load all visible rows
            </button>
          </div>
        ) : null}
      </div> : null}

      {selectedOrder360 ? (
        <div className="nc-modal-overlay" role="dialog" aria-modal="true" onClick={() => setSelectedOrder360Id(null)}>
          <div className="nc-modal nc-360-modal" onClick={(event) => event.stopPropagation()}>
            <div className="nc-modal-header">
              <div>
                <h3 style={{ margin: 0 }}>Customer 360</h3>
                <p className="nc-note" style={{ margin: "4px 0 0" }}>
                  Order #{selectedOrder360.orderNumber} | {selectedOrder360.customerName || "Guest Customer"}
                </p>
              </div>
              <div className="nc-toolbar" style={{ marginBottom: 0 }}>
                <button type="button" onClick={exportCustomer360Pdf}>Export PDF</button>
                <button type="button" onClick={() => setSelectedOrder360Id(null)}>
                  Close
                </button>
              </div>
            </div>

            <div className="nc-360-grid">
              <div className="nc-soft-box">
                <h4 style={{ marginTop: 0 }}>Customer Profile</h4>
                <p><strong>Name:</strong> {selectedOrder360.customerName || "-"}</p>
                <p><strong>Email:</strong> {selectedOrder360.customerEmail || "-"}</p>
                <p><strong>Phone:</strong> {selectedOrder360.customerPhone || "-"}</p>
                <p>
                  <strong>Address:</strong>{" "}
                  {[
                    selectedOrder360.shippingAddress1,
                    selectedOrder360.shippingAddress2,
                    selectedOrder360.shippingCity,
                    selectedOrder360.shippingPincode,
                    selectedOrder360.shippingState,
                    selectedOrder360.shippingCountry,
                  ]
                    .filter(Boolean)
                    .join(", ") || "-"}
                </p>
                <p><strong>Total Orders:</strong> {selectedCustomerHistory?.totalOrders || 1}</p>
                <p><strong>Lifetime Gross:</strong> {money(selectedCustomerHistory?.lifetimeGross || selectedOrder360.grossValue)}</p>
                <p><strong>Lifetime Net:</strong> {money(selectedCustomerHistory?.lifetimeNet || selectedOrder360.netCash)}</p>
                <p><strong>LTV Tier:</strong> {String(selectedCustomerHistory?.ltvTier || "bronze").toUpperCase()}</p>
                <p>
                  <strong>Repeat Purchase Frequency:</strong>{" "}
                  {selectedCustomerHistory?.avgDaysBetweenOrders != null
                    ? `${selectedCustomerHistory.avgDaysBetweenOrders.toFixed(1)} days`
                    : "Not enough history"}
                </p>
                <p>
                  <strong>Predicted Next Order Window:</strong>{" "}
                  {selectedCustomerHistory?.predictedNextOrderFrom && selectedCustomerHistory?.predictedNextOrderTo
                    ? `${new Date(selectedCustomerHistory.predictedNextOrderFrom).toLocaleDateString()} - ${new Date(selectedCustomerHistory.predictedNextOrderTo).toLocaleDateString()}`
                    : "Not enough history"}
                </p>
              </div>
              <div className="nc-soft-box">
                <h4 style={{ marginTop: 0 }}>Order Snapshot</h4>
                <p><strong>Gross:</strong> {money(selectedOrder360.grossValue)}</p>
                <p><strong>Net Cash:</strong> {money(selectedOrder360.netCash)}</p>
                <p><strong>Financial Status:</strong> {selectedOrder360.financialStatus || "-"}</p>
                <p><strong>Fulfillment Status:</strong> {selectedOrder360.fulfillmentStatus || "-"}</p>
                <p>
                  <strong>Risk:</strong> Returned {selectedOrder360.isReturned ? "Yes" : "No"} | RTO{" "}
                  {selectedOrder360.isRTO ? "Yes" : "No"}
                </p>
                <p>
                  <strong>Preferred Sizes:</strong>{" "}
                  {(selectedCustomerHistory?.preferredSizes || [])
                    .map((row) => `${row.size} (${row.qty})`)
                    .join(", ") || "-"}
                </p>
                <p>
                  <strong>Preferred Categories:</strong>{" "}
                  {(selectedCustomerHistory?.preferredCategories || [])
                    .map((row) => `${row.category} (${row.qty})`)
                    .join(", ") || "-"}
                </p>
              </div>
            </div>

            <div className="nc-soft-box" style={{ marginTop: "12px" }}>
              <h4 style={{ marginTop: 0 }}>Previous Orders</h4>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Order</th>
                    <th style={{ textAlign: "left" }}>Date</th>
                    <th style={{ textAlign: "right" }}>Gross</th>
                    <th style={{ textAlign: "right" }}>Net</th>
                    <th style={{ textAlign: "left" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedCustomerHistory?.previousOrders || []).length === 0 ? (
                    <tr><td colSpan={5}>No previous orders found.</td></tr>
                  ) : (
                    (selectedCustomerHistory?.previousOrders || []).map((row) => (
                      <tr key={`prev-order-${row.id}`}>
                        <td>#{row.orderNumber}</td>
                        <td>{new Date(row.createdAt).toLocaleDateString()}</td>
                        <td style={{ textAlign: "right" }}>{money(row.grossValue)}</td>
                        <td style={{ textAlign: "right" }}>{money(row.netCash)}</td>
                        <td>{row.financialStatus || "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="nc-soft-box" style={{ marginTop: "12px" }}>
              <h4 style={{ marginTop: 0 }}>Timeline</h4>
              <ol className="nc-360-timeline">
                {selectedOrderTimeline.map((event, idx) => (
                  <li key={`${selectedOrder360.id}-timeline-${idx}`} className={`nc-360-${event.type}`}>
                    <div className="nc-360-time">{formatDateTime(event.time)}</div>
                    <div className="nc-360-content">
                      <div className="nc-360-rowhead">
                        <strong>{event.title}</strong>
                        <span className={`nc-badge ${getTimelineBadge(event.type).className}`}>{getTimelineBadge(event.type).label}</span>
                      </div>
                      <div>{event.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : (error?.message || "Something went wrong while loading Home.");
  return (
    <div className="nc-shell nc-home">
      <div className="nc-card nc-section">
        <h2>Home Unavailable</h2>
        <p className="nc-note">{message}</p>
        <a className="nc-chip" href={withEmbedded("/app")}>Reload Home</a>
      </div>
    </div>
  );
}


