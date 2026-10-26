# v1 carry-over, cutover and rollback

The baseline is a **fresh v2 database**, with new workspaces, memberships, keys
and reconnected capabilities. Ek A carries forward knowledge and designs, not
customer records, except for the **leads-only owner amendment of 2026-10-26** below. This procedure implements M4 Task 10 and rulings Q7/Q8/C1 in
the [M4 plan](../superpowers/plans/2026-10-23-rust-m4-urunlestirme.md), under
[design §14–16 and Ek A](../superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md).
Q7 resolves the older §14 choice: create **new reviewed provider apps**; do not
transfer or share v1 apps. Missing provider approval blocks live acceptance.

This public document and its rehearsal use synthetic examples only. The real
change record, provider IDs, account bindings, recovery material and archive
belong in access-controlled operational storage outside this repository.

## Inventory and integrated evidence

The following links identify existing implementations and tests; they are not a
claim of live provider acceptance. Test names were checked against integrated
M1–M3 sources. This documentation task does not rerun Rust or panel suites.

| Disposition | Scope and evidence |
|---|---|
| Keep — Ek A knowledge | **Thompson sampling and rewards.** [Planning](../../rust/crates/domain/jt_studio/src/planning.rs) and [learning](../../rust/crates/domain/jt_studio/src/learning.rs); [planning tests](../../rust/crates/domain/jt_studio/tests/studio_planning.rs): `thompson_selection_and_uniform_exploration_are_injected`; [learning tests](../../rust/crates/domain/jt_studio/tests/studio_learning.rs): `learning_and_weekly_weights_match_ruling_vectors`, `missing_metrics_do_not_reward_zero`. Algorithms carry over; learned history does not. |
| Keep — Ek A knowledge | **Publication/measurement provider knowledge.** Meta [publish](../../rust/crates/adapters/jt_meta/src/publish.rs)/[insights](../../rust/crates/adapters/jt_meta/src/insights.rs), X [publish](../../rust/crates/adapters/jt_x/src/publish.rs)/[insights](../../rust/crates/adapters/jt_x/src/insights.rs). [Meta tests](../../rust/crates/adapters/jt_meta/tests/graph.rs): `facebook_publish_feed_photos_and_video`, `insights_read_post_and_account_counters`; [X tests](../../rust/crates/adapters/jt_x/tests/x.rs): `publish_receipt_url_uses_username`, `insights_read_public_metrics`. [Uncertain receipt test](../../rust/crates/adapters/jt_meta/tests/studio_publish.rs): `accepted_missing_or_unreadable_receipt_is_unknown`. |
| Keep — Ek A knowledge | **NetGSM behavior.** [SMS implementation](../../rust/crates/adapters/jt_netgsm/src/sms.rs); [tests](../../rust/crates/adapters/jt_netgsm/tests/netgsm.rs): `send_posts_the_v2_body_with_basic_auth`, `inbox_always_sends_both_dates_in_turkish_time`, `no_retry_after_an_unparseable_response`, `sms_commercial_iysfilter_mapping`. Provider behavior is retained; credentials and queues are fresh. |
| Keep — Ek A knowledge | **Email receive/send rules.** [IMAP](../../rust/crates/adapters/jt_mail/src/imap.rs), [SMTP](../../rust/crates/adapters/jt_mail/src/smtp.rs); [mail tests](../../rust/crates/adapters/jt_mail/tests/mail.rs): `imap_account_mailbox_uid_dedupe`, `uidvalidity_reset`, `smtp_starttls_stable_message_id`, `smtp_accepted_answer_lost_is_unknown`, `sent_echo_reconciles_unknown`, `tls_required`. No old mail import or cursor reuse. |
| Keep — Ek A knowledge | **MCP OAuth 2.1 design only.** The integrated [MCP auth](../../rust/crates/adapters/jt_mcp/src/auth.rs) and [HTTP endpoint](../../rust/crates/adapters/jt_mcp/src/http.rs) use bearer API keys; [HTTP tests](../../rust/crates/adapters/jt_mcp/tests/mcp_http.rs) include `missing_bearer_is_401_structured`, `a_revoked_key_is_refused_on_its_next_request`, `session_bound_to_other_key_is_unknown`. These prove bearer behavior, **not an implemented OAuth 2.1 authorization server**. Provider OAuth in connector adapters is a different flow. |
| Keep — Ek A knowledge | **Sealed-secret approach.** [AES implementation](../../rust/crates/adapters/jt_seal/src/aes.rs); [seal tests](../../rust/crates/adapters/jt_seal/tests/seal.rs): `round_trip_per_workspace`, `another_workspace_cannot_open`, `tampered_byte_is_refused`, `output_never_contains_plaintext`. Reuse the approach, never v1 sealed blobs or keys. |
| Keep — Ek A knowledge | **Tenant-filter architecture tests.** [Tenant transactions](../../rust/crates/adapters/jt_pg/src/tx.rs) and [unit of work](../../rust/crates/adapters/jt_pg/src/uow.rs); [SQL scoping tests](../../rust/crates/jt_archtest/tests/sql_scoping.rs): `every_sql_literal_touching_a_tenant_table_mentions_workspace_id`, `every_tenant_table_has_force_rls_in_the_migration`, `platform_wide_markers_live_only_in_platform_or_user_files`. |
| Keep — Ek A knowledge | **Design system and three-column inbox.** [Design tokens](../../rust/panel/src/index.css) document their v1 origin; [InboxPage](../../rust/panel/src/pages/InboxPage.tsx) implements the responsive three-column grid. [Inbox tests](../../rust/panel/src/pages/Inbox.test.tsx): `human_holder_does_not_disable_panel_reply`, `queue_switching_and_unsnooze` verify interactions; they do not prove pixel-level visual parity. |
| Keep — Ek A knowledge | **Roles/invitations.** [Team](../../rust/crates/jt_app/src/usecases/team.rs) and [roles](../../rust/crates/jt_app/src/usecases/roles.rs); [team tests](../../rust/crates/jt_app/tests/team.rs): `invite_stores_only_the_token_hash_with_a_seven_day_expiry_and_ledgers_it`, `demoting_the_last_owner_is_conflict_last_owner`, `roles_update_replaces_custom_permissions_but_not_system_ones`. Old memberships and invitation tokens are not imported. |
| Remove — §3/§16 | Credits, packages, subscriptions, top-ups, reseller billing, coupons and trials. Product payment remains one-time bank transfer with operator confirmation and owner activation; advertising budgets remain tenant spending caps. |
| Remove — §3/§16 | Internal AI/media generation and research/trend provider dependencies. |
| Remove — §3/§16 | Field installs, sales reports, sites, courses, form builders and order forms/orders. |
| Remove — §3/§16 | Multiple brands per workspace, nested groups, simultaneous journeys for one person and three extra languages; panel languages remain Turkish/English. |
| Remove — §3/§16 | Ad campaign/creative creation, product catalog/PDF quotes, customer-payment connector and public booking page. Existing ad budget operations are not campaign creation. |
| Defer | Additional `Connector` adapters; object-store `FileStore` adapter; product payment provider; service split; webchat widget; master-key rotation. None is introduced by cutover. |
| Start fresh — C1 | New workspaces, memberships, keys and reconnected capabilities. **Only allowlisted v1 leads may become people. No conversations/mail, payments, publications, queues, learning history, ledger, sessions, invitations or v1 sealed credentials are imported.** New installation keys and secret custody are independent. |

Operational behavior and connector configuration are described in the
[Rust README](../../rust/README.md). First-run guidance is **M4 Task 7 — pending**;
deployment and backup/restore are **M4 Task 8/9 — pending**. This procedure does
not invent their files or claim recovery readiness. Their completed, verified
runbooks and the owner's live acceptance are prerequisites for a real switch.

## Private change record and stop points

The owner chooses and records the switch time (UTC and local timezone), approves
the go/no-go decision, owns event-gap reconciliation, and owns the v1 archive.
Assign an executing operator and record each step's actual start/end time,
actor, result and evidence reference. Synthetic record examples:

| Record | Synthetic value / required evidence |
|---|---|
| Owner / operator / gap owner | `owner-example` / `operator-example` / `owner-example` |
| Planned switch time | `2030-01-01T12:00:00Z`; actual freeze, webhook and enable instants recorded separately |
| Old/new provider app IDs, per provider/product | `app-v1-example` / `app-v2-example`; distinct IDs, new review approval and granted permissions recorded |
| Old/new account and capability bindings | `account-example`; verified same intended account, new workspace/capability IDs and app subscriptions recorded |
| Old/new callbacks | `callback-v1-example` / `callback-v2-example`; exact approved redirect paths and provider verification evidence |
| Old/new DNS/proxy and webhook targets | `dns-v1-example`, `proxy-v1-example`, `hook-v1-example` and their v2 counterparts; restore instructions and effective route evidence |
| Sender/poller ownership | v1 → neither → v2; all workers, agents, schedulers and manual send paths accounted for |
| Recovery sets | Separate frozen v1 and fresh v2 backups, matching binaries/schema, files and independently secured key references; restore verification |
| Archive | Frozen snapshot ID/checksum, owner/access list, creation instant, read-only storage policy and earliest release instant (creation + 90 elapsed days) |
| Gap and uncertain writes | Freeze-to-enable interval, affected provider/account IDs, known receipts, unknown outcomes, owner and reconciliation disposition |
| Rollback | Reason, decision time/owner, new-data recovery set ID/checksum, retention location, unresolved gaps and explicit `retain-isolated; no-merge; no-replay` decision |

Keep secret values, activation codes, message bodies and bank-transfer evidence
out of this record and operational logs. Reference protected recovery records
instead. The synthetic rehearsal's `codes` file represents code **audit**, not
plaintext codes.

## Cutover procedure (Q7)

1. **Prepare; stop if incomplete.** Start v2 with a fresh database and fresh keys;
   explicitly create memberships and reconnect capabilities. Keep all v2 sends
   and polls disabled. Create new provider apps and obtain required reviews;
   record new and old app IDs, intended account bindings, callbacks, DNS/proxy,
   webhook targets and owner-chosen switch time. No transferred v1 app, missing
   approval, missing gap owner or missing record may pass this gate. Do not
   populate v2 from a v1 snapshot, mail history, queue or secret store.
2. **Freeze v1 sends and polls.** Quiesce schedulers, queue workers, manual/API/MCP
   send paths and connected agents; account for in-flight calls and their
   receipts/unknown outcomes. Keep inbound routing recorded during the gap.
   `JEETA_JOBS_ENABLED=false` disables scheduled jobs only; it is not a complete
   sending fence. Check both installations have zero active senders/pollers
   before proceeding. Record the gap start and owner. Never replay an unknown
   external write to establish a supposedly clean boundary.
3. **Back up both systems; establish the archive.** Capture recoverable v1 and v2
   sets with schema/binary versions, database, local files and matching protected
   key custody. Use the completed M4 Task 8/9 runbooks and verify recovery before
   live acceptance. Capture an access-controlled, read-only v1 archive retained
   for **at least 90 elapsed days**. Enforce read-only storage/DB permissions,
   restrict readers, and record access and checksums. Keep the old runtime's
   retained state separate; the archive is never a runnable writable database.
4. **Verify new routing and identity; stop on failure.** Recheck reviews, granted
   scopes, approved callbacks, webhook verification/subscriptions and actual
   account identity for each intended capability. Evidence must match the
   recorded account, not merely a successful login. Keep both senders stopped
   if review, backup, callback, hook or account checks fail.
5. **Switch the single effective Meta webhook destination.** Follow the provider
   change record to replace old routing/subscriptions with the new reviewed
   app's routing. Record each change and verify the effective destination is v2
   only; do not fan out to both installations. Record other providers' hook
   changes and apply the recorded new proxy/DNS/callback bindings. A new app does
   not make simultaneous subscriptions safe. If verification fails, leave both
   senders stopped and use rollback below.
6. **Enable the v2 sender/poll owner once.** Verify v1 remains fenced and all
   incoming routing/bindings point to v2. Enable v2 once, record the gap end and
   inspect controlled owner-approved live sends/receipts. Retrying this step
   must not create another active sender. The owner reconciles the event gap
   using provider evidence and records unresolved events explicitly.

There is **no automatic exactly-once guarantee across installations**. Existing
per-installation deduplication and job locks do not coordinate v1 with v2. If a
pre-switch gate fails, keep v2 fenced; resuming v1 is an explicit owner decision
after verifying old routing and retained state. Never write to the archive.

## Rollback, in order

1. **Stop new sends and polls.** Fence all v2 external-write paths first, drain or
   account for in-flight work, and record the rollback gap start. Keep v1 stopped.
2. **Preserve all new data before any restore/routing change.** Retain v2 messages,
   payment evidence, code/grant audit, ledger and all other new records together
   with database/files/key recovery material. Do not restore over the new DB or
   run destructive migration downs. Account for late inbound writes: quiesce
   writes for a consistent recovery point or capture them and repeat preservation
   and the decision before continuing. The rehearsal rejects a stale snapshot.
3. **Record the owner's rollback decision.** Identify the preserved recovery set,
   new/isolated records, reason, timestamp, retained location, reconciliation owner
   and unresolved provider outcomes. With new data, no routing/resume step may
   proceed without this record. This baseline permits retention in isolated v2
   only; an instruction to discard, merge or replay blocks rollback progression
   until amended. Even an empty v2 needs a recorded decision.
4. **Re-point webhooks first.** Restore the recorded old effective destinations
   and subscriptions, including the single Meta destination. Confirm old routing
   and prevent dual delivery. Both senders remain stopped during this step.
5. **Restore proxy/DNS/callback bindings, then old sender ownership.** Verify the
   recorded v1 app/account and routing. Resume the old runtime from its retained
   state, separately from the read-only archive. Only then enable v1 sends/polls
   once; v2 stays isolated and stopped. Record the rollback gap end.
6. **Reconcile manually under the owner.** Preserve the new data and both gap
   records after rollback. Reconcile known provider receipts, payments and
   outstanding work explicitly; never merge v2 into v1 or replay unknown sends.
   Messages, publication evidence and domain ledger retain their indefinite
   retention rules; the v1 archive's 90-day minimum does not shorten them. Raw
   webhook bodies and probe runs keep their existing 30-day rules. At day 90,
   archive release requires an explicit owner decision and review of outstanding
   reconciliation/retention obligations; there is no automatic deletion.

## Any future selected import requires a separate amended dispatch

Q8 is binding. A request to reuse knowledge is not permission to copy v1 tables,
customer records, sealed credentials or sessions. Before any importer or seed
work, obtain owner approval and a controller-approved **separate amended
dispatch** specifying a field-level allowlist, consent/retention rules,
identity/ID mapping, dry-run reconciliation, and reversible up/down seeds.
The down step must be idempotent, remove only untouched imported rows by fixed
keys, and preserve operator/user/runtime edits. Verify up → down → up before
acceptance. This task adds no importer, migration endpoint, DB port or MCP tool.

## Run the synthetic rehearsal

From the repository root:

```sh
bash -n rust/scripts/tests/v1-cutover.sh
bash rust/scripts/tests/v1-cutover.sh
if command -v shellcheck >/dev/null; then
  shellcheck rust/scripts/tests/v1-cutover.sh
fi
```

The script uses Bash/coreutils, `mktemp -d` and trap cleanup. It creates two local
state directories, a private synthetic change record, frozen backups/archive,
and a recording fake provider with one webhook destination and append-only call
and transition logs. It has no network access, secrets or production side
effects. Time is modeled as elapsed days; file modes plus procedure access checks
model archive control (they do not certify production storage immutability).
Passing proves ordering and refusal behavior in this model, not provider review,
production deployment, real backup restoration or live cutover acceptance.

Each named case exercises successful operations and at least one refused unsafe
operation, checking rejection leaves state unchanged. Failures exit nonzero;
success prints one `PASS <name>` line per case:

| Check | Negative case(s) |
|---|---|
| `cutover_never_has_two_active_senders` | Enable before freeze/switch, duplicate enable, send through the disabled installation |
| `cutover_records_single_webhook_and_gap_owner` | Missing gap owner, duplicate webhook switch |
| `cutover_requires_new_reviewed_apps_and_owner_time` | Missing records/time/owner, reused app, pending review, wrong account, unverified hooks/callbacks, backup before freeze |
| `v1_archive_is_read_only_for_ninety_days` | Unauthorized read, writes, deletion at day 89, unauthorized release at day 90; resumed runtime cannot alter archive |
| `rollback_repoints_webhooks_before_old_sender_starts` | Repoint before stop/preservation/decision, restore bindings before hooks, enable old sender before restored bindings |
| `rollback_preserves_new_payment_and_messages` | Preserve while v2 runs, decide before preservation, use snapshot made stale by a late message |
| `new_data_requires_recorded_rollback_decision` | Missing/wrong-owner decision, discard/merge instruction |
| `fresh_start_imports_no_v1_secrets_or_history` | Import any excluded category, preflight with contaminated v2 storage |


## Leads-only owner amendment (2026-10-26)

Ruling: v1 is retained for its data; **only leads** may move from one v1 workspace
into one Rust workspace. This replaces Q8/C1's “imports nothing” rule only for leads.
The export allowlist is exactly `id`, `businessName`, `contactPerson`, `phone`,
`whatsapp`, `email`, `address`, `city`, `region`, `businessType`, `tableCount`,
`branchCount`, `currentSystem`, `source`, `status`, `lostReason`, `notes`,
`nextFollowUp`, `priority`, `customFields`, `emailOptOut`, `smsOptOut`, `waOptOut`,
`emailBouncedAt`, `createdAt`, `updatedAt`. Deleted and merged v1 leads are excluded.
No tokens, AI scores, İYS caches, assigned users, converted tenants, product
snapshots, messages, conversations, payments or historical events cross over.

Ruling: `contactPerson` becomes the display name and `businessName` the company;
creation time and v1 attribution are preserved. Phone and distinct WhatsApp numbers
share the domain's phone identity namespace (calls/SMS/WhatsApp); ten-digit local
numbers use TR, and the existing normalizer produces E.164 keys. Email uses the
existing trimmed, lowercase normalizer. Invalid identities are skipped and counted.
Stages map NEW→New, CONTACTED→Contacted, NOT_REACHABLE→Unreachable,
DEMO_SCHEDULED→Appointment, MEETING_DONE→Met, OFFER_SENT→Quoted, WAITING→Pending,
WON→Won, LOST→Lost. Won/Lost are closed at v1 `updatedAt`, without synthetic sale
events, commissions, quotes or appointments. Loss text is marked as imported.
No owner is assigned. v1 notes and nonempty auxiliary fields form one system note
per lead; empty notes are omitted. Only open journeys with a future `nextFollowUp`
get a `v1 takip` task. Prisma timestamps without a zone are interpreted as UTC.

Ruling: true `emailOptOut`, `smsOptOut`, `waOptOut` each create a **withdrawn**
consent with source **import**, effective at v1 `updatedAt`, plus a **manual**
suppression for email/SMS/WhatsApp respectively. `emailBouncedAt` adds an email
**bounce** suppression. False defaults never create explicit or implied consent.
These local withdrawals participate in the existing later consent-sync workflow;
the importer itself starts no jobs and makes no provider calls.

Ruling: UUIDv5 IDs use the destination workspace, v1 lead ID and entity kind.
Re-import skips recorded leads. Shared normalized identities coalesce onto an
unchanged imported person; the first person's name and company win. Duplicate
open leads reuse the existing open journey, preserving each original source/status
in provenance and keeping per-lead notes/tasks. Closed leads retain closed journeys.
Any normalized identity matching an erasure tombstone skips the entire lead
(`erased_skipped`), so old exports cannot recreate erased personal data.
Keys belonging to non-imported or touched people are skipped and counted; keys
bridging two imported people are never stolen. Reuse the identical protected export
for retries and rollback. Rollback treats each coalesced person as one aggregate:
it removes that person and only its import-created children when their stored
fingerprint still matches, with no conversations, merges, events, quotes,
appointments or other activity. Changed records are kept and counted for manual
review. A subsequent rollback is a no-op for removed aggregates.

Run these commands using a matching binary/schema. Run the export **on the v1
host** with a read-only database account; database passwords belong in protected
service/environment files, never command arguments. Synthetic IDs below must be
replaced with the two intended workspace IDs. The export remains outside the repo.

```sh
umask 077
psql -X -q -d service=jeeta_v1_readonly \
  -v v1_workspace_id=00000000-0000-0000-0000-000000000001 \
  -f /opt/jeeta/rust/scripts/v1-export-leads.sql > /root/v1-leads.jsonl
chmod 600 /root/v1-leads.jsonl
```

Securely transfer that file to `/root/v1-leads.jsonl` on the Rust host if needed.
Load `JEETA_DATABASE_URL` and `JEETA_SECRET_KEY` from the same protected environment
used by serve. The database role must be ordinary and subject to FORCE RLS.
The command checks exact migration versions/checksums before writes; it never
runs migrations, binds HTTP or starts provider clients. It refuses symlinks,
non-regular files, unknown fields, invalid statuses/timestamps, files over 256 MiB,
lines over 1 MiB and more than one million leads. Fix/re-export input without
printing its contents to logs. Report and error output contain only counts or
fixed categories.

```sh
set -a
. /etc/jeeta/jeeta.env
set +a
/opt/jeeta/jeeta import-v1-leads \
  --workspace 00000000-0000-0000-0000-000000000002 \
  --input /root/v1-leads.jsonl --dry-run
/opt/jeeta/jeeta import-v1-leads \
  --workspace 00000000-0000-0000-0000-000000000002 \
  --input /root/v1-leads.jsonl
```

Dry run executes the same repository writes as import in chunks of 100 leads,
then explicitly rolls back each transaction, releasing the workspace inbox lock
between chunks. Successful lead IDs, identity ownership and minimal person/open
journey context stay in memory; later chunks restore only needed parents rather
than replaying earlier leads. Constraints, indexes and RLS are exercised, and
counts match import against unchanged data. The counts-only ledger write is also
rehearsed and rolled back. It leaves **no durable rows, including no ledger entry**;
PostgreSQL sequences can advance on rolled-back inserts. Import
commits chunks of 100; a successful import or rollback appends one `import.v1_leads` counts-only ledger
entry by System `v1_import`. If interrupted after a chunk, retry the same file;
committed leads are skipped. Import markers are loaded once per run and rechecked
by primary key rather than scanning all people for every lead. A separate operator
session lock rejects overlapping import, dry-run or rollback commands for the same
workspace (`already_running`); retry after the active command ends. It reserves
one database connection, and chunk processing requires another. Ordinary inbox
work can proceed between chunks. Erasure and active
identity checks include shared-intake phone keys as well as TR-canonical keys;
new imported TR identities still use `+90` E.164. The shared normalizer now treats
ten-digit TR national numbers as `+90`; the importer also checks historical aliases
created before that fix. In both modes, normalized emails over 254 characters and
phones over 15 digits are skipped and counted as invalid identities.
Keep the original export until verification ends.
In the panel, select the destination workspace and verify people, companies,
normalized identities, stage counts, closed Won/Lost journeys, imported notes,
future follow-up tasks and channel withdrawals/suppressions. Confirm another
workspace has no imported rows. Retain only counts in the operational record.

If needed, roll back before operators or scheduled consent-sync jobs change the leads:

```sh
/opt/jeeta/jeeta import-v1-leads \
  --workspace 00000000-0000-0000-0000-000000000002 \
  --input /root/v1-leads.jsonl --rollback
```

Inspect the `rolled_back` and `kept` counts. Touched aggregates remain intact;
never delete them manually as part of this import rollback. After acceptance or
rollback review, shred both transferred and original export copies:

```sh
shred --remove /root/v1-leads.jsonl
```

Use the storage operator's deletion procedure for snapshots or copy-on-write
storage as well; keep exports out of backups and the repository.
