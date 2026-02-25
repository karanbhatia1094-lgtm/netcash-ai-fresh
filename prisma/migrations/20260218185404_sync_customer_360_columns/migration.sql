-- AlterTable
ALTER TABLE "NetCashOrder" ADD COLUMN "customerEmail" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "customerName" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "customerPhone" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "firstClickCampaignId" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "firstClickCampaignName" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "firstClickSource" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "lastClickCampaignId" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "lastClickCampaignName" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "lastClickSource" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingAddress1" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingAddress2" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingCountry" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingPincode" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "shippingState" TEXT;
ALTER TABLE "NetCashOrder" ADD COLUMN "touchpointsJson" TEXT;
