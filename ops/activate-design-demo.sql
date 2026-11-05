-- Explicitly requested staging demo activation; only the newly registered workspace.
BEGIN;
SET LOCAL statement_timeout='10s';
DO $$
DECLARE
  ws constant uuid := '01a1ac18-5e12-7217-8b7c-6e145e599b3c';
  usr constant uuid := '01a1ac18-5e11-73c4-8a0a-22eaf8d0be8c';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
    JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
    WHERE w.id=ws AND u.id=usr AND u.email='tasarim-demo-1105@staging.example.test'
      AND w.name='Jeeta Tasarım Demo' AND m.status='active' AND r.key='owner'
  ) THEN RAISE EXCEPTION 'New demo workspace identity mismatch'; END IF;
  PERFORM 1 FROM workspaces WHERE id=ws FOR UPDATE;
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=ws AND status='active') THEN
    RAISE NOTICE 'Demo already activated'; RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=ws AND status='pending_payment') THEN
    RAISE EXCEPTION 'Unexpected workspace status';
  END IF;
  INSERT INTO workspace_entitlements(id,workspace_id,source,confirmed_at,activated_at,redeemed_by)
    VALUES(gen_random_uuid(),ws,'grandfathered',now(),now(),usr);
  UPDATE workspaces SET status='active' WHERE id=ws;
  INSERT INTO ledger_entries(workspace_id,at,actor_kind,actor_component,action,subject_kind,subject_id,payload)
    VALUES(ws,now(),'system','staging-demo-setup','workspace.demo_activated','workspace',ws::text,
      '{"reason":"User requested an active staging demo account with approved example strategy","environment":"staging","payment_collected":false}'::jsonb);
END $$;
COMMIT;
SELECT 'Requested staging demo activation complete';
