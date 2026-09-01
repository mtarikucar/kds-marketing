-- Distribution: who to contact, what to tag, when to cross-post — and a
-- message that is PREPARED but not sent.
--
-- The owner chose the safe shape explicitly: the system produces a plan and
-- drafts; a human sends. The rejected alternative was automated mass DMs to
-- strangers, which is what platform spam detection is built to catch and what
-- gets an account restricted. Everything below is shaped by that decision.
--
-- WHY A NEW TABLE FOR DRAFTS. Nothing in this product stores an unsent message.
-- A `messages` row is only ever written AFTER a send attempt (SENT or FAILED),
-- so "prepared, not sent" has no home there — and giving it one would put an
-- unsent row in the inbox's own table, where every reader would have to learn a
-- new state it has never had to consider. A separate table means the send
-- boundary is a boundary between TABLES, not a status column somebody can flip.
--
-- WHY `distribution_drafts.status` STARTS AT DRAFT AND NOTHING BUT A HUMAN MOVES
-- IT. `sentAt` + `sentById` are written together by the one method a human
-- calls. A SENT row with a null `sentById` would be evidence of exactly the
-- behaviour this design forbids, which is why the pair exists rather than a
-- lone timestamp.
--
-- WHY `campaignItemId` IS UNIQUE ON THE PLAN. Two plans for one item would be
-- two competing answers to "who has already been contacted about this video",
-- and the drafts hang off the plan. Re-planning replaces the plan's CONTENT and
-- keeps its identity, so a draft a human already sent keeps pointing at a row
-- that still exists.
--
-- WHY THE UNIQUE INDEX ON (planId, leadId, channelType). Re-planning has to be
-- idempotent for the same reason promotion did: the operation is
-- read-then-create, and a read-then-create guard cannot stop a double-create —
-- two concurrent runs each see "no draft yet" and both insert. Postgres
-- refusing the second is the guarantee; the application catches the violation
-- and keeps the existing row, which is the one a human may already have edited.
--
-- WHY THE PLAN ITSELF IS JSONB. The plan carries a `gaps` array: the parts that
-- could NOT be produced, each with its reason. That is not decoration — an
-- empty `crossPosts` list that reads as "no cross-posting needed" is precisely
-- the failure mode the spec forbids ("dağıtım planı çıkarılamazsa 'dağıtım
-- gerekmiyor' denmez"). Gaps travel WITH the plan, in the same document, so no
-- reader can display one without the other.
--
-- Soft references throughout (no FKs to social_campaign_items, leads, channels
-- or marketing_users), matching this schema's house style for cross-module
-- links — and load-bearing here: a plan is a RECORD of what was distributed and
-- must outlive the deletion of the calendar slot it was drawn from.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DistributionDraftStatus') THEN
        CREATE TYPE "DistributionDraftStatus" AS ENUM ('DRAFT', 'SENT', 'DISMISSED', 'FAILED');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "content_distribution_plans" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignItemId" TEXT NOT NULL,
    "socialCampaignId" TEXT NOT NULL,
    "contentConceptId" TEXT,
    "plan" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- No DB default, matching every other @updatedAt column in this schema:
    -- Prisma writes it from the client on every update, and a CURRENT_TIMESTAMP
    -- default here is drift the CI parity gate fails on.
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_distribution_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "content_distribution_plans_campaignItemId_key"
    ON "content_distribution_plans"("campaignItemId");

-- Every read of this table is tenant-scoped, so workspaceId leads.
CREATE INDEX IF NOT EXISTS "content_distribution_plans_workspaceId_idx"
    ON "content_distribution_plans"("workspaceId");

CREATE TABLE IF NOT EXISTS "distribution_drafts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "campaignItemId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    -- SMS | WHATSAPP | EMAIL. The three a conversation can be STARTED on; the
    -- list is short because Instagram, Messenger and TikTok only permit a reply
    -- to someone who wrote first, which is a platform rule and not a missing
    -- adapter.
    "channelType" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "DistributionDraftStatus" NOT NULL DEFAULT 'DRAFT',
    -- Written together, by a human send, and never apart.
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "conversationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distribution_drafts_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee of re-planning. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS "distribution_drafts_planId_leadId_channelType_key"
    ON "distribution_drafts"("planId", "leadId", "channelType");

-- "What is still waiting for a person", per tenant and per plan.
CREATE INDEX IF NOT EXISTS "distribution_drafts_workspaceId_status_idx"
    ON "distribution_drafts"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "distribution_drafts_planId_status_idx"
    ON "distribution_drafts"("planId", "status");
