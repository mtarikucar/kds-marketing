#!/usr/bin/env bash
# Shared validation is also used by restore-drill.sh; never source recovery input.
set -euo pipefail
umask 077
fail() { printf 'recovery: %s\n' "$1" >&2; exit 1; }
private_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail 'required protected file missing'
  local mode owner
  mode=$(stat -c %a "$1"); owner=$(stat -c %u "$1")
  (( (8#$mode & 077) == 0 )) || fail 'file must be owner-only'
  [[ "$owner" == "$EUID" || "$owner" == 0 ]] || fail 'file has wrong owner'
}
read_config() {
  private_file "$1"
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail 'invalid config line'
    key=${line%%=*}; value=${line#*=}
    [[ "$key" =~ ^JEETA_[A-Z_]+$ || "$key" == PGSERVICEFILE || "$key" == PGPASSFILE ]] || fail 'invalid config key'
    [[ "$value" != *$'\r'* ]] || fail 'invalid config value'
    printf -v "$key" '%s' "$value"; export "$key"
  done < "$1"
}
required() { local name; for name in "$@"; do [[ -n "${!name:-}" ]] || fail "missing $name"; done; }
hook() { private_file "$1"; [[ -x "$1" ]] || fail 'hook is not executable'; "$@" >/dev/null 2>&1; }
safe_tree() {
  [[ -d "$1" && ! -L "$1" ]] || fail 'missing directory'
  [[ -z "$(find "$1" -mindepth 1 ! -type f ! -type d -print -quit)" ]] || fail 'special files or symlinks refused'
}
inventory() {
  (cd "$1"
   if [[ ${2:-set} == data ]]; then find . -type f -print0
   else find . -type f ! -path ./SHA256SUMS ! -path ./COMPLETE ! -path ./FAILED -print0; fi |
     LC_ALL=C sort -z | xargs -0 -r sha256sum)
}
verify_set() {
  safe_tree "$1"
  [[ -s "$1/SHA256SUMS" && -s "$1/manifest" && -d "$1/files" ]] || fail 'incomplete recovery set'
  inventory "$1" | cmp -s "$1/SHA256SUMS" - || fail 'recovery checksum mismatch'
}
release_inventory() { (cd "$1/migrations"; sha256sum *.up.sql *.down.sql | LC_ALL=C sort); }
release_versions() {
  local f v
  for f in "$1"/migrations/*.up.sql; do v=${f##*/}; v=${v%%_*}; printf '%d\n' "$((10#$v))"; done | sort -n
}
db_versions() { psql -XAt --set=ON_ERROR_STOP=1 "$1" -c 'SELECT version FROM _sqlx_migrations WHERE success ORDER BY version'; }
db_settings() {
  psql -XAt --set=ON_ERROR_STOP=1 "$1" -c "SELECT pg_encoding_to_char(encoding), datlocprovider, datcollate, datctype, coalesce(daticulocale,''), coalesce(datcollversion,''), coalesce(pg_database_collation_actual_version(oid),'') FROM pg_database WHERE datname=current_database()"
}
read_manifest() {
  local line key value
  declare -gA manifest=()
  while IFS= read -r line; do
    key=${line%%=*}; value=${line#*=}
    case "$key" in format|kind|source_revision|source_id|master_key_id|started_at|completed_at|schema_version) ;; *) fail 'unknown manifest field';; esac
    [[ -z "${manifest[$key]+x}" && "$value" =~ ^[a-zA-Z0-9_.:+/-]+$ ]] || fail 'invalid manifest field'
    manifest[$key]=$value
  done < "$1/manifest"
  [[ ${#manifest[@]} == 8 && ${manifest[format]} == 1 ]] || fail 'invalid manifest format'
  [[ ${manifest[kind]} == logical || ${manifest[kind]} == physical ]] || fail 'invalid backup kind'
  local timestamp
  for timestamp in started_at completed_at; do
    [[ ${manifest[$timestamp]} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail 'invalid manifest timestamp'
    date -u -d "${manifest[$timestamp]}" +%s >/dev/null 2>&1 || fail 'invalid manifest timestamp'
  done
  [[ ${manifest[schema_version]} == "$(tail -1 "$1/schema.versions")" ]] || fail 'manifest schema version mismatch'
}
# WAL/base retention. Keeps the archive needed by the newest N verified physical
# sets of this installation (N=JEETA_BASE_RETENTION, default 2). It refuses, and
# removes nothing, unless the newest base verifies, N verified bases exist and the
# N-th newest base's backup history file is in the archive. Returns 3 on refusal.
# Written for callers without errexit (backup.sh runs it in a `( ) ||` subshell).
wal_skip() { printf 'recovery: WAL retention skipped: %s; archive left untouched\n' "$1" >&2; }
base_valid() {
  [[ -f "$1/COMPLETE" && ! -e "$1/FAILED" ]] || return 1
  # Same evidence as logical retention: checksums, manifest, source and kind.
  (verify_set "$1"; read_manifest "$1"; [[ ${manifest[source_id]} == "$JEETA_SOURCE_ID" && ${manifest[kind]} == physical ]]) 2>/dev/null
}
# First backup_label line, e.g. "START WAL LOCATION: 0/2000028 (file 000000010000000000000002)".
base_start() {
  local line re='^START WAL LOCATION: [0-9A-F]+/[0-9A-F]+ \(file ([0-9A-F]{24})\)$'
  [[ -f "$1/base/backup_label" && ! -L "$1/base/backup_label" ]] || return 1
  IFS= read -r line < "$1/base/backup_label" || return 1
  [[ "$line" =~ $re ]] || return 1
  printf '%s\n' "$line"
}
# Sort key per set: "<name timestamp> <start LSN> <path>". Names carry only whole seconds
# plus a random suffix, so sets from the same second are ordered by WAL position; a set
# without a readable label sorts as the newest of its second (it then blocks retention).
base_order() {
  local dir name line lsn hi lo
  while IFS= read -r dir; do
    name=${dir##*/}
    lsn=FFFFFFFFFFFFFFFF
    if line=$(base_start "$dir"); then
      lsn=${line#START WAL LOCATION: }; lsn=${lsn%% *}
      hi=${lsn%/*}; lo=${lsn#*/}
      printf -v lsn '%08X%08X' "0x$hi" "0x$lo"
    fi
    printf '%s %s %s\n' "${name%%-*}" "$lsn" "$dir"
  done
}
# The archived <segment>.<offset>.backup whose START line matches the base's label.
base_history() {
  local line segment candidate first found=
  line=$(base_start "$1") || return 1
  segment=${line##*file }; segment=${segment%)}
  for candidate in "$2/$segment".????????.backup; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || continue
    IFS= read -r first < "$candidate" || continue
    [[ "$first" == "$line" ]] || continue
    [[ -z "$found" ]] || return 1
    found=${candidate##*/}
  done
  [[ -n "$found" ]] || return 1
  printf '%s\n' "$found"
}
wal_retention() {
  local base_root=$1 wal_dir=$2 keep=$3 dry_run=${4:-0}
  local cleanup cut history line newest_line newest_segment listing removed i cut_index=-1
  local -a sets=() valid=()
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || { wal_skip 'JEETA_BASE_RETENTION must be a positive integer'; return 3; }
  [[ -d "$wal_dir" && ! -L "$wal_dir" ]] || { wal_skip 'WAL archive directory missing'; return 3; }
  [[ -d "$base_root" && ! -L "$base_root" ]] || { wal_skip 'base backup root missing'; return 3; }
  cleanup=$(command -v pg_archivecleanup) || cleanup=/usr/lib/postgresql/16/bin/pg_archivecleanup
  [[ -x "$cleanup" ]] || { wal_skip 'pg_archivecleanup not found'; return 3; }
  mapfile -t sets < <(find "$base_root" -mindepth 1 -maxdepth 1 -type d -name '*-physical-*' | base_order | LC_ALL=C sort -r | cut -d' ' -f3-)
  (( ${#sets[@]} > 0 )) || { wal_skip 'no base backups'; return 3; }
  base_valid "${sets[0]}" || { wal_skip "newest base backup ${sets[0]##*/} is not complete and verified"; return 3; }
  for ((i = 0; i < ${#sets[@]}; i++)); do
    base_valid "${sets[i]}" || continue
    valid+=("${sets[i]}")
    if (( ${#valid[@]} == keep )); then cut_index=$i; break; fi
  done
  (( cut_index >= 0 )) || { wal_skip "only ${#valid[@]} complete base backup(s), $keep required"; return 3; }
  cut=${sets[cut_index]}
  history=$(base_history "$cut" "$wal_dir") || { wal_skip "backup history file of ${cut##*/} not found in the WAL archive"; return 3; }
  newest_line=$(base_start "${sets[0]}") || { wal_skip "newest base backup ${sets[0]##*/} has no backup_label"; return 3; }
  newest_segment=${newest_line##*file }; newest_segment=${newest_segment%)}
  # pg_archivecleanup compares names without the timeline; so does this guard.
  [[ ! "${history:8:16}" > "${newest_segment:8}" ]] || { wal_skip 'base backup names and WAL positions disagree'; return 3; }
  listing=$("$cleanup" -n "$wal_dir" "$history") || { wal_skip 'pg_archivecleanup dry run failed'; return 3; }
  removed=0; [[ -z "$listing" ]] || removed=$(printf '%s\n' "$listing" | wc -l)
  if (( dry_run )); then
    printf 'recovery: dry run: would keep WAL from %s (base %s; newest %s verified bases kept)\n' "$history" "${cut##*/}" "$keep"
    [[ -z "$listing" ]] || while IFS= read -r line; do printf 'would remove %s\n' "$line"; done <<< "$listing"
  else
    "$cleanup" "$wal_dir" "$history" || { printf 'recovery: pg_archivecleanup failed; inspect the WAL archive\n' >&2; return 1; }
    printf 'recovery: WAL retention removed %s archived segment(s) before %s (base %s)\n' "$removed" "$history" "${cut##*/}" >&2
  fi
  # Older verified sets of this installation are superseded by N newer verified ones.
  # Corrupt, foreign, incomplete and failed sets stay for inspection.
  for ((i = cut_index + 1; i < ${#sets[@]}; i++)); do
    base_valid "${sets[i]}" || continue
    if (( dry_run )); then
      printf 'would remove base %s\n' "${sets[i]##*/}"
    else
      rm -rf -- "${sets[i]}" || { printf 'recovery: could not remove superseded base %s\n' "${sets[i]##*/}" >&2; return 1; }
      printf 'recovery: removed superseded base backup %s\n' "${sets[i]##*/}" >&2
    fi
  done
  return 0
}
[[ "${1:-}" == --library ]] && return 0
[[ $# == 1 ]] || fail 'usage: backup.sh <backup-root>'
[[ -z "${PGPASSWORD:-}" ]] || fail 'use a protected libpq passfile'
[[ -z "${JEETA_RECOVERY_CONFIG:-}" ]] || read_config "$JEETA_RECOVERY_CONFIG"
required JEETA_RELEASE_DIR JEETA_FILES_DIR JEETA_SOURCE_ID JEETA_MASTER_KEY_ID JEETA_RECOVERY_STATUS_DIR JEETA_CONTROL_HOOK PGSERVICEFILE PGPASSFILE
private_file "$PGSERVICEFILE"; private_file "$PGPASSFILE"
[[ "$JEETA_SOURCE_ID" =~ ^[a-zA-Z0-9_-]+$ && "$JEETA_MASTER_KEY_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'unsafe identifier'
[[ -f "$JEETA_RELEASE_DIR/REVISION" ]] || fail 'release REVISION missing'
revision=$(cat "$JEETA_RELEASE_DIR/REVISION")
[[ "$revision" =~ ^[a-zA-Z0-9._-]+$ ]] || fail 'invalid release revision'
safe_tree "$JEETA_FILES_DIR"
mkdir -p "$1" "$JEETA_RECOVERY_STATUS_DIR"
root=$(realpath "$1")
[[ "$root/" != "$(realpath "$JEETA_FILES_DIR")/"* ]] || fail 'backup root overlaps files'
lock_dir=${JEETA_LOCK_DIR:-/run/jeeta-recovery}
mkdir -p "$lock_dir"
[[ ! -L "$lock_dir/$JEETA_SOURCE_ID.lock" ]] || fail 'unsafe lock file'
exec 9>"$lock_dir/$JEETA_SOURCE_ID.lock"; flock -n 9 || fail 'backup already running for this installation'
set_verified=0
set_dir=
physical_created=0
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    # Includes late failures after an attempted reopen (e.g. atomic rename fails).
    hook "$JEETA_CONTROL_HOOK" block || true
    hook "$JEETA_CONTROL_HOOK" stop || true
    if [[ -n "$set_dir" ]] && (( ! set_verified )); then printf 'backup_failed\n' > "$set_dir/FAILED"; fi
    printf 'backup_failed\n' > "$root/FAILED"
    printf 'recovery: backup failed; ingress remains blocked; inspect privately\n' >&2
  fi
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
hook "$JEETA_CONTROL_HOOK" block
hook "$JEETA_CONTROL_HOOK" stop
hook "$JEETA_CONTROL_HOOK" assert_quiesced
create_set() {
  local kind=$1 dest=$2 started completed
  set_verified=0
  mkdir -p "$dest"
  set_dir=$(mktemp -d "$dest/$(date -u +%Y%m%dT%H%M%SZ)-$kind-XXXXXX")
  started=$(date -u +%FT%TZ)
  # Logs stay private; PostgreSQL errors can contain connection details.
  if [[ "$kind" == logical ]]; then
    pg_dump --format=custom --file="$set_dir/database.dump" --dbname=service=jeeta_backup >"$set_dir/command.log" 2>&1
    pg_restore --list "$set_dir/database.dump" >/dev/null 2>>"$set_dir/command.log"
  else
    pg_basebackup --dbname=service=jeeta_backup --pgdata="$set_dir/base" --format=plain --wal-method=stream --checkpoint=fast >"$set_dir/command.log" 2>&1
    pg_verifybackup "$set_dir/base" >>"$set_dir/command.log" 2>&1
  fi
  db_settings service=jeeta_backup > "$set_dir/database.settings" 2>>"$set_dir/command.log"
  cp -a "$JEETA_FILES_DIR" "$set_dir/files"
  safe_tree "$set_dir/files"
  release_inventory "$JEETA_RELEASE_DIR" > "$set_dir/migrations.sha256"
  release_versions "$JEETA_RELEASE_DIR" > "$set_dir/schema.versions"
  db_versions service=jeeta_backup > "$set_dir/database.versions" 2>>"$set_dir/command.log"
  cmp -s "$set_dir/schema.versions" "$set_dir/database.versions" || fail 'database/release schema mismatch'
  (cd "$set_dir/files"; find . -printf '%y %m %s %P\n' | LC_ALL=C sort) > "$set_dir/files.metadata"
  completed=$(date -u +%FT%TZ)
  printf 'format=1\nkind=%s\nsource_revision=%s\nsource_id=%s\nmaster_key_id=%s\nstarted_at=%s\ncompleted_at=%s\nschema_version=%s\n' \
    "$kind" "$revision" "$JEETA_SOURCE_ID" "$JEETA_MASTER_KEY_ID" "$started" "$completed" "$(tail -1 "$set_dir/schema.versions")" > "$set_dir/manifest"
  find "$set_dir" -type d -exec chmod 700 {} +
  find "$set_dir" -type f -exec chmod 600 {} +
  inventory "$set_dir" > "$set_dir/SHA256SUMS"
  verify_set "$set_dir"
  printf 'verified\n' > "$set_dir/COMPLETE"
  set_verified=1
  printf '%s\n' "$set_dir"
}
create_set logical "$root"
# Nightly logical still runs on Sunday. 'always' permits explicit base refresh/drills.
if [[ "${JEETA_PHYSICAL_SCHEDULE:-sunday}" == always || ( "${JEETA_PHYSICAL_SCHEDULE:-sunday}" == sunday && $(date -u +%u) == 7 ) ]]; then
  required JEETA_BASE_ROOT
  create_set physical "$JEETA_BASE_ROOT"
  physical_created=1
fi
# Retention is deliberately conservative: only complete logical sets, after a newer
# verified full set. Bases/WAL follow wal_retention after a verified physical set.
mapfile -t old_sets < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name '*-logical-*' | LC_ALL=C sort -r)
kept=0
declare -A retained_days=()
for old in "${old_sets[@]}"; do
  [[ -f "$old/COMPLETE" && ! -e "$old/FAILED" ]] || continue
  # Foreign/corrupt sets are retained for inspection, never counted as recovery.
  (verify_set "$old"; read_manifest "$old"; [[ ${manifest[source_id]} == "$JEETA_SOURCE_ID" && ${manifest[kind]} == logical ]]) || continue
  read_manifest "$old"
  day=${manifest[started_at]%%T*}
  if [[ -z ${retained_days[$day]+x} ]]; then
    retained_days[$day]=1
    ((kept+=1))
  fi
  if (( kept > 30 )); then rm -rf -- "$old"; fi
done
status_tmp=$(mktemp "$JEETA_RECOVERY_STATUS_DIR/.backup-status.XXXXXX")
printf '{"completed_at":"%s"}\n' "$(date -u +%FT%TZ)" > "$status_tmp"
# The new inode needs explicit reader access; a directory ACL cannot widen 0600.
chgrp "${JEETA_STATUS_GROUP:-jeeta}" "$status_tmp"
chmod 640 "$status_tmp"
hook "$JEETA_CONTROL_HOOK" start
hook "$JEETA_CONTROL_HOOK" unblock
mv -f "$status_tmp" "$JEETA_RECOVERY_STATUS_DIR/backup-status.json"
# After the verified run is published and ingress is open: a retention refusal or
# error is logged and leaves the archive as it is, never failing the backup.
if (( physical_created )); then
  if [[ -n ${JEETA_WAL_ARCHIVE_DIR:-} ]]; then
    (wal_retention "$JEETA_BASE_ROOT" "$JEETA_WAL_ARCHIVE_DIR" "${JEETA_BASE_RETENTION:-2}") ||
      printf 'recovery: WAL retention did not complete; backup itself succeeded\n' >&2
  else
    printf 'recovery: JEETA_WAL_ARCHIVE_DIR unset; WAL retention skipped\n' >&2
  fi
fi
