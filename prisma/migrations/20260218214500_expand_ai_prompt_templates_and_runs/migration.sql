-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiPromptTemplate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'custom',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiPromptTemplate" ("createdAt", "id", "query", "shop", "title", "updatedAt") SELECT "createdAt", "id", "query", "shop", "title", "updatedAt" FROM "AiPromptTemplate";
DROP TABLE "AiPromptTemplate";
ALTER TABLE "new_AiPromptTemplate" RENAME TO "AiPromptTemplate";
CREATE INDEX "AiPromptTemplate_shop_createdAt_idx" ON "AiPromptTemplate"("shop", "createdAt");
CREATE TABLE "AiPromptRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "templateId" INTEGER,
    "promptQuery" TEXT NOT NULL,
    "intent" TEXT,
    "answer" TEXT,
    "summaryJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiPromptRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AiPromptTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AiPromptRun_shop_createdAt_idx" ON "AiPromptRun"("shop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
