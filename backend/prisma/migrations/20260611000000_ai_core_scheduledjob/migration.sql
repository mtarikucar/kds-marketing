-- P1: AI core + ScheduledJob primitive. All additive (new tables + one
-- nullable Package.limits column). The only non-trivial DDL — the
-- KnowledgeDoc tsvector trigger + GIN index — is isolated here for easy
-- revert.

-- Package.limits (numeric entitlement limits beyond the legacy 3 columns)
ALTER TABLE "packages" ADD COLUMN "limits" JSONB;

-- ScheduledJob
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "scheduled_jobs_status_runAt_idx" ON "scheduled_jobs"("status", "runAt");
CREATE INDEX "scheduled_jobs_workspaceId_kind_idx" ON "scheduled_jobs"("workspaceId", "kind");
-- Rescheduling collapses onto the same PENDING row (Prisma can't express a
-- partial unique — same technique as commissions_sourcePaymentId).
CREATE UNIQUE INDEX "scheduled_jobs_pending_dedup"
  ON "scheduled_jobs"("kind", "dedupKey")
  WHERE "status" = 'PENDING' AND "dedupKey" IS NOT NULL;

-- KnowledgeDoc (+ FTS)
CREATE TABLE "knowledge_docs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "language" TEXT NOT NULL DEFAULT 'tr',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "knowledge_docs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "knowledge_docs_workspaceId_status_idx" ON "knowledge_docs"("workspaceId", "status");
CREATE INDEX "knowledge_docs_searchVector_idx" ON "knowledge_docs" USING GIN ("searchVector");

-- regconfig is chosen from a CASE whitelist (NEVER interpolated from the
-- row's language value) so it can't be turned into an injection vector.
CREATE OR REPLACE FUNCTION knowledge_docs_tsv_update() RETURNS trigger AS $$
DECLARE cfg regconfig;
BEGIN
  cfg := CASE NEW."language"
           WHEN 'tr' THEN 'turkish'::regconfig
           WHEN 'en' THEN 'english'::regconfig
           WHEN 'ru' THEN 'russian'::regconfig
           ELSE 'simple'::regconfig
         END;
  NEW."searchVector" :=
    setweight(to_tsvector(cfg, coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector(cfg, coalesce(NEW."content", '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_docs_tsv_trigger
  BEFORE INSERT OR UPDATE OF "title", "content", "language" ON "knowledge_docs"
  FOR EACH ROW EXECUTE FUNCTION knowledge_docs_tsv_update();

-- AgentProfile
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "persona" TEXT NOT NULL,
    "tone" TEXT,
    "goals" TEXT,
    "guardrails" TEXT,
    "language" TEXT NOT NULL DEFAULT 'tr',
    "channels" JSONB,
    "kbDocIds" JSONB,
    "captureFields" JSONB,
    "handoffRules" JSONB,
    "followup" JSONB,
    "bookingCalendarId" TEXT,
    "maxRepliesPerConvoDaily" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_profiles_workspaceId_status_idx" ON "agent_profiles"("workspaceId", "status");
