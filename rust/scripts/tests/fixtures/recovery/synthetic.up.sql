-- Disposable, synthetic-only drill probes; actual application migrations run first.
CREATE SCHEMA IF NOT EXISTS recovery_fixture;
CREATE TABLE IF NOT EXISTS recovery_fixture.files (workspace_id uuid, path text PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_fixture.outbox (id integer PRIMARY KEY, state text NOT NULL, attempts integer NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_fixture.timeline (label text PRIMARY KEY);
INSERT INTO recovery_fixture.outbox VALUES (1, 'unknown', 1) ON CONFLICT DO NOTHING;
INSERT INTO workspaces(id,name,slug,status) VALUES
 ('00000000-0000-0000-0000-000000000001','Synthetic A','recovery-a','active'),
 ('00000000-0000-0000-0000-000000000002','Synthetic B','recovery-b','pending_payment') ON CONFLICT DO NOTHING;
INSERT INTO users(id,email,password_hash,display_name) VALUES
 ('00000000-0000-0000-0000-000000000003','fixture@example.invalid','not-a-real-hash','Fixture') ON CONFLICT DO NOTHING;
INSERT INTO platform_operators(id,email,password_hash) VALUES
 ('00000000-0000-0000-0000-000000000004','operator@example.invalid','not-a-real-hash') ON CONFLICT DO NOTHING;
INSERT INTO payment_notifications VALUES
 ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','\x00','synthetic',100,'TRY',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO workspace_entitlements(id,workspace_id,source,payment_id,confirmed_by,confirmed_at,activated_at,redeemed_by) VALUES
 ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','paid','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000004',now(),now(),'00000000-0000-0000-0000-000000000003') ON CONFLICT DO NOTHING;
INSERT INTO ledger_entries(workspace_id,at,actor_kind,action,payload)
 SELECT '00000000-0000-0000-0000-000000000001',now(),'system','recovery.synthetic','{}'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_entries WHERE action='recovery.synthetic');
