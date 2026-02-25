-- CreateTable
CREATE TABLE "NetCashOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" TEXT NOT NULL,
    "marketingSource" TEXT NOT NULL,
    "originalValue" REAL NOT NULL,
    "refundedValue" REAL NOT NULL DEFAULT 0,
    "currentStatus" TEXT NOT NULL,
    "isReturned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketingSourceMetrics" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "reportedROAS" REAL NOT NULL DEFAULT 0,
    "adSpend" REAL NOT NULL DEFAULT 0,
    "reportedRevenue" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "NetCashOrder_orderId_key" ON "NetCashOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSourceMetrics_source_key" ON "MarketingSourceMetrics"("source");
