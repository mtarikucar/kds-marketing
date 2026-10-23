# M4 — Ürünleştirme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one-time bank-transfer payment and durable workspace activation, a platform operator console, first-run guidance, a single-process PostgreSQL deployment, tested recovery, operational visibility and a controlled v1 cutover, ending with the owner's live smoke acceptance.

**Architecture:** Extend existing `jt_app` use cases, tenant/platform transaction bundles, ledger and HTTP/MCP catalog; keep platform identity separate. Payment notification, verified entitlement and workspace operational status are separate facts. Reuse `jeeta serve`, its scheduler and separately built panel assets; preserve M1–M3 domain behavior. Carry forward Ek A knowledge; the authoritative baseline is a fresh database, not a v1 customer-data importer.

**Tech Stack:** Existing Rust 1.96, axum 0.8, sqlx 0.8.6/PostgreSQL, rmcp 3.6, React/TypeScript, pnpm, tracing; systemd and PostgreSQL backup tools. No payment provider, external monitoring SaaS, new queue service or application service split.

**Spec:** `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` §9–12, §14–16, Ek A; LOCAL `docs/reports/v2-reference/rust-rewrite-research/12-m4-productisation-prep.md` P1–P6/O1–O4/D1–D5/B1–B4/L1–L3/C1–C4 and its decision queue (never commit). Format: `2026-10-23-rust-m2a-gelen-kutusu-cekirdek.md`. Binding M1b Task 10 rulings govern refresh, polling and shutdown even where older deployment prose differs.

## Global Constraints

- K4: **one-time payment only**, permanent access after operator confirmation and owner code redemption; no credits, subscriptions, packages, top-ups, reseller billing, coupons, trials or automatic expiry. Bank-transfer evidence → operator confirmation/code → panel activation is the M4 payment mechanism. Advertising budgets remain tenant spending caps.
- **Q2 amendment to §9/K11, §5 and prep P4:** `billing.report_payment` is evidence-only with panel/MCP twins and needs no code. Only `billing.activate {code}` redeems the operator-issued code, in the panel. Codes never authorize strategy approval or other actions; preserve existing destructive `confirm: true` contracts. Settlement verification remains operator-only.
- Existing statuses stay `pending_payment|active|suspended`. `auth.*`, `workspace.*`, `platform.*` retain their current status exemptions; `strategy.*`/`work.*` also work while pending, never while suspended. Payment exemptions are exact rows, not a blanket `billing.*` bypass. Payment never approves strategy, verifies a capability or marks an agent connected.
- Hexagonal boundaries, structured errors, dependency allowlists, tenant `workspace_id`, composite FKs and ENABLE/FORCE RLS continue. Production DB roles are `NOSUPERUSER NOBYPASSRLS`; explicit platform queries use the existing platform bundle, never tenant-bypass privileges or operator access to messages, notes, raw webhook bodies or sealed credentials.
- Every schema migration and seed is a sqlx `.up.sql`/`.down.sql` pair. Up is idempotent where practical; down is scoped and repeatable, preserves runtime/operator data, and refuses a destructive rollback while such data exists. Test up → down → up plus repeated down; rollback after live writes uses preserved backups and the cutover procedure, never silent data loss.
- English identifiers, errors, DTOs and MCP schemas; Turkish panel copy, with existing TR/EN key parity. Catalog rows, actual handlers/dispatchers, permissions, status gates and exact-set architecture tests change together. Platform and operational administration stay panel-only: no `jeeta.platform.*` or `jeeta.ops.*` tools.
- Domain audit ledger and operational stderr logs are separate. Never log codes, reference text, passwords, API/session/provider tokens, database URLs, authorization headers, secret-bearing URL/query segments or tenant bodies. Use IDs, action, actor, outcome and route templates; preserve `rmcp=warn`. Public fixtures are synthetic.
- Messages, publication evidence and ledger are retained indefinitely; raw webhook bodies and `probe_runs` retain the existing 30-day rules. Operational JSON logs use journald with 30-day retention and a 1 GiB cap (implementation defaults, separate from audit retention). Daily full DB backup, continuous WAL archiving and a monthly restore drill are required.
- Single binary + PostgreSQL means one application process, with the matching panel distribution and local FileStore data beside it; panel assets are not currently embedded. Retain connector timeouts/isolation, advisory job locks, refresh for active/pending workspaces (including marked X retries), active-only polling and the 30-second job shutdown grace. Unknown external writes are never blindly retried.
- Q1–Q8 and P1–P2 are binding; the final index maps their implementation. New names below are implementation contracts, not existing features. Price/currency/bank text are required deployment inputs, never fixture-derived defaults. This plan does not claim implementation or live acceptance.

## Review Focus

1. Confirmation retries and activation/suspend/revoke races must serialize without duplicate grants or reactivation → T1/T3/T4: `concurrent_confirmation_creates_one_grant`, `activation_suspend_revoke_serialize`, `reconfirm_same_payment_preserves_history`.
2. Wrong guesses must count against the workspace challenge; ownership changes retain code validity for current owners → T4: `five_distinct_wrong_guesses_lock_challenge`, `current_owner_can_redeem_after_ownership_change`, `code_never_returned_to_agent`.
3. Tenant credentials cannot enter operator APIs; recovery must revoke sessions; metrics must authenticate → T5/T6: `metrics_missing_wrong_token_is_401`, `operator_reset_revokes_all_sessions`, `tenant_and_operator_sessions_are_not_interchangeable`.
4. A DB-only restore or restored provider traffic risks lost credentials and duplicate writes → T9: `restore_requires_matching_key_and_files`, `restore_drill_has_zero_provider_traffic`, `restore_checks_schema_before_serve`.
5. Liveness and restart counters must not misrepresent readiness or lost webhook traffic → T5: `readiness_fails_when_database_unavailable`, `unrouted_signed_webhook_is_visible`, `restart_counters_have_explicit_epoch_and_unknown_history`.

## File structure

Paths below are relative to `rust/` unless prefixed `docs/` or `.github/`. In task file lists, `usecases/` and `ports/` expand under `crates/jt_app/src/`, `routes/` under `crates/adapters/jt_panel_http/src/`, `jt_app/tests`/`jt_archtest/tests` under `crates/`, and `jt_pg/tests`/`jt_mcp/tests`/`jt_panel_http/tests` under `crates/adapters/`. Panel page/API paths expand under `panel/src/`. Each task owns its named tests and consequential registration/fake/contract changes; dispatch it as one worker run after its dependencies are ready.

- Billing contracts/use cases: `crates/jt_app/src/ports/billing.rs`, `usecases/billing/{mod,schema,payments,codes}.rs`, `usecases/platform_payments.rs`; reuse `ctx::{Ctx,PlatformCtx}`, `usecases/platform.rs`, `usecases/workspace.rs`, `catalog.rs`, `gate.rs`.
- Persistence: reserve `migrations/2026102301_m4_billing.{up,down}.sql`, `2026102302_m4_activation_codes.{up,down}.sql` and `2026102303_m4_grandfathered_backfill.{up,down}.sql`; `crates/adapters/jt_pg/src/repos/billing.rs`, `uow.rs`; `crates/jt_testkit/src/fakes/{billing,platform,tenant,state}.rs`. These reserved IDs must follow the integrated M3 chain; assert ordering and exact filename parity before applying. No historical migration edits.
- Surfaces: `crates/adapters/jt_panel_http/src/routes/{billing,platform_payments,ops}.rs`; `crates/adapters/jt_mcp/src/tools/billing.rs`; existing route/tool modules and shared schema registration. Test files use `m4_*` names below to keep verification targets unambiguous.
- Operations: `crates/jt_app/src/{ports/ops,usecases/ops}.rs`, `bin/jeeta/src/{ops,config,serve,stdio,scheduler}.rs`; runtime wiring remains at the binary boundary, no SQL or filesystem calls in use cases.
- Panel: `panel/src/pages/{BillingPage,OnboardingPage}.tsx`, `pages/platform/{WorkspacesPage,PaymentsPage,HealthPage}.tsx`, `api/{billing,ops,platform}.ts`, `App.tsx`, `HomePage.tsx`, `i18n/{tr,en}.json` and corresponding tests.
- Delivery: `deploy/{jeeta.service,jeeta.env.example,jeeta-backup.service,jeeta-backup.timer,journald-jeeta.conf}`, `scripts/{backup,restore-drill,smoke-productisation}.sh`, `docs/operations/{deployment,backup-restore,v1-cutover,m4-acceptance}.md`, `README.md`, `Makefile`, `.github/workflows/rust.yml` (repo root). No real environment files, credentials, backups or customer exports are checked in.

**Execution/testing convention:** T1→T2/T3→T4; T3/T5→T6; T2–T6→T7; T8→T9; T10 uses T7–T9; T11 closes all tasks. T5 and T8 can proceed independently. For each task, write the named failing tests, run its fast command and confirm the expected missing behavior, implement, then rerun fast. All cargo commands run in `rust/`; panel commands use `pnpm --dir panel`. Final once per implementation run: `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace`; repeat only on failure. Run named panel/script checks when touched; T11 adds the release-specific checks. Commit only when the dispatch header authorizes it, with an explicit file list, one plain conventional message and no authorship trailer; never push, tag or deploy.

---

### Task 1: Durable payment evidence, activation challenges and entitlement history

**Files:** Create the three reserved migration pairs, `ports/billing.rs`, `usecases/billing/{mod,schema}.rs`, Pg/fake `billing.rs`; modify `ports/mod.rs`, repo/use-case registrations, `jt_pg/src/uow.rs`, testkit bundles/state. Test: `jt_pg/tests/m4_billing_storage.rs`, `jt_app/tests/m4_billing_contracts.rs`, migration/RLS exact-set tests.

**Interfaces:** Define `PaymentId(Uuid)`, `EntitlementId(Uuid)`, `ActivationCodeId(Uuid)`. `PaymentNotification {id,workspace_id,reported_by:UserId,reference_sealed:Vec<u8>,request_key:String,amount_minor:i64,currency:String,paid_at:OffsetDateTime,reported_at:OffsetDateTime}`. `WorkspaceEntitlement {id,workspace_id,source:EntitlementSource,payment_id:Option<PaymentId>,confirmed_by:Option<OperatorId>,confirmed_at:OffsetDateTime,activated_at:Option<OffsetDateTime>,redeemed_by:Option<UserId>,revoked_at:Option<OffsetDateTime>,reason:Option<String>}`; `EntitlementSource = Paid | Grandfathered` serializes as `paid | grandfathered`. Paid grants require matching payment/operator; grandfathered grants have neither. Grants never expire; revoke closes a row, never deletes it. Confirmation creates an unactivated grant; redemption activates it.

`payment_notifications` has unique `(workspace_id,id)` and `(workspace_id,request_key)`; `workspace_entitlements` has PK id, composite payment FK and one open grant per workspace (`revoked_at IS NULL`). Closed grants may reuse the same payment ID. `workspace_billing` stores a stable unique reference generated once under workspace lock: `JEETA-<first 8 uppercase UUID hex digits>-<6 random decimal digits>`; retry collisions. `activation_codes` stores id, workspace_id, entitlement_id (composite FK), action=`billing.activate`, keyed digest, issued_by, created_at, expires_at, attempts, invalidated_at, consumed_at, redeemed_by; no recipient binding or plaintext. Use unique `(workspace_id,id)` on grants and at most one noninvalidated/unconsumed challenge per workspace. All four tenant tables have ENABLE/FORCE RLS; sealed references and codes have masked Debug.

All repository methods below are async `Result<_,AppError>`. `BillingRepo::{get_payment(id)->Option<PaymentNotification>,find_request(key:&str)->Option<PaymentNotification>,insert_payment(row)->(),reference_get_or_create()->String,entitlement()->Option<WorkspaceEntitlement>,activate_entitlement(id,at,by:UserId)->()}` through `TenantRepos::billing()`. Add `WorkspaceRepo::lock()->WorkspaceRow` and `set_status(ws:WorkspaceId,status:WorkspaceStatus,reason:&str,by:&Actor)->()`; reject ws different from the tenant bundle. Extend platform `workspace_set_status` to the same reason/actor contract. Mutation plus `platform.workspace_status` ledger (from/to/reason/by) is atomic in the caller's transaction; only T3 ruled operations and T4 activation call it. Registration in `auth.rs` still creates pending workspaces; `workspace.info` remains read-only.

Extend `PlatformRepos` with `workspace_lock(ws)->WorkspaceRow`, `payment_get(ws,id)->Option<PaymentNotification>`, `entitlement_get(ws)->Option<WorkspaceEntitlement>`, `entitlement_insert(row)->()`, `entitlement_revoke(ws,id,at,reason:&str)->()`, `payments_list()->Vec<PaymentNotification>` and T4 challenge methods with explicit workspace IDs. All writers lock workspace before grant/challenge; no nested tenant commit. Update every Pg/fake/wrapper implementation.

`ActivationCodeRepo::{insert(row:ActivationCodeRow)->(),lock_current_by_workspace()->Option<ActivationCodeRow>,record_failed_attempt(id:ActivationCodeId)->(),invalidate_current(at:OffsetDateTime)->(),consume(id:ActivationCodeId,at:OffsetDateTime,by:UserId)->()}` is exposed by `TenantRepos::activation_codes()`; implement platform equivalents with explicit ws here for T3. Current means newest noninvalidated challenge, including a consumed row for replay refusal. `ActivationCodeRow` has the stored fields above; failures cap attempts at five.

The **separate data pair** `2026102303_m4_grandfathered_backfill` inserts activated grandfathered grants only for existing active workspaces without an open grant. Persist a migration-owned manifest of exact inserted IDs and full original row images plus the workspace ledger watermark; derive fixed grant IDs from workspace IDs. Up skips existing grants. Down deletes only manifest-owned rows still byte-for-byte unchanged and unreferenced by runtime history (including later workspace status ledger entries); retain edited/revoked rows and their manifest entries. Never change workspace status or delete runtime/operator data. Schema downs preflight all owned tables and refuse atomically while live rows remain; repeated down is safe.

- [ ] Tests: `billing_rls_and_composite_fk_reject_other_workspace` reads/writes with ordinary roles; `request_key_unique_per_workspace`; `paid_and_grandfathered_provenance_constraints`; `one_open_grant_preserves_closed_history`; `workspace_status_reason_actor_is_atomic`; `billing_migration_up_down_up_and_repeated_down`; `billing_down_refuses_live_rows_without_changes`; `grandfathered_backfill_up_down_up` includes repeated up/down, pending/suspended exclusion, preexisting grant preservation and `grandfathered_down_preserves_edited_revoked_and_runtime_rows`. Run fake/Pg parity.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_billing_storage --test m4_billing_contracts` → PASS; preserve exact schema/table assertions.
- [ ] Commit `feat(billing): persist payment evidence and entitlement history`.

### Task 2: Tenant payment status and evidence-only bank-transfer notification

**Files:** Create `usecases/billing/payments.rs`, HTTP `routes/billing.rs`, MCP `tools/billing.rs`; modify catalog/gate/dispatch/schema registrations, Deps and binary `config.rs` wiring. Test: `jt_app/tests/m4_billing_payments.rs`, `jt_panel_http/tests/m4_billing_http.rs`, `jt_mcp/tests/m4_billing_mcp.rs`, binary config and exact gate/twin tests.

**Interfaces:** `billing::status(deps:&Deps,ctx:&Ctx)->Result<BillingStatusOut,AppError>`; `billing::report_payment(deps:&Deps,ctx:&Ctx,input:ReportPaymentInput)->Result<PaymentOut,AppError>`. `ReportPaymentInput {reference:String,amount_minor:i64,paid_at:OffsetDateTime,request_key:String}`: normalize reference uppercase/remove spaces and require equality with workspace reference; positive minor amount; paid_at not future; nonempty request_key ≤128 bytes. `BillingConfig {price_minor:i64,price_currency:String,bank_instructions:String}` comes from required `JEETA_PRICE_MINOR` (>0), `JEETA_PRICE_CURRENCY` (three uppercase ASCII letters), `JEETA_BANK_INSTRUCTIONS` (nonempty, ≤4096 bytes). Missing billing reference is initialized once under workspace lock on first billing access; the Read surface only exposes the stable value, never tenant-editable instructions. No guessed monetary defaults. Persist currency at report time; differing reported amount is evidence for operator review, never automatic settlement.

`PaymentOut {id,reported_at,amount_minor,currency,paid_at,confirmed:bool}`; confirmed means a paid grant has existed, not active access. `EntitlementOut {id,source,payment_id:Option<PaymentId>,confirmed_at,activated_at,revoked_at}`. `BillingStatusOut {workspace_status:WorkspaceStatus,entitlement:Option<EntitlementOut>,payment:Option<PaymentOut>,price_minor:i64,price_currency:String,bank_instructions:String,payment_reference:String}` exposes read-only instructions/reference and latest grant including revoked history; no code, operator details or sealed evidence. The internal `entitlement()` returns only the open grant; add `latest_entitlement()->Option<WorkspaceEntitlement>` for status.

| Row | Tool | HTTP | Gate / risk |
|---|---|---|---|
| `billing.status` | none, panel_only | `GET /api/billing` | strategy Exempt; exact Always status exemption; Read |
| `billing.report_payment` | `jeeta.billing.report_payment` | `POST /api/billing/payments` | strategy Exempt; exact PendingPayment exemption; Write |

Status requires active membership + `WorkspaceRead`; report requires current owner role + `TeamManage`, including effective key scopes for agents. Both surfaces call the same evidence-only use case with no code field/proof. Derive workspace/actor from session/key; never from input. Pending fresh registrations use the panel: this adds no unpaid key issuance or alternate agent authentication. Existing authorized keys can report after revocation. Report seals the reference and appends `billing.payment_reported` with payment ID only in one transaction; same request key + same normalized reference/amount/paid_at returns original stored currency/result, changed payload is `CONFLICT`. Never mutate status/entitlement or call providers; foreign payment IDs return `NOT_FOUND`.

- [ ] Tests: `report_does_not_activate_workspace`, `report_idempotency_covers_reference_amount_paid_at`, `billing_instructions_and_reference_are_stable_read_only`, `payment_status_persists_across_restart`, `report_actor_and_workspace_are_server_derived`, `pending_can_report_suspended_cannot`, `http_mcp_payment_effect_parity_without_code`, `owner_role_and_effective_scopes_required`, `billing_rows_do_not_open_team_keys_or_capabilities`, `payment_does_not_satisfy_strategy_gate`, `report_ledger_failure_rolls_back`, `billing_config_rejects_missing_or_invalid_values`.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_billing_payments --test m4_billing_http --test m4_billing_mcp --test gate_rule --test twin_rule`; `cargo test --locked -p jeeta billing_config` → PASS.
- [ ] Commit `feat(billing): bank transfer evidence and payment instructions`.

### Task 3: Operator confirmation, reissue and explicit workspace transitions

**Files:** Create `usecases/platform_payments.rs`, `routes/platform_payments.rs`, code-generation helper in `usecases/billing/codes.rs`; modify `usecases/platform.rs`, platform Pg/fakes, catalog/routes and legacy route tests. Test: `jt_app/tests/m4_platform_payments.rs`, `jt_pg/tests/m4_payment_races.rs`, `jt_panel_http/tests/m4_platform_payments_http.rs`.

**Interfaces:** `platform_payments::{list(deps:&Deps,pctx:&PlatformCtx)->Result<Vec<PlatformPaymentOut>,AppError>,confirm(deps:&Deps,pctx:&PlatformCtx,ws:WorkspaceId,id:PaymentId)->Result<ConfirmationOut,AppError>,reissue(deps:&Deps,pctx:&PlatformCtx,ws:WorkspaceId,id:PaymentId)->Result<ConfirmationOut,AppError>,revoke_activation(deps:&Deps,pctx:&PlatformCtx,ws:WorkspaceId,reason:&str)->Result<WorkspaceAdminOut,AppError>}`. `PlatformPaymentOut {workspace_id,payment_id,reported_at,amount_minor,currency,paid_at,reference,entitlement:Option<EntitlementOut>}` decrypts evidence only for operators, no receipt bodies/logging/cache. `ConfirmationOut {workspace:WorkspaceAdminOut,entitlement:EntitlementOut,activation:Option<ActivationCodeDeliveryOut>}`; non-Debug delivery contains `{id,expires_at,code:String}` and is shown once in the operator console for out-of-band handoff. Lost response uses explicit reissue, not plaintext recovery.

All rows below are panel_only/Exempt/Always; only list is Read, others Write. Remove unrestricted `platform::set_status`, its catalog row, `PATCH .../status`, `SetStatusBody` and panel `setWorkspaceStatus`; old route returns 404. Replace with `platform::suspend(deps,pctx,ws,reason:&str)` and `platform::resume(deps,pctx,ws)`, both returning `Result<WorkspaceAdminOut,AppError>`.

| Row | HTTP |
|---|---|
| `platform.payments.list` | `GET /api/platform/payments` |
| `platform.billing.confirm` | `POST /api/platform/workspaces/{workspace_id}/payments/{payment_id}/confirm` |
| `platform.billing.reissue` | `POST /api/platform/workspaces/{workspace_id}/payments/{payment_id}/reissue` |
| `platform.billing.revoke_activation` | `POST /api/platform/workspaces/{workspace_id}/revoke-activation` with `{reason}` |
| `platform.workspaces.suspend` | `POST /api/platform/workspaces/{workspace_id}/suspend` with `{reason}` |
| `platform.workspaces.resume` | `POST /api/platform/workspaces/{workspace_id}/resume` |

Lock workspace and reread status/grant. `billing.confirm` on pending with no open grant verifies operator-reviewed reference/amount/currency/paid_at against the bank transfer, inserts a paid grant and an 8-character `[A-Z0-9]` code (72 h, five attempts), never activates. Same payment/open grant returns current state with activation=None and no audit/write, including after activation/suspension. Different payment with open grant conflicts. After revoke, confirming the SAME payment creates one NEW grant/code; retries then return that grant. Reissue requires pending + matching open paid grant, invalidates old challenge, resets attempts/72 h with a new code, and preserves the grant. Reject first confirmation/reissue on active/suspended; do not implicitly resume.

`suspend`: active→suspended, retain activated paid/grandfathered grant; repeated suspended is no-op, pending conflicts. `resume`: suspended→active only with an activated open grant; repeated active is no-op; pending conflicts. `revoke_activation`: close any open grant with revoked_at/reason, invalidate challenge, move active/suspended/pending→pending_payment; already pending without a grant is no-op. Reasons for suspend/revoke are trimmed, required, ≤500 characters; fixed internal activation/resume reasons avoid missing audit context. Refunds remain out of band. Confirmation/reissue/revoke append named billing ledger entries; status transitions append `platform.workspace_status` including reason/actor. All effects commit once; payment evidence and historical grants remain intact.

- [ ] Tests: `concurrent_confirmation_creates_one_grant`, `confirmation_never_activates`, `confirmation_failure_rolls_back_every_effect`, `confirmation_retry_after_suspend_does_not_reactivate`, `reconfirm_same_payment_preserves_history`, `revoke_pending_challenge_invalidates_code`, `reason_required_and_repeated_transition_is_noop`, `resume_preserves_paid_and_grandfathered_entitlement`, `legacy_status_route_is_removed`, `wrong_workspace_payment_is_not_found`. Assert exact audit counts/actors and no reference/code in ledger.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_platform_payments --test m4_payment_races --test m4_platform_payments_http` → PASS with real Pg races.
- [ ] Commit `feat(platform): confirm evidence and control activation grants`.

### Task 4: Workspace-locked, panel-only activation redemption

**Files:** Extend `usecases/billing/codes.rs`, billing schemas/ports/repos/fakes, HTTP billing routes, catalog/gate and exact permission/twin tests. Test: `jt_app/tests/m4_payment_codes.rs`, `jt_pg/tests/m4_payment_code_storage.rs`, T2 HTTP/MCP targets, T3 race target.

**Interfaces:** `billing::activate(deps:&Deps,ctx:&Ctx,input:ActivateInput)->Result<BillingStatusOut,AppError>`; `ActivateInput {code:String}`. Row `billing.activate` → `POST /api/billing/activate`, panel_only, strategy Exempt, exact PendingPayment exemption, Write. Require human session, `TeamManage` and active current owner-role membership checked inside the transaction. Any CURRENT owner may redeem; ownership changes do not invalidate a code, former owners cannot redeem. Record redeeming UserId on code/grant and ledger. No designated recipient; no MCP activation handler/schema/tool.

Consume T1's `ActivationCodeRepo`/`ActivationCodeRow` and platform equivalents; T3 owns issuance/reissue. Workspace lock is acquired BEFORE challenge lookup, never lookup by submitted digest; compare keyed digest in constant time with workspace/grant/action binding. Lock current membership/role while authorizing redemption so role changes serialize. Generate codes uniformly using existing secure randomness and reject any digest used by an earlier challenge in this workspace; bind purpose to `billing.activate`, mask all Debug and apply `Cache-Control: no-store` to code responses.

Invalid input, including malformed codes, counts as a failed guess against an unexpired, unconsumed current challenge. Persist each failure before returning a structured validation error (repo calls themselves succeed); attempts=5 locks it even if the next code is correct. expires_at<=now, consumed, invalidated or absent challenge cannot change status/payment. Reissue alone unlocks and invalidates the previous code. Success requires pending + matching unrevoked paid grant; consume + grant activated_at/redeemed_by + `WorkspaceRepo::set_status(ws,Active,"billing.activate",actor)` + `billing.activated` audit commit atomically. Replay is refused without mutation; lost-success response is recovered by status read. Suspension/revoke cannot be undone by replay. Concurrent activation/suspend/revoke follows workspace-lock order: suspend-before-activation on pending conflicts; activation-before-suspend ends suspended; revoke in either order leaves pending with no usable old code.

- [ ] Tests: `five_distinct_wrong_guesses_lock_challenge`, `concurrent_wrong_guesses_stop_at_five`, `activation_expiry_at_72_hours`, `reissue_invalidates_old_code_and_resets_attempts`, `activation_binding_and_replay`, `current_owner_can_redeem_after_ownership_change` (former owner refused), `agent_cannot_activate_even_with_valid_code`, `code_never_returned_to_agent`, `activation_consume_status_and_ledger_roll_back_together`, `activation_suspend_revoke_serialize` (both lock orders), `activate_suspend_resume_revoke_reconfirm_activate`, `strategy_approval_and_existing_confirm_actions_need_no_code`.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_payment_codes --test m4_payment_code_storage --test m4_payment_races --test m4_billing_mcp --test m4_billing_http --test twin_rule --test gate_rule` → PASS.
- [ ] Commit `feat(billing): redeem one-time activation codes in the panel`.

### Task 5: Readiness, redacted operational signals and platform health projection

**Files:** Create `ports/ops.rs`, `usecases/ops.rs`, HTTP `routes/ops.rs`, `bin/jeeta/src/ops.rs`; modify Deps/runtime wiring, platform repo/fake projection, `config.rs`, `serve.rs`, `scheduler.rs`, webhook signal wiring and catalog. Test: `jt_app/tests/m4_ops.rs`, `jt_panel_http/tests/m4_ops_http.rs`, `bin/jeeta/tests/m4_observability.rs`.

**Interfaces:** Preserve public `GET /healthz` liveness; add `GET /readyz` with only `{"ok":true|false}`, HTTP 200/503 based on DB connectivity, completed boot/migrations and local FileStore readiness. These process endpoints have no tenant catalog row or MCP tool. Details belong in authenticated `ops.health` → `GET /api/platform/health`, panel-only/Exempt/Always/Read. `ops::health(deps:&Deps,pctx:&PlatformCtx)->Result<OpsHealthOut,AppError>` consumes new `OpsSnapshot::snapshot()->Result<OpsHealthOut,AppError>` port; adapters gather DB/filesystem/runtime signals. Deps/fake changes are part of this task.

Define `OpsHealthOut {observed_at,process_started_at,database:HealthState,files:HealthState,jobs:Vec<JobHealth>,connectors:Vec<ConnectorHealthCount>,webhooks:WebhookCounters,backup:RecoveryFreshness}`; `HealthState {Ok,Degraded,Unknown}`. `JobHealth {name,last_success_at:Option<OffsetDateTime>,failed_total:u64}`, `ConnectorHealthCount {workspace_id:WorkspaceId,kind_key:String,reconnect_required:u64,expires_before:Option<OffsetDateTime>}`, `WebhookCounters {accepted:u64,unrouted:u64,unresolved:u64}`, `RecoveryFreshness {last_backup_at:Option<OffsetDateTime>,last_wal_archive_at:Option<OffsetDateTime>}`. Only counts/status/time/IDs; no capability public JSON, external account bodies, tokens, message excerpts or payment reference. Add `PlatformRepos::connector_health_counts()->Result<Vec<ConnectorHealthCount>,AppError>` as an explicit platform projection, never a general tenant-repo reader exposed to operators. `OpsSnapshot::snapshot(&self)` is async and receives its runtime probes through binary wiring; it exposes only the declared output type.

Q5 fixes JSON stderr/journald, authenticated health and `GET /metrics` Prometheus text (`text/plain; version=0.0.4`). Validate nonempty secret `JEETA_METRICS_TOKEN` in config; require `Authorization: Bearer <token>` with constant-time comparison; missing/wrong token → 401, including operator cookies without the token. This process endpoint has no catalog/MCP row. Bound output to 256 KiB and fixed metric/label sets; aggregate tenant counts, never truncate into invalid text. No SaaS or persistent counter history is added. Emit bounded-name HTTP count/error/latency, DB pool occupancy/reachability, disk available bytes, job success/failure, reconnect counts and webhook unrouted/unresolved counts. Counters label route templates/provider/kind/outcome, never workspace/customer/token values. Represent reset epoch and missing history honestly; journald retains operational events; counters start a new process epoch. The owner checks health daily; mark backup age >24 h, WAL observation >15 min and disk free <10% degraded (implementation thresholds). Read backup/WAL freshness only from T9's verified status artifacts, never infer success from a timer firing. Clock-skew/future timestamps are degraded, not fresh.

- [ ] Tests: `readiness_fails_when_database_unavailable`, `readiness_distinguishes_file_failure_from_liveness`, `platform_projection_is_metadata_only`, `unrouted_signed_webhook_is_visible` (retain legitimate HTTP 200), `restart_counters_have_explicit_epoch_and_unknown_history`, `logs_redact_secret_canaries_on_success_and_error`, `metric_labels_are_bounded`, `metrics_missing_wrong_token_is_401`, `metrics_valid_token_returns_bounded_prometheus_text`, `missing_or_future_backup_marker_is_not_healthy`. Redaction tests inject secrets into config errors, payment/code input, provider failures and raw URL/query; inspect captured stderr and ledger separately. Never serialize an arbitrary error chain into telemetry.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_ops --test m4_ops_http --test m4_observability` → PASS; integration fixture provides fake probes, no live monitoring service.
- [ ] Commit `feat(ops): readiness and redacted platform health signals`.

### Task 6: Platform console, bootstrap and operator access runbook

**Files:** Create `panel/src/pages/platform/{PaymentsPage,HealthPage}.tsx`, `panel/src/api/ops.ts`; modify existing platform WorkspacesPage/login/API, App/router and TR/EN copy. Modify `usecases/platform.rs`, operator/session ports and Pg/fakes, binary `config.rs`/`serve.rs`, platform HTTP routes/catalog and shared panel types; create `docs/operations/operator-access.md`. Test corresponding `*.test.tsx`, `jt_app/tests/m4_platform_access.rs`, `jt_panel_http/tests/m4_platform_access_http.rs`, `bin/jeeta/tests/m4_operator_reset.rs`.

**Interfaces:** Reuse `/api/platform/login`, `/api/platform/workspaces`, T3 operation routes and T5 health. Separate `jt_platform`/`jt_session` cookies; no impersonation/platform MCP. Console `/platform/workspaces`, `/platform/payments`, `/platform/health` shows reference, amount, currency, paid_at, confirmed/activated/revoked states, one-time code with expiry and explicit reissue, suspend/revoke reason forms and resume. Copy: “Ödeme bildirimleri”, “Havale doğrulandı”, “Etkinleştirme kodu”, “Kodu yeniden oluştur”, “Askıya al”, “Yeniden aç”, “Etkinleştirmeyi geri al”. Code handoff is out of band; never expose it in tenant status or client telemetry.

Preserve `platform::bootstrap(deps,email,password)->Result<bool,AppError>`: both env fields, ≥12-character password, existing operator means no-op. Add `OperatorRepo::{set_password(id:OperatorId,password_hash:&str)->(),lock_all()->Vec<OperatorRow>}` and `PlatformSessionRepo::revoke_all(operator:OperatorId)->()` (async Result). `platform::reset_password(deps:&Deps,pctx:&PlatformCtx,target:OperatorId,password:&str)->Result<(),AppError>` requires a DIFFERENT authenticated operator; row `platform.operators.reset_password`, panel_only/Exempt/Always/Write, `POST /api/platform/operators/{operator_id}/reset-password` with `{password}`. Add a console form accepting target operator ID; no new operator-creation policy.

`platform::bootstrap_reset(deps:&Deps,email:&str,password:&str)->Result<(),AppError>` is startup-only: `config.rs` parses `JEETA_PLATFORM_BOOTSTRAP_RESET=1`, requires both bootstrap variables and calls reset instead of bootstrap. With the service stopped, owner sets a protected env file then starts once; lock operator rows, require exactly one matching-email operator, set hashed password and revoke all its sessions atomically, then remove all three env variables. Zero/multiple operators or mismatched email abort boot. Both reset paths validate ≥12 characters; hash before transaction, serialize password verification/session insertion with reset so an in-flight old login cannot mint a surviving session. Update `platform::login` accordingly. Log only target/actor/outcome, never password/hash. No SQL-edit recovery instructions.

- [ ] Tests: `tenant_and_operator_sessions_are_not_interchangeable` covers tenant cookie, bearer/API key, revoked/expired operator cookie and CSRF/request-header checks; `bootstrap_requires_both_fields_and_twelve_characters`; `bootstrap_restart_never_creates_second_operator`; `console_confirmation_retry_keeps_current_status`, `console_code_reissue_and_reason_forms`; `console_contains_no_tenant_body_drilldown`; `operator_reset_revokes_all_sessions`, `sole_operator_bootstrap_reset_changes_password`, `bootstrap_reset_rejects_zero_multiple_or_wrong_operator`, `bootstrap_reset_requires_explicit_flag_and_credentials`, `reset_and_inflight_login_serialize`. Browser tests assert Turkish labels, operator-only navigation and sanitized health fields, not just render snapshots.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_platform_access --test m4_platform_access_http --test m4_operator_reset`; `pnpm --dir panel test src/pages/platform`; `pnpm --dir panel typecheck` → PASS.
- [ ] Commit `feat(panel): platform payment and health console`.

### Task 7: Tenant first-run journey and provider setup guidance

**Files:** Create `panel/src/pages/{BillingPage,OnboardingPage}.tsx`, `api/billing.ts`; modify HomePage, App, existing ConnectPage/ApiKeysPage links and TR/EN copy. Test `BillingPage.test.tsx`, `OnboardingPage.test.tsx`, existing page/API wrapper tests; `jt_panel_http/tests/m4_onboarding_http.rs`.

**Interfaces:** Derive progress from existing `workspace.info` (`jeeta.workspace.info`, `GET /api/workspace`), T2 billing, strategy, team/API-key, capability verification and agent-connection APIs; no new onboarding table, seed or completion boolean. UI routes `/billing` and `/onboarding`. Journey: register → “Ödeme bekleniyor” and strategy preparation → “Havale bildirimini gönder” → “İşletmen onayı bekleniyor” → “Etkinleştirme kodunu gir” → panel `billing.activate` → “Çalışma alanı açık” → invite team/create scoped key → connect and verify capability → connect agent. Show actual gate refusal; no fake timer, trial or recurring payment copy. Show T2 configured price/currency/bank instructions and workspace reference read-only. Any current owner can enter the delivered code; show expiry/lockout/reissue guidance. A suspended workspace says “Çalışma alanı askıya alındı”; entitlement remains visible. Revocation returns to pending; confirmation alone never unlocks team/keys.

API key plaintext appears once; copying is explicit and no analytics/log/URL carries it. Revisit does not redisplay it. Role and scope limits continue. Strategy approved, payment confirmed, connector verified and agent recently connected are separate indicators; stale/no agent warns that work needs the tenant's agent scheduler. Provider setup uses `${JEETA_PUBLIC_BASE_URL}/oauth/callback/{meta|instagram|x}` panel callbacks and actual webhook addresses from `/api/connectors/hooks`; display `reconnect_required` and `access.expires_at`. Missing platform apps (`CONFLICT`) mean “Sağlayıcı uygulaması yapılandırılmadı”, not a successful connection. Existing connector flows own secret entry.

- [ ] Tests: `pending_owner_can_prepare_strategy_and_report_but_not_invite_or_create_key`, `confirmation_waits_for_code_activation`, `activation_unlocks_workspace_but_not_strategy_or_agent`, `owner_redemption_after_transfer_of_ownership`, `first_run_resumes_after_reload_and_suspend`, `key_is_shown_once_and_not_logged`, `provider_missing_app_is_not_connection_success`, `reconnect_and_expiry_are_visible`, `narrow_scopes_do_not_gain_owner_actions`. Exercise API refusals as well as disabled buttons; TR/EN parity continues.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_onboarding_http`; `pnpm --dir panel test src/pages/BillingPage.test.tsx src/pages/OnboardingPage.test.tsx src/pages/ApiKeysPage.test.tsx src/pages/ConnectPage.test.tsx src/i18n/parity.test.ts`; `pnpm --dir panel typecheck` → PASS.
- [ ] Commit `feat(panel): payment and activation first-run journey`.

### Task 8: Reproducible deployment and boot/shutdown contract

**Files:** Create `deploy/jeeta.service`, `deploy/jeeta.env.example`, `deploy/journald-jeeta.conf`, `docs/operations/deployment.md`; modify `README.md`, binary config/serve/stdio/scheduler only where a tested gap requires it. Test: `bin/jeeta/tests/m4_deployment.rs`; release artifact recipe in `.github/workflows/rust.yml` without publishing/deploying.

**Interfaces:** One `jeeta serve` process serves panel/API/MCP and jobs against one PostgreSQL. Distribution manifest records source revision, binary checksum, panel checksum, migration versions and recovery-compatible schema version. Release recipe, from `rust/`:

```sh
cargo build --release --locked -p jeeta
pnpm --dir panel install --frozen-lockfile
pnpm --dir panel build
```

Package `target/release/jeeta`, `panel/dist/`, `migrations/`, `scripts/`, `deploy/` and operation documents from the same revision. Build the binary with package-scoped production features, never workspace test feature unification. Layout example `/opt/jeeta/releases/<revision>/{jeeta,panel,migrations,scripts,deploy}`, `/opt/jeeta/current` pointing to one complete release; retain prior package for rollback. Use `JEETA_FILES_DIR=/var/lib/jeeta/files`; wire this exact variable to the integrated FileStore and require an absolute writable path. It is included in every recovery set.

Install the supplied journald drop-in with `Storage=persistent`, `MaxRetentionSec=30day`, `SystemMaxUse=1G`; these host-wide limits are documented. Systemd example (validate on the target host; no deployment in the worker run):

```ini
[Unit]
Description=Jeeta
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jeeta
Group=jeeta
WorkingDirectory=/var/lib/jeeta
EnvironmentFile=/etc/jeeta/jeeta.env
ExecStart=/opt/jeeta/current/jeeta serve
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/jeeta
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec=60s` exceeds the existing HTTP drain (10 s) plus job grace (30 s). Ensure persistent directories exist with the service owner before starting. A TLS reverse proxy forwards panel/API/MCP/webhooks and preserves the intended public host; document actual proxy timeout/body-size settings from integrated M2/M3 rather than overriding them. FileStore writes must fit the unit's writable paths.

Environment checklist (sample contains names/placeholders only):

- `JEETA_DATABASE_URL`: ordinary schema-owning `NOSUPERUSER NOBYPASSRLS` app role; separate privileged backup/restore access outside app env. `JEETA_ALLOW_SUPERUSER` and `JEETA_ALLOW_TEST_LOOPBACK` unset/false in production.
- `JEETA_SECRET_KEY`: existing 64-hex/32-byte master key; root-owned mode 0600 environment file delivery. The owner keeps the separate recovery copy in their password manager; no shell tracing or command-line key; rotation is not part of this task.
- `JEETA_BIND=127.0.0.1:8080`, `JEETA_PANEL_DIR=/opt/jeeta/current/panel`, `JEETA_COOKIE_SECURE=true`, `JEETA_ALLOWED_HOSTS=<public-host>`, `JEETA_PUBLIC_BASE_URL=https://<public-host>` (origin only). Public URL and allowed hosts have different validation purposes.
- `JEETA_LOG_FORMAT=json`, `JEETA_LOG=info,rmcp=warn`, `JEETA_JOBS_ENABLED=true` for the sole production worker; false for restoration inspection. Stdio-only `JEETA_STDIO_API_KEY` belongs to its protected client environment, not browser config.
- Initial setup only: `JEETA_PLATFORM_BOOTSTRAP_EMAIL` + `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` (≥12 characters); remove both after first successful login. Recovery only: `JEETA_PLATFORM_BOOTSTRAP_RESET=1`, then remove all three variables. Required `JEETA_PRICE_MINOR`, `JEETA_PRICE_CURRENCY`, `JEETA_BANK_INSTRUCTIONS` follow T2; `JEETA_METRICS_TOKEN` follows T5. Code policy is fixed at 8 alphanumerics/72 h/5 attempts, not configurable.
- Meta: `JEETA_META_APP_ID`, `JEETA_META_APP_SECRET`, `JEETA_META_VERIFY_TOKEN`; optional `JEETA_META_LOGIN_CONFIG_ID`, `JEETA_META_WHATSAPP_CONFIG_ID`, `JEETA_META_GRAPH_VERSION` validated against the integrated adapter. Instagram: `JEETA_INSTAGRAM_APP_ID`, `JEETA_INSTAGRAM_APP_SECRET`. X: `JEETA_X_CLIENT_ID`, `JEETA_X_CLIENT_SECRET`. Each app is all-or-none; any configured app needs `JEETA_PUBLIC_BASE_URL`. Inventory additional M2/M3 provider-app/file-store variables directly from their integrated config; do not pretend today's M1 list covers unmerged M3.

Boot order: reject test-loopback binary → connect → reject unsafe DB role → apply pending sqlx up migrations → boot adapters/egress → configured operator bootstrap/reset → bind/start jobs. Migration failure aborts before listening or sending; concurrent migrators serialize via sqlx locking. No automatic down or destructive fallback. `mcp-stdio` currently **does not migrate**, run jobs or serve HTTP; it requires an already compatible database and performs the same role/egress checks. It authenticates its key at startup, so document restart after key revocation/issuer demotion rather than promising immediate revocation. Upgrade backs up first and checks compatibility; running an old binary against a new schema is not assumed safe.

Deployment runbook must include T9's `pg_dump` logical backup recipe, master-key/FileStore recovery warning, continuous WAL/base-backup prerequisites and monthly `restore-drill.sh` invocation, linking the full recovery document. This task cannot claim a deploy-ready recovery path until T9 passes.

- [ ] Tests: `boot_role_check_precedes_migrations`, `migration_failure_never_starts_listener_or_jobs`, `boot_applies_pending_migrations_once`, `stdio_never_migrates_or_runs_jobs`, `provider_apps_require_public_url_and_complete_credentials`, `production_build_refuses_test_loopback`, `shutdown_stops_new_jobs_then_drains_existing`, `jobs_disabled_has_no_background_provider_calls`. Preserve active/pending refresh and active-only poll tests, including marked X retry. Verify static assets and API/MCP from the same package with synthetic configuration.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_deployment`; `systemd-analyze verify deploy/jeeta.service` on a staging layout with the example executable installed; `pnpm --dir panel build` → PASS. Report missing host facilities rather than claiming unit validation. Release build is required once for the packaged candidate; coordinate disk capacity, never remove another worker's artifacts.
- [ ] Commit `docs(ops): reproducible deployment and verified boot behavior`.

### Task 9: Daily backup, continuous WAL and isolated restore drill

**Files:** Create `scripts/backup.sh`, `scripts/restore-drill.sh`, `deploy/jeeta-backup.service`, `deploy/jeeta-backup.timer`, `docs/operations/backup-restore.md`; modify `.github/workflows/rust.yml`, deployment docs/README/Makefile and T5 status-artifact reader; test `scripts/tests/backup-restore.sh`, `jt_pg/tests/m4_restore.rs`. No checked-in dumps, keys or production evidence.

**Interfaces:** `backup.sh <backup-root>` creates a private recovery directory with manifest, DB archive, file snapshot metadata and checksums, and atomically writes `backup-status.json` only after validation. `restore-drill.sh <recovery-set> <isolated-target-config>` requires an explicit disposable target; refuses a source/target collision, nonempty target and production public origin. Protected config files supply connections/keys; scripts do not accept secrets as positional args, echo environment, enable `set -x` or log decrypted canaries. The T5 runtime probe refreshes `wal-status.json` every 60 seconds and records archive success/failure from PostgreSQL archiver state plus archive-destination verification, with an observation timestamp; a logical dump does not update WAL success. Q6 sets RPO 24 h / RTO 1 h; the owner operates backups and runs a monthly drill. Implementation layout: protected separately mounted `/var/backups/jeeta/{logical,base,wal}`; keep 30 daily logical sets and a verified 30-day base/WAL chain, pruning only after a newer complete chain is verified.

Logical full-backup recipe uses a protected libpq service/passfile, e.g. `pg_dump --format=custom --file="$backup_dir/database.dump" --dbname=service=jeeta_backup`; companion restore uses `pg_restore --exit-on-error --no-owner --dbname=service=jeeta_restore "$backup_dir/database.dump"`. Provision the same ordinary application roles/ownership and validate FORCE RLS after restore; privileged restoration credentials never become the application credentials. Daily full backups are mandatory. For point-in-time recovery, maintain a **physical base backup and continuous WAL archive** (`pg_basebackup` plus PostgreSQL archive configuration) and restore a base backup + matching WAL to the selected recovery target. WAL cannot be replayed onto a `pg_dump` restore. Document/test logical restore and PITR as distinct paths, not an interchangeable recipe.

Recovery set includes matching user uploads/publication evidence, DB reference consistency point, exact release/schema/config metadata, master-key identifier and a separately protected copy of the **same** master key. `panel/dist` is replaceable release content, not user FileStore data. A DB dump cannot decrypt credentials without that key; a newly generated key is not recovery. Quiesce writes by stopping the single application and blocking ingress before pg_dump + copying `JEETA_FILES_DIR`; resume only after both snapshots/checksums complete. The backup service brackets this with stop/restart and preserves a failed marker on errors. Keep files append-only for the retained PITR window, snapshot at each base backup and before drill, and verify target DB references against that retained file set; restore orphan files without deleting referenced evidence. Verify hashes and DB-to-file references, not only backup command exit status. Retention never removes the only recoverable base/WAL/key chain.

Drill order: restore to isolated network/DB/files; validate manifest/schema against matching binary **before `serve` can auto-migrate**; provide matching key; disable jobs and block all provider egress/production webhooks at network level; open only isolated inspection access. Check synthetic two-tenant RLS, sealed-canary decrypt equality without printing plaintext, file read/checksum, ledger, payment notification/entitlement/status and outbox uncertainty. Exercise missing/wrong key and missing files as failed drills. For PITR, insert synthetic records before/after a marked target and prove only intended state recovered. Provider tokens may have rotated externally: surface reconnect, do not claim the external provider rolled back. Jobs are enabled only in a separate reviewed cutover step, never automatically by the drill.

Deliver systemd examples: `jeeta-backup.service` Type=oneshot runs `/opt/jeeta/current/scripts/backup.sh /var/backups/jeeta/logical` with a root-only recovery EnvironmentFile, UMask=0077 and only required service-stop/storage privileges. `jeeta-backup.timer`: OnCalendar=*-*-* 02:00:00, Persistent=true, Unit=jeeta-backup.service, WantedBy=timers.target. Package scripts with the release. Continuous PostgreSQL `archive_mode=on`/`archive_command` and physical base backups remain enabled independently of this nightly logical timer. Validate both units in the staging layout.

Scripts read a protected recovery config that selects the target cluster/files/service; the CI config names only its disposable process and directories, never the host production service. `restore-drill.sh` uses manifest `kind=logical|physical` to select the fixed logical/PITR path; `backup.sh` produces the nightly logical set and weekly physical base set (Sunday), each with files/checksums.

CI job `restore-drill` in `.github/workflows/rust.yml` installs matching PostgreSQL client/server tools, creates disposable logical and physical clusters/directories plus synthetic keys/FileStore, then runs `bash scripts/tests/backup-restore.sh` and the `m4_restore` target. The shell harness must invoke the actual `backup.sh` and `restore-drill.sh` for both logical and PITR paths; verify `ci_runs_real_restore_scripts`, checksums, RLS, code/grant history, elapsed time and cleanup. Block external network traffic, use synthetic provider canaries and fail on any attempted call; upload only a sanitized report.

- [ ] Tests: `restore_requires_matching_key_and_files`, `restore_checks_schema_before_serve`, `restore_drill_has_zero_provider_traffic`, `logical_restore_preserves_rls_payment_and_ledger`, `pitr_stops_at_selected_target`, `backup_failure_does_not_advance_success_marker`, `restore_refuses_production_or_nonempty_target`, `restored_unknown_send_is_not_retried`. Drill report: source revision, backup time, WAL target, file/key integrity outcome (no secret), elapsed recovery time and observed data-loss interval against RPO 24 h / RTO 1 h; failures fail the drill. The owner performs and records the monthly logical/PITR exercise and daily backup/WAL checks.
- [ ] Fast red/green: `bash -n scripts/backup.sh scripts/restore-drill.sh scripts/tests/backup-restore.sh`; `bash scripts/tests/backup-restore.sh`; `systemd-analyze verify deploy/jeeta-backup.service deploy/jeeta-backup.timer`; `cargo test --locked --workspace --test m4_restore` → PASS. Test harness provisions disposable PostgreSQL fixtures/physical recovery directories; neither production access nor live-provider calls are required.
- [ ] Commit `feat(ops): verified backup and isolated restore drills`.

### Task 10: v1 carry-over inventory, cutover and rollback rehearsal

**Files:** Create `docs/operations/v1-cutover.md`; modify README and synthetic `scripts/tests/v1-cutover.sh`. Public document contains procedure and synthetic examples only; local v1 research/customer exports remain excluded.

**Interfaces:** No importer, migration endpoint, MCP tool or new DB port under the current §14/§16 baseline. Q8 freezes the fresh-start ruling: Ek A means reusable knowledge/algorithms/designs, while the spec and prep C1 explicitly exclude historical customer-data import. If the owner wants a selected data import, controller must first approve a new field-level allowlist, consent/retention rules, identity/ID mapping, dry-run reconciliation and reversible up/down seed procedure that removes only untouched imported fixed-key rows. That is a separate amended dispatch, not implicit permission to copy v1 tables or secrets.

Document this complete keep/remove/defer inventory with evidence links to integrated M1–M3 tests:

| Disposition | Scope |
|---|---|
| Keep — Ek A knowledge | Thompson sampling/reward logic; publication/measurement provider knowledge; NetGSM behavior; email receive/send rules; MCP OAuth 2.1 design; sealed-secret approach; tenant-filter architecture tests; design system/three-column inbox; roles/invitations. Verify each against its integrated implementation; design carry-over does not prove OAuth implementation complete. |
| Remove — §3/§16 | Credits/packages/subscriptions/top-ups/reseller billing/coupons/trials; internal AI/media generation or research/trend provider dependencies; field installs, sales reports, sites/courses/forms/orders; multiple brands/nested groups/simultaneous journeys/three extra languages; ad campaign/creative creation, product catalog/PDF quotes, customer-payment connector, public booking page. |
| Defer | Additional Connector adapters, object-store FileStore adapter, product payment provider, service split, webchat widget, master-key rotation. |
| Start fresh — C1 | Workspaces, memberships, keys and reconnected capabilities; no imported people, conversations/mail, payments, publications, queues, learning history, ledger, sessions, invitations or v1 sealed credentials. |

Q7 requires **NEW reviewed provider apps**; no v1 app transfer. The owner chooses and records the switch time, owns event-gap reconciliation and the access-controlled read-only v1 archive retained for **90 days**. Record old/new app IDs, account bindings, callbacks, DNS/proxy and webhook targets; freeze v1 sends/polls, back up both systems, verify new reviews/callbacks/hooks/account identity, switch the single Meta webhook destination, then enable the new sender once. Missing provider approval blocks live acceptance. No automatic exactly-once guarantee across installations.

Rollback = stop new sends/polls, preserve all new messages/payment/code/grant audit, **re-point webhooks** to recorded old routing, restore proxy/callback bindings and old sender ownership in order, then reconcile external writes manually under the owner. The v1 archive remains read-only; resume the old runtime from its retained state, never mutate the archive. No v2→v1 merge or replay of unknown sends; record the gap and isolated new data even after rollback.

- [ ] Tests/rehearsal: `cutover_never_has_two_active_senders`, `cutover_records_single_webhook_and_gap_owner`, `cutover_requires_new_reviewed_apps_and_owner_time`, `v1_archive_is_read_only_for_ninety_days`, `rollback_repoints_webhooks_before_old_sender_starts`, `rollback_preserves_new_payment_and_messages`, `new_data_requires_recorded_rollback_decision`, `fresh_start_imports_no_v1_secrets_or_history`. Use two mock installations and a recording fake provider; test the documented operations and stop points, not claims based on prose alone.
- [ ] Fast red/green: `bash -n scripts/tests/v1-cutover.sh`; `bash scripts/tests/v1-cutover.sh` → PASS; inventory every Ek A row with a real test/evidence reference after integration, no fabricated proof.
- [ ] Commit `docs(ops): v1 carry-over inventory and rehearsed cutover`.

### Task 11: Architecture parity, release smoke and owner acceptance

**Files:** Create `jt_archtest/tests/m4_productisation.rs`, `scripts/smoke-productisation.sh`, `docs/operations/m4-acceptance.md`; modify `jt_archtest/tests/{gate_rule,twin_rule,dependency_boundaries}.rs`, README, Makefile and `.github/workflows/rust.yml`; shared fixtures/tests only where required.

**Interfaces:** `make smoke-productisation` invokes the synthetic script against disposable Pg plus recording connectors. Register final exact catalog set, status exceptions, permissions and schemas. Add exactly T2 `{billing.status,billing.report_payment}`, T3 `{platform.payments.list,platform.billing.confirm,platform.billing.reissue,platform.billing.revoke_activation,platform.workspaces.suspend,platform.workspaces.resume}`, T4 `{billing.activate}`, T5 `{ops.health}`, T6 `{platform.operators.reset_password}`; remove `{platform.workspaces.set_status}`. Net +10 rows against the integrated baseline; assert exact names and total, never `>=`. Only `billing.report_payment` has a new MCP twin; activation/platform/ops stay panel_only. No spending/quota concept or production `test-loopback` path.

Smoke covers register → pending strategy → notification → operator confirmation/code handoff → current owner panel redemption → permanent activation across restart → team/key/capability verification → authenticated MCP action; assert independent strategy gate, scopes, unauthorized/foreign-workspace refusal, suspension/resume/revoke/re-confirm of the same payment and code single use. Then synthetic webhook→person→agent reply→publication→measurement across integrated M2/M3, plus restore evidence and operator visibility. This validates the existing milestones, not an invitation to reimplement them in M4. No real payment, message, publication or provider traffic in CI.

- [ ] Tests: `catalog_and_handlers_match_ratified_m4_surface_set`, `platform_and_ops_have_no_mcp_tools`, `only_named_billing_rows_bypass_pending_status`, `payment_does_not_add_credit_or_subscription_dependency`, `m4_surface_schema_and_effect_parity`, `full_productisation_smoke`. Run source/ledger/log secret-canary checks and ordinary-role RLS tests. Add `retention_preserves_messages_publication_evidence_and_ledger` and `raw_bodies_and_probe_runs_obey_thirty_day_boundaries` with synthetic old/young records; cleanup may purge only the latter eligible records. All Rust unit/adapter/Pg/architecture tests and panel tests remain required.
- [ ] Fast red/green: `cargo test --locked --workspace --test m4_productisation --test twin_rule --test gate_rule`; `make smoke-productisation` → PASS.
- [ ] Final release candidate: run the shared full block exactly once; additionally `cargo test --locked -p jt_outbound --test production_build`, `RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps`, `cargo deny --locked check`, `pnpm --dir panel test`, `pnpm --dir panel typecheck`, `pnpm --dir panel build`. Attach successful T8 release build, T9 logical/PITR drill and T10 cutover rehearsal evidence. Keep Rust CI independent of v1; any later release tag scheme must not collide with v1, and this worker does not tag/publish.
- [ ] Prepare a Turkish owner-smoke checklist: “Kayıt”, “Ödeme beklerken strateji”, “Havale bildirimi ve işletmen onayı”, “Panelde etkinleştirme kodu”, “Kalıcı açılış”, “Yetkisiz erişimin reddi”, “Askıya alma ve yeniden açma”, “Panel/MCP kapıları”, “Örnek bağlayıcı”, “Yedekten geri dönüş”. Owner alone conducts authorized live provider/payment smoke and records date/revision/outcomes; unresolved app approval or failed restore keeps M4 acceptance open.
- [ ] Commit `test(ops): productisation acceptance and architecture coverage`; coordinator handles integration and live acceptance.

## Self-review notes

- **Coverage:** §9 amended by Q2, payments/activation/history T1–T4/T7; §10 ordinary-role RLS, reversible migrations/backfill, retention, FileStore/key recovery, nightly full backup + continuous WAL T1/T8/T9/T11; §11 operator identity/reset and team/scopes T5–T7; §12 pure/Pg/race/adapter/panel/architecture/restore tests T1–T11.
- **§14–16/Ek A:** fresh start and complete keep/remove/defer inventory T10; provider review/reconnect and single-process isolation T7–T10; manual owner acceptance T11. No historical import, payment provider, SaaS or excluded v1 feature is introduced.
- **Interfaces:** T1 owns schema/repository contracts, T2 DTOs/config/twin, T3 confirmation/transitions, T4 panel redemption. Status mutation, legacy API removal, reset and all fakes/wrappers are explicit. Serve migrates; stdio does not. Every Review Focus entry has a named test; exact assertions stay exact.
- **Execution:** use fast tests then one final full block per implementation run. This document-only revision runs its task-file Verify; M4 implementation/live acceptance remain future work. All rulings below are applied; no controller question remains.

## Ruling applied

D1–D8 refer to the eight T021 builder-check defects.

| ID | Binding decision / resolved defect | Tasks |
|---|---|---|
| Q1 | Env price/currency/bank text, normalized workspace reference, reasoned revoke, out-of-band refunds | T1–T3, T7–T8 |
| Q2 | Explicit §9/K11 amendment: evidence-only owner panel/MCP twin; operator 8-character/72-hour/5-attempt code; panel redemption | T2–T4, T6–T7, T11 |
| Q3 | Activate/suspend/resume/revoke state machine; permanent paid/grandfathered provenance and reversible backfill | T1, T3–T4, T7, T11 |
| Q4 | Another operator resets password; sole-operator flag recovery revokes sessions | T6, T8 |
| Q5 | Journald, token-protected Prometheus metrics, public probes, operator health; no SaaS | T5–T6, T8 |
| Q6 | Nightly timer/dump + files, continuous WAL, CI restore, password-manager key custody, RPO 24 h/RTO 1 h, owner monthly drill | T8–T9, T11 |
| Q7 | New reviewed apps, owner switch time, read-only 90-day archive, webhook rollback | T10–T11 |
| Q8 | Fresh start; Ek A knowledge only; historical import requires separate owner-approved brief | T10 |
| P1 | Same payment may be re-confirmed after revoke; one new grant/code, retries idempotent, history retained | T1, T3–T4, T11 |
| P2 | Any current owner redeems; no recipient binding; ownership changes retain validity; redeemer recorded | T1, T4, T7 |
| D1 | Correct evidence→confirm→code→activate flow, tenant status mutation, atomicity and races | T1–T4, T6–T7, T11 |
| D2 | Paid/grandfathered source, closed grant history, separate backfill pair with edited-row protection | T1, T3 |
| D3 | Remove unrestricted status API; explicit reasoned suspend/revoke and entitlement-preserving resume | T1, T3, T6 |
| D4 | Workspace-locked challenge; distinct/concurrent wrong guesses, expiry and reissue tested | T1, T4 |
| D5 | Password/session ports, config reset mode and real recovery tests | T6, T8 |
| D6 | Amount/paid_at persistence/projection, immutable retry evidence, instructions/reference DTO | T1–T3, T7–T8 |
| D7 | Bounded authenticated metrics plus separate liveness/readiness/operator health | T5, T8 |
| D8 | Backup service/timer, real CI restore scripts, logical/PITR paths, full recovery set and SLO | T8–T9, T11 |
