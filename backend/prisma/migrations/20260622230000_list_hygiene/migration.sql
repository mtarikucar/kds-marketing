-- Epic 9a: list-hygiene tier-1 (GoHighLevel parity).
-- Two additive columns (one defaulted, one nullable) — safe on one replica.
ALTER TABLE "leads" ADD COLUMN "emailVerifiedStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "leads" ADD COLUMN "emailBouncedAt" TIMESTAMP(3);
