# M1a Strateji ve Kabiliyetler (Strategy gate, consultation, capability registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the strategy gate real: versioned strategies formed through a recorded consultation and approved by a human or their agent; a capability registry (accounts, devices, agent connections, computer accesses, third-party tools, budget items) with groups, policies and agent-reported verification; per-workspace secret sealing; a "what is pending" entry point for agents with the agent check-in warning (B11). Connectors (Meta, NetGSM, X) are the separate M1b plan.

**Architecture:** Two new pure domain crates (`jt_strategy`, `jt_capability`) and one driven adapter (`jt_seal`, AES-256-GCM with a per-workspace key derived from the master key). `jt_app` gains ports, use cases and catalog rows; `jt_pg` gains migrations 0002/0003 and repos under the same RLS discipline; `jt_panel_http` and `jt_mcp` gain routes and tools from the catalog; the binary swaps `NoStrategyYet` for `PgStrategyGate`. Every rule of M0 (twin rule, status/strategy gate, SQL scoping scan, ledger on every mutation, secrets never in payloads) continues to apply.

**Tech Stack:** as M0 (Rust 1.96, axum 0.8, sqlx 0.8.6, rmcp 3.6, React 18 panel) plus `aes-gcm` 0.11, `hkdf` 0.13, `zeroize` 1.9 (only in `jt_seal`).

**Spec:** `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` §5 (Strateji kapısı, incl. the M0 amendments), §6 (Kabiliyetler: 6.1 tek varlık, 6.2 tür listesi, 6.3 gruplar, 6.4 doğrulama, 6.5 araçlar), §4.2 rule 3 (ajanı uyandırmak sistemin işi değil), B1, B10, B11, §13 M1 row. Reference: M0 plan `docs/superpowers/plans/2026-10-22-rust-m0-temel.md` (Global Constraints apply verbatim) and the M0 ledger copy `docs/reports/v2-reference/rust-rewrite-research/05-m0-sdd-ledger.md` (deferred items folded into Task 1 here).

## Global Constraints

All M0 Global Constraints apply unchanged (no AI/media/STT/TTS libraries; only `jt_outbound` has an HTTP client; tenant tables carry `workspace_id` with FORCE RLS and are reached only through `TenantTx`; reversible `.up.sql`/`.down.sql` pairs with the round-trip test green; English code / Turkish copy; `jeeta.<domain>.<action>` tool names; twin rule; structured errors; secrets never in repo; plain commits with no AI trailer; v1 untouched). Additions:

- **Status gate:** every new use case except `strategy.*` and `work.*` is subject to `WORKSPACE_INACTIVE` (they are not `status_exempt`); `strategy.*`, `capability.*`, `budget.*`, `work.*`, `agent.*` are **strategy-Exempt** (spec §5: "kabiliyet araçları açıktır çünkü istişare bağlı hesapları bilmek ister"; an agent must be able to ask what is pending before a strategy exists). The gate-rule archtest's exempt-prefix list grows by exactly `strategy.`, `capability.`, `budget.`, `work.`. No `Gated` use case is introduced by this plan; B1's behavioural test now runs against the real `PgStrategyGate` (Task 5).
- **Approval authority (K11, §5):** `strategy.approve` and `strategy.archive` require `role_key == "owner"` or `"manager"` (the agent inherits its issuer's role) and no one-time code.
- **Hypothesis identity** (spec §5 "Sürüm değişince sürmekte olan iş"): a hypothesis id is stable across versions; a new draft starts as a copy of the approved version with every hypothesis `kept`; edits mark `retired` or `added`.
- **One approved version per workspace** enforced by a partial unique index; approving archives the previous approved version in the same transaction.
- **Secrets:** sealed blobs (`jt_seal`) are never returned by any use case; `connector_public` and masks only. Sealing key = HKDF-SHA256(master `JEETA_SECRET_KEY`, info = workspace id); nonce 96-bit random per seal; format `v1 || nonce || ciphertext`.
- **Capability kinds** are the closed list in Task 6 (from spec §6.2) plus `third_party.other` with a free `key_detail`; unknown kinds are `VALIDATION`.
- **Verification evidence** is the agent's claim: text plus optional references (a file id, a serial, a screenshot id); the system records it, never checks it (spec §6.4). Connector probes are M1b.
- **Egress tenant hosts** are written only through `jt_app`'s `TenantHostRegistry` port whose `jt_outbound` adapter rejects non-public IP literals and `localhost` (the M0 Task 13 carry-over) — the port is created here; the first caller is M1b.
- **Ledger:** every mutation writes one entry with `Subject { kind: "strategy_version"|"hypothesis"|"consultation"|"capability"|"capability_group"|"budget_item"|"budget_spend" }` and `strategy_version_id` set to the approved version at the time, when one exists.
- **Panel copy** TR/EN parity test stays green; no AI product names.

## Review Focus

1. **Approving an empty or inconsistent strategy** — a draft with no hypothesis, or a hypothesis whose channel names no connected capability group, must be refused with `VALIDATION` listing the gaps; a reasonable owner expects approval to mean "complete". Pinned in Task 2 (rules) and Task 4 (use case).
2. **Two approvals racing** — two managers approving two drafts at once must end with exactly one approved version. Pinned in Task 3 (partial unique index + pg test) and Task 4.
3. **A capability from another workspace in a group or budget link** — adding workspace B's capability to A's group, or linking B's budget item, must be `NOT_FOUND`, never a cross-tenant reference. Pinned in Task 7 (pg) and Task 8 (use case).
4. **Stale verification** — a device verified 40 days ago with a 30-day policy must read as `declared` (not `verified`) everywhere it is listed, and `work.pending` must list it. Pinned in Task 6 (pure derivation) and Task 10.
5. **Sealed data leaking** — no response, ledger payload, `Debug` output or panel JSON contains a sealed blob or the derived key; a test serialises every capability output and the ledger after a seal and asserts absence. Pinned in Task 1 and Task 8.

---

## File Structure

```
rust/
  migrations/0002_strategy.up.sql / .down.sql
  migrations/0003_capabilities.up.sql / .down.sql
  crates/
    domain/jt_strategy/src/{lib.rs,version.rs,sections.rs,hypothesis.rs,consultation.rs,rules.rs}
    domain/jt_capability/src/{lib.rs,kind.rs,capability.rs,group.rs,budget.rs,policy.rs,status.rs}
    adapters/jt_seal/src/{lib.rs,aes.rs}                 SecretBox adapter (AES-256-GCM + HKDF)
    jt_app/src/ports.rs                                   + SecretBox, StrategyRepos, CapabilityRepos, TenantHostRegistry, WorkspacePolicyRepo
    jt_app/src/usecases/{strategy.rs,capabilities.rs,groups.rs,budget.rs,work.rs}
    jt_app/src/catalog.rs                                 + rows (Task 4/8/10 tables)
    jt_app/src/gate.rs                                    unchanged API; PgStrategyGate lives in jt_pg
    adapters/jt_pg/src/repos/{strategy.rs,hypotheses.rs,consultation.rs,capabilities.rs,groups.rs,budget.rs,policies.rs}
    adapters/jt_pg/src/strategy_gate.rs                   PgStrategyGate
    adapters/jt_outbound/src/public_host.rs               validate_public_host + TenantHostRegistry adapter
    adapters/jt_panel_http/src/routes/{strategy.rs,capabilities.rs,groups.rs,budget.rs,work.rs}
    adapters/jt_mcp/src/tools/{strategy.rs,capabilities.rs,budget.rs,work.rs}
    jt_testkit/src/{fakes.rs (extended), panel.rs (shared HTTP harness)}
    jt_archtest/tests/{gate_rule.rs (prefixes), sql_scoping.rs (auto via migrations), twin_parity.rs (+strategy.get)}
  bin/jeeta/src/serve.rs                                  PgStrategyGate + Seal wiring
  panel/src/pages/{StrategyPage,CapabilitiesPage,BudgetPage}.tsx, api/{strategy,capabilities,budget,work}.ts, HomePage (strategy state, agent check-in, pending work)
```

---

### Task 1: M0 carry-overs and the `jt_seal` secret box

**Files:**
- Create: `rust/crates/adapters/jt_seal/{Cargo.toml,src/lib.rs,src/aes.rs}`, `rust/crates/adapters/jt_seal/tests/seal.rs`
- Modify: `rust/Cargo.toml` (members, deps `aes-gcm`, `hkdf`, `zeroize`), `rust/crates/jt_app/src/ports.rs` (+`SecretBox` port), `rust/crates/jt_archtest/tests/dependency_boundaries.rs` (only `jt_seal` may depend on `aes-gcm`/`hkdf`), `rust/crates/adapters/jt_pg/Cargo.toml` and `rust/Cargo.toml` (`sqlx` with `default-features = false` and the explicit feature list), `rust/crates/jt_app/src/ports.rs` (drop `Serialize` from `UserRow`, `SessionRow`, `PlatformSessionRow`, `ApiKeyRow`, `MembershipRow`, `OperatorRow` or `#[serde(skip_serializing)]` on the hash fields), `rust/crates/jt_app/src/usecases/roles.rs` + `rust/crates/adapters/jt_pg/src/repos/roles.rs` + fakes (`count_memberships_using` counts only non-removed memberships; `delete_custom` re-points removed rows to the system `rep` role first), `rust/crates/jt_testkit/src/panel.rs` (move the duplicated HTTP test harness from `jt_panel_http/tests/*` into testkit; tests import it), `rust/Makefile` (`--locked` on cargo commands), `rust/bin/jeeta/src/config.rs` (expose the 32-byte master key to the seal adapter)
- Test: `rust/crates/adapters/jt_seal/tests/seal.rs`, existing suites

**Interfaces:**
- Produces (`jt_app::ports`): `#[async_trait] pub trait SecretBox: Send + Sync { fn seal(&self, ws: WorkspaceId, plaintext: &[u8]) -> Result<Vec<u8>, AppError>; fn open(&self, ws: WorkspaceId, sealed: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, AppError>; }` (sync fns; `zeroize` becomes a `jt_app` dependency — add to the archtest allowlist).
- Produces (`jt_seal`): `pub struct AesSecretBox` with `AesSecretBox::new(master: [u8; 32]) -> Self`; per-workspace key = HKDF-SHA256(ikm = master, salt = b"jeeta-seal-v1", info = ws.as_uuid().as_bytes()); output `[0x01] ++ nonce(12) ++ aes_gcm_ciphertext`; `open` fails with `AppError::internal("sealed data cannot be opened")` on wrong workspace, truncated input or bad tag (never leaks why).
- Produces (`jt_testkit::fakes`): `PlainSecretBox` (`seal` = `b"plain:" ++ ws ++ b":" ++ plaintext`, `open` checks the workspace prefix) for use-case tests.
- Produces (`Deps`): `pub seal: Arc<dyn SecretBox>` field added to `jt_app::usecases::Deps` (fakes and bin updated).

- [ ] **Step 1: Failing tests** (`jt_seal/tests/seal.rs`): `round_trip_per_workspace`; `another_workspace_cannot_open` (same master, different ws → error); `tampered_byte_is_refused`; `truncated_input_is_refused`; `two_seals_of_same_plaintext_differ` (random nonce); `output_never_contains_plaintext` (plaintext `b"jt_live_secret"` absent from the sealed bytes). In `jt_archtest`: extend `dependency_boundaries.rs` so only `jt_seal` lists `aes-gcm`/`hkdf`.
- [ ] **Step 2: Run to fail.** `cd rust && cargo test -p jt_seal`
- [ ] **Step 3: Implement** the crate, the port, `Deps.seal`, the fake, and the carry-overs listed in Files (each carry-over keeps its existing tests green; add `used_then_removed_role_can_be_deleted` to `jt_app/tests/team.rs` or `roles` tests).
- [ ] **Step 4: Run** `cd rust && make check` (env `JEETA_TEST_DATABASE_URL` set) and `cd rust/panel && pnpm test` (harness move must not change panel tests).
- [ ] **Step 5: Commit** `feat(seal): per-workspace secret box, and the M0 carry-overs`

---

### Task 2: Domain crate `jt_strategy`

**Files:**
- Create: `rust/crates/domain/jt_strategy/{Cargo.toml,src/lib.rs,src/version.rs,src/sections.rs,src/hypothesis.rs,src/consultation.rs,src/rules.rs}`, `rust/crates/domain/jt_strategy/tests/rules.rs`
- Modify: `rust/Cargo.toml` (member), `rust/crates/jt_archtest/tests/dependency_boundaries.rs` (`jt_strategy` is a domain crate: `DOMAIN_ALLOW` + `jt_tenancy`)

**Interfaces:**
- Ids: `StrategyVersionId`, `HypothesisId`, `ConsultationEntryId` (same newtype macro pattern as `jt_tenancy`, defined here).
- `pub enum VersionStatus { Draft, Approved, Archived }` with `key()`/`parse()`.
- `pub struct StrategyVersion { pub id, pub workspace_id, pub number: i32, pub status, pub sections: Sections, pub created_at, pub created_by: Actor-like (UserId + Option<AgentConnectionId>), pub submitted_at: Option<_>, pub approved_at: Option<_>, pub approved_by: Option<UserId>, pub archived_at: Option<_> }`.
- `pub struct Sections { pub identity: Identity, pub audience: Vec<Segment>, pub channels: Vec<ChannelChoice>, pub goals: Goals, pub budget_frame: BudgetFrame, pub prohibitions: Vec<String>, pub cadence: Cadence, pub paid_enabled: bool }` with:
  - `Identity { product: String, voice: String, positioning: String, usp: String }`
  - `Segment { key: String /* [a-z0-9_]{2,32} */, name: String, description: String }`
  - `ChannelChoice { channel: String /* a capability kind key from jt_capability, validated in jt_app */, rationale: String, group_id: Option<Uuid> }`
  - `Goals { objective: String, kpis: Vec<Kpi { name, target: String }> }`
  - `BudgetFrame { lanes: Vec<Lane { lane: LaneKind /* Organic|Paid */, period: Period /* Weekly|Monthly */, cap_minor: i64, currency: String /* ISO 4217, 3 upper */ }> }`
  - `Cadence { per_week: u16 /* 0..=70 */, channel_mix: Vec<Mix { channel: String, share_pct: u8 }> /* shares sum to 100 when non-empty */ }`
  - all `Serialize + Deserialize + Clone + Debug + PartialEq`, `Default` for `Sections`.
- `pub struct Hypothesis { pub id: HypothesisId, pub title: String, pub segment_key: String, pub angle: String, pub channel: String, pub metric: String, pub confidence: f32 /* 0.0..=1.0 */, pub state: HypothesisState /* Kept|Retired|Added */ }`.
- `pub enum ConsultationKind { Question, Answer, Assumption, SectionDraft, Note, Submitted, Approved, Archived }`; `pub struct ConsultationEntry { pub id, pub version_id, pub kind, pub section_key: Option<String>, pub text: String /* ≤ 20_000 chars */, pub actor: jt_ledger::Actor, pub at }`.
- Rules (`rules.rs`, pure):
  - `pub fn validate_sections(s: &Sections) -> Vec<Gap>` where `Gap { field: String, message: String }`: product non-empty; ≥1 segment with unique keys; ≥1 channel; every `Mix.channel` ∈ channels; shares sum to 100 when non-empty; every lane currency valid; `paid_enabled` ⇒ ≥1 `Paid` lane; prohibitions ≤ 100 items.
  - `pub fn validate_for_approval(s: &Sections, hyps: &[Hypothesis], known_channels: &BTreeSet<String>) -> Vec<Gap>`: `validate_sections` + ≥1 non-retired hypothesis + every hypothesis `segment_key` ∈ segments + every hypothesis/channel `channel` ∈ `known_channels` (the caller passes the workspace's connected capability kinds and `"any"`) — Review Focus 1.
  - `pub fn next_draft_from(approved: &StrategyVersion, hyps: &[Hypothesis]) -> (Sections, Vec<Hypothesis>)`: copies sections, every hypothesis `Kept`.
  - `pub fn diff(a: &Sections, b: &Sections) -> Vec<String>` (dotted field paths that differ).
  - `pub fn budget_cap_for(s: &Sections, lane: LaneKind) -> Option<(i64, Period, String)>`.

- [ ] **Step 1: Failing tests** (`tests/rules.rs`): `validate_sections_reports_every_gap_at_once` (empty product, no segment, mix share 60 → three gaps); `approval_requires_a_live_hypothesis_and_known_channels`; `next_draft_keeps_every_hypothesis`; `diff_lists_changed_paths`; `currency_and_shares_rules`.
- [ ] **Step 2: Run to fail. Step 3: Implement. Step 4: Run to pass**, clippy clean.
- [ ] **Step 5: Commit** `feat(strategy): versions, sections, hypotheses, consultation entries and approval rules`

---

### Task 3: Migration 0002 and strategy repositories

**Files:**
- Create: `rust/migrations/0002_strategy.up.sql`, `rust/migrations/0002_strategy.down.sql`, `rust/crates/adapters/jt_pg/src/repos/{strategy.rs,hypotheses.rs,consultation.rs}`, `rust/crates/adapters/jt_pg/src/strategy_gate.rs`
- Modify: `rust/crates/jt_app/src/ports.rs` (+`StrategyRepo`, `HypothesisRepo`, `ConsultationRepo`, `TenantRepos::{strategy, hypotheses, consultation}` accessors), `rust/crates/adapters/jt_pg/src/uow.rs`, `rust/crates/jt_testkit/src/fakes.rs`
- Test: `rust/crates/adapters/jt_pg/tests/strategy_repos.rs`, `rust/crates/adapters/jt_pg/tests/migrations.rs` (table count 10 → 13)

**Interfaces:**
- SQL (`0002_strategy.up.sql`, all `if not exists`, all tenant tables with ENABLE+FORCE RLS and the standard `<t>_ws` policy):
  - `strategy_versions(id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade, number int not null, status text not null check (status in ('draft','approved','archived')), sections jsonb not null default '{}'::jsonb, created_at timestamptz not null, created_by_user uuid, created_by_connection uuid, submitted_at timestamptz, approved_at timestamptz, approved_by uuid references users(id), archived_at timestamptz, unique (workspace_id, number))` + `create unique index if not exists strategy_versions_one_approved on strategy_versions (workspace_id) where status = 'approved'` + `create unique index if not exists strategy_versions_one_draft on strategy_versions (workspace_id) where status = 'draft'`.
  - `strategy_hypotheses(version_id uuid not null references strategy_versions(id) on delete cascade, workspace_id uuid not null, hypothesis_id uuid not null, title text not null, segment_key text not null, angle text not null, channel text not null, metric text not null, confidence real not null check (confidence >= 0 and confidence <= 1), state text not null check (state in ('kept','retired','added')), position int not null, primary key (version_id, hypothesis_id))`.
  - `consultation_entries(id uuid pk, workspace_id uuid not null, version_id uuid not null references strategy_versions(id) on delete cascade, kind text not null, section_key text, text text not null, actor_kind text not null, actor_user_id uuid, agent_connection_id uuid, actor_component text, at timestamptz not null)` + index `(version_id, at)`; append-only trigger like the ledger.
- Ports: `StrategyRepo { insert(StrategyVersion); find(id) -> Option; current_approved() -> Option; current_draft() -> Option; list() -> Vec (newest first); update_sections(id, Sections, at); set_status(id, VersionStatus, at, by: Option<UserId>) -> rows changed; next_number() -> i32 }`; `HypothesisRepo { replace_all(version_id, Vec<Hypothesis>); list(version_id) -> Vec; upsert(version_id, Hypothesis); set_state(version_id, HypothesisId, HypothesisState) }`; `ConsultationRepo { append(ConsultationEntry) -> ConsultationEntryId; list(version_id, limit, before: Option<OffsetDateTime>) -> Vec }`.
- `jt_pg::PgStrategyGate::new(pool)` implementing `StrategyGate` with `select exists(select 1 from strategy_versions where workspace_id = $1 and status = 'approved')` under `TenantTx` (statement names `workspace_id`).

- [ ] **Step 1: Failing tests**: `one_approved_version_per_workspace_is_enforced_by_the_index` (second approved insert → CONFLICT; Review Focus 2), `one_draft_per_workspace`, `hypotheses_replace_and_set_state`, `consultation_is_append_only_and_lists_newest_first`, `strategy_gate_flips_when_a_version_is_approved`, migrations round trip (count 13).
- [ ] **Step 2–4:** fail → implement (pg + fakes with the same contracts) → pass; `cargo test -p jt_archtest` (SQL scan picks up the new tables; every statement names `workspace_id`).
- [ ] **Step 5: Commit** `feat(pg): strategy versions, hypotheses, consultation log and the real strategy gate`

---

### Task 4: Strategy use cases

**Files:**
- Create: `rust/crates/jt_app/src/usecases/strategy.rs`, `rust/crates/jt_app/tests/strategy.rs`
- Modify: `rust/crates/jt_app/src/catalog.rs` (rows below), `rust/crates/jt_app/src/usecases/mod.rs`

**Interfaces:** (all `deps: &Deps, ctx: &Ctx`; `strategy.*` rows are Exempt, status_exempt = true for `strategy.*` per Global Constraints — add `"strategy."` to `STATUS_EXEMPT_PREFIXES` so a pending-payment workspace can still consult; **Ruling:** the strategy itself may be prepared before payment, nothing else)
- `get(deps, ctx) -> StrategyOut { approved: Option<VersionOut>, draft: Option<VersionOut>, gaps: Vec<Gap> /* for the draft */ }`, `VersionOut { id, number, status, sections, hypotheses, created_at, approved_at, approved_by_email: Option<Email>, consultation_count }`. Requires `WorkspaceRead`.
- `start_consultation(deps, ctx) -> VersionOut`: `TeamManage` or owner/manager role (`require_any`: `Ctx::is_owner_or_manager()` helper, else FORBIDDEN); if a draft exists → return it (idempotent); else create number = next, sections/hypotheses copied from the approved version (`next_draft_from`) or `Default`; consultation entry `Note "consultation started"`; ledger `strategy.start_consultation`.
- `record(deps, ctx, RecordInput { kind: Question|Answer|Assumption|Note, section_key: Option<String>, text }) -> ConsultationEntryId`: needs a draft (`CONFLICT("no draft")`); text 1..=20_000; ledger `strategy.record` with payload `{kind, section_key}` only (not the text — the text lives in the consultation table, which is itself readable only with `WorkspaceRead`).
- `write_section(deps, ctx, section_key: String, value: serde_json::Value) -> VersionOut`: section_key ∈ {identity, audience, channels, goals, budget_frame, prohibitions, cadence, paid_enabled}; deserialise into the typed field (`VALIDATION` with serde error); `validate_sections` gaps are returned in `VersionOut.gaps` but do not block writing; consultation entry `SectionDraft`; ledger `strategy.write_section`.
- `set_hypotheses(deps, ctx, Vec<HypothesisInput { id: Option<HypothesisId>, title, segment_key, angle, channel, metric, confidence }>) -> VersionOut`: ids present → updated/`Kept`; absent → new id, `Added`; hypotheses of the approved base missing from the input → `Retired` (kept in the table with state retired); ledger `strategy.set_hypotheses` `{added, retired, kept counts}`.
- `submit(deps, ctx) -> VersionOut`: `validate_for_approval` with `known_channels` = kinds of this workspace's capabilities with status ≠ retired ∪ {"any"} (via `CapabilityRepo` — Task 7; until then the use case takes a `&dyn ChannelCatalog` port returning the set; implement the port now with a fake); gaps → `VALIDATION { "gaps": [...] }`; sets `submitted_at`; consultation `Submitted`; ledger.
- `approve(deps, ctx) -> VersionOut`: owner or manager only (FORBIDDEN `{"reason":"owner_or_manager"}`); draft must be submitted (`CONFLICT("not submitted")`); re-validates; in one tenant transaction: archive current approved (set_status Archived), set draft Approved with `approved_by` = acting user (for an agent: the issuer), consultation `Approved`, ledger `strategy.approve` `{number, hypotheses: n}`; a `23505` on the partial index → `CONFLICT("another approval won")` (Review Focus 2).
- `archive(deps, ctx, ArchiveInput { version_id: StrategyVersionId, confirm: bool }) -> ()`: owner/manager; `confirm` must be true (DESTRUCTIVE); archives the approved version **named by `version_id`** (another version in force → `CONFLICT`, so a stale screen cannot archive a newer approval; settled in the M1a implementation); consultation `Archived`; ledger; afterwards the gate closes (spec §5) — the studio cancellation hook is M3; define the port `StrategyArchivedHook` with a no-op default now.
- `list_versions(deps, ctx) -> Vec<VersionSummary { id, number, status, created_at, approved_at, archived_at }>`.
- `consultation(deps, ctx, version_id, limit, before) -> Vec<ConsultationEntry>`.

Catalog rows (all Exempt, status_exempt true, `panel_only: false`):

| id | mcp_tool | panel_route | risk |
|---|---|---|---|
| `strategy.get` | `jeeta.strategy.get` | `GET /api/strategy` | Read |
| `strategy.start_consultation` | `jeeta.strategy.start_consultation` | `POST /api/strategy/consultation` | Write |
| `strategy.record` | `jeeta.strategy.record` | `POST /api/strategy/consultation/entries` | Write |
| `strategy.write_section` | `jeeta.strategy.write_section` | `PUT /api/strategy/draft/sections/{section_key}` | Write |
| `strategy.set_hypotheses` | `jeeta.strategy.set_hypotheses` | `PUT /api/strategy/draft/hypotheses` | Write |
| `strategy.submit` | `jeeta.strategy.submit` | `POST /api/strategy/draft/submit` | Write |
| `strategy.approve` | `jeeta.strategy.approve` | `POST /api/strategy/draft/approve` | Write |
| `strategy.archive` | `jeeta.strategy.archive` | `POST /api/strategy/archive` | Destructive |
| `strategy.list_versions` | `jeeta.strategy.list_versions` | `GET /api/strategy/versions` | Read |
| `strategy.consultation` | `jeeta.strategy.consultation` | `GET /api/strategy/versions/{version_id}/consultation` | Read |

- [ ] **Step 1: Failing tests** (fakes): one per rule above, including `approve_refuses_gaps_with_validation_listing_them` (Review Focus 1), `approve_archives_the_previous_version_in_the_same_transaction`, `second_approval_loses_with_conflict` (fake raises CONFLICT on the second approved), `rep_cannot_approve`, `agent_with_owner_key_can_approve`, `archive_requires_confirm`, `record_payload_never_contains_the_text`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(strategy): consultation, drafting, submission, approval and archiving use cases`

---

### Task 5: Strategy on both gates, real gate wired, B1 behavioural test

**Files:**
- Create: `rust/crates/adapters/jt_panel_http/src/routes/strategy.rs`, `rust/crates/adapters/jt_mcp/src/tools/strategy.rs`, `rust/crates/adapters/jt_panel_http/tests/strategy_http.rs`
- Modify: `rust/crates/adapters/jt_panel_http/src/routes/mod.rs` (`ROUTES`), `rust/crates/adapters/jt_mcp/src/registry.rs` (+10 tools; permission map), `rust/bin/jeeta/src/serve.rs` + `stdio.rs` (`PgStrategyGate` replaces `NoStrategyYet`; `AesSecretBox` in `Deps`), `rust/crates/adapters/jt_mcp/tests/mcp_http.rs` (B1 against the real gate), `rust/crates/jt_archtest/tests/{twin_parity.rs,gate_rule.rs}`

**Interfaces:**
- Routes exactly as the catalog; bodies: `RecordBody { kind, section_key, text }`, `SectionBody = serde_json::Value`, `HypothesesBody { hypotheses: Vec<HypothesisInput> }`, `ArchiveBody { version_id, confirm: bool }` (MCP arguments the same); responses `VersionOut`/`StrategyOut`.
- MCP tools: argument structs mirror the bodies; `jeeta.strategy.get` description tells the agent the consultation protocol in two sentences ("Ask the owner the open questions, record each answer, write sections, set hypotheses, submit; the owner or a manager approves").
- B1: in `mcp_http.rs`, `gated_test_tool_passes_only_after_a_real_approval`: with `PgStrategyGate`, the gated test tool → `STRATEGY_REQUIRED`; run `start_consultation` → `write_section` ×n → `set_hypotheses` → `submit` → `approve` through the MCP tools with an owner key; the gated tool now runs; `archive {confirm:true}` → `STRATEGY_REQUIRED` again.
- Twin parity: extend `twin_parity.rs` with `strategy.get` (panel vs MCP identical JSON).

- [ ] **Step 1: Failing tests**: `strategy_http.rs` — `owner_runs_the_consultation_to_approval_on_the_panel` (full flow, incl. gaps shown before fix), `rep_cannot_write_sections_403`, `archive_without_confirm_422`; the B1 MCP test; twin parity.
- [ ] **Step 2–4** (`make check`, env set). **Step 5: Commit** `feat(strategy): panel routes, MCP tools and the live strategy gate`

---

### Task 6: Domain crate `jt_capability`

**Files:**
- Create: `rust/crates/domain/jt_capability/{Cargo.toml,src/lib.rs,src/kind.rs,src/capability.rs,src/group.rs,src/budget.rs,src/policy.rs,src/status.rs}`, `tests/rules.rs`
- Modify: `rust/Cargo.toml`, archtest `DOMAIN_ALLOW` (`jt_capability` depends on `jt_tenancy`)

**Interfaces:**
- Ids: `CapabilityId`, `CapabilityGroupId`, `BudgetItemId`, `BudgetSpendId`.
- `pub enum KindGroup { SocialAccount, Messaging, Telephony, Community, Ads, Calendar, Device, AgentConnection, ComputerAccess, ThirdParty }`.
- `pub struct CapabilityKind { pub group: KindGroup, pub key: &'static str }` and `pub const KINDS: &[CapabilityKind]` with exactly these keys: social `instagram, facebook_page, x, linkedin_page, tiktok, pinterest, youtube, google_business`; messaging `whatsapp_cloud, instagram_dm, messenger, sms_line, mailbox, webchat`; telephony `netgsm_pbx`; community `discord, reddit, review_google, review_facebook`; ads `meta_ads, tiktok_ads, linkedin_ads, google_ads`; calendar `google_calendar, outlook_calendar`; device `phone, computer, printer, printer_3d, audio_io, camera, screen, scanner, usb_storage`; agent_connection `claude_code, codex, claude_ai, other_agent`; computer_access `filesystem_root, browser_profile, shell, adb, screen_control`; third_party `notion, slack, gmail, apify, firecrawl, other`. `CapabilityKind::parse(key) -> Option<&'static CapabilityKind>`; `fn default_reach(&self) -> Reach` (social/messaging/telephony/community/ads/calendar → `Connector`; device → `Device`; agent_connection/computer_access/third_party → `Agent`).
- `pub enum Reach { Connector, Agent, Device }`; `pub enum StoredStatus { Declared, Verified, Unreachable, Retired }`; `pub enum EffectiveStatus { Declared, Verified, Stale, Unreachable, Retired }`.
- `pub struct Policy { pub active_hours: Option<Hours { tz: String, from: u8, to: u8, days: Vec<u8> }>, pub daily_ops_cap: Option<u32>, pub spend_cap_minor: Option<i64>, pub requires_human_approval: bool, pub verify_max_age_days: u16 /* default 30 */ }` with `Default`.
- `pub struct Capability { pub id, pub workspace_id, pub kind: &'static CapabilityKind, pub key_detail: Option<String> /* for third_party.other */, pub name, pub description, pub reach, pub status: StoredStatus, pub external_id: Option<String>, pub connector_public: serde_json::Value, pub has_sealed_config: bool, pub last_verified_at: Option<OffsetDateTime>, pub evidence: Option<Evidence { text: String, refs: Vec<String> }>, pub policy: Policy, pub budget_item_ids: Vec<BudgetItemId>, pub strategy_version_id: Option<Uuid>, pub created_at, pub updated_at }`.
- `pub fn effective_status(c: &Capability, now) -> EffectiveStatus`: Retired/Unreachable as stored; Verified but `last_verified_at` older than `verify_max_age_days` → `Stale`; Verified fresh → Verified; else Declared (Review Focus 4).
- `pub struct CapabilityGroup { id, workspace_id, name /* 1..=64 */, purpose: Option<String> }`.
- `pub enum BudgetKind { Cash, AdBudget, SmsBudget, AgentQuota, AgentHours, Consumable }`; `pub struct BudgetItem { id, workspace_id, name, kind, unit: Unit /* Currency(String) | Count(String label) | Minutes */, cap: i64, period: Period /* Daily|Weekly|Monthly|Total */, strategy_version_id: Option<Uuid>, created_at }`; `pub struct BudgetSpend { id, budget_item_id, workspace_id, at, amount: i64, source: SpendSource /* Connector(String) | Agent | Human */, reference: Option<String> }`; `pub fn period_window(period, now) -> (OffsetDateTime, OffsetDateTime)`; `pub fn remaining(cap, spent) -> i64`.
- Rules: `validate_name`, `validate_policy` (hours 0..=23, from < to, days 1..=7, tz IANA-looking string), `third_party.other` requires `key_detail` `[a-z0-9_-]{2,40}`; `can_link_budget(kind, budget_kind) -> bool` (ads ↔ AdBudget|Cash; sms_line ↔ SmsBudget|Cash; agent_connection ↔ AgentQuota|AgentHours; device printer/printer_3d ↔ Consumable|Cash; others ↔ Cash).

- [ ] **Step 1: Failing tests**: `every_kind_key_is_unique_and_parses`, `default_reach_per_group`, `effective_status_goes_stale_after_policy_age` (Review Focus 4), `other_third_party_requires_key_detail`, `budget_link_rules`, `period_windows_are_half_open_and_utc`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(capability): kinds, capability, groups, policies, budget items and status derivation`

---

### Task 7: Migration 0003 and capability repositories

**Files:**
- Create: `rust/migrations/0003_capabilities.up.sql` / `.down.sql`, `rust/crates/adapters/jt_pg/src/repos/{capabilities.rs,groups.rs,budget.rs,policies.rs}`
- Modify: `ports.rs` (+`CapabilityRepo`, `CapabilityGroupRepo`, `BudgetRepo`, `WorkspacePolicyRepo`; `TenantRepos` accessors), `uow.rs`, fakes
- Test: `jt_pg/tests/capability_repos.rs`, migrations table count 13 → 20 (0003 adds seven tables: `capabilities`, `capability_groups`, `capability_group_members`, `budget_items`, `capability_budget_links`, `budget_spend_entries`, `workspace_policies`; corrected in the M1a implementation)

**Interfaces:**
- SQL (tenant tables with FORCE RLS + policy): `capabilities(id uuid pk, workspace_id uuid not null references workspaces(id) on delete cascade, kind_key text not null, key_detail text, name text not null, description text not null default '', reach text not null check (reach in ('connector','agent','device')), status text not null check (status in ('declared','verified','unreachable','retired')), external_id text, connector_public jsonb not null default '{}'::jsonb, connector_sealed bytea, last_verified_at timestamptz, evidence jsonb, policy jsonb not null default '{}'::jsonb, strategy_version_id uuid, created_at timestamptz not null, updated_at timestamptz not null)` + unique partial index `(workspace_id, kind_key, external_id) where external_id is not null and status <> 'retired'` (B10: many instances allowed; the same external account twice is not); `capability_groups(id uuid pk, workspace_id, name text not null, purpose text, created_at, unique (workspace_id, name))`; `capability_group_members(workspace_id uuid not null, group_id uuid not null references capability_groups(id) on delete cascade, capability_id uuid not null references capabilities(id) on delete cascade, primary key (group_id, capability_id))`; `budget_items(id uuid pk, workspace_id, name, kind text not null, unit jsonb not null, cap bigint not null, period text not null, strategy_version_id uuid, created_at)`; `capability_budget_links(workspace_id, capability_id references capabilities(id) on delete cascade, budget_item_id references budget_items(id) on delete cascade, primary key (capability_id, budget_item_id))`; `budget_spend_entries(id uuid pk, workspace_id, budget_item_id references budget_items(id) on delete cascade, at timestamptz not null, amount bigint not null, source jsonb not null, reference text)` + append-only trigger + index `(budget_item_id, at)`; `workspace_policies(workspace_id uuid pk references workspaces(id) on delete cascade, agent_checkin_interval_minutes int not null default 1440, updated_at timestamptz not null)` (RLS by `workspace_id`).
- Ports: `CapabilityRepo { insert(Capability, sealed: Option<Vec<u8>>); find(id) -> Option<Capability>; list(filter: CapabilityFilter { group: Option<KindGroup>, kind: Option<&'static str>, status: Option<StoredStatus>, group_id: Option<CapabilityGroupId> }) -> Vec; update(Capability) /* not the sealed blob */; set_sealed(id, Option<Vec<u8>>); read_sealed(id) -> Option<Vec<u8>>; set_status(id, StoredStatus, at); kinds_in_use() -> BTreeSet<String> }`; `CapabilityGroupRepo { insert; list -> Vec<(CapabilityGroup, Vec<CapabilityId>)>; find; rename; delete; add_member(group, cap); remove_member(group, cap) }` (member writes verify both rows belong to the workspace — Review Focus 3, `NOT_FOUND` otherwise); `BudgetRepo { insert_item; list_items; find_item; link(cap, item); unlink; append_spend(BudgetSpend) -> BudgetSpendId; spent_between(item, from, to) -> i64; list_spend(item, limit, before) }`; `WorkspacePolicyRepo { get() -> WorkspacePolicy { agent_checkin_interval_minutes }; set(WorkspacePolicy, at) }`.
- `ChannelCatalog` (Task 4's port) is implemented by `CapabilityRepo::kinds_in_use()` in the use case layer.

- [ ] **Step 1: Failing tests**: `capability_insert_find_list_update_and_sealed_round_trip` (sealed read back only via `read_sealed`; `find` returns `has_sealed_config` only), `same_external_account_twice_is_conflict_until_retired` (B10 + uniqueness), `group_member_from_another_workspace_is_not_found` (Review Focus 3), `budget_link_and_spend_window_sum`, `spend_entries_are_append_only`, `workspace_policy_defaults`, migrations round trip (count 20).
- [ ] **Step 2–4.** **Step 5: Commit** `feat(pg): capabilities, groups, budget items, spend ledger and workspace policies`

---

### Task 8: Capability, group and budget use cases

**Files:**
- Create: `rust/crates/jt_app/src/usecases/{capabilities.rs,groups.rs,budget.rs}`, tests `jt_app/tests/{capabilities.rs,budget.rs}`
- Modify: `catalog.rs` (rows below), `jt_outbound/src/public_host.rs` + `lib.rs` (`validate_public_host(host) -> Result<(), HostError>`: rejects IP literals in loopback/private/link-local/multicast/unspecified ranges (v4 and v6), `localhost`, single-label names; `TenantHostRegistry` adapter calling `Egress::allow/revoke_tenant_host` after validation), `ports.rs` (+`TenantHostRegistry { allow(ws, host); revoke(ws, host) }`)

**Interfaces:** (`capability.*`, `budget.*` Exempt from strategy; NOT status-exempt)
- `capabilities::declare(deps, ctx, DeclareInput { kind_key, key_detail, name, description, external_id, connector_public, policy: Option<Policy> }) -> CapabilityOut`: `ApiKeysManage`? No — new permission needed. **Ruling:** add `Permission::CapabilitiesManage` (`"capabilities.manage"`) and `Permission::BudgetManage` (`"budget.manage"`) to `jt_tenancy` (Owner/Manager get them; Rep does not; existing keys' scopes unaffected — intersection shrinks nothing they had). `declare` requires `CapabilitiesManage`; reach = `kind.default_reach()`; connector kinds may be declared here too (status Declared; credentials arrive in M1b via `connector.*`); status Declared; ledger `capability.declare` `{kind_key, name, external_id?}` (never `connector_public` secrets — `connector_public` is validated to contain no key named like a secret: reuse the redaction key list as a denylist → `VALIDATION`).
- `list(deps, ctx, CapabilityFilter) -> Vec<CapabilityOut>` (`WorkspaceRead`) with `effective_status` computed at `ctx.now`; `get(id)`.
- `verify(deps, ctx, id, Evidence) -> CapabilityOut`: `CapabilitiesManage` for humans; agents may verify (their own reach kinds) with `WorkspaceRead` + the capability's reach being `Agent` or `Device` — **Ruling:** verification by an agent requires only `WorkspaceRead` because it is the agent's own claim about its own hands; connector kinds cannot be verified here (`CONFLICT("connector capabilities are verified by their probe")`); sets Verified + `last_verified_at = now` + evidence; ledger `capability.verify` `{evidence_refs: n}`.
- `mark_unreachable(deps, ctx, id, reason)`; `retire(deps, ctx, id, confirm: bool)` (Destructive; revokes tenant hosts registered for it via `TenantHostRegistry`; unlinks budgets; removes from groups); `set_policy(deps, ctx, id, Policy)`; `link_budget(deps, ctx, id, budget_item_id)` / `unlink_budget` (uses `can_link_budget`; cross-workspace → `NOT_FOUND`).
- `groups::create(deps, ctx, name, purpose) -> GroupOut`, `rename`, `delete` (members detached), `add_member(group_id, capability_id)`, `remove_member`, `list() -> Vec<GroupOut { group, members: Vec<CapabilityOut> }>`.
- `budget::create_item(deps, ctx, BudgetItemInput { name, kind, unit, cap, period }) -> BudgetItemOut { item, spent_in_period, remaining }` (`BudgetManage`); `list_items`; `record_spend(deps, ctx, item_id, amount, reference) -> BudgetSpendOut` (agents and humans; `WorkspaceRead` + the item must be linked to at least one capability the caller may use — keep simple: `WorkspaceRead`; source = `Agent`/`Human` from `ctx.actor`); `spend(deps, ctx, item_id, limit, before) -> Vec<BudgetSpend>`; over-cap recording is allowed but returns `BudgetItemOut.remaining < 0` and writes ledger `budget.over_cap` (the hard cap applies to connector-driven spend in M3).

Catalog rows (Exempt, not status-exempt):

| id | mcp_tool | panel_route | risk |
|---|---|---|---|
| `capability.list` | `jeeta.capability.list` | `GET /api/capabilities` | Read |
| `capability.get` | `jeeta.capability.get` | `GET /api/capabilities/{capability_id}` | Read |
| `capability.declare` | `jeeta.capability.declare` | `POST /api/capabilities` | Write |
| `capability.verify` | `jeeta.capability.verify` | `POST /api/capabilities/{capability_id}/verify` | Write |
| `capability.mark_unreachable` | `jeeta.capability.mark_unreachable` | `POST /api/capabilities/{capability_id}/unreachable` | Write |
| `capability.set_policy` | `jeeta.capability.set_policy` | `PUT /api/capabilities/{capability_id}/policy` | Write |
| `capability.retire` | `jeeta.capability.retire` | `POST /api/capabilities/{capability_id}/retire` | Destructive |
| `capability.link_budget` | `jeeta.capability.link_budget` | `POST /api/capabilities/{capability_id}/budget-links` | Write |
| `capability.unlink_budget` | `jeeta.capability.unlink_budget` | `DELETE /api/capabilities/{capability_id}/budget-links/{budget_item_id}` | Write |
| `capability.groups.list` | `jeeta.capability.groups_list` | `GET /api/capability-groups` | Read |
| `capability.groups.create` | `jeeta.capability.groups_create` | `POST /api/capability-groups` | Write |
| `capability.groups.rename` | `jeeta.capability.groups_rename` | `PATCH /api/capability-groups/{group_id}` | Write |
| `capability.groups.delete` | `jeeta.capability.groups_delete` | `DELETE /api/capability-groups/{group_id}` | Destructive |
| `capability.groups.add_member` | `jeeta.capability.groups_add_member` | `POST /api/capability-groups/{group_id}/members` | Write |
| `capability.groups.remove_member` | `jeeta.capability.groups_remove_member` | `DELETE /api/capability-groups/{group_id}/members/{capability_id}` | Write |
| `budget.items.list` | `jeeta.budget.items_list` | `GET /api/budget/items` | Read |
| `budget.items.create` | `jeeta.budget.items_create` | `POST /api/budget/items` | Write |
| `budget.spend.record` | `jeeta.budget.spend_record` | `POST /api/budget/items/{budget_item_id}/spend` | Spend |
| `budget.spend.list` | `jeeta.budget.spend_list` | `GET /api/budget/items/{budget_item_id}/spend` | Read |

(MCP names keep the three-part `jeeta.<domain>.<action>` shape; the catalog-name test allows underscores in the action.)

- [ ] **Step 1: Failing tests**: one per rule, incl. `declare_rejects_secret_looking_public_fields`, `agent_verifies_its_own_device_with_workspace_read_only`, `connector_kind_cannot_be_verified_by_claim`, `retire_revokes_tenant_hosts_and_detaches` (fake `TenantHostRegistry` records calls), `cross_workspace_group_member_and_budget_link_are_not_found` (Review Focus 3), `outputs_and_ledger_never_contain_sealed_bytes` (Review Focus 5: seal a blob via `set_sealed`, serialise all outputs + ledger, assert absence), `over_cap_spend_is_recorded_and_flagged`; `jt_outbound/tests/public_host.rs`: `private_and_loopback_literals_are_rejected`, `public_names_pass`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(capabilities): registry, groups, policies, budget items and spend with public-host guards`

---

### Task 9: Capabilities and budget on both gates

**Files:**
- Create: `jt_panel_http/src/routes/{capabilities.rs,groups.rs,budget.rs}`, `jt_mcp/src/tools/{capabilities.rs,budget.rs}`, `jt_panel_http/tests/capabilities_http.rs`
- Modify: `routes/mod.rs`, `registry.rs` (+19 tools, permission map), `twin_parity.rs` (+`capability.list`)

- [ ] **Step 1: Failing tests**: `owner_declares_groups_and_links_a_budget_on_the_panel`, `rep_can_list_but_not_declare`, `agent_verifies_a_phone_over_mcp_and_panel_shows_verified` (MCP `jeeta.capability.verify` then panel `GET /api/capabilities/{id}` → `effective_status: "verified"`), parity on `capability.list`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(capabilities): panel routes and MCP tools`

---

### Task 10: Pending work and agent check-in (B11)

**Files:**
- Create: `jt_app/src/usecases/work.rs`, `jt_app/tests/work.rs`, `jt_panel_http/src/routes/work.rs`, `jt_mcp/src/tools/work.rs`
- Modify: `catalog.rs`, `routes/mod.rs`, `registry.rs`, `usecases/agents.rs` (expose `last_seen_at` max per workspace + overdue flag)

**Interfaces:** (`work.*` Exempt and status_exempt; `agent.*` unchanged)
- `work::pending(deps, ctx) -> PendingOut { strategy: StrategyState /* Missing | DraftOpen { gaps } | Submitted | Approved { number } */, items: Vec<WorkItem { kind: ConsultStrategy | ApproveStrategy | VerifyCapability { capability_id, name, stale: bool } | DeclareFirstCapability | ConnectConnector { capability_id, name } /* M1b fills; name added in Task 12 */, priority: u8, hint: String /* Turkish? no: English, the agent's language; the panel shows its own copy */ }>, agent: AgentState { last_seen_at: Option<_>, interval_minutes, overdue: bool } }`: `WorkspaceRead`. Items: no approved strategy and no draft → `ConsultStrategy`; draft submitted and the caller can approve → `ApproveStrategy`; every capability with `effective_status ∈ {Declared, Stale}` and reach `Agent|Device` → `VerifyCapability` (Review Focus 4); no capability at all → `DeclareFirstCapability`.
- `work::checkin(deps, ctx) -> PendingOut`: agents only (`Actor::Agent`, else `FORBIDDEN`); touches `agent_connections.last_seen_at` (already done by every call) and writes ledger `work.checkin` once per hour at most per connection (debounce like `touch_last_used`); returns `pending`.
- `work::set_checkin_interval(deps, ctx, minutes: u32 /* 15..=10080 */)`: `TeamManage`; `WorkspacePolicyRepo::set`; ledger.
- `agents::list` output gains `overdue: bool` per connection = `now - last_seen_at > interval`; `work::pending.agent.last_seen_at` = max over connections; `overdue` when no connection or all overdue.

Catalog rows: `work.pending` (`jeeta.work.pending`, `GET /api/work/pending`, Read), `work.checkin` (`jeeta.work.checkin`, panel_only: false? an agent-only tool has no human caller — **Ruling:** `work.checkin` is MCP-only: a new `mcp_only: bool` flag on `UseCase` mirroring `panel_only`; the twin test accepts `mcp_only` rows without a panel route; the only `mcp_only` row in M1 is `work.checkin`), `work.set_checkin_interval` (`jeeta.work.set_checkin_interval`, `PUT /api/work/checkin-interval`, Write).

- [ ] **Step 1: Failing tests**: `pending_lists_consult_when_no_strategy`, `pending_lists_stale_devices` (Review Focus 4), `checkin_is_agent_only_and_ledgers_at_most_hourly`, `overdue_when_no_connection_or_all_late`, twin test accepts `mcp_only`, HTTP `home_data_shows_agent_overdue`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(work): pending work, agent check-in and the overdue warning`

---

### Task 11: Panel pages — Strategy, Capabilities, Budget, Home

**Files:**
- Create: `rust/panel/src/pages/{StrategyPage,CapabilitiesPage,BudgetPage}.tsx` (+ tests), `rust/panel/src/api/{strategy,capabilities,budget,work}.ts`, `rust/panel/src/components/{HypothesisTable,ConsultationLog,CapabilityCard,StatusBadge}.tsx`
- Modify: `HomePage.tsx` (strategy state card; "Strateji bekleniyor" callout becomes live: Missing → CTA "İstişareyi başlat" + explanation that the agent runs the consultation; DraftOpen → gaps list; Submitted → approve button for owner/manager; Approved → version number and hypotheses count), `layout/Shell.tsx` (nav: Strateji, Kabiliyetler, Bütçe), `i18n/{tr,en}.json`, `types.ts`

**Pages:**
- **Strategy:** tabs Onaylı / Taslak; sections rendered read-mostly with inline edit for owner/manager (identity, audience, channels, goals, budget frame, prohibitions, cadence, paid toggle); hypotheses table (title, segment, angle, channel, metric, confidence bar, state chip kept/retired/added); consultation log (questions, answers, assumptions, notes with actor badge human/agent/system and time); actions: Start consultation, Submit (shows gaps), Approve, Archive (ConfirmDialog with typed confirm), Versions list.
- **Capabilities:** grouped by `KindGroup` with filter chips; cards show name, kind, reach, effective status badge (declared/verified/stale/unreachable/retired), last verified, policy summary, budget links, groups; actions: Declare (dialog with kind picker from `KINDS`, key_detail when other), Verify (evidence text + refs), Set policy, Retire (ConfirmDialog); Groups panel: create/rename/delete, drag-free add/remove via select.
- **Budget:** items table (name, kind, unit, cap, period, spent, remaining with over-cap red), create dialog, spend history drawer, "record spend" form.
- **Home:** strategy card; agent card (last seen, interval, overdue warning in red with "ajan zamanlayıcısı kiracının sorumluluğudur" note); pending work list from `GET /api/work/pending` with links.

- [ ] **Step 1: Failing tests**: parity; smoke per page with fixtures (heading + one row/card); `HomePage` shows the overdue warning when `agent.overdue`; `StrategyPage` shows gaps and disables Approve for a rep.
- [ ] **Step 2–4:** `pnpm typecheck && pnpm test && pnpm build`.
- [ ] **Step 5: Commit** `feat(panel): strategy, capabilities, budget and home pending-work pages`

---

### Task 12: Docs, README, MCP tool list, archtests, plan/spec alignment

**Files:**
- Modify: `rust/README.md` (tool list now 15 + 10 + 19 + 3 = 47; consultation protocol for agents; capability kinds table; sealing note; `JEETA_SECRET_KEY` now in use — rotating it invalidates sealed connector configs), `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` (§5: `strategy.*` status-exempt; agent verification needs only WorkspaceRead; `mcp_only` rows; §6: permissions `capabilities.manage`/`budget.manage`; B11 mechanics), `jt_archtest` (exempt prefixes; `mcp_only`; tool count assertion), `.env.example`

- [ ] **Step 1:** update archtest expectations first (fail), then docs; `make check`; `cd rust/panel && pnpm test && pnpm build`.
- [ ] **Step 2: Manual smoke** (record in the report): boot with a scratch DB, register, activate via operator, create an owner key, over MCP: `jeeta.work.pending` → ConsultStrategy; run the consultation tools to approval; `jeeta.capability.declare` a phone, `verify` it; `jeeta.work.pending` → empty items; panel shows Approved and Verified. Record tool count (47).
- [ ] **Step 3: Commit and push** `docs(rust): M1a strategy and capabilities in README, spec and archtests`; push `feat/rust-m1-strategy-capabilities`; open a draft PR against `feat/rust-rewrite` (or `main` if #358 has merged).

---

## Self-review notes

- **Spec coverage (M1 row of §13, minus connectors):** strategy versions + consultation tools (T2–T5), gate (T3/T5, B1 real), capability registry + groups + policies + budget items (T6–T9), agent connection record (M0) + B11 (T10), panel (T11). Connectors and OAuth flows → M1b plan. B10 (many instances) is pinned in T7 (`same_external_account_twice_is_conflict_until_retired` proves instances are distinct by external id, not kind).
- **Type consistency:** `Permission::{CapabilitiesManage, BudgetManage}` introduced in T8 are referenced by T9/T11; `ChannelCatalog` introduced in T4 is implemented in T8 via `kinds_in_use`; `TenantHostRegistry` port (T8) is the M1b hook; `mcp_only` (T10) is the only catalog shape change.
- **Review Focus** items are pinned: 1→T2/T4, 2→T3/T4, 3→T7/T8, 4→T6/T10, 5→T1/T8.
- **Rulings embedded in this plan (to be ledgered when executed):** `strategy.*` is status-exempt; new permissions `capabilities.manage`/`budget.manage`; agent verification of its own reach needs only `workspace.read`; `work.checkin` is `mcp_only`; over-cap agent-reported spend is recorded and flagged (hard cap applies to connector spend in M3); sealing key derivation (HKDF per workspace from the master key).
