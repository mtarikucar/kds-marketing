-- Concepts: the step between "this idea is good" and a campaign calendar.
--
-- A single idea is distilled into N ANGLES on that idea, each planned shot by
-- shot. Most of a batch is meant to be discarded, which is why these are not
-- social_campaign_items: that table's socialCampaignId is a required FK and
-- scheduledFor a required timestamp, so an idea with no campaign and no date
-- could only be stored by inventing both — and a rejected idea would then sit
-- in the campaign's calendar counted as planned content by its stats JSON.
--
-- Shaped so promotion stays a short step: hook -> item.topic, shotPlan travels
-- across whole, socialCampaignId already recorded when the idea arrived scoped
-- to a campaign.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContentConceptStatus') THEN
        CREATE TYPE "ContentConceptStatus" AS ENUM ('PROPOSED', 'APPROVED', 'DISCARDED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "content_concepts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    -- The N concepts distilled from ONE idea in ONE call share this, so a
    -- reviewer sees a batch rather than a flat backlog.
    "batchId" TEXT NOT NULL,
    -- The idea verbatim, so the concept can be judged against what was asked.
    "sourceIdea" TEXT NOT NULL,
    -- Free text, not an enum: the five-angle taxonomy is a prompt, not a
    -- contract, and freezing it here would stop the sixth good angle existing.
    -- Uniqueness within a batch is enforced in application code.
    "angle" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "ordinal" INTEGER NOT NULL,
    -- A ShotPlan (video/video-pipeline.service.ts).
    "shotPlan" JSONB NOT NULL,
    "status" "ContentConceptStatus" NOT NULL DEFAULT 'PROPOSED',
    -- Stamped only when a HUMAN decides. NULL on PROPOSED.
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    -- Soft reference, like SocialCampaign.linkedCampaignId: a concept must
    -- outlive the deletion of a campaign, because the idea is still good.
    "socialCampaignId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DB default, matching every other @updatedAt column in this schema:
    -- Prisma writes the value on every update from the client, and a
    -- CURRENT_TIMESTAMP default here is real drift — `prisma migrate diff`
    -- fails the CI parity gate on it.
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_concepts_pkey" PRIMARY KEY ("id")
);

-- The review queue read: one workspace, one status.
CREATE INDEX IF NOT EXISTS "content_concepts_workspaceId_status_idx"
    ON "content_concepts"("workspaceId", "status");

-- The batch read: "show me the five that came out of that idea". workspaceId
-- leads BOTH indexes deliberately — every read on this table is tenant-scoped
-- and a batchId-first index would invite a query that forgets to say whose.
CREATE INDEX IF NOT EXISTS "content_concepts_workspaceId_batchId_idx"
    ON "content_concepts"("workspaceId", "batchId");
