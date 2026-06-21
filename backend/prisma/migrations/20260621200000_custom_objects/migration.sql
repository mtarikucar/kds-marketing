-- Migration: Custom Objects (GoHighLevel parity)
--
-- A workspace defines its own record types (custom objects) beyond the built-in
-- Contact. Object FIELDS reuse custom_field_defs namespaced by entity='OBJ:<key>'
-- (no schema change there). Records hold validated values in JSONB; links
-- associate a record with a Contact (soft ref to leads). New tables only —
-- purely additive, safe online migration.

-- CreateTable
CREATE TABLE "custom_object_defs" (
    "id"            TEXT NOT NULL,
    "workspaceId"   TEXT NOT NULL,
    "key"           TEXT NOT NULL,
    "labelSingular" TEXT NOT NULL,
    "labelPlural"   TEXT NOT NULL,
    "primaryField"  TEXT NOT NULL DEFAULT 'name',
    "description"   TEXT,
    "icon"          TEXT,
    "archived"      BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_object_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_object_records" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectDefId" TEXT NOT NULL,
    "values"      JSONB NOT NULL DEFAULT '{}',
    "displayName" TEXT NOT NULL DEFAULT '',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_object_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_object_links" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "recordId"    TEXT NOT NULL,
    "leadId"      TEXT NOT NULL,
    "label"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_object_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_object_defs_workspaceId_key_key" ON "custom_object_defs"("workspaceId", "key");
CREATE INDEX "custom_object_defs_workspaceId_archived_idx" ON "custom_object_defs"("workspaceId", "archived");

CREATE INDEX "custom_object_records_workspaceId_objectDefId_idx" ON "custom_object_records"("workspaceId", "objectDefId");
CREATE INDEX "custom_object_records_workspaceId_objectDefId_displayName_idx" ON "custom_object_records"("workspaceId", "objectDefId", "displayName");

CREATE UNIQUE INDEX "custom_object_links_recordId_leadId_key" ON "custom_object_links"("recordId", "leadId");
CREATE INDEX "custom_object_links_workspaceId_leadId_idx" ON "custom_object_links"("workspaceId", "leadId");
CREATE INDEX "custom_object_links_workspaceId_recordId_idx" ON "custom_object_links"("workspaceId", "recordId");

-- AddForeignKey
ALTER TABLE "custom_object_records" ADD CONSTRAINT "custom_object_records_objectDefId_fkey" FOREIGN KEY ("objectDefId") REFERENCES "custom_object_defs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custom_object_links" ADD CONSTRAINT "custom_object_links_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "custom_object_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
