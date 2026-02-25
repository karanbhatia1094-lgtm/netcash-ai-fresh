-- CreateTable
CREATE TABLE "MarketingSpendEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "spendDate" DATETIME NOT NULL,
    "adSpend" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MarketingSpendEntry_spendDate_idx" ON "MarketingSpendEntry"("spendDate");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSpendEntry_source_spendDate_key" ON "MarketingSpendEntry"("source", "spendDate");
