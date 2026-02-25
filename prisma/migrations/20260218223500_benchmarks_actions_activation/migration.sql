-- CreateTable
CREATE TABLE "MarketBenchmark" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "benchmarkKey" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "p50" REAL NOT NULL,
    "p75" REAL NOT NULL,
    "p90" REAL NOT NULL,
    "source" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignActionItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "reason" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "owner" TEXT,
    "dueDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ActivationDestination" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "authHeaderName" TEXT,
    "authHeaderValue" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastResponse" TEXT,
    "lastTriggeredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketBenchmark_benchmarkKey_metric_key" ON "MarketBenchmark"("benchmarkKey", "metric");

-- CreateIndex
CREATE INDEX "CampaignActionItem_shop_status_priority_createdAt_idx" ON "CampaignActionItem"("shop", "status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ActivationDestination_shop_isActive_idx" ON "ActivationDestination"("shop", "isActive");
