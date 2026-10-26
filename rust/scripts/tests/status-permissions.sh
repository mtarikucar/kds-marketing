#!/usr/bin/env bash
# Root-only disposable check of the documented two-writer status layout.
set -euo pipefail
((EUID == 0))
work=$(mktemp -d /tmp/jeeta-status-permissions-XXXXXXXX)
trap 'rm -rf "$work"' EXIT
chmod 755 "$work"
install -d -o root -g postgres -m 1770 "$work/status"
printf 'backup\n' > "$work/status/backup-status.json"
chown root:postgres "$work/status/backup-status.json"
chmod 640 "$work/status/backup-status.json"
runuser -u postgres -- bash -eu -c '
  status=$1
  test "$(cat "$status/backup-status.json")" = backup
  printf "wal\n" > "$status/.wal-new"
  mv "$status/.wal-new" "$status/wal-status.json"
  printf "wal2\n" > "$status/.wal-new"
  mv "$status/.wal-new" "$status/wal-status.json"
  if rm "$status/backup-status.json" 2>/dev/null; then exit 1; fi
  if printf "overwrite\n" 2>/dev/null > "$status/backup-status.json"; then exit 1; fi
  if mv "$status/wal-status.json" "$status/backup-status.json" 2>/dev/null; then exit 1; fi
  test "$(cat "$status/backup-status.json")" = backup
' _ "$work/status"
