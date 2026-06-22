-- Epic 7b: multi-step funnels (GoHighLevel parity). New table only — additive,
-- safe to deploy ahead of the code on the single replica.
CREATE TABLE "funnels" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "steps"       JSONB NOT NULL,
  "published"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "funnels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "funnels_workspaceId_slug_key" ON "funnels"("workspaceId", "slug");
CREATE INDEX "funnels_workspaceId_idx" ON "funnels"("workspaceId");
