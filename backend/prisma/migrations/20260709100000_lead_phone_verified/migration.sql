-- NetGSM SMS v2 (Phase 1, Task 12): lead phone verification stamp.
-- Additive only; no changes to existing columns.
--
-- leads.phoneVerifiedAt is stamped when a rep confirms a live SMS OTP sent to
-- the lead's phone (POST /marketing/leads/:id/verify-phone/confirm). Null =
-- unverified (default for every existing + new row).
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);
