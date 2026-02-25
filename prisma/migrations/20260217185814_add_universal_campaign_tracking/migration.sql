-- AlterTable
ALTER TABLE "NetCashOrder" ADD COLUMN "campaignId" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "campaignName" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "clickId" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "landingSite" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "referringSite" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "utmCampaign" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "utmSource" TEXT;

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "netCashOrderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" REAL NOT NULL DEFAULT 0,
    "lineTotal" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "OrderLineItem_netCashOrderId_fkey" FOREIGN KEY ("netCashOrderId") REFERENCES "NetCashOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ToolAttribution" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "netCashOrderId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ToolAttribution_netCashOrderId_fkey" FOREIGN KEY ("netCashOrderId") REFERENCES "NetCashOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolAttribution_netCashOrderId_tool_key" ON "ToolAttribution"("netCashOrderId", "tool");
