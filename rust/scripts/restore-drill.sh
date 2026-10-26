#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/backup.sh" --library
[[ $# == 2 ]] || fail 'usage: restore-drill.sh <recovery-set> <isolated-target-config>'
started=$(date +%s)
recovery=$(realpath "$1")
read_config "$2"
required JEETA_TARGET_DIR JEETA_TARGET_ID JEETA_RELEASE_DIR JEETA_MASTER_KEY_FILE JEETA_MASTER_KEY_ID JEETA_PUBLIC_ORIGIN JEETA_INTEGRITY_HOOK JEETA_SEALED_CANARY_CHECK_HOOK
[[ "${JEETA_DISPOSABLE:-}" == yes && "${JEETA_JOBS_ENABLED:-}" == false ]] || fail 'disposable target with jobs disabled required'
# A private network namespace (docker --network none or unshare --net) is mandatory.
# No application process is launched, and PostgreSQL listens only on a private socket.
interfaces=$(awk -F: 'NR>2 { gsub(/[[:space:]]/, "", $1); print $1 }' /proc/self/net/dev) || fail 'cannot inspect network namespace'
[[ "$interfaces" == lo ]] || fail 'network isolation required'
[[ "$JEETA_PUBLIC_ORIGIN" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$ ]] || fail 'production public origin refused'
verify_set "$recovery"; read_manifest "$recovery"
[[ -f "$recovery/COMPLETE" && ! -e "$recovery/FAILED" ]] || fail 'backup is not complete'
[[ "$JEETA_TARGET_ID" != "${manifest[source_id]}" ]] || fail 'source/target collision'
target=$(realpath -m "$JEETA_TARGET_DIR")
[[ "$target" != / && "$target/" != "$recovery/"* && "$recovery/" != "$target/"* ]] || fail 'source/target path collision'
[[ ! -e "$target" || ( -d "$target" && -z "$(find "$target" -mindepth 1 -print -quit)" ) ]] || fail 'nonempty target refused'
[[ "$(cat "$JEETA_RELEASE_DIR/REVISION")" == "${manifest[source_revision]}" ]] || fail 'release revision mismatch'
release_inventory "$JEETA_RELEASE_DIR" | cmp -s "$recovery/migrations.sha256" - || fail 'migration checksums mismatch'
release_versions "$JEETA_RELEASE_DIR" | cmp -s "$recovery/schema.versions" - || fail 'schema versions mismatch'
[[ -s "$recovery/database.settings" && $(wc -l < "$recovery/database.settings") == 1 ]] || fail 'database settings missing'
IFS='|' read -r db_encoding db_provider db_collate db_ctype db_icu db_collation_version db_actual_version < "$recovery/database.settings"
[[ "$db_encoding" =~ ^[A-Z0-9_]+$ && -n "$db_collate" && -n "$db_ctype" ]] || fail 'invalid database settings'
case "$db_provider" in c) locale_provider=libc;; i) locale_provider=icu;; *) fail 'unsupported locale provider';; esac
private_file "$JEETA_MASTER_KEY_FILE"
[[ "$JEETA_MASTER_KEY_ID" == "${manifest[master_key_id]}" && -s "$JEETA_MASTER_KEY_FILE" ]] || fail 'matching master key required'
private_file "$JEETA_INTEGRITY_HOOK"; private_file "$JEETA_SEALED_CANARY_CHECK_HOOK"
[[ "$EUID" != 0 ]] || fail 'run drill as an unprivileged disposable-cluster owner'
mkdir -p "$target"; target=$(realpath "$target")
export JEETA_DRILL_FILES_DIR="$target/files" JEETA_DRILL_SOCKET_DIR="$target/socket"
for variable in ${!PG@}; do unset "$variable"; done
export PGHOST="$JEETA_DRILL_SOCKET_DIR" PGPORT=5432 PGUSER="${JEETA_RESTORE_ROLE:-$(id -un)}" PGDATABASE=jeeta
mkdir -p "$PGHOST"
file_source="$recovery/files"
if [[ ${manifest[kind]} == physical && -n ${JEETA_PITR_FILES_DIR:-} ]]; then
  safe_tree "$JEETA_PITR_FILES_DIR"
  [[ -s "$JEETA_PITR_FILES_DIR/SHA256SUMS" ]] || fail 'supplemental file inventory missing'
  inventory "$JEETA_PITR_FILES_DIR" | cmp -s "$JEETA_PITR_FILES_DIR/SHA256SUMS" - || fail 'supplemental file checksum mismatch'
  [[ -d "$JEETA_PITR_FILES_DIR/files" ]] || fail 'supplemental files missing'
  file_source="$JEETA_PITR_FILES_DIR/files"
fi
cp -a "$file_source" "$target/files"
running=0
finish() {
  local rc=$?
  if ((running)); then pg_ctl -D "$target/db" -m immediate -w stop >>"$target/postgres.log" 2>&1 || rc=1; fi
  if ((rc)); then printf 'integrity=failed\n' > "$target/FAILED"; printf 'recovery: drill failed; private diagnostics retained\n' >&2; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
wal_target=none
recovered_at=${manifest[started_at]}
if [[ ${manifest[kind]} == logical ]]; then
  initdb -D "$target/db" -A trust --no-locale --encoding=UTF8 >"$target/postgres.log" 2>&1
else
  required JEETA_WAL_DIR JEETA_WAL_TARGET_NAME JEETA_WAL_TARGET_TIME
  [[ "$JEETA_WAL_TARGET_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'invalid WAL target'
  [[ "$JEETA_WAL_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'unsafe WAL directory'
  safe_tree "$JEETA_WAL_DIR"
  [[ -s "$JEETA_WAL_DIR/SHA256SUMS" ]] || fail 'verified WAL snapshot required'
  inventory "$JEETA_WAL_DIR" | cmp -s "$JEETA_WAL_DIR/SHA256SUMS" - || fail 'WAL checksums mismatch'
  pg_verifybackup "$recovery/base" >"$target/postgres.log" 2>&1
  cp -a "$recovery/base" "$target/db"
  rm -f "$target/db/postmaster.pid" "$target/db/standby.signal"
  : > "$target/db/recovery.signal"
  wal_target=$JEETA_WAL_TARGET_NAME; recovered_at=$JEETA_WAL_TARGET_TIME
fi
# Discard source configuration and all includes/archive hooks before any start.
: > "$target/db/postgresql.auto.conf"
printf 'local all all trust\n' > "$target/db/pg_hba.conf"
[[ "$target" =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'unsafe target path'
cat > "$target/db/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$PGHOST'
port = 5432
archive_mode = off
ssl = off
shared_preload_libraries = ''
CONF
if [[ ${manifest[kind]} == physical ]]; then
  # These five control-data values are recovery minimums. Never copy arbitrary
  # source configuration/includes or executable settings into the target.
  LC_ALL=C pg_controldata "$recovery/base" > "$target/control.txt"
  for mapping in max_connections:max_connections max_worker_processes:max_worker_processes max_wal_senders:max_wal_senders max_prepared_xacts:max_prepared_transactions max_locks_per_xact:max_locks_per_transaction; do
    field=${mapping%%:*}; setting=${mapping#*:}
    value=$(awk -F: -v field="$field setting" '$1 == field { gsub(/[[:space:]]/, "", $2); print $2 }' "$target/control.txt")
    [[ "$value" =~ ^[0-9]+$ ]] || fail 'invalid recovery capacity control data'
    printf '%s = %s\n' "$setting" "$value" >> "$target/db/postgresql.conf"
  done
  cat >> "$target/db/postgresql.conf" <<CONF
restore_command = 'cp $JEETA_WAL_DIR/%f %p'
recovery_target_name = '$JEETA_WAL_TARGET_NAME'
recovery_target_action = 'promote'
CONF
fi
running=1
pg_ctl -D "$target/db" -l "$target/postgres.log" -w -t 60 start >>"$target/postgres.log" 2>&1
if [[ ${manifest[kind]} == logical ]]; then
  locale_args=(--template=template0 --encoding="$db_encoding" --locale-provider="$locale_provider" --lc-collate="$db_collate" --lc-ctype="$db_ctype")
  if [[ "$db_provider" == i ]]; then locale_args+=(--icu-locale="$db_icu"); fi
  createdb "${locale_args[@]}" jeeta >>"$target/postgres.log" 2>&1
  # Required roles are provisioned by this release-specific hook before restore.
  hook "$JEETA_INTEGRITY_HOOK" prepare
  pg_restore --exit-on-error --no-owner --dbname=jeeta "$recovery/database.dump" >>"$target/postgres.log" 2>&1
else
  for ((i=0; i<60; i++)); do
    [[ "$(psql -XAt -c 'SELECT pg_is_in_recovery()' 2>/dev/null || true)" == f ]] && break
    sleep 1
  done
  [[ "$(psql -XAt -c 'SELECT pg_is_in_recovery()')" == f ]] || fail 'PITR target not reached'
  recovered_at=$(psql -XAt -c 'SELECT pg_last_xact_replay_timestamp()')
  [[ -n "$recovered_at" ]] || fail 'missing replay timestamp'
  (( $(date -u -d "$JEETA_WAL_TARGET_TIME" +%s) >= $(date -u -d "$recovered_at" +%s) )) || fail 'replay exceeded declared target time'
fi
db_settings dbname=jeeta > "$target/database.settings" 2>>"$target/postgres.log"
cmp -s "$target/database.settings" "$recovery/database.settings" || fail 'restored encoding/locale/collation version mismatch'
db_versions dbname=jeeta > "$target/database.versions" 2>>"$target/postgres.log"
cmp -s "$target/database.versions" "$recovery/schema.versions" || fail 'restored schema mismatch'
hook "$JEETA_INTEGRITY_HOOK" verify
# T071 supplies real binary decryption equality. Output is ALWAYS suppressed.
hook "$JEETA_SEALED_CANARY_CHECK_HOOK" verify
# Compare actual restored files, including missing/extra files.
inventory "$target/files" data | cmp -s <(inventory "$file_source" data) - || fail 'restored files changed'
if [[ ${manifest[kind]} == physical ]]; then hook "$JEETA_INTEGRITY_HOOK" verify_pitr; fi
pg_ctl -D "$target/db" -m fast -w stop >>"$target/postgres.log" 2>&1
running=0
elapsed=$(( $(date +%s) - started ))
loss=$(( started - $(date -u -d "$recovered_at" +%s) ))
(( loss >= 0 && loss <= 86400 && elapsed <= 3600 )) || fail 'RPO/RTO exceeded or recovery time is in the future'
printf 'source_revision=%s\nbackup_time=%s\nwal_target=%s\nintegrity=passed\nkey_check=external_hook_passed\nelapsed_seconds=%s\ndata_loss_seconds=%s\nrpo_seconds=86400\nrto_seconds=3600\njobs_enabled=false\n' \
  "${manifest[source_revision]}" "${manifest[completed_at]}" "$wal_target" "$elapsed" "$loss" > "$target/report"
cat "$target/report"
