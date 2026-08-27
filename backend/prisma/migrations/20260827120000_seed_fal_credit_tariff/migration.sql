-- Give fal.ai media generation a price, so the last unmetered vendor lands in
-- the spend ledger like every other one.
--
-- The `CONTENT` ledger channel, the `FAL_CREDIT` tariff unit and
-- `estimateMediaCredits()` have all existed since media generation shipped, with
-- nothing joining them: no code ever settled a FAL_CREDIT. So fal cost appeared
-- in the customer's credit meter and (for engine assets) in the growth wallet,
-- while the vendor-cost report showed 0 for it. v2.270.0 adds the settle call;
-- this gives it something to resolve.
--
-- COST RECOVERY, NOT A MARGIN. media-models.config.ts sets the credit meter at
-- ~1 credit ≈ $0.01 of generation spend, already rounded up so the platform
-- never under-charges. Converted at ~40 TRY/USD that is 0.40 TRY per credit.
-- Raise it in the panel to price the feature — that is a commercial decision and
-- deliberately not one this migration makes.
--
-- Platform default (workspaceId NULL); a workspace row still wins, because
-- resolve() scores workspace matches above platform ones. Guarded so re-running
-- against a database that already has a rate cannot overwrite it.
--
-- country stays NULL: fal bills in USD regardless of where the customer is, so
-- unlike the carrier rates there is nothing country-specific to match on. The
-- settle call passes no country, which matches only country-agnostic rows.

INSERT INTO "channel_tariffs" ("id", "workspaceId", "channel", "provider", "unitType", "unitCost", "currency", "country", "effectiveFrom", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'CONTENT', 'fal', 'FAL_CREDIT', 0.4000, 'TRY', NULL, now(), true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "channel_tariffs"
  WHERE "workspaceId" IS NULL AND "channel" = 'CONTENT' AND "unitType" = 'FAL_CREDIT'
);
