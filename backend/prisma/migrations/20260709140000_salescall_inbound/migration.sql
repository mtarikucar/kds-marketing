-- Phase 3 Task 2 — INBOUND/missed SalesCalls + crm_id correlation.
-- Additive + one relaxation; no data is touched or deleted.

-- An INBOUND call to an extension that doesn't match any MarketingUser.dahili
-- has no rep to attribute it to (OUTBOUND calls always set this from the
-- authenticated actor in SalesCallService.startCall, so this never regresses
-- that path).
ALTER TABLE "sales_calls" ALTER COLUMN "marketingUserId" DROP NOT NULL;

-- The rep whose extension actually answered (may differ from
-- marketingUserId on an INBOUND call routed through a hunt group).
ALTER TABLE "sales_calls" ADD COLUMN IF NOT EXISTS "answeredByUserId" TEXT;

-- Stamped when an INBOUND SalesCall row is created from an `inbound_call`
-- santral event (the extension started ringing).
ALTER TABLE "sales_calls" ADD COLUMN IF NOT EXISTS "ringingAt" TIMESTAMP(3);

-- santral event correlation (crm_id/uniqueId -> this row) reads/upserts by
-- externalCallId on every inbound_call/answer/hangup/cdr event.
CREATE INDEX IF NOT EXISTS "sales_calls_externalCallId_idx" ON "sales_calls"("externalCallId");
