/*
  Warnings:

  - The primary key for the `NetCashOrder` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `currentStatus` on the `NetCashOrder` table. All the data in the column will be lost.
  - You are about to drop the column `originalValue` on the `NetCashOrder` table. All the data in the column will be lost.
  - You are about to drop the column `refundedValue` on the `NetCashOrder` table. All the data in the column will be lost.
  - Added the required column `grossValue` to the `NetCashOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `netCash` to the `NetCashOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderNumber` to the `NetCashOrder` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shop` to the `NetCashOrder` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NetCashOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "grossValue" REAL NOT NULL,
    "discountTotal" REAL NOT NULL DEFAULT 0,
    "shippingTotal" REAL NOT NULL DEFAULT 0,
    "taxTotal" REAL NOT NULL DEFAULT 0,
    "refundTotal" REAL NOT NULL DEFAULT 0,
    "returnTotal" REAL NOT NULL DEFAULT 0,
    "rtoTotal" REAL NOT NULL DEFAULT 0,
    "exchangeAdjustment" REAL NOT NULL DEFAULT 0,
    "netCash" REAL NOT NULL,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "marketingSource" TEXT,
    "isReturned" BOOLEAN NOT NULL DEFAULT false,
    "isRTO" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_NetCashOrder" ("createdAt", "id", "isReturned", "marketingSource", "orderId", "updatedAt") SELECT "createdAt", "id", "isReturned", "marketingSource", "orderId", "updatedAt" FROM "NetCashOrder";
DROP TABLE "NetCashOrder";
ALTER TABLE "new_NetCashOrder" RENAME TO "NetCashOrder";
CREATE UNIQUE INDEX "NetCashOrder_orderId_key" ON "NetCashOrder"("orderId");
CREATE UNIQUE INDEX "NetCashOrder_shop_orderNumber_key" ON "NetCashOrder"("shop", "orderNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
