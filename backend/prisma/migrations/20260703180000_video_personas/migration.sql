-- Faz 2 AI video: reusable UGC persona (reference images + locked seed) for
-- identity-consistent multi-shot video (Seedance @reference / Higgsfield Soul ID).

-- CreateTable
CREATE TABLE "video_personas" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "referenceImageUrls" TEXT[],
    "lockedSeed" INTEGER,
    "voiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_personas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_personas_workspaceId_status_idx" ON "video_personas"("workspaceId", "status");

