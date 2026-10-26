# Deployment, boot and shutdown

One `jeeta serve` process serves the panel, API, MCP, webhooks and scheduled jobs
against one PostgreSQL database. This runbook covers the deployment artefacts of
[M4 Task 8 and Q4–Q6](../superpowers/plans/2026-10-23-rust-m4-urunlestirme.md).
All examples are synthetic. Keep actual hosts, credentials, bank details,
recovery sets and change records in private operational storage.

This is the documentation half (T070). Release CI, boot-contract tests and the
Rust README reconciliation remain T066. Metrics/status probes (Task 5), operator
reset (Task 6), and the [backup/restore runbook](backup-restore.md) and scripts
(Task 9) are pending in this revision. **Deployment is not recovery-ready until
Task 9's logical/PITR restore drill passes.** The pending link is intentional;
these instructions do not claim that its scripts or reset flag already work.

## Build and distribution

Build a reviewed source revision from a clean packaging checkout with the
repository's pinned toolchain and lockfiles. From `rust/`:

```sh
cargo build --release --locked -p jeeta
pnpm --dir panel install --frozen-lockfile
pnpm --dir panel build
```

Use the package-scoped production build. Whole-workspace test feature unification
can enable `jt_outbound/test-loopback`; such a binary must not be deployed.
The release build and panel build must pass for the actual packaged candidate;
this documentation task does not execute either build.

Package `rust/target/release/jeeta`, the **contents** of `rust/panel/dist/`,
`rust/migrations/`, repository `scripts/`, `deploy/` and operation documents from
the same revision. Include Task 9's scripts once implemented; their absence
blocks recovery readiness. Install the complete release before moving `current`:

```text
/opt/jeeta/releases/<revision>/
  jeeta
  panel/index.html                 # plus matching built assets
  migrations/                      # every .up.sql and .down.sql pair
  scripts/
  deploy/
  docs/operations/
  manifest.json
/opt/jeeta/current -> /opt/jeeta/releases/<revision>
```

The distribution manifest must record these fields, with values derived from
that package, never copied from another build:

| Field | Required content |
|---|---|
| `source_revision` | Full source commit SHA and clean source provenance |
| `binary_checksum` | SHA-256 of `jeeta` |
| `panel_checksum` | SHA-256 of a sorted per-file SHA-256 manifest of `panel/`; include that file manifest in the package |
| `migration_versions` | Ordered shipped sqlx versions, with checksums for the up/down files |
| `schema_version` | Recovery-compatible schema version for this binary, checked against the database's applied migration set |

Record the checksum method and toolchain versions alongside the manifest.
Retain the prior complete release and its matching recovery set. A retained
binary alone does not make schema rollback safe.

## Database, directories and secret custody

Provision an ordinary schema-owning application role with `LOGIN NOSUPERUSER
NOBYPASSRLS`. It needs permission to apply the packaged migrations, but must not
bypass tenant RLS. Confirm its attributes before first start; boot rejects either
superuser or BYPASSRLS. Keep privileged backup/restore access in a **separate**
protected libpq service/passfile, outside the application environment. Restore
must re-establish ordinary application ownership and ENABLE/FORCE RLS.

Create the `jeeta` system user and group without interactive login. Provision:

| Path | Ownership / permissions / purpose |
|---|---|
| `/opt/jeeta/releases` and each release | `root:root`; directories 0755, binary/scripts 0755, ordinary assets 0644; service cannot modify release content |
| `/opt/jeeta/current` | Root-managed symlink to one complete release |
| `/etc/jeeta` | `root:root` 0700 |
| `/etc/jeeta/jeeta.env` | `root:root` **0600**, including `JEETA_SECRET_KEY`; systemd reads it before switching to `jeeta` |
| `/var/lib/jeeta` | `jeeta:jeeta` 0700; service working directory |
| `/var/lib/jeeta/files` | `jeeta:jeeta` 0700; persistent FileStore, included in backups |
| `/var/lib/jeeta/recovery-status` | Planned Tasks 5/9 status directory; provision with narrowly scoped writer access and service read access when those tasks land |
| `/var/backups/jeeta/{logical,base,wal}` | Separate protected mounted storage, managed by the recovery account; outside the app's writable tree |

Use the [environment template](../../deploy/jeeta.env.example) as an inventory,
then fill required values privately. Blank values are placeholders. A copied
blank template will fail startup. It is a systemd `EnvironmentFile`, with no
`export`, command substitution or shell variable expansion. Quote literal values
containing spaces appropriately. Do not print or source the file for diagnostics.
Do not leave `.env` or `rust/.env` under the service working directory: the binary
loads these as fallbacks and they can introduce unintended configuration.

`JEETA_SECRET_KEY` is exactly 64 hex characters / 32 bytes. Generate it using a
secure random source during initial provisioning and deliver it without terminal
output, shell tracing, command-line secret arguments or repository storage. The
owner keeps a separate recovery copy of the **same key** in their password
manager. Restrict the containing environment file to root, mode 0600, including
all temporary editing copies. Losing the key makes sealed credentials
unrecoverable even with a healthy database dump. Generating a new key during
restore is not recovery; master-key rotation is outside this procedure.

Production values (set in the private environment file):

```ini
JEETA_BIND=127.0.0.1:8080
JEETA_FILES_DIR=/var/lib/jeeta/files
JEETA_PANEL_DIR=/opt/jeeta/current/panel
JEETA_COOKIE_SECURE=true
JEETA_ALLOWED_HOSTS=<public-host>
JEETA_PUBLIC_BASE_URL=https://<public-host>
JEETA_LOG_FORMAT=json
JEETA_LOG=info,rmcp=warn
JEETA_JOBS_ENABLED=true
```

Replace `<public-host>` with the intended authority. `JEETA_ALLOWED_HOSTS` is a
comma-separated list of host authorities (optional numeric port), whereas
`JEETA_PUBLIC_BASE_URL` is an origin without path, query, user or fragment.
[Config](../../rust/bin/jeeta/src/config.rs) requires the origin for provider
apps; [boot](../../rust/bin/jeeta/src/serve.rs) also requires it for file transport
even without an app. FileStore boot requires an existing absolute private
directory with no symlink components and a public HTTPS origin. Keep the directory inside the unit's
`ReadWritePaths=/var/lib/jeeta`.

Fill `JEETA_DATABASE_URL`, the key, positive `JEETA_PRICE_MINOR`, three uppercase
ASCII letters in `JEETA_PRICE_CURRENCY` and nonblank `JEETA_BANK_INSTRUCTIONS`
(1–4096 UTF-8 bytes). Configure provider apps as complete groups: Meta ID/secret/
verify token; Instagram ID/secret; X client ID/secret. Optional Meta configuration
IDs and Graph version require the Meta group. The template comments reflect each
current validation rule. Leave unused provider groups unset.

Remove `JEETA_ALLOW_SUPERUSER` and `JEETA_ALLOW_TEST_LOOPBACK` in production.
Keep `rmcp=warn` to avoid logging MCP session identifiers. Never log passwords,
keys, authorization headers, activation codes, payment reference text, tenant
bodies or secret-bearing URLs. Journald retention concerns operational logs;
messages, publication evidence and audit ledger retain their separate indefinite
retention. Activation policy is fixed at **8 alphanumerics / 72 h / 5 attempts**.

## TLS proxy and integrated request limits

Terminate TLS at the reverse proxy and forward to `127.0.0.1:8080`. Route panel
assets and fallback pages, `/api/`, `/mcp`, webhook paths and signed `/files/`
transport to the **same release**. Preserve the intended public `Host` (including
port when configured), request method, path, raw query, body, cookies, bearer
headers and webhook signature headers. Restrict accepted public hosts at the
proxy; do not replace the host with the upstream loopback address. Keep upstream
HTTP unreachable externally. Forward `X-Requested-With` for panel requests;
proxying must not bypass the application's CSRF checks. Avoid logging raw
webhook/file URLs, query strings or credentials at the proxy.

The integrated sources define the following limits:

| Route / transport | Body limit and source |
|---|---|
| `POST /api/studio/files`, `POST /api/studio/slots/{slot_id}/piece` | **280,000,000 bytes**, explicit `DefaultBodyLimit` in [panel router](../../rust/crates/adapters/jt_panel_http/src/lib.rs) |
| Other panel API body extractors | Axum's default **2,097,152 bytes (2 MiB)**; the panel router does not override it globally |
| `/mcp` | **280,000,000 bytes**, `with_max_request_body_bytes` in [MCP HTTP service](../../rust/crates/adapters/jt_mcp/src/http.rs) |
| Meta webhooks | **3,145,728 bytes (3 MiB)**, `META_BODY_LIMIT` in [webhook router](../../rust/crates/adapters/jt_webhook/src/lib.rs) |
| NetGSM webhooks | **262,144 bytes (256 KiB)**, `NETGSM_BODY_LIMIT` in the same router |

Configure route-specific proxy body ceilings to preserve these limits; do not
apply a small global ceiling that breaks the supported upload/MCP payloads.
These are transport limits; individual use cases can reject smaller invalid
payloads. Preserve signed webhook bytes without transformation. Allow streaming
MCP responses and disable response buffering for `/mcp`.

There is **no explicit request timeout layer in `jt_panel_http` or the combined
HTTP router**. Do not interpret the shutdown drain as a per-request timeout.
The locked rmcp 3.6.0 transport used by `StreamableHttpServerConfig::default()`
sets SSE keep-alive to **15 seconds** and SSE retry to **3 seconds**; neither is a
request deadline. Set proxy stream idle timeout above the keep-alive interval
and validate uploads and long-running tool calls on the packaged candidate.
Record the actual proxy connect/read/write timeout configuration in the private
release record; this repository currently specifies no universal numeric proxy
request timeout. Preserve connector-specific timeouts and egress policy.

## Service and journal installation

After provisioning the directories and protected environment, install the
[unit](../../deploy/jeeta.service) and [journal drop-in](../../deploy/journald-jeeta.conf)
on the target host as root:

```sh
install -m 0644 /opt/jeeta/current/deploy/jeeta.service /etc/systemd/system/jeeta.service
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 /opt/jeeta/current/deploy/journald-jeeta.conf /etc/systemd/journald.conf.d/jeeta.conf
systemd-analyze verify --man=no /etc/systemd/system/jeeta.service
systemctl daemon-reload
systemctl restart systemd-journald
journalctl --flush
systemctl enable --now jeeta.service
```

`Storage=persistent`, `MaxRetentionSec=30day`, `SystemMaxUse=1G` are **host-wide**
journald settings, not a per-service quota. Review other host drop-ins and their
precedence, confirm persistent journal storage and inspect actual disk usage.
`systemd-analyze verify` validates service units; a `journald.conf` drop-in is
not a unit and cannot be validated by passing it to that command. Inspect merged
settings with `systemd-analyze cat-config systemd/journald.conf`, then check
journald's own startup diagnostics on the target. A staging unit verification
does not prove user provisioning, filesystem permissions, DB access or boot.

The service runs as `jeeta`, with mode mask 0077, no new privileges, private tmp,
protected home and strict read-only system paths except `/var/lib/jeeta`.
It restarts on failure after 5 seconds. Confirm the service stays healthy;
`Type=simple` being active alone is not proof that startup/migrations succeeded.
Validate panel assets, authenticated API/MCP and synthetic webhook handling,
and confirm one scheduler owner. Task 5 will add operational health/metrics;
do not use nonexistent endpoints as current readiness evidence.

## Boot, operator setup and recovery

After config validation, [serve.rs](../../rust/bin/jeeta/src/serve.rs) orders boot:

1. Reject a binary compiled with test-loopback egress enabled.
2. Connect to PostgreSQL; reject a superuser/BYPASSRLS application role.
3. Apply pending sqlx **up** migrations. Concurrent migrators serialize via sqlx
   locking. A failure aborts before listening or starting jobs.
4. Construct adapters, FileStore and egress; rebuild allowed tenant hosts.
5. Bootstrap the operator if configured. Task 6 adds the recovery-reset branch
   at this point; it is not implemented in this revision.
6. Bind HTTP, then start jobs when enabled.

There is no automatic down migration or destructive fallback. The boot process
is not an old-binary/new-schema compatibility check; perform that check before
starting either serve or stdio.

For first setup, set `JEETA_PLATFORM_BOOTSTRAP_EMAIL` and
`JEETA_PLATFORM_BOOTSTRAP_PASSWORD` together in the protected environment. Use a
valid operator email and password of at least **12 characters**, as enforced by
[platform bootstrap](../../rust/crates/jt_app/src/usecases/platform.rs). Start
once, confirm successful operator login, stop, remove both values, and restart.
Existing operators prevent ordinary bootstrap from replacing their passwords.
Confirm login again after removal. Operator identity is separate from tenant
membership and does not grant access to tenant message bodies or credentials.

Q4 recovery procedure, **available only after Task 6 is integrated and tested**:

1. Prefer another authenticated operator's password-reset action when available.
2. For sole-operator recovery, stop the service and verify it is stopped. In the
   protected environment set the existing operator email, a new password of at
   least 12 characters, and `JEETA_PLATFORM_BOOTSTRAP_RESET=1`.
3. Start once. Reset must require exactly one matching-email operator, update its
   password hash and revoke all its sessions atomically. Zero/multiple operators
   or a mismatched email must abort boot. Do not edit SQL to bypass recovery.
4. Confirm recovery, stop, remove **all three** bootstrap variables and restart.
   Confirm the new login succeeds and old sessions/password fail. Keep passwords
   and hashes out of the operational record.

The current binary does not parse the reset flag: setting it now is not a
password reset. Wait for the tested Task 6 implementation before using this path.
`JEETA_METRICS_TOKEN` and `JEETA_RECOVERY_STATUS_DIR` are also pending; the latter
will identify the absolute directory containing `backup-status.json` and
`wal-status.json`, with access coordinated between Tasks 5/9.

## Shutdown and stdio clients

SIGTERM/SIGINT stops new connections and job scheduling. The HTTP drain is
**10 seconds** (`DRAIN_TIMEOUT` in [serve.rs](../../rust/bin/jeeta/src/serve.rs));
then scheduled runs receive up to **30 seconds** (`SHUTDOWN_GRACE` in
[scheduler.rs](../../rust/bin/jeeta/src/scheduler.rs)) before abortion. Thus
**10 + 30 < TimeoutStopSec=60s**, leaving room for cleanup. In-flight provider
writes with an unknown outcome must not be blindly retried after restart.

[`jeeta mcp-stdio`](../../rust/bin/jeeta/src/stdio.rs) does **not** migrate, start
jobs or serve HTTP. It needs a compatible, already migrated database and the
same production role/egress checks and required configuration. Supply
`JEETA_STDIO_API_KEY` only in the protected stdio client environment, never in
the service env file or browser configuration. Authentication happens at process
startup: **restart every affected stdio process after key revocation or issuer
demotion**. Do not promise immediate revocation within an existing process.

## Upgrade and rollback

1. Record installed revision/schema, proposed revision, checksums and migration
   compatibility. Build and validate the complete candidate in staging.
2. Fence ingress and external writers, stop the single application and relevant
   stdio clients, and take a verified DB + FileStore + key recovery set **first**.
   Preserve all current runtime data. Task 9 recovery prerequisites below apply.
3. Check the target DB's applied versions/checksums against the candidate's
   manifest and reviewed migration compatibility before it can auto-migrate.
   Install the complete release, then atomically replace the root-managed
   `current` symlink on the same filesystem.
4. Start once, inspect boot/migration results and validate panel/API/MCP/webhooks
   and jobs using synthetic checks. Record the outcome without secrets.
5. If the candidate fails, stop/fence it and preserve new DB/files and uncertain
   external-write evidence. **Never run an old binary on a newer schema.** A
   symlink-only rollback is allowed only when the DB still matches the prior
   release's schema. Otherwise use its matching verified recovery set in an
   isolated target and an owner-reviewed cutover with reconciliation of all
   newer data. Never automatically run downs or overwrite newer runtime data.

For the v1 transition, additionally follow [v1 cutover](v1-cutover.md); restarting
an older sender without fencing the new sender can duplicate external writes.

## Backup and restore prerequisites — Task 9 pending

The full procedure will live in [backup-restore.md](backup-restore.md). Before
live recovery acceptance, provision protected, separately mounted backup storage,
a nightly full backup, continuous WAL archiving, physical base backups and a
monthly owner-run restore drill. Target **RPO 24 h / RTO 1 h**; retain 30 daily
logical sets and a verified 30-day base/WAL chain. Prune only after a newer
complete chain is verified, never the only recoverable key/base/WAL set.

Logical recipe (inside the future backup procedure, with private paths and
protected libpq service/passfile; `backup_dir` denotes its recovery-set directory):

```sh
pg_dump --format=custom --file="$backup_dir/database.dump" --dbname=service=jeeta_backup
pg_restore --exit-on-error --no-owner --dbname=service=jeeta_restore "$backup_dir/database.dump"
```

The restore service must name an explicit disposable isolated target, never
production. Quiesce writes by stopping the application and blocking ingress
before the dump and FileStore snapshot; resume only after both snapshots and
checksums are complete. Recover matching DB, uploads/publication evidence,
manifest/schema/config metadata and the separately protected **same master key**.
Panel assets are replaceable release content; FileStore data is not. Verify DB
references against file checksums, not just a successful dump exit code.

PITR is a separate path: PostgreSQL `archive_mode=on`, a verified archive command
and destination, and `pg_basebackup` physical base backups with a continuous
matching WAL chain. **WAL cannot be replayed onto a pg_dump restore.** Preserve
FileStore data append-only through the PITR retention window and snapshot at
base backups and before drills. Verify archive successes and destination data;
a nightly timer firing is not evidence of either backup or WAL health.

After Task 9 ships, the owner runs and records monthly, using protected paths:

```text
/opt/jeeta/current/scripts/restore-drill.sh <recovery-set> <isolated-target-config>
```

The drill must reject source/target collisions, production origins and nonempty
targets; check manifest/schema against the matching binary **before serve can
auto-migrate**. Disable jobs and block all provider egress and production
webhooks at the network boundary. Prove tenant RLS, sealed-canary equality without
printing plaintext, file integrity, ledger/payment/entitlement state and unknown
outbox preservation. Wrong/missing keys and missing files must fail; PITR must
prove records before/after the target boundary. Record measured data loss and
recovery elapsed time against RPO/RTO. Provider tokens may require reconnection;
restoring the database does not roll back an external provider. Do not enable
jobs automatically after the drill. **Until this drill passes, deployment is
not recovery-ready.**
