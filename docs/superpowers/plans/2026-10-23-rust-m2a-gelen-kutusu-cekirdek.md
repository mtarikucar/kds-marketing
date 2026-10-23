# M2a — Gelen Kutusu Çekirdeği Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build people, identities, conversations, messages, reducer-owned journeys, executor handover, fenced replies, tasks/notes, merge/undo, inbound consumption and the three-column inbox on both surfaces.

**Architecture:** Pure domain `jt_inbox`; application use cases over tenant repos; migration 0006 with FORCE RLS; independently tracked inbound consumption; durable outbound sends through M1b connectors. Email, quotes, appointments, consent, commissions and erasure are M2b; calendar providers, HTML mail, webchat and archive are M2c.

**Tech Stack:** M0–M1b: Rust 1.96, axum 0.8, sqlx 0.8.6/Postgres, rmcp 3.6, React. Own E.164 normalisation, no new HTTP client.

**Spec:** `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` §7, §4.2–§4.5, §10–11; LOCAL `docs/reports/v2-reference/rust-rewrite-research/08-m2-inbox-prep.md` M2-01…M2-20 (never commit); binding M1b ledger M2 pre-rulings, revision rulings Q1–Q8/D9–D22/Gaps and M2 GLOBAL CONSTRAINT. Later controller rulings M2a-1…3/M2b-1…3 govern conflicting earlier prose.

## Global Constraints

- M0–M1b constraints continue: hexagonal boundaries, dependency allowlists, reversible idempotent up/down migrations/seeds, tenant `workspace_id`, ENABLE/FORCE RLS, composite FKs, structured errors, mutation ledger without personal bodies/secrets, English code/MCP, Turkish panel with TR/EN parity, cargo-deny.
- All `inbox.*` rows are strategy-Gated except `inbox.pending`/`inbox.context` (Exempt). The system consumer has no principal and never loses inbound data to that gate. `inbox.` remains subject to the workspace status gate.
- Only `reduce` constructs a `Transition`; all journey INSERT/UPDATE paths use domain-produced state. Partial unique index permits one open journey/person. Won never reopens; Lost requires `reopened`, not a fresh journey. Human reopen requires owner/manager and `InboxManage` (never `TeamManage`).
- Identity channels: shared `phone` for SMS/WhatsApp/calls, `email`, account-scoped `instagram_dm|messenger|webchat`. Only `active` identities match; unique `(workspace_id, channel, value_normalized) WHERE active`. Acquisition `Source` is separate. A merge preserves the keeper's first touch.
- Default executor Agent; `Executor { Agent, Human { user_id: Option<UserId> } }`, None = unassigned human queue. Every change increments `executor_generation: u32`. Owner for commission is separate. Q5 supersedes pre-ruling 3's departed-member agent fallback: departure → Human{None}, open journeys unassigned, ledgered. Lost inbound specifically uses Human{None} (Q2).
- Two send fences check lost, erased/merged, live capability, generation, agent/human executor, Reply window (same conversation inbound within 24 h); M2b adds suppression/consent. Human reply is allowed regardless of holder and never changes executor. Provider I/O holds no locks; terminal-race success stays Sent and ledgers inbox.sent_after_terminal. Unknown delivery is never blindly resent; M2b records the SMS-without-job-id reconciliation limit.
- Required client event idempotency key is unique/workspace; duplicate suppresses effects and ledgers `inbox.event.duplicate`. Consumer identity is `(workspace, provider, external_id)`, independently of `events.ack`.
- `Permission::{InboxWork, InboxManage}` keys `inbox.work|inbox.manage`; owner/manager both, Rep work, custom roles unchanged. New-workspace defaults and existing-role backfill both change. Agents inherit issuer grants except explicit `take_over` exception: tool exists, agents receive `VALIDATION("executor must be a person")`.
- Every user use-case task implements/registers panel HTTP handlers, MCP dispatchers and shared schemas in the M1a pattern, not merely catalog rows; `to_json` parity tests required. Task tables below use `inbox.` row prefixes and `jeeta.inbox.` tool prefixes. Jobs alone have no new public row.

## Review Focus

1. Lost inbound retains Lost, reopens Ours/Human{None}, derives reopen_question; agent send refused; no second journey → T4/T6/T7/T8.
2. Concurrent first contacts for one identity yield one person/journey and one conversation/capability → T3/T7.
3. Takeover or loss between enqueue and provider fence refuses; crash after possible acceptance never resends → T6.
4. Same-key Won is duplicate; different-key Won on Won is Terminal CONFLICT; provider replay has no duplicate effects → T4/T7 (commission M2b).
5. Two open journeys prevent automatic merge; undo restores collisions but refuses keeper edits after merge → T5.

## File structure

Paths below are relative to `rust/`. Domain: `crates/domain/jt_inbox/src/{lib,ids,identity,person,conversation,message,journey,fence,merge,task,note}.rs`; IDs: PersonId, IdentityId, ConversationId, MessageId, JourneyId, JourneyEventId, TaskId, NoteId, MergeId. Ports: `crates/jt_app/src/ports/inbox.rs`, `ports/mod.rs`/TenantRepos. Use cases: `crates/jt_app/src/usecases/inbox/`. SQL/repos: `migrations/0006_inbox.{up,down}.sql`, `crates/adapters/jt_pg/src/repos/inbox/`. Each surface-owning task edits `crates/adapters/jt_panel_http/src/routes/inbox.rs`, `crates/adapters/jt_mcp/src/tools/inbox.rs`, registrations and `crates/jt_app/src/catalog.rs`; tests under each crate's `tests/`. Panel: `panel/src/pages/Inbox*.tsx`, `api/inbox.ts`, copy. Jobs: `usecases/jobs.rs`, `bin/jeeta/src/scheduler.rs`. Architecture tests: `crates/jt_archtest/tests/`.

---

### Task 0 (controller, before dispatch)

**Files:** `crates/domain/jt_connector/src/error.rs`, `crates/jt_app/src/ports/connectors.rs`, sending adapters and testkit fixtures; domain MsgStatus contract owned by T1.

**Interfaces:** add `ConnectorError::Unknown { reason: String }` for writes that may have reached a provider; use the existing non_exhaustive/redacting-constructor pattern and map post-write transport failures accordingly. Extend `SendReceipt { provider_id: String, cost_minor: Option<i64> }`; unknown cost stays None. T1 includes `MsgStatus::Unknown`. Preserve real M1b sending signatures:
```rust
async fn send_text(&self, cred: &Credential, public: &Value, recipient_id: &str, text: &str) -> Result<SendReceipt, ConnectorError>; // MessagingSender
async fn send(&self, cred: &Credential, to: &str, text: &str, reference: Option<&str>) -> Result<SendReceipt, ConnectorError>; // SmsSender (M2b T0 adds commercial)
```
- [ ] Tests: `post_write_transport_failure_is_unknown`, `send_receipt_unknown_cost_is_none`, adapter/testkit contract tests; update every receipt constructor and error match.
- [ ] Commit `feat(connector): uncertain send outcomes and optional cost`

### Task 1: Domain — identities, people, conversations, messages

**Files:** `crates/domain/jt_inbox/{Cargo.toml,src/{lib,ids,identity,person,conversation,message}.rs}`, workspace manifest; `jt_archtest/tests/dependency_boundaries.rs` (domain + app allowlists).

**Interfaces:** `Channel { WhatsApp, InstagramDm, Messenger, Sms, Email, Webchat, Phone }` is the contact channel; `IdentityChannel { Phone, Email, InstagramDm, Messenger, Webchat }` is the identity key. `channel_for_kind(kind_key: &str) -> Option<Channel>` maps whatsapp_cloud/instagram_dm/messenger/sms_line/mailbox/webchat/netgsm_pbx. `normalise(channel: IdentityChannel, raw: &str) -> Result<String, IdentityError>`: TR phone variants (`0532…`, `90532…`→`+90532…`) → E.164, international '+' retained, 8–15 digits; email trim/lowercase/single @; opaque IDs preserved after trim, empty invalid. Scope opaque storage as `<capability external_id>:<opaque id>` before matching, uniqueness or tombstoning; phone channels all use IdentityChannel::Phone.

`Identity { id, workspace_id, person_id, channel, value_normalized, value_display, active, first_seen_at }`; `Source { Channel(Channel), MetaAds, Import, Form, Repeat }`; `FirstTouch { source: Source, capability_id: Option<CapabilityId>, at }`; Person includes display_name, company, first_touch, merged_into, erased_at, created_at/updated_at. Keep event actor separate as `EventSource { System, Agent, Human(UserId) }`.

Conversation is person × capability, with kind_key, `ConvState { Open, Ours, Theirs, Snoozed { until }, Closed }`, Executor, generation, inbound/outbound timestamps. `reopen_on_inbound(&mut self, now) -> bool` → Ours, clears snooze; `on_outbound(&mut self, now)` → Theirs, clears snooze; `snooze(until)`, `unsnooze()` → Ours; `take_over(user) -> u32`, `hand_to_agent() -> u32`. Message carries direction, `Author { Customer, Agent, Human(UserId), System }`, body, external_id, `MsgStatus { Received, Queued, Sent, Delivered, Failed, Unknown, Refused { reason } }`, optional cost_minor, at. Serde snake_case/tolerant storage as M1a.

- [ ] Tests: `phone_channels_share_one_identity`, `phone_variants_normalise_to_one_e164`, `email_normalises_case_and_space`, `opaque_ids_are_account_scoped`, `channel_for_every_messaging_kind`, `inbound_and_outbound_clear_snooze`, `executor_changes_bump_generation`, serde round trips.
- [ ] Commit `feat(inbox): identities, people, conversations and messages`

### Task 2: Domain — reducer, fence, merge rules, tasks and notes

**Files:** `jt_inbox/src/{journey,fence,merge,task,note}.rs`.

**Interfaces:** Journey holds status, owner, opened_at/closed_at, lost_reason, unreachable_attempts, source and updated_at. `JourneyStatus { New, Contacted, Unreachable, Appointment, Met, Quoted, Pending, Won, Lost }`; `JourneyEventKind { MessageReceived, Replied, CallMade { connected: bool }, AppointmentBooked, MeetingHeld, QuoteSent, QuoteAccepted, Won { product: String, amount_minor: i64, currency: String }, Lost { reason_key: String }, Snoozed { until }, Reopened, Merged { target: PersonId } }`; events carry EventSource, required idempotency_key, at, payload and lost-reason label snapshot.

`pub fn reduce(j: &Journey, e: &JourneyEvent, policy: &ReducePolicy) -> Result<Transition, ReduceError>`; `ReducePolicy { unreachable_threshold: u8 }` default 3; `ReduceError { Terminal, NotAllowed(&'static str), Duplicate }`, no Backwards. Transition fields private, constructor domain-only, read-only accessors, no public deserialization bypass; it returns the full reducer-owned state patch (status, attempts, closed_at, lost_reason) and effects. Rank New=0, Contacted=Unreachable=1, Appointment=2, Met=3, Quoted=4, Pending=5; Won/Lost outside ranks. Failed calls increment attempts and enter Unreachable only from rank ≤1 at threshold. Successful contact resets attempts and maps New/Unreachable→Contacted. Lower-rank milestones keep status while applying effects. Only authorized Reopened takes Lost→Contacted and clears closure/reason/attempts; Won never reopens. MessageReceived on Lost preserves Lost plus ConversationOurs; post-Won inbound is routed to a new Repeat journey by T7. System-sourced Replied on Won/Lost returns an unchanged patch with no effects and no error (M2a-1); other terminal-changing events refuse. Duplicate detection precedes reduction.

Effects: MessageReceived→ConversationOurs; nonterminal Replied→ConversationTheirs; AppointmentBooked/MeetingHeld/QuoteSent/QuoteAccepted advance by rank; Won→CommissionDue{amount_minor,currency}+CloseTasks+closure; Lost→CloseConversations+CancelOpenTasks+closure; Snoozed→ConversationSnoozed; Merged preserves status. `FenceCtx` includes latest/open journey status, person_erased/person_merged, conversation_state, expected/current_generation, executor_is_agent, capability_live; `may_send(ctx: &FenceCtx, by_agent: bool) -> Result<(), FenceRefusal>` refuses JourneyLost/PersonErased/PersonMerged/ExecutorChanged/HumanHoldsConversation/CapabilityDown. Reply-window validation is T6.

`decide_merge(a: &PersonView, b: &PersonView) -> MergeDecision`: Auto keeps older person only if ≤1 open journey and no differing nonempty display_name/email/phone/company; otherwise Suggest(conflicts), including two_open_journeys. Task: journey_id/title/due_at/assignee?/Open|Done|Cancelled; Note: journey_id/author/text/at.

- [ ] Tests: `reducer_table_matches_spec`, `failed_calls_never_regress_advanced_stages`, `equal_rank_success_recovers_unreachable`, `reopen_clears_full_patch`, `lost_inbound_only_changes_conversation`, `won_is_terminal_even_for_reopen`, `system_replied_on_won_or_lost_is_noop`, `lower_rank_events_keep_status_apply_effects`, `fence_refuses_lost_erased_merged_generation_and_agent_human_hold`, `merge_auto_requires_no_conflicts`.
- [ ] Commit `feat(inbox): journey reducer, fence, merge rules and tasks`

### Task 3: Migration 0006, ports, Postgres repos, fakes

**Files:** 0006 pair, `ports/inbox.rs`, TenantRepos, `jt_pg/src/repos/inbox/{people,identities,conversations,messages,journeys,tasks_notes,merges,consumption,lost_reasons,outbox,request_keys}.rs`, testkit, `jt_tenancy/src/role.rs`, workspace creation, Pg migration/RLS tests.

**Interfaces/SQL:** thirteen tables total, **23→36** (T6 outbox and M2a-1 request_keys included; supersedes D20’s earlier count). All tenant-scoped with composite FKs; IDs unique with workspace where referenced. `people` stores T1 fields; `identities` has active bool default true and ONLY the active partial unique index; `conversations` unique(workspace,person,capability), snoozed_until and executor kind/user/generation; `messages` unique(workspace,conversation,external_id) WHERE external_id IS NOT NULL; `journeys` unique(workspace,person) WHERE closed_at IS NULL; `journey_events` append-only, unique(workspace,idempotency_key), payload/from_status/to_status; `tasks`, `notes`; `merges` holds source/target/decision/conflicts/status/moved snapshot/at/applied_by/undone_at; `lost_reasons(workspace_id,key,label,active,seeded)` PK(workspace,key); `event_consumption(workspace_id,consumer,event_id,consumed_at,outcome)` composite PK; T6 `outbox`; `request_keys(workspace_id,key,response jsonb,at timestamptz)` PK(workspace_id,key), tenant RLS. A key is unique per workspace for 24 h; expired entries may be replaced atomically.

Lost-reason keys `fiyat,zaman,rakip,ulasilamadi,ilgisiz,diger`: idempotent 0006 existing-workspace backfill plus workspace-creation initialization, seeded=true. 0006 down drops lost_reasons like the other schema tables. Preserving edited/runtime seeded rows applies only to future data-only migrations, not this schema rollback (M2a-2). No first-use seeding. Add InboxWork/InboxManage parse/key/all; backfill system roles reversibly and change SystemRole::Rep defaults; custom grants preserved.

Ports: `PersonRepo { insert, get, lock, find_by_identity(channel, normalized), search, mark_merged, set_erased }`; `IdentityRepo { insert, list, deactivate_for, move_to }` (active only); `ConversationRepo { get, lock, find(person,capability), upsert_on_inbound, update_state/executor, list }`; `MessageRepo { insert_if_new -> Option<MessageId>, list, set_status }`; `JourneyRepo { open_for, latest_for, lock, insert, apply_transition(id, Transition, event), get, events }`, no direct status setter; TaskRepo/NoteRepo/MergeRepo/LostReasonRepo; RequestKeyRepo for 24-h response lookup/storage shared by reply/send/quotes.send. `ConsumptionRepo { try_claim(consumer,event_id) -> bool, record(consumer,event_id,outcome) }` operates inside the same transaction as effects.

Add tenant `list_for_consumer(consumer, cursor, limit)` to inbound repo: ordered `(received_at,id)`, exclude this consumer's completed/deferred claims BEFORE limit, ignore processed_at entirely. Page cursor is traversal-only, restart next sweep so rollback failures remain eligible. Deferred namespaced `inbox@1` rows can be claimed by `inbox@2`; global domain keys still suppress effects already applied.

- [ ] Tests: `migration_round_trip_23_36_23_36`, `lost_defaults_existing_and_new_workspaces`, `schema_down_drops_lost_reasons`, `request_keys_workspace_scope_and_24h_expiry`, `identity_unique_among_active_rows`, `one_open_journey_per_person_index`, `journey_events_append_only`, `consumer_filters_before_limit_ignores_ack`, RLS/composite-FK tests, `role_backfill_and_new_rep_defaults`, repo fake contracts.
- [ ] Commit `feat(pg): inbox tables, repos, defaults and permissions`

### Task 4: Use cases — people, identities, journeys, dictionaries

**Files:** `usecases/inbox/{mod,people,journeys}.rs`, workspace policy, catalog, HTTP/MCP adapters and registrations, tests.

**Interfaces:** shared `match_or_create` for every creation path. Own-channel match wins; email/phone resolving to different people → attach to message's own-channel person and Suggest(identity_split), never silently merge. For non-message people.create or lead-gen, split email/phone → CONFLICT identity_split with both person IDs and a merge suggestion; caller retries with one identity (M2a-3). Add subsequent touches without rewriting first touch; atomic person + initial journey + identities + exactly one person-created ledger entry. Resolve merged aliases to keeper; erased identities cannot recreate people (M2b tombstones).

All following rows have tools listed without `jeeta.inbox.` and routes without `/api/inbox`; InboxWork unless noted:

| Row | Tool | Panel route / contract |
|---|---|---|
| people.search | people_search | GET /people?q&limit → Vec<PersonOut> |
| people.get | people_get | GET /people/{person_id} → person,identities,open_journey,conversations |
| people.create | people_create | POST /people {display_name,identities,source:Source} → person,created |
| identities.add | identities_add | POST /people/{person_id}/identities {channel,value,capability_id?} → added/merge_suggested/merged_into |
| journeys.open | journeys_open | POST /people/{person_id}/journeys → JourneyOut; open→CONFLICT, latest Lost→CONFLICT reopen_required, Won→Repeat |
| events.report | events_report | POST /journeys/{journey_id}/events {kind,idempotency_key,payload} → transition,effects |
| lost_reasons.list | lost_reasons_list | GET /lost-reasons; InboxWork |
| lost_reasons.set | lost_reasons_set | PUT /lost-reasons {key,label,active}; InboxManage, last active cannot deactivate |
| journeys.get | journeys_get | GET /journeys/{journey_id} → journey,events tail 50,tasks,notes |
| journeys.assign_owner | journeys_assign_owner | POST /journeys/{journey_id}/owner {user_id?}; InboxManage |
| status_labels.set | status_labels_set | PUT /status-labels {labels}; InboxManage, policy-stored labels for fixed status keys only |

`events.report` allows only call_made, appointment_booked, meeting_held, quote_accepted, won, lost, snoozed, reopened. replied/message_received/quote_sent/merged are system-only; actor/source derived from principal. Missing key→VALIDATION. Reopened requires InboxManage + owner/manager. Lost requires active dictionary key and copies its label onto the event. Lock and reduce, persist full patch/effects/ledger atomically. Same-key duplicate has no side effects; another Won key on Won→Terminal CONFLICT. Won never provisions a product.

- [ ] Tests: `create_matches_existing_identity`, `identity_split_suggests_without_stealing`, `create_identity_split_returns_both_ids_and_suggestion`, `first_touch_and_person_created_once`, `merged_alias_resolves_keeper`, `open_refuses_latest_lost`, `report_effect_failure_rolls_back`, `duplicate_suppresses_effects`, `external_system_event_or_missing_key_rejected`, `lost_label_survives_relabel`, `reopen_needs_manage_and_role`, `second_won_new_key_is_terminal`, `status_labels_cannot_add_status`, HTTP/MCP schema/effect parity.
- [ ] Commit `feat(inbox): people, journeys, events and dictionaries`

### Task 5: Use cases — merge/undo, tasks, notes

**Files:** `usecases/inbox/{merge,tasks}.rs`, catalog, HTTP/MCP adapters/registrations, confirm archtest, tests.

**Interfaces:** rows/tools `merges.list/apply/undo/refuse` → `merges_list/apply/undo/refuse`; GET `/api/inbox/merges`, POST `/api/inbox/merges/{merge_id}/apply|undo|refuse`. InboxManage; apply {keep:PersonId}, undo {confirm:true} Destructive. Lock both people; refuse two open journeys; move identities/journeys/tasks/notes and coalesce same-capability conversations keeping older conversation. Active identity model throughout: deactivate redundant rows, move live rows, restore original active flags on undo. Keeper keeps own first touch. Snapshot every moved entity (table,id,original parent), original conversation state/executor/generation and coalesced message IDs. Undo ≤30 days restores snapshot; keeper person/journey/conversation updated_at > merge.at → CONFLICT edited_after_merge. Child mutations update owning aggregate timestamps. No silent loss of colliding messages.

InboxWork rows `tasks.create/complete/list`, `notes.add`; tools `tasks_create/complete/list`, `notes_add`; POST `/api/inbox/journeys/{journey_id}/tasks` {title,due_at,assignee?}, POST `/api/inbox/tasks/{task_id}/complete`, GET `/api/inbox/tasks?queue=due_24h|overdue|all&assignee`, POST `/api/inbox/journeys/{journey_id}/notes` {text}. due_24h = now through +24h, overdue = before now, all has no time cap.

- [ ] Tests: `merge_snapshot_restores_conversation_collisions`, `merge_refuses_two_open_journeys`, `undo_restores_active_identities`, `undo_refuses_after_thirty_days_or_aggregate_edit`, `undo_requires_confirm`, `keeper_first_touch_preserved`, `tasks_due_24h_overdue_all_boundaries`, `notes_never_in_ledger_payload`, route/tool parity. Add merges.undo to destructive confirm list now.
- [ ] Commit `feat(inbox): reversible merges, tasks and notes`

### Task 6: Use cases — conversations, executor, snooze and durable reply

**Files:** `usecases/inbox/{conversations,replies}.rs`, OutboxRepo/RequestKeyRepo, 0006 outbox/request_keys, jobs/scheduler, catalog, HTTP/MCP adapters/registrations, tests.

**Interfaces:** InboxWork rows/tools/routes (prefix `/api/inbox`): conversations.list/get → conversations_list/get, GET `/conversations` (ours|unassigned|snoozed|all,cursor) / `/conversations/{id}`; messages.list → messages_list, GET `/conversations/{id}/messages?cursor`. take_over/hand_to_agent/snooze/unsnooze/close → same tool suffix, POST `/conversations/{id}/take-over|hand-to-agent|snooze|unsnooze|close`; snooze {until} reports snoozed, unsnooze clears timestamp → Ours. take_over agent principal→VALIDATION("executor must be a person"). Human reply never implicitly takes over.

`inbox.reply(ctx, conversation_id, {text,intent,request_key?}) -> ReplyOut {message_id,state}`; tool `jeeta.inbox.reply`, POST `/api/inbox/conversations/{id}/reply`. `SendIntent { Reply, Commercial }` defined here; M2a accepts Reply only, Commercial→VALIDATION until M2b. Reply inbound age ≤24h else FORBIDDEN reply_window_closed. Agent cannot send while human executor holds or latest journey Lost; human holder never disables a human reply, other fences still apply.

Outbox stores id/workspace/conversation/message/capability/intent/expected_generation/fence_snapshot/state/attempts/last_error/created_at/updated_at. Optional request_key uses T3 request_keys: repeat within 24 h returns the stored response without another send. This same workspace-wide contract applies to M2b inbox.send and inbox.quotes.send on both surfaces. States **queued→sending→sent|failed|unknown|refused**. Tx A: fence 1 + queued message/outbox, commit. Tx B: lock **conversation→journey→outbox**, fence 2 with fresh state, mark sending and snapshot journey.updated_at, conversation generation and person state; commit and release every lock. Provider I/O runs lock-free. Tx C re-locks in the same order and records result + system replied with key `outbox:<id>` atomically. Success Sent includes provider_id/cost_minor; ConnectorError::Unknown→Unknown, definite failure→Failed, fence refusal→Refused. Use exact T0 ports; SMS reference correlates outbox. Nonterminal success moves conversation Theirs and clears snooze. If the journey became terminal during I/O, keep the message Sent, ledger `inbox.sent_after_terminal`, and apply system Replied as a reducer no-op; never undo terminal status or close/cancel effects. Unknown stores no success effect until evidence establishes acceptance; replaying result uses the same event key. DLR/IMAP-sent reconciliation is M2b.

`outbox_recover` every minute: sending older than 2 min→unknown, never resend; queued older than 5 min→send step. Concurrent workers claim under lock. Competing inbox mutations use the same lock order; none holds a lock across provider I/O. Tx C and later evidence reconciliation use the terminal no-op rule, so a late success cannot trigger a resend or reducer error.

- [ ] Tests: `executor_change_between_enqueue_and_send_refuses`, `lost_between_enqueue_and_send_refuses`, `human_reply_ignores_holder`, `reply_window_24h_timezone_boundary`, `successful_send_atomically_records_replied`, `result_replay_has_one_effect`, `provider_io_holds_no_locks`, `sent_after_terminal_is_ledgered_without_transition`, `reply_request_key_returns_stored_response`, `crash_after_provider_write_becomes_unknown_never_resends`, `abandoned_queue_recovers_once`, `sms_optional_cost`, `unsnooze_and_outbound_clear_snooze`, HTTP/MCP parity.
- [ ] Commit `feat(inbox): executor, snooze and durable fenced replies`

### Task 7: Inbound event consumer

**Files:** `usecases/inbox/consumer.rs`, jobs/scheduler (`inbox_consume` every 10 s, lock `jeeta.jobs.inbox_consume`), provider-produced fixtures, fake/Pg tests.

**Interfaces/behaviour:** system-only, no panel/MCP row; active/pending_payment workspaces; `list_for_consumer("inbox@1",cursor,100)`. Claim + all domain effects + completion in ONE transaction; crash/error rolls back claim/effects, redacted warn and continue batch. Manual `events.ack` is seen-only; do not use list_pending or mark_processed for domain completion. Deferred LeadGen/Consent/Unknown and unrouted capability=None produce no person; deferred outcomes can be reconsidered by inbox@2. Same provider event/domain keys remain idempotent across consumer versions.

Decode actual adapter payloads: WhatsApp `message.from`, Messenger/IG `messaging.sender.id`, NetGSM normalized `from` (not mandatory ceptel). Resolve capability kind/account scope, shared phone/email matching and identity_split. Message→match_or_create→conversation→insert_if_new (external_id = provider message ID)→message_received key `inbound:<event_id>`. Lost attaches to latest Lost, preserves status, Ours/Human{None}, generation change, derived reopen_question. Won auto-opens NEW Repeat journey, preserving person's first touch. MessageEcho matches our external ID or stores System outbound; Status updates Delivered/Failed; CallEvent correlates by NetGSM unique_id. Inbound_call/Answer only touch conversation activity; at Hangup emit call_made key `call:<unique_id>`, connected iff an Answer was seen in that call’s persisted inbound lifecycle. Once Hangup decides, late events are duplicates and cannot revise the result or count another attempt. Check erased/tombstoned identities before matching in M2b.

- [ ] Tests: `adapter_payloads_decode_without_invented_json`, `two_concurrent_first_messages_one_person_journey`, `duplicate_provider_event_consumed_once`, `lost_inbound_unassigned_human`, `won_inbound_opens_repeat`, `manual_ack_does_not_skip_consumption`, `deferred_reclaimed_by_next_version`, `claim_effect_completion_rollback_and_retry`, `failure_does_not_starve_later_events`, `unrouted_event_does_not_create_person`, `call_lifecycle_one_attempt`, `hangup_connected_iff_answer_seen`, `late_pbx_events_are_duplicates`.
- [ ] Commit `feat(inbox): transactional inbound consumer`

### Task 8: Pending/context, work views, SLA and snooze jobs

**Files:** `usecases/inbox/context.rs`, `usecases/{work,jobs}.rs`, membership departure hook, WorkspacePolicy, scheduler, catalog, HTTP/MCP adapters/registrations, tests.

**Interfaces:** `inbox.pending(ctx) -> PendingOut {ours,reopen_questions,merges,tasks_due}`; tool `jeeta.inbox.pending`, GET `/api/inbox/pending`. `inbox.context(ctx,conversation_id) -> ContextOut {person,journey,open_tasks,recent_conversations,strategy_guidance,prohibitions}`; tool `jeeta.inbox.context`, GET `/api/inbox/conversations/{id}/context`. Both InboxWork, strategy-Exempt. Same-person recent conversations only (last 3 messages each); events tail 10. `strategy_guidance` = live strategy summary + segment names/descriptions + hypotheses targeting conversation channel; None without strategy, no per-person segment assignment. Prohibitions include lost, human-held-for-agent (M2b consent).

`work.pending` is a derived view, no push or notification dedupe required: ReplyDue priority 2, ReopenQuestion 2, MergeSuggested 3, TaskDue 3. Visibility follows executor; Human{None} uses unassigned queue. `response_sla` every minute, policy `max_response_s` per channel (WhatsApp/IG/Messenger 900, SMS 3600), stale Ours/Agent→Human{journey owner or None}, bump generation, ledger once. Departed executor→Human{None}, affected open journeys owner=None, ledger; no-payee follow-up is unassigned. `snooze_wake` every minute reopens elapsed snoozes Ours once. Policy also holds unreachable_threshold (3) and fixed-key status labels.

- [ ] Tests: `context_only_same_person_and_channel_hypotheses`, `pending_filters_executor_and_unassigned`, `sla_handover_owner_or_none_ledgers_once`, `departure_unassigns_executor_and_journeys`, `snooze_wake_timezone_boundary_once`, `work_pending_is_derived_and_preserves_status_gating`, HTTP/MCP parity.
- [ ] Commit `feat(inbox): pending, context and handover jobs`

### Task 9: Three-column panel

**Files:** `panel/src/pages/{InboxPage,InboxConversation,InboxJourneyPanel,InboxMerges}.tsx`, `api/inbox.ts`, HomePage, TR/EN copy/tests.

**Interfaces:** T4–T8 shared schemas. Left queues Bizde/Atanmamış/Ertelenmiş/Hepsi and search; thread with executor badge, takeover/hand-back, reply, snooze/unsnooze; journey timeline with source icons, customizable status labels, report-event forms, lost reason dictionary, owner, tasks/notes, merge/apply/refuse/undo. Lost inbound asks “Yeniden aç?” for managers/owners. Human reply is never disabled because another human holds it. Show actual fence reasons; mobile columns stack.

- [ ] Tests: `human_holder_does_not_disable_panel_reply`, `event_forms_match_tool_schema`, `merge_banner_and_confirm`, `queue_switching_and_unsnooze`, TR/EN parity.
- [ ] Commit `feat(panel): inbox queues, conversations and journey panel`

### Task 10: Architecture, documentation and smoke

**Files:** `jt_archtest/tests/{inbox_rules,twin_rule,gate_rule,dependency_boundaries}.rs`, README, spec implementation blocks §7.2–7.4/7.7, `make smoke-inbox`.

**Interfaces:** Structural architecture checks cover EVERY journey INSERT/UPDATE path and Transition construction (private fields/domain constructor); SQL/lock grep heuristics supplementary only. Dependency allowlists include jt_inbox and jt_app edge. Twin count: T4=11, T5=8, T6=9, T8=2 → **30 new, 60+30=90**. Assert actual catalog count; pending/context gate exemptions and merges.undo confirm list. Smoke: scripted connector→consumer→reply→events; no live providers.

- [ ] Tests: `inbox_status_written_only_by_reducer`, `forged_transition_bypass_injection_rejected`, `single_match_or_create_definition`, `panel_mcp_consumer_effect_parity`, catalog/schema/gate/confirm tests, smoke-inbox; run workspace/panel checks per README.
- [ ] Commit `docs(rust): M2a inbox core`; coordinator handles integration, no worker push.

## Ruling applied

Q1→T1/T4/T7; Q2→T2/T4/T7; Q3→T6; Q4→M2b T2/T8 (T3 tombstone-ready person); Q5→T1/T6/T7/T8; Q6→T5; Q7→M2b T1/T5; Q8→T8. D9→T3/T7; D10→M2b T2/T8; D11→T0/T1/T6; D12→M2b T0/T2/T4; D13→M2b T2/T3/T4; D14→T2; D15→T7 + M2b T3/T9; D16→T4; D17→T3/T4; D18→T1/T3/T5; D19→T4/T6/T9; D20→T3/T10 + M2b T2; D21→T3–T8/T10; D22→T2/T10. D10/D15 refer to T004 findings (no separate numbered paragraph in rulings).

Gaps→T1/T6/T8 unsnooze/timezones/outbound clearing; T1/T4/T5 acquisition/first touch/person-created ledger; T4 lost-label snapshot/status labels; T5 queue due_24h|overdue|all; T8 derived work; M2b T6/T8 opaque quote refs/reminders; scope above defers calendar/HTML/webchat/archive to M2c. Pre-rulings 1–5→T2/T4/T5/T7/T8/T6 respectively, subject to Q2/Q5 revisions. M2-01…20 coverage follows these task owners; erasure/commissions/quotes remain M2b.


M2a-1→T2/T3/T6 (request_keys changes counts to 23→36; M2b 36→47); M2a-2→T3; M2a-3→T4/T7 + M2b T9. M2b-1→M2b T0/T3/T4/T6; M2b-2→M2b T1/T5; M2b-3→M2b T2/T8/T10.

## Controller decisions

- M2a-1: lock-free provider I/O, durable fence snapshot, terminal success ledger/no-op reducer, and optional 24-h request_key response reuse are specified in T2/T3/T6.
- M2a-2: 0006 down drops lost_reasons; edited-row preservation is for future data-only migrations.
- M2a-3: Hangup decides call:<unique_id>; late PBX events duplicate. Non-message identity splits return both IDs and a merge suggestion with CONFLICT; retry with one identity.
