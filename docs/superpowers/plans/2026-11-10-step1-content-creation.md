# Step 1 — İçerik oluşturma (content creation): Implementation Plan

> **Who does the work:** Claude, in the main session, itself. The repository's Codex hand-off
> rule was withdrawn by the owner on 2026-11-10 and nothing is handed to Codex. The few tasks
> Codex did before that are named in the execution log at the end. Steps use checkbox
> (`- [ ]`) syntax. The tree is shared with another session; nobody commits unless the owner asks.

**Goal:** From a one-sentence goal and a start time to a finished, checked content package, with
no human in between: the production line, the area page with platform previews, and the agent
protocol behind them. First content kind: images.

**Architecture:** A production area is today's production project
(`studio_production_projects`, one JSON document per area) with new fields: when it starts, who
opened it, the agent's claim and progress, and its packages. An agent takes an area at its start
time through `work.checkin`, reports its step, and delivers a package of platform versions; the
server checks each version with the existing material gate and truth check before accepting it.
No approval step exists. Scheduling the versions is Step 2.

**Tech Stack:** Rust 1.96 (`jt_app` use cases, `jt_pg`, `jt_mcp`, `jt_panel_http`, `jt_testkit`
fakes), sqlx migrations, React 18 + TypeScript + vitest, i18next.

**Spec:** `docs/superpowers/specs/2026-11-10-uc-modul-ve-panel-iskeleti-design.md` §5.3, §5.4, §6.
Step 0's plan (`2026-11-10-step0-skeleton-and-split.md`) holds the module and permission names.

## Global Constraints

- Only agents produce; Jeeta calls no AI, media or trend provider and runs no agent.
- No approval of a package. What replaces it: the material gate, the truth check (§5.4).
- A real capture's share permission is given by a person; an agent may give it only to an
  AI-generated material that shows no person (existing rule, unchanged).
- Every panel operation has an MCP twin; the human's "Olmamış" is panel-only.
- Reversible migrations (up/down, idempotent, down never deletes runtime data: it refuses instead).
- Existing production areas, their sources, requests, productions and scheduled outputs stay and
  stay visible.
- Old tool names keep working: `jeeta.studio.project_*` are extended, not renamed.
- New use cases are `content.*` (module `content`, permissions `content.work` / `content.manage`).
- Shared tree: small targeted edits in files another session changed; never `cargo fmt --all`;
  i18n keys are added line by line; no commits.
- Turkish UI with English parity; no internal term on screen (no "hipotez", "kol", "şerit",
  "yuva", "parça", "claim", "lease").
- Exact counts after Step 0: 268 catalog rows, 227 MCP tools, 101 tables, 35 migrations. This step
  adds 6 catalog rows (4 twins, 2 panel-only), 4 MCP tools, 1 migration (0036), no table.

## The area and its package (stored in the project's JSON)

```rust
// jt_app::ports::production_projects — every new field is #[serde(default)]
pub struct ProductionProject {
    // existing: id, workspace_id, title, brief (the goal sentence), revision, archived, sources,
    // requests, outputs, production_ids, invalidated_production_ids, created_at, updated_at
    pub start_at: Option<OffsetDateTime>,   // None on an area from before: reads as created_at
    pub opened_by: OpenedBy,
    pub hints: AreaHints,
    pub claim: Option<AreaClaim>,
    pub progress: Option<AreaProgress>,
    pub packages: Vec<ContentPackage>,      // oldest first; the last one is the current package
    pub redo: Option<RedoRequest>,          // an "Olmamış" the agent has not answered yet
    pub refused: u8,                        // deliveries refused since the last accepted one
}
pub enum OpenedBy { Human, System { trigger: AreaTrigger, key: String } }   // default Human
pub enum AreaTrigger { Olay, Calendar, Floor }
pub struct AreaHints { pub formats: Vec<PostFormat>, pub capability_ids: Vec<CapabilityId> }
pub struct AreaClaim { pub agent: AgentConnectionId, pub token: Uuid,
                       pub at: OffsetDateTime, pub lease_until: OffsetDateTime }
pub struct AreaProgress { pub step: u8, pub note: String, pub at: OffsetDateTime }  // step 1..=14
pub struct ContentPackage { pub revision: u32, pub delivered_at: OffsetDateTime,
                            pub by: AgentConnectionId, pub summary: String,
                            pub versions: Vec<PackageVersion> }
pub struct PackageVersion { pub id: Uuid, pub format: PostFormat,
    pub capability_id: Option<CapabilityId>,          // the account it is made for, if chosen
    pub text: String, pub title: Option<String>, pub tags: Vec<String>, pub link: Option<String>,
    pub material_ids: Vec<MaterialId>,                // in display order; 1..=MAX_POST_MATERIALS
    pub hypothesis_id: HypothesisId, pub content_type: Option<String>,
    pub slot_id: Option<SlotId> }                     // set when Step 2 schedules it
pub struct RedoRequest { pub note: String, pub by: UserId, pub at: OffsetDateTime }

pub enum AreaState { Queued, Working, WaitingMaterial, Done, Held, Archived }
impl ProductionProject {
    pub fn starts_at(&self) -> OffsetDateTime;                 // start_at or created_at
    pub fn state(&self, now: OffsetDateTime) -> AreaState;
    pub fn needs_agent(&self, now: OffsetDateTime) -> bool;    // what `work.checkin` lists
}
```

State, first match wins: `archived` → Archived; `refused >= 3` → Held; an open material request →
WaitingMaterial; a claim whose lease has not run out → Working; a current package and no `redo` →
Done; otherwise Queued. `needs_agent`: state is Queued and `starts_at() <= now`.

Constants: lease 30 minutes, extended by every progress report; `MAX_GOAL_CHARS` 2000;
`MAX_VERSIONS` 12; `MAX_TAGS` 30; text limits as `studio.piece_submit` applies them.

Mirrored columns (migration `0036_production_areas`): `start_at timestamptz not null`,
`done_at timestamptz null` (the current package's `delivered_at`, null while a redo is open or no
package exists), an index `(workspace_id, archived, done_at, start_at)`, and checks tying both to
`data`, as the table's other mirrored columns have. Backfill: `start_at = created_at`,
`done_at = null`. Down: refuses while any area holds a package, a claim or a redo; otherwise drops
the index and the two columns.

## Use cases

| Use case | Kind | Route / tool | Permission | Strategy |
|---|---|---|---|---|
| `studio.project_create` (extended) | twin | existing | `content.manage` | exempt |
| `studio.project_list` (extended) | twin | existing | `content.work` | exempt |
| `studio.project_get` (extended) | twin | existing | `content.work` | exempt |
| `content.area_claim` | twin | `POST /api/content/areas/{project_id}/claim`, `jeeta.content.area_claim` | `content.work` | exempt |
| `content.area_progress` | twin | `POST /api/content/areas/{project_id}/progress`, `jeeta.content.area_progress` | `content.work` | exempt |
| `content.area_release` | twin | `POST /api/content/areas/{project_id}/release`, `jeeta.content.area_release` | `content.work` | exempt |
| `content.area_deliver` | twin | `POST /api/content/areas/{project_id}/delivery`, `jeeta.content.area_deliver` | `content.work` | **gated** |
| `content.area_redo` | panel-only | `POST /api/content/areas/{project_id}/redo` | `content.manage`, a human | exempt |
| `content.delivery_accept` | panel-only | `POST /api/content/areas/{project_id}/delivery/accept` | `content.manage`, a human | **gated** |

`gating_module`: the prefix `content.` maps to the module `content` (and `social.`, `ads.`,
`materials.` to theirs, for the steps to come).

- **`studio.project_create`** input gains `start_at` (optional; default now; not more than a year
  ahead), `formats`, `capability_ids` (each a live social-account capability of the workspace);
  `title` becomes optional (default: the goal's first 60 characters, cut at a word). `brief` is the
  goal and is required (1..=2000 characters).
- **`studio.project_list`** input gains `scope`: absent = today's behaviour; `"open"` = every
  non-archived area whose `done_at` is null, by `start_at`, then id (at most 200); `"done"` =
  non-archived areas with a `done_at`, newest first, 50 a page, with `done_before` (opaque
  cursor) and `next_done_before`. Every project in every answer carries
  `"state": {"state": "...", "step": n|null, "note": "..."|null, "starts_at": "..."}`.
- **`content.area_claim`** `{expected_revision}` → `{project, claim_token}`. Refused unless
  `needs_agent`; one live claim per area; an agent caller only (a human has no claim).
- **`content.area_progress`** `{claim_token, step, note}` → `{project}`; extends the lease; refused
  with a token that is not the live claim's.
- **`content.area_release`** `{claim_token, reason}` → `{project}`: gives the area back (the agent
  stops, or waits for a material it requested); the area is Queued or WaitingMaterial again.
- **`content.area_deliver`** `{claim_token, request_key, summary, versions[]}` (a version as
  `PackageVersion` without `id` and `slot_id`) → `{project}`. For every version: its materials are
  the area's (a source, or a material produced in the area), live, and eligible to be shared
  (`jt_studio::eligibility`); its text passes the truth check against those materials
  (`jt_studio::truth::check_caption`); `hypothesis_id` is a hypothesis of the approved strategy;
  `capability_id`, when given, is a live social account and `format` is one it takes. All versions
  pass or none is stored. A refusal answers `409 CONFLICT` with
  `details: {"reason": "package_refused", "versions": [{"index": 0, "findings": [...]}]}` and
  counts in `refused`; an accepted package appends a `ContentPackage`, clears `claim`, `redo` and
  `refused`, sets `done_at`. Replayed by `request_key`.
- **`content.area_redo`** `{package_revision, note}` (1..=2000 characters; `package_revision` is
  the current package the person saw, `null` for none) → `ProjectDetail`: stores `redo`, clears
  `done_at` and a kept refusal; the area is Queued again and its work item carries the note. It is
  refused once a newer package was delivered; an agent's progress reports do not stand in its way.
  Step 2 adds: the unpublished versions' planned posts are cancelled.
- **`content.delivery_accept`** `{expected_revision}` → `ProjectDetail` (design B9, B45): for an
  area held after three refusals, a person accepts the kept delivery when the checks, run again,
  hold nothing but its text; the package records who accepted and what. Anything else answers
  `409` `not_releasable`.
- **Opened by the system:** `content::open_by_system(repos, ctx, trigger, key, goal, sources,
  start_at) -> ProductionProject`, idempotent by `key` (the id is `planner::stable_id(ws, key)`).
  Not exposed; Step 2 switches the planner's triggers to it.

Work items (`usecases/work.rs`), each for a caller holding the named permission and only while the
module is installed:

| Kind | For | When | 
|---|---|---|
| `content_area` `{project_id, expected_revision, redo_note}` | agent, `content.work` | `needs_agent` |
| `content_material_request` `{project_id, request_id}` | human, `content.work` | an open material request |
| `content_area_held` `{project_id}` | human, `content.manage` | state Held |

The kind `studio_project` is removed (its condition listed every area for ever).

## Review Focus

1. Two agents claim one area at the same moment: exactly one gets it.
2. An agent delivers after its lease ran out and another agent claimed: refused, nothing stored.
3. A delivery naming a material of another workspace, an erased material, or a real capture with
   no share permission: refused, and the reason says which version and why.
4. A human says "Olmamış" while an agent is working: the claim is not broken; the note reaches the
   agent with its next delivery's answer or its next work item, and the delivered package is not
   marked done while the redo stands.
5. An area from before this step (no `start_at`, outputs but no package): listed, opens, and is
   Queued or Done by the rule, never an error.

---

### Task 1: the area model, migration, opening and listing

**Files:** `rust/crates/jt_app/src/ports/production_projects.rs`,
`rust/crates/jt_app/src/usecases/studio/projects.rs`, `rust/crates/adapters/jt_pg/src/repos/studio/projects.rs`,
`rust/crates/jt_testkit/src/fakes/production_projects.rs`, `rust/migrations/0036_production_areas.*`,
`rust/crates/jt_app/src/usecases/studio/schema.rs`, tests `jt_app/tests/studio_projects.rs`,
`jt_pg/tests/production_projects.rs`, `jt_pg/tests/migrations.rs`.

- [x] 1.1 Types above with `starts_at`, `state`, `needs_agent`; unit tests for every row of the
  state rule and for an old document (no new field) reading as Queued-or-Done.
- [x] 1.2 Migration 0036 with its tests (round trip, backfill, down refusing a stored package).
- [x] 1.3 `project_create` extended (validation table-driven), `project_list` scopes and the
  `state` object in every answer; pg and fake repos agree (contract test).
- [x] 1.4 `open_by_system` with idempotence by key.

### Task 2: claim, progress, delivery with checks, redo, work items

**Files:** `rust/crates/jt_app/src/usecases/content/{mod,areas,package}.rs` (new),
`rust/crates/jt_app/src/usecases/work.rs`, `rust/crates/jt_app/src/catalog.rs`,
`rust/crates/jt_app/src/gate.rs`, `rust/crates/adapters/jt_mcp/src/tools/content.rs` (new),
`rust/crates/adapters/jt_panel_http/src/routes/content.rs` (new), tests
`jt_app/tests/content_areas.rs`, `jt_mcp/tests/content_mcp.rs`, `jt_panel_http/tests/content_http.rs`,
`jt_archtest` exact-count and twin tests. After Task 1.

- [x] 2.1 `area_claim`, `area_progress`, `area_release` (Review Focus 1, 2).
- [x] 2.2 `area_deliver` with the checks (Review Focus 3) and replay by key.
- [x] 2.3 `area_redo` (Review Focus 4).
- [x] 2.4 Work items and the removal of `studio_project`; hints written for an agent that has
  never seen the system (what to read, what to call, in which order).
- [x] 2.5 Catalog rows, MCP tools, routes, schemas, gate prefix mapping; exact counts 273 / 231.

### Task 3: panel — production line, opening, area page

**Files:** `rust/panel/src/pages/content/**`, `rust/panel/src/api/content.ts` (new),
`rust/panel/src/api/projects.ts`, `rust/panel/src/components/ModuleStatusLine.tsx` (new),
`rust/panel/src/lib/workItems.ts`, i18n, tests. Independent of Tasks 1–2 (fixtures).

- [x] 3.1 **Üretim hattı** (`/content`): one list. Open areas by start time (earliest first), then
  finished ones (newest first, "daha fazla"). A row: start time, title, one status sentence, state
  chip; a row waiting for a material is tinted. "Arşivdekileri göster". Empty state invites the
  first area.
- [x] 3.2 **Üretim alanı aç**: goal (required, one sentence is enough), start time (required,
  default now); optional platform (the connected social accounts) and format. Nothing else.
- [x] 3.3 **Üretim alanı sayfası** (`/content?area=<id>`): title, goal, who opened it, state;
  version tabs; the chosen version in a phone frame of its format (square feed post, 4:5,
  9:16 for story / Reels / TikTok, carousel with its pages) with the account name, caption and
  tags as the platform lays them out; beside it the version's summary (format, text, materials
  used), the checks, the agent's note, and **Olmamış** (a note is required). No approve button.
  Below, collapsed: the 14 steps with the current one marked, and material requests (the existing
  request UI). An area with no package yet shows its status sentence where the preview would be.
- [x] 3.4 `ModuleStatusLine` (design §5.3 B30) on the content, social and ads pages: the four
  states of the table, each with its link; computed from `/api/workspace/modules`, `/api/agents`
  and `/api/strategy`; nothing when all is well. It replaces the bare "Ajan bekleniyor" chip.
- [x] 3.5 Home feed: texts and links for `content_area`, `content_material_request`,
  `content_area_held`; `studio_project` removed.
- [x] 3.6 Tests for each state of the line and the page; `tsc` and the full vitest run green.

### Task 4: workflow text, documents, proof with a real agent

- [x] 4.1 The `content` blueprint's `workflow` is the 14 steps of design §6.2.
- [x] 4.2 `rust/README.md`: the area, its states, the agent protocol, migration 0036.
- [x] 4.3 Whole step: clippy, full Rust tests, panel tests, visual check at 1440 and 390.
- [x] 4.4 Proof (design S26): on a separate local database and port, a real connected agent
  session takes an area at its start time and delivers an image package that passes the checks;
  the area page shows it. Recorded in this plan's execution log.

## Execution log

- 2026-11-10 **Proof (4.4) done.** A separate local server (127.0.0.1:8090) on its own empty
  database (`jeeta_modules`): the 36 migrations applied from scratch; an owner registered,
  approved a strategy and installed the modules; the agent's key carried the working permissions
  only (`workspace.read`, `materials.work`, `content.work`, `social.work`, `ads.work`). The owner
  opened one area with one sentence ("Kış koleksiyonundaki yeni kupaları duyuran bir Instagram
  gönderisi hazırla"). A fresh Claude session that had never seen the product, connected through
  nothing but the MCP endpoint, found the area at check-in, claimed it, reported the 14 steps,
  drew a 1080x1350 announcement card with its own tools, uploaded it, added it as an
  agent-made material, attached it and delivered one feed-post version; the delivery was
  accepted the first time and the area reads `done`. The area page shows it (phone frame,
  caption, tags, the agent's note, "Olmamış"); checked at 1440 and 390 against the real server.
  The owner's own connected session remains the final acceptance (design S26).
- What the proof agent had to guess, and what was changed because of it: a key that cannot
  declare a capability was still asked to (capability items are now listed only to
  `capabilities.manage`); the work list's tool description did not name the new kinds; the
  delivery schema had no field descriptions; the tool texts did not say that a claimed area leaves
  check-in, that steps need not be reported in order, that an added material shows up as an
  analysis item, that re-adding a material refreshes it, or what the text check matches. All
  rewritten (`jt_mcp/src/tools/{content,projects,work,studio}.rs`, the schema in
  `usecases/content/mod.rs`, the hint in `usecases/work.rs`). Left as they are: the material tag
  taxonomy and a few older Studio tool descriptions, which are not this step's.

- 2026-11-10 Tasks 1–2 taken over by Claude after Codex's usage limit (the owner then withdrew
  the Codex hand-off rule). What changed against the plan as written, each recorded in the design
  (§13, B39–B46):
  - **A visual the agent made may stand alone** (B39): the earlier rule (spec 2026-11-03 D10) made
    every content need a real capture, so an area without one could never finish. Now a workspace
    setting, on by default (`MaterialPolicy.ai_standalone`, column added by 0036).
  - **Working an area needs only `content.work`** (B40): attaching a material, asking for a
    capture, answering a request. Taking a source out stays `content.manage`.
  - **"Olmamış" is bound to the package seen**, not to the area's revision (B41).
  - **An awaited capture keeps an area unfinished** (B42): `done_at` is null while a request is
    open, in the record and in the mirrored column.
  - **Limits** (B43), **malformed deliveries are validation errors** (B44).
  - **A held area shows why, and a person may accept what only the text check holds** (B45): the
    last refused delivery is kept in the area (`refusal`); new panel-only `content.delivery_accept`.
  - **Names** (B46): `content.area_deliver` and `content.delivery_accept`; the architecture rule
    that forbids "package" in operation names stands.
  - The claim token is a random 32-byte token (the codebase's token generator), not a UUID.
  - Exact counts after this step: **274** catalog rows (4 twins, 2 panel-only), **231** MCP tools,
    101 tables, 36 migrations.

- 2026-11-10 Task 3 done by Codex (T077): production line, opening form, area page with platform
  frames, "Olmamış", the 14 steps, material requests, `ModuleStatusLine`, home feed items; 76
  panel test files / 592 tests green, `tsc` clean; checked at 1440 and 390.
- Polish noted for the final pass: a version tab reads "Hesap seçilmedi · Kaydırmalı gönderi · 1"
  when no account was chosen (drop the account part then).

- 2026-11-11 Whole-step verification, run once for all four steps on the final tree: clippy clean, `cargo fmt --check` clean, whole Rust suite 387 targets / 4,149 tests passed, 0 failed (`--skip production_build`, see the Step 0 log); panel `tsc` clean, 81 test files / 655 tests passed; `design-review/modules.cjs` 23 scenarios at 1440 and 390 (46 runs): no overflow, no page error, no unanswered request.
