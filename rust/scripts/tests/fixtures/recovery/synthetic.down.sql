BEGIN;
-- Disposable fixture teardown bypasses the real append-only ledger trigger only
-- within this transaction; fixed synthetic rows only. Never a production migration.
SET LOCAL session_replication_role = replica;
-- Tightly scoped fixed synthetic IDs; never used on a runtime database.
DROP TABLE IF EXISTS recovery_fixture.files;
DROP TABLE IF EXISTS recovery_fixture.outbox;
DROP TABLE IF EXISTS recovery_fixture.timeline;
DROP SCHEMA IF EXISTS recovery_fixture;
DELETE FROM ledger_entries WHERE workspace_id='00000000-0000-0000-0000-000000000001' AND action='recovery.synthetic';
DELETE FROM workspace_entitlements WHERE id='00000000-0000-0000-0000-000000000006';
DELETE FROM payment_notifications WHERE id='00000000-0000-0000-0000-000000000005';
DELETE FROM platform_operators WHERE id='00000000-0000-0000-0000-000000000004';
DELETE FROM users WHERE id='00000000-0000-0000-0000-000000000003';
DELETE FROM workspaces WHERE id IN ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
COMMIT;
