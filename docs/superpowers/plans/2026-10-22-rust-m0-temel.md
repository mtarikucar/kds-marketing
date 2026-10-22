# M0 Temel (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new Rust system's skeleton: one binary, hexagonal crate layout, PostgreSQL with reversible migrations and row-level tenant isolation, human auth and teams, API keys and agent connections, an MCP gate and a panel gate that call the same use cases, the strategy/workspace gate, the append-only ledger, the egress allowlist, a platform-operator role, a React panel shell, and CI.

**Architecture:** A Cargo workspace under `rust/`. Pure domain crates (`jt_tenancy`, `jt_ledger`) know no I/O. `jt_app` holds ports (traits) and use cases and a static `UseCaseCatalog` that every surface is checked against. Driving adapters are `jt_mcp` (rmcp, streamable HTTP + stdio) and `jt_panel_http` (axum JSON API + static panel). Driven adapters are `jt_pg` (sqlx, RLS-scoped transactions) and `jt_outbound` (the only HTTP client, hostname allowlist). `jt_archtest` enforces the boundaries as tests. The binary `jeeta` wires everything.

**Tech Stack:** Rust 1.96.0 (stable, pinned via `rust-toolchain.toml`); tokio 1.54; axum 0.8; tower-http 0.6; sqlx 0.8.6 (postgres, runtime-tokio, tls-rustls, migrate, uuid, time, json); rmcp 3.6 (features `server`, `transport-streamable-http-server`, `transport-io`); reqwest 0.12 (rustls, only in `jt_outbound`); serde/serde_json; uuid 1 (v7); time 0.3; thiserror 2; tracing; argon2 0.6; sha2; rand 0.10; cargo-deny 0.19; PostgreSQL 16. Panel: Vite 5, React 18, TypeScript 5, Tailwind 3, react-router 6, @tanstack/react-query 5, i18next 25, vitest 2, pnpm 9.

**Spec:** `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` (Turkish). Read §4 (omurga), §4.3 (crate layout and enforced boundaries), §4.4 (gates and auth), §4.5 (panel/MCP twin rule and naming), §5 (gate exemptions), §10 (multi-tenancy and data), §11 (roles, platform operator, security), §12 (tests), §13 (M0 row), Ek B (Turkish→English name table).

## Global Constraints

- **No AI, media-generation, STT or TTS provider library anywhere in the dependency tree** (spec §4.2, §4.3). Enforced by `cargo deny check` (Task 1) and kept green by every task.
- **Only `jt_outbound` may depend on an HTTP client** (`reqwest`); only `jt_pg` may depend on `sqlx`; domain crates (`jt_tenancy`, `jt_ledger`) depend only on `serde`, `serde_json`, `uuid`, `time`, `thiserror` (spec §4.3). Enforced by `jt_archtest`.
- **Every tenant table carries `workspace_id`, has `ENABLE` + `FORCE ROW LEVEL SECURITY`, and a policy on `current_setting('app.workspace_id', true)`** (spec §4.3, §10). Tenant data is reached only through `TenantTx`; platform-wide reads only through `PlatformTx`.
- **Migrations are reversible pairs** `migrations/<NNNN>_<name>.up.sql` + `.down.sql`; `down` removes exactly what `up` added and is a no-op when already reverted; the round-trip test (Task 5) must pass after every migration change (repo-wide rule and spec §10).
- **Naming:** Turkish is the ubiquitous language in docs and panel copy; code, tables, routes and MCP tool names are English per spec Ek B. MCP tools are `jeeta.<domain>.<action>` (spec §4.4, Ek B). Panel copy exists in `tr` and `en` with identical key sets.
- **Twin rule:** every use case in `UseCaseCatalog` has both an MCP tool and a panel route unless flagged `panel_only` (spec §4.5, B8). Only `auth.register`, `auth.login`, `auth.logout`, `auth.me`, `workspace.switch`, `team.accept_invite`, `platform.*` and (later) payment are `panel_only` (an agent never holds a human's session or invite token). The agent's counterpart of `auth.me` is the twin `agents.whoami` (`GET /api/whoami` and `jeeta.agent.whoami`, the same `WhoAmI` answer). (Settled in the M0 implementation.)
- **Gate:** two independent checks (spec §5, B1). The workspace-status check: every use case except `auth.*`, `workspace.*` and `platform.*` (`UseCase::status_exempt`) returns `WORKSPACE_INACTIVE` while the workspace is not `active`, whether or not it is exempt from the strategy gate; so `team.*`, `roles.*`, `api_keys.*`, `agents.*` and `ledger.*` are closed until the operator activates a workspace. The strategy gate: every `Gated` use case returns `STRATEGY_REQUIRED` while the workspace has no approved strategy. Exempt from the strategy gate in M0: `auth.*`, `workspace.*`, `team.*`, `roles.*`, `api_keys.*`, `agents.*`, `ledger.list`, `platform.*` (every M0 use case; the first `Gated` entries arrive in M1). (Status check settled in the M0 implementation.)
- **Structured errors** everywhere: `{ "code": "<UPPER_SNAKE>", "message": "<human text>", "details": {} }`. Codes in M0: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION`, `STRATEGY_REQUIRED`, `WORKSPACE_INACTIVE`, `HOST_NOT_ALLOWED`, `INTERNAL`.
- **Secrets never enter the repo.** Test DB credentials come from `JEETA_TEST_DATABASE_URL`; the local `.env` is gitignored. No real customer data, no screenshots.
- **Commits:** conventional-commit messages, plain text, **no `Co-Authored-By` trailer, no "Generated with" line, no AI or model name anywhere in commit messages, code comments or docs** (owner's global rule). Author/committer is the repo's configured user.
- **v1 is untouched:** nothing under `backend/`, `frontend/`, `desktop/`, `local-inference/` changes in M0. The only shared file edited is `.github/workflows/rust.yml` (new) and `.gitignore` (append).
- **Local test command:** `cd rust && JEETA_TEST_DATABASE_URL=<admin url> cargo test --workspace`. CI provides `postgres://postgres:postgres@localhost:5432/postgres`.

## Review Focus

1. **Email case and whitespace** — `Tarik@Example.com ` and `tarik@example.com` are the same account; register must reject the second, login must accept either. Test pinned in Task 2 (`Email::parse`) and Task 7.
2. **Cross-tenant id probing** — a caller authenticated for workspace A asks for an entity id that belongs to workspace B; the answer is `NOT_FOUND`, never the row. Test pinned in Task 5 (RLS) and Task 11 (MCP `team.list` sees only its workspace).
3. **Revoked key, demoted issuer** — a revoked API key is `UNAUTHENTICATED`; a key whose issuer lost a permission loses that scope at the next call. Test pinned in Task 10.
4. **Invite misuse** — accepting an invite with a different email than invited, a used token, or an expired token is refused with `FORBIDDEN`/`CONFLICT`. Test pinned in Task 9.
5. **Panel mutation without the request header** — a `POST /api/*` without `X-Requested-With: jeeta-panel` is refused with `403 FORBIDDEN` even with a valid cookie (CSRF). Test pinned in Task 8.

---

## File Structure

```
rust/
  Cargo.toml                       workspace members + [workspace.dependencies] with pinned versions
  rust-toolchain.toml              channel 1.96.0, components rustfmt clippy
  deny.toml                        cargo-deny: bans (AI SDKs, reqwest/sqlx wrappers), licenses, advisories
  Makefile                         fmt, lint, deny, test, migrate, dev, panel targets
  README.md                        how to run locally; env vars; test DB
  .env.example                     documented env vars with placeholder values
  migrations/
    0001_foundation.up.sql / .down.sql
  crates/
    domain/jt_tenancy/             ids, Email, Role, Permission, WorkspaceStatus, role→permission rules
    domain/jt_ledger/              LedgerEntry, Actor, Action
    jt_app/                        AppError, Ctx, ports, use cases, UseCaseCatalog, gate
    adapters/jt_pg/                Pool, TenantTx/PlatformTx, repos, migrate()
    adapters/jt_panel_http/        axum router, session + CSRF middleware, routes, ServeDir
    adapters/jt_mcp/               rmcp server, key auth, tool registry, gate, tools
    adapters/jt_outbound/          Egress client with allowlist
    jt_testkit/                    TestDb, fakes for ports, fixtures
    jt_archtest/                   tests: dependency boundaries, SQL scoping scan
  bin/jeeta/                       config, wiring, `serve` and `mcp-stdio` subcommands
  panel/                           Vite + React + TS panel (shell only in M0)
.github/workflows/rust.yml         rust checks, rust tests (postgres service), panel checks
```

---

### Task 1: Workspace scaffold, toolchain, deny rules, architecture test skeleton

**Files:**
- Create: `rust/Cargo.toml`, `rust/rust-toolchain.toml`, `rust/deny.toml`, `rust/Makefile`, `rust/README.md`, `rust/.env.example`
- Create: `rust/crates/domain/jt_tenancy/{Cargo.toml,src/lib.rs}`, `rust/crates/domain/jt_ledger/{Cargo.toml,src/lib.rs}`, `rust/crates/jt_app/{Cargo.toml,src/lib.rs}`, `rust/crates/adapters/jt_pg/{Cargo.toml,src/lib.rs}`, `rust/crates/adapters/jt_panel_http/{Cargo.toml,src/lib.rs}`, `rust/crates/adapters/jt_mcp/{Cargo.toml,src/lib.rs}`, `rust/crates/adapters/jt_outbound/{Cargo.toml,src/lib.rs}`, `rust/crates/jt_testkit/{Cargo.toml,src/lib.rs}`, `rust/crates/jt_archtest/{Cargo.toml,src/lib.rs}`, `rust/bin/jeeta/{Cargo.toml,src/main.rs}`
- Create: `rust/crates/jt_archtest/tests/dependency_boundaries.rs`
- Modify: `.gitignore` (append `rust/target/`, `rust/panel/node_modules/`, `rust/panel/dist/`, `rust/.env`)

**Interfaces:**
- Produces: crate names `jt_tenancy`, `jt_ledger`, `jt_app`, `jt_pg`, `jt_panel_http`, `jt_mcp`, `jt_outbound`, `jt_testkit`, `jt_archtest`, binary crate `jeeta`. Workspace dependency table (exact minor versions from the Tech Stack) that every crate references with `workspace = true`.
- Produces: `jt_archtest::metadata()` → parsed `cargo metadata --format-version 1` JSON (`serde_json::Value`), and `jt_archtest::direct_deps(crate: &str) -> BTreeSet<String>`.

- [ ] **Step 1: Write the failing architecture test**

`rust/crates/jt_archtest/tests/dependency_boundaries.rs`:

```rust
use jt_archtest::direct_deps;

const DOMAIN_ALLOW: &[&str] = &["serde", "serde_json", "uuid", "time", "thiserror"];

#[test]
fn domain_crates_depend_only_on_pure_crates() {
    for c in ["jt_tenancy", "jt_ledger"] {
        for d in direct_deps(c) {
            assert!(DOMAIN_ALLOW.contains(&d.as_str()), "{c} depends on {d}");
        }
    }
}

#[test]
fn app_depends_on_no_adapter() {
    for d in direct_deps("jt_app") {
        assert!(!d.starts_with("jt_") || ["jt_tenancy", "jt_ledger"].contains(&d.as_str()), "jt_app depends on {d}");
    }
}

#[test]
fn only_outbound_uses_reqwest_and_only_pg_uses_sqlx() {
    for c in ["jt_tenancy","jt_ledger","jt_app","jt_panel_http","jt_mcp","jt_testkit","jeeta"] {
        let deps = direct_deps(c);
        assert!(!deps.contains("reqwest"), "{c} must not depend on reqwest");
        if c != "jt_testkit" && c != "jeeta" { assert!(!deps.contains("sqlx"), "{c} must not depend on sqlx"); }
    }
}
```

(`jt_testkit` and `jeeta` are allowed `sqlx` only to construct pools; they must not write SQL. Task 12 adds the SQL scan.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd rust && cargo test -p jt_archtest`
Expected: compile error, `jt_archtest` has no `direct_deps`.

- [ ] **Step 3: Create the workspace**

`rust/Cargo.toml`: `[workspace] resolver = "2"`, members = all crates listed in Files. `[workspace.package]` edition 2024, version 0.1.0, license "UNLICENSED", publish = false. `[workspace.dependencies]`: tokio 1.54 (features macros, rt-multi-thread, signal), axum 0.8, tower 0.5, tower-http 0.6 (fs, trace, cors), sqlx 0.8.6 (features runtime-tokio, tls-rustls, postgres, migrate, uuid, time, json), rmcp 3.6 (features server, transport-streamable-http-server, transport-io), reqwest 0.12 (default-features false; features rustls-tls, json), serde 1 (derive), serde_json 1, uuid 1 (v7, serde), time 0.3 (serde, formatting, parsing, macros), thiserror 2, anyhow 1, tracing 0.1, tracing-subscriber 0.3 (env-filter, json), argon2 0.6, sha2 0.11, hex 0.4, rand 0.10, base64 0.23, subtle 2, schemars 1, url 2, dotenvy 0.15, toml 1, async-trait 0.1, http 1, tower-service 0.3. `[workspace.lints.clippy]` `all = "deny"`, `pedantic = "warn"`; `[workspace.lints.rust]` `unsafe_code = "forbid"`.

`rust/rust-toolchain.toml`: `[toolchain] channel = "1.96.0" components = ["rustfmt", "clippy"]`.

Each crate `Cargo.toml` uses `edition.workspace = true`, `lints.workspace = true`, and only workspace deps. Domain crates list exactly `serde`, `serde_json`, `uuid`, `time`, `thiserror`. `jt_app` lists `jt_tenancy`, `jt_ledger`, `serde`, `serde_json`, `uuid`, `time`, `thiserror`, `async-trait`. `jt_archtest` lists `serde_json` and (dev) nothing else; its `lib.rs` runs `cargo metadata` via `std::process::Command` with `--format-version 1 --no-deps` and parses with serde_json.

`jt_archtest::direct_deps(crate)`: from `packages[]` find `name == crate`, return the set of `dependencies[].name` where `kind` is null (normal deps only; dev-dependencies excluded).

- [ ] **Step 4: Write `deny.toml`**

```toml
[graph]
all-features = true

[advisories]
yanked = "deny"
unmaintained = "workspace"

[licenses]
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0", "Zlib", "MPL-2.0", "CDLA-Permissive-2.0", "OpenSSL"]

[bans]
multiple-versions = "warn"
# Only jt_outbound may pull an HTTP client; only jt_pg may pull sqlx.
deny = [
  { crate = "reqwest", wrappers = ["jt_outbound"] },
  { crate = "sqlx", wrappers = ["jt_pg", "jt_testkit", "jeeta"] },
  # AI / media / speech providers: never, anywhere (spec §4.2).
  { crate = "async-openai" }, { crate = "openai" }, { crate = "openai-api-rs" }, { crate = "openai_api_rust" },
  { crate = "anthropic" }, { crate = "anthropic-sdk" }, { crate = "anthropic-rs" }, { crate = "misanthropic" }, { crate = "clust" },
  { crate = "genai" }, { crate = "rig-core" }, { crate = "langchain-rust" }, { crate = "llm" }, { crate = "llm-chain" },
  { crate = "fal" }, { crate = "fal-rs" }, { crate = "runware" }, { crate = "replicate-rs" }, { crate = "stability-rs" },
  { crate = "elevenlabs" }, { crate = "elevenlabs-rs" }, { crate = "deepgram" }, { crate = "whisper-rs" }, { crate = "openai-whisper" },
  { crate = "candle-core" }, { crate = "candle-transformers" }, { crate = "ort" }, { crate = "llama-cpp-2" }, { crate = "llama_cpp" }, { crate = "mistralrs" },
  { crate = "google-generative-ai-rs" }, { crate = "gemini-rs" }, { crate = "ollama-rs" }, { crate = "aws-sdk-bedrockruntime" }, { crate = "azure_openai" },
]

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

(If `cargo deny check` reports a license the tree actually needs that is missing from `allow`, add that exact SPDX id; do not switch to `allow-osi-fsf-free`.)

- [ ] **Step 5: Makefile, README, .env.example, .gitignore**

Makefile targets: `fmt` (`cargo fmt --all -- --check`), `lint` (`cargo clippy --workspace --all-targets -- -D warnings`), `deny` (`cargo deny check`), `test` (`cargo test --workspace`), `check` (fmt lint deny test), `panel-install`/`panel-test`/`panel-build` (pnpm in `panel/`), `dev` (`cargo run -p jeeta -- serve`). README: prerequisites, `cp .env.example .env`, how to point `JEETA_TEST_DATABASE_URL` at a local Postgres, `make check`. `.env.example` lists every `JEETA_*` variable from Task 16 with placeholders.

- [ ] **Step 6: Verify**

Run: `cd rust && cargo build --workspace && cargo deny check && cargo test -p jt_archtest`
Expected: build ok; deny `advisories ok, bans ok, licenses ok, sources ok`; 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add rust/ .gitignore
git commit -m "build(rust): scaffold the workspace, toolchain, deny rules and architecture tests"
```

---

### Task 2: Domain crate `jt_tenancy`

**Files:**
- Create: `rust/crates/domain/jt_tenancy/src/{lib.rs,ids.rs,email.rs,role.rs,workspace.rs}`
- Test: `rust/crates/domain/jt_tenancy/tests/rules.rs`

**Interfaces:**
- Produces:
  - `pub struct WorkspaceId(pub Uuid)`, `UserId`, `MembershipId`, `RoleId`, `SessionId`, `ApiKeyId`, `AgentConnectionId`, `OperatorId` — each `Copy + Eq + Hash + Serialize + Deserialize + Display + FromStr`, with `fn new_v7() -> Self`.
  - `pub struct Email(String)` with `pub fn parse(raw: &str) -> Result<Email, EmailError>` (trim, lowercase, must contain exactly one `@` with non-empty sides and a dot in the domain; max 254 chars) and `pub fn as_str(&self) -> &str`.
  - `pub enum Permission { WorkspaceRead, TeamManage, ApiKeysManage, LedgerRead }` with `pub fn key(&self) -> &'static str` (`"workspace.read"`, `"team.manage"`, `"api_keys.manage"`, `"ledger.read"`) and `pub fn parse(key: &str) -> Option<Permission>`, `pub fn all() -> &'static [Permission]`.
  - `pub enum SystemRole { Owner, Manager, Rep }` with `pub fn key(&self) -> &'static str` (`"owner"`, `"manager"`, `"rep"`) and `pub fn permissions(&self) -> BTreeSet<Permission>`: Owner = all; Manager = all; Rep = `{WorkspaceRead}`.
  - `pub struct RoleDef { pub id: RoleId, pub key: String, pub name: String, pub permissions: BTreeSet<Permission>, pub is_system: bool }`.
  - `pub enum WorkspaceStatus { PendingPayment, Active, Suspended }` with `key()` (`"pending_payment"`, `"active"`, `"suspended"`) and `parse()`.
  - `pub enum MembershipStatus { Invited, Active, Removed }` with `key()`/`parse()`.
  - `pub fn can_change_role(actor: &BTreeSet<Permission>, target_is_last_owner: bool) -> Result<(), TenancyError>`: requires `TeamManage`; refuses removing/demoting the last owner (`TenancyError::LastOwner`).

- [ ] **Step 1: Write failing tests** (`tests/rules.rs`)

```rust
use jt_tenancy::*;
#[test] fn email_normalises_case_and_whitespace() {
    assert_eq!(Email::parse("  Tarik@Example.COM ").unwrap().as_str(), "tarik@example.com");
}
#[test] fn email_rejects_garbage() {
    for bad in ["", "a@", "@b.c", "a@b", "a b@c.d"] { assert!(Email::parse(bad).is_err(), "{bad}"); }
}
#[test] fn owner_and_manager_have_all_permissions_rep_reads_only() {
    assert_eq!(SystemRole::Owner.permissions().len(), Permission::all().len());
    assert_eq!(SystemRole::Manager.permissions().len(), Permission::all().len());
    assert_eq!(SystemRole::Rep.permissions(), [Permission::WorkspaceRead].into_iter().collect());
}
#[test] fn permission_keys_round_trip() {
    for p in Permission::all() { assert_eq!(Permission::parse(p.key()), Some(*p)); }
}
#[test] fn last_owner_cannot_be_demoted() {
    let actor = SystemRole::Owner.permissions();
    assert!(matches!(can_change_role(&actor, true), Err(TenancyError::LastOwner)));
    assert!(can_change_role(&actor, false).is_ok());
    assert!(matches!(can_change_role(&SystemRole::Rep.permissions(), false), Err(TenancyError::Forbidden)));
}
#[test] fn status_keys_round_trip() {
    for s in [WorkspaceStatus::PendingPayment, WorkspaceStatus::Active, WorkspaceStatus::Suspended] {
        assert_eq!(WorkspaceStatus::parse(s.key()), Some(s));
    }
}
```

- [ ] **Step 2: Run to see them fail** — `cargo test -p jt_tenancy` → compile errors.
- [ ] **Step 3: Implement** the items in Interfaces. Ids via a small macro generating the newtype with `uuid::Uuid::now_v7()`.
- [ ] **Step 4: Run** — `cargo test -p jt_tenancy` → all pass; `cargo clippy -p jt_tenancy -- -D warnings` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(tenancy): ids, email normalisation, roles, permissions and workspace status"`

---

### Task 3: Domain crate `jt_ledger`

**Files:**
- Create: `rust/crates/domain/jt_ledger/src/lib.rs`
- Test: `rust/crates/domain/jt_ledger/tests/entry.rs`

**Interfaces:**
- Produces:
  - `pub enum Actor { Human { user_id: UserId }, Agent { connection_id: AgentConnectionId, user_id: UserId }, System { component: String } }` (Agent carries the issuing user so authority is auditable, spec §4.4).
  - `pub struct Action(String)` with `pub fn new(s: &str) -> Result<Action, LedgerError>`: lowercase `[a-z0-9_.]+` with at least one dot (e.g. `team.invite`, `mcp.tool_call`).
  - `pub struct LedgerEntry { pub workspace_id: WorkspaceId, pub at: OffsetDateTime, pub actor: Actor, pub action: Action, pub subject: Option<Subject>, pub payload: serde_json::Value, pub strategy_version_id: Option<Uuid> }`, `pub struct Subject { pub kind: String, pub id: String }`.
  - `impl LedgerEntry { pub fn new(workspace_id, actor, action, payload) -> Self` with `at` supplied by caller via `.at(OffsetDateTime)`; `pub fn redacted(&self) -> LedgerEntry` masking payload keys named `password`, `token`, `secret`, `api_key` to `"***"` at any depth. }

- [ ] **Step 1: Failing tests**: `action_requires_dotted_lowercase` (`"Team.Invite"`, `"team"`, `"team invite"` rejected; `"team.invite"`, `"mcp.tool_call"` accepted); `redacted_masks_secret_keys_at_any_depth` (payload `{"token":"x","nested":{"api_key":"y","ok":1}}` → both masked, `ok` kept); `entry_serialises_actor_tagged` (JSON has `"actor": {"kind":"agent", ...}` via `#[serde(tag = "kind", rename_all = "snake_case")]`).
- [ ] **Step 2: Run to fail.** `cargo test -p jt_ledger`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass**, clippy clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(ledger): append-only entry model with actor, action and redaction"`

---

### Task 4: `jt_app` core — errors, context, ports, catalog, gate

**Files:**
- Create: `rust/crates/jt_app/src/{lib.rs,error.rs,ctx.rs,ports.rs,catalog.rs,gate.rs}`
- Test: `rust/crates/jt_app/tests/{catalog.rs,gate.rs}`

**Interfaces:**
- Produces:
  - `pub enum ErrorCode { Unauthenticated, Forbidden, NotFound, Conflict, Validation, StrategyRequired, WorkspaceInactive, HostNotAllowed, Internal }` with `pub fn as_str(&self) -> &'static str` giving the UPPER_SNAKE names from Global Constraints.
  - `pub struct AppError { pub code: ErrorCode, pub message: String, pub details: serde_json::Value }` with constructors `AppError::not_found(msg)`, `::forbidden(msg)`, `::validation(msg, details)`, etc., `impl std::error::Error`.
  - `pub struct Ctx { pub workspace_id: WorkspaceId, pub actor: Actor, pub permissions: BTreeSet<Permission>, pub now: OffsetDateTime }` and `pub struct PlatformCtx { pub operator_id: OperatorId, pub now: OffsetDateTime }`.
  - Ports (all `#[async_trait] pub trait ... : Send + Sync`):
    - `Clock { fn now(&self) -> OffsetDateTime }` (sync), `IdGen { fn uuid(&self) -> Uuid }`, `TokenGen { fn token(&self, bytes: usize) -> String }` (base64url without padding), `PasswordHasher { fn hash(&self, pw: &str) -> Result<String, AppError>; fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> }`.
    - `UnitOfWork { async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError>; async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError>; async fn user(&self) -> Result<Box<dyn UserRepos>, AppError>; }` where each returned object exposes repos and `async fn commit(self: Box<Self>) -> Result<(), AppError>`.
    - `TenantRepos` exposes: `fn roles(&mut self) -> &mut dyn RoleRepo`, `memberships`, `api_keys`, `agent_connections`, `ledger`, `workspace` (read own row), plus `commit`.
    - `UserRepos` (not tenant-scoped): `users`, `sessions`, `memberships_of_user(user_id) -> Vec<MembershipView>`, `workspaces_create(...)`.
    - `PlatformRepos`: `operators`, `platform_sessions`, `workspaces_list()`, `workspace_set_status(ws, status)`.
    - Repo traits with exact methods are defined in this task as the single source of truth; later tasks implement them. Define: `UserRepo { find_by_email, find_by_id, insert }`, `SessionRepo { insert, find_by_token_hash, revoke, set_current_workspace }`, `RoleRepo { list, find_by_key, insert, update_permissions, delete_custom }`, `MembershipRepo { list, find_by_user, find_by_invite_hash, insert_invite, activate, set_role, remove, count_active_owners }`, `ApiKeyRepo { insert, list, find_by_hash, revoke, touch_last_used }`, `AgentConnectionRepo { upsert_on_initialize, touch_tool_call, find }`, `LedgerRepo { append, list(filter) }`, `OperatorRepo { count, insert, find_by_email }`, `PlatformSessionRepo { insert, find_by_token_hash }`.
  - `pub struct UseCase { pub id: &'static str, pub gate: GateMode, pub mcp_tool: Option<&'static str>, pub panel_route: Option<(&'static str, &'static str)>, pub panel_only: bool, pub status_exempt: bool, pub risk: Risk }` (`status_exempt` only for `auth.*`, `workspace.*`, `platform.*`; settled in the M0 implementation), `pub enum GateMode { Exempt, Gated }`, `pub enum Risk { Read, Write, Spend, Destructive }`.
  - `pub static CATALOG: &[UseCase]` listing every M0 use case:

    | id | gate | mcp_tool | panel_route | panel_only | risk |
    |---|---|---|---|---|---|
    | `auth.register` | Exempt | — | `POST /api/auth/register` | yes | Write |
    | `auth.login` | Exempt | — | `POST /api/auth/login` | yes | Write |
    | `auth.logout` | Exempt | — | `POST /api/auth/logout` | yes | Write |
    | `auth.me` | Exempt | — | `GET /api/auth/me` | yes | Read |
    | `workspace.info` | Exempt | `jeeta.workspace.info` | `GET /api/workspace` | no | Read |
    | `workspace.switch` | Exempt | — | `POST /api/auth/switch-workspace` | yes | Write |
    | `team.list` | Exempt | `jeeta.team.list` | `GET /api/team` | no | Read |
    | `team.invite` | Exempt | `jeeta.team.invite` | `POST /api/team/invites` | no | Write |
    | `team.accept_invite` | Exempt | — | `POST /api/team/invites/accept` | yes | Write |
    | `team.set_role` | Exempt | `jeeta.team.set_role` | `PATCH /api/team/{membership_id}/role` | no | Write |
    | `team.remove` | Exempt | `jeeta.team.remove` | `DELETE /api/team/{membership_id}` | no | Destructive |
    | `roles.list` | Exempt | `jeeta.roles.list` | `GET /api/roles` | no | Read |
    | `roles.create` | Exempt | `jeeta.roles.create` | `POST /api/roles` | no | Write |
    | `roles.update` | Exempt | `jeeta.roles.update` | `PATCH /api/roles/{role_id}` | no | Write |
    | `roles.delete` | Exempt | `jeeta.roles.delete` | `DELETE /api/roles/{role_id}` | no | Destructive |
    | `api_keys.create` | Exempt | `jeeta.api_keys.create` | `POST /api/api-keys` | no | Write |
    | `api_keys.list` | Exempt | `jeeta.api_keys.list` | `GET /api/api-keys` | no | Read |
    | `api_keys.revoke` | Exempt | `jeeta.api_keys.revoke` | `DELETE /api/api-keys/{key_id}` | no | Destructive |
    | `agents.list` | Exempt | `jeeta.agents.list` | `GET /api/agents` | no | Read |
    | `agents.whoami` | Exempt | `jeeta.agent.whoami` | `GET /api/whoami` | no | Read |
    | `ledger.list` | Exempt | `jeeta.ledger.list` | `GET /api/ledger` | no | Read |
    | `platform.login` | Exempt | — | `POST /api/platform/login` | yes | Write |
    | `platform.workspaces.list` | Exempt | — | `GET /api/platform/workspaces` | yes | Read |
    | `platform.workspaces.set_status` | Exempt | — | `PATCH /api/platform/workspaces/{workspace_id}/status` | yes | Write |

    (M1 adds the first `Gated` entries. `team.accept_invite` and `workspace.switch` are panel-only because an agent never holds a human's invite token or session.)
  - `pub trait StrategyGate: Send + Sync { async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError>; }` and `pub struct NoStrategyYet;` implementing it as always `false` (M1 replaces it).
  - `pub async fn check_gate(uc: &UseCase, ws_status: WorkspaceStatus, gate: &dyn StrategyGate, ws: WorkspaceId) -> Result<(), AppError>`: if `!uc.status_exempt` and status != Active → `WORKSPACE_INACTIVE`; then if `uc.gate == Gated` and no approved strategy → `STRATEGY_REQUIRED`; else Ok. Every use case still requires the caller to be authenticated. (Settled in the M0 implementation: the status check no longer depends on the strategy exemption.)

- [ ] **Step 1: Failing tests**

`tests/catalog.rs`: `ids_are_unique`; `every_non_panel_only_use_case_has_both_surfaces` (B8); `panel_only_use_cases_have_no_mcp_tool`; `mcp_tool_names_follow_prefix` (start with `jeeta.` and have exactly three dot-separated parts); `panel_routes_are_unique`.
`tests/gate.rs`: with `NoStrategyYet`: a `Gated` use case → `StrategyRequired` when workspace Active; `WorkspaceInactive` when PendingPayment (inactive wins over strategy); `Exempt` → Ok in both states; a stub gate returning `true` lets Gated pass on Active.

- [ ] **Step 2: Run to fail.** `cargo test -p jt_app`
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run to pass**, clippy clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(app): error codes, context, ports, use-case catalog and the strategy gate"`

---

### Task 5: `jt_pg` foundation — migration 0001, RLS, scoped transactions, test database

**Files:**
- Create: `rust/migrations/0001_foundation.up.sql`, `rust/migrations/0001_foundation.down.sql`
- Create: `rust/crates/adapters/jt_pg/src/{lib.rs,pool.rs,tx.rs,migrate.rs}`
- Create: `rust/crates/jt_testkit/src/{lib.rs,db.rs,fakes.rs}`
- Test: `rust/crates/adapters/jt_pg/tests/{migrations.rs,rls.rs}`

**Interfaces:**
- Produces:
  - `jt_pg::connect(url: &str) -> Result<PgPool, sqlx::Error>` (max 10 connections, `application_name = jeeta`).
  - `jt_pg::migrator() -> &'static sqlx::migrate::Migrator` (`sqlx::migrate!("../../../migrations")`), `jt_pg::migrate_up(pool)`, `jt_pg::migrate_down_all(pool)` (`migrator().undo(pool, 0)`).
  - `pub struct TenantTx<'c>` created by `TenantTx::begin(pool, ws: WorkspaceId)`: begins a transaction and runs `SELECT set_config('app.workspace_id', $1, true)`; `commit()`/`rollback()`; `fn conn(&mut self) -> &mut PgConnection`.
  - `pub struct PlatformTx<'c>` created by `PlatformTx::begin(pool)`: begins and runs `SELECT set_config('app.platform', 'on', true)`.
  - `pub struct UserTx<'c>` for user-level tables (`users`, `sessions`): plain transaction, no settings.
  - `jt_testkit::TestDb::new().await -> TestDb` with `pub pool: PgPool`: reads `JEETA_TEST_DATABASE_URL` (admin URL), creates database `jt_test_<12 hex>`, connects, runs `migrate_up`; `impl Drop` spawns a best-effort `DROP DATABASE ... WITH (FORCE)`. `TestDb::seed_workspace(&self, name) -> (WorkspaceId, UserId)` inserting an active workspace, a user `owner+<id>@test.local`, system roles and an owner membership (via `PlatformTx`/`UserTx` and raw SQL inside testkit only).
  - `jt_testkit::fakes`: `FixedClock(OffsetDateTime)`, `SeqIdGen`, `FixedTokenGen(Vec<String>)`, `PlainHasher` (hash = `"plain:" + pw`), in-memory repos implementing every port from Task 4 (`InMemoryUow`).

- [ ] **Step 1: Write the migration pair**

`0001_foundation.up.sql` creates, in this order, each with `IF NOT EXISTS`:

- `workspaces(id uuid primary key, name text not null, slug text not null unique, status text not null check (status in ('pending_payment','active','suspended')), created_at timestamptz not null default now())`
- `users(id uuid primary key, email text not null, password_hash text not null, display_name text not null, created_at timestamptz not null default now())` + `create unique index if not exists users_email_lower_idx on users (lower(email))`
- `sessions(id uuid primary key, user_id uuid not null references users(id) on delete cascade, token_hash text not null unique, current_workspace_id uuid references workspaces(id) on delete set null, created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz)`
- `roles(id uuid primary key, workspace_id uuid not null references workspaces(id) on delete cascade, key text not null, name text not null, permissions text[] not null, is_system boolean not null default false, unique (workspace_id, key))`
- `memberships(id uuid primary key, workspace_id uuid not null references workspaces(id) on delete cascade, user_id uuid references users(id) on delete cascade, role_id uuid not null references roles(id), status text not null check (status in ('invited','active','removed')), invited_email text, invite_token_hash text unique, invite_expires_at timestamptz, invited_by uuid references users(id), created_at timestamptz not null default now())` + partial unique index on `(workspace_id, user_id) where user_id is not null and status <> 'removed'`
- `api_keys(id uuid primary key, workspace_id uuid not null references workspaces(id) on delete cascade, name text not null, prefix text not null, key_hash text not null unique, scopes text[] not null, issued_by uuid not null references users(id), status text not null check (status in ('active','revoked')), created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz)`
- `agent_connections(id uuid primary key, workspace_id uuid not null references workspaces(id) on delete cascade, api_key_id uuid not null references api_keys(id) on delete cascade, client_name text not null, client_version text not null default '', protocol_version text not null default '', first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), tool_calls bigint not null default 0, unique (api_key_id, client_name, client_version))`
- `ledger_entries(id bigint generated always as identity primary key, workspace_id uuid not null references workspaces(id) on delete cascade, at timestamptz not null, actor_kind text not null check (actor_kind in ('human','agent','system')), actor_user_id uuid, agent_connection_id uuid, actor_component text, action text not null, subject_kind text, subject_id text, payload jsonb not null default '{}'::jsonb, strategy_version_id uuid)` + index `(workspace_id, at desc)` + trigger function `ledger_entries_immutable()` raising `exception 'ledger_entries is append-only'` on UPDATE or DELETE, attached as `BEFORE UPDATE OR DELETE ... FOR EACH ROW`.
- `platform_operators(id uuid primary key, email text not null, password_hash text not null, created_at timestamptz not null default now())` + unique index on `lower(email)`
- `platform_sessions(id uuid primary key, operator_id uuid not null references platform_operators(id) on delete cascade, token_hash text not null unique, created_at timestamptz not null default now(), expires_at timestamptz not null)`
- For each tenant table (`roles`, `memberships`, `api_keys`, `agent_connections`, `ledger_entries`): `alter table t enable row level security; alter table t force row level security; create policy t_ws on t using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid or current_setting('app.platform', true) = 'on') with check (same expression);` (`create policy` has no `if not exists`: wrap in a `DO $$ ... IF NOT EXISTS (select 1 from pg_policies where policyname = 't_ws') THEN ... END IF; $$`.)
- `workspaces` itself: RLS with policy `(id = nullif(current_setting('app.workspace_id', true), '')::uuid or current_setting('app.platform', true) = 'on')`, so a tenant transaction sees only its own workspace row. `users`, `sessions`, `platform_*`: no RLS.

`0001_foundation.down.sql`: `drop table if exists` in reverse dependency order (`platform_sessions`, `platform_operators`, `ledger_entries`, `agent_connections`, `api_keys`, `memberships`, `roles`, `sessions`, `users`, `workspaces`), `drop function if exists ledger_entries_immutable()`. Idempotent.

- [ ] **Step 2: Failing tests**

`tests/migrations.rs`:
```rust
#[tokio::test] async fn up_down_up_round_trip() {
    let db = TestDb::new().await;               // already migrated up
    jt_pg::migrate_down_all(&db.pool).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from pg_tables where schemaname='public' and tablename <> '_sqlx_migrations'").fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 0);
    jt_pg::migrate_down_all(&db.pool).await.unwrap(); // down twice is a no-op
    jt_pg::migrate_up(&db.pool).await.unwrap();
    let n: i64 = /* same count */; assert_eq!(n, 10);
}
#[tokio::test] async fn every_migration_has_a_down_file() { /* read rust/migrations dir, assert each *.up.sql has a sibling *.down.sql */ }
```
`tests/rls.rs`:
```rust
#[tokio::test] async fn tenant_tx_sees_only_its_workspace() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await; let (b, _) = db.seed_workspace("b").await;
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from roles").fetch_one(tx.conn()).await.unwrap();
    assert_eq!(n, 3);                        // only a's three system roles
    let n: i64 = sqlx::query_scalar("select count(*) from workspaces").fetch_one(tx.conn()).await.unwrap();
    assert_eq!(n, 1);
    tx.rollback().await.unwrap();
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from roles").fetch_one(p.conn()).await.unwrap();
    assert_eq!(n, 6);
    let _ = b;
}
#[tokio::test] async fn tenant_tx_cannot_insert_for_another_workspace() { /* insert role with workspace_id = b inside TenantTx(a) → error (RLS WITH CHECK) */ }
#[tokio::test] async fn without_setting_no_rows_are_visible() { /* plain pool query on roles → 0 rows */ }
#[tokio::test] async fn ledger_is_append_only() { /* insert via PlatformTx, then UPDATE → error contains "append-only"; DELETE → same */ }
```

- [ ] **Step 3: Run to fail** — `cd rust && JEETA_TEST_DATABASE_URL=... cargo test -p jt_pg` (needs `jt_testkit` first → compile errors).
- [ ] **Step 4: Implement** `jt_pg` pool/tx/migrate and `jt_testkit::TestDb` + fakes (fakes may be stubs that `todo!()` for methods no test calls yet; Task 7 fills them).
- [ ] **Step 5: Run to pass.** Also `cargo deny check` still green.
- [ ] **Step 6: Commit** — `git commit -m "feat(pg): foundation schema with row-level tenant isolation, reversible migration and test database"`

---

### Task 6: `jt_pg` repositories

**Files:**
- Create: `rust/crates/adapters/jt_pg/src/repos/{mod.rs,users.rs,sessions.rs,roles.rs,memberships.rs,api_keys.rs,agent_connections.rs,ledger.rs,operators.rs,workspaces.rs}`, `rust/crates/adapters/jt_pg/src/uow.rs`
- Test: `rust/crates/adapters/jt_pg/tests/repos.rs`

**Interfaces:**
- Consumes: every repo trait and `UnitOfWork` from Task 4; `TenantTx`/`PlatformTx`/`UserTx` from Task 5.
- Produces: `jt_pg::PgUnitOfWork::new(pool) -> PgUnitOfWork` implementing `UnitOfWork`; `PgTenantRepos`, `PgUserRepos`, `PgPlatformRepos` implementing the repo-bundle traits, each holding its transaction and committing on `commit()`.
- Every SQL string that touches a tenant table includes `workspace_id` in the statement (belt) and runs inside `TenantTx` (braces) — Task 12 scans for the former.

- [ ] **Step 1: Failing tests** (`tests/repos.rs`, one per repo, against `TestDb`): `users_insert_and_find_by_email_is_case_insensitive`; `sessions_find_by_hash_and_revoke`; `roles_list_has_three_system_roles_and_custom_crud`; `memberships_invite_activate_set_role_remove_and_count_owners`; `api_keys_insert_find_by_hash_revoke_touch`; `agent_connections_upsert_increments_on_second_initialize_and_touch_counts_calls`; `ledger_append_and_list_newest_first_with_limit_and_action_filter`; `operators_count_insert_find`; `platform_workspaces_list_and_set_status`; `uow_tenant_commit_persists_and_rollback_on_drop_discards`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** the repos with `sqlx::query!`-free runtime queries (`sqlx::query`, `query_as`) so the build does not need a live DB; map rows to the Task 4 view structs; map `23505` unique violations to `AppError::conflict`.
- [ ] **Step 4: Run to pass**; clippy clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(pg): repositories and unit of work over scoped transactions"`

---

### Task 7: Auth use cases (register, login, logout, me, switch workspace)

**Files:**
- Create: `rust/crates/jt_app/src/usecases/{mod.rs,auth.rs}`
- Modify: `rust/crates/jt_testkit/src/fakes.rs` (complete in-memory repos used here)
- Test: `rust/crates/jt_app/tests/auth.rs`, `rust/crates/adapters/jt_pg/tests/auth_flow.rs`

**Interfaces:**
- Consumes: ports, `AppError`, `CATALOG` from Task 4; `jt_tenancy` from Task 2; `LedgerEntry` from Task 3.
- Produces (all in `jt_app::usecases::auth`, taking `&dyn UnitOfWork`, `&dyn Clock`, `&dyn IdGen`, `&dyn TokenGen`, `&dyn PasswordHasher` bundled as `pub struct Deps`):
  - `register(deps, RegisterInput { email: String, password: String, display_name: String, workspace_name: String }) -> Result<SessionOut, AppError>`: validates (password ≥ 10 chars, workspace_name non-empty, email via `Email::parse`), creates user, workspace (`PendingPayment`, slug from name + 4 random chars), three system roles (owner/manager/rep with `SystemRole::permissions()`), an active owner membership, a session, a ledger entry `auth.register` (actor Human). Duplicate email → `CONFLICT`.
  - `login(deps, LoginInput { email, password }) -> Result<SessionOut, AppError>`: wrong email or password → `UNAUTHENTICATED` with the same message for both; sets `current_workspace_id` to the user's first active membership.
  - `logout(deps, session_token) -> Result<(), AppError>` revokes.
  - `resolve_session(deps, token: &str) -> Result<Principal, AppError>`: hash lookup, expiry and revocation checks → `Principal { user_id, email, current_workspace: Option<WorkspaceId>, memberships: Vec<MembershipView> }`.
  - `me(deps, principal) -> MeOut`, `switch_workspace(deps, principal, ws) -> Result<(), AppError>` (must be an active member → else `FORBIDDEN`).
  - `pub struct SessionOut { pub token: String /* plaintext, 32 random bytes base64url */, pub expires_at: OffsetDateTime, pub me: MeOut }`. Session lifetime 30 days. Token stored as hex SHA-256.
  - `pub fn ctx_for(principal: &Principal, ws: WorkspaceId, now) -> Result<Ctx, AppError>` building `Ctx` with the member's role permissions (`FORBIDDEN` if not a member).

- [ ] **Step 1: Failing tests** (`jt_app/tests/auth.rs` with fakes): `register_creates_workspace_owner_roles_and_session`; `register_normalises_email_and_rejects_duplicate_with_conflict` (Review Focus 1); `register_rejects_short_password_with_validation`; `login_accepts_any_case_email_and_rejects_wrong_password_with_identical_message`; `resolve_session_rejects_expired_and_revoked`; `switch_workspace_requires_active_membership`; `register_writes_ledger_entry_auth_register`.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** use cases; complete the fakes.
- [ ] **Step 4: Run to pass.** Then `jt_pg/tests/auth_flow.rs`: the same `register → login → resolve_session` through `PgUnitOfWork` with the real hasher (`Argon2Hasher` lives in `jt_app::adapters_std`? No: put `Argon2Hasher`, `SystemClock`, `UuidV7Gen`, `RandTokenGen` in a small module `jt_app::std_impls` behind feature `std-impls` — they need `argon2`, `rand`: add those two deps to `jt_app` and extend the archtest allowlist for `jt_app` to include `argon2`, `rand`, `sha2`, `base64`, `hex`.)
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): registration, login, sessions and workspace switching"`

---

### Task 8: Panel HTTP adapter — router, session cookie, CSRF header, error mapping, auth routes, static panel

**Files:**
- Create: `rust/crates/adapters/jt_panel_http/src/{lib.rs,state.rs,error.rs,session.rs,csrf.rs,routes/mod.rs,routes/auth.rs,static_files.rs}`
- Test: `rust/crates/adapters/jt_panel_http/tests/auth_http.rs`

**Interfaces:**
- Consumes: Task 7 use cases; `CATALOG`.
- Produces:
  - `jt_panel_http::router(state: AppState) -> axum::Router` mounting `/api/*` and, when `state.panel_dir` is `Some`, `ServeDir` with `index.html` fallback for everything else; `/healthz` → `200 {"ok":true}`.
  - `pub struct AppState { pub uow: Arc<dyn UnitOfWork>, pub clock, pub ids, pub tokens, pub hasher, pub gate: Arc<dyn StrategyGate>, pub cookie_secure: bool, pub panel_dir: Option<PathBuf> }`.
  - Cookie `jt_session`: `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure` when `cookie_secure`.
  - CSRF middleware: every `POST/PATCH/PUT/DELETE` under `/api/` requires header `X-Requested-With: jeeta-panel`, else `403 {"code":"FORBIDDEN","message":"missing request header"}`.
  - Error mapping: `AppError` → status: Unauthenticated 401, Forbidden 403, NotFound 404, Conflict 409, Validation 422, StrategyRequired 409, WorkspaceInactive 423, HostNotAllowed 403, Internal 500; body is the structured error.
  - `pub const ROUTES: &[(&str, &str)]` — the method/path table the router is built from and the twin test (Task 12) compares with `CATALOG`.
  - Extractor `Authed(Principal)` from the cookie; `WorkspaceCtx(Ctx)` from `Authed` + current workspace.

- [ ] **Step 1: Failing tests** (axum `Router` + `tower::ServiceExt::oneshot`, `TestDb`): `register_sets_httponly_samesite_strict_cookie_and_returns_me`; `login_then_me_round_trip`; `post_without_requested_with_header_is_403` (Review Focus 5); `me_without_cookie_is_401_structured_error`; `healthz_ok`; `static_index_served_when_panel_dir_set` (temp dir with `index.html`; `GET /team` returns it; `GET /api/nothing` returns 404 JSON, not index).
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass**; clippy clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(panel-http): axum gate with session cookie, request-header check and auth routes"`

---

### Task 9: Team and roles use cases, routes

**Files:**
- Create: `rust/crates/jt_app/src/usecases/{team.rs,roles.rs}`
- Create: `rust/crates/adapters/jt_panel_http/src/routes/{team.rs,roles.rs,workspace.rs}`
- Test: `rust/crates/jt_app/tests/team.rs`, `rust/crates/adapters/jt_panel_http/tests/team_http.rs`

**Interfaces:**
- Consumes: Task 7 `Deps`, `Ctx`; Task 4 repos.
- Produces (`jt_app::usecases::team`): `list(deps, ctx) -> Vec<MemberOut>`; `invite(deps, ctx, InviteInput { email, role_key }) -> InviteOut { membership_id, invite_token /* plaintext, shown once */, expires_at }` (requires `TeamManage`; 7-day expiry; existing active member → `CONFLICT`; ledger `team.invite`); `accept_invite(deps, AcceptInput { token, password, display_name }) -> SessionOut` (token hash lookup; expired/used → `FORBIDDEN`; creates the user if the email is new, else requires that the logged-in user's email equals `invited_email` → mismatch `FORBIDDEN` (Review Focus 4); activates membership; ledger `team.accept_invite`); `set_role(deps, ctx, membership_id, role_key)` (uses `can_change_role`; last owner → `CONFLICT` with code detail `last_owner`); `remove(deps, ctx, membership_id)` (same last-owner rule; status `Removed`; revokes that user's sessions whose `current_workspace_id` is this workspace).
- Produces (`jt_app::usecases::roles`): `list`, `create(ctx, CreateRole { key, name, permissions: Vec<String> })` (key `[a-z0-9_]{2,32}`, not a system key, unknown permission → `VALIDATION`), `update(ctx, role_id, permissions)` (system roles immutable → `FORBIDDEN`), `delete(ctx, role_id)` (in use by a membership → `CONFLICT`). All require `TeamManage`, all write ledger entries.
- Produces (`jt_app::usecases::workspace`): `info(deps, ctx) -> WorkspaceOut { id, name, slug, status, my_role, my_permissions }`.
- Routes per `CATALOG` panel_route column (Task 4). Add them to `ROUTES`.

- [ ] **Step 1: Failing tests**: use-case tests with fakes for every rule named above (one test per rule), plus HTTP tests `owner_invites_and_invitee_accepts_and_appears_in_list`, `rep_cannot_invite_403`, `last_owner_cannot_be_removed_409`.
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(team): invitations, roles and membership management on both gates"`

---

### Task 10: API keys and agent connections

**Files:**
- Create: `rust/crates/jt_app/src/usecases/{api_keys.rs,agents.rs}`
- Create: `rust/crates/adapters/jt_panel_http/src/routes/{api_keys.rs,agents.rs}`
- Test: `rust/crates/jt_app/tests/api_keys.rs`, `rust/crates/adapters/jt_panel_http/tests/api_keys_http.rs`

**Interfaces:**
- Produces (`jt_app::usecases::api_keys`):
  - `create(deps, ctx, CreateKey { name, scopes: Vec<String> }) -> KeyOut { id, name, prefix, plaintext /* once */, scopes, created_at }`. Plaintext = `jt_live_` + 32 random bytes base64url (no padding); `prefix` = first 12 chars of plaintext for display; stored `key_hash` = hex SHA-256 of the full plaintext. Requested scopes must be a subset of the issuer's permissions, else `FORBIDDEN`; empty scopes → all of the issuer's permissions. Requires `ApiKeysManage`. Ledger `api_keys.create` (payload has `prefix` only).
  - `list(deps, ctx) -> Vec<KeySummary>` (no hash, no plaintext), `revoke(deps, ctx, key_id)` (ledger `api_keys.revoke`).
  - `authenticate(deps, bearer: &str) -> Result<AgentPrincipal, AppError>`: must start with `jt_live_`; hash lookup; `status != active` → `UNAUTHENTICATED`; issuer membership must be active, else `UNAUTHENTICATED`; `effective_scopes = key.scopes ∩ issuer's current permissions` (Review Focus 3); touches `last_used_at`; returns `AgentPrincipal { workspace_id, api_key_id, issued_by: UserId, permissions: BTreeSet<Permission> }`.
  - `pub fn ctx_for_agent(p: &AgentPrincipal, connection_id: AgentConnectionId, now) -> Ctx` with `Actor::Agent`.
- Produces (`jt_app::usecases::agents`): `register_initialize(deps, principal, ClientInfo { name, version, protocol_version }) -> AgentConnectionId` (upsert; ledger `agent.connected` on first sight only); `touch_tool_call(deps, connection_id)`; `list(deps, ctx) -> Vec<AgentConnectionOut>`; `whoami(ctx) -> WhoAmI { actor, workspace_id, permissions }`.

- [ ] **Step 1: Failing tests**: `create_returns_plaintext_once_and_list_hides_it`; `scopes_must_be_subset_of_issuer_permissions`; `authenticate_rejects_unknown_revoked_and_wrong_prefix_with_unauthenticated`; `effective_scopes_shrink_when_issuer_is_demoted` (Review Focus 3: owner creates key with all scopes, owner is demoted to rep by another owner, authenticate → only `workspace.read`); `register_initialize_is_idempotent_per_client_and_ledgers_once`; HTTP: `create_list_revoke_round_trip`.
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api-keys): scoped keys, agent connections and bearer authentication"`

---

### Task 11: MCP adapter — rmcp server, bearer auth, tool registry, gate, M0 tools, stdio mode

**Files:**
- Create: `rust/crates/adapters/jt_mcp/src/{lib.rs,auth.rs,registry.rs,handler.rs,errors.rs,tools/mod.rs,tools/workspace.rs,tools/team.rs,tools/roles.rs,tools/api_keys.rs,tools/agents.rs,tools/ledger.rs,http.rs,stdio.rs}`
- Test: `rust/crates/adapters/jt_mcp/tests/{registry.rs,mcp_http.rs}`

**Interfaces:**
- Consumes: `CATALOG`, use cases from Tasks 7–10 and 12 (ledger list), `authenticate` and `register_initialize`.
- Produces:
  - `pub struct ToolSpec { pub name: &'static str, pub use_case: &'static str, pub description: &'static str, pub input_schema: schemars::Schema, pub risk: Risk }` and `pub fn registry() -> Vec<ToolSpec>`: one entry per `CATALOG` row with `mcp_tool` set. M0 tools: `jeeta.agent.whoami`, `jeeta.workspace.info`, `jeeta.team.list`, `jeeta.team.invite`, `jeeta.team.set_role`, `jeeta.team.remove`, `jeeta.roles.list`, `jeeta.roles.create`, `jeeta.roles.update`, `jeeta.roles.delete`, `jeeta.api_keys.create`, `jeeta.api_keys.list`, `jeeta.api_keys.revoke`, `jeeta.agents.list`, `jeeta.ledger.list`. `tools/list` returns them filtered to the caller's permissions (a tool whose use case needs `TeamManage` is hidden from a read-only key) and each description ends with ` [risk: READ|WRITE|SPEND|DESTRUCTIVE]`.
  - `pub fn http_service(state: McpState) -> axum::Router` mounting rmcp's streamable HTTP service at `/mcp`; every request needs `Authorization: Bearer jt_live_…`; failure → HTTP 401 with the structured error body before any MCP processing. The authenticated `AgentPrincipal` is placed in the request extensions; the `ServerHandler::initialize` override reads `client_info` and calls `register_initialize`, storing the `AgentConnectionId` in the session.
  - Tool call flow in `handler.rs`: look up `ToolSpec` → `CATALOG` entry → `check_gate` (Task 4) with the workspace's current status and `state.gate` → permission check → deserialize arguments → call use case → `touch_tool_call` → ledger `mcp.tool_call` `{tool, risk, ok, duration_ms, error_code?}` → return `CallToolResult` (`is_error: true` with the structured error JSON as text content on failure; on success, the use case output as JSON text plus `structured_content`).
  - `pub async fn run_stdio(state: McpState, principal: AgentPrincipal)`: serves the same handler over stdin/stdout (`transport-io`) for local use; the binary resolves the principal from `JEETA_STDIO_API_KEY`.

- [ ] **Step 1: Failing tests**

`tests/registry.rs`: `every_catalog_mcp_tool_is_registered_and_nothing_else` (B8 half); `registry_names_are_unique_and_prefixed`.
`tests/mcp_http.rs` (spin the axum router on a random port with `TestDb`; use `rmcp` client with `transport-streamable-http-client-reqwest` as a **dev-dependency only** — allowed: dev-dependencies are excluded by `direct_deps`, and `cargo deny` bans apply to the normal graph only when `deny.toml` `[graph] exclude-dev = true` is set; set it): `missing_bearer_is_401_structured`; `initialize_records_agent_connection_with_client_name`; `tools_list_hides_tools_the_key_cannot_use`; `call_team_list_returns_only_own_workspace_members` (Review Focus 2: seed two workspaces, key for A, result has A's members only); `call_writes_ledger_mcp_tool_call_entry`; `call_of_gated_tool_returns_strategy_required` (register a test-only `ToolSpec` with a `Gated` catalog entry via `registry_with(extra)`; assert `is_error` and `code == "STRATEGY_REQUIRED"`); `call_on_pending_payment_workspace_returns_workspace_inactive` for the same gated tool.

- [ ] **Step 2: Run to fail.** **Step 3: Implement** (read rmcp 3.6 docs for `StreamableHttpService`, `ServerHandler`, `tool_router`; prefer explicit `ServerHandler` impl over macros so the registry stays data-driven). **Step 4: Run to pass**; `cargo deny check` green.
- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): streamable HTTP and stdio gate with key auth, registry, strategy gate and ledger"`

---

### Task 12: Ledger use case, twin and gate enforcement tests, SQL scoping scan

**Files:**
- Create: `rust/crates/jt_app/src/usecases/ledger.rs`, `rust/crates/adapters/jt_panel_http/src/routes/ledger.rs`
- Create: `rust/crates/jt_archtest/tests/{twin_rule.rs,sql_scoping.rs,gate_rule.rs}`
- Test: `rust/crates/jt_app/tests/ledger.rs`

**Interfaces:**
- Produces: `jt_app::usecases::ledger::list(deps, ctx, LedgerFilter { action_prefix: Option<String>, actor_kind: Option<String>, limit: u32 /* default 50, max 500 */, before_id: Option<i64> }) -> Vec<LedgerEntryOut>` (requires `LedgerRead`; payload returned through `LedgerEntry::redacted`).
- Produces (`jt_archtest`): `pub fn tenant_tables() -> Vec<String>` parsing `migrations/*.up.sql` for `create table if not exists <name>` whose column list contains `workspace_id`; `pub fn sql_literals_in(crate_dir) -> Vec<(PathBuf, String)>` extracting string literals from `.rs` files that contain `select|insert|update|delete` (case-insensitive).

- [ ] **Step 1: Failing tests**

`jt_app/tests/ledger.rs`: `list_requires_ledger_read`; `list_redacts_secret_keys`; `list_paginates_with_before_id_and_caps_limit_at_500`.
`jt_archtest/tests/twin_rule.rs`: `panel_routes_table_matches_catalog` (every `CATALOG.panel_route` ∈ `jt_panel_http::ROUTES` and vice versa — `jt_archtest` gets `jt_panel_http`, `jt_mcp`, `jt_app` as dev-dependencies); `mcp_registry_matches_catalog`.
`jt_archtest/tests/sql_scoping.rs`: `every_sql_literal_touching_a_tenant_table_mentions_workspace_id` over `crates/adapters/jt_pg/src` (allow an explicit `// archtest: platform-wide` comment on the preceding line for the handful of `PlatformTx` queries, and assert those files also import `PlatformTx`).
`jt_archtest/tests/gate_rule.rs`: `only_listed_use_cases_are_exempt` — the exempt set equals exactly the Global Constraints list (ids starting with `auth.`, `workspace.`, `team.`, `roles.`, `api_keys.`, `agents.`, `ledger.`, `platform.`); any new id outside these prefixes must be `Gated` (B1 structural half; the behavioural half is Task 11's tests).

- [ ] **Step 2: Run to fail.** **Step 3: Implement** the ledger use case + route + MCP tool wiring (Task 11 registry entry `jeeta.ledger.list` now has its use case), and the archtest helpers. **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ledger): listing with redaction, and architecture tests for the twin rule, gate rule and SQL scoping"`

---

### Task 13: Outbound egress client with hostname allowlist

**Files:**
- Create: `rust/crates/adapters/jt_outbound/src/{lib.rs,allowlist.rs,client.rs}`
- Test: `rust/crates/adapters/jt_outbound/tests/egress.rs`

**Interfaces:**
- Produces:
  - `pub struct AllowedHost { pub connector: &'static str, pub host: &'static str }` and `pub const FIXED_HOSTS: &[AllowedHost]` — empty in M0 except a doc comment; M1 fills it per connector (spec §4.3 "sabit katman").
  - `pub struct Egress { .. }` with `Egress::new(fixed: &'static [AllowedHost]) -> Egress`, `fn allow_tenant_host(&self, ws: WorkspaceId, host: &str)` and `fn revoke_tenant_host(&self, ws, host)` (the "kiracı katmanı", fed by capability records in M1), `async fn send(&self, scope: EgressScope, req: reqwest::Request) -> Result<reqwest::Response, EgressError>` where `pub enum EgressScope { Connector(&'static str), Tenant(WorkspaceId) }` and `pub enum EgressError { HostNotAllowed { host: String }, Transport(reqwest::Error) }`.
  - The check happens on `req.url().host_str()` before the request is handed to reqwest (no DNS, no socket). Only `https` is accepted except for hosts `127.0.0.1`/`localhost` in `cfg(test)`.
  - `impl From<EgressError> for AppError` → `HOST_NOT_ALLOWED`.
  - reqwest client built with `redirect(Policy::none())` so a redirect cannot escape the allowlist; timeouts 30 s connect/60 s total.

- [ ] **Step 1: Failing tests**: `disallowed_host_is_refused_without_network` (target `https://203.0.113.1.invalid/` → `HostNotAllowed` immediately); `fixed_host_allowed_for_its_connector_only` (`Connector("meta")` may reach a test entry, `Connector("netgsm")` may not); `tenant_host_allowed_only_for_that_workspace`; `http_scheme_refused_outside_tests_for_public_hosts`; `allowed_local_host_round_trip` (spawn a tiny axum server on 127.0.0.1, allow its host for a tenant, GET returns 200).
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass**; `cargo deny check` confirms `reqwest` appears only under `jt_outbound` (and dev-only in `jt_mcp` tests with `exclude-dev = true`).
- [ ] **Step 5: Commit** — `git commit -m "feat(outbound): single egress client with fixed and tenant hostname allowlists"`

---

### Task 14: Platform operator — bootstrap, login, workspace list and status

**Files:**
- Create: `rust/crates/jt_app/src/usecases/platform.rs`, `rust/crates/adapters/jt_panel_http/src/routes/platform.rs`, `rust/crates/adapters/jt_panel_http/src/platform_session.rs`
- Test: `rust/crates/jt_app/tests/platform.rs`, `rust/crates/adapters/jt_panel_http/tests/platform_http.rs`

**Interfaces:**
- Produces (`jt_app::usecases::platform`): `bootstrap(deps, email, password) -> Result<bool /* created */, AppError>` (idempotent: creates the operator only when `operators.count() == 0`); `login(deps, email, password) -> PlatformSessionOut { token, expires_at /* 12 h */ }`; `resolve(deps, token) -> PlatformCtx`; `list_workspaces(deps, pctx) -> Vec<WorkspaceAdminOut { id, name, slug, status, created_at, owner_email, member_count }>`; `set_status(deps, pctx, ws, WorkspaceStatus)` (writes ledger `platform.workspace_status` into that workspace with `Actor::System { component: "platform_operator:<id>" }`).
- Cookie `jt_platform` (same flags as `jt_session`), routes per `CATALOG`; CSRF header rule applies.
- Gate behaviour: `check_gate` already returns `WORKSPACE_INACTIVE` for `Gated` use cases; this task adds the behavioural tests end to end through the MCP gate using the Task 11 test-only gated tool.

- [ ] **Step 1: Failing tests**: `bootstrap_creates_once`; `login_and_resolve`; `set_status_activates_and_ledgers`; HTTP: `operator_lists_workspaces_and_activates_one`; `tenant_session_cannot_call_platform_routes_401`; MCP (in `jt_mcp/tests/mcp_http.rs`, extend): `gated_tool_passes_after_operator_activates_and_gate_stub_says_strategy_exists`.
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(platform): operator bootstrap, login and workspace activation"`

---

### Task 15: Panel shell (React) — kit copy, i18n, pages, API client, served by the binary

**Files:**
- Create: `rust/panel/{package.json,pnpm-lock.yaml,vite.config.ts,tsconfig.json,tailwind.config.js,postcss.config.js,index.html,vitest.config.ts}`
- Create: `rust/panel/src/{main.tsx,App.tsx,index.css,api/client.ts,api/types.ts,auth/useSession.ts,i18n/{config.ts,tr.json,en.json},pages/{LoginPage,RegisterPage,AcceptInvitePage,HomePage,TeamPage,RolesPage,ApiKeysPage,AgentsPage,LedgerPage,platform/PlatformLoginPage,platform/WorkspacesPage}.tsx,layout/Shell.tsx}`
- Create: `rust/panel/src/components/ui/*` — copied from `frontend/src/components/ui/*.tsx` + `cn.ts` + `index.ts` (component files only, not `*.test.tsx`), with the design tokens from `frontend/src/index.css` copied into `rust/panel/src/index.css` and `frontend/tailwind.config.js` content paths adjusted. Fix imports that pointed outside the kit (search for `@/features`, `@/lib`, `@/store`; replace with local stubs or drop the component if it depends on v1 app state — record each drop in `rust/panel/README.md`).
- Test: `rust/panel/src/i18n/parity.test.ts`, `rust/panel/src/pages/*.test.tsx` (render smoke per page), `rust/crates/adapters/jt_panel_http/tests/static_panel.rs`

**Interfaces:**
- Consumes: the HTTP API from Tasks 8–10, 12, 14 (`/api/*`), cookie auth, `X-Requested-With: jeeta-panel` on every mutating call (set centrally in `api/client.ts`).
- Produces: `pnpm build` → `rust/panel/dist/`; the binary serves it when `JEETA_PANEL_DIR` points at it.
- Pages (TR copy from `tr.json`, EN from `en.json`, keys identical): Login, Register, Accept invite (`/invite/:token`), Home (workspace card + status badge `pending_payment|active|suspended` + "strateji bekleniyor" callout placeholder), Team (list, invite dialog showing the one-time link `/invite/<token>`, role select, remove), Roles (list, create/edit permissions), API keys (list, create dialog showing plaintext once with copy button, revoke), Agents (connections list: client name, version, first/last seen, tool calls), Ledger (table with action filter, actor badge human/agent/system, redacted payload disclosure), Platform login, Platform workspaces (list + activate/suspend). Language switcher and theme toggle from the kit in the shell header; workspace switcher in the shell using `/api/auth/me` memberships.

- [ ] **Step 1: Failing tests**: `parity.test.ts` asserts `Object.keys(flatten(tr))` equals `Object.keys(flatten(en))`; one render smoke test per page with a mocked fetch returning minimal fixtures (asserts the page heading from i18n renders); `static_panel.rs` builds nothing but asserts that when `panel_dir` contains an `index.html` the router serves it at `/team` (already covered in Task 8 — extend to assert `Cache-Control: no-cache` on `index.html` and `max-age=31536000, immutable` under `/assets/`).
- [ ] **Step 2: Run to fail** — `cd rust/panel && pnpm install && pnpm test`.
- [ ] **Step 3: Implement** scaffold, copy kit, pages, client.
- [ ] **Step 4: Run to pass** — `pnpm test && pnpm build && pnpm exec tsc --noEmit`; then `cargo run -p jeeta -- serve` with `JEETA_PANEL_DIR=panel/dist` and check `/` returns the shell (manual smoke; record in README).
- [ ] **Step 5: Commit** — `git commit -m "feat(panel): shell with design kit, bilingual copy, team, keys, agents, ledger and platform pages"`

---

### Task 16: Binary wiring, configuration, CI workflow, docs

**Files:**
- Create: `rust/bin/jeeta/src/{main.rs,config.rs,serve.rs,stdio.rs}`
- Create: `.github/workflows/rust.yml`
- Modify: `rust/README.md`, `rust/.env.example`, `rust/Makefile`

**Interfaces:**
- Produces: `jeeta serve` and `jeeta mcp-stdio` subcommands. Config from environment (loaded with `dotenvy` from `rust/.env` when present): `JEETA_DATABASE_URL` (required), `JEETA_BIND` (default `127.0.0.1:8080`), `JEETA_PANEL_DIR` (optional), `JEETA_COOKIE_SECURE` (default `true`; `false` for local http), `JEETA_SECRET_KEY` (64 hex chars; required, validated at boot, unused until M1 sealing), `JEETA_PLATFORM_BOOTSTRAP_EMAIL` / `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` (optional; when set, Task 14 `bootstrap` runs at boot), `JEETA_STDIO_API_KEY` (for `mcp-stdio`), `JEETA_LOG` (tracing filter, default `info`). Boot order: load config → connect → `migrate_up` → bootstrap operator → build `AppState`/`McpState` with `PgUnitOfWork`, `Argon2Hasher`, `SystemClock`, `UuidV7Gen`, `RandTokenGen`, `NoStrategyYet`, `Egress::new(FIXED_HOSTS)` → merge `jt_panel_http::router` and `jt_mcp::http_service` → serve with graceful shutdown on SIGINT/SIGTERM. Startup logs the bind address and the number of migrations applied; never logs secrets.
- CI `.github/workflows/rust.yml`: `on: push` (branches `main`, `feat/**`) and `pull_request`, with `paths: ["rust/**", ".github/workflows/rust.yml"]`. Jobs: `rust-checks` (ubuntu-latest; `dtolnay/rust-toolchain@1.96.0` with rustfmt+clippy; `Swatinem/rust-cache@v2` with `workspaces: rust`; `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets -- -D warnings`; install cargo-deny 0.19 via `taiki-e/install-action@cargo-deny`; `cargo deny check`); `rust-test` (service `postgres:16-alpine` with `POSTGRES_PASSWORD: postgres`, health check; env `JEETA_TEST_DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres`; `cargo test --workspace`); `panel` (`pnpm/action-setup@v4` with version 9, node 24, `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`), all with `working-directory: rust` or `rust/panel`. No tag triggers.

- [ ] **Step 1: Failing test** — `rust/bin/jeeta/tests/config.rs`: `config_requires_database_url_and_valid_secret_key` (missing url → error naming the variable; secret of wrong length → error naming the variable; valid → `Config` with defaults applied).
- [ ] **Step 2: Run to fail.** **Step 3: Implement** `config.rs`, `serve.rs`, `stdio.rs`, `main.rs`; write the workflow; finish README (local run recipe, how to create the first operator, how to connect Claude Code to `/mcp` with a key, how to run stdio mode) and `.env.example`.
- [ ] **Step 4: Verify everything locally**

Run: `cd rust && make check` (fmt, clippy, deny, tests with `JEETA_TEST_DATABASE_URL` set) and `cd rust/panel && pnpm test && pnpm build`. Then boot: `JEETA_DATABASE_URL=… JEETA_SECRET_KEY=$(openssl rand -hex 32) JEETA_COOKIE_SECURE=false JEETA_PANEL_DIR=panel/dist JEETA_PLATFORM_BOOTSTRAP_EMAIL=op@local JEETA_PLATFORM_BOOTSTRAP_PASSWORD=… cargo run -p jeeta -- serve`; `curl -s localhost:8080/healthz` → `{"ok":true}`; register via `curl` with the header; `curl -s -H 'Authorization: Bearer bad' localhost:8080/mcp` → 401 structured error.
Expected: all green; the three curls behave as stated.

- [ ] **Step 5: Commit and push**

```bash
git add rust/ .github/workflows/rust.yml
git commit -m "feat(jeeta): binary wiring, configuration and CI for the Rust workspace"
git push -u origin feat/rust-rewrite
```

Then confirm the `rust.yml` workflow is green on the PR before declaring M0 done.

---

## Self-review notes

- **Spec coverage (M0 row of §13):** Cargo workspace (T1), PostgreSQL + migrations (T5), MCP and panel gates (T8, T11), multi-tenancy (T5, T6, T12), registration and login (T7, T8), team and roles (T9), platform operator (T14), ban list and two-tier egress allowlist (T1, T13), ledger infrastructure (T3, T5, T12), panel skeleton (T15). B1 (T4, T11, T12, T14), B2 (T1, T13), B8 (T4, T11, T12), B10 skeleton (T6: many keys and agent connections per workspace; T9: no uniqueness per workspace beyond user identity) are covered. B11 (agent check-in warning) belongs to M1 with `studio.pending_work`; the `agent_connections.last_seen_at` column it needs is created here.
- **Type consistency:** `Ctx`, `AppError`, `Principal`, `AgentPrincipal`, `SessionOut`, `ROUTES`, `CATALOG`, `registry()` names are used identically across tasks. `Deps` is introduced in T7 and reused by T9–T14.
- **Review Focus** items each have a named test in the owning task (1→T2/T7, 2→T5/T11, 3→T10, 4→T9, 5→T8).
- **Proportion:** the plan pins decisions (schema, codes, catalog, flags) and leaves bodies to the implementer; the only long code block is the migration, which is a decision, not an implementation.
