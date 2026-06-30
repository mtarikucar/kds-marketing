-- CreateTable
CREATE TABLE "call_analyses" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "salesCallId" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "language" TEXT,
    "summary" TEXT NOT NULL,
    "sentiment" TEXT,
    "score" INTEGER,
    "actionItems" JSONB,
    "topics" JSONB,
    "sttProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_analyses_salesCallId_key" ON "call_analyses"("salesCallId");

-- CreateIndex
CREATE INDEX "call_analyses_workspaceId_createdAt_idx" ON "call_analyses"("workspaceId", "createdAt");
