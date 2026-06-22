-- Epic 5: opportunity forecasting (GoHighLevel parity).
-- Additive nullable column only — safe to deploy ahead of the code on one replica.
ALTER TABLE "opportunities" ADD COLUMN "expectedCloseDate" TIMESTAMP(3);
