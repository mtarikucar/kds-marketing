#!/usr/bin/env bash
# Synthetic acceptance probes, not the application's scheduler or canary decryptor.
set -euo pipefail
sql() { psql -XAt --set=ON_ERROR_STOP=1 -c "$1"; }
case "$1" in
  prepare)
    sql "CREATE ROLE recovery_app NOSUPERUSER NOBYPASSRLS NOLOGIN" ;;
  verify)
    sql 'GRANT USAGE ON SCHEMA public TO recovery_app; GRANT SELECT ON ALL TABLES IN SCHEMA public TO recovery_app'
    [[ $(sql "SELECT count(*) FROM pg_roles WHERE rolname='recovery_app' AND NOT rolsuper AND NOT rolbypassrls") == 1 ]]
    [[ $(sql "SELECT count(*) FROM pg_class WHERE relname IN ('workspaces','payment_notifications','workspace_entitlements','ledger_entries') AND relrowsecurity AND relforcerowsecurity") == 4 ]]
    for tenant in 1 2; do
      result=$(sql "SET ROLE recovery_app; SET app.workspace_id='00000000-0000-0000-0000-00000000000$tenant'; SELECT count(*) FROM workspaces;")
      [[ ${result##*$'\n'} == 1 ]]
    done
    [[ $(sql "SET ROLE recovery_app; SET app.workspace_id='00000000-0000-0000-0000-000000000001'; SELECT count(*) FROM payment_notifications p JOIN workspace_entitlements e ON e.payment_id=p.id JOIN ledger_entries l ON l.workspace_id=p.workspace_id WHERE e.activated_at IS NOT NULL AND l.action='recovery.synthetic';" | tail -1) == 1 ]]
    [[ $(sql "SET ROLE recovery_app; SET app.workspace_id='00000000-0000-0000-0000-000000000002'; SELECT count(*) FROM payment_notifications;" | tail -1) == 0 ]]
    [[ $(sql "SELECT status FROM workspaces WHERE slug='recovery-a'") == active ]]
    [[ $(sql "SELECT state || ':' || attempts FROM recovery_fixture.outbox WHERE id=1") == unknown:1 ]]
    [[ $(sql 'SELECT count(*) FROM recovery_fixture.files') == 1 ]]
    while IFS='|' read -r file digest; do
      [[ "$file" =~ ^[a-zA-Z0-9_-]+$ ]]
      [[ $(sha256sum "$JEETA_DRILL_FILES_DIR/$file" | cut -d' ' -f1) == "$digest" ]]
    done < <(sql 'SELECT path,sha256 FROM recovery_fixture.files')
    ;;
  verify_pitr)
    [[ $(sql "SELECT string_agg(label,',' ORDER BY label) FROM recovery_fixture.timeline") == before ]]
    ;;
  *) exit 1;;
esac
