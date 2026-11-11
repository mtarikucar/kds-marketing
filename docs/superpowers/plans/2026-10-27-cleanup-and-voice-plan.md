# Cleanup + voice + TikTok/LinkedIn — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, task by task, tests first. Checkbox syntax tracks progress.
> Specs: `docs/superpowers/specs/2026-10-27-agent-voice-calls-design.md` (V-tasks), `2026-10-27-tiktok-linkedin-connectors-design.md` (S-tasks). Format follows `2026-10-23-rust-m4-urunlestirme.md`. Paths relative to `rust/` unless prefixed `docs/`. Every file:line below was verified on 2026-10-27 at 7513c253 (branch `feat/rust-panel-money-inputs`); re-verify after rebase.

**Goal:** (1) close the real defects found in the staging walkthrough, (2) let the connected agent place, hold and finish phone calls through NetGSM with nothing thinking on the server, (3) add TikTok and LinkedIn as first-class connectors. Everything ships inert behind capabilities/env until the owner enables what §Checklist names.

**Global constraints** (unchanged from M4): hexagonal boundaries; catalog rows, handlers, permissions, status gates and exact-set tests change together (`crates/jt_app/tests/catalog.rs:261` pins 144 rows); migrations are repeatable `up`/`down` pairs with ENABLE/FORCE RLS on every tenant table (`crates/jt_archtest/tests/sql_scoping.rs:277`); no provider or LLM key on the platform; English identifiers, Turkish panel copy with TR/EN parity; never log tokens, bodies or phone numbers; no push/deploy from a worker. Fast loop per task: write the named failing tests → run the crate's tests → implement → rerun; once per run `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`, `pnpm --dir panel test` when the panel is touched. Rust does not build on Windows: CI on Linux is the check.

## 0. Order, and why

1. **C1–C3 first (≈ 1 day).** Three small defects with safety weight: probe failures lose their reason and one error kind would violate a CHECK (C1); the PBX recording/linkup policy keys are unreachable (C2, a V0 prerequisite); every new workspace auto-publishes agent-submitted pieces to real accounts (C3, one default + a seed, owner decision D2). They touch files V0 touches anyway.
2. **V0 → V1 → V2 (voice) next**, as the owner asked. V0 needs no purchase and no sidecar and is the data model for everything after. V1 waits only for Gate V1 (owner, one hour) — the Rust side can be built against the recorded fixtures meanwhile.
3. **S1–S3 (TikTok, LinkedIn) in parallel with V1 on a second worker.** They are new adapter crates with no file overlap with voice except the shared registration lists (`provider.rs`, `fixed_hosts.rs`, `connectors.rs`, `oauth_kind_schema`, panel lists), which S1 owns. Their long pole is not code but app review: the owner's portal checklist (spec §2/§3) should start **today**.
4. **C4–C6 after**: timestamp serde (cross-cutting, needs a 24-h deploy note), "deferred is final", Bitwarden hardening. C7 (Facebook comments) stays in the backlog with its app-review dependency.

Migration names (renumber to the merge order; the names are the contract): `0013_probe_reason`, `0014_voice_calls`, `0015_social_providers`, `0016_studio_approval_default` (only if D2 = yes).

## Review focus

1. A call must never be dialed without the fence passing **again inside the dial transaction** (consent/suppression/hours/cap/budget) → V0-T3 `fence_reevaluated_before_dial`, V1-T3 `bridge_dial_only_after_fence`.
2. A silent or disconnected agent must end the call by script, never leave a caller hanging → V1-T2 `agent_silence_plays_holding_then_fallback_then_closes`, `agent_disconnect_ends_by_script`.
3. The server composes no sentence: every played text is in the plan or the policy → V1-T2 `every_played_text_is_authored`.
4. Phone numbers never reach logs, ledger payloads or MCP outputs unmasked → V0-T2 `outputs_mask_e164`, V1-T4 `bridge_events_never_logged_with_numbers`.
5. Stored Studio rows with tuple timestamps still decode after the serde change → C4-T1 `stored_tuple_rows_still_decode`.
6. Unaudited TikTok apps never post privately by accident, and LinkedIn refuses org flows before CMA → S2-T3 `public_privacy_refused_when_not_offered`, S3-T1 `page_flow_refused_without_org_scopes`.

---

## C. Cleanups (verified)

### C1: Probe failures persist a reason; `unknown` is a legal `error_kind`

**Verified:** `probe_runs` has `ok, error_kind, latency_ms, facts` only, `error_kind` CHECK `in ('auth','permission','throttle','transient','permanent')` (`migrations/0005_connectors.up.sql:122-134`). `ProbeRun::from_result` keeps only `e.kind()` (`crates/jt_app/src/ports/mod.rs:1373-1377`); `apply_probe` writes `connector_public.health = {ok, at, latency_ms, error_kind}` (`crates/jt_app/src/usecases/connector.rs:2158-2163`); the reason exists only in the returned `ProbeOut.result.error_reason` (:2212), which `set_credentials` (:1685, :1813), mailbox paths (:1660, :1778), `confirm_assets` (:737) and the jobs (`usecases/jobs.rs:395, 560`) discard. The panel declares `error_reason` (`panel/src/api/types.ts:845`) and never renders it; `ConnectPage.tsx:191-201`, `CapabilitiesPage.tsx:84-104`, `ConnectorHealthBadge.tsx:35-37` show one fixed sentence per kind (`i18n/tr.json:916-922`). **Latent CHECK violation:** `ConnectorError::Unknown.kind()` is `"unknown"` (`crates/domain/jt_connector/src/error.rs:120`), not in the CHECK; `ProbeRun::from_result` would write it and the insert would fail the whole probe/`set_credentials`. Not reachable today only because adapters return `Unknown` for writes alone (`jt_meta/src/graph.rs:616-617`). `ProbeRunRepo::list/latest` have no production caller except the purge (`jobs.rs:877-884`).

- **Files:** `migrations/0013_probe_reason.{up,down}.sql` (add `reason text` ≤ 300, extend CHECK with `unknown`; down drops the column and restores the CHECK only when no `unknown` rows exist); `ports/mod.rs` `ProbeRun{reason: Option<String>}`; `jt_pg/src/repos/probe_runs.rs` insert/read; `usecases/connector.rs` `apply_probe` (health gains `reason`, built with `failure::failure_reason(Some(provider), e)`), `health()` → `ConnectorHealth{reason}`; `jt_testkit/src/fakes/connector.rs:31` kind list; `panel/src/lib/connectors.ts:87` `ERROR_KINDS` + `unknown` copy; `ConnectPage.tsx` Result card, `CapabilitiesPage.tsx` ProbeDialog, `ConnectorHealthBadge.tsx` show the reason line under the kind sentence (title attribute + text, `tr.json`/`en.json`).
- **Tests first:** `jt_pg/tests/probe_runs.rs::unknown_kind_is_storable_with_reason`; `jt_app/tests/connector.rs::probe_failure_reason_is_persisted_and_served_by_health`; `jt_app/tests/connector.rs::set_credentials_failure_keeps_reason_in_health`; panel `ConnectPage.test.tsx::shows_probe_reason_line`.
- **Acceptance:** `jeeta.connector.health` and `GET /api/connectors/health` carry `reason` (≤ 300 chars, redacted line); the panel shows it; a probe returning `Unknown` is stored, not errored; migration round-trips up→down→up.
- **Risk:** low. Reason text comes from redacting constructors only; assert no secret substring in the test.

### C2: PBX call policy keys are unreachable (`call_mode`, `recording_allowed`)

**Verified:** the adapter reads `public["call_mode"]` and `public["recording_allowed"] == true` (`crates/adapters/jt_netgsm/src/santral.rs:60-83,114-160`), but no use case or panel writes them (grep in `crates/jt_app/src`, `crates/adapters/jt_panel_http/src`, `panel/src`: no hits); `connected_public` writes provider/name/hosts/access/asset only (`usecases/connector.rs:2399`). Effect: recording can never be enabled, `linkup` can never be chosen.

- **Files:** `usecases/connector.rs` new `set_pbx_policy(capability_id, {call_mode: originate|linkup, recording_allowed: bool})` writing into `connector_public` under capability lock (merge, never replace), ledger `connector.pbx_policy_set`; catalog row `connector.set_pbx_policy` (twin, Write, `capabilities.manage`), MCP tool `jeeta.connector.set_pbx_policy`, route `PUT /api/connectors/{capability_id}/pbx-policy`; `jt_mcp/src/tools/connector.rs`; `jt_panel_http/src/routes/mod.rs`; panel: NetGSM PBX capability card toggle + mode select (`CapabilitiesPage.tsx`, `api/connectors.ts`, i18n); catalog count 144 → 145.
- **Tests first:** `jt_app/tests/connector.rs::pbx_policy_is_written_into_connector_public_and_read_by_adapter` (uses the scripted telephony fake asserting the `public` it receives); `jt_mcp/tests/connector_mcp.rs::set_pbx_policy_tool`; `jt_app/tests/catalog.rs` count; panel test.
- **Acceptance:** after setting `recording_allowed=true`, the NetGSM fake receives `caller_record=1`; `linkup` mode changes the verb; a non-PBX capability is `CONFLICT`.
- **Risk:** low. V0-T1 depends on it (recording announcement gate).

### C3: Studio lanes default to no human approval (owner decision D2)

**Verified:** `LaneControl::requires_human_approval` defaults `false` (`crates/domain/jt_studio/src/control.rs:21-25`); `lock_control` lazily inserts empty lanes (`jt_pg/src/repos/studio/control.rs:57-69`); migration seeds `lanes '{}'` (`0009_studio.up.sql:278-279`); the effective policy treats a missing lane as no approval (`usecases/studio/chain.rs:201-209`); `publish_due` claims any Ready organic slot and publishes (`publish.rs:117,174,194-197,264-266`; `jt_pg/.../queue.rs:18` has no approval check); `smoke_studio.rs:100-128` proves publish with no `policy_set`/`approve`. Paid lane sends budget moves immediately (`ads.rs:452-462`). Nothing sets an approval default (onboarding mentions strategy only, `OnboardingPage.tsx:30,43`).

- **Recommendation:** new workspaces start with `requires_human_approval: true` on **both** lanes; the agent sees `StudioApproval` work items and the panel's approve button; the owner flips to autopilot with `jeeta.studio.policy_set` once content quality is trusted. Existing workspaces that have **never published** (no `studio_publications` row) get the same seed; workspaces with publications keep their current behaviour.
- **Files:** `usecases/studio/control.rs` (or `jt_pg/.../control.rs:57-69`): the lazy insert seeds `{organic:{requires_human_approval:true}, paid:{requires_human_approval:true}}` (brake off); `migrations/0016_studio_approval_default.{up,down}.sql` data migration for `lanes = '{}'` AND no publications (down removes only rows it set, tracked by a `seeded_by_migration` key in the JSON); panel `StudioToday.tsx:184,311,321` fallback `?? false` → read the server value, no fallback; onboarding checklist line "Studio is in approval mode" (`OnboardingPage.tsx`); setup readiness item; `jt_testkit/src/fakes/studio.rs:141`.
- **Tests first:** `jt_app/tests/studio_control.rs::new_workspace_requires_approval_on_both_lanes`; `smoke_studio.rs` adjusted: publish needs `studio.approve` first (keep one explicit autopilot test that sets the policy off); `jt_pg/tests/migrations.rs` round-trip; panel test for the toggle initial state.
- **Acceptance:** a fresh workspace's Ready piece is listed as `studio_approval` work and not published until approved; `policy_set(false)` restores today's behaviour.
- **Risk:** medium (behaviour change for agents running autonomously; only for never-published workspaces). Blocked on D2.

### C4: Studio timestamps serialize as `time` tuples (MCP + panel), stored as tuples

**Verified:** `time` has no `serde-human-readable` feature (`Cargo.toml:75`); 16 timestamp fields in `#[derive(Serialize)]` structs lack `rfc3339` serde: `control.rs:14`, `measurement.rs:34,48,53,57`, `paid.rs:20,71,147,152,154,201`, `publication.rs:30,113,115`, `slot.rs:23`, `trend.rs:19`, plus `jt_app/src/ports/files.rs:15-17` (`StoredFile`); `jt_capability` uses `with = "time::serde::rfc3339"` (`capability.rs:88,108`). MCP serialises domain structs directly (`jt_mcp/src/tools/mod.rs:79-84`, `tools/studio.rs:146-232`; wrappers embed domain types: `views.rs:33-43`, `work.rs:25-33,47-53`, `learning.rs:33-36,60`, `ads.rs:51-52`, `control.rs:41-45`); the panel routes return the same (`jt_panel_http/src/routes/studio.rs:17,48,56,82,121,131,158,174`). **Storage is the same JSON:** `jt_pg/src/repos/studio/mod.rs:23-28` encodes with `serde_json::to_value` into `studio_slots.data`, `studio_pieces.data` (approval), `studio_publish_attempts.data`, `studio_publications.data`, `studio_adset_bindings.{data,control}`, `studio_measurements.data`, `studio_trends.data`, `studio_spend_reservations.data`, `studio_budget_moves.data`, `studio_files.data`, `studio_request_keys.response` (migration `0009_studio.up.sql:31,49,61,71,88,90,99,126,132,141,44,153`); request-key `payload_digest` hashes the encoded payload (`mod.rs:32-34,58`), and ledger payloads carry tuples (`planner.rs:268`, `ads.rs:679`). Panel decodes tuples in `panel/src/api/studio.ts:197-205` (`instant`), used by `StudioPlan.tsx:23,37,55,56`. Other domains: 0 unannotated fields in `jt_inbox`, `jt_strategy`, `jt_ledger`.

- **Decision:** no DTO layer. Add a **tolerant serde module** `jt_studio::time_compat` (`serialize` → RFC 3339; `deserialize` accepts an RFC 3339 string **or** the 9-tuple; `option`, `date` (string or `[year, ordinal]`), and a `window` helper for `(ODT, ODT)`), applied to every field above and to `StoredFile`. Stored tuple rows keep decoding; new writes are RFC 3339; MCP/panel outputs become RFC 3339 at once.
- **Request keys:** a key created before deploy and replayed after it digests differently → `409 request key payload mismatch` for ≤ 24 h (`studio_request_keys` TTL). Document in the deploy note; the agent already treats CONFLICT as "do not retry blindly". Do **not** try to version the digest.
- **Files:** `crates/domain/jt_studio/src/time_compat.rs` + attributes on the 16 fields; `jt_app/src/ports/files.rs:15-17`; `panel/src/api/studio.ts` keep `instant()` tolerant (comment: legacy ledger payloads) and fix the budget-move state type (`:38` → `'succeeded'|'failed'|'refused'|'cancelled'`, from `jt_studio/src/paid.rs:56-64`); README MCP output note.
- **Tests first:** `jt_studio/tests/time_compat.rs::{round_trips_rfc3339, decodes_legacy_tuple, decodes_legacy_date_tuple, option_and_window}`; `jt_pg/tests/studio_storage.rs::stored_tuple_rows_still_decode` (insert a raw tuple JSON row via sqlx, read through the repo); `jt_mcp/tests/studio_mcp.rs::slot_get_scheduled_at_is_rfc3339`; `jt_panel_http` studio route test asserting a string; panel `studio.test.ts::instant_accepts_both`.
- **Acceptance:** every Studio MCP/panel timestamp is an RFC 3339 string; all pre-existing rows decode; `cargo test` green; deploy note merged into `docs/operations/deployment.md`.
- **Risk:** medium (touches every Studio read path). Mitigated by the tolerant reader and the raw-row test.

### C5: "Deferred" consumption is final

**Verified:** `consume_event` records outcome `deferred` (`usecases/inbox/consumer.rs:131-140`) and `list_for_consumer` re-lists only deferred Meta `lead_gen` (`jt_pg/src/repos/events.rs:100`). Consequences: a call on a `Lost` journey, deferred "until a coordinator decision" (`consumer.rs:733-741`), is dropped forever with no work item; NetGSM events that arrive while zero or several matching capabilities are live (`usecases/webhook.rs:246-249` → `consumer.rs:163-165`) are never attached, even after the capability connects; NetGSM `voice-report`/`autocall-report` `Status` and `cdr` events are never consumed (`consumer.rs:237-249,711-713`).

- **Files:** `jt_pg/src/repos/events.rs` re-list deferred rows of every provider with a backoff column (`deferred_until`, next = 1 h × attempts, cap 24 h, stop after 7 days → outcome `abandoned` + ledger `inbox.event.abandoned`); `consumer.rs`: a deferred call on a Lost journey creates a `ReopenQuestion` work item (reuse `WorkKind::ReopenQuestion`, `work.rs`) instead of silence; `cdr`/`Status` handling moves to V0-T4. Migration: a nullable column on `inbound_events` (fold into `0014_voice_calls` or its own `0013b`; keep repeatable).
- **Tests first:** `jt_app/tests/inbox_consumer.rs::{deferred_event_is_retried_with_backoff, deferred_is_abandoned_after_seven_days, call_on_lost_journey_raises_reopen_question, netgsm_event_attaches_after_capability_connects}`.
- **Acceptance:** `work.pending` shows the reopen question; a NetGSM event received before the PBX capability existed is consumed within one hour of connecting.
- **Risk:** medium (consumer loop); keep per-run caps.

### C6: Password managers autofill provider credential fields

**Verified:** every credential input already has `autoComplete={secret ? 'new-password' : 'off'}`, `data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type="other"`, no `name` (`panel/src/pages/ConnectPage.tsx:90-122`); all four forms are real `<form noValidate autoComplete="off">` with a submit (`:297,:356,:385,:430`) and a `type="password"` input right after a user-code/user-name text input — the exact login-form heuristic Bitwarden's page-load autofill keys on; `data-bwignore` only suppresses Bitwarden's inline menu, not page-load/shortcut fill. Cannot be proven in code; the staging observation stands.

- **Files:** `ConnectPage.tsx` `TextField`: secret inputs render `type="text"` with `className` masking (`-webkit-text-security: disc` in `index.css`, with a show/hide toggle for accessibility), `readOnly` until focus (`onFocus` clears it) — both defeat page-load heuristics; forms become `<div role="form">` with an explicit submit handler (Enter via `onKeyDown`); keep all ignore attributes; `Field.tsx`/`Input.tsx` unchanged.
- **Tests first:** `ConnectPage.test.tsx::{secret_inputs_are_not_type_password, secret_input_is_readonly_until_focus, enter_submits_netgsm_form}`; manual check with Bitwarden on staging recorded in the PR.
- **Acceptance:** no `input[type=password]` in the connect forms; submit still works by button and Enter; Bitwarden on staging no longer fills.
- **Risk:** low; UX of masking toggle.

### C7 (backlog): `review_facebook` / Facebook comments ingestion

**Verified:** feature gap, not a bug. Hidden by `NOT_CONNECTABLE` (`panel/src/lib/connectors.ts:19`, applied `:27-29`, `ConnectPage.tsx:497`, `CapabilityCard.tsx:27`); MCP text says "cannot be connected yet" (`jt_mcp/src/tools/connector.rs:51-52`); Meta page subscription is `messages,message_echoes,messaging_postbacks,message_reactions,leadgen` (`jt_meta/src/oauth.rs:44-45`), the parser keeps only `leadgen` from Page changes (`jt_meta/src/webhook.rs:389`), `EventKind` has no comment/review variant (`jt_connector/src/event.rs:22-38`). Label mismatch: EN "Facebook reviews" vs. code comment "comments" (`en.json:744`).

- **Needs before code:** Meta app review for `pages_manage_engagement` + `pages_read_user_content` (comments) and `pages_read_engagement`; `feed` field subscription. Then: `EventKind::Comment`, parser for `changes[].value{item: comment, comment_id, post_id, from, message}`, inbox conversation per comment thread on `facebook_page`, reply via `POST /{comment_id}/comments`. Rename the kind label to "Facebook yorumları/comments" consistently. Not scheduled.

---

## V. Voice (spec `2026-10-27-agent-voice-calls-design.md`)

### V0-T1: `jt_calls` domain — session state machine, plan, policy, fence

- **Files:** new crate `crates/domain/jt_calls` (`Cargo.toml` member + workspace dep; `jt_archtest` domain allowlist), `src/{lib,session,plan,policy,fence,timers}.rs`.
- **Interfaces:** spec §5 (`CallSession`, `CallState`, `EndCause`, `RefusalReason`, `CallPlan`, `Turn`, `CallMetrics`, `CallPolicy`); `fence_call(FenceInput) -> Result<(), RefusalReason>` where `FenceInput{purpose, consents, suppressions, latest_journey_status, person_erased, person_merged, has_phone_identity, relationship: RelationshipEvidence{won, recent_appointment_or_quote, open_appointment, inbound_call_within_7d}, hours_ok, calls_today, daily_cap, budget_remaining_minor, per_minute_minor, bridge_online, bridge_busy, disclosure_present}`; `next_timer(&CallSession, now, &CallPolicy) -> TimerAction`; `reduce(&mut CallSession, BridgeEvent, now) -> Vec<Command>`. All timestamps `time::serde::rfc3339`.
- **Tests first:** `jt_calls/tests/fence.rs` matrix (purpose × consent kind × suppression × journey × hours × cap × budget × bridge × disclosure; every `RefusalReason` reached once); `tests/timers.rs::{holding_at_4s, holding_again_at_10s, fallback_at_20s, closing_when_fallbacks_exhausted, caller_silence_reprompt, max_duration_closes}`; `tests/session.rs` reducer per event (ringing→answered→utterance→say→hangup; `agent_timeout`; `transferred`; `no_answer`; `busy`), serde round-trip of every struct.
- **Acceptance:** 100% of `EndCause`/`RefusalReason` variants covered; no I/O; `every_played_text_is_authored` proves the reducer only emits texts present in plan/policy.
- **Risk:** low.

### V0-T2: persistence + use cases for human click-to-call and the call log

- **Files:** `migrations/0014_voice_calls.{up,down}.sql` (spec §9: `call_sessions`, `call_turns`, `call_commands`, `call_duty`, `workspace_policies.calls`, role backfill `calls.work`/`calls.manage`, system role `voice_bridge` with `calls.bridge`); `jt_tenancy/src/role.rs` `Permission::{CallsWork, CallsManage, CallsBridge}` (+ `ALL_PERMISSIONS`, `key()`, system-role grants); `ports/calls.rs` (`CallRepo`, `CallTurnRepo`, `CallCommandRepo`, `CallDutyRepo`, `CallPolicyRepo` via `WorkspacePolicy.calls`); `jt_pg/src/repos/calls/{mod,sessions,turns,commands,duty}.rs`, `uow.rs`; `jt_testkit/src/fakes/calls.rs`; `usecases/calls/{mod,policy,place,get,list,end}.rs`; `usecases/policy.rs` (move `hours()` from `studio/chain.rs:105-128`, reuse in both); catalog rows `calls.policy_get/set, calls.place, calls.get, calls.list, calls.end` (spec §7, risks/permissions as listed; `calls.place` = Spend); `jt_mcp/src/tools/calls.rs`; `jt_panel_http/src/routes/calls.rs`; `tools/mod.rs`, `routes/mod.rs` registration; catalog count update.
- **Behaviour:** `calls.place{mode:"human", rep_extension}` runs the fence (spec §8, steps 1,2(`netgsm_pbx`),3,4,5,6,7) inside the tenant transaction, inserts `Dialing`, commits, then calls `Telephony::click_to_call(cred, public, rep_extension, e164)`; receipt `crm_id` stored; on `ConnectorError` → `Ended{Failed(failure_line)}` + ledger `calls.refused`/`calls.failed`. `mode:"agent"` returns `CONFLICT bridge_offline` until V1. `calls.end` for human calls records outcome/summary, journey `CallMade{connected}` (reuse `consumer.rs` apply path), note, optional task, `record_spend`.
- **Tests first:** `jt_pg/tests/calls_storage.rs` (RLS exact set, composite FKs, down refuses live rows); `jt_app/tests/calls_place.rs::{human_click_to_call_originates_rep_then_customer, fence_reevaluated_before_dial, commercial_without_arama_consent_refused, service_call_needs_relationship, callback_needs_recent_inbound, outside_hours_refused, daily_cap_refused, budget_exhausted_refused, lost_journey_refused, outputs_mask_e164, refusal_is_ledgered_once}`; `jt_app/tests/calls_end.rs::{end_writes_call_made_note_and_spend, end_twice_is_idempotent}`; `jt_mcp/tests/calls_mcp.rs` tool shapes + risk tags; `jt_panel_http` route tests; catalog/permission exact-set tests.
- **Acceptance:** a rep (or an agent on a rep's behalf) dials a consented person from the panel/MCP; the NetGSM fake sees `originate`; the call appears in `calls.list`; refusals carry stable reasons.
- **Risk:** medium (permissions + catalog + migration in one task; split the migration into V0-T2a if a worker needs it smaller).

### V0-T3: CDR, call-event correlation, NetGSM reports

- **Files:** `usecases/inbox/consumer.rs` (`cdr` scenario → update `call_sessions` by `crm_id`/`unique_id`: duration, recording ref, `answered_at`; `voice-report`/`autocall-report` `Status` → consumed with a ledger line, no journey effect); `usecases/jobs.rs` `Job::NetgsmCdrPoll` (hourly, active workspaces with a verified `netgsm_pbx`, window = last 2 h, `NetgsmConnector::call_records` through a new port method `Telephony::call_records` so the use case does not name the adapter); `bin/jeeta/src/scheduler.rs` interval; `ports/connectors.rs` `Telephony::call_records`; `jt_netgsm/src/ports.rs`; `jt_testkit` fake.
- **Tests first:** `jt_app/tests/inbox_consumer.rs::{cdr_event_backfills_session_duration_and_recording, hangup_event_ends_human_session, voice_report_is_consumed_not_deferred}`; `jt_app/tests/jobs.rs::cdr_poll_dedups_against_push` (same `netgsm-call:<id>:cdr` external id); `jt_netgsm` already covers `call_records` parsing.
- **Acceptance:** a human call placed in V0-T2 shows duration, outcome and recording link from the CDR within an hour; spend is corrected to `ceil(duration/60) × rate`.
- **Risk:** low. Needs the server IP on NetGSM's allowed list (owner).

### V0-T4: panel `/calls` + policy editor + capability card bits

- **Files:** `panel/src/pages/{CallsPage,CallDetail,CallsPolicy}.tsx`, `api/calls.ts`, `App.tsx` routes `calls`, `calls/:callId`, nav entry, `i18n/{tr,en}.json`, `CapabilitiesPage.tsx` (`netgsm_pbx` card: recording toggle from C2, "Place a call" for reps), `OnboardingPage`/setup readiness lines.
- **Tests first:** `CallsPage.test.tsx::{lists_calls_with_masked_numbers, place_call_dialog_refusal_shows_reason}`, `CallDetail.test.tsx::{renders_turns_timeline, end_button_needs_calls_manage}`, `CallsPolicy.test.tsx::saves_policy`.
- **Acceptance:** log, detail, policy editor usable in Turkish; no raw E.164 in the DOM except for `calls.manage` in the detail view.
- **Risk:** low.

### V1-T1: `voice_bridge` capability kind + bridge routes

- **Files:** `jt_capability/src/kind.rs` `k(KindGroup::Telephony, "voice_bridge")` (reach: device-like; verified by heartbeat); `usecases/calls/bridge.rs` (`register`, `commands` long-poll ≤ 25 s with lease + re-delivery after 10 s, `events` batch idempotent by `(bridge_call_id, bridge_seq)`); catalog rows `calls.bridge.register/commands/events` as `panel_only` under `/api/voice/bridge/*`; `jt_panel_http/src/routes/voice_bridge.rs` using the API-key bearer auth of `jt_mcp::auth` (extract into `jt_app::usecases::api_keys::authenticate` if not already shared) and permission `calls.bridge`; heartbeat → capability `verified`/`stale`/`unreachable` via a 1-minute `Job::VoiceBridgeHealth`; work item `VoiceBridgeOffline`; panel capability card (engines, extension, heartbeat age); `docs/operations/voice-bridge.md` (install, SIP creds, Gate V1 steps, systemd unit).
- **Tests first:** `jt_app/tests/calls_bridge.rs::{register_verifies_capability_and_records_facts, stale_after_60s_unreachable_after_10m, commands_long_poll_returns_within_wait_plus_one, unacked_command_redelivered_after_10s, events_batch_is_idempotent, bridge_key_cannot_call_other_tools}`; `jt_panel_http/tests/voice_bridge.rs` auth (session cookie refused, wrong-role key refused).
- **Acceptance:** a scripted bridge client (test) registers, polls, posts events; the capability flips states by heartbeat; the MCP catalog shows no bridge tool.
- **Risk:** medium (new auth surface; keep it to one permission).

### V1-T2: agent-driven session — `calls.listen`, `calls.say`, timers, scripted ending

- **Files:** `usecases/calls/{listen,say,session}.rs` (long-poll ≤ 25 s on a per-workspace `tokio::sync::Notify` registry kept in `Deps` — new port `CallSignals` with an in-memory impl in `jt_app::std_impls`, process-local like `OpsSignals`; a multi-instance deployment degrades to 1-s polling of `call_turns`, acceptable); `jobs.rs` `Job::CallTimers` every 1 s only while a session is live (or a spawned task per live call in `bin/jeeta` — prefer the job with `next_timer` from `jt_calls` so tests stay deterministic); `calls.place{mode:"agent"}` → command `dial` + pre-synthesis payload; `reduce` outputs → `call_commands`; catalog rows `calls.listen`, `calls.say`, `calls.transfer`; MCP tool descriptions with the latency rule (spec §7); ledger entries (spec §12); metrics per call.
- **Tests first:** `jt_app/tests/calls_session.rs::{bridge_dial_only_after_fence, answered_plays_opening, utterance_wakes_listen_immediately, say_enqueues_tts_command_and_turn, agent_silence_plays_holding_then_fallback_then_closes, agent_disconnect_ends_by_script, barge_in_marks_say_interrupted, caller_hangup_ends_session_with_call_made, max_duration_closes, transfer_ends_agent_part, listen_times_out_within_wait_plus_one, one_live_agent_call_per_connection, every_played_text_is_authored}`; `jt_mcp/tests/calls_mcp.rs::listen_long_poll_shape`; contract replay tests over `tests/fixtures/voice/{outbound_happy,agent_silent,caller_hangup}.json`.
- **Acceptance:** with the scripted bridge, an agent loop in the test (place → listen → say × n → end) produces the expected turn log, journey event, note and spend; a silent agent never leaves the session un-ended.
- **Risk:** high (timers + long-poll + transactions). Keep the reducer pure (V0-T1) and the use case thin.

### V1-T3: the voice bridge sidecar

- **Files:** `rust/bridge/voice/` (Go module `jeeta-voice-bridge`: `sipgo`+`diago` for SIP/RTP/G.711, `vosk` cgo or `whisper.cpp` server, `piper` subprocess; or Python `pjsua2` — implementer's choice, documented), `config.example.env`, `systemd/jeeta-voice-bridge.service`, `README.md`, tests against a mock Jeeta (`mock_server_test.go`), CI job in `.github/workflows/rust.yml` (separate step, Linux).
- **Behaviour:** register every 15 s; command loop; per call: answer/dial, pre-synthesise plan audio, VAD (webrtcvad or energy), streaming STT partials + finals, barge-in stop, DTMF, recording after announcement only, hangup causes; never logs numbers or audio paths with numbers.
- **Tests first:** unit tests for chunking/VAD endpointing/barge-in state; an end-to-end test with two local SIP UAs (bridge + a scripted caller) in CI.
- **Acceptance:** Gate V1 passed by the owner; a real outbound call from the agent reaches a mobile with two-way audio; transcript appears in `/calls/{id}` live.
- **Risk:** high (telephony reality); isolated from the Rust workspace, so it never blocks CI of `jeeta`.

### V2-T1: inbound duty mode, voicemail, callback

- **Files:** `usecases/calls/{duty,inbound}.rs`; catalog `calls.duty_start/end`; `WorkKind::{CallbackDue, CallWaiting}` in `usecases/work.rs` + hints; `listen` without `call_id`; bridge `inbound` handling (answer + greeting if on duty; else answer + voicemail + record ≤ 60 s + `MessageReceived` with transcript + `CallbackDue`); panel banner "agent on duty"; `calls.place{purpose:"callback"}` evidence from inbound sessions.
- **Tests first:** `jt_app/tests/calls_inbound.rs::{inbound_with_duty_delivers_to_listen, inbound_without_duty_takes_voicemail_and_creates_callback, duty_expires_after_90s_without_listen, voicemail_is_message_received_not_call_made}`.
- **Acceptance:** an inbound call while the agent loops `listen` is answered with the greeting and handled; otherwise voicemail + callback work item within seconds.
- **Risk:** medium.

### V3 (optional, after owner decisions D4/D6): recording purge job, cloud-engine facts, approval-before-dial

- `Job::CallsRecordingPurge` (policy `recording_retention_days`); `requires_human_approval` on `voice_bridge` → `Planned` sessions + `CallApproval` work item + panel approve; bridge reports engine facts; no new provider keys in Jeeta.

---

## S. TikTok and LinkedIn (spec `2026-10-27-tiktok-linkedin-connectors-design.md`)

### S1: shared registration (providers, apps, hosts, migration, gates, panel lists)

- **Files:** spec §1 table (every file:line there). Migration `0015_social_providers`. Also `MediaDelivery` replacing `for_x` (`studio/publish.rs:64`, `files.rs:339`), `Publisher::resolve` default method (`ports/connectors.rs:575`), `jobs.rs:309` always-due for `Provider::Tiktok`.
- **Tests first:** `jt_connector/tests/rules.rs` updated pins (`provider keys = [meta,netgsm,x,mail,tiktok,linkedin]`, unsupported set shrinks, every connector kind served once); `jt_outbound` `fixed_hosts_are_exactly_the_documented_set`; `bin/jeeta` registry matrix test (:178-251) with both providers; `jt_app/tests/connector.rs::{tiktok_and_linkedin_start_oauth_build_redirect, manual_credentials_refused_for_oauth_only_providers, linkedin_page_refused_without_org_scopes}`; `jt_app/tests/studio_publish.rs::media_delivery_per_kind`; `jt_pg/tests/migrations.rs` round-trip; panel `OAuthCallbackPage.test.tsx` + `ConnectPage.test.tsx` cases for both; `jt_archtest` lists.
- **Acceptance:** with no app configured, both providers answer `CONFLICT provider_app_not_configured` to `start_oauth`; with apps set, the start log lists `tiktok,linkedin`; existing providers unchanged.
- **Risk:** medium (many pinned lists; one worker, one PR).

### S2: `jt_tiktok` adapter

- **Files:** `crates/adapters/jt_tiktok/src/{lib,client,credential,oauth,account,publish,insights,ports}.rs`, tests + fixtures (spec §2 files).
- **Tests first (`tests/tiktok.rs`, `tests/studio_publish.rs`):** `hosts_are_the_fixed_tiktok_entries`; `authorize_url_uses_client_key_and_comma_scopes`; `exchange_builds_oauth_credential_with_expiry`; `refresh_rotates_refresh_token`; `probe_binds_open_id_as_account_id`; `creator_info_is_queried_before_every_post`; `public_privacy_refused_when_not_offered`; `video_init_then_chunked_upload_content_range`; `photo_uses_pull_from_url`; `status_processing_is_unknown_then_complete_resolves_permalink`; `status_failed_carries_fail_reason`; `error_mapping_{auth,scope,rate,5xx}`; `no_secret_in_errors`; `read_retried_once_write_never`.
- **Acceptance:** scripted mock passes all; `failure_reason(Some(Provider::Tiktok), e)` lines read as spec §1 examples; Studio publishes a video piece end-to-end against the mock with `PublishOutcome::Unknown → Succeeded` via `resolve`.
- **Risk:** medium; the upload host and chunk rules are verified live by the owner's tester account (S2 acceptance note).

### S3: `jt_linkedin` adapter

- **Files:** `crates/adapters/jt_linkedin/src/{lib,client,credential,oauth,account,publish,insights,ports}.rs`, tests + fixtures (spec §3).
- **Tests first:** `authorize_url_member_scopes_vs_page_scopes`; `page_flow_refused_without_org_scopes` (in S1 but asserted here too at adapter level: `list_assets` without org scopes yields the member asset only); `exchange_sets_60d_expiry_and_optional_refresh`; `refresh_without_token_is_none`; `userinfo_probe_binds_sub`; `organization_acls_yield_one_page_asset_each`; `post_text_sends_rest_posts_with_version_headers_and_reads_restli_id`; `image_upload_init_put_then_media_content`; `video_init_parts_finalize`; `error_426_names_version`; `member_metrics_are_permanent_unsupported`; `org_share_statistics_map_counts`; `no_secret_in_errors`.
- **Acceptance:** member posting works against the mock; page posting works only with the org-scope flag; Studio measurement treats member metrics as `unsupported` without retry storms (add `jt_app/tests/studio_measure.rs::permanent_unsupported_metrics_stop_retrying`).
- **Risk:** medium; `LinkedIn-Version` pin must be checked on the live API at implementation time.

### S4 (backlog): ads apps (`tiktok_ads`, `linkedin_ads`), TikTok webhooks, LinkedIn org comments — each needs its own app review; not scheduled.

---

## Checklist for the owner (purchase / enable)

**Voice**
- [ ] Add the server's public IP to the NetGSM account's allowed IPs (CDR `/netsantral/report`); register the `events` callback URL from `jeeta.connector.hooks` in Netsantral.
- [ ] Gate V1 (free, 1 h): register ext 101 with a software SIP UA from the Contabo host, route an inbound call to 101, dial out from 101 — record the three results.
- [ ] If Gate V1 fails: "SIP Trunk" add-on (1.035 TL/mo) + outbound permission.
- [ ] Sidecar host capacity (≥ 2 vCPU/2 GB for Vosk+Piper; 4 vCPU/8 GB for faster-whisper) and UDP 5060 + RTP range open.
- [ ] Not needed: Özel API, "Yapay Zeka", "Çağrı Analizi", VAPI/Retell/ElevenLabs, OpenAI/Anthropic keys. Optional later: a cloud STT/TTS key in the sidecar; NetGSM "Görüşme Kaydı" only for portal-side recordings.

**TikTok** — spec §2 checklist: app with Login Kit + Content Posting API; redirect `https://{public base}/oauth/callback/tiktok`; scopes `user.info.basic video.publish video.list user.info.stats`; app audit (demo video, privacy UI, terms/privacy/data-deletion pages, tester account); URL-property verification of the media host; `JEETA_TIKTOK_CLIENT_KEY/SECRET`.

**LinkedIn** — spec §3 checklist: Sign In (OIDC) + Share on LinkedIn products; redirect `https://{public base}/oauth/callback/linkedin`; CMA access (pending Microsoft vetting) → `JEETA_LINKEDIN_ORG_SCOPES=1`; `JEETA_LINKEDIN_CLIENT_ID/SECRET`; data-deletion page.

## Decision queue (owner)

- D1 Gate V1 approval and sidecar host (spec §13.1–2).
- D2 Studio approval-on default for new and never-published workspaces (C3).
- D3 Mandatory assistant disclosure sentence (spec §13.3).
- D4 Start engines: self-hosted Vosk+Piper vs. cloud key in the sidecar (spec §13.4).
- D5 "Service call" relationship rule as the non-commercial exception (spec §13.5).
- D6 Agent calls dial freely within gates, or need human approval per call for the first month (spec §13.6).
- D7 LinkedIn: ship `linkedin_member` now and `linkedin_page` behind the org-scope flag (recommended), or wait for CMA.
- D8 TikTok tester/developer account for unaudited posting.

### Owner answers (2026-10-27, relayed by the coordinator)

- D1: yes: run the free one-hour software-extension test (ext 101) on the existing Contabo host; the sidecar runs on that same VM. SIP Trunk is **not** approved in advance: if NetGSM refuses the extension test, stop and report.
- D2: **no**: keep the current Studio default (no human approval). C3 and migration `0016_studio_approval_default` are dropped.
- D3: the disclosure sentence is mandatory in every agent-mode opening; only a human can turn it off.
- D4: self-hosted Vosk + Piper.
- D5: accepted: the existing-relationship rule (Won journey, appointment/quote within 180 days, or an open appointment) is the non-commercial exception; everything else needs explicit ARAMA consent.
- D6: `calls.place` does not require human approval by default (the agent dials freely within the gates).
- D7: wait for CMA; LinkedIn stays unconfigured.
- D8: the owner opens a dedicated TikTok test account.
- Migration numbers as merged: `0013_probe_reason`, `0014_social_providers` (PR #366), `0015_voice_calls`.
