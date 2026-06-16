-- Migration: custom field definitions + leads.customFields (Epic A1)

CREATE TABLE "custom_field_defs" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "entity"      TEXT NOT NULL DEFAULT 'LEAD',
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "options"     JSONB,
  "required"    BOOLEAN NOT NULL DEFAULT false,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "archived"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_field_defs_workspaceId_entity_key_key"
  ON "custom_field_defs" ("workspaceId", "entity", "key");

CREATE INDEX "custom_field_defs_workspaceId_entity_archived_idx"
  ON "custom_field_defs" ("workspaceId", "entity", "archived");

-- Lead custom-field values (JSONB). Default GIN (jsonb_ops) accelerates the
-- containment/key-existence predicates used by segment/audience filtering.
-- (jsonb_ops, not jsonb_path_ops: the latter isn't round-tripped by Prisma's
-- introspection so it permanently fails the migrations↔schema parity gate, and
-- jsonb_ops also supports the ?/?&/?| operators the segment compiler may use.)
ALTER TABLE "leads" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "leads_customFields_gin" ON "leads" USING GIN ("customFields");
