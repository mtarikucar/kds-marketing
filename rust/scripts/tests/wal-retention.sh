#!/usr/bin/env bash
# WAL/base retention contracts on a synthetic archive: no PostgreSQL server needed.
# Uses the real pg_archivecleanup when installed; CI requires it (JEETA_REQUIRE_HOST_TOOLS=yes).
set -euo pipefail
umask 077
scripts=$(cd "$(dirname "$0")/.." && pwd)
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
root=$(mktemp -d "${TMPDIR:-/tmp}/jeeta-wal-retention-XXXXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin"
if ! command -v pg_archivecleanup >/dev/null; then
  if [[ -x /usr/lib/postgresql/16/bin/pg_archivecleanup ]]; then
    export PATH="/usr/lib/postgresql/16/bin:$PATH"
  else
    [[ ${JEETA_REQUIRE_HOST_TOOLS:-no} != yes ]] || fail 'pg_archivecleanup required'
    # Local fallback with pg_archivecleanup's rule: segment (or .partial) names that
    # sort before the kept segment, timeline ignored. Never used in CI.
    cat > "$root/bin/pg_archivecleanup" <<'STUB'
#!/usr/bin/env bash
dry=0; [[ $1 == -n ]] && { dry=1; shift; }
keep=${2:0:24}
for path in "$1"/*; do
  name=${path##*/}; name=${name%.partial}
  [[ $name =~ ^[0-9A-F]{24}$ && "${name:8}" < "${keep:8}" ]] || continue
  if ((dry)); then printf '%s\n' "$path"; else rm -- "$path"; fi
done
STUB
    chmod 700 "$root/bin/pg_archivecleanup"
  fi
fi
if ! command -v flock >/dev/null; then
  [[ ${JEETA_REQUIRE_HOST_TOOLS:-no} != yes ]] || fail 'flock required'
  printf '#!/bin/sh\nexit 0\n' > "$root/bin/flock"; chmod 700 "$root/bin/flock"
fi
export PATH="$root/bin:$PATH"
seg() { printf '00000001000000000000%04X' "$1"; }
label() { printf 'START WAL LOCATION: 0/%X000028 (file %s)\n' "$1" "$(seg "$1")"; }
# A synthetic physical set as backup.sh lays it out, plus its archived history file.
mkset() {
  local name=$1 start=$2 source=${3:-source} dir="$base/$1"
  mkdir -p "$dir/files" "$dir/base"
  printf 'evidence\n' > "$dir/files/evidence"
  { label "$start"; printf 'CHECKPOINT LOCATION: 0/%X000060\nBACKUP METHOD: streamed\nBACKUP FROM: primary\nSTART TIMELINE: 1\n' "$start"; } > "$dir/base/backup_label"
  printf '1\n' > "$dir/schema.versions"
  printf 'format=1\nkind=physical\nsource_revision=synthetic\nsource_id=%s\nmaster_key_id=key-v1\nstarted_at=2026-11-01T02:00:00Z\ncompleted_at=2026-11-01T02:10:00Z\nschema_version=1\n' "$source" > "$dir/manifest"
  reinventory "$dir"
  printf 'verified\n' > "$dir/COMPLETE"
  { label "$start"; printf 'STOP WAL LOCATION: 0/%X000100 (file %s)\nSTOP TIMELINE: 1\n' "$start" "$(seg "$start")"; } > "$wal/$(seg "$start").00000028.backup"
}
reinventory() { (source "$scripts/backup.sh" --library; inventory "$1" > "$1/SHA256SUMS"); }
# Four weekly bases (newest first: d@0B, c@09, b@06, a@03) over segments 01..0C.
setup() {
  work="$root/$1"; base="$work/base"; wal="$work/wal"
  mkdir -p "$base" "$wal" "$work/locks"
  local n
  for ((n = 1; n <= 12; n++)); do printf 'wal\n' > "$wal/$(seg "$n")"; done
  printf 'partial\n' > "$wal/$(seg 2).partial"
  printf 'in flight\n' > "$wal/$(seg 13).tmp"
  printf 'timeline\n' > "$wal/00000002.history"
  mkset 20261025T020000Z-physical-aaaaaa 3
  mkset 20261101T020000Z-physical-bbbbbb 6
  mkset 20261108T020000Z-physical-cccccc 9
  mkset 20261115T020000Z-physical-dddddd 11
}
tree() { (cd "$work" && find . ! -path './out' ! -path './locks*' -print | LC_ALL=C sort); }
retention() {
  JEETA_SOURCE_ID=source JEETA_BASE_ROOT="$base" JEETA_WAL_ARCHIVE_DIR="$wal" JEETA_LOCK_DIR="$work/locks" \
    JEETA_BASE_RETENTION="$keep" bash "$scripts/wal-retention.sh" "$@"
}
refuses() {
  local before rc=0
  before=$(tree)
  retention "$@" > "$work/out" 2>&1 || rc=$?
  [[ $rc == 3 ]] || { cat "$work/out" >&2; fail "$case_name: expected refusal, got exit $rc"; }
  grep -q 'WAL retention skipped' "$work/out" || fail "$case_name: refusal not logged"
  [[ "$(tree)" == "$before" ]] || fail "$case_name: refused run changed files"
}
cut_respected() {
  local cut=$1 path name n
  for path in "$wal"/*; do
    name=${path##*/}; name=${name%.partial}
    if [[ $name =~ ^[0-9A-F]{24}$ && "${name:8}" < "${cut:8}" ]]; then fail "$case_name: kept segment older than the cut: ${path##*/}"; fi
  done
  for ((n = 16#${cut:16}; n <= 12; n++)); do
    [[ -f "$wal/$(seg "$n")" ]] || fail "$case_name: removed segment at/after the cut: $(seg "$n")"
  done
  for name in "$(seg 13).tmp" 00000002.history "$(seg 3).00000028.backup" "$(seg 9).00000028.backup"; do
    [[ -f "$wal/$name" ]] || fail "$case_name: removed non-segment file $name"
  done
}
prunes_to_nth_newest_complete_base() {
  setup prune
  mkset 20261018T020000Z-physical-foreign 2 elsewhere
  mkset 20261020T020000Z-physical-corrupt 2
  printf 'x' >> "$base/20261020T020000Z-physical-corrupt/files/evidence"
  retention > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'prune run failed'; }
  cut_respected "$(seg 9)"
  [[ ! -e "$wal/$(seg 8)" && ! -e "$wal/$(seg 2).partial" ]] || fail 'segments before the cut kept'
  [[ -d "$base/20261115T020000Z-physical-dddddd" && -d "$base/20261108T020000Z-physical-cccccc" ]] || fail 'retained bases removed'
  [[ ! -e "$base/20261101T020000Z-physical-bbbbbb" && ! -e "$base/20261025T020000Z-physical-aaaaaa" ]] || fail 'superseded bases kept'
  [[ -d "$base/20261018T020000Z-physical-foreign" && -d "$base/20261020T020000Z-physical-corrupt" ]] || fail 'foreign/corrupt bases removed'
  grep -q 'removed 9 archived segment' "$work/out" || { cat "$work/out" >&2; fail 'prune not logged'; }
  # Idempotent: a second run removes nothing more.
  retention > "$work/out" 2>&1 || fail 'second run failed'
  cut_respected "$(seg 9)"
}
retention_count_is_configurable() {
  setup three
  keep=3 retention > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'keep=3 run failed'; }
  cut_respected "$(seg 6)"
  [[ -d "$base/20261101T020000Z-physical-bbbbbb" && ! -e "$base/20261025T020000Z-physical-aaaaaa" ]] || fail 'keep=3 bases'
  setup invalid-count; keep=0 refuses; keep=two refuses
}
dry_run_removes_nothing() {
  setup dry
  local before
  before=$(tree)
  retention --dry-run > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'dry run failed'; }
  [[ "$(tree)" == "$before" ]] || fail 'dry run changed files'
  grep -q "^would remove .*/$(seg 8)\$" "$work/out" || fail 'dry run did not list segments'
  if grep -q "would remove .*/$(seg 9)\$" "$work/out"; then fail 'dry run listed the cut segment'; fi
  grep -q '^would remove base 20261101T020000Z-physical-bbbbbb$' "$work/out" || fail 'dry run did not list bases'
  if [[ -n ${JEETA_SHOW_DRY_RUN:-} ]]; then cat "$work/out"; fi
}
fewer_than_n_complete_bases_refuse() {
  setup fewer
  rm -rf "$base"/*-aaaaaa "$base"/*-bbbbbb "$base"/*-cccccc
  refuses
  setup fewer-keep; keep=5 refuses
  # Incomplete and failed sets do not count towards N.
  setup fewer-marked
  rm "$base/20261108T020000Z-physical-cccccc/COMPLETE"
  touch "$base/20261101T020000Z-physical-bbbbbb/FAILED"
  keep=3 refuses
}
newest_base_must_verify() {
  setup newest-incomplete; mkset 20261116T020000Z-physical-eeeeee 12; rm "$base/20261116T020000Z-physical-eeeeee/COMPLETE"; refuses
  setup newest-failed; touch "$base/20261115T020000Z-physical-dddddd/FAILED"; refuses
  setup newest-corrupt; printf 'x' >> "$base/20261115T020000Z-physical-dddddd/files/evidence"; refuses
  setup newest-foreign; mkset 20261116T020000Z-physical-eeeeee 12 elsewhere; refuses
}
history_file_must_match() {
  setup history-missing; rm "$wal/$(seg 9).00000028.backup"; refuses
  setup history-other; sed -i '1s/9000028/9000099/' "$wal/$(seg 9).00000028.backup"; refuses
  setup label-missing
  rm "$base/20261108T020000Z-physical-cccccc/base/backup_label"
  reinventory "$base/20261108T020000Z-physical-cccccc"
  refuses
}
corrupt_base_is_skipped_not_counted() {
  setup skip
  printf 'x' >> "$base/20261108T020000Z-physical-cccccc/files/evidence"
  retention > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'skip run failed'; }
  cut_respected "$(seg 6)"
  [[ -d "$base/20261108T020000Z-physical-cccccc" && ! -e "$base/20261025T020000Z-physical-aaaaaa" ]] || fail 'corrupt base handling'
}
same_second_bases_follow_wal_order() {
  # Set names carry whole seconds and a random suffix; within one second the WAL
  # position decides which base is newer, never the suffix.
  setup same-second
  rm -rf "$base"/*-cccccc "$base"/*-dddddd
  mkset 20261115T020000Z-physical-zzzzzz 9
  mkset 20261115T020000Z-physical-aaaaaa 11
  retention > "$work/out" 2>&1 || { cat "$work/out" >&2; fail 'same-second run failed'; }
  cut_respected "$(seg 9)"
  [[ -d "$base/20261115T020000Z-physical-zzzzzz" && -d "$base/20261115T020000Z-physical-aaaaaa" ]] || fail 'same-second bases removed'
  [[ ! -e "$base/20261101T020000Z-physical-bbbbbb" ]] || fail 'superseded base kept'
}
for case_name in prunes_to_nth_newest_complete_base same_second_bases_follow_wal_order retention_count_is_configurable dry_run_removes_nothing fewer_than_n_complete_bases_refuse newest_base_must_verify history_file_must_match corrupt_base_is_skipped_not_counted; do
  keep=2
  "$case_name"
  printf 'PASS %s\n' "$case_name"
done
