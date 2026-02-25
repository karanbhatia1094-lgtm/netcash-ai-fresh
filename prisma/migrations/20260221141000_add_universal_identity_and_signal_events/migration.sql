-- CreateTable
CREATE TABLE "UniversalIdentity" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "identityKey" TEXT NOT NULL,
    "identityType" TEXT NOT NULL,
    "identityHash" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventsCount" INTEGER NOT NULL DEFAULT 0,
    "shopsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UniversalIdentityShop" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "identityKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventsCount" INTEGER NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalGrossValue" REAL NOT NULL DEFAULT 0,
    "totalNetCash" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UniversalSignalEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventAt" DATETIME NOT NULL,
    "orderId" TEXT,
    "orderNumber" TEXT,
    "source" TEXT,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "identityKey" TEXT,
    "customerEmailHash" TEXT,
    "customerPhoneHash" TEXT,
    "clickIdHash" TEXT,
    "sessionId" TEXT,
    "paymentMethod" TEXT,
    "couponCode" TEXT,
    "discountAmount" REAL,
    "grossValue" REAL,
    "netCash" REAL,
    "messageChannel" TEXT,
    "messageOpenedAt" DATETIME,
    "adSeenAt" DATETIME,
    "purchaseAt" DATETIME,
    "deviceType" TEXT,
    "osName" TEXT,
    "handsetBrand" TEXT,
    "handsetModel" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UniversalCustomerProfile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "customerEmailHash" TEXT,
    "customerPhoneHash" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalGrossValue" REAL NOT NULL DEFAULT 0,
    "totalDiscountAmount" REAL NOT NULL DEFAULT 0,
    "totalNetCash" REAL NOT NULL DEFAULT 0,
    "lastPaymentMethod" TEXT,
    "lastCouponCode" TEXT,
    "lastSource" TEXT,
    "lastCampaignId" TEXT,
    "lastCampaignName" TEXT,
    "lastOsName" TEXT,
    "lastHandsetBrand" TEXT,
    "lastHandsetModel" TEXT,
    "lastDeviceType" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "UniversalIdentity_identityKey_key" ON "UniversalIdentity"("identityKey");

-- CreateIndex
CREATE INDEX "UniversalIdentity_identityType_identityHash_idx" ON "UniversalIdentity"("identityType", "identityHash");

-- CreateIndex
CREATE INDEX "UniversalIdentity_lastSeenAt_idx" ON "UniversalIdentity"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "UniversalIdentityShop_identityKey_shop_key" ON "UniversalIdentityShop"("identityKey", "shop");

-- CreateIndex
CREATE INDEX "UniversalIdentityShop_shop_lastSeenAt_idx" ON "UniversalIdentityShop"("shop", "lastSeenAt");

-- CreateIndex
CREATE INDEX "UniversalSignalEvent_shop_eventAt_idx" ON "UniversalSignalEvent"("shop", "eventAt");

-- CreateIndex
CREATE INDEX "UniversalSignalEvent_shop_eventType_eventAt_idx" ON "UniversalSignalEvent"("shop", "eventType", "eventAt");

-- CreateIndex
CREATE INDEX "UniversalSignalEvent_identityKey_eventAt_idx" ON "UniversalSignalEvent"("identityKey", "eventAt");

-- CreateIndex
CREATE UNIQUE INDEX "UniversalCustomerProfile_shop_identityKey_key" ON "UniversalCustomerProfile"("shop", "identityKey");

-- CreateIndex
CREATE INDEX "UniversalCustomerProfile_shop_totalNetCash_idx" ON "UniversalCustomerProfile"("shop", "totalNetCash");

-- CreateIndex
CREATE INDEX "UniversalCustomerProfile_identityKey_lastSeenAt_idx" ON "UniversalCustomerProfile"("identityKey", "lastSeenAt");
