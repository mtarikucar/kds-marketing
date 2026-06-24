-- Per-order coupon-redemption idempotency. Without this, two concurrent redeems
-- for the same order (double-submit / retry) each consume a redemption slot and
-- write a duplicate CouponRedemption row. At most one redemption per (coupon,
-- invoice) and per (coupon, order form) — partial since the ids are nullable.
CREATE UNIQUE INDEX "coupon_redemptions_coupon_invoice_key"
  ON "coupon_redemptions" ("couponId", "invoiceId")
  WHERE "invoiceId" IS NOT NULL;

CREATE UNIQUE INDEX "coupon_redemptions_coupon_orderform_key"
  ON "coupon_redemptions" ("couponId", "orderFormId")
  WHERE "orderFormId" IS NOT NULL;
