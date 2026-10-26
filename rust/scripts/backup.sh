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
exec 9>"$root/.backup.lock"; flock -n 9 || fail 'backup already running'
set_dir=
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    # Includes late failures after an attempted reopen (e.g. atomic rename fails).
    hook "$JEETA_CONTROL_HOOK" block || true
    hook "$JEETA_CONTROL_HOOK" stop || true
    if [[ -n "$set_dir" ]]; then printf 'backup_failed\n' > "$set_dir/FAILED"; fi
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
  printf '%s\n' "$set_dir"
}
create_set logical "$root"
# Nightly logical still runs on Sunday. 'always' permits explicit base refresh/drills.
if [[ "${JEETA_PHYSICAL_SCHEDULE:-sunday}" == always || ( "${JEETA_PHYSICAL_SCHEDULE:-sunday}" == sunday && $(date -u +%u) == 7 ) ]]; then
  required JEETA_BASE_ROOT
  create_set physical "$JEETA_BASE_ROOT"
fi
# Retention is deliberately conservative: only complete logical sets, after a newer
# verified full set, and never bases/WAL without an independently verified chain.
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
hook "$JEETA_CONTROL_HOOK" start
hook "$JEETA_CONTROL_HOOK" unblock
mv -f "$status_tmp" "$JEETA_RECOVERY_STATUS_DIR/backup-status.json"
