-- Rollback for 20260703150000_agent_observability_approvals.
DROP TABLE IF EXISTS "tool_call_logs";
DROP TABLE IF EXISTS "approval_requests";
DROP TABLE IF EXISTS "agent_runs";
