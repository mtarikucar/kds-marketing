-- Content-pack routine (#2): opt-in content profiles + draft output.
-- Additive only; no changes to existing tables.

-- CreateTable
CREATE TABLE "content_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "themes" TEXT NOT NULL,
    "voice" TEXT,
    "counts" JSONB NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "lastRunAt" TIMESTAMP(3),
    "lastRunStats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_drafts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contentProfileId" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_profiles_workspaceId_status_idx" ON "content_profiles"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "content_drafts_workspaceId_status_idx" ON "content_drafts"("workspaceId", "status");
