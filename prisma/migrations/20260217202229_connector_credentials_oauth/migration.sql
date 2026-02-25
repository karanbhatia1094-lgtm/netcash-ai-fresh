-- CreateTable
CREATE TABLE "ConnectorCredential" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenType" TEXT,
    "scope" TEXT,
    "expiresAt" DATETIME,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ConnectorCredential_shop_idx" ON "ConnectorCredential"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorCredential_shop_provider_key" ON "ConnectorCredential"("shop", "provider");
