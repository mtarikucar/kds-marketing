-- Suppression at the level of an ADDRESS, not a lead row.
-- A person on file twice unsubscribes once: today only the row they clicked
-- stops being mailed, and the next campaign reaches them through the other one.
-- Per-workspace on purpose — a global row would block tenant B from mailing
-- their own consented customer and leak that the address exists elsewhere.
-- `hash` is an HMAC of the normalized value, so an erased subject leaves no
-- readable address behind, and `reason` is part of the unique key: without it
-- an ERASURE tombstone and a HARD_BOUNCE for the same address collide and the
-- KVKK tombstone is the one that loses.

-- CreateTable
CREATE TABLE IF NOT EXISTS "contact_suppressions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT,
    "note" TEXT,
    "liftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "contact_suppressions_workspaceId_kind_hash_idx" ON "contact_suppressions"("workspaceId", "kind", "hash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "contact_suppressions_workspaceId_kind_hash_reason_key" ON "contact_suppressions"("workspaceId", "kind", "hash", "reason");
