-- The outbound mail ledger: one row per mail the gateway was asked to send,
-- whatever happened to it.
-- `LeadActivity.leadId` is NOT NULL, so digests, host reminders, team invites
-- and AUTH mail leave no queryable row anywhere today — "why did nothing send
-- in the last hour" is unanswerable for exactly the mail an operator gets paged
-- about. LeadActivity stays the tenant-visible trace; this is the ops record and
-- the attribution key a bounce report comes back on (messageId).
--
-- The unique on (workspaceId, idempotencyKey) is what makes a repeated booking
-- or invoice send settle as DEDUPED instead of a second mail. Postgres treats
-- NULLs as distinct, so the many rows that pass no key never collide — a partial
-- index would behave identically and CI's migrations↔schema parity gate would
-- flag it as drift, because schema.prisma has no syntax for a WHERE clause.

-- CreateTable
CREATE TABLE IF NOT EXISTS "mail_log" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailClass" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "toAddress" TEXT NOT NULL,
    "toAddressNorm" TEXT NOT NULL,
    "leadId" TEXT,
    "fromAddress" TEXT NOT NULL,
    "replyTo" TEXT,
    "transport" TEXT NOT NULL,
    "channelId" TEXT,
    "subject" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "softBounces" INTEGER NOT NULL DEFAULT 0,
    "bouncedAt" TIMESTAMP(3),
    "complainedAt" TIMESTAMP(3),
    "campaignRecipientId" TEXT,
    "workflowRunId" TEXT,
    "conversationMessageId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mail_log_workspaceId_createdAt_idx" ON "mail_log"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mail_log_workspaceId_messageId_idx" ON "mail_log"("workspaceId", "messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mail_log_workspaceId_toAddressNorm_createdAt_idx" ON "mail_log"("workspaceId", "toAddressNorm", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mail_log_workspaceId_idempotencyKey_key" ON "mail_log"("workspaceId", "idempotencyKey");
