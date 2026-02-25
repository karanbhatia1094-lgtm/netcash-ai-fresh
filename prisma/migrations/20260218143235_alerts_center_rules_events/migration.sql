-- CreateTable
CREATE TABLE "AlertRuleSetting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mutedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AlertRuleSetting_shop_idx" ON "AlertRuleSetting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRuleSetting_shop_ruleKey_key" ON "AlertRuleSetting"("shop", "ruleKey");

-- CreateIndex
CREATE INDEX "AlertEvent_shop_isRead_severity_lastSeenAt_idx" ON "AlertEvent"("shop", "isRead", "severity", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvent_shop_fingerprint_key" ON "AlertEvent"("shop", "fingerprint");
