# Step 0 — Panel skeleton and the Growth Studio split: Implementation Plan

> **Who does the work:** Claude, in the main session, itself. The repository's Codex hand-off
> rule was withdrawn by the owner on 2026-11-10 and nothing is handed to Codex. The few tasks
> Codex did before that are named in the execution log at the end. Steps use checkbox
> (`- [ ]`) syntax. The tree is shared with another session; nobody commits unless the owner asks.

**Goal:** Replace the single "Büyüme stüdyosu" module by four independently installable modules
(İçerik oluşturma, Sosyal medya yönetimi, Reklam yönetimi, Materyal kütüphanesi), reshape the side
navigation, and re-home the existing screens without changing what they do.

**Architecture:** Use-case ids, HTTP paths and MCP tool names stay (`studio.*`, `/api/studio/...`,
`jeeta.studio.*`); what changes is which *module* and which *permission* each one belongs to. The
module registry gains four builtin blueprints and loses `growth-studio`; the gate maps each use case
to its module, refuses a removed module's use cases, and a removed module's automation stops through
the existing lane brake. The panel gets four module pages composed from the existing components.

**Tech Stack:** Rust 1.96 (hexagonal: `jt_app` use cases, `jt_pg` PostgreSQL adapters, `jt_mcp`,
`jt_panel_http`), sqlx migrations (`NNNN_name.up.sql` / `.down.sql`), React 18 + TypeScript + Vite +
vitest, i18next (`tr.json`, `en.json`).

**Spec:** `docs/superpowers/specs/2026-11-10-uc-modul-ve-panel-iskeleti-design.md` (§4, §5.3, §10,
§11, §12 step 0, Ek A). Decisions cited as S*n* (owner) and B*n* (builder).

## Global Constraints

- No AI, media-generation or trend provider inside Jeeta; no agent runner or agent wake-up.
- Every panel operation keeps its MCP twin; human decisions stay panel-only.
- Tenant isolation (FORCE RLS) on every tenant table; no new table in this step.
- Every migration is a reversible up/down pair; down removes exactly what up added, is idempotent,
  and never touches operator data. Verify up → down → up.
- Existing records stay and stay visible (materials, olays, production areas, planned and published
  posts, measurements, ad-set bindings).
- MCP tool names used by connected agents (`jeeta.studio.*`) do not change in this step.
- The repository is public: no real customer data, screenshots or dumps in docs or tests.
- Another session has uncommitted work in `modules.rs`, `gate.rs`, `catalog.rs`, `App.tsx`,
  `Shell.tsx`, `pages/home/*`, `lib/modules.ts`, `i18n/*.json`. Edit those with small targeted
  edits; never rewrite a whole file; add i18n keys line by line, never regenerate the JSON.
  Do not touch prospects, outreach or inbox pages, `jt_netgsm`, or `rust/README.md` lines about
  prospects / SMS filter / `inbox.send`.
- Never run `cargo fmt --all` (it reformats the other session's files); format only files you
  changed: `rustfmt --edition 2024 <files>`.
- Exact-count assertions today (after the other session's work): 268 catalog rows, 227 MCP tools,
  101 tables, 33 migrations. This step adds migrations 0034 and 0035 and no table, row or tool.
- UI copy is Turkish with English key parity; no internal term (hipotez kolu, şerit, yuva, parça)
  in the new navigation or page titles.

## Names fixed for every task

| Thing | Value |
|---|---|
| Module ids | `content`, `social`, `ads`, `materials` |
| Module names (tr) | İçerik oluşturma, Sosyal medya yönetimi, Reklam yönetimi, Materyal kütüphanesi |
| Module names (en) | Content creation, Social media, Advertising, Materials library |
| Requirements | `content`: none · `social`: `social_account` · `ads`: `ads` · `materials`: none |
| Panel paths | `/content`, `/social`, `/ads`, `/materials`, `/users` |
| Permissions | `content.work`, `content.manage`, `social.work`, `social.manage`, `ads.work`, `ads.manage`, `materials.work` |
| New error | `MODULE_NOT_INSTALLED`, HTTP 409, `details: { "module": "<id>" }` |
| Migrations | `0034_split_growth_studio`, `0035_module_permissions` |

### Use case → module (gate) and permission

`W` = the module's `.work`, `M` = its `.manage`. "any" = the caller needs at least one of the
listed permissions.

| Module | Use cases (`studio.` prefix omitted) | Permission |
|---|---|---|
| `materials` | `file_upload`, `material_add`, `material_get`, `materials_list`, `material_preview`, `material_tag`, `material_bind`, `material_free`, `material_permission`, `material_delete`, `material_intelligence_get`, `material_intelligence_list`, `material_intelligence_update`, `material_analysis_claim`, `material_analysis_complete`, `material_analysis_fail`, `material_analysis_retry`, `olay_create`, `olay_update`, `olay_get`, `olays_list`, `olay_confirm`, `shoot_list`, `shoot_request`, `shoot_resolve`, `piece_submit`, `slot_materials`, `material_check_release` | `materials.work` |
| `content` | `project_create`, `project_get`, `project_list`, `project_update`, `project_materials`, `project_request`, `project_request_update`, `project_production`, `material_production_request`, `material_production_list`, `material_production_claim`, `material_production_complete`, `material_production_fail`, `calendar_list`, `calendar_set`, `material_policy_set` | `content.work`; where the code asks `StudioManage` today, `content.manage` |
| `social` | `project_publication`, `post_requests`, `posts_propose`, `posts_list`, `posting_policy_set`, `weekly_summary`, `slot_get`, `slot_cancel`, `tiktok_metrics` | `social.work` |
| `social` | `project_schedule`, `tiktok_posting`, `tiktok_post` | `social.manage` (where the code asks `StudioManage` today; else `social.work`) |
| `ads` | `adsets_list`, `adset_bind` | `ads.work` |
| `ads` | `budget_move` | `ads.manage` |
| none | `overview`, `pending`, `learned`, `ledger`, `ledger_export` | any of `content.work`, `social.work`, `ads.work`, `materials.work` |
| none | `judgment_record`, `trend_record`, `hypothesis_propose` | any of `content.work`, `social.work`, `ads.work` (`hypothesis_propose` also `team.manage`, as today) |
| none | `brake` | any of `social.manage`, `ads.manage`, `budget.manage` |
| none | `policy_set` | organic lane: `social.manage`; paid lane: `ads.manage` |
| none | `approve` | slot target: `social.manage`; budget-move target: `ads.manage` |

"none" means the use case is not tied to one module: the gate neither locks it on a module's missing
capability nor refuses it when a module is removed.

## Review Focus

1. A workspace whose stored registry has `growth-studio` removed (installed: false) must come out of
   the migration with all four new modules not installed, not installed-by-default.
2. A workspace created after 0032 with no registry row must keep its inbox after the migration.
3. Removing `ads` while an ad set is bound must pause it at the provider (same path as the brake),
   and re-installing must let it run again without a human releasing a brake.
4. A custom role that held only `studio.work` must be able to do exactly what it could before; a
   role that never held it must gain nothing.
5. An old bookmark `/studio?tab=materials&view=olays&olay=<id>` must land on that olay.

---

### Task 1: module registry split, gate, removal semantics

**Files:**
- Modify: `rust/crates/jt_app/src/usecases/modules.rs` (catalog, required set, dependency rule,
  `installed_in`, `installed`)
- Modify: `rust/crates/jt_app/src/gate.rs` (`studio_module`, `gating_module`, `module_installed`,
  install check)
- Modify: `rust/crates/jt_app/src/error.rs`, `rust/crates/adapters/jt_panel_http/src/error.rs`
  (`ModuleNotInstalled`)
- Modify: `rust/crates/adapters/jt_pg/src/strategy_gate.rs` (`module_installed` from the database)
- Modify: `rust/crates/domain/jt_studio/src/control.rs` (`LaneControl::module_removed`)
- Modify: `rust/crates/adapters/jt_pg/src/repos/studio/control.rs` and the fake control repo in
  `rust/crates/jt_testkit/src/fakes/` (`lock_control` derives `module_removed`)
- Modify: `rust/crates/jt_app/src/usecases/jobs.rs`, `studio/planner.rs`, `studio/measure.rs`
  (skip a removed module's automation)
- Create: `rust/migrations/0034_split_growth_studio.up.sql`, `.down.sql`
- Test: `rust/crates/jt_app/tests/gate.rs`, `rust/crates/jt_app/tests/modules.rs` (or the existing
  module test target), `rust/crates/adapters/jt_pg/tests/module_gate.rs`,
  `rust/crates/adapters/jt_pg/tests/migrations.rs`

**Interfaces — Produces:**

```rust
// jt_app::usecases::modules
pub const CONTENT: &str = "content";
pub const SOCIAL: &str = "social";
pub const ADS: &str = "ads";
pub const MATERIALS: &str = "materials";
/// Removing one of these stops its automation; the gate refuses its use cases while removed (S25).
pub const INSTALL_GATED: &[&str] = &[CONTENT, SOCIAL, ADS, MATERIALS];
/// Whether builtin module `id` is installed in a stored registry (`None`: no row). Pure: the
/// catalog, the legacy flag and the materials dependency decide.
pub fn installed_in(data: Option<&serde_json::Value>, id: &str) -> Result<bool, AppError>;
pub async fn installed(repos: &mut dyn TenantRepos, id: &str) -> Result<bool, AppError>;

// jt_app::gate
/// The module of a `studio.*` use case (table above); `None` for the cross-module ones.
pub fn studio_module(id: &str) -> Option<&'static str>;
pub fn gating_module(id: &str) -> Option<&'static str>; // inbox.people.* → None (S10)
trait StrategyGate { async fn module_installed(&self, ws: WorkspaceId, module: &str)
    -> Result<bool, AppError> { Ok(true) } }

// jt_app::error
impl AppError { pub fn module_not_installed(module: &str) -> Self }  // ErrorCode::ModuleNotInstalled

// jt_studio::LaneControl
#[serde(skip)] pub module_removed: bool,   // is_braked(lane) is true while it is set
```

- [x] **1.1 Catalog and required set.** `catalog()` drops `growth-studio`, adds the four modules
  with the names, requirements and a short workflow; `load()` makes only `strategy` required.
  Test `builtin_catalog_has_four_studio_modules_and_only_strategy_is_required`: ids contain
  `content`, `social`, `ads`, `materials`, not `growth-studio`; `required` is true for `strategy`
  only; requirements are exactly `[]`, `["social_account"]`, `["ads"]`, `[]`.
- [x] **1.2 Materials dependency (B3).** Installing `content`, `social` or `ads` installs
  `materials`; removing `materials` while one of them is installed answers `VALIDATION`
  (`field: "module"`); `load()` repairs a stored registry that breaks the rule. Tests
  `installing_social_installs_materials`, `materials_cannot_be_removed_while_a_dependant_is_installed`,
  `materials_installs_alone`.
- [x] **1.3 `installed_in` / `installed`.** Tests over stored JSON: no row → strategy only; legacy
  row with no entries → every builtin installed; explicit `installed: false` wins over legacy.
- [x] **1.4 Gate mapping.** `studio_module` follows the table; `gating_module` returns it for
  `studio.*`, `None` for `inbox.people.*`, unchanged otherwise. Test
  `every_studio_use_case_has_a_module_or_is_listed_cross_module`: iterate the catalog's `studio.*`
  rows; each is in exactly one of the five groups of the table; the group sizes are 28, 16, 12, 3, 11.
- [x] **1.5 Install check.** `check_gate`: after the capability check, a use case whose module is in
  `INSTALL_GATED` and is not installed answers `MODULE_NOT_INSTALLED` (409, `details.module`);
  `CAPABILITY_EXEMPT` use cases are never refused. `PgStrategyGate::module_installed` reads the
  registry row and calls `installed_in`. Tests in `jt_app/tests/gate.rs` (fake gate) and
  `jt_pg/tests/module_gate.rs` (database, HTTP and MCP): removed `ads` refuses `studio.adset_bind`
  and still allows `studio.brake` and `studio.overview`.
- [x] **1.6 Removal stops automation (S25).** `lock_control()` (pg and fake) sets
  `lanes[Organic].module_removed = !installed(social)` and `lanes[Paid].module_removed =
  !installed(ads)` in `StudioControl::removed`; `is_braked` honours it; nothing persists it.
  `modules::remove` / `install` of `ads` call `studio::control::reconcile_bindings` after commit
  (best effort, like `brake`). No job needs its own check: the planner, the publisher, the budget
  dispatcher and the reconciliation already ask `is_braked` per lane. Measurement keeps running
  (it observes, it does not act). The shared spend gate (`reserve_connector_spend`) serves the
  inbox too, so a reservation without a Studio chain asks the human brake alone
  (`StudioControl::brake_engaged_for`): removing a module must not stop inbox sends. Tests:
  `removed_social_holds_publication_and_reinstall_resumes`,
  `removed_ads_pauses_bound_adset_and_reinstall_resumes`,
  `removed_module_flag_is_never_stored` (set a brake while removed, reinstall, lane not braked).
- [x] **1.7 Migration 0034.** Up, with `app.platform = 'on'` like 0032: (a) a registry holding a
  `growth-studio` entry gets four entries copying its `installed` and `config` (revision 1) and
  loses the old entry; (b) a non-legacy registry with no `inbox` entry gets one, installed;
  (c) a workspace with no registry row gets `{"legacy":false,"modules":[<inbox entry>]}`.
  Down: (a) any registry holding one of the four ids loses them and, if it has no `growth-studio`
  entry, gains one with `installed` = any of the four installed and the config of the first of
  `content`, `social`, `ads`, `materials` present; (b) an `inbox` entry equal to the seeded default
  is removed from non-legacy registries; (c) rows equal to `{"legacy":false,"modules":[]}` are
  deleted. Tests in `migrations.rs`: `split_growth_studio_round_trip` (up → down → up gives the
  same rows), `split_keeps_removed_studio_removed`, `split_keeps_inbox_for_rowless_workspaces`,
  and the migration count becomes 34.
- [x] **1.8 Fix what the change forces**: exact module lists in `jt_mcp` / `jt_panel_http` tests,
  `jt_testkit` fakes, the panel fixture `rust/panel/src/test/modules.ts` (`legacyModules` gets the
  four ids instead of `growth-studio`).
- [x] **1.9 Verify.** `cd rust && cargo test --locked --workspace --test gate --test modules --test
  module_gate --test migrations --test studio_rules --test catalog --test registry` green; then the
  full block once.

### Task 2: panel skeleton and re-homing

**Files:** `rust/panel/src/**` except `pages/prospects/**`, `pages/Prospect*.tsx`,
`pages/Outreach*.tsx`, `pages/Inbox*.tsx`.

**Interfaces — Consumes:** the names table above. API paths are unchanged.

- [x] **2.1 Side navigation** (`layout/Shell.tsx`): top: Ana sayfa, Strateji. Modules: every
  installed module that is not required (the inbox is now one of them), then "Modül ekle".
  "Yönetim" group: Bütçe, Kullanıcılar, API anahtarları, Yetenekler ve bağlantılar, Ajanlar. İş
  takibi and Günlük are gone.
- [x] **2.2 Routes** (`App.tsx`): `/content`, `/social`, `/ads`, `/materials` each inside
  `<ModuleGate moduleId=...>`; `/users`. Redirects (`<Navigate replace>` keeping the query string):
  `/studio` → by `tab` (`materials` → `/materials`, `projects` → `/content`, `posts` → `/social`
  with `tab=posts`, none → `/social`); `/team` and `/roles` → `/users`; `/activity` and `/ledger`
  → `/`. `lib/modules.ts`: `BUILTIN_PATHS` and `moduleVisibleTo` know the four ids
  (`<id>.work`).
- [x] **2.3 Module pages**, composed from the existing components, behaviour unchanged:
  - `pages/materials/MaterialsPage.tsx`: `StudioMaterials` with Yükle, Kütüphane, Olaylar, Çekim
    listesi (no Takvim).
  - `pages/content/ContentPage.tsx`: tabs "Üretim alanları" (`StudioProjects`) and "Özel günler"
    (`MaterialsCalendar` with the materials rules).
  - `pages/social/SocialPage.tsx`: tabs Bugün (`StudioToday`), Plan (`StudioPlan`), Paylaşımlar
    (`PostsPlan`), Haftalık özet (`PostsWeek`), Ayarlar (`PostsSettings` plus the organic-lane
    switch "Paylaşımı duraklat" calling `brake(engaged, 'organic', revision)`).
  - `pages/ads/AdsPage.tsx`: the paid controls now inside `StudioLearned` (ad sets, bind, budget
    move) and the pending budget moves; an explanatory empty state when the paid lane is not
    available.
  - Opening a slot from another page goes to `/social?slot=<id>`.
- [x] **2.4 Strategy and budget:** `StrategyPage` gains a section "Öğrenilenler" (`StudioLearned`
  without the paid controls and without the trend form); `BudgetPage` gains a section "Durdurma"
  with "Reklam harcamasını durdur" (`brake(engaged, 'paid', revision)`), and shows a release
  button when the workspace-wide brake is engaged. `StudioStrategyBar`, `StudioLedger`,
  `LedgerPage` and `WorkspaceActivityPage` are deleted with their tests.
- [x] **2.5 Kullanıcılar** (`pages/UsersPage.tsx`): the team section then the roles section of
  today's two pages on one page; `/team/distribution` keeps working.
- [x] **2.6 Home:** `WorkFeed` shows every pending item (no slice of four) and loses the links to
  `/activity` and `/ledger`; its "Günlük" tab stays (S27). `agenda.ts`, `AgendaCalendar.tsx` and
  `lib/workItems.ts` use the new module ids and paths (slot → `/social?slot=`, shoot request →
  `/materials?view=shoots`, project → `/content?project=`, budget move → `/ads`).
- [x] **2.7 Permissions and errors in the panel:** `can(...)` checks use the new keys per page
  (`materials.work`, `content.work`, `content.manage`, `social.work`, `social.manage`, `ads.work`,
  `ads.manage`); role labels for the seven keys in both languages; `MODULE_NOT_INSTALLED` in
  `lib/errors.ts`, `i18n` and `QueryState`.
- [x] **2.8 Tests:** the existing Studio tests move with their components and stay green;
  new: `Shell.test.tsx` (navigation order, no İş takibi / Günlük, inbox among modules),
  `App.redirects.test.tsx` (each redirect above, including Review Focus 5),
  `UsersPage.test.tsx`, `SocialPage.test.tsx`, `AdsPage.test.tsx`, `ContentPage.test.tsx`,
  `MaterialsPage.test.tsx`. `npx vitest run` and `npx tsc --noEmit` green.

### Task 3: permissions per module

**Files:** `rust/crates/domain/jt_tenancy/src/role.rs`, `rust/crates/jt_app/src/ctx.rs`,
`rust/crates/jt_app/src/usecases/studio/**`, `rust/crates/jt_app/src/usecases/work.rs`,
`rust/crates/adapters/jt_mcp/src/**`, `rust/crates/jt_testkit/src/**`,
`rust/migrations/0035_module_permissions.*`, and the tests these force. After Task 1.

**Interfaces — Produces:**

```rust
// jt_tenancy::Permission: StudioWork and StudioManage are removed; added, with these keys:
ContentWork "content.work", ContentManage "content.manage", SocialWork "social.work",
SocialManage "social.manage", AdsWork "ads.work", AdsManage "ads.manage",
MaterialsWork "materials.work"
// jt_app::ctx::Ctx
pub fn require_any(&self, any: &[Permission]) -> Result<(), AppError>; // FORBIDDEN, details.permissions
// jt_mcp ToolDef / ToolSpec: `permission: Permission` becomes `permissions: &'static [Permission]`
// (any of); listing and the pre-check use "any".
```

- [x] **3.1** Enum, keys, `ALL_PERMISSIONS`, `require_any` (+ unit tests).
- [x] **3.2** Each use case asks the permission of the table above; `policy_set` and `approve`
  decide by lane / target. Table-driven test `every_studio_use_case_asks_its_module_permission`:
  for each `studio.*` row, a caller holding every permission except the row's is `FORBIDDEN`, and a
  caller holding only one of the row's permissions passes the permission check.
- [x] **3.3** `work.rs`: an item is listed for a caller holding its module's permission (slot,
  approval of a slot: social; budget move and its approval: ads; shoot request and material
  analysis: materials; production area and material production: content).
- [x] **3.4** Migration 0035. Up, on `roles.permissions` and `api_keys.scopes`: `studio.work` is
  replaced by the four `.work` keys, `studio.manage` by the three `.manage` keys. Down: an array
  holding all four `.work` keys gets `studio.work` back; the new keys are removed either way (a
  partial set is dropped, never widened); same for `.manage`. Tests: round trip, Review Focus 4,
  `partial_new_permissions_are_dropped_on_down`.
- [x] **3.5** MCP: `permissions` (any-of) on every tool; the registry and scoped-client tests.
- [x] **3.6** Verify: fast block with the touched test targets, then the full block once.

### Task 4: work routing by assignment, documents, whole-step verification

- [x] **4.1 Assignment (B34).** `work.rs`: for an agent caller, an item of module *m* is listed only
  if *m* has no assigned agent (`config.agent_ids` empty) or the caller's connection is assigned;
  items of a removed module are never listed. A human caller is unaffected. Tests
  `assigned_agent_gets_the_module_work_and_others_do_not`,
  `unassigned_module_serves_any_agent_with_permission`, `removed_module_work_is_not_listed`.
- [x] **4.2 Documents.** `rust/README.md`: modules table, permissions table, migrations 0034 and
  0035, removal rule. `rust/panel/design-review/studio.cjs` scenarios follow the new paths.
- [x] **4.3 Whole step.** `cd rust && cargo clippy --locked --workspace --all-targets -- -D
  warnings && cargo test --locked --workspace`; `cd rust/panel && npx tsc --noEmit && npx vitest
  run`; design-review harness on the four module pages at 1440 and 390; the running local server
  shows the new navigation with existing data.

## Execution log

- 2026-11-10 Task 2 done by Codex (T075): 74 panel test files / 573 tests green, `tsc` clean;
  fixture-based visual check of the four module pages, Kullanıcılar, Bütçe and the legacy
  redirects at 1440 and 390: no overflow, no page error.
- 2026-11-10 Task 1 steps 1.1–1.7 done by the coordinator. Found while building: the lane brake
  is also the inbox's spend gate (see 1.6); Studio test worlds must install the modules
  (`jt_testkit::studio_contract::install_all_modules`, called by `fixture_in` and the attribution
  contract's setup).
- `bin/jeeta/tests/m4_deployment.rs::production_build_refuses_test_loopback` needs a fresh
  `target/release/jeeta` and `rust/panel/dist`; both are the other session's demo build, so the
  test is skipped (`-- --skip production_build`) until the owner allows a rebuild.
- Task 3 handed to Codex (T076).
- Test worlds: `TestDb::seed_workspace` now stores the legacy registry (every builtin module
  installed); `TestDb::seed_new_workspace` leaves a workspace as registration does (strategy
  only). `jt_pg/tests/modules_registry.rs`, `jt_panel_http/tests/modules_http.rs` and the two
  install-gate tests use the latter.
- Rust tasks from here on verify with clippy and their fast block; the coordinator runs the whole
  suite at each step's end (one full run takes about 20 minutes and exact-count tests make
  parallel Rust tasks collide).
- 2026-11-10 Task 3 done by Codex (T076): seven module permissions, `Ctx::require_any`, any-of
  MCP scopes, migration 0035; its whole-suite run: clippy clean, 4,036 tests in 370 targets
  green. Coordinator's follow-up: a set of one permission refuses exactly as `require` does
  (`details.permission`), so single-permission tools answer the same over the panel and MCP.
- Task 4.1 (work routing by assignment, removed modules' work not listed) is folded into the
  Step 1 server task (T078), which rewrites `usecases/work.rs` anyway.

- 2026-11-11 Task 4.1 verified in the tree: `work.rs::module_work_offered` and `work_module`
  (content, social, ads and materials kinds, the ad campaign kinds among them) with the three
  named tests in `jt_app/tests/studio_permissions.rs`. Task 4.2: the README carries the modules,
  the permissions, migrations 0034 and 0035 and the removal rule; the visual scenarios of the
  four module pages live in `rust/panel/design-review/modules.cjs` (not in `studio.cjs`).

- 2026-11-11 Whole-step verification, run once for all four steps on the final tree: clippy clean, `cargo fmt --check` clean, whole Rust suite 387 targets / 4,149 tests passed, 0 failed (`--skip production_build`, see the Step 0 log); panel `tsc` clean, 81 test files / 655 tests passed; `design-review/modules.cjs` 23 scenarios at 1440 and 390 (46 runs): no overflow, no page error, no unanswered request.
