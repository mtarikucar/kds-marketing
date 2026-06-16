-- Migration: configurable IVR / phone-tree menus (GoHighLevel parity).
--
-- Additive only: two new tables that sit IN FRONT OF the existing Twilio Voice-AI
-- flow. `ivr_menus` is a workspace-OWNED multi-level call menu (`workspaceId`
-- carries the same scoping invariant as every other owned delegate). When a
-- workspace has an ENABLED `isRoot` menu, inbound calls are answered with its
-- <Gather numDigits=1> keypad; otherwise the call falls through to the existing
-- AI receptionist unchanged. `ivr_options` are the keypad keys (digit UNIQUE
-- within a menu); an option's `action` decides what the digit does. The only FK
-- is option->menu (ON DELETE CASCADE so deleting a menu drops its keys); the
-- workspace relationship is bounded by the service layer's workspaceId scoping,
-- matching this schema's soft-reference style (no FK to `workspaces`).

CREATE TABLE "ivr_menus" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "greeting"    TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "isRoot"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ivr_menus_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ivr_menus_workspaceId_idx" ON "ivr_menus" ("workspaceId");
CREATE INDEX "ivr_menus_workspaceId_isRoot_enabled_idx" ON "ivr_menus" ("workspaceId", "isRoot", "enabled");

CREATE TABLE "ivr_options" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "menuId"       TEXT NOT NULL,
  "digit"        TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "action"       TEXT NOT NULL,
  "targetMenuId" TEXT,
  "dialNumber"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ivr_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ivr_options_menuId_digit_key" ON "ivr_options" ("menuId", "digit");
CREATE INDEX "ivr_options_workspaceId_idx" ON "ivr_options" ("workspaceId");

ALTER TABLE "ivr_options"
  ADD CONSTRAINT "ivr_options_menuId_fkey"
  FOREIGN KEY ("menuId") REFERENCES "ivr_menus" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
