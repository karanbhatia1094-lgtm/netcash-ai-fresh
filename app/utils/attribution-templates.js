function safeOrderNumber(sampleOrder) {
  return String(sampleOrder?.orderNumber || "#1001");
}

function safeOrderId(sampleOrder) {
  return String(sampleOrder?.orderId || "gid://shopify/Order/12345");
}

function baseRecord({ shop, sampleOrder, campaignId, campaignName }) {
  return {
    shop,
    orderNumber: safeOrderNumber(sampleOrder),
    campaignId,
    campaignName,
  };
}

function defaultMappings() {
  return [
    { sourceField: "provider or tool", netcashField: "provider", notes: "Connector/tool name" },
    { sourceField: "shop", netcashField: "shop", notes: "myshopify domain" },
    { sourceField: "order_id / order_number", netcashField: "orderId / orderNumber", notes: "At least one required" },
    { sourceField: "campaign_id", netcashField: "campaignId", notes: "Preferred" },
    { sourceField: "campaign_name", netcashField: "campaignName", notes: "Preferred" },
    { sourceField: "adset_id / adgroup_id", netcashField: "adSetId", notes: "Optional" },
    { sourceField: "ad_id / creative_id", netcashField: "adId", notes: "Optional" },
  ];
}

function providerMappings(provider) {
  const common = defaultMappings();
  if (provider === "meta_ads") {
    return [
      ...common,
      { sourceField: "meta campaign.id", netcashField: "campaignId", notes: "Meta Ads campaign id" },
      { sourceField: "meta adset.id", netcashField: "adSetId", notes: "Meta Ads ad set id" },
      { sourceField: "meta ad.id", netcashField: "adId", notes: "Meta Ads ad id" },
    ];
  }
  if (provider === "google_ads") {
    return [
      ...common,
      { sourceField: "google campaign.id", netcashField: "campaignId", notes: "Google campaign id" },
      { sourceField: "google ad_group.id", netcashField: "adSetId", notes: "Use ad group id" },
      { sourceField: "google ad_group_ad.ad.id", netcashField: "adId", notes: "Optional creative id" },
    ];
  }
  return [
    ...common,
    { sourceField: "journey_id / flow_id", netcashField: "campaignId", notes: "CRM journey id" },
    { sourceField: "journey_name / campaign_name", netcashField: "campaignName", notes: "CRM campaign label" },
  ];
}

function toCurlCommand(payload) {
  const compact = JSON.stringify(payload);
  return [
    "curl -X POST \"https://your-app-domain/api/attribution\"",
    "  -H \"Content-Type: application/json\"",
    "  -H \"x-netcash-api-key: <ATTRIBUTION_API_KEY>\"",
    `  -d '${compact}'`,
  ].join(" \\\n");
}

function templateDefinitions(shop, sampleOrder) {
  return [
    {
      provider: "meta_ads",
      name: "Meta Ads",
      mode: "pull + mapping",
      mappingHint: "Pass Meta campaign/adset/ad IDs with each mapped order.",
      payload: {
        provider: "meta_ads",
        records: [
          {
            ...baseRecord({
              shop,
              sampleOrder,
              campaignId: "1201234567890",
              campaignName: "Meta Prospecting Conversion",
            }),
            adSetId: "1201234567000",
            adId: "1201234567999",
          },
        ],
      },
    },
    {
      provider: "google_ads",
      name: "Google Ads",
      mode: "pull + mapping",
      mappingHint: "Use orderId (preferred) or orderNumber with campaign/ad group IDs.",
      payload: {
        provider: "google_ads",
        records: [
          {
            shop,
            orderId: safeOrderId(sampleOrder),
            campaignId: "201001",
            campaignName: "Google Search Brand",
            adSetId: "adgroup_7788",
            adId: "creative_8899",
          },
        ],
      },
    },
    {
      provider: "moengage",
      name: "MoEngage",
      mode: "push",
      mappingHint: "Map campaign/journey IDs from MoEngage webhook to Netcash attribution.",
      payload: {
        provider: "moengage",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "moe_journey_001",
            campaignName: "MoEngage Winback Journey",
          }),
        ],
      },
    },
    {
      provider: "webengage",
      name: "WebEngage",
      mode: "push",
      mappingHint: "Send each conversion event with campaign metadata.",
      payload: {
        provider: "webengage",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "we_flow_778",
            campaignName: "WebEngage Cart Recovery",
          }),
        ],
      },
    },
    {
      provider: "clevertap",
      name: "CleverTap",
      mode: "push",
      mappingHint: "Attach CleverTap campaign ID/name against converted order.",
      payload: {
        provider: "clevertap",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "ct_push_456",
            campaignName: "CleverTap Promo Push",
          }),
        ],
      },
    },
    {
      provider: "kwikengage",
      name: "KwikEngage",
      mode: "push",
      mappingHint: "Post WhatsApp campaign attribution after order success.",
      payload: {
        provider: "kwikengage",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "kwk_wa_1200",
            campaignName: "KwikEngage Broadcast Promo",
          }),
        ],
      },
    },
    {
      provider: "bik_ai",
      name: "Bik.ai",
      mode: "push",
      mappingHint: "Map conversational commerce flows to order-level attribution.",
      payload: {
        provider: "bik_ai",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "bik_conv_001",
            campaignName: "Bik AI Flow Conversion",
          }),
        ],
      },
    },
    {
      provider: "bitespeed",
      name: "BiteSpeed",
      mode: "push",
      mappingHint: "Send campaign mapping from WhatsApp journeys.",
      payload: {
        provider: "bitespeed",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "bs_wa_022",
            campaignName: "BiteSpeed Cart Recovery",
          }),
        ],
      },
    },
    {
      provider: "nitro",
      name: "Nitro",
      mode: "push",
      mappingHint: "Map Nitro campaign/journey IDs for conversion stitching.",
      payload: {
        provider: "nitro",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "nitro_msg_009",
            campaignName: "Nitro Lifecycle Trigger",
          }),
        ],
      },
    },
    {
      provider: "manual",
      name: "Generic Third-Party",
      mode: "push",
      mappingHint: "Use this for any tool by sending provider/tool and campaign metadata.",
      payload: {
        provider: "manual",
        records: [
          baseRecord({
            shop,
            sampleOrder,
            campaignId: "partner_campaign_001",
            campaignName: "Partner Tool Attribution",
          }),
        ],
      },
    },
  ];
}

export function getAttributionTemplateCatalog({ shop, sampleOrder }) {
  return templateDefinitions(shop, sampleOrder).map((item) => ({
    ...item,
    payloadJson: JSON.stringify(item.payload, null, 2),
    curlCommand: toCurlCommand(item.payload),
    fieldMappings: providerMappings(item.provider),
  }));
}
