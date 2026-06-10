-- P2: omnichannel conversations + Conversation AI. All additive (3 nullable-
-- with-default columns on leads + four new tables). No data backfill needed.

-- Lead per-channel marketing opt-out (campaigns + the AI engine honor these).
ALTER TABLE "leads" ADD COLUMN "emailOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN "smsOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN "waOptOut" BOOLEAN NOT NULL DEFAULT false;

-- Channel (connected messaging channels; secret creds AES-256-GCM sealed)
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "agentProfileId" TEXT,
    "widgetKey" TEXT,
    "externalId" TEXT,
    "configSealed" TEXT,
    "configPublic" JSONB,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "channels_widgetKey_key" ON "channels"("widgetKey");
CREATE INDEX "channels_workspaceId_type_idx" ON "channels"("workspaceId", "type");
CREATE INDEX "channels_workspaceId_status_idx" ON "channels"("workspaceId", "status");
CREATE INDEX "channels_type_externalId_idx" ON "channels"("type", "externalId");

-- ContactIdentity (channel identity → lead)
CREATE TABLE "contact_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "contact_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contact_identities_channelId_value_key" ON "contact_identities"("channelId", "value");
CREATE INDEX "contact_identities_workspaceId_idx" ON "contact_identities"("workspaceId");
CREATE INDEX "contact_identities_leadId_idx" ON "contact_identities"("leadId");

-- Conversation (thread + AI-control state + inbox view state)
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactIdentityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "aiPaused" BOOLEAN NOT NULL DEFAULT false,
    "assignedToId" TEXT,
    "subject" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "followupCount" INTEGER NOT NULL DEFAULT 0,
    "aiRepliesToday" INTEGER NOT NULL DEFAULT 0,
    "aiRepliesDayKey" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "conversations_workspaceId_status_lastMessageAt_idx" ON "conversations"("workspaceId", "status", "lastMessageAt");
CREATE INDEX "conversations_workspaceId_assignedToId_idx" ON "conversations"("workspaceId", "assignedToId");
CREATE INDEX "conversations_channelId_idx" ON "conversations"("channelId");
CREATE INDEX "conversations_leadId_idx" ON "conversations"("leadId");

-- Message (one message in a conversation; externalMessageId dedupes inbound)
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messages_externalMessageId_key" ON "messages"("externalMessageId");
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");
CREATE INDEX "messages_workspaceId_createdAt_idx" ON "messages"("workspaceId", "createdAt");
