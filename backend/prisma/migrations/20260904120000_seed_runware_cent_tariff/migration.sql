-- Give Runware media generation a price so the second media vendor lands in the
-- spend ledger beside fal (v2.270.0 gave fal one; hybrid routing adds Runware).
--
-- UNIT IS A US CENT, NOT A CREDIT. Runware reports its own USD cost per task
-- (`includeCost`), and the catalogue's credit meter stays derived from the fal
-- rate whichever vendor rendered — so a Runware generation is metered in cents
-- of what Runware actually charged. The rate carries the same ~40 TRY/USD
-- assumption the FAL_CREDIT row does (0.40 TRY per $0.01), so the two vendors
-- read in one currency on the report. Raise or lower it in the panel.
--
-- Platform default (workspaceId NULL); a workspace row still wins, because
-- resolve() scores workspace matches above platform ones. Guarded so re-running
-- against a database that already has a rate cannot overwrite it. country stays
-- NULL: Runware bills in USD regardless of where the customer is.

INSERT INTO "channel_tariffs" ("id", "workspaceId", "channel", "provider", "unitType", "unitCost", "currency", "country", "effectiveFrom", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'CONTENT', 'runware', 'RUNWARE_CENT', 0.4000, 'TRY', NULL, now(), true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "channel_tariffs"
  WHERE "workspaceId" IS NULL AND "channel" = 'CONTENT' AND "unitType" = 'RUNWARE_CENT'
);
