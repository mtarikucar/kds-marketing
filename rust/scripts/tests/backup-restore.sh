#!/usr/bin/env bash
# Runs real scripts against disposable PostgreSQL; all records are synthetic.
set -euo pipefail
umask 077
scripts=$(cd "$(dirname "$0")/.." && pwd)
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
[[ -x "$scripts/backup.sh" && -x "$scripts/restore-drill.sh" ]] || fail 'real recovery scripts are missing'
# Prefer host PostgreSQL tools when available. A separate network namespace is
# mandatory on both paths; no connections to pre-existing services are possible.
if [[ ${JEETA_HARNESS_INNER:-} != yes ]]; then
  scratch=$(mktemp -d /tmp/jeeta-drill-XXXXXXXX)
  container=jeeta-drill-$(basename "$scratch")
  cleanup_outer() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
  trap cleanup_outer EXIT
  pg_bin=$(find /usr/lib/postgresql -path '*/bin/initdb' -print -quit 2>/dev/null || true)
  if [[ -n "$pg_bin" ]]; then export PATH="${pg_bin%/*}:$PATH"; fi
  if command -v pg_dump >/dev/null && command -v initdb >/dev/null && command -v pg_verifybackup >/dev/null && unshare -U --map-current-user -n true 2>/dev/null && ((EUID != 0)); then
    JEETA_HARNESS_INNER=yes JEETA_TEST_ROOT="$scratch" unshare -U --map-current-user -n bash "$0"
  elif command -v pg_dump >/dev/null && command -v initdb >/dev/null && ((EUID == 0)) && unshare -n true 2>/dev/null; then
    chown postgres "$scratch"
    unshare -n runuser -u postgres -- env PATH="$PATH" JEETA_HARNESS_INNER=yes JEETA_TEST_ROOT="$scratch" bash "$0"
  else
    # Work is a disposable bind mount, no anonymous/named PostgreSQL volumes.
    docker run --rm --name "$container" --network none --mount "type=bind,src=$scripts/../,dst=/src,readonly" \
      --mount "type=bind,src=$scratch,dst=/work" --env "JEETA_TEST_FILTER=${JEETA_TEST_FILTER:-}" --env "JEETA_OUTER_OWNER=$(id -u):$(id -g)" --entrypoint bash postgres:16 -c \
      'trap '"'"'chown -R "$JEETA_OUTER_OWNER" /work'"'"' EXIT; chown postgres:postgres /work; runuser -u postgres -- env JEETA_HARNESS_INNER=yes JEETA_TEST_ROOT=/work JEETA_TEST_FILTER="${JEETA_TEST_FILTER:-}" bash /src/scripts/tests/backup-restore.sh'
  fi
  exit 0
fi
work=$JEETA_TEST_ROOT
fixtures="$scripts/tests/fixtures/recovery"
mkdir -p "$work"/{source,socket,files,release,status,logical,base,wal,hooks}
cp -R "$scripts/../migrations" "$work/release/"
printf 'synthetic-release\n' > "$work/release/REVISION"
printf 'synthetic-file\n' > "$work/files/evidence"
printf 'synthetic-master-key\n' > "$work/key"
printf 'synthetic-master-key\n' > "$work/expected-key"
cp "$fixtures/integrity.sh" "$work/hooks/integrity"
cat > "$work/hooks/canary" <<'HOOK'
#!/usr/bin/env bash
# T071 replaces this synthetic key-equality check with real sealed-canary decryption.
set -euo pipefail
cmp -s "$JEETA_MASTER_KEY_FILE" "$JEETA_TEST_ROOT/expected-key"
HOOK
cat > "$work/hooks/control" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
w=$JEETA_TEST_ROOT
printf '%s\n' "$1" >> "$w/control.log"
case "$1" in
 block) touch "$w/blocked";;
 stop) touch "$w/stopped";;
 assert_quiesced) [[ -f "$w/blocked" && -f "$w/stopped" ]]; [[ ! -e "$w/inject-failure" ]];;
 start) rm "$w/stopped";;
 unblock) rm "$w/blocked"; if [[ -e "$w/inject-status-failure" ]]; then chmod 500 "$w/status"; fi;;
 *) exit 1;;
esac
HOOK
chmod 700 "$work/hooks/"*
initdb -D "$work/source" -A trust --no-locale --encoding=UTF8 > "$work/setup.log" 2>&1
cat >> "$work/source/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$work/socket'
wal_level = replica
archive_mode = on
archive_command = 'test ! -f $work/wal/%f && cp %p $work/wal/%f'
max_wal_senders = 12
max_connections = 150
max_worker_processes = 12
max_prepared_transactions = 8
max_locks_per_transaction = 100
CONF
source_running=1
cleanup_inner() { local rc=$?; if ((rc)); then tail -25 "$work/setup.log" >&2; fi; if ((source_running)); then pg_ctl -D "$work/source" -m immediate -w stop >> "$work/setup.log" 2>&1 || true; fi; }
trap cleanup_inner EXIT
pg_ctl -D "$work/source" -l "$work/source.log" -w start >> "$work/setup.log" 2>&1
export PGHOST="$work/socket" PGUSER="$(id -un)" PGDATABASE=jeeta
createdb --template=template0 --encoding=UTF8 --locale=C.utf8 jeeta
sql() { psql -XAt --set=ON_ERROR_STOP=1 -c "$1"; }
sql 'CREATE TABLE _sqlx_migrations(version bigint PRIMARY KEY,success boolean NOT NULL)' >> "$work/setup.log"
for migration in "$work/release/migrations/"*.up.sql; do
  psql -X --set=ON_ERROR_STOP=1 -f "$migration" >> "$work/setup.log" 2>&1
  ver=${migration##*/}; ver=${ver%%_*}
  sql "INSERT INTO _sqlx_migrations VALUES ($((10#$ver)),true)" >> "$work/setup.log"
done
# The synthetic up/down pair is checked up -> down -> down -> up.
for direction in up down down up; do
  psql -X --set=ON_ERROR_STOP=1 -f "$fixtures/synthetic.$direction.sql" >> "$work/setup.log" 2>&1
done
sql "CREATE ROLE recovery_app NOSUPERUSER NOBYPASSRLS NOLOGIN" >> "$work/setup.log"
digest=$(sha256sum "$work/files/evidence" | cut -d' ' -f1)
sql "INSERT INTO recovery_fixture.files VALUES ('00000000-0000-0000-0000-000000000001','evidence','$digest')" >> "$work/setup.log"
printf '[jeeta_backup]\nhost=%s/socket\nuser=%s\ndbname=jeeta\n' "$work" "$PGUSER" > "$work/service"
: > "$work/passfile"
export PGSERVICEFILE="$work/service" PGPASSFILE="$work/passfile"
export JEETA_RELEASE_DIR="$work/release" JEETA_FILES_DIR="$work/files" JEETA_SOURCE_ID=source
export JEETA_MASTER_KEY_ID=synthetic-key-v1 JEETA_RECOVERY_STATUS_DIR="$work/status" JEETA_CONTROL_HOOK="$work/hooks/control"
export JEETA_LOCK_DIR="$work/locks" JEETA_STATUS_GROUP="$(id -gn)"
export JEETA_PHYSICAL_SCHEDULE=always JEETA_BASE_ROOT="$work/base"
"$scripts/backup.sh" "$work/logical" > "$work/backup.log" 2>&1 || { cat "$work/backup.log"; cat "$work"/logical/*/command.log; fail 'backup'; }
logical=$(find "$work/logical" -mindepth 1 -maxdepth 1 -type d | head -1)
physical=$(find "$work/base" -mindepth 1 -maxdepth 1 -type d | head -1)
[[ -f "$logical/COMPLETE" && -f "$physical/COMPLETE" ]] || fail 'both real backup types required'
[[ $(cat "$work/control.log") == $'block\nstop\nassert_quiesced\nstart\nunblock' ]] || fail 'quiesce order'
[[ -z $(find "$logical" "$physical" \( -type f ! -perm 600 -o -type d ! -perm 700 \) -print -quit) ]] || fail 'private permissions'
[[ ! -e "$work/status/wal-status.json" ]] || fail 'backup fabricated WAL status'
sql "INSERT INTO recovery_fixture.timeline VALUES ('before')" >> "$work/setup.log"
wal_target_time=$(date -u +%FT%TZ)
sql "SELECT pg_create_restore_point('synthetic_target')" >> "$work/setup.log"
sql "INSERT INTO recovery_fixture.timeline VALUES ('after')" >> "$work/setup.log"
sql 'SELECT pg_switch_wal()' >> "$work/setup.log"
for ((i=0;i<100;i++)); do
  pending=$(find "$work/source/pg_wal/archive_status" -name '*.ready' -print -quit)
  [[ -z "$pending" ]] && break
  sleep .1
done
[[ -z "$pending" ]] || fail 'WAL did not archive'
# Immutable WAL snapshot, not a checksum file in the live archive destination.
cp -a "$work/wal" "$work/wal-snapshot"
(cd "$work/wal-snapshot"; find . -type f ! -path ./SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$work/wal-snapshot/SHA256SUMS"
config() {
  target="$work/target-$1"
  conf="$work/config-$1"
  cat > "$conf" <<CONF
JEETA_TARGET_DIR=$target
JEETA_TARGET_ID=disposable-$1
JEETA_DISPOSABLE=yes
JEETA_JOBS_ENABLED=false
JEETA_PUBLIC_ORIGIN=http://127.0.0.1:8080
JEETA_RELEASE_DIR=$work/release
JEETA_MASTER_KEY_FILE=$work/key
JEETA_MASTER_KEY_ID=synthetic-key-v1
JEETA_INTEGRITY_HOOK=$work/hooks/integrity
JEETA_SEALED_CANARY_CHECK_HOOK=$work/hooks/canary
JEETA_WAL_DIR=$work/wal-snapshot
JEETA_WAL_TARGET_NAME=synthetic_target
JEETA_WAL_TARGET_TIME=$wal_target_time
CONF
}
restore_ok() {
  "$scripts/restore-drill.sh" "$1" "$conf" > "$work/drill.log" 2>&1 || { cat "$work/drill.log"; [[ ! -f "$target/postgres.log" ]] || tail -30 "$target/postgres.log"; fail "restore $case_name"; }
  grep -qx 'integrity=passed' "$target/report" || fail 'missing integrity report'
}
refused() {
  if "$scripts/restore-drill.sh" "$1" "$conf" > "$work/rejected.log" 2>&1; then fail 'unsafe restore accepted'; fi
  [[ ! -e "$target/report" ]] || fail 'failed restore published success'
}
restore_requires_matching_key_and_files() {
  config missing-key; sed -i "s|JEETA_MASTER_KEY_FILE=.*|JEETA_MASTER_KEY_FILE=$work/missing|" "$conf"; refused "$logical"
  config wrong-key-id; sed -i 's/JEETA_MASTER_KEY_ID=.*/JEETA_MASTER_KEY_ID=wrong/' "$conf"; refused "$logical"
  printf 'wrong-key\n' > "$work/wrong-key"
  config wrong-key; sed -i "s|JEETA_MASTER_KEY_FILE=.*|JEETA_MASTER_KEY_FILE=$work/wrong-key|" "$conf"; refused "$logical"
  cp -a "$logical" "$work/missing-files"; rm "$work/missing-files/files/evidence"
  config missing-files; refused "$work/missing-files"
  config key-files-valid; restore_ok "$logical"
}
restore_checks_schema_before_serve() {
  cp -a "$work/release" "$work/bad-release"; printf '\n-- mismatch\n' >> "$work/bad-release/migrations/0001_foundation.up.sql"
  config bad-schema; sed -i "s|JEETA_RELEASE_DIR=.*|JEETA_RELEASE_DIR=$work/bad-release|" "$conf"; refused "$logical"
  [[ ! -e "$target" ]] || fail 'schema rejection must precede cluster/serve'
  printf 'wrong-revision\n' > "$work/bad-release/REVISION"
  config bad-revision; sed -i "s|JEETA_RELEASE_DIR=.*|JEETA_RELEASE_DIR=$work/bad-release|" "$conf"; refused "$logical"
}
restore_drill_has_zero_provider_traffic() {
  # The kernel namespace has loopback only. An attempted provider call is a failing
  # hook, and may never turn into a successful report even if the caller ignores errors.
  [[ $(awk -F: 'NR>2 { gsub(/[[:space:]]/, "", $1); print $1 }' /proc/self/net/dev) == lo ]] || fail 'network is not isolated'
  cat > "$work/hooks/attempt-egress" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == prepare ]] && exit 0
: > "$JEETA_TEST_ROOT/provider-attempt"
(timeout 2 bash -c 'echo synthetic >/dev/tcp/192.0.2.1/443') >/dev/null 2>&1
exit 1
HOOK
  chmod 700 "$work/hooks/attempt-egress"
  config egress-attempt; sed -i "s|JEETA_SEALED_CANARY_CHECK_HOOK=.*|JEETA_SEALED_CANARY_CHECK_HOOK=$work/hooks/attempt-egress|" "$conf"; refused "$logical"
  [[ -f "$work/provider-attempt" ]] || fail 'negative egress probe did not run'
  rm "$work/provider-attempt"
  config isolated; restore_ok "$logical"
  [[ ! -e "$work/provider-attempt" ]] || fail 'unexpected provider attempt'
  config jobs-enabled; sed -i 's/JEETA_JOBS_ENABLED=false/JEETA_JOBS_ENABLED=true/' "$conf"; refused "$logical"
}
logical_restore_preserves_rls_payment_and_ledger() {
  config logical; restore_ok "$logical"
  # Corrupt a real RLS property, make a real new dump, and require drill failure.
  sql 'ALTER TABLE payment_notifications NO FORCE ROW LEVEL SECURITY' >/dev/null
  export JEETA_PHYSICAL_SCHEDULE=never
  "$scripts/backup.sh" "$work/bad-rls" > "$work/bad-backup.log" 2>&1
  sql 'ALTER TABLE payment_notifications FORCE ROW LEVEL SECURITY' >/dev/null
  config bad-rls; refused "$(find "$work/bad-rls" -mindepth 1 -maxdepth 1 -type d | head -1)"
}
pitr_stops_at_selected_target() {
  config physical; restore_ok "$physical"
  grep -qx 'wal_target=synthetic_target' "$target/report" || fail 'wrong PITR target'
  config wrong-target; sed -i 's/JEETA_WAL_TARGET_NAME=.*/JEETA_WAL_TARGET_NAME=nonexistent/' "$conf"; refused "$physical"
}
backup_failure_does_not_advance_success_marker() {
  cp "$work/status/backup-status.json" "$work/status-before"
  touch "$work/inject-failure"
  if "$scripts/backup.sh" "$work/failed-backup" > "$work/failed.log" 2>&1; then fail 'injected backup failure accepted'; fi
  cmp -s "$work/status-before" "$work/status/backup-status.json" || fail 'success advanced after failure'
  [[ -f "$work/blocked" && -f "$work/stopped" ]] || fail 'failed backup resumed writes'
  rm "$work/inject-failure"
  # Failure after a set has been allocated must preserve its marker.
  cp "$work/service" "$work/service-before"; printf '[jeeta_backup]\nhost=/missing\n' > "$work/service"
  if "$scripts/backup.sh" "$work/failed-dump" > "$work/failed.log" 2>&1; then fail 'failed dump accepted'; fi
  cp "$work/service-before" "$work/service"
  [[ -n $(find "$work/failed-dump" -name FAILED -print -quit) ]] || fail 'missing failed marker'
  cmp -s "$work/status-before" "$work/status/backup-status.json" || fail 'failed dump advanced success'
  touch "$work/inject-status-failure"
  if "$scripts/backup.sh" "$work/failed-status" > "$work/failed.log" 2>&1; then fail 'failed status publication accepted'; fi
  chmod 700 "$work/status"; rm "$work/inject-status-failure"
  cmp -s "$work/status-before" "$work/status/backup-status.json" || fail 'failed status publication advanced marker'
  [[ -f "$work/blocked" && -f "$work/stopped" ]] || fail 'late failure did not re-quiesce'
  [[ -n $(find "$work/failed-status" -name FAILED -print -quit) ]] || fail 'late failure marker absent'
}
restore_refuses_production_or_nonempty_target() {
  config production; sed -i 's|JEETA_PUBLIC_ORIGIN=.*|JEETA_PUBLIC_ORIGIN=https://production.example.invalid|' "$conf"; refused "$logical"
  config nonempty; mkdir "$target"; printf 'keep\n' > "$target/operator-file"; refused "$logical"; grep -qx keep "$target/operator-file"
  config collision; sed -i 's/JEETA_TARGET_ID=.*/JEETA_TARGET_ID=source/' "$conf"; refused "$logical"
  config path-collision; sed -i "s|JEETA_TARGET_DIR=.*|JEETA_TARGET_DIR=$logical|" "$conf"; refused "$logical"
}
restored_unknown_send_is_not_retried() {
  config unknown; restore_ok "$logical"
  # This probes synthetic persisted uncertainty, not the Rust scheduler (T071).
  sql "UPDATE recovery_fixture.outbox SET state='queued',attempts=2 WHERE id=1" >/dev/null
  "$scripts/backup.sh" "$work/bad-unknown" > "$work/bad-backup.log" 2>&1
  sql "UPDATE recovery_fixture.outbox SET state='unknown',attempts=1 WHERE id=1" >/dev/null
  config retried-unknown; refused "$(find "$work/bad-unknown" -mindepth 1 -maxdepth 1 -type d | head -1)"
}
review_regressions() {
  local problems=0 before copy day old
  mkdir -p "$JEETA_LOCK_DIR"
  exec 8>"$JEETA_LOCK_DIR/$JEETA_SOURCE_ID.lock"; flock -n 8
  cp "$work/control.log" "$work/control-before-lock"
  if "$scripts/backup.sh" "$work/second-destination" > "$work/lock.log" 2>&1; then
    printf 'FAIL installation_lock_does_not_cover_other_destination\n'; problems=$((problems+1))
  fi
  cmp -s "$work/control.log" "$work/control-before-lock" || { printf 'FAIL locked_backup_touched_control\n'; problems=$((problems+1)); }
  exec 8>&-
  if [[ $(stat -c %a "$work/status/backup-status.json") != 640 || $(stat -c %G "$work/status/backup-status.json") != "$JEETA_STATUS_GROUP" ]]; then
    printf 'FAIL published_status_not_group_readable\n'; problems=$((problems+1))
  fi
  config review-locale
  if ! "$scripts/restore-drill.sh" "$logical" "$conf" > "$work/review-locale.log" 2>&1; then
    printf 'FAIL source_database_locale_not_preserved\n'; problems=$((problems+1))
  fi
  config review-capacity
  if ! "$scripts/restore-drill.sh" "$physical" "$conf" > "$work/review-capacity.log" 2>&1; then
    printf 'FAIL physical_source_capacity_not_preserved\n'; problems=$((problems+1))
  fi
  # Seed 30 valid historical days, then make publication fail after retention.
  mkdir -p "$work/late-retention"
  for ((old=1;old<=30;old++)); do
    day=$(date -u -d "$old days ago" +%Y%m%d)
    copy="$work/late-retention/${day}T000000Z-logical-history"
    cp -a "$logical" "$copy"
    sed -i "s/^started_at=.*/started_at=$(date -u -d "$old days ago" +%FT%TZ)/" "$copy/manifest"
    (source "$scripts/backup.sh" --library; inventory "$copy" > "$copy/SHA256SUMS")
  done
  touch "$work/inject-status-failure"
  if JEETA_PHYSICAL_SCHEDULE=never "$scripts/backup.sh" "$work/late-retention" > "$work/late-retention.log" 2>&1; then fail 'late publication failure accepted'; fi
  chmod 700 "$work/status"; rm "$work/inject-status-failure"
  before=0
  for copy in "$work/late-retention/"*-logical-*; do
    if [[ -f "$copy/COMPLETE" && ! -f "$copy/FAILED" ]]; then before=$((before+1)); fi
  done
  if ((before<30)); then printf 'FAIL late_failure_reduced_recoverable_retention\n'; problems=$((problems+1)); fi
  ((problems==0)) || fail 'post-commit security regressions'
}
retention_preserves_valid_daily_history() {
  # Real backup publishes into a populated root; tiny copies of a real logical set
  # model history. Invalid/foreign sets must not consume this source's quota.
  local old copy day
  mkdir -p "$work/retention"
  for ((old=1; old<=31; old++)); do
    day=$(date -u -d "$old days ago" +%Y%m%d)
    copy="$work/retention/${day}T000000Z-logical-history"
    cp -a "$logical" "$copy"
    sed -i "s/^started_at=.*/started_at=$(date -u -d "$old days ago" +%FT%TZ)/" "$copy/manifest"
    (source "$scripts/backup.sh" --library; inventory "$copy" > "$copy/SHA256SUMS")
  done
  for ((old=1; old<=31; old++)); do
    copy="$work/retention/299901$(printf '%02d' "$old")T000000Z-logical-foreign"
    cp -a "$logical" "$copy"; sed -i 's/source_id=source/source_id=foreign/' "$copy/manifest"
    (source "$scripts/backup.sh" --library; inventory "$copy" > "$copy/SHA256SUMS")
    copy="$work/retention/299902$(printf '%02d' "$old")T000000Z-logical-corrupt"
    cp -a "$logical" "$copy"; printf corrupt >> "$copy/database.dump"
  done
  "$scripts/backup.sh" "$work/retention" > "$work/retention.log" 2>&1
  [[ $(find "$work/retention" -name '*-history' -type d | wc -l) == 29 ]] || fail 'invalid or foreign sets consumed daily retention quota'
  [[ $(find "$work/retention" -name '*-foreign' -type d | wc -l) == 31 ]] || fail 'foreign backups were deleted'
  [[ $(find "$work/retention" -name '*-corrupt' -type d | wc -l) == 31 ]] || fail 'corrupt backups were deleted'
}
ci_runs_real_restore_scripts() {
  retention_preserves_valid_daily_history
  review_regressions
  [[ -s "$logical/database.dump" && -s "$physical/base/backup_manifest" ]] || fail 'real backups absent'
  [[ -s "$work/target-logical/report" && -s "$work/target-physical/report" ]] || fail 'real restore reports absent'
  # Removing an archive must make the actual script reject the set.
  cp -a "$logical" "$work/no-database"; rm "$work/no-database/database.dump"
  config no-database; refused "$work/no-database"
}
if [[ ${JEETA_TEST_FILTER:-} == review ]]; then
  review_regressions
  printf 'PASS post_commit_security_regressions\n'
  exit 0
fi
if [[ ${JEETA_TEST_FILTER:-} == retention ]]; then
  retention_preserves_valid_daily_history
  printf 'PASS retention_preserves_valid_daily_history\n'
  exit 0
fi
for case_name in restore_requires_matching_key_and_files restore_checks_schema_before_serve restore_drill_has_zero_provider_traffic logical_restore_preserves_rls_payment_and_ledger pitr_stops_at_selected_target backup_failure_does_not_advance_success_marker restore_refuses_production_or_nonempty_target restored_unknown_send_is_not_retried ci_runs_real_restore_scripts; do
  "$case_name"
  printf 'PASS %s\n' "$case_name"
done
