# Backup and isolated recovery

The owner checks recovery daily and performs and records **both** a logical restore
and a PITR drill monthly. Targets are RPO **24 hours**, RTO **1 hour**. A timer firing,
a successful database connection, or a copied dump is not evidence of recovery.
The shell scripts require Bash, GNU coreutils/findutils, util-linux (`flock`), and
matching PostgreSQL 16 client/server tools. Run backup as the recovery operator;
run drills as an unprivileged owner of an explicitly disposable cluster.

## Recovery material and custody

Mount protected storage separately at `/var/backups/jeeta/{logical,base,wal}`.
Backups contain customer data and sealed secrets: directories are 0700, files 0600.
Copy verified sets and WAL off the database machine using the owner's protected
backup destination; this script does not provision off-site storage. Keep the
**same master key** in a password manager with controlled recovery access, separate
from backup sets. A newly generated key cannot recover existing credentials.
Record the nonsecret key identifier; never put the key in a manifest, command
argument, report, Git, or a journal. Retain each historical key while its recovery
sets are retained. Test password-manager recovery during the monthly drill.

A release at `/opt/jeeta/current` must include `REVISION` (one revision identifier),
`migrations/*.up.sql` and `*.down.sql`, `scripts/backup.sh`, and
`scripts/restore-drill.sh`. A recovery set records format/kind, source installation
ID, revision, key ID, start/completion UTC timestamps, latest schema version, exact
applied migration versions, release migration SHA-256 hashes, file metadata and a
full file checksum inventory. The database's successful `_sqlx_migrations` version
set must exactly match that release. `COMPLETE` is written only after verification;
`FAILED` forbids restore. Checksums detect corruption, not malicious replacement:
protect the recovery storage and hooks against writes by tenants and app processes.
`panel/dist` is replaceable release content, not FileStore evidence.

## Daily backup and quiesce bracket

Install the packaged `/opt/jeeta/current/deploy/jeeta-backup.service` and timer in
systemd's unit directory. Create the directories in `ReadWritePaths` before enabling
the timer. `/etc/jeeta/recovery.env` is root-owned 0600; its values are systemd
EnvironmentFile entries (no shell expansion):

```ini
JEETA_RELEASE_DIR=/opt/jeeta/current
JEETA_FILES_DIR=/var/lib/jeeta/files
JEETA_SOURCE_ID=primary-installation
JEETA_MASTER_KEY_ID=owner-key-v1
JEETA_RECOVERY_STATUS_DIR=/var/lib/jeeta/recovery-status
JEETA_BASE_ROOT=/var/backups/jeeta/base
JEETA_CONTROL_HOOK=/etc/jeeta/recovery-control
PGSERVICEFILE=/etc/jeeta/pg_service.conf
PGPASSFILE=/etc/jeeta/pgpass
```

Use a protected libpq `jeeta_backup` service and passfile, not `PGPASSWORD`, passwords
in URLs, or positional secrets. The backup role must be able to read all tenant
rows for a complete dump and take replication backups; it is **not** an application
credential. Ordinary application roles remain NOSUPERUSER NOBYPASSRLS. Restrict the
backup connection using PostgreSQL access rules and local sockets where possible.

For a manual run, `JEETA_RECOVERY_CONFIG=/etc/jeeta/recovery.env` reads the same
unquoted `NAME=value` format; it never evaluates shell commands or expansions.
Paths containing spaces work for backup, but physical restore paths must use
letters/digits, `/`, `.`, `_`, and `-` because PostgreSQL restore_command is a shell
command. Do not use shell quoting syntax inside the manual config.

Provision `/etc/jeeta/recovery-control` as a root-owned 0700 executable. It accepts
exactly one operation, must fail on errors, and must implement these contracts:

1. `block`: block public and webhook ingress at the proxy, including direct paths.
2. `stop`: `systemctl stop jeeta.service`, waiting for its shutdown grace to finish.
3. `assert_quiesced`: independently verify ingress is blocked and the app stopped.
4. `start`: `systemctl start jeeta.service`, verify readiness while ingress is blocked.
5. `unblock`: reopen ingress only after start succeeded.

The ingress implementation depends on the installed proxy, so it is deliberately
an operator-supplied executable, not an assumed firewall command. Use a local proxy
control socket accessible to the service sandbox. The unit grants no firewall or
kernel administration capability. Do not implement any of these operations as a
no-op in production. A backup failure leaves ingress blocked and the app stopped
(or still blocked if restart was attempted); inspect private diagnostics, resolve
the failure, and rerun or deliberately recover service under the owner's control.
No trap automatically resumes traffic after an error.

The script locks the backup root, blocks ingress and stops the app, then runs
`pg_dump --format=custom --dbname=service=jeeta_backup` and snapshots
`JEETA_FILES_DIR` in the same write-free interval. It verifies the dump catalog,
release schema, file inventory and database archive checksums before restarting
and reopening ingress. Sunday adds a **physical** `pg_basebackup` and
`pg_verifybackup` within that bracket; the nightly logical backup still occurs.
Schedule is Sunday UTC, whereas the systemd daily timer uses the host's timezone
at 02:00. `JEETA_PHYSICAL_SCHEDULE=always` requests a base refresh; `never` is useful
only for isolated testing, not the production schedule. Base backups may lengthen
the maintenance interval: measure it before rollout.

## Continuous WAL and retention

On the source PostgreSQL cluster enable `wal_level=replica`, `archive_mode=on`, and
an archive command that returns success **only after durable archive storage has
accepted the exact WAL bytes**. Enable an appropriate `archive_timeout` so low
traffic still archives within the required RPO. Use the PostgreSQL owner's
protected, append-only archive directory; never overwrite an existing WAL filename
with different bytes. Archive settings and storage must be monitored independently
of the nightly timer. `pg_basebackup`'s streamed starting WAL makes a complete base,
but future PITR requires the continuous archive. Test archive-command failure and
disk-full alerts when commissioning the deployment.

Keep at least 30 daily logical sets and a verified 30-day base/WAL/key chain. The
script retains complete logical sets for the newest 30 distinct backup days, pruning older complete sets
only after a newer full backup verifies. Corrupt, foreign-installation, incomplete
and failed sets are retained for inspection and never consume the valid-set quota. **Base and WAL deletion is deliberately not automated.** Age alone,
a fresh base, or a checksum is insufficient evidence of a recoverable chain.
Keep the base at or before the 30-day boundary and every WAL segment/history file
needed through the newest verified target. First restore a newer complete chain,
record its base ID, timeline, target and retained range, then have the owner remove
only superseded material outside that range. Never remove the only recoverable
chain or its key. Until that evidence exists, retain extra data and alert on disk
usage; this conservative policy trades storage for recovery safety.

Keep FileStore files append-only throughout the retained PITR window. A base's
file snapshot can only support targets whose references exist in that snapshot.
For later targets with newly created files, retain a matching checksum-verified
file snapshot and supply that snapshot as `JEETA_PITR_FILES_DIR` (record its provenance); never delete referenced evidence to make a drill
pass. Missing references must fail. The supplemental directory must contain `files/` and a
`SHA256SUMS` inventory covering every file below it (excluding the inventory itself); no provider fetch fills missing files.

## Logical restore path

A logical dump restores into a newly initialized cluster. **WAL is never replayed
onto a logical dump.** Use the matching release, separately retrieved key and an
empty disposable target, in a network namespace with **only loopback** (for
example a container started with `--network none`, with no published ports).
The script additionally binds PostgreSQL only to a private Unix socket. It refuses
any other network interface, production/non-loopback origin, source installation
ID, overlapping source/target path, nonempty target, symlinks/special files in
recovery sets, wrong release/migration inventory, or missing/mismatched key ID.
Jobs must be explicitly disabled. It never starts `jeeta serve`, so auto-migration
cannot run before release validation and no scheduler/provider retries can occur.

Create a protected 0600 target config (literal, unquoted `NAME=value`):

```ini
JEETA_TARGET_DIR=/work/disposable-logical
JEETA_TARGET_ID=monthly-drill-unique
JEETA_DISPOSABLE=yes
JEETA_JOBS_ENABLED=false
JEETA_PUBLIC_ORIGIN=http://127.0.0.1:8080
JEETA_RELEASE_DIR=/work/matching-release
JEETA_MASTER_KEY_FILE=/work/protected-key
JEETA_MASTER_KEY_ID=owner-key-v1
JEETA_INTEGRITY_HOOK=/work/protected-integrity-check
JEETA_SEALED_CANARY_CHECK_HOOK=/work/protected-sealed-canary-check
```

Invoke `/opt/jeeta/current/scripts/restore-drill.sh <recovery-set> <target-config>`
as the unprivileged PostgreSQL cluster owner. No secrets are positional. Only
protected config and key **paths** appear above. The logical path initializes a
cluster, calls the integrity hook's `prepare` operation to provision matching
roles, restores with `pg_restore --exit-on-error --no-owner`, then verifies actual
DB migration versions. The privileged restore identity must never become the
application's role. Ownership/grants and FORCE RLS must be tested using ordinary
NOSUPERUSER NOBYPASSRLS roles.

Both hooks are required owner-only executables. Their stdout/stderr is suppressed
because decrypted material must not enter output. They receive libpq `PGHOST`
(private socket), `PGPORT`, `PGUSER`, `PGDATABASE`, plus `JEETA_DRILL_FILES_DIR` and
the protected config variables. They must exit nonzero on **any** failed invariant:

- Integrity `prepare`: create required ordinary roles for logical restore.
- Integrity `verify`: check two-tenant RLS with FORCE RLS enabled, file contents and
  every DB-to-file reference, ledger/payment/entitlement/status and code history,
  and preservation of unknown external sends without retry. Record safe counts
  only if needed. The role making tenant queries must not bypass RLS.
- Integrity `verify_pitr`: verify the synthetic pre-target marker exists and the
  post-target marker does not, using independently recorded expectations.
- `JEETA_SEALED_CANARY_CHECK_HOOK verify`: decrypt and compare a known sealed canary
  using the matching binary and recovered key, without printing either value.
  **T071 supplies the real Rust check.** This shell task's fixture checks only
  synthetic key equality; it does not claim real credential decryption or test
  the Rust scheduler. An absent/failing hook always fails the drill.

## Physical PITR path

Choose a manifest with `kind=physical`. Prepare an immutable snapshot of the
matching WAL archive containing all segments/history through a marked restore
point. Generate `SHA256SUMS` over all files in that snapshot (relative sorted
filenames, `sha256sum`, excluding `SHA256SUMS` itself). Do not write this inventory
into the live archive destination. In addition to the logical config fields:

```ini
JEETA_TARGET_DIR=/work/disposable-pitr
JEETA_WAL_DIR=/work/verified-wal-snapshot
JEETA_WAL_TARGET_NAME=monthly_drill_target
JEETA_WAL_TARGET_TIME=2026-10-26T02:00:00Z
# Optional verified superset for files added after the base:
JEETA_PITR_FILES_DIR=/work/retained-files-snapshot
# If the source cluster superuser differs from the disposable OS account:
JEETA_RESTORE_ROLE=postgres
```

Create named restore points with `pg_create_restore_point` on the **disposable
source in tests**; record the actual UTC time and synthetic records before/after
that point. For an owner drill, use an independently recorded source marker and
target time; do not fabricate a target timestamp to satisfy RPO. Archive the WAL
containing both sides of the target before starting. Use the exact PostgreSQL
major version and compatible runtime/extension installation.

The physical path runs `pg_verifybackup`, copies the physical base, replaces all
source PostgreSQL configuration (including auto config and archive hooks), adds
`recovery.signal` and a fixed `restore_command`, and sets `recovery_target_name` and
`recovery_target_action=promote`. It waits for recovery to finish, validates the
restored schema and invariants, and requires `verify_pitr` to prove the selected
state. A missing segment, wrong timeline/target or post-target record fails the
drill. No source replication connection or source archive command is retained.
PostgreSQL stops on both success and failure; the files/report remain for inspection.

Reports contain only source revision, backup UTC time, named WAL target, integrity
and external key-hook outcome, elapsed seconds, observed data-loss interval and
RPO/RTO budgets. Physical data loss uses PostgreSQL's last replayed transaction
timestamp, not merely the operator-supplied marker time. Targets in the future, data loss over 24 hours, elapsed recovery
over one hour, or any failed check fail the drill. Private PostgreSQL logs and a
`FAILED` marker stay in the disposable target for diagnosis; never upload those
logs or recovery material as public CI artifacts. Publish only the sanitized
successful `report`. Provider credentials may have rotated externally: expect
reconnect, never claim provider state rolled back. Enabling jobs/egress belongs to
a separately reviewed cutover; a drill never enables either.

## Daily owner check and monthly evidence

Daily, check timer/service result, the latest complete manifest/checksums, free
space, off-site copy, last verified full-backup time, PostgreSQL archiver failures
and the independently verified archive destination. Investigate missing/stale
status or failed markers immediately; check that maintenance did not leave ingress
blocked. Monthly, restore a recent logical set and a base plus a complete WAL
chain in isolation, recover the key from custody, run the two-tenant/decryption/
file/ledger/billing/uncertainty probes, and record the owner, date, sanitized reports,
RPO/RTO outcomes, chain coverage and any remediation. Never use customer data in
repository fixtures.

`$JEETA_RECOVERY_STATUS_DIR/backup-status.json` is atomically published using a
same-directory temporary file and rename **after verified completion**, as
`{"completed_at":"<RFC3339 UTC>"}` (well below the reader's 4 KiB limit).
A failed run preserves the prior marker. Give the application read access to the
status directory through an operator-controlled group/ACL; it must not write it.
The shell scripts never write `wal-status.json`. The **T071 binary probe**, every
60 seconds, will publish `{"archived_at":"<RFC3339 UTC>"}` only after confirming
archiver state and the destination. Until wired, WAL health is unknown, not healthy.

Run `bash /opt/jeeta/current/scripts/tests/backup-restore.sh` in the source test
layout to execute the real scripts. It detects host PostgreSQL tools and uses a
private network namespace, or falls back to the local `postgres:16` image with
`--network none`. Unique disposable containers and a `mktemp` directory are cleaned
by traps; it never uses pre-existing containers/volumes. All application migrations
are applied. Additional synthetic probes and seeds live under
`scripts/tests/fixtures/recovery`; their scoped up/down pair is round-trip tested.
T071 adds the Rust tests and CI job; the shell test name
`ci_runs_real_restore_scripts` proves executable paths, not that a CI job exists.
