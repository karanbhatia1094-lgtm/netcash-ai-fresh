-- CreateTable
CREATE TABLE "ConnectorSyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lookbackDays" INTEGER NOT NULL DEFAULT 7,
    "spendRowsFetched" INTEGER NOT NULL DEFAULT 0,
    "spendRowsWritten" INTEGER NOT NULL DEFAULT 0,
    "attributionRowsFetched" INTEGER NOT NULL DEFAULT 0,
    "attributionRowsWritten" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ConnectorSyncRun_shop_createdAt_idx" ON "ConnectorSyncRun"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectorSyncRun_provider_createdAt_idx" ON "ConnectorSyncRun"("provider", "createdAt");
