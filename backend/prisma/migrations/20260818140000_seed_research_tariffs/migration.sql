-- Turn research metering on by giving it prices to work with.
--
-- ResearchSpendService and ConversationSpendService are both complete and
-- correctly wired: firecrawl pages, apify runs and delivered leads are settled
-- at the point of use. But ChannelTariffService.resolve() returns null when no
-- ChannelTariff row matches, both services then log at DEBUG and return, and
-- NOTHING in the repo or in any migration ever inserted a row. So every unit of
-- crawl/actor spend since the feature shipped has been silently free, with the
-- only trace at a log level production does not print.
--
-- These are PLATFORM defaults (workspaceId NULL). A workspace-specific row
-- still wins: resolve() scores workspace matches above platform ones.
--
-- THE NUMBERS ARE COST RECOVERY, NOT A MARGIN. They come from vendor list
-- price converted at ~40 TRY/USD, rounded up:
--   FIRECRAWL_PAGE  ~$0.001/page  -> 0.05 TRY
--   APIFY_RUN       ~$0.05/run    -> 2.00 TRY
-- Raise them in the panel to price the feature; that is a commercial decision
-- and deliberately not one this migration makes.
--
-- RESEARCH_LEAD is intentionally NOT seeded. It is an outcome unit charged on
-- top of the inputs above, so pricing it is a product decision, and seeding it
-- at a guess would double-charge for work the two input units already recover.
--
-- Carrier units (SMS_SEGMENT, VOICE_MINUTE, WA_*) are also not seeded: those
-- are the operator's own contracted NetGSM/Meta rates and cannot be guessed.
-- They now log at WARN when missing, so the gap is visible instead of silent.

INSERT INTO "channel_tariffs" ("id", "workspaceId", "channel", "provider", "unitType", "unitCost", "currency", "effectiveFrom", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'RESEARCH', 'firecrawl', 'FIRECRAWL_PAGE', 0.0500, 'TRY', now(), true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "channel_tariffs"
  WHERE "workspaceId" IS NULL AND "channel" = 'RESEARCH' AND "unitType" = 'FIRECRAWL_PAGE'
);

INSERT INTO "channel_tariffs" ("id", "workspaceId", "channel", "provider", "unitType", "unitCost", "currency", "effectiveFrom", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'RESEARCH', 'apify', 'APIFY_RUN', 2.0000, 'TRY', now(), true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "channel_tariffs"
  WHERE "workspaceId" IS NULL AND "channel" = 'RESEARCH' AND "unitType" = 'APIFY_RUN'
);
