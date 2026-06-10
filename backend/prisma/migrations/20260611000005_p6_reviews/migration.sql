-- P6: reviews / reputation. Additive (two new tables).

CREATE TABLE "review_sources" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GOOGLE',
    "name" TEXT NOT NULL,
    "placeUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "review_sources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "review_sources_workspaceId_idx" ON "review_sources"("workspaceId");

CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT,
    "leadId" TEXT,
    "rating" INTEGER,
    "text" TEXT,
    "authorName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "replyDraft" TEXT,
    "replyText" TEXT,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reviews_token_key" ON "reviews"("token");
CREATE INDEX "reviews_workspaceId_status_idx" ON "reviews"("workspaceId", "status");
