-- Faz 4 trend->remix: abstract format intelligence (hook/scene/pacing/caption
-- patterns + risk score), NOT a copy of the source video.

-- CreateTable
CREATE TABLE "trend_templates" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourcePlatform" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT,
    "hookPattern" TEXT,
    "sceneStructure" JSONB,
    "pacingNote" TEXT,
    "captionPattern" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "extractedByAi" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trend_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trend_templates_workspaceId_status_idx" ON "trend_templates"("workspaceId", "status");

