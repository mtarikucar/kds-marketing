# Step 3 — Bütçe ve reklam yönetimi (budget and advertising): Implementation Plan

> **Who does the work:** Claude, in the main session, itself. The repository's Codex hand-off
> rule was withdrawn by the owner on 2026-11-10 and nothing is handed to Codex. The few tasks
> Codex did before that are named in the execution log at the end. Steps use checkbox
> (`- [ ]`) syntax. The tree is shared with another session; nobody commits unless the owner asks.

**Goal:** From a goal and a budget to a running ad that an agent watches and improves, with money
that can never pass its limits, and one place (Bütçe) where every module's spend is seen and
stopped.

**Architecture:** An ad campaign is a new tenant record (`ads_campaigns`) with the same shape as
a production area: who opened it, an agent's claim, a plan, what was built at the provider, what
the agent changed, daily results. The agent only decides: it delivers one structured plan; Jeeta
validates it, reserves the whole campaign budget against every cap, and builds the campaign at
the provider itself, paused first, with the platform's hard total budget. The first provider is
Meta. Bütçe gains one general ad budget, the breakdown of spend by module and campaign, and the
stop switches; the Studio brake moves there.

**Tech Stack:** Rust 1.96 (`jt_app`, `jt_pg`, `jt_mcp`, `jt_panel_http`, `jt_meta`, `jt_testkit`),
sqlx migrations, React 18 + TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-uc-modul-ve-panel-iskeleti-design.md` §5.4, §8, §9,
Ek B.3. Earlier steps' plans in this directory.

## Global Constraints

- No write that would pass a limit reaches a provider (P4): campaign budget, the general ad
  budget's remainder in its period, the strategy's paid cap, the connection's own caps. All are
  checked in one transaction before the write, as `reserve_connector_spend` does today.
- A campaign's budget is written to the provider as its **total (lifetime) budget**, never as a
  daily budget alone (B32); a total budget needs an end time.
- A campaign a person opened starts without approval (S20); one the system proposes spends
  nothing until a person approves it (S24); an unapproved proposal closes after 7 days (B16).
- Jeeta builds the campaign through its own connector (B11); every object is created paused and
  activated only after the reservation holds.
- Material share permission and the truth check apply to ad texts and media as to posts (B10).
- A plan that declares a special ad category is refused in this version (B33).
- The ad account's currency equals the general ad budget's currency; no conversion (B24).
- The lead-form result is offered only while the inbox is installed (B25).
- Stopping stops spending only (B36): nothing that costs no money stops.
- The existing "bind an ad set created elsewhere" keeps working (B26).
- Reversible migrations; FORCE RLS on the new table; every panel operation has an MCP twin
  except a person's decisions (open, approve, decline, resume, end, budget change, stop switches).
- On screen the unit is "reklam kampanyası" (B27): a module called "Kampanyalar" already exists.
- No real provider call in tests: the scripted connector and recorded request/response shapes.
- Shared tree: small targeted edits; never `cargo fmt --all`; i18n keys line by line; no commits.
- Exact counts after Step 2: 277 catalog rows, 234 MCP tools, 102 tables, 38 migrations. This
  step's rows, tools and migrations are fixed by its tasks; each task states its own delta and the
  whole-step verification states the totals.

## Part A — Bütçe

### The general ad budget (B37)

- `budget_items` gains `general boolean not null default false` (migration 0039) with a partial
  unique index: at most one live (`retired_at is null`) general item per workspace; a general item
  is of kind `ad_budget` with a currency unit and a period that is not `total`.
- `budget.create_item` / `update_item` accept `general`. Its cap may not exceed the approved
  strategy's paid cap for the same period and currency (compared after bringing both to the
  budget item's period: daily × 7 = weekly, daily × 30 = monthly); refused with
  `details: {"reason": "above_strategy_cap", "cap": …}`.
- It is not linked to capabilities: every reservation of the paid lane counts against it, whatever
  the ad account.
- Migration 0039 backfill: a workspace with exactly one live `ad_budget` item in a currency unit
  and a non-total period gets it marked general; otherwise none is marked. Down: clears the flag,
  drops the index and the column.

### Spend by module, and the stop switches (S6, S7, B36)

- A spend entry's `source` (jsonb, already there) carries `"module"` (`ads`, `inbox`, `outreach`,
  `calls`, `social`) and, for ads, `"campaign_id"`. Every place that writes a spend entry or a
  reservation names its module.
- `budget.breakdown` (twin, `GET /api/budget/breakdown?from=&until=`, `budget.manage` or any
  module's `.work`): for each budget item, spend by module and, for `ads`, by campaign.
- The workspace control gains `spend_stopped: { all: bool, modules: set }` (stored in the control
  document; never derived). `reserve_connector_spend` refuses with `reason: "spend_stopped"` when
  `all` is set or the reservation's module is in the set.
- `budget.stop` (panel-only, `POST /api/budget/stop`, `budget.manage`, a human)
  `{scope: "all" | {"module": "<id>"}, stopped: bool, expected_revision}` → the stop state.
  Stopping `ads` engages the paid lane's brake (the existing mechanism: bound ad sets and, from
  Task 4 on, campaigns are paused at their provider by the reconciliation and resumed when it is
  released); stopping another module (`inbox`, `outreach`, `calls`, `social`) puts it in
  `spend_stopped.modules`; stopping `all` sets `spend_stopped.all` and engages the paid lane's
  brake. Releasing reverses exactly that.
- The stop state (`budget.breakdown` returns it): `{revision, all, modules, paused: [{module,
  title, state: "paused" | "pausing"}]}`; `modules` lists `ads` while the paid lane's brake is
  engaged; `paused` names each ad set or campaign with whether its provider confirmed the pause.
- `studio.brake` stays as the lane-level operation (an agent may stop what runs): the organic
  lane's brake is the social settings' "pause every account", the paid lane's is what
  `budget.stop` uses. The workspace-wide flag of the old "Acil fren" is no longer set by anything:
  migration 0040 turns a stored one into `spend_stopped.all` plus both lane brakes and clears it;
  its down sets it again where all three are set and clears them.

## Part B — Reklam yönetimi

### The campaign

```rust
// jt_ads (new domain crate) / jt_app::ports::ads
pub struct AdCampaign {
    pub id: AdCampaignId, pub workspace_id: WorkspaceId, pub revision: u64,
    pub title: String, pub goal: String,
    pub budget_minor: i64, pub currency: String,           // the campaign budget: a total
    pub start_at: OffsetDateTime, pub end_at: Option<OffsetDateTime>,
    pub account_hint: Option<CapabilityId>,                // the ad account, when the person chose
    pub opened_by: CampaignOpenedBy,                       // Human { user } | System { agent }
    pub approval: Option<Approval>,                        // who approved a system proposal, when
    pub claim: Option<Claim>, pub refused: u8,
    pub plan: Option<CampaignPlan>, pub built: Option<Built>,
    pub moves: Vec<Move>, pub stop: Option<Stop>,
    pub ended: Option<Ended>, pub created_at: OffsetDateTime, pub updated_at: OffsetDateTime,
}
pub enum CampaignState { Proposed, Queued, Planning, Building, InReview, Live, Paused, Rejected,
                         Ended, Held, Expired, Declined }
```

State, first match wins: `ended` → Ended; declined → Declined; a proposal without approval:
older than 7 days → Expired, else Proposed; `refused >= 3` → Held; `stop` → Paused; `built`:
every ad active → Live, any ad disapproved → Rejected, else InReview (before activation:
Building); a live claim → Planning; otherwise Queued. An agent is needed when the state is Queued
or Rejected and `start_at <= now`.

`CampaignPlan` (what the agent delivers; closed schema, unknown fields refused):

```json
{
  "ad_account": "<capability id>",
  "result": "link_click" | "lead_form",
  "destination": {"kind": "website", "url": "https://…"}
               | {"kind": "lead_form", "page": "<capability id>", "name": "…",
                  "questions": ["FULL_NAME", "EMAIL", "PHONE"],
                  "privacy_policy_url": "https://…", "thank_you_url": "https://…"},
  "special_ad_categories": [],
  "audience": {"countries": ["TR"], "regions": [], "cities": [], "age_min": 18, "age_max": 65,
               "genders": [], "interests": [{"id": "…", "name": "…"}], "broad": true},
  "placements": "automatic" | {"platforms": ["facebook", "instagram"]},
  "end_at": "…",
  "ads": [{"name": "…", "material_ids": ["…"], "primary_text": "…", "headline": "…",
           "description": null, "call_to_action": "LEARN_MORE", "page": "<capability id>",
           "instagram": "<capability id or null>", "hypothesis_id": "…"}],
  "summary": "…", "audience_summary": "…"
}
```

Validation, all or nothing, each refusal naming the field: the ad account is a live `meta_ads`
capability whose currency is the campaign's; `page` (and `instagram`) are live capabilities in
the ad account's capability group; 1–6 ads, each with 1 image material (this version) that is
live and may be shared, texts within the provider's limits and passing the truth check;
`special_ad_categories` empty; `end_at` after `start_at` by 24 hours to 90 days (the campaign's
own `end_at`, when the person set one, wins and must equal it); the budget is at least the
account's minimum daily budget times the number of days; `lead_form` only while the inbox is
installed; URLs are `https`; `hypothesis_id` is a paid-lane hypothesis of the approved strategy.

### Use cases (`ads.*`, module `ads`)

| Use case | Kind | Route / tool | Permission | Strategy |
|---|---|---|---|---|
| `ads.campaigns_list` | twin | `GET /api/ads/campaigns` | `ads.work` | exempt |
| `ads.campaign_get` | twin | `GET /api/ads/campaigns/{id}` | `ads.work` | exempt |
| `ads.campaign_open` | panel-only | `POST /api/ads/campaigns` | `ads.manage`, a human | exempt |
| `ads.campaign_propose` | MCP-only | `jeeta.ads.campaign_propose` | `ads.work`, an agent | gated |
| `ads.campaign_approve` | panel-only | `POST /api/ads/campaigns/{id}/approve` | `ads.manage`, a human | gated |
| `ads.campaign_decline` | panel-only | `POST /api/ads/campaigns/{id}/decline` | `ads.manage`, a human | exempt |
| `ads.campaign_claim` | twin | `POST /api/ads/campaigns/{id}/claim` | `ads.work` | exempt |
| `ads.campaign_release` | twin | `POST /api/ads/campaigns/{id}/release` | `ads.work` | exempt |
| `ads.plan_submit` | twin | `POST /api/ads/campaigns/{id}/plan` | `ads.work` | gated |
| `ads.campaign_move` | twin | `POST /api/ads/campaigns/{id}/moves` | `ads.work` | gated |
| `ads.campaign_pause` | twin | `POST /api/ads/campaigns/{id}/pause` | `ads.work` | exempt |
| `ads.campaign_resume` | panel-only | `POST /api/ads/campaigns/{id}/resume` | `ads.manage`, a human | gated |
| `ads.campaign_end` | panel-only | `POST /api/ads/campaigns/{id}/end` | `ads.manage`, a human | exempt |
| `ads.campaign_update` | panel-only | `PATCH /api/ads/campaigns/{id}` | `ads.manage`, a human | gated |
| `ads.ad_preview` | twin | `GET /api/ads/campaigns/{id}/ads/{index}/preview?placement=` | `ads.work` | exempt |

- `campaign_open` `{request_key, goal, budget_minor, start_at, title?, account?, end_at?}`: the
  currency is the general ad budget's; refused without a general ad budget, without a paid lane
  in the approved strategy, or when `budget_minor` exceeds what the general budget has left in
  its current period.
- `campaign_propose` `{request_key, goal, budget_minor, start_at, end_at?, reason}`: at most one
  open proposal per week per workspace (a setting, default 1); lists in the home feed as
  `ads_campaign_proposal`. `approve` makes it Queued; `decline` (a reason) closes it.
- `plan_submit` `{claim_token, request_key, plan}`: validates; reserves the campaign's whole
  budget for the paid lane (module `ads`, this campaign) against every cap; stores the plan;
  starts the build. A refusal counts in `refused` and answers what to fix.
- **Build** (deterministic, resumable, never twice): each provider object is created with a name
  that contains the campaign's id and its part (`jeeta:<campaign id>:campaign`, `:adset`,
  `:ad:<n>`), recorded with its provider id before the next step; after an answer that was lost,
  the object is looked up by that name and adopted, never created again. Order: campaign (paused,
  campaign-level total budget, lowest-cost bidding, no special category) → ad set (audience,
  placements, the result's optimisation, start and end) → for each ad: image upload, creative,
  ad (paused) → for a lead form: the form first → activation of campaign, ad set and ads. A step
  the provider refuses for good ends the build with the provider's reason; what was created stays
  paused and is named in the campaign for a person to see.
- **Watching** (job `ads_campaigns`, hourly, per workspace with `ads` installed): reads each
  built campaign's state and review feedback, and its daily numbers (spend, impressions, clicks,
  results) per ad; writes actual spend entries (module `ads`, the campaign); ends a campaign whose
  end time passed or whose budget is spent; pauses every campaign when the general ad budget's
  period is exhausted and resumes them in the next period (B31).
- **Improving.** Work item `ads_campaign_review` once a day for each Live campaign. Moves:
  `{"kind":"pause_ad","ad":n,"reason":"…"}`, `{"kind":"resume_ad","ad":n,"reason":"…"}`,
  `{"kind":"add_ad","ad":{…},"reason":"…"}` (validated as in a plan; at most 6 ads),
  `{"kind":"fix_ad","ad":n,"with":{…},"reason":"…"}` (after a rejection),
  `{"kind":"none","reason":"…"}`. Each is recorded with its reason and outcome and shown on the
  campaign page. The campaign's budget and end date change only through `campaign_update`.
- **Results.** Daily rows per ad in `ads_campaigns`' sibling data (`results` array in the
  campaign document, one entry per ad per day); measurements for the strategy's learning are
  written through the existing measurement records with the ad's hypothesis.
- **Work items:** `ads_campaign_plan` (agent; Queued or Rejected and due),
  `ads_campaign_review` (agent; Live, once a day), `ads_campaign_proposal` (human, `ads.manage`),
  `ads_campaign_held` (human).

### Connector port (`jt_app::ports::connectors::AdCampaignWriter`, implemented by `jt_meta`)

```rust
async fn account_limits(&self, cred, public) -> Result<AdAccountLimits, ConnectorError>;
    // currency, minor_unit_exponent, timezone, min_daily_budget_minor
async fn find_by_name(&self, cred, account: &str, level: AdLevel, name: &str)
    -> Result<Option<String>, ConnectorError>;
async fn create_campaign(&self, cred, account: &str, spec: &CampaignSpec) -> Result<String, ConnectorError>;
async fn create_adset(&self, cred, account: &str, spec: &AdSetSpec) -> Result<String, ConnectorError>;
async fn upload_image(&self, cred, account: &str, bytes: &[u8], name: &str) -> Result<String, ConnectorError>;
async fn create_lead_form(&self, page_cred, page_id: &str, spec: &LeadFormSpec) -> Result<String, ConnectorError>;
async fn create_creative(&self, cred, account: &str, spec: &CreativeSpec) -> Result<String, ConnectorError>;
async fn create_ad(&self, cred, account: &str, spec: &AdSpec) -> Result<String, ConnectorError>;
async fn campaign_state(&self, cred, campaign_id: &str) -> Result<CampaignProviderState, ConnectorError>;
async fn ad_days(&self, cred, campaign_id: &str, since: Date, until: Date) -> Result<Vec<AdDay>, ConnectorError>;
async fn preview(&self, cred, account: &str, creative: &CreativeSpec, placement: AdPlacement)
    -> Result<String, ConnectorError>;      // the provider's own preview frame (HTML), short-lived
```

`set_status` (exists) activates and pauses. Meta specifics are in design Ek B.3: API version
v27.0, `OUTCOME_TRAFFIC` / `OUTCOME_LEADS`, `special_ad_categories: []`, campaign `lifetime_budget`
with `bid_strategy: LOWEST_COST_WITHOUT_CAP`, ad set `optimization_goal` `LINK_CLICKS` /
`LEAD_GENERATION` with `billing_event: IMPRESSIONS`, `destination_type: ON_AD` and
`promoted_object.page_id` for lead forms, `targeting.geo_locations`, `targeting_automation.
advantage_audience`, `dsa_payor` / `dsa_beneficiary` when an EU country is targeted (refused in
this version: `details.reason = "eu_targeting_needs_payer"`), `object_story_spec.link_data`,
`generatepreviews`. Writes are throttled to the limited tier (three points each, sixty per
account, five-minute decay).

## Review Focus

1. The answer to "create campaign" is lost: the retry finds the campaign by its name and goes on;
   the provider holds one campaign.
2. Two plans for one campaign arrive together: one build.
3. The general ad budget has 1.000 left and two campaigns of 600 are opened at once: one is
   refused.
4. A campaign is stopped in Bütçe while its build is half way: nothing is activated; released:
   the build goes on from where it was.
5. A proposal is approved on its eighth day: refused (it expired).
6. The provider disapproves one of three ads: the campaign is Rejected for the agent, the other
   two keep running, the fix replaces only that ad.

---

### Task 1: Bütçe — general ad budget, module attribution, stop switches

Migrations 0039, 0040; `usecases/budget.rs`, `usecases/studio/{budget,control}.rs`, spend
writers in inbox, outreach and calls (module name only), `jt_pg` budget repo, fakes, catalog
(+`budget.breakdown` twin, +`budget.stop` panel-only), tests.

### Task 2: the campaign record and the people's side

New crate `rust/crates/domain/jt_ads` (types, state rule, plan validation that needs no I/O),
`jt_app/src/ports/ads.rs`, `usecases/ads/{mod,campaigns}.rs`, migration 0041 (`ads_campaigns`,
FORCE RLS, mirrored `start_at`, `state_hint`), `jt_pg` repo, fake, catalog rows for list, get,
open, propose, approve, decline, pause, resume, end, update; work items for proposals and held
campaigns; tests (Review Focus 3, 5).

### Task 3: the connector — Meta campaign building

`jt_app/src/ports/connectors.rs` (`AdCampaignWriter`), `jt_meta/src/campaigns.rs` (new) with
request and response shapes tested against recorded fixtures, scripted connector support in
`jt_testkit`. `review: security`.

### Task 4: plan, build, watching, moves

`usecases/ads/{plan,build,watch,moves}.rs`, job `ads_campaigns`, claim / release / plan_submit /
campaign_move / ad_preview rows, work items for plan and review, reservations with module and
campaign, spend entries, measurements; tests (Review Focus 1, 2, 4, 6). `review: security`.

### Task 5: panel — Reklam yönetimi and Bütçe

`rust/panel/src/pages/ads/**`, `pages/BudgetPage.tsx`, `api/ads.ts`, `api/budget.ts`, home feed
items, i18n, tests. Independent of Tasks 1–4 (fixtures).

- `/ads`: the general ad budget strip (spent / cap, link to Bütçe), platform filter, the campaign
  queue (title, platforms, spent / budget bar, result and cost per result, state), "Reklam
  kampanyası aç" (goal, campaign budget with the general budget's remainder under it, start time;
  optional ad account and end date).
- `/ads?campaign=<id>`: the ads in the provider's preview frame (sandboxed `iframe` of the
  returned HTML) with a placement choice, the audience sentence, spent and results per day, the
  agent's moves with reasons, "Kampanyayı durdur" / "Sürdür" / "Bitir", budget and end date.
  A proposal shows the same with "Onayla" / "Reddet" and what it would cost.
- `/budget`: under each item the spend by module and campaign; "Durdurma": all spending, one
  module's spending, with what is paused and what is still waiting for the provider.
- Home: `ads_campaign_proposal` (approve from the campaign page), `ads_campaign_held`.

### Task 6: documents, whole-step verification, proof

README (modules, use cases, tables, migrations, the K12 rule lifted), `no_paid_creation_api`
replaced by a rule that only `usecases/ads/build.rs` calls the creation port; clippy, full tests,
panel tests, visual check; proof on the separate local database with the scripted provider (a
person opens a campaign, a connected agent plans it, the build completes, numbers arrive, a stop
in Bütçe pauses it). The real Meta run waits for the owner (B38).

## Execution log

- 2026-11-10/11 Tasks 1, 2, 4 and 6 (documents) done by Claude in the main session (the Codex
  hand-off rule was withdrawn); Task 3 (the Meta connector, `jt_meta/src/campaigns.rs`, 22 tests)
  and Task 5 (the panel) were already in the tree and were verified and aligned. What differs from
  the plan above, and why (design B48–B50):
  - **Migrations.** `0039_general_ad_budget` (the flag, its rule and index, and `module` /
    `campaign_id` on spend entries) and `0040_ads_campaigns` (the table). No migration turns the
    workspace-wide brake into something else: `studio.brake` keeps it (an agent may stop what
    runs), Bütçe reads it as "all stopped", and "let all go on" releases it.
  - **Attribution.** A spend entry and a reservation name their module. The inbox names
    `outreach` for a campaign's step or test and `inbox` for anything else; a first message from
    the prospect pool goes out through the inbox's send path and counts under `inbox` (agreed with
    the session that owns that code; it can add a mark if the owner wants them apart).
  - **Stop.** `spend_stopped {all, modules}` on the control; `ads` is the paid lane's brake. The
    spend gate refuses a stopped module; a call is refused before it is placed.
  - **The campaign record** lives in `jt_app::ports::ads` (no new crate). A campaign's
    commitment is the campaign itself (its unspent budget), not a reservation row: every gate that
    could spend on ads sums the open campaigns (`ads::check_money`, and the bound ad sets' own gate).
    Against the strategy's paid cap the whole unspent budget is counted in the current period:
    conservative, never over.
  - **Not in this version:** changing a built campaign's budget or end (`already_built`: end it
    and open another); results as learning measurements; a name lookup for lead forms (a lost
    answer can leave a second, unused form; a form costs nothing).
  - **Watching** is part of the `studio_control` job, not a job of its own; the provider is read
    once an hour per built campaign.
  - **Counts now:** 295 catalog rows, 244 MCP tools, 103 tables, 40 migrations.
  - **Verification so far:** `ads_campaigns` 9 tests (the six Review Focus cases among them),
    `budget_general` 3, the store contract on the fake and PostgreSQL, migrations 41, the registry
    and architecture suites (a new rule: only `ads/build.rs` creates at the ad platform, and what
    commits money asks `check_money`), clippy clean; panel `tsc` clean, ads/budget/home suites
    pass. The whole Rust suite and the whole panel suite run at the end of the step.
  - **Proof.** With no ad account on the proof database the real binary cannot build a
    campaign; the build, the watch and the stop are shown by the tests with the scripted provider.
    The real Meta run waits for the owner (B38).

- 2026-11-11 Read-through by Claude of what Codex had written (the Meta campaign connector, the
  ads and budget panel pages, the visual review script), line by line, and of the watch around
  them. Found and fixed (design B51):
  - **Connector.** Daily numbers counted a `lead` action as the result of any campaign: now only
    the campaign's own result kind (`lead` for a form campaign, `link_click` for a site
    campaign). A broad (Advantage+) audience was sent with an upper age, which Meta refuses:
    now sent without one, and a plan with a broad audience outside 18–25 / 65 is refused as
    malformed before anything is built.
  - **An ended campaign whose pause the provider did not confirm was never tried again**, its
    budget was free at once, and the spend between the last hourly read and the end was never
    read. Now: the watch follows a campaign that is over until the provider confirms the pause
    (`AdsRepo::list_winding_down`), its unspent budget stays held until then
    (`provider_still_running`), and it is read hourly for 48 hours after its end.
  - **Removing the ads module left running campaigns unwatched at the provider**: they are now
    paused there (`module_removed`) and go on when the module is installed again.
  - **Panel.** The campaign pages mapped refusals the server never sends (`no_ad_budget`,
    `above_remaining`, `remaining_minor`): they now map the real ones (`no_general_ad_budget`,
    `no_paid_lane`, `spend_stopped`, `above_general_budget` / `above_strategy_cap` /
    `above_account_cap` with `left`, and the state refusals). "Change budget and end date" is
    offered only before the build; "resume" is not offered while the budget holds the campaign;
    an end is confirmed first; the end date rule (24 hours to 90 days) is checked before
    sending; the remaining general budget subtracts what open campaigns hold; who stopped a
    campaign and why it ended are said in words, not codes. Bütçe: "all spending" no longer
    reads "waiting" while it is not stopped; the breakdown is read once a minute, not every 15
    seconds. İçerik: one outage shows one error with one retry, not two.
  - **Visual review script** (`design-review/modules.cjs`) had never run: it lacked three
    fixture answers. 36 scenario runs (18 scenarios at 1440 and 390) pass: no overflow, no page
    error, no unanswered request.
  - **Known limit, recorded in the README:** the watch runs for active workspaces only; in a
    suspended workspace only the provider's own limits hold the spend.
  - **Proof on the real binary** (separate server 127.0.0.1:8090, throwaway database
    `jeeta_modules`, migrations 0037–0040 applied by the binary itself; an ad account and a
    Facebook Page declared through the API and marked connected in that database, without a
    credential, so nothing can reach the ad platform). Seen over the panel's API and MCP:
    opening is refused without a general ad budget (`no_general_ad_budget`); a person opens a
    campaign with no approval; the same request key answers the same campaign; a second one
    that does not fit is refused with what is left (`above_general_budget`, `left`); stopping
    ad spending in Bütçe refuses opening (`spend_stopped`) and letting it go on allows it; the
    agent sees `ads_campaign_plan` in its work, proposes a campaign (a second proposal the same
    week is `proposal_limit`), has no tool to approve, resume, end or open; the person
    approves; the agent claims and delivers a plan: a broad audience with a narrow age range
    is `VALIDATION`, a well-formed plan is refused with its findings (no usable ad account, an
    EU country); the agent stops the campaign with why, only a person lets it go on; the budget
    of an unbuilt campaign changes; ending a campaign frees what it held. What it showed and
    was fixed: the ads status line said the strategy does not allow ad spending although the
    server allowed it (the panel asked for an ads channel in the strategy, the server asks for
    a paid lane); the campaign page said nothing of a refused plan (it now lists the findings,
    in words where a person can act); Bütçe did not say what open campaigns hold of the
    general ad budget (`held_minor` in `budget.breakdown`, shown on the page). A build, a watch
    and a provider pause cannot be shown without a real ad account: they are the tests' with
    the scripted provider, and the first real run is the owner's (B38).
  - **Home feed.** The log on the home page showed the three modules' records as raw codes
    under "Çalışma alanı" (`ads.campaign.opened`, `content.package.delivered`, `budget.stop`):
    `home/agenda.ts::ledgerModule` now attributes `content.*`, `social.*` and `ads.*` to their
    modules, and `home/copy.ts` words them in Turkish and English (a marked block at the end of
    each table; the file is the other session's, which confirmed it had no pending change).

  - 2026-11-11 **Whole-step verification**, run once for all four steps on the final tree: clippy clean, `cargo fmt --check` clean, whole Rust suite 387 targets / 4,149 tests passed, 0 failed (`--skip production_build`, see the Step 0 log); panel `tsc` clean, 81 test files / 655 tests passed; `design-review/modules.cjs` 23 scenarios at 1440 and 390 (46 runs): no overflow, no page error, no unanswered request.
  - **After the first report (2026-11-11).** Campaigns of a workspace that is not active are
    paused at the provider by the control job and go on when it is active again (B52; it had been
    listed as a known limit). `jt_meta/tests/ad_campaign_flow.rs` runs a whole campaign through
    the use cases on the real Meta adapter against the Graph mock: opened, planned, built paused,
    switched on ad then ad set then campaign, read (spend into the general ad budget, only link
    clicks as results), stopped from Bütçe (paused at Meta), ended. The first real run is still
    the owner's (B38).
  - **Committed and published to staging (2026-11-11).** The four steps are on
    `design/jeeta-refinement` as `8fa83bde`, `1c3c7429`, `c7857483` and, with the files both
    sessions touched, `7891020b` (the other session's own work is `e10887eb`). CI run
    `42957581297` passed all nine jobs on `7891020b` (4,357 Rust tests, 655 panel tests).
    Staging release `7891020b`, schema 32 to 40, was published on 2026-11-11 at 04:33 UTC; its
    record is `ops/staging-7891020b.md` on `ops/release-dd66e8dc`. The commission tables were
    empty before migration 33 (`0|0|0`), so it removed no record. Checked from outside only: the
    35 published panel files match the artifact, readiness, eight routes, 401 without a session.
    Nothing was tried signed in on staging. What stays open is what needs the owner's real
    account: the first ad campaign built at Meta and the first post left with Facebook's
    scheduler (B38; Step 2's proof box 5.3).
  - **The API version of the ad calls (2026-11-11, after the staging release).** This plan
    names Marketing API v27.0 for the campaign calls, but the adapter sent every call on its
    default `v19.0`, a version Meta no longer serves; Meta's versioning page says such a call
    "may fail or be upgraded to the next available version". Found while preparing the owner's
    first real run. Every call on an ad account (the account, its campaigns, ad sets, ads,
    creatives, previews, insights, lead forms; listing and probing ad accounts) now goes out on
    `v27.0` or on a newer version the Meta app names (B54, `jt_meta::ADS_API_VERSION`,
    `GraphApp::for_ads`). The other Meta calls are unchanged. Committed as `d0e0f893`; CI run
    `42962669127` passed all nine jobs. Published to staging on 2026-11-11 at 05:31 UTC as a
    release without a migration (record `ops/staging-d0e0f893.md` on `ops/release-dd66e8dc`);
    the operator script printed the serving binary as the candidate's. Tested against the Graph
    mock only: no call has been made to Meta on any version.
  - **What v27.0 changes for these calls (2026-11-11).** With the ad calls now on v27.0, the
    v26.0 and v27.0 changelogs were read against every field the campaign builder sends. Nothing
    breaks: `advantage_audience` is already sent explicitly (v26.0 made that an error
    otherwise), no placement position is sent (v26.0 removed two), and the "other mobile
    devices" default applies only to sales campaigns that target devices. One default would
    have changed what runs: from v27.0 Meta may add a Product showcase to a creative that says
    nothing about it, for an account with a catalog. Every creative Jeeta builds now declines it
    (B55), so the ad that runs is the one that was planned and checked. Source:
    `developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version27.0`
    and `/version26.0`. Committed as `fa2da400`; CI run `42967783601` passed all nine jobs;
    published to staging on 2026-11-11 at 06:14 UTC without a migration (record
    `ops/staging-fa2da400.md` on `ops/release-dd66e8dc`). Tested against the Graph mock only.
