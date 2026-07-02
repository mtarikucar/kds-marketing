-- Fix: the per-order-form coupon-redemption unique index must be scoped to the
-- BUYER, not just the order form. An order form is a reusable public page many
-- different buyers submit; CouponsService.redeem() dedups per
-- (coupon, orderForm, leadId) — its own comment says keying on orderFormId ALONE
-- would let the first buyer short-circuit every later buyer. But the backing
-- index was ("couponId","orderFormId"), omitting leadId. So the 2nd+ buyer's
-- redemption collided (P2002); order-forms.submit() swallows that (.catch → null)
-- and silently charges them FULL price, while the coupon still shows redemptions
-- remaining. A multi-use order-form coupon worked for exactly one buyer.
--
-- Adding leadId matches the app-level dedup key. It only LOOSENS the constraint
-- (any rows unique under the old key are unique under the new one), so no data
-- cleanup is needed. Same-buyer double-submit is still deduped by (coupon,
-- orderForm, leadId); the order-form caller always resolves a concrete leadId
-- (the lead is created/deduped before redeem), so the nullable leadId never
-- weakens it in practice.
DROP INDEX "coupon_redemptions_coupon_orderform_key";

CREATE UNIQUE INDEX "coupon_redemptions_coupon_orderform_key"
  ON "coupon_redemptions" ("couponId", "orderFormId", "leadId")
  WHERE "orderFormId" IS NOT NULL;
