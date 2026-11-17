#!/usr/bin/env bash
# Runs backup.sh's WAL/base retention by hand. --dry-run lists, removes nothing.
# Same config and installation lock as backup.sh; exit 3 means it refused.
set -euo pipefail
umask 077
source "$(dirname "$0")/backup.sh" --library
dry_run=0
case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) dry_run=1;;
  *) fail 'usage: wal-retention.sh [--dry-run]';;
esac
[[ -z "${JEETA_RECOVERY_CONFIG:-}" ]] || read_config "$JEETA_RECOVERY_CONFIG"
required JEETA_SOURCE_ID JEETA_BASE_ROOT JEETA_WAL_ARCHIVE_DIR
[[ "$JEETA_SOURCE_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'unsafe identifier'
lock_dir=${JEETA_LOCK_DIR:-/run/jeeta-recovery}
mkdir -p "$lock_dir"
[[ ! -L "$lock_dir/$JEETA_SOURCE_ID.lock" ]] || fail 'unsafe lock file'
exec 9>"$lock_dir/$JEETA_SOURCE_ID.lock"; flock -n 9 || fail 'backup already running for this installation'
wal_retention "$JEETA_BASE_ROOT" "$JEETA_WAL_ARCHIVE_DIR" "${JEETA_BASE_RETENTION:-2}" "$dry_run"
