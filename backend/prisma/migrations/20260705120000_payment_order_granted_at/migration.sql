-- Audit A1: make paid-but-ungranted queryable. The reconcile sweep used a
-- blind `take: limit` window (succeededAt asc) that could never advance past
-- the oldest `limit` SUCCEEDED orders; a recent failed grant was born outside
-- the window and never re-examined. `grantedAt` is stamped on grant success
-- and the sweep filters `grantedAt IS NULL`.
ALTER TABLE "payment_orders" ADD COLUMN "grantedAt" TIMESTAMP(3);

CREATE INDEX "payment_orders_status_grantedAt_idx" ON "payment_orders"("status", "grantedAt");

-- Backfill: existing SUCCEEDED orders predate the marker.
--  * Subscription-family + ADDON: assume granted (the pre-existing sweep's own
--    assumption — workspaces with a subscription were skipped as granted, and
--    ADDON misgrants stay operator-triaged).
--  * WALLET_TOPUP: only mark granted when the wallet credit VERIFIABLY landed
--    (its idempotency ref exists in the growth wallet ledger) — an uncredited
--    paid top-up must stay in the sweep window to be recovered.
UPDATE "payment_orders" p
SET "grantedAt" = COALESCE(p."succeededAt", p."updatedAt")
WHERE p.status = 'SUCCEEDED'
  AND (
    p.type <> 'WALLET_TOPUP'
    OR EXISTS (
      SELECT 1 FROM "growth_wallet_ledger_entries" l
      WHERE l.ref = 'order:' || p.id
    )
  );
