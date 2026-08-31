-- The research lane gains a third, DEFAULT state: AUTO.
--
-- WHY A THIRD STATE. v2.286.0 shipped SERVER|MCP with SERVER as the default,
-- and nobody turned MCP on — so the feature that moves 86% of the platform's
-- model bill saved nothing. The owner's instruction is to default to MCP when a
-- Claude is actually connected. That needs a value meaning "nobody has decided,
-- go and look", because an explicit SERVER and an untouched SERVER are the same
-- string and must stop being the same decision.
--
-- WHY THE BACKFILL IS SAFE. Every existing 'SERVER' row is this column's own
-- migration default (20260831120000, shipped hours ago) rather than anyone's
-- choice, so flipping them to AUTO restores the intent that the column had no
-- decision in it yet. And being wrong now costs at most
-- RESEARCH_MCP_GRACE_HOURS of latency on a night's research, never a lost run:
-- under AUTO/MCP the platform takes the job back after the grace window and
-- says so on the panel. That bounded cost is the entire reason auto-defaulting
-- is permissible at all -- without the fallback shipped alongside it, this
-- backfill would be the silent-stop bug applied to every workspace at once.
--
-- Rows explicitly at 'MCP' are LEFT ALONE: that value can only have been
-- written by an owner deliberately flipping the switch, and it still wins.
--
-- Idempotent: re-running matches nothing the second time.
ALTER TABLE "workspaces"
  ALTER COLUMN "researchExecution" SET DEFAULT 'AUTO';

UPDATE "workspaces"
   SET "researchExecution" = 'AUTO'
 WHERE "researchExecution" = 'SERVER';

-- The auto-detection asks: "has an MCP tool call happened in this workspace
-- lately?" That is an `agent_runs` row with agent = 'mcp'. Two code paths write
-- it, and both are a Claude: McpInvokerService opens exactly one per tool call
-- (on BOTH the api-key and the OAuth paths), and McpApprovalExecutorService
-- opens one per approval a human releases. The second cannot make a workspace
-- look connected on its own — an approval only exists because a tool call
-- created it, that call already wrote its own row, and the approval TTL (24h)
-- is far inside the 14-day window this reads over. A THIRD writer would move
-- workspaces into the MCP lane silently; src/modules/marketing/research/
-- research-connection-signal.tripwire.spec.ts turns adding one into a red
-- build. The read runs inside the once-a-minute
-- scheduled-job claim, so it must be an index probe rather than a scan.
--
-- `agent_runs_workspaceId_agent_startedAt_idx` already exists (schema.prisma,
-- AgentRun @@index([workspaceId, agent, startedAt])) and is an exact prefix
-- match for `workspaceId = ? AND agent = 'mcp' AND startedAt > ?`. No new index
-- is created here; this comment exists so the next reader does not add one.
