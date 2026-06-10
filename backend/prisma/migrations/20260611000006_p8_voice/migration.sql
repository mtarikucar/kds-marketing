-- P8: Voice AI (Twilio). Additive (two new tables).

CREATE TABLE "voice_calls" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "leadId" TEXT,
    "externalCallId" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "turns" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_calls_externalCallId_key" ON "voice_calls"("externalCallId");
CREATE INDEX "voice_calls_workspaceId_createdAt_idx" ON "voice_calls"("workspaceId", "createdAt");

CREATE TABLE "voice_transcripts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voice_transcripts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voice_transcripts_callId_idx" ON "voice_transcripts"("callId");
