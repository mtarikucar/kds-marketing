-- Per-workspace MCP write policy: APPROVAL (default — risky tools queue for
-- a human) or AUTONOMOUS (risky tools execute inline; audit logging still
-- mandatory). Additive; no changes to existing columns.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "mcpWriteMode" TEXT NOT NULL DEFAULT 'APPROVAL';
