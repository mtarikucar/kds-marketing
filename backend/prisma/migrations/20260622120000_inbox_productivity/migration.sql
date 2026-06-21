-- Migration: Inbox productivity (GoHighLevel parity)
--
-- Canned-response snippets, internal conversation notes (a separate table so
-- they can never reach a channel send egress), and a soft-delete column on
-- leads for bulk delete. Additive + nullable only — safe online migration.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "message_snippets" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerId"     TEXT,
    "shortcut"    TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "body"        TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_snippets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_notes" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorId"       TEXT NOT NULL,
    "body"           TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_snippets_workspaceId_shortcut_key" ON "message_snippets"("workspaceId", "shortcut");
CREATE INDEX "message_snippets_workspaceId_idx" ON "message_snippets"("workspaceId");
CREATE INDEX "conversation_notes_workspaceId_conversationId_createdAt_idx" ON "conversation_notes"("workspaceId", "conversationId", "createdAt");
