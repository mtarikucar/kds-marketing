-- Aggregate booleans only: no account identifiers, tenant names, content or credentials.
WITH ready AS (
  SELECT w.id,s.id AS strategy_id FROM workspaces w
  JOIN strategy_versions s ON s.workspace_id=w.id AND s.status='approved'
  WHERE w.status='active' AND EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=w.id AND m.status='active'
  )
)
SELECT json_build_object(
  'accounts_exist',EXISTS(SELECT 1 FROM users),
  'active_account_with_approved_strategy_exists',EXISTS(SELECT 1 FROM ready),
  'ready_workspace_has_active_hypotheses',EXISTS(
    SELECT 1 FROM ready r JOIN strategy_hypotheses h ON h.version_id=r.strategy_id WHERE h.state<>'retired'
  ),
  'ready_workspace_has_example_records',EXISTS(
    SELECT 1 FROM ready r WHERE EXISTS(SELECT 1 FROM people p WHERE p.workspace_id=r.id)
      OR EXISTS(SELECT 1 FROM conversations c WHERE c.workspace_id=r.id)
      OR EXISTS(SELECT 1 FROM studio_materials m WHERE m.workspace_id=r.id)
  )
);
