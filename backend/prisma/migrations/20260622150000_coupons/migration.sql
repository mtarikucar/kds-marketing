-- Migration: Discount coupons + invoice discount column (GoHighLevel parity)
--
-- Per-workspace PERCENT/FIXED coupons with server-validated redemption + an
-- append-only redemption log. Invoices gain a `discount` column (applied after
-- tax). Additive + defaulted only — safe online migration.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "discount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "coupons" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "code"           TEXT NOT NULL,
    "kind"           TEXT NOT NULL,
    "value"          INTEGER NOT NULL,
    "currency"       TEXT,
    "minSubtotal"    INTEGER,
    "maxRedemptions" INTEGER,
    "timesRedeemed"  INTEGER NOT NULL DEFAULT 0,
    "startsAt"       TIMESTAMP(3),
    "expiresAt"      TIMESTAMP(3),
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "couponId"    TEXT NOT NULL,
    "invoiceId"   TEXT,
    "orderFormId" TEXT,
    "leadId"      TEXT,
    "amountOff"   INTEGER NOT NULL,
    "redeemedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupons_workspaceId_code_key" ON "coupons"("workspaceId", "code");
CREATE INDEX "coupons_workspaceId_active_idx" ON "coupons"("workspaceId", "active");
CREATE INDEX "coupon_redemptions_couponId_redeemedAt_idx" ON "coupon_redemptions"("couponId", "redeemedAt");
CREATE INDEX "coupon_redemptions_workspaceId_idx" ON "coupon_redemptions"("workspaceId");

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
