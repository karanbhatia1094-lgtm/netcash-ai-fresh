import crypto from "node:crypto";
import { prisma } from "../../prisma.client.js";
import { resolveShopConfig } from "./release-control.server";

function normalizeMarketingSource(rawValue) {
  const source = String(rawValue || "").trim().toLowerCase();
  if (!source) return "direct";

  if (source.includes("whatsapp") || source === "wa") return "whatsapp";
  if (source.includes("sms") || source.includes("text_message")) return "sms";
  if (source.includes("rcs")) return "rcs";
  if (source.includes("instagram")) return "instagram";
  if (source.includes("facebook") || source === "fb") return "facebook";
  if (source.includes("google") || source.includes("gclid")) return "google";
  if (source.includes("meta")) return "meta";
  if (source.includes("tiktok")) return "tiktok";
  if (source.includes("youtube")) return "youtube";
  if (source.includes("bing") || source.includes("microsoft")) return "bing";
  if (source.includes("email") || source.includes("klaviyo") || source.includes("mailchimp")) return "email";
  if (source.includes("moengage")) return "moengage";
  if (source.includes("clevertap")) return "clevertap";
  if (source.includes("webengage")) return "webengage";
  if (source.includes("kwikengage")) return "kwikengage";
  if (source.includes("bitespeed")) return "bitespeed";
  if (source.includes("bik.ai") || source.includes("bikai")) return "bikai";
  if (source.includes("nitro")) return "nitro";
  if (source.includes("wati")) return "wati";
  if (source.includes("spur")) return "spur";
  if (source.includes("affiliate")) return "affiliate";
  if (source.includes("direct") || source.includes("none")) return "direct";

  return source.replace(/\s+/g, "_");
}

function parseUrl(urlValue) {
  if (!urlValue) return null;
  try {
    return new URL(String(urlValue), "https://dummy.local");
  } catch {
    return null;
  }
}

function getSourceFromUrl(urlValue) {
  const parsed = parseUrl(urlValue);
  if (!parsed) return null;

  const utmSource = parsed.searchParams.get("utm_source");
  if (utmSource) return utmSource;

  const host = parsed.hostname.toLowerCase();
  if (host.includes("google")) return "google";
  if (host.includes("facebook") || host.includes("instagram")) return "meta";
  if (host.includes("tiktok")) return "tiktok";
  if (host.includes("youtube")) return "youtube";

  return null;
}

function extractCustomAttributeMap(orderData) {
  const rows = orderData?.note_attributes || orderData?.customAttributes || [];
  const map = new Map();

  if (!Array.isArray(rows)) return map;

  for (const row of rows) {
    const key = String(row?.name || row?.key || "").trim().toLowerCase();
    const value = String(row?.value || "").trim();
    if (key && value) map.set(key, value);
  }

  return map;
}

function extractCampaignData(orderData) {
  const landingSite = orderData?.landing_site || orderData?.landingPageUrl || "";
  const referringSite = orderData?.referring_site || orderData?.referringSite || "";
  const customMap = extractCustomAttributeMap(orderData);

  const landingUrl = parseUrl(landingSite);
  const refUrl = parseUrl(referringSite);

  const firstParam = (...keys) => {
    for (const key of keys) {
      const value = landingUrl?.searchParams.get(key) || refUrl?.searchParams.get(key) || customMap.get(key);
      if (value) return value;
    }
    return null;
  };

  const utmSource = firstParam("utm_source", "source") || null;
  const utmMedium = firstParam("utm_medium", "medium") || null;
  const utmCampaign = firstParam("utm_campaign", "campaign") || null;

  const campaignId =
    firstParam("campaign_id", "utm_id", "campaignid", "cid") ||
    customMap.get("campaign_id") ||
    null;

  const clickId =
    firstParam("gclid", "fbclid", "ttclid", "msclkid", "li_fat_id") ||
    customMap.get("gclid") ||
    customMap.get("fbclid") ||
    null;

  const fallbackSource = orderData?.source_name || orderData?.sourceName;
  const marketingSource = normalizeMarketingSource(
    utmSource || getSourceFromUrl(landingSite) || getSourceFromUrl(referringSite) || fallbackSource || "direct",
  );

  return {
    marketingSource,
    campaignId,
    campaignName: utmCampaign,
    utmSource,
    utmMedium,
    utmCampaign,
    clickId,
    landingSite: landingSite || null,
    referringSite: referringSite || null,
  };
}

function parseTouchpointsFromCustomMap(customMap) {
  const candidates = [
    customMap.get("touchpoints"),
    customMap.get("netcash_touchpoints"),
    customMap.get("attribution_path"),
    customMap.get("touchpoint_path"),
  ].filter(Boolean);

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => ({
            source: normalizeMarketingSource(row?.source || row?.channel || row?.provider || ""),
            campaignId: row?.campaignId || row?.campaign_id || null,
            campaignName: row?.campaignName || row?.campaign_name || null,
            occurredAt: row?.occurredAt || row?.timestamp || null,
          }))
          .filter((row) => row.source);
      }
    } catch {
      // Ignore malformed touchpoint JSON and fall through
    }
  }

  const pipeValue = customMap.get("touchpoint_pipe");
  if (pipeValue) {
    return pipeValue
      .split("|")
      .map((part) => {
        const [source, campaignId = "", campaignName = ""] = String(part).split(":");
        return {
          source: normalizeMarketingSource(source),
          campaignId: campaignId || null,
          campaignName: campaignName || null,
          occurredAt: null,
        };
      })
      .filter((row) => row.source);
  }

  return [];
}

function extractTouchpointData(orderData, attribution) {
  const customMap = extractCustomAttributeMap(orderData);
  const touchpoints = parseTouchpointsFromCustomMap(customMap);

  const fallbackTouch = {
    source: normalizeMarketingSource(attribution.marketingSource || "direct"),
    campaignId: attribution.campaignId || null,
    campaignName: attribution.campaignName || null,
    occurredAt: orderData?.created_at || orderData?.createdAt || null,
  };

  const allTouchpoints = touchpoints.length > 0 ? touchpoints : [fallbackTouch];
  const first = allTouchpoints[0] || fallbackTouch;
  const last = allTouchpoints[allTouchpoints.length - 1] || fallbackTouch;

  return {
    firstClickSource: first.source || fallbackTouch.source,
    firstClickCampaignId: first.campaignId || null,
    firstClickCampaignName: first.campaignName || null,
    lastClickSource: last.source || fallbackTouch.source,
    lastClickCampaignId: last.campaignId || null,
    lastClickCampaignName: last.campaignName || null,
    touchpointsJson: JSON.stringify(allTouchpoints),
  };
}

function extractCustomerData(orderData) {
  const customer = orderData?.customer || {};
  const shipping = orderData?.shipping_address || orderData?.shippingAddress || {};

  const firstName = String(customer?.firstName || customer?.first_name || "").trim();
  const lastName = String(customer?.lastName || customer?.last_name || "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  return {
    customerName: fullName,
    customerEmail: customer?.email || null,
    customerPhone: customer?.phone || shipping?.phone || null,
    shippingAddress1: shipping?.address1 || null,
    shippingAddress2: shipping?.address2 || null,
    shippingCity: shipping?.city || null,
    shippingPincode: shipping?.zip || shipping?.postalCode || null,
    shippingState: shipping?.province || shipping?.state || null,
    shippingCountry: shipping?.country || shipping?.countryCodeV2 || null,
  };
}

function toNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function safeHash(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return crypto.createHash("sha256").update(text).digest("hex");
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseUserAgentForDevice(userAgent = "") {
  const ua = String(userAgent || "").toLowerCase();
  const osName = ua.includes("android")
    ? "android"
    : ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")
      ? "ios"
      : ua.includes("windows")
        ? "windows"
        : ua.includes("mac os")
          ? "macos"
          : ua.includes("linux")
            ? "linux"
            : "unknown";
  const deviceType = ua.includes("mobile")
    ? "mobile"
    : ua.includes("ipad") || ua.includes("tablet")
      ? "tablet"
      : "desktop";
  return { osName, deviceType };
}

function buildIdentityFromData({ email, phone, clickId, fallbackKey }) {
  const emailNorm = normalizeEmail(email);
  const phoneNorm = normalizePhone(phone);
  const emailHash = safeHash(emailNorm);
  const phoneHash = safeHash(phoneNorm);
  const clickHash = safeHash(clickId);

  if (emailHash) {
    return { identityKey: `email:${emailHash}`, identityType: "email", identityHash: emailHash, emailHash, phoneHash, clickHash };
  }
  if (phoneHash) {
    return { identityKey: `phone:${phoneHash}`, identityType: "phone", identityHash: phoneHash, emailHash, phoneHash, clickHash };
  }
  if (clickHash) {
    return { identityKey: `click:${clickHash}`, identityType: "click_id", identityHash: clickHash, emailHash, phoneHash, clickHash };
  }
  const fallbackHash = safeHash(String(fallbackKey || ""));
  if (fallbackHash) {
    return { identityKey: `anon:${fallbackHash}`, identityType: "anonymous", identityHash: fallbackHash, emailHash, phoneHash, clickHash };
  }
  return { identityKey: null, identityType: "unknown", identityHash: null, emailHash, phoneHash, clickHash };
}

function extractBehaviorData(orderData, customMap) {
  const paymentNames = orderData?.payment_gateway_names || orderData?.paymentGatewayNames || [];
  const paymentMethod =
    (Array.isArray(paymentNames) && paymentNames[0]) ||
    customMap.get("payment_method") ||
    customMap.get("payment_gateway") ||
    null;
  const discountCodes = orderData?.discount_codes || orderData?.discountCodes || [];
  const couponCode =
    (Array.isArray(discountCodes) && (discountCodes[0]?.code || discountCodes[0])) ||
    customMap.get("discount_code") ||
    customMap.get("coupon_code") ||
    null;
  const ua =
    orderData?.client_details?.user_agent ||
    orderData?.clientDetails?.userAgent ||
    customMap.get("user_agent") ||
    customMap.get("ua") ||
    "";
  const parsedUa = parseUserAgentForDevice(ua);
  const deviceType = customMap.get("device_type") || parsedUa.deviceType || null;
  const osName = customMap.get("os_name") || customMap.get("device_os") || parsedUa.osName || null;
  const handset = customMap.get("handset") || "";
  const handsetBrand = customMap.get("handset_brand") || (handset ? handset.split(" ")[0] : null);
  const handsetModel = customMap.get("handset_model") || (handset || null);
  const messageOpenedAt =
    parseDateOrNull(customMap.get("message_opened_at")) ||
    parseDateOrNull(customMap.get("whatsapp_opened_at")) ||
    parseDateOrNull(customMap.get("sms_opened_at"));
  const adSeenAt =
    parseDateOrNull(customMap.get("ad_seen_at")) ||
    parseDateOrNull(customMap.get("ad_viewed_at")) ||
    parseDateOrNull(customMap.get("ad_clicked_at"));
  const sessionId = customMap.get("session_id") || customMap.get("netcash_session_id") || null;
  return {
    paymentMethod: paymentMethod ? String(paymentMethod) : null,
    couponCode: couponCode ? String(couponCode) : null,
    deviceType: deviceType ? String(deviceType).toLowerCase() : null,
    osName: osName ? String(osName).toLowerCase() : null,
    handsetBrand: handsetBrand ? String(handsetBrand) : null,
    handsetModel: handsetModel ? String(handsetModel) : null,
    messageOpenedAt,
    adSeenAt,
    sessionId,
    userAgent: ua ? String(ua) : null,
  };
}

async function writeUniversalEvent({
  shop,
  eventType,
  eventAt,
  orderId = null,
  orderNumber = null,
  source = null,
  campaignId = null,
  campaignName = null,
  identityKey = null,
  identityType = null,
  identityHash = null,
  customerEmailHash = null,
  customerPhoneHash = null,
  clickIdHash = null,
  sessionId = null,
  paymentMethod = null,
  couponCode = null,
  discountAmount = null,
  grossValue = null,
  netCash = null,
  messageChannel = null,
  messageOpenedAt = null,
  adSeenAt = null,
  purchaseAt = null,
  deviceType = null,
  osName = null,
  handsetBrand = null,
  handsetModel = null,
  metadata = null,
}) {
  if (!prisma.universalSignalEvent) return null;
  const when = parseDateOrNull(eventAt) || new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const createdEvent = await tx.universalSignalEvent.create({
        data: {
          shop,
          eventType: String(eventType || "interaction"),
          eventAt: when,
          orderId: orderId || null,
          orderNumber: orderNumber || null,
          source: source || null,
          campaignId: campaignId || null,
          campaignName: campaignName || null,
          identityKey: identityKey || null,
          customerEmailHash: customerEmailHash || null,
          customerPhoneHash: customerPhoneHash || null,
          clickIdHash: clickIdHash || null,
          sessionId: sessionId || null,
          paymentMethod: paymentMethod || null,
          couponCode: couponCode || null,
          discountAmount: discountAmount != null ? Number(discountAmount) : null,
          grossValue: grossValue != null ? Number(grossValue) : null,
          netCash: netCash != null ? Number(netCash) : null,
          messageChannel: messageChannel || null,
          messageOpenedAt: messageOpenedAt || null,
          adSeenAt: adSeenAt || null,
          purchaseAt: purchaseAt || null,
          deviceType: deviceType || null,
          osName: osName || null,
          handsetBrand: handsetBrand || null,
          handsetModel: handsetModel || null,
          metadataJson: metadata ? JSON.stringify(metadata) : null,
        },
      });

      if (identityKey && identityHash && tx.universalIdentity && tx.universalIdentityShop) {
        const existingShopLink = await tx.universalIdentityShop.findUnique({
          where: {
            identityKey_shop: { identityKey, shop },
          },
        });

        await tx.universalIdentity.upsert({
          where: { identityKey },
          create: {
            identityKey,
            identityType: identityType || "unknown",
            identityHash,
            firstSeenAt: when,
            lastSeenAt: when,
            eventsCount: 1,
            shopsCount: 1,
          },
          update: {
            lastSeenAt: when,
            eventsCount: { increment: 1 },
            ...(existingShopLink ? {} : { shopsCount: { increment: 1 } }),
          },
        });

        await tx.universalIdentityShop.upsert({
          where: {
            identityKey_shop: { identityKey, shop },
          },
          create: {
            identityKey,
            shop,
            firstSeenAt: when,
            lastSeenAt: when,
            eventsCount: 1,
            totalOrders: eventType === "purchase" ? 1 : 0,
            totalGrossValue: eventType === "purchase" ? Number(grossValue || 0) : 0,
            totalNetCash: eventType === "purchase" ? Number(netCash || 0) : 0,
          },
          update: {
            lastSeenAt: when,
            eventsCount: { increment: 1 },
            totalOrders: eventType === "purchase" ? { increment: 1 } : undefined,
            totalGrossValue: eventType === "purchase" ? { increment: Number(grossValue || 0) } : undefined,
            totalNetCash: eventType === "purchase" ? { increment: Number(netCash || 0) } : undefined,
          },
        });

        if (tx.universalCustomerProfile) {
          await tx.universalCustomerProfile.upsert({
            where: {
              shop_identityKey: { shop, identityKey },
            },
            create: {
              shop,
              identityKey,
              customerEmailHash: customerEmailHash || null,
              customerPhoneHash: customerPhoneHash || null,
              firstSeenAt: when,
              lastSeenAt: when,
              totalOrders: eventType === "purchase" ? 1 : 0,
              totalGrossValue: eventType === "purchase" ? Number(grossValue || 0) : 0,
              totalDiscountAmount: eventType === "purchase" ? Number(discountAmount || 0) : 0,
              totalNetCash: eventType === "purchase" ? Number(netCash || 0) : 0,
              lastPaymentMethod: paymentMethod || null,
              lastCouponCode: couponCode || null,
              lastSource: source || null,
              lastCampaignId: campaignId || null,
              lastCampaignName: campaignName || null,
              lastOsName: osName || null,
              lastHandsetBrand: handsetBrand || null,
              lastHandsetModel: handsetModel || null,
              lastDeviceType: deviceType || null,
            },
            update: {
              lastSeenAt: when,
              totalOrders: eventType === "purchase" ? { increment: 1 } : undefined,
              totalGrossValue: eventType === "purchase" ? { increment: Number(grossValue || 0) } : undefined,
              totalDiscountAmount: eventType === "purchase" ? { increment: Number(discountAmount || 0) } : undefined,
              totalNetCash: eventType === "purchase" ? { increment: Number(netCash || 0) } : undefined,
              customerEmailHash: customerEmailHash || undefined,
              customerPhoneHash: customerPhoneHash || undefined,
              lastPaymentMethod: paymentMethod || undefined,
              lastCouponCode: couponCode || undefined,
              lastSource: source || undefined,
              lastCampaignId: campaignId || undefined,
              lastCampaignName: campaignName || undefined,
              lastOsName: osName || undefined,
              lastHandsetBrand: handsetBrand || undefined,
              lastHandsetModel: handsetModel || undefined,
              lastDeviceType: deviceType || undefined,
            },
          });
        }
      }

      return createdEvent;
    });
  } catch (error) {
    if (!isSchemaMismatchError(error)) throw error;
    return null;
  }
}

function normalizeLineItems(orderData) {
  const rows = orderData?.line_items || [];
  if (!Array.isArray(rows)) return [];

  return rows
    .map((line) => {
      const quantity = Number.parseInt(line?.quantity, 10);
      const safeQty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      const unitPrice = toNumber(line?.price || line?.unit_price || line?.originalUnitPrice || line?.original_unit_price);
      const lineTotal = toNumber(line?.line_total || line?.total || unitPrice * safeQty);
      return {
        title: String(line?.title || line?.name || "Item"),
        variantTitle: line?.variant_title || line?.variantTitle || null,
        sku: line?.sku || null,
        quantity: safeQty,
        unitPrice,
        lineTotal,
      };
    })
    .filter((line) => line.title);
}

function isSchemaMismatchError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("Unknown argument") ||
    message.includes("Unknown field") ||
    message.includes("does not exist in current database") ||
    message.includes("no such table")
  );
}

export async function saveOrder(shop, orderData) {
  try {
    const orderId = String(orderData.id);
    const orderNumber = String(orderData.order_number ?? orderData.name ?? orderId);

    const grossValue = toNumber(orderData.total_price);
    const discountTotal = toNumber(orderData.total_discounts);
    const taxTotal = toNumber(orderData.total_tax);
    const refundTotal = toNumber(orderData.total_refunded);

    let shippingTotal = 0;
    if (Array.isArray(orderData.shipping_lines) && orderData.shipping_lines.length > 0) {
      shippingTotal = orderData.shipping_lines.reduce((sum, line) => sum + toNumber(line.price), 0);
    }

    const customMap = extractCustomAttributeMap(orderData);
    const returnTotal = toNumber(orderData.return_total || customMap.get("return_total"));
    const rtoTotal = toNumber(orderData.rto_total || customMap.get("rto_total"));
    const exchangeAdjustment = toNumber(orderData.exchange_adjustment || customMap.get("exchange_adjustment"));

    const netCash =
      grossValue -
      discountTotal -
      shippingTotal -
      taxTotal -
      refundTotal -
      returnTotal -
      rtoTotal +
      exchangeAdjustment;

    const createdAt = orderData.created_at ? new Date(orderData.created_at) : new Date();
    const attribution = extractCampaignData(orderData);
    const touchpointData = extractTouchpointData(orderData, attribution);
    const customerData = extractCustomerData(orderData);
    const behaviorData = extractBehaviorData(orderData, customMap);
    const identity = buildIdentityFromData({
      email: customerData.customerEmail,
      phone: customerData.customerPhone,
      clickId: attribution.clickId,
      fallbackKey: `${shop}:${orderId}`,
    });
    const lineItems = normalizeLineItems(orderData);
    const tags = Array.isArray(orderData?.tags)
      ? orderData.tags.map((tag) => String(tag).toLowerCase())
      : String(orderData?.tags || "")
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean);
    const statusText = `${String(orderData.financial_status || "").toLowerCase()} ${String(orderData.fulfillment_status || "").toLowerCase()}`;
    const isReturned = returnTotal > 0 || refundTotal > 0 || tags.includes("return") || statusText.includes("refunded");
    const isRTO =
      rtoTotal > 0 ||
      tags.includes("rto") ||
      statusText.includes("rto") ||
      (statusText.includes("cancelled") && !statusText.includes("paid"));

    let order;
    try {
      order = await prisma.$transaction(async (tx) => {
        const upserted = await tx.netCashOrder.upsert({
          where: { orderId },
          update: {
            grossValue,
            discountTotal,
            shippingTotal,
            taxTotal,
            refundTotal,
            returnTotal,
            rtoTotal,
            exchangeAdjustment,
            netCash,
            financialStatus: orderData.financial_status,
            fulfillmentStatus: orderData.fulfillment_status,
            marketingSource: attribution.marketingSource,
            campaignId: attribution.campaignId,
            campaignName: attribution.campaignName,
            utmSource: attribution.utmSource,
            utmMedium: attribution.utmMedium,
            utmCampaign: attribution.utmCampaign,
            clickId: attribution.clickId,
            landingSite: attribution.landingSite,
            referringSite: attribution.referringSite,
            ...customerData,
            firstClickSource: touchpointData.firstClickSource,
            firstClickCampaignId: touchpointData.firstClickCampaignId,
            firstClickCampaignName: touchpointData.firstClickCampaignName,
            lastClickSource: touchpointData.lastClickSource,
            lastClickCampaignId: touchpointData.lastClickCampaignId,
            lastClickCampaignName: touchpointData.lastClickCampaignName,
            touchpointsJson: touchpointData.touchpointsJson,
            isReturned,
            isRTO,
            updatedAt: new Date(),
          },
          create: {
            orderId,
            shop,
            orderNumber,
            createdAt,
            grossValue,
            discountTotal,
            shippingTotal,
            taxTotal,
            refundTotal,
            returnTotal,
            rtoTotal,
            exchangeAdjustment,
            netCash,
            financialStatus: orderData.financial_status,
            fulfillmentStatus: orderData.fulfillment_status,
            marketingSource: attribution.marketingSource,
            campaignId: attribution.campaignId,
            campaignName: attribution.campaignName,
            utmSource: attribution.utmSource,
            utmMedium: attribution.utmMedium,
            utmCampaign: attribution.utmCampaign,
            clickId: attribution.clickId,
            landingSite: attribution.landingSite,
            referringSite: attribution.referringSite,
            ...customerData,
            firstClickSource: touchpointData.firstClickSource,
            firstClickCampaignId: touchpointData.firstClickCampaignId,
            firstClickCampaignName: touchpointData.firstClickCampaignName,
            lastClickSource: touchpointData.lastClickSource,
            lastClickCampaignId: touchpointData.lastClickCampaignId,
            lastClickCampaignName: touchpointData.lastClickCampaignName,
            touchpointsJson: touchpointData.touchpointsJson,
            isReturned,
            isRTO,
          },
        });

        if (tx.orderLineItem) {
          await tx.orderLineItem.deleteMany({ where: { netCashOrderId: upserted.id } });
          if (lineItems.length > 0) {
            await tx.orderLineItem.createMany({
              data: lineItems.map((line) => ({
                netCashOrderId: upserted.id,
                title: line.title,
                variantTitle: line.variantTitle,
                sku: line.sku,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                lineTotal: line.lineTotal,
              })),
            });
          }
        }

        return upserted;
      });
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      order = await prisma.netCashOrder.upsert({
        where: { orderId },
        update: {
          grossValue,
          discountTotal,
          shippingTotal,
          taxTotal,
          refundTotal,
          returnTotal,
          rtoTotal,
          exchangeAdjustment,
          netCash,
          financialStatus: orderData.financial_status,
          fulfillmentStatus: orderData.fulfillment_status,
          marketingSource: attribution.marketingSource,
          updatedAt: new Date(),
        },
        create: {
          orderId,
          shop,
          orderNumber,
          createdAt,
          grossValue,
          discountTotal,
          shippingTotal,
          taxTotal,
          refundTotal,
          returnTotal,
          rtoTotal,
          exchangeAdjustment,
          netCash,
          financialStatus: orderData.financial_status,
          fulfillmentStatus: orderData.fulfillment_status,
          marketingSource: attribution.marketingSource,
        },
      });
    }

    console.log(`Order ${orderNumber} saved for ${shop}`);

    try {
      await writeUniversalEvent({
        shop,
        eventType: "purchase",
        eventAt: createdAt,
        orderId,
        orderNumber,
        source: attribution.marketingSource,
        campaignId: attribution.campaignId,
        campaignName: attribution.campaignName,
        identityKey: identity.identityKey,
        identityType: identity.identityType,
        identityHash: identity.identityHash,
        customerEmailHash: identity.emailHash,
        customerPhoneHash: identity.phoneHash,
        clickIdHash: identity.clickHash,
        sessionId: behaviorData.sessionId,
        paymentMethod: behaviorData.paymentMethod,
        couponCode: behaviorData.couponCode,
        discountAmount: discountTotal,
        grossValue,
        netCash,
        messageChannel: null,
        messageOpenedAt: behaviorData.messageOpenedAt,
        adSeenAt: behaviorData.adSeenAt,
        purchaseAt: createdAt,
        deviceType: behaviorData.deviceType,
        osName: behaviorData.osName,
        handsetBrand: behaviorData.handsetBrand,
        handsetModel: behaviorData.handsetModel,
        metadata: {
          financialStatus: orderData.financial_status || null,
          fulfillmentStatus: orderData.fulfillment_status || null,
          userAgent: behaviorData.userAgent || null,
        },
      });
    } catch (error) {
      console.error("Universal event write failed:", error?.message || error);
    }

    return order;
  } catch (error) {
    console.error("Error saving order:", error);
    throw error;
  }
}

export async function upsertToolAttribution({
  shop,
  orderId,
  orderNumber,
  tool,
  campaignId,
  campaignName,
  adSetId,
  adId,
}) {
  const normalizedTool = String(tool || "manual").trim().toLowerCase();
  if (!normalizedTool) throw new Error("tool is required");

  const order = await prisma.netCashOrder.findFirst({
    where: {
      shop,
      OR: [
        orderId ? { orderId: String(orderId) } : undefined,
        orderNumber ? { orderNumber: String(orderNumber) } : undefined,
        orderNumber ? { orderNumber: `#${String(orderNumber).replace(/^#/, "")}` } : undefined,
      ].filter(Boolean),
    },
  });

  if (!order) {
    throw new Error("Order not found for given shop/orderId/orderNumber");
  }

  if (!prisma.toolAttribution) {
    try {
      return await prisma.netCashOrder.update({
        where: { id: order.id },
        data: {
          campaignId: campaignId || order.campaignId,
          campaignName: campaignName || order.campaignName,
        },
      });
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      return order;
    }
  }

  return prisma.$transaction(async (tx) => {
    await tx.toolAttribution.upsert({
      where: {
        netCashOrderId_tool: {
          netCashOrderId: order.id,
          tool: normalizedTool,
        },
      },
      update: {
        campaignId: campaignId || null,
        campaignName: campaignName || null,
        adSetId: adSetId || null,
        adId: adId || null,
      },
      create: {
        netCashOrderId: order.id,
        tool: normalizedTool,
        campaignId: campaignId || null,
        campaignName: campaignName || null,
        adSetId: adSetId || null,
        adId: adId || null,
      },
    });

    try {
      return await tx.netCashOrder.update({
        where: { id: order.id },
        data: {
          campaignId: campaignId || order.campaignId,
          campaignName: campaignName || order.campaignName,
        },
      });
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      return order;
    }
  });
}

export async function getOrders(shop, days = 365) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - Number(days));

  try {
    return await prisma.netCashOrder.findMany({
      where: {
        shop,
        createdAt: {
          gte: sinceDate,
        },
      },
      include: {
        lineItems: true,
        toolAttributions: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  } catch (error) {
    if (!isSchemaMismatchError(error)) throw error;
    return prisma.netCashOrder.findMany({
      where: {
        shop,
        createdAt: {
          gte: sinceDate,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }
}

export async function ingestUniversalSignalEvents(shop, events = []) {
  const rows = Array.isArray(events) ? events : [];
  const accepted = [];
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    try {
      const identity = buildIdentityFromData({
        email: row.customerEmail || row.email,
        phone: row.customerPhone || row.phone,
        clickId: row.clickId,
        fallbackKey: row.sessionId || row.orderId || `${shop}:${Date.now()}:${i}`,
      });
      await writeUniversalEvent({
        shop,
        eventType: row.eventType || "interaction",
        eventAt: row.eventAt || row.occurredAt || new Date(),
        orderId: row.orderId || null,
        orderNumber: row.orderNumber || null,
        source: normalizeMarketingSource(row.source || row.utmSource || "unknown"),
        campaignId: row.campaignId || null,
        campaignName: row.campaignName || row.utmCampaign || null,
        identityKey: identity.identityKey,
        identityType: identity.identityType,
        identityHash: identity.identityHash,
        customerEmailHash: identity.emailHash,
        customerPhoneHash: identity.phoneHash,
        clickIdHash: identity.clickHash,
        sessionId: row.sessionId || null,
        paymentMethod: row.paymentMethod || null,
        couponCode: row.couponCode || null,
        discountAmount: toNumber(row.discountAmount || 0),
        grossValue: toNumber(row.grossValue || 0),
        netCash: toNumber(row.netCash || 0),
        messageChannel: row.messageChannel || null,
        messageOpenedAt: parseDateOrNull(row.messageOpenedAt),
        adSeenAt: parseDateOrNull(row.adSeenAt),
        purchaseAt: parseDateOrNull(row.purchaseAt),
        deviceType: row.deviceType || null,
        osName: row.osName || null,
        handsetBrand: row.handsetBrand || null,
        handsetModel: row.handsetModel || null,
        metadata: row.metadata || null,
      });
      accepted.push({ index: i });
    } catch (error) {
      errors.push({ index: i, error: error?.message || "unknown_error" });
    }
  }

  return {
    received: rows.length,
    accepted: accepted.length,
    rejected: errors.length,
    errors,
  };
}

export async function getUniversalShopOverview(shop, days = 90) {
  if (!prisma.universalSignalEvent) {
    return {
      days,
      totalEvents: 0,
      uniqueIdentities: 0,
      purchases: 0,
      messageOpens: 0,
      adViews: 0,
      iosPct: 0,
      androidPct: 0,
      topPaymentMethods: [],
      topCoupons: [],
    };
  }

  const since = sinceDateForDays(days);
  try {
    const [events, uniqueIdentities] = await Promise.all([
      prisma.universalSignalEvent.findMany({
        where: { shop, eventAt: { gte: since } },
        orderBy: { eventAt: "desc" },
      }),
      prisma.universalSignalEvent.groupBy({
        by: ["identityKey"],
        where: { shop, eventAt: { gte: since }, identityKey: { not: null } },
      }),
    ]);

    const purchases = events.filter((e) => e.eventType === "purchase");
    const messageOpens = events.filter((e) => e.eventType === "message_open" || e.messageOpenedAt != null);
    const adViews = events.filter((e) => e.eventType === "ad_view" || e.adSeenAt != null);
    const mobileEvents = events.filter((e) => (e.deviceType || "").toLowerCase() === "mobile");
    const iosCount = mobileEvents.filter((e) => (e.osName || "").toLowerCase().includes("ios")).length;
    const androidCount = mobileEvents.filter((e) => (e.osName || "").toLowerCase().includes("android")).length;
    const pct = (value, total) => (total > 0 ? (value / total) * 100 : 0);

    const mapCount = (items, keyGetter) => {
      const m = new Map();
      for (const item of items) {
        const key = keyGetter(item);
        if (!key) continue;
        m.set(key, (m.get(key) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
    };

    return {
      days,
      totalEvents: events.length,
      uniqueIdentities: uniqueIdentities.length,
      purchases: purchases.length,
      messageOpens: messageOpens.length,
      adViews: adViews.length,
      iosPct: pct(iosCount, mobileEvents.length),
      androidPct: pct(androidCount, mobileEvents.length),
      topPaymentMethods: mapCount(events, (e) => e.paymentMethod),
      topCoupons: mapCount(events, (e) => e.couponCode),
    };
  } catch (error) {
    if (!isSchemaMismatchError(error)) throw error;
    return {
      days,
      totalEvents: 0,
      uniqueIdentities: 0,
      purchases: 0,
      messageOpens: 0,
      adViews: 0,
      iosPct: 0,
      androidPct: 0,
      topPaymentMethods: [],
      topCoupons: [],
    };
  }
}

export async function getUniversalInsights(shop, days = 90, sources = null) {
  const defaultPayload = {
    days,
    totals: {
      events: 0,
      purchases: 0,
      uniqueIdentities: 0,
      repeatCustomers: 0,
      avgDiscountPerPurchase: 0,
      iosPct: 0,
      androidPct: 0,
    },
    topPaymentMethods: [],
    topCoupons: [],
    topHandsets: [],
    purchaseByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    adViewsByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    messageOpensByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    purchaseByWeekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => ({ day, count: 0 })),
    lagHours: {
      adToPurchaseAvg: 0,
      messageToPurchaseAvg: 0,
    },
    paymentMix: {
      codPurchases: 0,
      prepaidPurchases: 0,
      codPct: 0,
      prepaidPct: 0,
    },
    couponStats: {
      couponUsagePct: 0,
      avgNetWithCoupon: 0,
      avgNetWithoutCoupon: 0,
      avgDiscountWithCoupon: 0,
    },
    orderValueBands: [
      { band: "<500", count: 0 },
      { band: "500-1499", count: 0 },
      { band: "1500-2999", count: 0 },
      { band: "3000+", count: 0 },
    ],
    rfmSegments: [],
    recencyBuckets: [
      { bucket: "0-7d", count: 0 },
      { bucket: "8-30d", count: 0 },
      { bucket: "31-90d", count: 0 },
      { bucket: "90d+", count: 0 },
    ],
    topPurchaseSources: [],
    engagementConversion: {
      purchasesAfterMessage24h: 0,
      purchasesAfterAd24h: 0,
      purchasesAfterAnySignal24h: 0,
    },
  };

  if (!prisma.universalSignalEvent) return defaultPayload;

  const since = sinceDateForDays(days);
  const sourceFilter = Array.isArray(sources) && sources.length ? { source: { in: sources } } : {};
  try {
    const [events, groupedIdentities] = await Promise.all([
      prisma.universalSignalEvent.findMany({
        where: { shop, eventAt: { gte: since }, ...sourceFilter },
        orderBy: { eventAt: "asc" },
      }),
      prisma.universalSignalEvent.groupBy({
        by: ["identityKey"],
        where: { shop, eventAt: { gte: since }, identityKey: { not: null }, ...sourceFilter },
      }),
    ]);

    const purchases = events.filter((e) => e.eventType === "purchase");
    const adViews = events.filter((e) => e.eventType === "ad_view" || e.adSeenAt != null);
    const messageOpens = events.filter((e) => e.eventType === "message_open" || e.messageOpenedAt != null);

    const byIdentity = new Map();
    for (const row of events) {
      const key = row.identityKey || null;
      if (!key) continue;
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(row);
    }

    const toHour = (dateValue) => {
      const d = new Date(dateValue);
      return Number.isNaN(d.getTime()) ? null : d.getHours();
    };
    const toWeekday = (dateValue) => {
      const d = new Date(dateValue);
      return Number.isNaN(d.getTime()) ? null : d.getDay();
    };
    const hourBucket = () => Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    const weekdayBucket = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => ({ day, count: 0 }));
    const purchaseByHour = hourBucket();
    const adViewsByHour = hourBucket();
    const messageOpensByHour = hourBucket();

    for (const row of purchases) {
      const hour = toHour(row.purchaseAt || row.eventAt);
      const day = toWeekday(row.purchaseAt || row.eventAt);
      if (hour != null) purchaseByHour[hour].count += 1;
      if (day != null) weekdayBucket[day].count += 1;
    }
    for (const row of adViews) {
      const hour = toHour(row.adSeenAt || row.eventAt);
      if (hour != null) adViewsByHour[hour].count += 1;
    }
    for (const row of messageOpens) {
      const hour = toHour(row.messageOpenedAt || row.eventAt);
      if (hour != null) messageOpensByHour[hour].count += 1;
    }

    const mapCount = (items, keyGetter) => {
      const m = new Map();
      for (const item of items) {
        const key = keyGetter(item);
        if (!key) continue;
        m.set(key, (m.get(key) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
    };

    const isCod = (method) => {
      const v = String(method || "").toLowerCase();
      return v.includes("cod") || v.includes("cash on delivery");
    };
    const codPurchases = purchases.filter((e) => isCod(e.paymentMethod)).length;
    const prepaidPurchases = Math.max(0, purchases.length - codPurchases);
    const withCoupon = purchases.filter((e) => !!e.couponCode);
    const withoutCoupon = purchases.filter((e) => !e.couponCode);
    const avg = (rows) => (rows.length ? rows.reduce((s, n) => s + n, 0) / rows.length : 0);
    const avgNetWithCoupon = avg(withCoupon.map((e) => Number(e.netCash || 0)));
    const avgNetWithoutCoupon = avg(withoutCoupon.map((e) => Number(e.netCash || 0)));
    const avgDiscountWithCoupon = avg(withCoupon.map((e) => Number(e.discountAmount || 0)));

    const orderValueBands = [
      { band: "<500", count: 0 },
      { band: "500-1499", count: 0 },
      { band: "1500-2999", count: 0 },
      { band: "3000+", count: 0 },
    ];
    for (const purchase of purchases) {
      const gross = Number(purchase.grossValue || 0);
      if (gross < 500) orderValueBands[0].count += 1;
      else if (gross < 1500) orderValueBands[1].count += 1;
      else if (gross < 3000) orderValueBands[2].count += 1;
      else orderValueBands[3].count += 1;
    }

    const mobilePurchases = purchases.filter((e) => (e.deviceType || "").toLowerCase() === "mobile");
    const iosCount = mobilePurchases.filter((e) => (e.osName || "").toLowerCase().includes("ios")).length;
    const androidCount = mobilePurchases.filter((e) => (e.osName || "").toLowerCase().includes("android")).length;
    const pct = (value, total) => (total > 0 ? (value / total) * 100 : 0);

    const adToPurchaseLags = [];
    const messageToPurchaseLags = [];
    let purchasesAfterMessage24h = 0;
    let purchasesAfterAd24h = 0;
    let purchasesAfterAnySignal24h = 0;
    for (const purchase of purchases) {
      if (!purchase.identityKey) continue;
      const identityEvents = byIdentity.get(purchase.identityKey) || [];
      const purchaseTs = new Date(purchase.purchaseAt || purchase.eventAt).getTime();
      if (!Number.isFinite(purchaseTs)) continue;

      let lastAdTs = null;
      let lastMsgTs = null;
      for (const event of identityEvents) {
        const adTs = event.adSeenAt ? new Date(event.adSeenAt).getTime() : (event.eventType === "ad_view" ? new Date(event.eventAt).getTime() : null);
        const msgTs = event.messageOpenedAt ? new Date(event.messageOpenedAt).getTime() : (event.eventType === "message_open" ? new Date(event.eventAt).getTime() : null);
        if (Number.isFinite(adTs) && adTs <= purchaseTs && (lastAdTs == null || adTs > lastAdTs)) lastAdTs = adTs;
        if (Number.isFinite(msgTs) && msgTs <= purchaseTs && (lastMsgTs == null || msgTs > lastMsgTs)) lastMsgTs = msgTs;
      }
      if (lastAdTs != null) {
        const lag = (purchaseTs - lastAdTs) / (1000 * 60 * 60);
        adToPurchaseLags.push(lag);
        if (lag <= 24) purchasesAfterAd24h += 1;
      }
      if (lastMsgTs != null) {
        const lag = (purchaseTs - lastMsgTs) / (1000 * 60 * 60);
        messageToPurchaseLags.push(lag);
        if (lag <= 24) purchasesAfterMessage24h += 1;
      }
      const nearestSignalTs = [lastAdTs, lastMsgTs].filter((x) => x != null).sort((a, b) => b - a)[0];
      if (nearestSignalTs != null) {
        const lag = (purchaseTs - nearestSignalTs) / (1000 * 60 * 60);
        if (lag <= 24) purchasesAfterAnySignal24h += 1;
      }
    }

    let repeatCustomers = 0;
    let profiles = [];
    if (prisma.universalCustomerProfile) {
      [repeatCustomers, profiles] = await Promise.all([
        prisma.universalCustomerProfile.count({
          where: { shop, totalOrders: { gte: 2 } },
        }),
        prisma.universalCustomerProfile.findMany({
          where: { shop },
          orderBy: { totalNetCash: "desc" },
          take: 10000,
        }),
      ]);
    }

    const recencyBuckets = [
      { bucket: "0-7d", count: 0 },
      { bucket: "8-30d", count: 0 },
      { bucket: "31-90d", count: 0 },
      { bucket: "90d+", count: 0 },
    ];
    const rfmCounter = {
      champions: 0,
      loyal: 0,
      active: 0,
      atRisk: 0,
      hibernating: 0,
    };
    const nowTs = Date.now();
    for (const profile of profiles) {
      const lastTs = new Date(profile.lastSeenAt).getTime();
      const recencyDays = Number.isFinite(lastTs) ? Math.floor((nowTs - lastTs) / (1000 * 60 * 60 * 24)) : 9999;
      if (recencyDays <= 7) recencyBuckets[0].count += 1;
      else if (recencyDays <= 30) recencyBuckets[1].count += 1;
      else if (recencyDays <= 90) recencyBuckets[2].count += 1;
      else recencyBuckets[3].count += 1;

      const orders = Number(profile.totalOrders || 0);
      const net = Number(profile.totalNetCash || 0);
      if (orders >= 6 && recencyDays <= 30 && net >= 30000) rfmCounter.champions += 1;
      else if (orders >= 4 && recencyDays <= 45) rfmCounter.loyal += 1;
      else if (orders >= 2 && recencyDays <= 90) rfmCounter.active += 1;
      else if (orders >= 2 && recencyDays > 90 && recencyDays <= 180) rfmCounter.atRisk += 1;
      else rfmCounter.hibernating += 1;
    }
    const rfmSegments = [
      { segment: "Champions", count: rfmCounter.champions },
      { segment: "Loyal", count: rfmCounter.loyal },
      { segment: "Active", count: rfmCounter.active },
      { segment: "At Risk", count: rfmCounter.atRisk },
      { segment: "Hibernating", count: rfmCounter.hibernating },
    ];

    const avgDiscountPerPurchase = purchases.length
      ? purchases.reduce((sum, row) => sum + Number(row.discountAmount || 0), 0) / purchases.length
      : 0;

    return {
      days,
      totals: {
        events: events.length,
        purchases: purchases.length,
        uniqueIdentities: groupedIdentities.length,
        repeatCustomers,
        avgDiscountPerPurchase,
        iosPct: pct(iosCount, mobilePurchases.length),
        androidPct: pct(androidCount, mobilePurchases.length),
      },
      topPaymentMethods: mapCount(purchases, (e) => e.paymentMethod),
      topCoupons: mapCount(purchases, (e) => e.couponCode),
      topHandsets: mapCount(purchases, (e) => `${e.handsetBrand || ""} ${e.handsetModel || ""}`.trim()),
      topPurchaseSources: mapCount(purchases, (e) => e.source || "unknown"),
      purchaseByHour,
      adViewsByHour,
      messageOpensByHour,
      purchaseByWeekday: weekdayBucket,
      lagHours: {
        adToPurchaseAvg: avg(adToPurchaseLags),
        messageToPurchaseAvg: avg(messageToPurchaseLags),
      },
      paymentMix: {
        codPurchases,
        prepaidPurchases,
        codPct: pct(codPurchases, purchases.length),
        prepaidPct: pct(prepaidPurchases, purchases.length),
      },
      couponStats: {
        couponUsagePct: pct(withCoupon.length, purchases.length),
        avgNetWithCoupon,
        avgNetWithoutCoupon,
        avgDiscountWithCoupon,
      },
      orderValueBands,
      rfmSegments,
      recencyBuckets,
      engagementConversion: {
        purchasesAfterMessage24h,
        purchasesAfterAd24h,
        purchasesAfterAnySignal24h,
      },
    };
  } catch (error) {
    if (!isSchemaMismatchError(error)) throw error;
    return defaultPayload;
  }
}

function startOfDay(dateValue) {
  const date = new Date(dateValue);
  date.setHours(0, 0, 0, 0);
  return date;
}

function sinceDateForDays(days) {
  const since = new Date();
  since.setDate(since.getDate() - Number(days));
  return since;
}

export async function upsertSourceAdSpend(source, adSpend, spendDateInput = new Date()) {
  const normalizedSource = normalizeMarketingSource(source);
  const spendValue = Number(adSpend) || 0;
  const spendDate = startOfDay(spendDateInput);

  if (!prisma.marketingSpendEntry) {
    return prisma.marketingSourceMetrics.upsert({
      where: { source: normalizedSource },
      update: { adSpend: spendValue },
      create: { source: normalizedSource, adSpend: spendValue },
    });
  }

  return prisma.marketingSpendEntry.upsert({
    where: { source_spendDate: { source: normalizedSource, spendDate } },
    update: {
      adSpend: spendValue,
    },
    create: {
      source: normalizedSource,
      spendDate,
      adSpend: spendValue,
    },
  });
}

export async function addSourceAdSpend(source, adSpend, spendDateInput = new Date()) {
  const normalizedSource = normalizeMarketingSource(source);
  const spendValue = Number(adSpend) || 0;
  const spendDate = startOfDay(spendDateInput);

  if (!prisma.marketingSpendEntry) {
    const existing = await prisma.marketingSourceMetrics.findUnique({
      where: { source: normalizedSource },
    });
    if (!existing) {
      return prisma.marketingSourceMetrics.create({
        data: { source: normalizedSource, adSpend: spendValue },
      });
    }
    return prisma.marketingSourceMetrics.update({
      where: { source: normalizedSource },
      data: { adSpend: (existing.adSpend || 0) + spendValue },
    });
  }

  const existing = await prisma.marketingSpendEntry.findUnique({
    where: { source_spendDate: { source: normalizedSource, spendDate } },
  });

  if (!existing) {
    return prisma.marketingSpendEntry.create({
      data: {
        source: normalizedSource,
        spendDate,
        adSpend: spendValue,
      },
    });
  }

  return prisma.marketingSpendEntry.update({
    where: { id: existing.id },
    data: { adSpend: (existing.adSpend || 0) + spendValue },
  });
}

export async function getSourceMetrics(days = 30) {
  if (!prisma.marketingSpendEntry) {
    const rows = await prisma.marketingSourceMetrics.findMany({
      orderBy: { source: "asc" },
    });
    return rows.map((row) => ({
      source: row.source.toLowerCase(),
      adSpend: row.adSpend || 0,
      lastSpendDate: row.updatedAt,
    }));
  }

  const sinceDate = sinceDateForDays(days);

  const entries = await prisma.marketingSpendEntry.findMany({
    where: { spendDate: { gte: sinceDate } },
    orderBy: [{ source: "asc" }, { spendDate: "desc" }],
  });

  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.source.toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        source: key,
        adSpend: 0,
        lastSpendDate: entry.spendDate,
      });
    }
    const row = grouped.get(key);
    row.adSpend += entry.adSpend || 0;
    if (entry.spendDate > row.lastSpendDate) {
      row.lastSpendDate = entry.spendDate;
    }
  }

  return [...grouped.values()].sort((a, b) => a.source.localeCompare(b.source));
}

export async function getAdSpendTotal(days = 30) {
  if (!prisma.marketingSpendEntry) {
    const result = await prisma.marketingSourceMetrics.aggregate({
      _sum: { adSpend: true },
    });
    return result?._sum?.adSpend || 0;
  }

  const sinceDate = sinceDateForDays(days);
  const result = await prisma.marketingSpendEntry.aggregate({
    where: { spendDate: { gte: sinceDate } },
    _sum: { adSpend: true },
  });
  return result?._sum?.adSpend || 0;
}

export async function getSpendEntries(days = 30) {
  if (!prisma.marketingSpendEntry) {
    const rows = await prisma.marketingSourceMetrics.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      spendDate: row.updatedAt,
      adSpend: row.adSpend || 0,
      isFallback: true,
    }));
  }

  const sinceDate = sinceDateForDays(days);
  return prisma.marketingSpendEntry.findMany({
    where: { spendDate: { gte: sinceDate } },
    orderBy: [{ spendDate: "desc" }, { source: "asc" }],
  });
}

export async function updateSpendEntry(entryId, adSpend) {
  const id = Number(entryId);
  const spendValue = Number(adSpend) || 0;

  if (!prisma.marketingSpendEntry) {
    return prisma.marketingSourceMetrics.update({
      where: { id },
      data: { adSpend: spendValue },
    });
  }

  return prisma.marketingSpendEntry.update({
    where: { id },
    data: { adSpend: spendValue },
  });
}

export async function deleteSpendEntry(entryId) {
  const id = Number(entryId);

  if (!prisma.marketingSpendEntry) {
    return prisma.marketingSourceMetrics.delete({
      where: { id },
    });
  }

  return prisma.marketingSpendEntry.delete({
    where: { id },
  });
}

export async function listUniversalSources(shop, days = 90) {
  if (!prisma.universalSignalEvent) return [];
  const since = sinceDateForDays(days);
  try {
    const rows = await prisma.universalSignalEvent.findMany({
      where: { shop, eventAt: { gte: since }, source: { not: null } },
      distinct: ["source"],
      select: { source: true },
    });
    return rows
      .map((row) => String(row?.source || "").toLowerCase())
      .filter(Boolean)
      .sort();
  } catch (error) {
    if (isSchemaMismatchError(error)) return [];
    throw error;
  }
}

const CREATIVE_FATIGUE_DEFAULTS = {
  minImpressions: Number(process.env.CREATIVE_FATIGUE_MIN_IMPRESSIONS || 5000),
  minSpend: Number(process.env.CREATIVE_FATIGUE_MIN_SPEND || 500),
  ctrDropPct: Number(process.env.CREATIVE_FATIGUE_CTR_DROP_PCT || 30),
  minAgeDays: Number(process.env.CREATIVE_FATIGUE_MIN_AGE_DAYS || 7),
  frequency: Number(process.env.CREATIVE_FATIGUE_FREQUENCY || 2.5),
};

function normalizeSourceFilters(source) {
  const raw = Array.isArray(source)
    ? source
    : String(source || "all")
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  const normalized = [...new Set(raw.map((row) => String(row).toLowerCase()))];
  const includeAll = normalized.length === 0 || normalized.includes("all");
  const filterSet = new Set(normalized.filter((row) => row !== "all"));
  return { includeAll, filterSet };
}

export async function upsertCreativeMetricDaily(shop, row = {}) {
  if (!prisma.creativeMetricDaily) return null;
  try {
    const reportDate = startOfDay(row.reportDate || new Date());
    return await prisma.creativeMetricDaily.upsert({
      where: {
        shop_source_adId_reportDate: {
          shop: String(shop),
          source: String(row.source || "unknown").toLowerCase(),
          adId: String(row.adId || ""),
          reportDate,
        },
      },
      update: {
        adName: row.adName || null,
        adSetId: row.adSetId || null,
        adSetName: row.adSetName || null,
        campaignId: row.campaignId || null,
        campaignName: row.campaignName || null,
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        spend: Number(row.spend || 0),
        ctr: Number(row.ctr || 0),
        frequency: row.frequency == null ? null : Number(row.frequency || 0),
        conversions: Number(row.conversions || 0),
      },
      create: {
        shop: String(shop),
        source: String(row.source || "unknown").toLowerCase(),
        adId: String(row.adId || ""),
        adName: row.adName || null,
        adSetId: row.adSetId || null,
        adSetName: row.adSetName || null,
        campaignId: row.campaignId || null,
        campaignName: row.campaignName || null,
        reportDate,
        impressions: Number(row.impressions || 0),
        clicks: Number(row.clicks || 0),
        spend: Number(row.spend || 0),
        ctr: Number(row.ctr || 0),
        frequency: row.frequency == null ? null : Number(row.frequency || 0),
        conversions: Number(row.conversions || 0),
      },
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return null;
    throw error;
  }
}

export async function upsertCreativeMetricBatch(shop, rows = []) {
  if (!prisma.creativeMetricDaily) return 0;
  let written = 0;
  for (const row of rows || []) {
    if (!row?.adId) continue;
    // eslint-disable-next-line no-await-in-loop
    await upsertCreativeMetricDaily(shop, row);
    written += 1;
  }
  return written;
}

function aggregateCreativeWindow(rows, { start, end }) {
  const summary = {
    impressions: 0,
    clicks: 0,
    spend: 0,
    frequencyTotal: 0,
    frequencyCount: 0,
  };
  for (const row of rows) {
    const date = new Date(row.reportDate);
    if (date < start || date > end) continue;
    summary.impressions += Number(row.impressions || 0);
    summary.clicks += Number(row.clicks || 0);
    summary.spend += Number(row.spend || 0);
    if (row.frequency != null) {
      summary.frequencyTotal += Number(row.frequency || 0);
      summary.frequencyCount += 1;
    }
  }
  summary.ctr = summary.impressions > 0 ? summary.clicks / summary.impressions : 0;
  summary.frequencyAvg = summary.frequencyCount > 0 ? summary.frequencyTotal / summary.frequencyCount : null;
  return summary;
}

export async function getCreativeFatigueRisks(shop, days = 30, source = "all") {
  if (!prisma.creativeMetricDaily) return [];
  const lookback = Math.max(14, Number(days) || 30);
  const sinceDate = sinceDateForDays(lookback);
  const { includeAll, filterSet } = normalizeSourceFilters(source);
  try {
    const rows = await prisma.creativeMetricDaily.findMany({
      where: {
        shop: String(shop),
        reportDate: { gte: sinceDate },
        ...(includeAll ? {} : { source: { in: [...filterSet] } }),
      },
      orderBy: [{ source: "asc" }, { adId: "asc" }, { reportDate: "asc" }],
    });

    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.source}|${row.adId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    const recentWindow = dayWindow(7, 0);
    const prevWindow = dayWindow(14, 7);
    const risks = [];
    for (const [key, entries] of grouped.entries()) {
      const [sourceKey, adId] = key.split("|");
      const firstSeen = entries.reduce((min, row) => (row.reportDate < min ? row.reportDate : min), entries[0].reportDate);
      const ageDays = Math.floor((Date.now() - new Date(firstSeen).getTime()) / (1000 * 60 * 60 * 24));
      const recent = aggregateCreativeWindow(entries, recentWindow);
      const previous = aggregateCreativeWindow(entries, prevWindow);
      if (recent.impressions < CREATIVE_FATIGUE_DEFAULTS.minImpressions) continue;
      if (recent.spend < CREATIVE_FATIGUE_DEFAULTS.minSpend) continue;
      if (previous.impressions <= 0 || previous.ctr <= 0) continue;
      const ctrDeltaPct = pctChange(recent.ctr, previous.ctr);
      if (ctrDeltaPct > -CREATIVE_FATIGUE_DEFAULTS.ctrDropPct) continue;
      const freq = recent.frequencyAvg;
      if (ageDays < CREATIVE_FATIGUE_DEFAULTS.minAgeDays && (!freq || freq < CREATIVE_FATIGUE_DEFAULTS.frequency)) continue;

      const isCritical = ctrDeltaPct <= -50 || (freq != null && freq >= 3.5) || ageDays >= 21;
      const representative = entries[entries.length - 1];
      risks.push({
        source: sourceKey,
        adId,
        adName: representative?.adName || null,
        adSetName: representative?.adSetName || null,
        campaignId: representative?.campaignId || null,
        campaignName: representative?.campaignName || null,
        recentCtr: recent.ctr,
        prevCtr: previous.ctr,
        ctrDeltaPct,
        recentSpend: recent.spend,
        recentImpressions: recent.impressions,
        recentClicks: recent.clicks,
        frequencyAvg: freq,
        ageDays,
        severity: isCritical ? "critical" : "warning",
        recommendation: isCritical
          ? "Refresh creative and cap frequency."
          : "Test new hook variations within 48h.",
      });
    }

    return risks
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
        return a.ctrDeltaPct - b.ctrDeltaPct;
      })
      .slice(0, 40);
  } catch (error) {
    if (isSchemaMismatchError(error)) return [];
    throw error;
  }
}

export async function getConnectorCredential(shop, provider) {
  if (!prisma.connectorCredential) return null;
  return prisma.connectorCredential.findUnique({
    where: {
      shop_provider: {
        shop: String(shop),
        provider: String(provider).toLowerCase(),
      },
    },
  });
}

export async function listConnectorCredentials(shop) {
  if (!prisma.connectorCredential) return [];
  return prisma.connectorCredential.findMany({
    where: { shop: String(shop) },
    orderBy: { provider: "asc" },
  });
}

export async function upsertConnectorCredential({
  shop,
  provider,
  accountId = null,
  accountName = null,
  accessToken = null,
  refreshToken = null,
  tokenType = null,
  scope = null,
  expiresAt = null,
  metadata = null,
}) {
  if (!prisma.connectorCredential) {
    throw new Error("ConnectorCredential model not found. Run prisma migrate/generate.");
  }
  const normalizedProvider = String(provider).toLowerCase();
  return prisma.connectorCredential.upsert({
    where: {
      shop_provider: {
        shop: String(shop),
        provider: normalizedProvider,
      },
    },
    update: {
      accountId,
      accountName,
      accessToken,
      refreshToken,
      tokenType,
      scope,
      expiresAt,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
    create: {
      shop: String(shop),
      provider: normalizedProvider,
      accountId,
      accountName,
      accessToken,
      refreshToken,
      tokenType,
      scope,
      expiresAt,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

export async function listAllConnectorCredentials(providers = []) {
  if (!prisma.connectorCredential) return [];
  const normalized = (providers || []).map((p) => String(p).toLowerCase());
  return prisma.connectorCredential.findMany({
    where:
      normalized.length > 0
        ? {
            provider: { in: normalized },
            accessToken: { not: null },
          }
        : undefined,
    orderBy: [{ shop: "asc" }, { provider: "asc" }],
  });
}

export async function getCampaignPerformance(shop, days = 30, source = "all") {
  const sinceDate = sinceDateForDays(days);
  const sourceFilters = Array.isArray(source)
    ? source
    : String(source || "all")
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  const normalizedFilters = [...new Set(sourceFilters.map((row) => String(row).toLowerCase()))];
  const includeAll = normalizedFilters.length === 0 || normalizedFilters.includes("all");
  const filterSet = new Set(normalizedFilters.filter((row) => row !== "all"));
  const orders = await prisma.netCashOrder.findMany({
    where: {
      shop,
      createdAt: { gte: sinceDate },
    },
    include: {
      lineItems: true,
      toolAttributions: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const campaignMap = new Map();
  const sourceCatalog = new Set();
  const addRow = (key, row) => {
    if (!campaignMap.has(key)) {
      campaignMap.set(key, {
        source: row.source || "unknown",
        campaignId: row.campaignId || "",
        campaignName: row.campaignName || "",
        orders: 0,
        grossRevenue: 0,
        netCash: 0,
        itemUnits: 0,
        rtoOrders: 0,
        returnedOrders: 0,
        exchangeOrders: 0,
        exchangeHigherOrders: 0,
        exchangeLowerOrders: 0,
        exchangeNeutralOrders: 0,
        exchangeRefundOrders: 0,
        lastOrderAt: null,
      });
    }
    const current = campaignMap.get(key);
    current.orders += 1;
    current.grossRevenue += row.grossValue || 0;
    current.netCash += row.netCash || 0;
    current.itemUnits += row.itemUnits || 0;
    current.rtoOrders += Number(row.rtoOrders || 0);
    current.returnedOrders += Number(row.returnedOrders || 0);
    current.exchangeOrders += Number(row.exchangeOrders || 0);
    current.exchangeHigherOrders += Number(row.exchangeHigherOrders || 0);
    current.exchangeLowerOrders += Number(row.exchangeLowerOrders || 0);
    current.exchangeNeutralOrders += Number(row.exchangeNeutralOrders || 0);
    current.exchangeRefundOrders += Number(row.exchangeRefundOrders || 0);
    if (!current.lastOrderAt || new Date(row.createdAt) > new Date(current.lastOrderAt)) {
      current.lastOrderAt = row.createdAt;
    }
  };

  for (const order of orders) {
    const itemUnits = (order.lineItems || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
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
      touches.push({
        source: order.marketingSource || "unknown",
        campaignId: "",
        campaignName: "",
      });
    }

    const uniqueTouches = new Map();
    for (const touch of touches) {
      const k = `${touch.source}|${touch.campaignId}|${touch.campaignName}`;
      if (!uniqueTouches.has(k)) uniqueTouches.set(k, touch);
    }

    for (const touch of uniqueTouches.values()) {
      const normalizedSource = String(touch.source || "unknown").toLowerCase();
      sourceCatalog.add(normalizedSource);
      if (!includeAll && !filterSet.has(normalizedSource)) continue;
      const exchangeAdjustment = Number(order.exchangeAdjustment || 0);
      const refundTotal = Number(order.refundTotal || 0);
      const isExchange = exchangeAdjustment !== 0;
      const exchangeHigherOrders = isExchange && exchangeAdjustment > 0 ? 1 : 0;
      const exchangeLowerOrders = isExchange && exchangeAdjustment < 0 ? 1 : 0;
      const exchangeNeutralOrders = isExchange && exchangeAdjustment === 0 ? 1 : 0;
      const exchangeRefundOrders = isExchange && refundTotal > 0 ? 1 : 0;
      const key = `${normalizedSource}|${touch.campaignId || ""}|${touch.campaignName || ""}`;
      addRow(key, {
        source: normalizedSource,
        campaignId: touch.campaignId,
        campaignName: touch.campaignName,
        grossValue: order.grossValue,
        netCash: order.netCash,
        itemUnits,
        rtoOrders: order.isRTO ? 1 : 0,
        returnedOrders: order.isReturned ? 1 : 0,
        exchangeOrders: isExchange ? 1 : 0,
        exchangeHigherOrders,
        exchangeLowerOrders,
        exchangeNeutralOrders,
        exchangeRefundOrders,
        createdAt: order.createdAt,
      });
    }
  }

  const sourceMetrics = await getSourceMetrics(days);
  const spendBySource = new Map(sourceMetrics.map((row) => [String(row.source).toLowerCase(), row.adSpend || 0]));

  const rows = [...campaignMap.values()]
    .map((row) => {
      const adSpend = spendBySource.get(row.source) || 0;
      return {
        ...row,
        adSpend,
        roas: adSpend > 0 ? row.grossRevenue / adSpend : 0,
        realRoas: adSpend > 0 ? row.netCash / adSpend : 0,
      };
    })
    .sort((a, b) => b.netCash - a.netCash);

  const sources = [...sourceCatalog].filter(Boolean).sort();
  return { rows, sources };
}

function campaignCustomerKey(order) {
  const email = String(order?.customerEmail || "").trim().toLowerCase();
  if (email) return { key: `email:${email}`, type: "email", email };
  const phone = String(order?.customerPhone || "").replace(/\D/g, "");
  if (phone) return { key: `phone:${phone}`, type: "phone", phone };
  const name = String(order?.customerName || "").trim().toLowerCase();
  if (name) return { key: `name:${name}`, type: "name", name };
  return null;
}

export async function getCampaignUserInsights(shop, days = 30, source = "all", limit = 200) {
  const sinceDate = sinceDateForDays(days);
  const sourceFilters = Array.isArray(source)
    ? source
    : String(source || "all")
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  const normalizedFilters = [...new Set(sourceFilters.map((row) => String(row).toLowerCase()))];
  const includeAll = normalizedFilters.length === 0 || normalizedFilters.includes("all");
  const filterSet = new Set(normalizedFilters.filter((row) => row !== "all"));

  const orders = await prisma.netCashOrder.findMany({
    where: {
      shop,
      createdAt: { gte: sinceDate },
    },
    include: {
      toolAttributions: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const map = new Map();
  for (const order of orders || []) {
    const customer = campaignCustomerKey(order);
    if (!customer) continue;
    const touches = [];

    if (order.marketingSource || order.campaignId || order.campaignName) {
      touches.push({
        source: String(order.marketingSource || "unknown").toLowerCase(),
        campaignId: order.campaignId || "",
        campaignName: order.campaignName || "",
      });
    }
    for (const attr of order.toolAttributions || []) {
      touches.push({
        source: String(attr.tool || "unknown").toLowerCase(),
        campaignId: attr.campaignId || "",
        campaignName: attr.campaignName || "",
      });
    }
    if (touches.length === 0) {
      touches.push({
        source: String(order.marketingSource || "unknown").toLowerCase(),
        campaignId: "",
        campaignName: "",
      });
    }
    const uniqueTouches = new Map();
    for (const touch of touches) {
      const k = `${touch.source}|${touch.campaignId}|${touch.campaignName}`;
      if (!uniqueTouches.has(k)) uniqueTouches.set(k, touch);
    }

    for (const touch of uniqueTouches.values()) {
      if (!includeAll && !filterSet.has(touch.source)) continue;
      const key = `${touch.source}|${touch.campaignId || ""}|${touch.campaignName || ""}|${customer.key}`;
      if (!map.has(key)) {
        map.set(key, {
          source: touch.source,
          campaignId: touch.campaignId || "",
          campaignName: touch.campaignName || "",
          customerKey: customer.key,
          customerEmail: order.customerEmail || null,
          customerPhone: order.customerPhone || null,
          customerName: order.customerName || null,
          orders: 0,
          grossRevenue: 0,
          netCash: 0,
          rtoOrders: 0,
          returnedOrders: 0,
          exchangeOrders: 0,
          exchangeHigherOrders: 0,
          exchangeLowerOrders: 0,
          exchangeRefundOrders: 0,
          lastOrderAt: null,
        });
      }
      const row = map.get(key);
      row.orders += 1;
      row.grossRevenue += Number(order.grossValue || 0);
      row.netCash += Number(order.netCash || 0);
      row.rtoOrders += order.isRTO ? 1 : 0;
      row.returnedOrders += order.isReturned ? 1 : 0;
      const adjustment = Number(order.exchangeAdjustment || 0);
      const isExchange = adjustment !== 0;
      row.exchangeOrders += isExchange ? 1 : 0;
      row.exchangeHigherOrders += isExchange && adjustment > 0 ? 1 : 0;
      row.exchangeLowerOrders += isExchange && adjustment < 0 ? 1 : 0;
      row.exchangeRefundOrders += isExchange && Number(order.refundTotal || 0) > 0 ? 1 : 0;
      row.lastOrderAt =
        !row.lastOrderAt || new Date(order.createdAt) > new Date(row.lastOrderAt)
          ? order.createdAt
          : row.lastOrderAt;
    }
  }

  return [...map.values()]
    .sort((a, b) => b.netCash - a.netCash || b.orders - a.orders)
    .slice(0, Math.max(1, Number(limit) || 200));
}

export async function createConnectorSyncRun(data) {
  if (!prisma.connectorSyncRun) return null;
  return prisma.connectorSyncRun.create({
    data: {
      shop: String(data.shop),
      provider: String(data.provider).toLowerCase(),
      status: String(data.status || "success"),
      lookbackDays: Number(data.lookbackDays || 7),
      spendRowsFetched: Number(data.spendRowsFetched || 0),
      spendRowsWritten: Number(data.spendRowsWritten || 0),
      attributionRowsFetched: Number(data.attributionRowsFetched || 0),
      attributionRowsWritten: Number(data.attributionRowsWritten || 0),
      errorMessage: data.errorMessage || null,
      durationMs: Number(data.durationMs || 0),
    },
  });
}

export async function getRecentConnectorSyncRuns(shop, limit = 25) {
  if (!prisma.connectorSyncRun) return [];
  return prisma.connectorSyncRun.findMany({
    where: { shop: String(shop) },
    orderBy: { createdAt: "desc" },
    take: Number(limit),
  });
}

export async function getLastSuccessfulConnectorSyncRun(shop, provider = null) {
  if (!prisma.connectorSyncRun) return null;
  const where = {
    shop: String(shop),
    status: "success",
  };
  if (provider) where.provider = String(provider).toLowerCase();
  return prisma.connectorSyncRun.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });
}

function isLikelyValidCampaignId(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (text.length > 120) return false;
  if (/[^a-zA-Z0-9._:-]/.test(text)) return false;
  if (/^(null|undefined|na|n\/a|none)$/i.test(text)) return false;
  return true;
}

function isLikelyValidUtm(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (text.length > 120) return false;
  if (/\s{2,}/.test(text)) return false;
  if (/[^a-zA-Z0-9._:-]/.test(text)) return false;
  return true;
}

export async function getSyncFreshnessByShop(days = 7) {
  const safeDays = Math.max(1, Math.min(90, Number(days) || 7));
  const since = sinceDateForDays(safeDays);

  const [orderRows, connectorRows] = await Promise.all([
    prisma.netCashOrder.groupBy({
      by: ["shop"],
      _max: { updatedAt: true, createdAt: true },
    }),
    prisma.connectorSyncRun
      ? prisma.connectorSyncRun.groupBy({
          by: ["shop"],
          _max: { createdAt: true },
          where: { createdAt: { gte: since } },
        })
      : [],
  ]);

  const byShop = new Map();
  for (const row of orderRows || []) {
    const latestOrderAt = row?._max?.updatedAt || row?._max?.createdAt || null;
    byShop.set(row.shop, {
      shop: row.shop,
      latestOrderAt,
      latestConnectorSyncAt: null,
    });
  }
  for (const row of connectorRows || []) {
    const existing = byShop.get(row.shop) || {
      shop: row.shop,
      latestOrderAt: null,
      latestConnectorSyncAt: null,
    };
    existing.latestConnectorSyncAt = row?._max?.createdAt || null;
    byShop.set(row.shop, existing);
  }

  return [...byShop.values()].map((row) => {
    const orderLagMinutes = row.latestOrderAt
      ? Math.max(0, Math.round((Date.now() - new Date(row.latestOrderAt).getTime()) / 60000))
      : null;
    const connectorLagMinutes = row.latestConnectorSyncAt
      ? Math.max(0, Math.round((Date.now() - new Date(row.latestConnectorSyncAt).getTime()) / 60000))
      : null;
    return {
      ...row,
      orderLagMinutes,
      connectorLagMinutes,
    };
  });
}

export async function getDataQualitySummary(shop, days = 30) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const orders = await getOrders(shop, safeDays);
  const spendEntries = await getSpendEntries(safeDays);
  const since = sinceDateForDays(safeDays);

  const totalOrders = Number(orders.length || 0);
  const mappedOrders = orders.filter((o) => {
    const hasSource = String(o.marketingSource || "").trim();
    const hasCampaign = String(o.campaignId || o.campaignName || "").trim();
    return Boolean(hasSource || hasCampaign);
  }).length;
  const mappedOrdersPct = totalOrders > 0 ? (mappedOrders / totalOrders) * 100 : 0;

  const invalidRows = orders.filter((o) => {
    return (
      !isLikelyValidCampaignId(o.campaignId) ||
      !isLikelyValidUtm(o.utmSource) ||
      !isLikelyValidUtm(o.utmMedium) ||
      !isLikelyValidUtm(o.utmCampaign)
    );
  });

  const sourceDateNeed = new Set();
  for (const order of orders) {
    const source = String(order.marketingSource || "").trim().toLowerCase();
    if (!source || source === "direct" || source === "unknown") continue;
    const date = new Date(order.createdAt).toISOString().slice(0, 10);
    sourceDateNeed.add(`${source}|${date}`);
  }

  const sourceDateHave = new Set(
    (spendEntries || []).map((row) => {
      const source = String(row.source || "").trim().toLowerCase();
      const date = new Date(row.spendDate).toISOString().slice(0, 10);
      return `${source}|${date}`;
    }),
  );

  const missingSpendRows = [...sourceDateNeed]
    .filter((key) => !sourceDateHave.has(key))
    .map((key) => {
      const [source, date] = key.split("|");
      return { source, date };
    })
    .slice(0, 200);

  const recentSyncRun = prisma.connectorSyncRun
    ? await prisma.connectorSyncRun.findFirst({
        where: { shop: String(shop) },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const syncLagMinutes = recentSyncRun
    ? Math.max(0, Math.round((Date.now() - new Date(recentSyncRun.createdAt).getTime()) / 60000))
    : null;

  return {
    shop: String(shop),
    days: safeDays,
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    totals: {
      totalOrders,
      mappedOrders,
      mappedOrdersPct,
      invalidRows: invalidRows.length,
      missingSpendRows: missingSpendRows.length,
      syncLagMinutes,
    },
    invalidRows: invalidRows.slice(0, 100).map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      campaignId: row.campaignId || null,
      utmSource: row.utmSource || null,
      utmMedium: row.utmMedium || null,
      utmCampaign: row.utmCampaign || null,
      createdAt: row.createdAt,
    })),
    missingSpendRows,
  };
}

const ALERT_RULES = {
  net_cash_drop: "Net Cash Drop",
  roas_drop: "ROAS Drop",
  spend_spike: "Spend Spike",
  order_drop: "Order Volume Drop",
  attribution_overlap: "Attribution Overlap Risk",
  landing_mismatch: "Landing Page Mismatch",
  creative_fatigue: "Creative Fatigue Risk",
  guardrail_margin: "Guardrail: Margin Breach",
  guardrail_rto: "Guardrail: RTO Breach",
  guardrail_discount: "Guardrail: Discount Breach",
  guardrail_refund: "Guardrail: Refund Breach",
  guardrail_cac: "Guardrail: CAC Breach",
};

export function listAlertRules() {
  return Object.entries(ALERT_RULES).map(([key, label]) => ({ key, label }));
}

export async function listAlertRuleSettings(shop) {
  if (!prisma.alertRuleSetting) return [];
  return prisma.alertRuleSetting.findMany({
    where: { shop: String(shop) },
    orderBy: { ruleKey: "asc" },
  });
}

export async function upsertAlertRuleSetting(shop, ruleKey, patch = {}) {
  if (!prisma.alertRuleSetting) return null;
  return prisma.alertRuleSetting.upsert({
    where: { shop_ruleKey: { shop: String(shop), ruleKey: String(ruleKey) } },
    update: {
      enabled: patch.enabled ?? true,
      mutedUntil: patch.mutedUntil ?? null,
    },
    create: {
      shop: String(shop),
      ruleKey: String(ruleKey),
      enabled: patch.enabled ?? true,
      mutedUntil: patch.mutedUntil ?? null,
    },
  });
}

export async function markAlertRead(shop, alertId, isRead = true) {
  if (!prisma.alertEvent) return null;
  return prisma.alertEvent.update({
    where: { id: Number(alertId) },
    data: { isRead: !!isRead },
  });
}

export async function listAlertEvents(shop, { severity = "all", limit = 100 } = {}) {
  if (!prisma.alertEvent) return [];
  const where = {
    shop: String(shop),
  };
  if (severity !== "all") {
    where.severity = String(severity);
  }
  return prisma.alertEvent.findMany({
    where,
    orderBy: [{ isRead: "asc" }, { lastSeenAt: "desc" }],
    take: Number(limit),
  });
}

function pctChange(current, previous) {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function dayWindow(daysBackStart, daysBackEnd = 0) {
  const start = new Date();
  start.setDate(start.getDate() - daysBackStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() - daysBackEnd);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function safeTouchpoints(value) {
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
  for (const touch of safeTouchpoints(order?.touchpointsJson)) {
    const source = String(touch?.source || touch?.tool || "").toLowerCase();
    if (source) sources.add(source);
  }
  return sources;
}

async function upsertAlertEvent(shop, candidate) {
  if (!prisma.alertEvent) return null;
  const fingerprint = `${candidate.ruleKey}:${candidate.fingerprintKey}`;
  const existing = await prisma.alertEvent.findUnique({
    where: {
      shop_fingerprint: {
        shop: String(shop),
        fingerprint,
      },
    },
  });
  if (!existing) {
    return prisma.alertEvent.create({
      data: {
        shop: String(shop),
        ruleKey: candidate.ruleKey,
        severity: candidate.severity,
        title: candidate.title,
        message: candidate.message,
        fingerprint,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        hitCount: 1,
        isRead: false,
      },
    });
  }
  return prisma.alertEvent.update({
    where: { id: existing.id },
    data: {
      severity: candidate.severity,
      title: candidate.title,
      message: candidate.message,
      lastSeenAt: new Date(),
      hitCount: (existing.hitCount || 0) + 1,
      isRead: false,
    },
  });
}

function activeSetting(settingsMap, ruleKey) {
  const setting = settingsMap.get(ruleKey);
  if (!setting) return { enabled: true, muted: false };
  const muted = !!setting.mutedUntil && new Date(setting.mutedUntil) > new Date();
  return { enabled: setting.enabled !== false, muted };
}

export async function evaluateAndStoreAlerts(shop) {
  if (!prisma.alertEvent || !prisma.alertRuleSetting) return { created: 0 };
  const settings = await listAlertRuleSettings(shop);
  const settingsMap = new Map(settings.map((s) => [s.ruleKey, s]));
  const guardrailConfig = await resolveShopConfig(shop, {
    growth_guardrail_max_cac: "0",
    growth_guardrail_min_margin_pct: "12",
    growth_guardrail_max_rto_pct: "15",
    growth_guardrail_max_discount_pct: "25",
    growth_guardrail_max_refund_pct: "8",
  });
  const guardrails = {
    maxCac: parseNumber(guardrailConfig.growth_guardrail_max_cac, 0),
    minMarginPct: parseNumber(guardrailConfig.growth_guardrail_min_margin_pct, 12),
    maxRtoPct: parseNumber(guardrailConfig.growth_guardrail_max_rto_pct, 15),
    maxDiscountPct: parseNumber(guardrailConfig.growth_guardrail_max_discount_pct, 25),
    maxRefundPct: parseNumber(guardrailConfig.growth_guardrail_max_refund_pct, 8),
  };

  const rCurrent = dayWindow(3, 0);
  const rPrev = dayWindow(6, 3);

  const [currentOrders, prevOrders, currentSpendRows, prevSpendRows] = await Promise.all([
    prisma.netCashOrder.findMany({
      where: { shop: String(shop), createdAt: { gte: rCurrent.start, lte: rCurrent.end } },
    }),
    prisma.netCashOrder.findMany({
      where: { shop: String(shop), createdAt: { gte: rPrev.start, lte: rPrev.end } },
    }),
    prisma.marketingSpendEntry
      ? prisma.marketingSpendEntry.findMany({
          where: { spendDate: { gte: rCurrent.start, lte: rCurrent.end } },
        })
      : [],
    prisma.marketingSpendEntry
      ? prisma.marketingSpendEntry.findMany({
          where: { spendDate: { gte: rPrev.start, lte: rPrev.end } },
        })
      : [],
  ]);

  const currentNet = currentOrders.reduce((s, o) => s + (o.netCash || 0), 0);
  const prevNet = prevOrders.reduce((s, o) => s + (o.netCash || 0), 0);
  const currentGross = currentOrders.reduce((s, o) => s + (o.grossValue || 0), 0);
  const prevGross = prevOrders.reduce((s, o) => s + (o.grossValue || 0), 0);
  const currentDiscount = currentOrders.reduce((s, o) => s + (o.discountTotal || 0), 0);
  const currentRefund = currentOrders.reduce((s, o) => s + (o.refundTotal || 0), 0);
  const currentRtoCount = currentOrders.filter((o) => o.isRTO).length;
  const currentSpend = currentSpendRows.reduce((s, r) => s + (r.adSpend || 0), 0);
  const prevSpend = prevSpendRows.reduce((s, r) => s + (r.adSpend || 0), 0);
  const currentRoas = currentSpend > 0 ? currentNet / currentSpend : 0;
  const prevRoas = prevSpend > 0 ? prevNet / prevSpend : 0;
  const currentOrdersCount = currentOrders.length;
  const currentMarginPct = currentGross > 0 ? (currentNet / currentGross) * 100 : 0;
  const currentDiscountPct = currentGross > 0 ? (currentDiscount / currentGross) * 100 : 0;
  const currentRefundPct = currentGross > 0 ? (currentRefund / currentGross) * 100 : 0;
  const currentRtoPct = currentOrdersCount > 0 ? (currentRtoCount / currentOrdersCount) * 100 : 0;
  const currentCac = currentOrdersCount > 0 ? currentSpend / currentOrdersCount : 0;

  const candidates = [];
  const netDelta = pctChange(currentNet, prevNet);
  if (netDelta <= -30) {
    candidates.push({
      ruleKey: "net_cash_drop",
      severity: netDelta <= -50 ? "critical" : "warning",
      title: "Net cash dropped sharply",
      message: `Net cash changed ${netDelta.toFixed(1)}% in last 3 days vs prior 3 days.`,
      fingerprintKey: `net_cash_drop:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (prevRoas > 0 && currentRoas < prevRoas * 0.7) {
    const dropPct = pctChange(currentRoas, prevRoas);
    candidates.push({
      ruleKey: "roas_drop",
      severity: dropPct <= -50 ? "critical" : "warning",
      title: "Real ROAS dropped",
      message: `Real ROAS changed ${dropPct.toFixed(1)}% (current ${currentRoas.toFixed(2)}x, previous ${prevRoas.toFixed(2)}x).`,
      fingerprintKey: `roas_drop:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (prevSpend > 0 && currentSpend >= prevSpend * 1.6) {
    const spikePct = pctChange(currentSpend, prevSpend);
    candidates.push({
      ruleKey: "spend_spike",
      severity: spikePct >= 100 ? "critical" : "warning",
      title: "Ad spend spiked",
      message: `Ad spend changed +${spikePct.toFixed(1)}% in last 3 days vs prior 3 days.`,
      fingerprintKey: `spend_spike:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const orderDelta = pctChange(currentOrders.length, prevOrders.length);
  if (orderDelta <= -35 && prevOrders.length > 0) {
    candidates.push({
      ruleKey: "order_drop",
      severity: orderDelta <= -60 ? "critical" : "warning",
      title: "Order volume dropped",
      message: `Order count changed ${orderDelta.toFixed(1)}% in last 3 days vs prior 3 days.`,
      fingerprintKey: `order_drop:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (guardrails.minMarginPct > 0 && currentMarginPct < guardrails.minMarginPct) {
    candidates.push({
      ruleKey: "guardrail_margin",
      severity: currentMarginPct < guardrails.minMarginPct * 0.7 ? "critical" : "warning",
      title: "Margin guardrail breached",
      message: `Net cash margin ${currentMarginPct.toFixed(1)}% is below guardrail ${guardrails.minMarginPct}% (last 3 days).`,
      fingerprintKey: `guardrail_margin:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (guardrails.maxRtoPct > 0 && currentRtoPct > guardrails.maxRtoPct) {
    candidates.push({
      ruleKey: "guardrail_rto",
      severity: currentRtoPct > guardrails.maxRtoPct * 1.3 ? "critical" : "warning",
      title: "RTO guardrail breached",
      message: `RTO rate ${currentRtoPct.toFixed(1)}% exceeds guardrail ${guardrails.maxRtoPct}% (last 3 days).`,
      fingerprintKey: `guardrail_rto:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (guardrails.maxDiscountPct > 0 && currentDiscountPct > guardrails.maxDiscountPct) {
    candidates.push({
      ruleKey: "guardrail_discount",
      severity: currentDiscountPct > guardrails.maxDiscountPct * 1.3 ? "critical" : "warning",
      title: "Discount guardrail breached",
      message: `Discount rate ${currentDiscountPct.toFixed(1)}% exceeds guardrail ${guardrails.maxDiscountPct}% (last 3 days).`,
      fingerprintKey: `guardrail_discount:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (guardrails.maxRefundPct > 0 && currentRefundPct > guardrails.maxRefundPct) {
    candidates.push({
      ruleKey: "guardrail_refund",
      severity: currentRefundPct > guardrails.maxRefundPct * 1.3 ? "critical" : "warning",
      title: "Refund guardrail breached",
      message: `Refund rate ${currentRefundPct.toFixed(1)}% exceeds guardrail ${guardrails.maxRefundPct}% (last 3 days).`,
      fingerprintKey: `guardrail_refund:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  if (guardrails.maxCac > 0 && currentCac > guardrails.maxCac) {
    candidates.push({
      ruleKey: "guardrail_cac",
      severity: currentCac > guardrails.maxCac * 1.3 ? "critical" : "warning",
      title: "CAC guardrail breached",
      message: `CAC INR ${currentCac.toFixed(0)} exceeds guardrail INR ${guardrails.maxCac.toFixed(0)} (last 3 days).`,
      fingerprintKey: `guardrail_cac:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const paidOrdersWithLanding = currentOrders.filter((row) => {
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
  if (paidOrdersWithLanding.length >= 20 && landingMismatchPct >= 30) {
    candidates.push({
      ruleKey: "landing_mismatch",
      severity: landingMismatchPct >= 50 ? "critical" : "warning",
      title: "Landing page mismatch risk",
      message: `${landingMismatchPct.toFixed(1)}% of paid orders landed on home or generic pages (${landingMismatchCount}/${paidOrdersWithLanding.length}).`,
      fingerprintKey: `landing_mismatch:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const multiSourceTouchpointCount = currentOrders.filter((row) => touchpointSources(row).size > 1).length;
  const multiSourceTouchpointPct = currentOrders.length
    ? (multiSourceTouchpointCount / currentOrders.length) * 100
    : 0;
  if (currentOrders.length >= 30 && multiSourceTouchpointPct >= 20) {
    candidates.push({
      ruleKey: "attribution_overlap",
      severity: multiSourceTouchpointPct >= 35 ? "critical" : "warning",
      title: "Attribution overlap risk",
      message: `${multiSourceTouchpointPct.toFixed(1)}% of recent orders show multi-source touchpoints (${multiSourceTouchpointCount}/${currentOrders.length}).`,
      fingerprintKey: `attribution_overlap:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  const fatigueRisks = await getCreativeFatigueRisks(shop, 14, "all");
  if (fatigueRisks.length > 0) {
    const criticalCount = fatigueRisks.filter((row) => row.severity === "critical").length;
    const top = fatigueRisks[0];
    const creativeLabel = top?.adName || top?.adId || "Top creative";
    candidates.push({
      ruleKey: "creative_fatigue",
      severity: criticalCount > 0 || fatigueRisks.length >= 4 ? "critical" : "warning",
      title: "Creative fatigue detected",
      message: `${fatigueRisks.length} creatives show CTR decay. ${creativeLabel} is down ${Math.abs(top.ctrDeltaPct).toFixed(1)}% vs prior week.`,
      fingerprintKey: `creative_fatigue:${new Date().toISOString().slice(0, 10)}`,
    });

    const actionsEnabled = String(process.env.CREATIVE_FATIGUE_ACTIONS_ENABLED || "true").toLowerCase() !== "false";
    if (actionsEnabled) {
      const actionTargets = fatigueRisks.slice(0, 6);
      for (const risk of actionTargets) {
        const label = risk.adName || risk.adId || "Creative";
        // eslint-disable-next-line no-await-in-loop
        await createCampaignActionItem(shop, {
          source: risk.source,
          campaignId: risk.campaignId,
          campaignName: risk.campaignName,
          reason: `Creative fatigue: ${label}`,
          recommendedAction: risk.severity === "critical"
            ? "Refresh creative, cap frequency, and recheck in 72h."
            : "Test new hooks and cut spend by 10-20% if CTR keeps sliding.",
          priority: risk.severity === "critical" ? "high" : "medium",
        });
      }
    }
  }

  let created = 0;
  for (const candidate of candidates) {
    const ruleState = activeSetting(settingsMap, candidate.ruleKey);
    if (!ruleState.enabled || ruleState.muted) continue;
    await upsertAlertEvent(shop, candidate);
    created += 1;
  }

  return {
    created,
    summary: {
      currentNet,
      prevNet,
      currentGross,
      prevGross,
      currentSpend,
      prevSpend,
      currentRoas,
      prevRoas,
      currentOrders: currentOrders.length,
      prevOrders: prevOrders.length,
    },
  };
}

export async function getDashboardPreference(shop) {
  if (!prisma.dashboardPreference) return null;
  return prisma.dashboardPreference.findUnique({
    where: { shop: String(shop) },
  });
}

export async function upsertDashboardPreference(shop, layout) {
  if (!prisma.dashboardPreference) return null;
  return prisma.dashboardPreference.upsert({
    where: { shop: String(shop) },
    update: {
      layout: layout ? JSON.stringify(layout) : null,
    },
    create: {
      shop: String(shop),
      layout: layout ? JSON.stringify(layout) : null,
    },
  });
}

const DEFAULT_AI_PROMPT_TEMPLATES = [
  { title: "30D Summary", query: "summary for last 30 days", category: "revenue", isPinned: true },
  { title: "Top Campaign", query: "top campaign in last 30 days", category: "campaigns", isPinned: true },
  { title: "Meta Orders", query: "show meta orders", category: "campaigns", isPinned: false },
  { title: "Google Orders", query: "show google orders", category: "campaigns", isPinned: false },
  { title: "Profit Snapshot", query: "profit summary", category: "operations", isPinned: false },
];

export async function listAiPromptTemplates(shop) {
  if (!prisma.aiPromptTemplate) return [];
  const normalizedShop = String(shop);
  const count = await prisma.aiPromptTemplate.count({
    where: { shop: normalizedShop },
  });

  if (count === 0) {
    await prisma.aiPromptTemplate.createMany({
      data: DEFAULT_AI_PROMPT_TEMPLATES.map((row) => ({
        shop: normalizedShop,
        title: row.title,
        query: row.query,
        category: row.category,
        isPinned: row.isPinned,
      })),
    });
  }

  return prisma.aiPromptTemplate.findMany({
    where: { shop: normalizedShop },
    orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
    take: 50,
  });
}

export async function createAiPromptTemplate(shop, { title, query, category = "custom", isPinned = false }) {
  if (!prisma.aiPromptTemplate) return null;
  return prisma.aiPromptTemplate.create({
    data: {
      shop: String(shop),
      title: String(title || "").trim(),
      query: String(query || "").trim(),
      category: String(category || "custom").trim().toLowerCase(),
      isPinned: !!isPinned,
    },
  });
}

export async function deleteAiPromptTemplate(shop, id) {
  if (!prisma.aiPromptTemplate) return null;
  return prisma.aiPromptTemplate.deleteMany({
    where: {
      id: Number(id),
      shop: String(shop),
    },
  });
}

export async function setAiPromptTemplatePinned(shop, id, isPinned) {
  if (!prisma.aiPromptTemplate) return null;
  return prisma.aiPromptTemplate.updateMany({
    where: {
      id: Number(id),
      shop: String(shop),
    },
    data: { isPinned: !!isPinned },
  });
}

export async function createAiPromptRun(shop, payload) {
  if (!prisma.aiPromptRun) return null;
  return prisma.aiPromptRun.create({
    data: {
      shop: String(shop),
      templateId: payload?.templateId ? Number(payload.templateId) : null,
      promptQuery: String(payload?.promptQuery || "").trim(),
      intent: payload?.intent ? String(payload.intent) : null,
      answer: payload?.answer ? String(payload.answer) : null,
      summaryJson: payload?.summaryJson ? JSON.stringify(payload.summaryJson) : null,
    },
  });
}

export async function listAiPromptRuns(shop, limit = 20) {
  if (!prisma.aiPromptRun) return [];
  return prisma.aiPromptRun.findMany({
    where: { shop: String(shop) },
    orderBy: { createdAt: "desc" },
    take: Number(limit),
  });
}

const DEFAULT_BENCHMARKS = [
  { benchmarkKey: "ecommerce_d2c", metric: "real_roas", p50: 1.8, p75: 2.4, p90: 3.2, source: "netcash_seed" },
  { benchmarkKey: "ecommerce_d2c", metric: "profit_margin_pct", p50: 18, p75: 26, p90: 34, source: "netcash_seed" },
  { benchmarkKey: "ecommerce_d2c", metric: "net_cash_per_order", p50: 180, p75: 260, p90: 360, source: "netcash_seed" },
];

export async function listMarketBenchmarks(benchmarkKey = "ecommerce_d2c") {
  if (!prisma.marketBenchmark) return [];
  const key = String(benchmarkKey || "ecommerce_d2c");
  const count = await prisma.marketBenchmark.count({ where: { benchmarkKey: key } });
  if (count === 0) {
    for (const row of DEFAULT_BENCHMARKS.filter((item) => item.benchmarkKey === key)) {
      try {
        await prisma.marketBenchmark.create({ data: row });
      } catch (error) {
        // Ignore duplicate key collisions during parallel/dev reload seeding.
        if (!String(error?.message || "").toLowerCase().includes("unique")) {
          throw error;
        }
      }
    }
  }
  return prisma.marketBenchmark.findMany({
    where: { benchmarkKey: key },
    orderBy: { metric: "asc" },
  });
}

export async function listCampaignActionItems(shop, status = "open") {
  if (!prisma.campaignActionItem) return [];
  const where = { shop: String(shop) };
  if (status !== "all") where.status = String(status);
  return prisma.campaignActionItem.findMany({
    where,
    orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
    take: 150,
  });
}

export async function createCampaignActionItem(shop, payload) {
  if (!prisma.campaignActionItem) return null;
  const safeShop = String(shop);
  const source = String(payload?.source || "unknown").toLowerCase();
  const campaignId = payload?.campaignId ? String(payload.campaignId) : null;
  const campaignName = payload?.campaignName ? String(payload.campaignName) : null;
  const reason = String(payload?.reason || "Low campaign quality").trim();
  const recommendedAction = String(payload?.recommendedAction || "Reduce spend by 20% and monitor for 48h").trim();
  const priority = String(payload?.priority || "medium").toLowerCase();

  const existing = await prisma.campaignActionItem.findFirst({
    where: {
      shop: safeShop,
      source,
      campaignId,
      campaignName,
      status: "open",
      reason,
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.campaignActionItem.create({
    data: {
      shop: safeShop,
      source,
      campaignId,
      campaignName,
      priority,
      reason,
      recommendedAction,
      status: "open",
    },
  });
}

export async function updateCampaignActionStatus(shop, id, status) {
  if (!prisma.campaignActionItem) return null;
  return prisma.campaignActionItem.updateMany({
    where: { id: Number(id), shop: String(shop) },
    data: { status: String(status || "open").toLowerCase() },
  });
}

export async function listActivationDestinations(shop) {
  if (!prisma.activationDestination) return [];
  return prisma.activationDestination.findMany({
    where: { shop: String(shop) },
    orderBy: { createdAt: "desc" },
  });
}

export async function createActivationDestination(shop, payload) {
  if (!prisma.activationDestination) return null;
  return prisma.activationDestination.create({
    data: {
      shop: String(shop),
      name: String(payload?.name || "").trim(),
      endpointUrl: String(payload?.endpointUrl || "").trim(),
      authHeaderName: payload?.authHeaderName ? String(payload.authHeaderName).trim() : null,
      authHeaderValue: payload?.authHeaderValue ? String(payload.authHeaderValue).trim() : null,
      isActive: payload?.isActive !== false,
    },
  });
}

export async function updateActivationDestination(shop, id, payload) {
  if (!prisma.activationDestination) return null;
  return prisma.activationDestination.updateMany({
    where: { id: Number(id), shop: String(shop) },
    data: {
      name: String(payload?.name || "").trim(),
      endpointUrl: String(payload?.endpointUrl || "").trim(),
      authHeaderName: payload?.authHeaderName ? String(payload.authHeaderName).trim() : null,
      authHeaderValue: payload?.authHeaderValue ? String(payload.authHeaderValue).trim() : null,
      isActive: payload?.isActive !== false,
      updatedAt: new Date(),
    },
  });
}

export async function deleteActivationDestination(shop, id) {
  if (!prisma.activationDestination) return null;
  return prisma.activationDestination.deleteMany({
    where: { id: Number(id), shop: String(shop) },
  });
}

function parseActivationAdapter(endpointUrl) {
  const value = String(endpointUrl || "").trim();
  if (!value) return { type: "webhook" };
  if (value.startsWith("meta://")) {
    // Format: meta://<adAccountId>/<audienceId>
    const clean = value.replace(/^meta:\/\//, "");
    const [accountId, audienceId] = clean.split("/");
    return {
      type: "meta_ads",
      accountId: accountId ? accountId.replace(/^act_/, "") : null,
      audienceId: audienceId || null,
    };
  }
  if (value.startsWith("google://")) {
    // Format: google://<customerId>/<userListId>
    const clean = value.replace(/^google:\/\//, "");
    const [customerId, userListId] = clean.split("/");
    return {
      type: "google_ads",
      customerId: customerId || null,
      userListId: userListId || null,
    };
  }
  return { type: "webhook" };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "").trim().toLowerCase()).digest("hex");
}

async function pushMetaAudience({
  shop,
  destination,
  payload,
  adapter,
}) {
  const credential = await getConnectorCredential(shop, "meta_ads");
  const accessToken = credential?.accessToken || process.env.META_ACCESS_TOKEN;
  const accountId = adapter.accountId || credential?.accountId || process.env.META_AD_ACCOUNT_ID;
  if (!accessToken) {
    return { ok: false, status: 400, body: "Meta adapter missing access token" };
  }
  if (!accountId) {
    return { ok: false, status: 400, body: "Meta adapter missing ad account id" };
  }

  let audienceId = adapter.audienceId || null;
  if (!audienceId) {
    const createParams = new URLSearchParams({
      access_token: accessToken,
      name: payload?.audienceName || destination.name || "Netcash Audience",
      subtype: "CUSTOM",
      customer_file_source: "USER_PROVIDED_ONLY",
      description: `Created by Netcash audience rule at ${new Date().toISOString()}`,
    });
    const createRes = await fetch(`https://graph.facebook.com/v20.0/act_${accountId}/customaudiences`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createParams,
    });
    const createBody = await createRes.json();
    if (!createRes.ok || !createBody?.id) {
      return {
        ok: false,
        status: createRes.status,
        body: `Meta audience create failed: ${JSON.stringify(createBody).slice(0, 900)}`,
      };
    }
    audienceId = String(createBody.id);
  }

  const keys = Array.isArray(payload?.orderKeys) ? payload.orderKeys : [];
  if (keys.length === 0) {
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({
        mode: "meta_ads",
        audienceId,
        message: "Audience available, no members to push for this run.",
      }),
    };
  }

  const data = keys
    .slice(0, 10000)
    .map((key) => [sha256Hex(key)]);
  const userPayload = {
    schema: ["EXTERN_ID"],
    data,
  };
  const userParams = new URLSearchParams({
    access_token: accessToken,
    payload: JSON.stringify(userPayload),
  });
  const userRes = await fetch(`https://graph.facebook.com/v20.0/${audienceId}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: userParams,
  });
  const userBody = await userRes.json();
  if (!userRes.ok) {
    return {
      ok: false,
      status: userRes.status,
      body: `Meta audience user push failed: ${JSON.stringify(userBody).slice(0, 900)}`,
    };
  }
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      mode: "meta_ads",
      audienceId,
      membersPushed: data.length,
      response: userBody,
    }).slice(0, 1000),
  };
}

async function pushGoogleAudience({
  shop,
  destination,
  payload,
  adapter,
}) {
  const credential = await getConnectorCredential(shop, "google_ads");
  const accessToken = credential?.accessToken || process.env.GOOGLE_ADS_ACCESS_TOKEN;
  const customerId = adapter.customerId || credential?.accountId || process.env.GOOGLE_ADS_CUSTOMER_ID;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "";

  if (!accessToken) {
    return { ok: false, status: 400, body: "Google adapter missing access token" };
  }
  if (!customerId) {
    return { ok: false, status: 400, body: "Google adapter missing customer id" };
  }
  if (!developerToken) {
    return { ok: false, status: 400, body: "Google adapter missing developer token" };
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  let userListResourceName = adapter.userListId
    ? `customers/${customerId}/userLists/${adapter.userListId}`
    : null;

  if (!userListResourceName) {
    const mutateRes = await fetch(`https://googleads.googleapis.com/v17/customers/${customerId}/userLists:mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        customerId: String(customerId),
        operations: [
          {
            create: {
              name: payload?.audienceName || destination.name || `netcash_audience_${Date.now()}`,
              description: `Created by Netcash audience rule at ${new Date().toISOString()}`,
              membershipLifeSpan: 30,
              crmBasedUserList: {
                uploadKeyType: "CONTACT_INFO",
              },
            },
          },
        ],
      }),
    });
    const mutateBody = await mutateRes.json();
    if (!mutateRes.ok) {
      return {
        ok: false,
        status: mutateRes.status,
        body: `Google user list create failed: ${JSON.stringify(mutateBody).slice(0, 900)}`,
      };
    }
    userListResourceName = mutateBody?.results?.[0]?.resourceName || null;
  }

  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      mode: "google_ads",
      userList: userListResourceName,
      note: "Audience list created/selected. Contact identifiers are required for member uploads.",
      matchedCount: Number(payload?.matchedCount || 0),
    }).slice(0, 1000),
  };
}

export async function triggerActivationDestination(shop, destinationId, payload) {
  if (!prisma.activationDestination) {
    return { ok: false, status: 501, body: "ActivationDestination model not available" };
  }
  const destination = await prisma.activationDestination.findFirst({
    where: { id: Number(destinationId), shop: String(shop), isActive: true },
  });
  if (!destination) {
    return { ok: false, status: 404, body: "Destination not found or inactive" };
  }

  let result = { ok: false, status: 500, body: "Unknown error" };
  try {
    const adapter = parseActivationAdapter(destination.endpointUrl);
    if (adapter.type === "meta_ads") {
      result = await pushMetaAudience({
        shop: String(shop),
        destination,
        payload,
        adapter,
      });
    } else if (adapter.type === "google_ads") {
      result = await pushGoogleAudience({
        shop: String(shop),
        destination,
        payload,
        adapter,
      });
    } else {
      const headers = { "Content-Type": "application/json" };
      if (destination.authHeaderName && destination.authHeaderValue) {
        headers[destination.authHeaderName] = destination.authHeaderValue;
      }
      const response = await fetch(destination.endpointUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload || {}),
      });
      const text = await response.text();
      result = { ok: response.ok, status: response.status, body: text.slice(0, 1000) };
    }
  } catch (error) {
    result = { ok: false, status: 500, body: String(error?.message || "Request failed") };
  }

  await prisma.activationDestination.update({
    where: { id: destination.id },
    data: {
      lastStatus: `${result.status}`,
      lastResponse: result.body,
      lastTriggeredAt: new Date(),
    },
  });

  return result;
}

function compareMetricValue(value, comparator, threshold) {
  const v = Number(value || 0);
  const t = Number(threshold || 0);
  if (comparator === "gte") return v >= t;
  if (comparator === "lte") return v <= t;
  if (comparator === "gt") return v > t;
  if (comparator === "lt") return v < t;
  return false;
}

export async function listAudienceSyncRules(shop) {
  if (!prisma.audienceSyncRule) return [];
  try {
    return await prisma.audienceSyncRule.findMany({
      where: { shop: String(shop) },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return [];
    throw error;
  }
}

export async function createAudienceSyncRule(shop, payload) {
  if (!prisma.audienceSyncRule) return null;
  try {
    return await prisma.audienceSyncRule.create({
      data: {
        shop: String(shop),
        name: String(payload?.name || "").trim(),
        audienceName: String(payload?.audienceName || "").trim(),
        destinationId: Number(payload?.destinationId || 0),
        metric: String(payload?.metric || "real_roas").trim(),
        comparator: String(payload?.comparator || "gte").trim(),
        threshold: Number(payload?.threshold || 0),
        source: payload?.source ? String(payload.source).trim().toLowerCase() : null,
        isActive: payload?.isActive !== false,
      },
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return null;
    throw error;
  }
}

export async function updateAudienceSyncRuleStatus(shop, ruleId, isActive) {
  if (!prisma.audienceSyncRule) return null;
  try {
    return await prisma.audienceSyncRule.updateMany({
      where: { id: Number(ruleId), shop: String(shop) },
      data: { isActive: !!isActive },
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return null;
    throw error;
  }
}

export async function deleteAudienceSyncRule(shop, ruleId) {
  if (!prisma.audienceSyncRule) return null;
  try {
    return await prisma.audienceSyncRule.deleteMany({
      where: { id: Number(ruleId), shop: String(shop) },
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return null;
    throw error;
  }
}

export async function listAudienceSyncRuns(shop, limit = 30) {
  if (!prisma.audienceSyncRun) return [];
  try {
    return await prisma.audienceSyncRun.findMany({
      where: { shop: String(shop) },
      orderBy: { createdAt: "desc" },
      take: Number(limit),
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return [];
    throw error;
  }
}

function scoreCampaign(row) {
  const roasComponent = Math.max(0, Math.min(60, (row.realRoas || 0) * 20));
  const marginComponent = row.grossRevenue > 0 ? Math.max(0, Math.min(25, (row.netCash / row.grossRevenue) * 100)) : 0;
  const volumeComponent = Math.max(0, Math.min(15, row.orders * 1.5));
  const score = Math.round(roasComponent + marginComponent + volumeComponent);
  const band = score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "D";
  return { score, band };
}

export async function getCreativePerformanceScores(shop, days = 30, source = "all") {
  const data = await getCampaignPerformance(shop, days, source);
  return (data.rows || []).map((row) => {
    const { score, band } = scoreCampaign(row);
    const recommendation =
      score >= 75
        ? "Scale winning creative variants."
        : score >= 60
          ? "Test 2-3 angle variations."
          : score >= 45
            ? "Refresh hooks and first 3 seconds."
            : "Pause weak creatives and relaunch with new concepts.";
    return {
      ...row,
      creativeScore: score,
      creativeBand: band,
      creativeRecommendation: recommendation,
    };
  });
}

export async function getBudgetReallocationSuggestions(shop, days = 30) {
  const data = await getCampaignPerformance(shop, days, "all");
  const rows = data.rows || [];
  const underperformers = rows
    .filter((r) => r.orders > 0 && (r.realRoas < 1 || r.netCash < 0))
    .sort((a, b) => (a.realRoas - b.realRoas) || (a.netCash - b.netCash))
    .slice(0, 5);
  const winners = rows
    .filter((r) => r.orders > 0 && r.realRoas >= 1.6 && r.netCash > 0)
    .sort((a, b) => b.realRoas - a.realRoas)
    .slice(0, 5);

  const suggestions = [];
  const pairs = Math.min(underperformers.length, winners.length);
  for (let i = 0; i < pairs; i += 1) {
    const from = underperformers[i];
    const to = winners[i];
    suggestions.push({
      fromSource: from.source,
      fromCampaignId: from.campaignId || null,
      fromCampaignName: from.campaignName || null,
      toSource: to.source,
      toCampaignId: to.campaignId || null,
      toCampaignName: to.campaignName || null,
      shiftPercent: from.realRoas < 0.75 ? 30 : 20,
      reason: `Shift budget from ${from.realRoas.toFixed(2)}x to ${to.realRoas.toFixed(2)}x real ROAS campaign.`,
    });
  }
  return suggestions;
}

export async function createBudgetReallocationDecision(shop, payload) {
  if (!prisma.budgetReallocationDecision) return null;
  try {
    return await prisma.budgetReallocationDecision.create({
      data: {
        shop: String(shop),
        fromSource: String(payload?.fromSource || "unknown"),
        fromCampaignId: payload?.fromCampaignId ? String(payload.fromCampaignId) : null,
        fromCampaignName: payload?.fromCampaignName ? String(payload.fromCampaignName) : null,
        toSource: String(payload?.toSource || "unknown"),
        toCampaignId: payload?.toCampaignId ? String(payload.toCampaignId) : null,
        toCampaignName: payload?.toCampaignName ? String(payload.toCampaignName) : null,
        shiftPercent: Number(payload?.shiftPercent || 0),
        reason: String(payload?.reason || "Reallocation approved"),
        status: String(payload?.status || "approved"),
        approvedBy: payload?.approvedBy ? String(payload.approvedBy) : null,
      },
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return null;
    throw error;
  }
}

export async function listBudgetReallocationDecisions(shop, limit = 40) {
  if (!prisma.budgetReallocationDecision) return [];
  try {
    return await prisma.budgetReallocationDecision.findMany({
      where: { shop: String(shop) },
      orderBy: { createdAt: "desc" },
      take: Number(limit),
    });
  } catch (error) {
    if (isSchemaMismatchError(error)) return [];
    throw error;
  }
}

export async function runAudienceSyncRules(shop, { days = 30, ruleId = null } = {}) {
  if (!prisma.audienceSyncRule || !prisma.audienceSyncRun) return { processed: 0, fired: 0, skipped: 0, runs: [] };

  const rules = await prisma.audienceSyncRule.findMany({
    where: {
      shop: String(shop),
      isActive: true,
      ...(ruleId ? { id: Number(ruleId) } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const orders = await getOrders(shop, days);
  const spendRows = await getSourceMetrics(days);
  const totalSpend = spendRows.reduce((sum, row) => sum + (row.adSpend || 0), 0);
  const totalNet = orders.reduce((sum, row) => sum + (row.netCash || 0), 0);
  const totalGross = orders.reduce((sum, row) => sum + (row.grossValue || 0), 0);

  const runs = [];
  let fired = 0;
  let skipped = 0;
  for (const rule of rules) {
    const scopedOrders = rule.source
      ? orders.filter((row) => String(row.marketingSource || "").toLowerCase() === String(rule.source).toLowerCase())
      : orders;
    const gross = scopedOrders.reduce((sum, row) => sum + (row.grossValue || 0), 0);
    const matchedCount = scopedOrders.length;

    let metricValue = 0;
    if (rule.metric === "order_count") metricValue = matchedCount;
    else if (rule.metric === "avg_order_value") metricValue = matchedCount > 0 ? gross / matchedCount : 0;
    else if (rule.metric === "real_roas") metricValue = totalSpend > 0 ? totalNet / totalSpend : 0;
    else if (rule.metric === "profit_margin_pct") metricValue = totalGross > 0 ? (totalNet / totalGross) * 100 : 0;
    else metricValue = 0;

    const conditionMet = compareMetricValue(metricValue, rule.comparator, rule.threshold);
    let status = "skipped";
    let response = "";
    let errorMessage = "";
    let payload = {
      type: "audience_sync",
      audienceName: rule.audienceName,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      metricValue,
      matchedCount,
      orderKeys: scopedOrders
        .slice(0, 1000)
        .map((row) => row.orderId || row.orderNumber)
        .filter(Boolean),
      source: rule.source || "all",
      windowDays: days,
      shop,
      timestamp: new Date().toISOString(),
    };

    if (conditionMet) {
      const result = await triggerActivationDestination(shop, rule.destinationId, payload);
      status = result.ok ? "fired" : "failed";
      response = result.body || "";
      if (!result.ok) errorMessage = result.body || `HTTP ${result.status}`;
      if (result.ok) fired += 1;
    } else {
      skipped += 1;
    }

    const created = await prisma.audienceSyncRun.create({
      data: {
        shop: String(shop),
        ruleId: rule.id,
        status,
        metricValue,
        matchedCount,
        payload: JSON.stringify(payload),
        response: response || null,
        errorMessage: errorMessage || null,
      },
    });
    await prisma.audienceSyncRule.update({
      where: { id: rule.id },
      data: { lastRunAt: new Date() },
    });
    runs.push(created);
  }

  return { processed: rules.length, fired, skipped, runs };
}
