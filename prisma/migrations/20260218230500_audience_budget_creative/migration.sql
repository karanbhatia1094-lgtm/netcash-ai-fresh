-- CreateTable
CREATE TABLE "AudienceSyncRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audienceName" TEXT NOT NULL,
    "destinationId" INTEGER NOT NULL,
    "metric" TEXT NOT NULL,
    "comparator" TEXT NOT NULL,
    "threshold" REAL NOT NULL,
    "source" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AudienceSyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "ruleId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "metricValue" REAL,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "response" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BudgetReallocationDecision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "fromSource" TEXT NOT NULL,
    "fromCampaignId" TEXT,
    "fromCampaignName" TEXT,
    "toSource" TEXT NOT NULL,
    "toCampaignId" TEXT,
    "toCampaignName" TEXT,
    "shiftPercent" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "approvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AudienceSyncRule_shop_isActive_createdAt_idx" ON "AudienceSyncRule"("shop", "isActive", "createdAt");

-- CreateIndex
CREATE INDEX "AudienceSyncRun_shop_createdAt_idx" ON "AudienceSyncRun"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AudienceSyncRun_ruleId_createdAt_idx" ON "AudienceSyncRun"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "BudgetReallocationDecision_shop_createdAt_idx" ON "BudgetReallocationDecision"("shop", "createdAt");
