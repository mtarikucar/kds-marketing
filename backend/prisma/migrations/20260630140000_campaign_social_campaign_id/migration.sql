-- Cross-linkage: a blast Campaign's companion Social Campaign (AI Social Content
-- Studio §6.3). Additive, nullable, no default — safe on populated tables.
ALTER TABLE "campaigns" ADD COLUMN "socialCampaignId" TEXT;
