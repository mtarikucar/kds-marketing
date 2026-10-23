# M2b — Gelen Kutusu: E-posta, Uyum, Teklif/Randevu, Komisyon, Silme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend M2a with SMTP/IMAP, consent/İYS/suppression, quotes, internal appointments, human commissions, erasure and lead-gen intake on both surfaces.

**Architecture:** Extend jt_inbox, M2a consumer/outbox and tenant repos (0007); add jt_mail. Calendar availability/OAuth/events, HTML mail, webchat and the archive command are M2c; M2b appointments are internal with ICS email.

**Tech Stack:** M2a + lettre connection-level SMTP, async-imap/runtime-tokio over tokio-rustls, mailparse, manual VCALENDAR; mail libraries only in jt_mail.

**Spec:** design `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` §7.5–7.8, §10, K13; LOCAL 08-m2-inbox-prep.md (never commit); M1b ledger M2 GLOBAL CONSTRAINT, pre-rulings and revision rulings Q1–Q8/D9–D22/Gaps (latest M2a-1…3/M2b-1…3 controller rulings govern conflicts).

## Global Constraints

- All M2a constraints apply, including gates, reducer, idempotency, fences, RLS, reversible migrations, permissions, secret-free ledger and TR/EN twins.
- SMTP/IMAP sockets use tenant-authorized `connect_public(scope,host,port)` → `resolve_public(host,port)` under 10 s timeout → returned SocketAddr only, no second resolution. Refuse private/loopback/link-local/v4-mapped private answers before connect. TLS required: implicit 465/993 or STARTTLS 587/143, declared-host verification. Loopback only under test-loopback. Hosts enter connector_public.hosts; every connection checks tenant allowlist, retirement/rebind revokes access.
- Reuse M2a `SendIntent { Reply, Commercial }`: Reply requires same-conversation inbound ≤24h; Commercial requires latest effective explicit/implied_by_contract consent for person/contact-channel and no suppression, otherwise FORBIDDEN reason exactly IZIN_YOK. SMS commercial→iysfilter=1, Reply→0. Both enqueue/provider fences re-read consent/suppression.
- Every outbound, including ICS, uses M2a outbox queued→sending→sent|failed|unknown|refused and recovery timings. Stable Message-ID `<uuid@public-base-host>` is persisted before send; unknown is never automatically resent. DLR/IMAP Sent evidence reconciles it; SMS without a provider job ID stays unknown with no correlation (accepted M2b-1 limit). Provider I/O is lock-free; M2a-1 governs terminal-race success and request_key response reuse.
- Q4 retention supersedes earlier delete-person wording: keep person tombstone display_name “silinmiş kişi”, erased_at, scrub other personal fields; delete identities, remove personal text from messages/notes/events. Keep journey/event/commission IDs and amounts. Identity hashes prevent resurrection. Ledger stays append-only: mask personal keys at READ when payload.person_id is in erasure_log (ruling's “details” means actual column `payload`).
- file_ref is an opaque agent-owned reference; platform does not fetch/manage its asset; erasure forgets it. No catalogue/PDF/payment links/public booking. No claim that calendar functionality ships here.
- Paths relative to `rust/`. Each public use-case task owns catalog, HTTP `jt_panel_http/src/routes/inbox.rs`, MCP `jt_mcp/src/tools/inbox.rs`, dispatcher registration/shared schemas and parity tests. Connector extensions use existing connector adapters. System jobs add no public tools.

## Review Focus

1. Commercial SMS/mail without consent→IZIN_YOK before queue; T5.
2. Public hostname resolving private→probe refuses without opening socket; T3.
3. Erased identity replay/webhook/IMAP cannot recreate person; T8.
4. Same-key Won duplicates; another key on Won→Terminal CONFLICT; one commission; T7.
5. Withdrawal/bounce/complaint between queue and provider fence refuses send; T5.

---

### Task 0 (controller, before dispatch)

**Files:** `jt_app/src/ports/{connectors,mod}.rs`, registry, `jt_netgsm`, jobs, testkit and callers.

**Interfaces:** extend SmsSender and OutboundJobRepo; add application-owned MailSender/MailboxPoller and registry access. Mailbox polling does not use DeliveryReports::inbox; email sending uses MailSender, not MessagingSender. Cursor type `MailboxCursor` carries per-mailbox UIDVALIDITY/last_uid for INBOX and Sent; poll returns new cursor, caller persists atomically with drafts.
```rust
async fn send(&self, cred: &Credential, to: &str, text: &str, reference: Option<&str>, commercial: bool) -> Result<SendReceipt, ConnectorError>;
async fn poll(&self, cred: &Credential, public: &Value, cursor: &MailboxCursor) -> Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError>;
async fn pending_job_ids(&mut self, ws: WorkspaceId, capability_id: CapabilityId, limit: u32) -> Result<Vec<String>, AppError>;
async fn record_status(&mut self, ws: WorkspaceId, capability_id: CapabilityId, statuses: Vec<connectors::DeliveryStatus>) -> Result<(), AppError>;
```
M2b-1 adds the typed mail contract (credentials stay separate):
```rust
pub struct Attachment { pub filename: String, pub mime: String, pub bytes: Vec<u8> }
pub struct MailMessage {
    pub to: String, pub subject: String, pub text: String, pub message_id: String,
    pub in_reply_to: Option<String>, pub references: Vec<String>, pub attachments: Vec<Attachment>,
}
#[async_trait]
pub trait MailSender: Send + Sync {
    async fn send(&self, cred: &Credential, message: MailMessage) -> Result<SendReceipt, ConnectorError>;
}
```
NetGSM commercial→iysfilter; M2a Reply=false. netgsm_dlr_poll queries/records per capability. Unchanged ports:
```rust
async fn send_text(&self, cred: &Credential, public: &Value, recipient_id: &str, text: &str) -> Result<SendReceipt, ConnectorError>;
async fn report(&self, cred: &Credential, job_ids: &[String]) -> Result<Vec<DeliveryStatus>, ConnectorError>;
async fn inbox(&self, cred: &Credential, from: OffsetDateTime, to: OffsetDateTime) -> Result<Vec<InboundEventDraft>, ConnectorError>;
async fn fetch(&self, cred: &Credential, leadgen_id: &str) -> Result<LeadGenRecord, ConnectorError>;
async fn add(&self, cred: &Credential, rows: &[ConsentRow]) -> Result<SendReceipt, ConnectorError>;
```
`InboundEventDraft { external_id:String, kind:EventKind, payload:Value, occurred_at:Option<OffsetDateTime> }`; M2a SendReceipt has provider_id and optional cost_minor. Persist MailMessage metadata with the outbox before sending; ICS uses attachments. Attachment bytes never enter logs or ledger.

- [ ] Tests: `sms_commercial_iysfilter_mapping`, `dlr_never_crosses_capabilities`, `mail_message_metadata_and_attachment_contract`, poller/testkit contracts.
- [ ] Commit `feat(connector): commercial sms, typed mail and scoped polling ports`

### Task 1: Domain additions

**Files:** `jt_inbox/src/{consent,suppression,quote,appointment,commission,erasure}.rs`.
**Interfaces:** Consent{id,person_id,channel,kind:Explicit|ImpliedByContract|Withdrawn,source:Form|Agent|Import|IysSync|Customer,at,sync_state:Pending|Sent|Failed|FailedFinal,attempts}; effective = latest at per(person,contact-channel), not insertion order; equal-at ties choose Withdrawn (M2b-2). Suppression reason Unsubscribe|Bounce|Complaint|Manual. `commercial_allowed(consents:&[Consent],suppressions:&[Suppression],channel)->Result<(),IzinYok>`; fence gains suppressed/consent_ok/intent. Identity phone sharing does not collapse SMS/call consent channels.

Quote{journey_id,amount_minor,currency,valid_until,file_ref?,channel,state:Sent|Accepted|Expired}; ISO4217 validation. Appointment{journey_id,starts_at,ends_at,location,state:Booked|Held|Cancelled}; ends>starts. `ics(appointment,organizer_email,attendee_email,uid)->String`: VCALENDAR2, CRLF/escaped text/UTC times. Commission{journey_id,payee?,amount_minor,currency,rate_bp,state:NoPayee|Pending|Approved|Paid}; `commission_for(amount_minor,rate_bp)->i64` round_half_even(amount_minor*rate_bp/10000). `identity_hash(channel,normalized)->String`: SHA256 hex of scoped normalized identity.

- [ ] Tests: `older_grant_cannot_override_withdrawal`, `equal_at_withdrawn_wins_in_either_order`, `commercial_requires_consent_without_suppression`, `commission_rounds_half_even`, `ics_crlf_utc_escaping`, `quote_currency_validated`, `identity_hash_uses_account_scope`.
- [ ] Commit `feat(inbox): compliance, quote, appointment and commission rules`

### Task 2: Migration 0007, ports, repos, fakes

**Files:** `migrations/0007_inbox_compliance.{up,down}.sql`, inbox ports/TenantRepos, `jt_pg/src/repos/inbox/{consents,suppressions,quotes,appointments,commissions,erasure,outbound_jobs,mail_cursors}.rs`, testkit/tests.
**Interfaces/SQL:** eleven tenant tables, **36→47** (M2a now includes request_keys): consents (sync_state pending|sent|failed|failed_final, attempts); suppressions PK(workspace,person,channel,reason); quotes; appointments; commissions unique(workspace,journey); erasure_log(person_id,workspace_id,requested_via,at); erased_identities PK(workspace,channel,value_hash); outbound_jobs(capability_id,provider_job_id,message_id,state,last_status,timestamps) unique(workspace,capability,provider_job_id); mail_cursors PK(workspace,capability,mailbox) with uidvalidity/last_uid; **commission_default(workspace_id PK,rate_bp)** and **commission_user_rates(workspace_id,user_id,rate_bp,PK(workspace_id,user_id))**. No competing commission_rates table/expression PK. RLS/composite FKs and idempotent up/down as M2a. Retained person tombstone keeps financial FKs valid.

Widen 0005 inbound provider CHECK meta/netgsm/x to include mail in 0007; down restores the old CHECK only if no mail rows exist; otherwise retains the widened CHECK in place. This documented downgrade exception is idempotent and never deletes runtime mail events (M2b-3). Cursor+draft inserts share transaction. OutboundJobRepo replaces stub: pending queued/sent <72h, capability-scoped status updates. T8 non-ledger guards allow person-scoped DELETE/UPDATE when current_setting('jeeta.erasure', true) = 'on', set locally only in the erasure transaction; down restores the guards. Ledger trigger remains unchanged.

- [ ] Tests: `migration_round_trip_36_47_36_47`, `commission_unique_per_journey`, `dlr_capability_isolation`, `mail_cursor_and_drafts_atomic`, `mail_provider_check_restored_without_mail_rows`, `mail_provider_check_retained_with_mail_rows_down_idempotent`, RLS/fake contracts; T8 guard tests.
- [ ] Commit `feat(pg): inbox compliance and mailbox persistence`

### Task 3: Mail adapter

**Files:** `adapters/jt_mail/{Cargo.toml,src/{lib,socket,smtp,imap,parse,probe}.rs,tests/}`, `jt_outbound`, `jt_connector` Provider/Credential, deny/archtest allowlists.
**Interfaces:** add Provider::Mail, mailbox mapping; Credential::Mailbox{smtp_host,smtp_port,imap_host,imap_port,username,password,from_address,tls:Implicit|StartTls}, masked Debug/public redaction. `connect_public(scope,host,port)` uses existing EgressScope/allowlist before filtered SocketAddr connection. Probe: IMAP-authenticated username → facts.account_id; separately verify SMTP AUTH and MAIL FROM:<from_address> acceptance.

Implement MailSender and MailboxPoller T0; map MailMessage subject/text/Message-ID/thread headers and MIME attachments without regenerating message_id. INBOX and Sent polling uses UIDVALIDITY/UID, resets on changed validity; external_id `imap:<account>:<mailbox>:<uidvalidity>:<uid>` includes capability external account ID. Payload from/to/subject/text/message_id/in_reply_to/date, attachment names/sizes only. Sent echo correlates persisted Message-ID; DSN→EventKind::Status failed with original Message-ID; withdrawal→unit EventKind::Consent with withdrawn in payload. Post-DATA uncertainty→ConnectorError::Unknown; ICS travels as an Attachment with its filename/mime/bytes; keep attachment bodies out of diagnostics.

- [ ] Tests: `mail_socket_refuses_a_public_name_resolving_to_private_space`, `socket_checks_tenant_host_after_retirement`, `smtp_starttls_stable_message_id`, `mail_sender_preserves_thread_headers_and_ics_attachment`, `smtp_accepted_answer_lost_is_unknown`, `imap_account_mailbox_uid_dedupe`, `uidvalidity_reset`, `sent_echo_reconciles_unknown`, `probe_authenticated_username_and_authorized_sender`, `bounce_and_consent_payload_fixtures`, `tls_required`, `no_password_in_errors`.
- [ ] Commit `feat(mail): smtp and imap over authorized public sockets`

### Task 4: Mailbox flows and email inbox

**Files:** `usecases/connector.rs`, `usecases/inbox/{consumer,replies}.rs`, jobs/scheduler, connector HTTP/MCP/schema, panel ConnectPage, tests.
**Interfaces:** extend existing `connector.set_credentials`/`probe`, tools `jeeta.connector.set_credentials/probe`, POST `/api/connectors/credentials` / `/api/connectors/{capability_id}/probe`; same permissions/gates, no new catalog rows. Extend `inbox.reply`, POST `/api/inbox/conversations/{id}/reply`, `jeeta.inbox.reply` with optional request_key and email subject/threading, using MailSender::send(cred,MailMessage). `mail_inbox_poll` every 2 min uses MailboxPoller, account/capability public metadata, transactionally stores drafts+cursor then same consumer. Retirement/rebind revokes old hosts. Reconciliation invokes idempotent outbox results, including inbox.sent_after_terminal and terminal system-Replied no-op. SMS with no provider_job_id remains unknown; do not attempt reference lookup or resend.

- [ ] Tests: `mailbox_hosts_probe_and_retire_surface_parity`, `email_matches_normalized_identity`, `poll_crash_keeps_cursor_and_events_consistent`, `sent_evidence_applies_success_effect_once`, `unknown_sms_without_job_id_stays_unknown`.
- [ ] Commit `feat(inbox): mailbox flows and email channel`

### Task 5: Consent, İYS, suppression and commercial send

**Files:** `usecases/inbox/{consent,replies,consumer}.rs`, jobs/work, catalog/HTTP/MCP/schema and tests.
**Interfaces:** row/tool prefixes inbox./jeeta.inbox.; routes /api/inbox:

| Row | Tool | Route |
|---|---|---|
| consent.record | consent_record | POST /people/{person_id}/consents {channel,kind,source,at} |
| consent.list | consent_list | GET /people/{person_id}/consents (consents/suppressions) |
| suppressions.add | suppressions_add | POST /people/{person_id}/suppressions {channel,reason:manual} |
| suppressions.remove | suppressions_remove | DELETE /people/{person_id}/suppressions/{channel}/{reason} |
| send | send | POST /people/{person_id}/send {channel,text,intent,request_key?} |

Consent/read/send InboxWork; suppression mutation InboxManage. send Commercial-only, consent-gated, creates conversation through same outbox; reply gains Commercial. Optional request_key on send/reply reuses the M2a 24-h workspace response cache. Latest-at ordering protects withdrawal against delayed grants; equal-at Withdrawn wins. Hourly iys_sync calls `ConsentSync::add(cred,&[ConsentRow])` (MESAJ for SMS; withdrawals granted=false): pending→sent on success, failed + attempts on error; retry failed rows hourly up to 5 attempts, then failed_final and a human work item. Sent/failed_final are not retried. Lost acknowledgements can repeat provider submissions; no exactly-once guarantee. Consumer inbox@2 handles deferred Consent; NetGSM unit Consent payload and bounce/complaint add suppression. Ledger refusal reason IZIN_YOK; both fences fresh.

- [ ] Tests: `commercial_without_consent_refused`, `withdrawal_between_queue_and_send_refuses`, `iys_success_marks_sent_without_resubmission`, `iys_errors_retry_hourly_then_failed_final_human_work`, `send_request_key_reuses_response`, `late_grant_does_not_restore_consent`, `iys_hook_and_bounce_use_adapter_fixtures`, `reply_window_stays_bound`, surface parity.
- [ ] Commit `feat(inbox): consent ordering and commercial send fences`

### Task 6: Quotes and internal appointments

**Files:** `usecases/inbox/{quotes,appointments}.rs`, catalog/HTTP/MCP/schema, tests.
**Interfaces:** six InboxWork rows/tools: quotes.send/accept/list→jeeta.inbox.quotes_send/accept/list; POST/GET `/api/inbox/journeys/{journey_id}/quotes`, POST `/api/inbox/quotes/{id}/accept`. send {amount_minor,currency,valid_until,file_ref?,channel,text,intent,request_key?} reuses M2a request_keys for 24 h; repeats return the stored response without another quote/send. New requests store quote and durable send; quote_sent only on evidenced success, using outbox-correlated idempotency; accept→quote_accepted, expired refuses. file_ref stays opaque, no platform asset deletion promise.

appointments.book/cancel/held→jeeta.inbox.appointments_book/cancel/held; POST `/api/inbox/journeys/{journey_id}/appointments` {starts_at,ends_at,location,intent}, POST `/api/inbox/appointments/{id}/cancel|held`. Book reports appointment_booked and creates automatic TaskDue reminder **1 h before**; held→meeting_held. Optional verified-mailbox/email-identity ICS is a MailMessage Attachment through MailSender, with explicit intent and SAME outbox/fences/recovery; refused/unknown email ledgered, never bypass consent as “best effort”.

- [ ] Tests: `quote_unknown_defers_quote_sent_until_evidence`, `quote_request_key_returns_same_quote_and_response`, `quote_accept_moves_pending`, `expired_quote_refused`, `appointment_ics_uses_both_fences`, `appointment_reminder_one_hour_before`, surface parity.
- [ ] Commit `feat(inbox): quotes and appointments`

### Task 7: Commissions

**Files:** `usecases/inbox/{commissions,journeys}.rs`, catalog/HTTP/MCP/schema, panel/tests.
**Interfaces:** consume CommissionDue inside won transaction; human journey owner at won is payee; missing→NoPayee, never payable, follow-up unassigned. Override table beats workspace default; snapshot rate/amount, round half even. Four rows/tools commissions.list/approve/pay→jeeta.inbox.commissions_list/approve/pay and commission_rates.set→jeeta.inbox.commission_rates_set. GET `/api/inbox/commissions?state&payee`, POST `/api/inbox/commissions/{id}/approve|pay`, PUT `/api/inbox/commission-rates` {user_id?,rate_bp}; list InboxWork, mutations InboxManage with owner/manager approval/payment, Pending→Approved→Paid only.

- [ ] Tests: `duplicate_won_one_commission`, `different_key_on_won_terminal`, `no_payee_unassigned_followup`, `override_beats_default`, `approve_then_pay_order`, transactional rollback/surface parity.
- [ ] Commit `feat(inbox): human commissions`

### Task 8: Erasure and replay protection

**Files:** `usecases/inbox/erasure.rs`, consumer, Pg erasure repos/0007 guards, `jt_pg/src/repos/ledger.rs` READ masking, catalog/HTTP/MCP/schema, panel/tests.
**Interfaces:** `inbox.people.erase(ctx,person_id,{confirm:true})`, tool `jeeta.inbox.people_erase`, POST `/api/inbox/people/{person_id}/erase`, InboxManage/Destructive, confirm list. Atomically tombstone person/identity hashes+erasure_log, delete identities and personal message/note/event text, retain anonymized journey/event/commission IDs+amounts. Forget quote file_ref; purge appointment personal fields and queued body/recipient data. Replay hash check precedes matching, increments erased_identity_drop.

Inventory explicitly includes raw delivery batches, parsed inbound payloads, merge snapshots, journey payloads, tasks, messages/notes, quote/appointment text, outbox/jobs and probe facts where person-linked. Inside the erasure use-case transaction only, execute `SET LOCAL jeeta.erasure = 'on'`; non-ledger append-only triggers check `current_setting('jeeta.erasure', true) = 'on'` AND that each affected row belongs to the erased person before permitting DELETE/UPDATE. Null the raw column for that workspace's inbound events referencing the person, including their stored raw batch; preserve unrelated rows and other people's parsed data. RLS/person predicates still apply, the flag expires at transaction end, and ordinary append-only enforcement remains. Ledger physical rows untouched: all ledger read surfaces mask name/phone/email/body/text for payload.person_id in erasure_log. Preserve financial/statistical references to tombstone, never dangling FKs.

- [ ] Tests: `erase_keeps_anonymous_ids_amounts_and_tombstone`, `replay_and_imap_cannot_resurrect`, `ledger_storage_unchanged_reads_masked`, `erasure_nulls_matching_raw_preserves_unrelated_parsed_data`, `erasure_flag_is_transaction_local_and_person_scoped`, `ordinary_append_only_still_enforced`, `erase_requires_confirm_manage`, surface parity.
- [ ] Commit `feat(inbox): erasure with read masking and replay protection`

### Task 9: Lead-gen intake

**Files:** `usecases/inbox/{leadgen,consumer}.rs`, adapter-generated fixture tests.
**Interfaces:** system inbox@2 consumer, no new public row; M2a people_get/journeys_get display results. `LeadGenFetcher::fetch(cred,leadgen_id)` returns LeadGenRecord.fields (BTreeMap<String,Vec<String>>), not field_data. Map email/phone through single match_or_create; a non-message split→CONFLICT identity_split with both person IDs and a merge suggestion, retry with one identity (M2a-3); Source::MetaAds for new first touch, existing person gains later touch; initial New journey only as applicable under terminal rules; follow-up TaskDue in 1 h. Claim/effects/ledger atomic and replay-idempotent.

- [ ] Tests: `leadgen_adapter_fields_create_meta_ads_person_and_task`, `leadgen_existing_person_preserves_first_touch`, `deferred_leadgen_reclaimed_once`, `leadgen_failure_rolls_back_claim`, `leadgen_split_returns_conflict_ids_and_merge_suggestion`.
- [ ] Commit `feat(inbox): lead-gen intake`

### Task 10: Panel, architecture and documentation

**Files:** panel consent/quote/appointment/commissions/erase/connect flows, archtests, README, spec finalized blocks §7.5/7.6/7.8/10.
**Interfaces:** shared-schema forms, typed erase confirm. Twin count T5=5 + T6=6 + T7=4 + T8=1 = **16 new; 90+16=106**. merges.undo already confirmed in M2a, add people.erase. Preserve pending/context exemptions; mail/domain/app allowlists; sockets only through outbound. Document Q4 retention, conditional CHECK downgrade, unknown-SMS/no-exactly-once limits and M2c archive/calendar/HTML/webchat scope; no erase/lost/archive parity claim.

- [ ] Tests: `mail_crate_has_no_direct_dns_or_connect` (supplementary grep plus T3 socket tests), catalog/gate/confirm/schema parity, panel consent/erase forms, full workspace checks per README.
- [ ] Commit `docs(rust): M2b inbox compliance and email`; coordinator integrates, no worker push.

## Ruling applied

Q1→T1/T3/T9 + M2a T1/T4; Q2→T7/T9 + M2a T2/T7; Q3→T4/T6 + M2a T6; Q4→T2/T8; Q5→M2a T8 + T7 no_payee; Q6→M2a T5; Q7→T1/T2/T5; Q8→M2a T8. D9→T5/T9 + M2a T3/T7; D10→T2/T8; D11→T0/T3 + M2a T0; D12→T0/T2/T4; D13→T2/T3/T4; D14→M2a T2; D15→T3/T5/T9; D16→M2a T4; D17→M2a T3/T4; D18→M2a T1/T3/T5; D19→M2a T4/T6; D20→T2/T10; D21→T4–T8/T10; D22→M2a T2/T10. D10/D15 are T004 defect IDs, absent as separate ruling paragraphs.

Gaps: quote file_ref→T6/T8; reminder→T6; calendar/HTML/webchat/archive→M2c scope; acquisition/person-created/first-touch→T9+M2a T1/T4/T5; unsnooze/timezones/lost-label/tasks/status-label/work view→M2a T4–T8. Pre-rulings inherited via M2a, especially send intent/reconciliation→T0/T4–T6; M2 GLOBAL CONSTRAINT→T3.


M2a-1→T2/T4/T5/T6 + M2a T2/T3/T6 (request_keys changes totals to 23→36→47); M2a-2→M2a T3; M2a-3→T9 + M2a T4/T7. M2b-1→T0/T3/T4/T6; M2b-2→T1/T2/T5; M2b-3→T2/T8/T10.

## Controller decisions

- M2b-1: MailSender carries persisted headers/body/ICS attachments; SMS without a provider job ID remains unknown, without correlation.
- M2b-2: equal-at Withdrawn wins; hourly retries stop at five attempts with failed_final and human work. No exactly-once İYS claim.
- M2b-3: person-scoped erasure uses transaction-local jeeta.erasure and nulls matching inbound raw; retain widened CHECK on downgrade if mail rows remain. Archive is M2c.
