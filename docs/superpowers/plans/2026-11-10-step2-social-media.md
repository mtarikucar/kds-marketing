# Step 2 — Sosyal medya yönetimi (social media): Implementation Plan

> **Who does the work:** Claude, in the main session, itself. The repository's Codex hand-off
> rule was withdrawn by the owner on 2026-11-10 and nothing is handed to Codex. The few tasks
> Codex did before that are named in the execution log at the end. Steps use checkbox
> (`- [ ]`) syntax. The tree is shared with another session; nobody commits unless the owner asks.

**Goal:** A finished content package goes out without a human: the module's agent chooses the
time, Jeeta posts it (or lets the platform's own scheduler hold it), and the module's page shows
each connected account with its performance, what is coming and what went out.

**Architecture:** A package version becomes a planned post through the existing posting engine
(package request → planned post → slot → piece → publication → measurement); nothing new
publishes. What is new: the use case that schedules a version, the work item that asks the agent
for a time, the account read models with daily account snapshots, an optional "schedule at the
provider" ability on the publisher port (Facebook Pages only today), and the removal of the
lane-level approval.

**Tech Stack:** Rust 1.96 (`jt_app`, `jt_pg`, `jt_mcp`, `jt_panel_http`, `jt_meta`, `jt_testkit`),
sqlx migrations, React 18 + TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-uc-modul-ve-panel-iskeleti-design.md` §5.4, §7,
Ek B.1, Ek B.2. Earlier steps: `2026-11-10-step0-skeleton-and-split.md`,
`2026-11-10-step1-content-creation.md` (the package and its versions).

## Global Constraints

- No approval before publishing (S18, S23). The lane-level "requires human approval" goes; the
  per-connection flag in Yetenekler ve bağlantılar stays and is honoured (B35).
- TikTok still needs its posting screen filled by a person (platform rule, §7.4): unchanged.
- Limits stay as they are: daily caps, spacing, quiet hours, lead and grace per format.
- No messages or comments in this module; no trend tracking.
- A metric the platform does not give is shown as missing, never invented.
- Publishing never happens twice: the existing fenced attempt and recovery rules hold for a post
  scheduled at the provider exactly as for one Jeeta sends.
- Reversible migrations; tenant isolation (FORCE RLS) on the one new table.
- New use cases are `social.*` (module `social`, permissions `social.work` / `social.manage`).
- Shared tree: small targeted edits; never `cargo fmt --all`; i18n keys line by line; no commits.
- Exact counts after Step 1: 273 catalog rows, 231 MCP tools, 101 tables, 36 migrations. This step
  adds 5 catalog rows (4 twins, 1 panel-only) and 4 MCP tools, removes one row and one tool
  (`studio.policy_set`), and adds 1 table (`social_account_days`) and 2 migrations (0037, 0038):
  277 rows, 234 tools, 102 tables, 38 migrations.

## Use cases

| Use case | Kind | Route / tool | Permission | Strategy |
|---|---|---|---|---|
| `social.version_schedule` | twin | `POST /api/social/versions/schedule`, `jeeta.social.version_schedule` | `social.work` | gated |
| `social.accounts_list` | twin | `GET /api/social/accounts`, `jeeta.social.accounts_list` | `social.work` | exempt |
| `social.account_get` | twin | `GET /api/social/accounts/{capability_id}`, `jeeta.social.account_get` | `social.work` | exempt |
| `social.versions_waiting` | twin | `GET /api/social/packages`, `jeeta.social.versions_waiting` | `social.work` | exempt |
| `social.account_pause` | panel-only | `POST /api/social/accounts/{capability_id}/pause` | `social.manage`, a human | exempt |

- **`social.version_schedule`** `{project_id, version_id, capability_id, publish_at, request_key}`
  → `{project, publication}`. The version is of the area's current package and has no `slot_id`;
  the area has no open redo; `capability_id` is a live social account that takes the version's
  format (the version's own `capability_id`, when it has one, must be this one). It plans the post
  through `posts_propose_locked` (trigger `Project`, the package's hypothesis and content type, the
  version's materials) and, in the same transaction, submits the version's text and media as the
  slot's piece, so the slot is Ready at once. Every refusal the engine has (caps, spacing, quiet
  hours, horizon, material gate, truth check) answers as it does for `studio.posts_propose`.
  Replayed by `request_key`. Sets the version's `slot_id`.
- **`social.versions_waiting`** → the versions of current packages that have no `slot_id`, with
  the area's goal, the package summary, and for each version the accounts that could take it.
- **`social.accounts_list`** → every social-account capability with: name, kind, status, paused,
  the latest snapshot's numbers, the next planned post's time and format.
- **`social.account_get`** `{capability_id, from, until}` (at most 366 days) →
  `{account, days: [{day, followers, reach, views, engagement, profile_visits}], upcoming:
  [{slot_id, publish_at, format, title, held_at_provider, state, waits_for}], recent: [{slot_id,
  published_at, format, title, url, metrics}], totals}`. A number the platform did not give is
  `null`.
- **`social.account_pause`** `{paused, expected_revision}` → the posting policy with
  `paused_capability_ids`. A paused account is planned and published no more than a braked lane;
  its posts already scheduled at the provider are withdrawn (Task 3).
- **Work item** `social_schedule` `{project_id, version_id}` for an agent holding `social.work`,
  for each waiting version, while the module is installed. Its hint names
  `jeeta.social.versions_waiting` and `jeeta.social.version_schedule` and the limits.
- **"Olmamış" (Step 1's `content.area_redo`)** now also cancels the planned posts of the current
  package's versions that are not published (the slot is cancelled with the reason
  `content_redo`, a post scheduled at the provider is withdrawn) and clears their `slot_id`.
- **Triggers.** When `content` is installed, the planner's olay and calendar triggers (and the
  floor trigger) open a production area through `content::open_by_system` instead of writing a
  package request; the goal sentence names the olay, the occasion or the quiet channel. When
  `content` is not installed, today's path stays (package request → `studio.posts_propose` →
  `studio.piece_submit`): that is the "simple package" of design B18.
- **Lane approval removed.** `studio.policy_set` and the lane's `requires_human_approval` are
  removed. Migration 0038: a workspace whose organic or paid lane required approval
  gets `requires_human_approval = true` on the capabilities of that lane (social accounts for
  organic, ad accounts for paid), so nothing a person switched on is switched off; down restores
  the lane flag where every capability of the lane has it. `studio.approve` stays for the TikTok
  screen, the per-connection flag and budget moves.

## Account snapshots

Table `social_account_days` (migration 0037): `workspace_id`, `capability_id`, `day date`,
`data jsonb` (the numbers read that day: `followers`, `reach`, `views`, `engagement`,
`profile_visits`, each optional), `read_at`; primary key `(workspace_id, capability_id, day)`;
FORCE RLS. The `studio_measure` job (every 6 hours), also: for each workspace with `social` installed
and each live social account, `InsightsReader::account_metrics` once a day (the first successful
read of the day stands; a failed read is retried on the next run and stores nothing). Kept 400
days. Down: drops the table (it holds observations only, re-read from the platform).

## Scheduling at the provider (Facebook Pages)

```rust
// jt_app::ports::connectors::Publisher — defaults mean "this provider cannot"
/// Whether `request` can be held by the provider until `at`: the earliest and latest lead it
/// accepts, or `None`.
fn schedule_window(&self, public: &Value, request: &PublishRequest) -> Option<(Duration, Duration)> { None }
/// Creates the post at the provider to go out at `at`. Its receipt names the scheduled post.
async fn schedule(&self, cred: &Credential, public: &Value, request: &PublishRequest,
                  at: OffsetDateTime) -> Result<PublishReceipt, ConnectorError> { unsupported }
/// Withdraws a post `schedule` created and that has not gone out. `Ok(false)`: it already went out.
async fn withdraw(&self, cred: &Credential, public: &Value, external_id: &str)
    -> Result<bool, ConnectorError> { unsupported }
```

- `jt_meta`: Facebook Page text, link and single-photo posts (`published=false`,
  `scheduled_publish_time`); window 15 minutes to 29 days. Not stories, not Reels, not Instagram.
- The publisher job, besides posts that are due, takes Ready slots whose time is inside their
  provider's window and that no attempt exists for: it claims the attempt as it does for a
  publication (same authorization, same fence) and calls `schedule`. The attempt is recorded as
  held at the provider, with the scheduled post's id as evidence. `resolve` answers `Pending`
  until the time has passed and the post reads as published, then `Published`: the existing
  recovery settles the slot. A slot held at the provider shows "Platformda zamanlandı"; any other
  planned slot "Jeeta yayınlayacak".
- Whatever would stop Jeeta from sending also withdraws: a brake, the module removed, the account
  paused, the slot cancelled or retired, the area's redo, the connection's approval flag switched
  on, the piece replaced. `withdraw` → the attempt ends as withdrawn and the slot is Ready again
  with no attempt; when the stop ends it is scheduled again if its time is still inside the
  window, else Jeeta sends it at its time. A withdraw the provider does not confirm is the
  existing "unknown" outcome: it waits for a person in the home feed and is never sent twice.

## Review Focus

1. Two agents schedule the same version at once: one planned post, the other answer is the same
   post (replay) or a refusal, never two posts.
2. A version scheduled, then "Olmamış": the post does not go out; with a provider-held post, the
   withdraw is confirmed before the slot is reused; if the withdraw fails the slot is not re-sent.
3. A brake engaged one second after a post was handed to the provider: it is withdrawn; released:
   it goes out once.
4. An account with no numbers from its platform (TikTok, X): the page shows the posts and "—"
   for each missing number, not zero.
5. A workspace with lane approval on: after 0038 its posts still wait for a person.

---

### Task 1: package to planned post, waiting packages, redo hook, trigger switch

**Files:** `rust/crates/jt_app/src/usecases/social/{mod,schedule}.rs` (new),
`usecases/content/areas.rs` (redo hook), `usecases/studio/planner.rs`, `usecases/work.rs`,
`catalog.rs`, `jt_mcp/src/tools/social.rs` (new), `jt_panel_http/src/routes/social.rs` (new), tests.

- [x] 1.1 `social.version_schedule` (Review Focus 1) and `social.versions_waiting` (renamed: no
  "package" in an operation name, design B46).
- [x] 1.2 Work item `social_schedule`.
- [x] 1.3 Redo cancels unpublished planned posts (Review Focus 2, the part without a provider).
- [x] 1.4 Triggers open production areas when `content` is installed; unchanged otherwise.

### Task 2: accounts, snapshots, pause, lane approval removal

**Files:** `usecases/social/accounts.rs` (new), `ports` and `jt_pg` repo for `social_account_days`,
`jt_testkit` fake, `usecases/jobs.rs`, `usecases/studio/control.rs`, migrations 0037 and 0038,
catalog, MCP, routes, tests.

- [x] 2.1 Table, repo, retention; contract test fake = pg (`social_accounts_contract`). The read is
  part of the existing `studio_measure` job, not a job of its own.
- [x] 2.2 `social.accounts_list`, `social.account_get` (Review Focus 4).
- [x] 2.3 `social.account_pause`; a paused account is neither planned nor published.
- [x] 2.4 Lane approval removed with migration 0038 (Review Focus 5); `studio.policy_set` gone;
  exact counts after Tasks 1 and 2: 278 catalog rows, 234 MCP tools, 102 tables, 38 migrations.

### Task 3: scheduling at the provider

**Files:** `jt_app/src/ports/connectors.rs`, `usecases/studio/publish.rs`, `jt_meta/src/**`,
`jt_testkit/src/fakes/providers.rs`, tests (`jt_app/tests/studio_publish.rs`,
`jt_meta/tests/studio_publish.rs`). After Tasks 1 and 2. `review: security`.

- [x] 3.1 Port methods with defaults; scripted connector support.
- [x] 3.2 Meta: schedule and withdraw a Page post; request and response shapes tested against
  the Graph mock, from the documented API (no live call).
- [x] 3.3 Publisher: hold at the provider, settle by `scheduled`, withdraw on every stop (Review
  Focus 2 and 3), never twice.

### Task 4: panel — accounts screen

**Files:** `rust/panel/src/pages/social/**`, `rust/panel/src/api/social.ts` (new), i18n, tests.
Independent of Tasks 1–3 (fixtures).

- [x] 4.1 `/social`: accounts on the left (name, platform, paused or locked marks, "Hesap bağla"
  to `/connect`), the chosen account on the right: four numbers with their change, a trend line,
  period choice (7, 30, 90 days), "Sıradaki paylaşımlar" (time, title, format, "Platformda
  zamanlandı" / "Jeeta yayınlayacak"), "Son paylaşımlar" (time, title, format, link, numbers).
  On a phone: the account list first, then the account.
- [x] 4.2 "Hazır paketler": versions waiting for a time (read-only; the agent schedules).
- [x] 4.3 Ayarlar: posting limits (existing `PostsSettings`), per-account "Paylaşımı duraklat".
- [x] 4.4 Bugün, Plan, the slot editor, Haftalık özet and the lane approval switch are removed;
  the TikTok posting screen opens from the home feed item "TikTok paylaşımını tamamla" and from
  the account's upcoming post.
- [x] 4.5 Tests; `tsc` and vitest green.

### Task 5: documents, whole-step verification, proof

- [x] 5.1 README: the module, the use cases, the table, migrations 0037 and 0038.
- [x] 5.2 Whole step: clippy, full Rust tests, panel tests, visual check.
- [ ] 5.3 Proof on the separate local database: an area's package is scheduled by a connected
  agent and appears under its account's "Sıradaki paylaşımlar". **Not done, and not possible
  without a real connected account** (see the execution log, 2026-11-11): the server offers a
  version only to an account with a sealed credential, and a credential is sealed only by a real
  connect. The flow is the tests' (`social_schedule`, `social_accounts`, the twin parity suite).

## Execution log

- 2026-11-10 Task 4 done by Codex (T079): accounts screen, waiting packages, per-account pause,
  TikTok routing; 78 panel test files / 579 tests green; checked at desktop and 390. The four
  unreferenced Step 0 files (`StudioToday`, `StudioPlan`, `PostsPlan`, `LaneSettings`) were
  removed by the coordinator afterwards (`tsc` clean).
- Added to the contract after the panel task: an upcoming post that waits for a person says why
  in `waits_for` (`"tiktok_screen"` or `"approval"`, else null). `"approval"` is a connection
  whose own flag asks for approval (B35): its row needs an "Onayla" action calling
  `studio.approve`. The panel part is in the final polish task.

- 2026-11-10 Tasks 1–3 and 5.1 done by Claude in the main session (the owner withdrew the Codex
  hand-off rule the same day). What differs from the plan above, and why:
  - **Names.** `social.versions_waiting` (not `packages_waiting`): the architecture rule that keeps
    "package" out of operation names (design B46).
  - **Snapshots.** No job of its own: `studio_measure` (every 6 hours) also reads each live social
    account's day once (`social::accounts::read_days`). The snapshot's account is the same
    workspace's by a composite foreign key. A published post's title is what its attempt sent.
  - **0038.** The up records what it moved in `studio_control.lane_approval_moved` (the lanes that
    were on, the connections it flagged), so the down is exact: it puts the lane's switch back and
    clears only the flags the migration set. A lane that was on with no connection yet has nowhere
    to move to: a connection made later starts without the flag.
  - **Scheduling at the provider** is not what the section above describes; design B47 records the
    decisions. It is a workspace setting, **off by default** (`PostingSettings.provider_scheduling`,
    column on `studio_posting_policy`, migration 0037), because nothing here ran against a real
    Page. The port is `schedule_window(public, request)`, `schedule`, `scheduled` (waiting /
    published / gone; `resolve` is left to background publishers) and `withdraw`. A hold is the
    slot's one attempt, made early (`claim_publication_held`, `PublishAttempt::held_until`); the
    engine's rule that a slot is attempted once did not change, so a withdrawn post is cancelled and
    its version waits for a time again instead of the slot being re-armed. A person's "Olmamış" or
    cancel takes the post back first and is refused if the platform does not confirm
    (`withdraw_unconfirmed`). A post nearer than two minutes to its time is not taken back, and a
    post that is out is never deleted. Meta: text, link and single-photo Page posts, 15 minutes to
    29 days ahead.
  - **Panel.** The approval a connection asks for is given from the account's upcoming post and
    from the home feed item (`/social?slot=…`, "Onayla"); a held post says "Tutuluyor"; Ayarlar has
    the scheduler switch.
  - **Verification so far.** `cargo clippy --locked --workspace --all-targets -- -D warnings` clean;
    the suites touched pass (migrations 39, social_accounts 6, social_schedule 5, studio_hold 9,
    jt_meta studio_publish 7, jt_pg studio_publish 6, studio_rules 13, twin_parity incl. the social
    twins); panel `tsc` clean, social/posts/home suites 43 passed. The whole Rust suite and the whole
    panel suite run once more at the end of Step 3. Proof 5.3 (a scheduled version under its
    account's "Sıradaki paylaşımlar") needs a connected social account: the proof database has none,
    so it is shown by the tests, not on screen.

- 2026-11-11 Proof attempt for 5.3 on the real binary (127.0.0.1:8090, database `jeeta_modules`).
  An Instagram account was declared through the API and marked connected directly in that
  throwaway database, with no credential. Result: `jeeta.social.accounts_list` lists it, and
  `jeeta.social.versions_waiting` offers the finished package's version to **no** account, and
  `work.pending` carries no `social_schedule` item: the channel rule fails closed on a
  connection without a sealed credential (`chain::capability_access`). That is the designed
  behaviour, and it means a post cannot be scheduled on the real binary without a real connect
  (the Graph address is not configurable, and nothing but a connect seals a credential). The
  owner's first real connect is where this is seen end to end.

- 2026-11-11 Whole-step verification, run once for all four steps on the final tree: clippy clean, `cargo fmt --check` clean, whole Rust suite 387 targets / 4,149 tests passed, 0 failed (`--skip production_build`, see the Step 0 log); panel `tsc` clean, 81 test files / 655 tests passed; `design-review/modules.cjs` 23 scenarios at 1440 and 390 (46 runs): no overflow, no page error, no unanswered request.

- 2026-11-11 What the attempt above led to (design B53). Reading why no account was offered
  showed a dead end that a real connect would not have lifted: the posting engine plans a post
  only for a hypothesis with an organic cadence, and neither the panel nor the consultation asks
  for one, so a strategy written the usual way posted nothing and said nothing. Now:
  `strategy.submit` gives such a hypothesis the default organic cadence when the strategy posts;
  a version's content type is a label, not a condition; a waiting version no account can take
  says why (`blocked`) to the agent and in "Hazır paketler"; the social status line says when no
  hypothesis of the strategy posts. Proof 5.3 at test level:
  `jt_meta/tests/social_post_flow.rs` runs the use cases on the real Meta adapter against the
  Graph mock, from a strategy written through the consultation's own use cases to the post on
  the Page and its place under the account's posts. On the real binary it still needs a real
  connect.

- 2026-11-11 On the real binary (127.0.0.1:8090, `jeeta_modules`, rebuilt): the strategy in force
  had a hypothesis with `cadence: {}`; a new consultation, submitted, carries
  `organic {slots_per_week: 3, content_types: [general]}` and was approved; the agent's
  `jeeta.social.versions_waiting` answers the finished version with `accounts: []` and
  `blocked: "no_connected_account"`, and "Hazır paketler" says so in words. (The accounts of that
  database have no credential; with a real connect the version would be offered to its account,
  as `social_post_flow.rs` shows.)

- 2026-11-11 **First real run, on staging (release `4cafc3b6`), with the owner's own Meta
  account** (the workspace is the staging demo; the owner connected a real Facebook Page). What
  was seen signed in, as the connected agent over MCP:
  - Connecting Meta works: the Page and its ad accounts came in verified and probe against Meta.
  - Resubmitting the strategy gave its three hypotheses the default organic cadence (B53).
  - With a Page connected the system opened an area by itself ("no post on this account yet").
    The agent took it; its first delivery was refused because the image had never been analysed
    (`quality` finding), which is the rule; after the agent analysed the image the package was
    accepted and its version waited with the Page as its account.
  - The owner turned on "Platformun kendi zamanlayıcısını kullan" (a person's setting; an agent
    cannot). The agent scheduled the version two days ahead; within two minutes the publish job
    handed it to Facebook's scheduler: the first real write to Meta. **Facebook accepted
    `POST /{page}/photos` with `scheduled_publish_time` and answered without a `post_id`**: the
    outcome was recorded as unknown (`studio.publish.failure`, "accepted response lacks post
    id"), so a scheduled post may exist on the Page that Jeeta cannot follow or take back. The
    owner checks the Page's scheduled posts by hand.
  - Fixed after it: the single-photo post is left in Meta's documented two calls (B56); an
    agent's cancel of an untouched planned version lets it be given another time, and a version
    can be planned again at all (B57: it could not, even after the system's own withdrawal).
  - Also seen: a feed post cannot be scheduled nearer than its preparation lead (24 hours by
    default, `lead_too_short`), so the nearest test time is a day ahead; MCP sessions on staging
    answer 404 after a few idle minutes and the client must initialise again.
  Box 5.3 stays open: the two-call hand-over and a withdrawal have not yet been seen on the Page.
