# Leads and outreach — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** cover v1's lead and email features in the Rust stack before v1 is switched off: a prospect pool that
agents fill with evidence using their own tools, research tasks from the strategy's ICP, rule-based lead
distribution that never leaves a journey silently ownerless, plain-text email outreach (campaigns and sequences)
through the customer's own mailbox within fences, email attachments, reports, and the v1 import split between
inbox and pool.

**Architecture:** spec `docs/superpowers/specs/2026-10-30-leads-pool-outreach-design.md` (read it first; section
numbers below are its sections). Two new pure domain crates (`jt_prospects`, `jt_outreach`), additions to
`jt_inbox` (distribution choice, commercial basis, `OutreachSent`, `RecipientKind`, `Source::Prospect`),
`jt_strategy` (the `prospecting` section) and `jt_tenancy` (four permissions); use cases in `jt_app`; Postgres
repos and in-memory fakes with shared contract tests; four migrations `0020`–`0023`; MCP tools and panel routes
for 46 new twin rows; public unsubscribe and click routes in `jt_webhook::links`; five jobs; panel pages.

**Tech stack:** Rust (axum, sqlx/Postgres with FORCE RLS, tokio, lettre, mailparse), React panel (vitest).

**Global constraints (same as every Rust plan here):** hexagonal boundaries (`jt_archtest`); catalog rows,
handlers, permissions, status gates and exact-set tests change together (`crates/jt_app/tests/catalog.rs` pins
169 rows before this plan); migrations are repeatable `up`/`down` pairs, ENABLE + FORCE RLS on every tenant
table (`crates/jt_archtest/tests/sql_scoping.rs`); English identifiers, TR + EN panel copy with parity; `tracing`
never carries prospect values, addresses, phone numbers, message text, file names or file contents (counts and
ids only); ledger payloads carry ids, counts, reasons and field names, never values; no external API call of any
kind (owner rule 1: no new egress host, no provider adapter for research); no provider or legal fact in a code
comment without its source; the repo is public: fixtures use `example.invalid` addresses, `+90 5xx` numbers made
of zeros (`+905000000000`), and invented business names. Rust crates that depend on `jt_pg` do not build tests on
Windows: CI on Linux is the check; `jt_app` clippy locally needs `--features tokio/time`.

**Per-task loop:** write the named failing tests → run them (red) → implement → run the crate's tests (green) →
`cargo fmt --all -- --check` and `cargo clippy -p <crate> --all-targets -- -D warnings` → commit (message ends
with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Once per PR: `cargo test --locked --workspace` in
CI, `pnpm --dir panel test` when the panel is touched.

**Base and branches:** every task branches from the latest `origin/feat/rust-panel-money-inputs` and lands by PR
into it. Migrations are numbered 0020–0023 because 0018 (TikTok webhooks) and 0019 (inbox comments and
marketplace) are taken by parallel branches; if either lands after a task here, that branch renumbers nothing
(its numbers are lower) but the second to merge rebases the count pins (spec §7.3). Within this plan migrations
merge in number order: a phase that merges out of order (L6 may be built in parallel with L1) takes the next free
number when it merges, and the later ones shift with their pins.

**Renumbered (2026-11-04, spec D61).** This program's migrations are `0020_prospects`, `0026_outreach`, `0027_distribution` and (L6) `0028_mail_files`: the base merged `0023_oauth_flow` and `0024_whatsapp_erasure`, #394 holds `0021`/`0022` and #392 `0025`. The pins count versions 1..=18, 20, 23, 24, 26, 27 (and 25 once #392 merges). Text below written before that keeps the old numbers in places; the file names are the truth.

**Deploy hazards (L1 review, 2026-11-03).** (1) 0019 is `feat/inbox-comments-marketplace`'s. `jt_pg::recovery::
check_schema` refuses any applied migration the build does not embed, so a database that ran a build with 0020
refuses a build without it, and one that ran 0019 refuses a build without 0019: deploy this branch only from a
base that holds both 0019 and 0020, never from one branch's build to the other's. (2) The L1 review fixes amended
0020 in place (it had not merged): a database that applied the earlier 0020 (a local or staging run of this
branch) fails `check_schema` on its checksum. Revert it with 0020's down (it refuses while the blocklist holds
do-not-contact or erased entries) and apply it again, or recreate that database.

---

## File structure

| Path | New/changed | Responsibility |
|---|---|---|
| `rust/crates/domain/jt_prospects/src/{lib,ids,prospect,evidence,keys,status,score,brief,policy,playbook}.rs` | new | pool model, provenance, dedupe keys, status machine, score rules, research brief, retention policy, playbook text (pure) |
| `rust/crates/domain/jt_outreach/src/{lib,ids,template,footer,campaign,audience,enrollment,throttle,links,fence,report}.rs` | new | templates and rendering, footer, campaign and enrollment state, throttles and warm-up, link rewriting, outreach fence (pure) |
| `rust/crates/domain/jt_inbox/src/{person,consent,fence,journey,distribution,ids}.rs` | changed/new | `RecipientKind`, `Source::Prospect`, `commercial_basis`, `OutreachSent`, distribution `choose` |
| `rust/crates/domain/jt_strategy/src/{sections,rules,parse}.rs` | changed | `prospecting` section |
| `rust/crates/domain/jt_tenancy/src/role.rs` | changed | four permissions |
| `rust/crates/jt_app/src/ports/{prospects,distribution,outreach,mail_files}.rs`, `ports/{mod,connectors}.rs` | new/changed | repos, `TenantRepos` accessors, `LeadsPolicy`, `PolledMail`, `MailMessage` fields, `ConsentSync::search` |
| `rust/crates/jt_app/src/usecases/prospects/*.rs`, `research.rs`, `distribution.rs`, `hours.rs`, `outreach/*.rs`, `inbox/attachments.rs` | new | use cases and job bodies |
| `rust/crates/jt_app/src/usecases/{inbox/*,strategy,work,jobs,v1_import,calls}.rs` | changed | hooks and changes of spec §6.3 |
| `rust/crates/jt_app/src/catalog.rs` | changed | 46 rows (spec §7.1) |
| `rust/crates/adapters/jt_pg/src/repos/{prospects,research,distribution}.rs`, `repos/outreach/*.rs`, `repos/inbox/mail_files.rs` | new | Postgres impls |
| `rust/crates/jt_testkit/src/fakes/{prospects,distribution,outreach,mail_files}.rs`, `src/{prospects,distribution,outreach,mail_files}_contract.rs` | new | fakes and contract tests |
| `rust/migrations/0020_prospects.{up,down}.sql` … `0028_mail_files.{up,down}.sql` | new | spec §4 |
| `rust/crates/adapters/jt_mcp/src/tools/{prospects,research,distribution,outreach}.rs`, `tools/{inbox,mod}.rs` | new/changed | MCP tools |
| `rust/crates/adapters/jt_panel_http/src/routes/{prospects,research,distribution,outreach}.rs`, `routes/{inbox,mod}.rs` | new/changed | panel routes |
| `rust/crates/adapters/jt_webhook/src/{lib,links}.rs` | changed/new | public unsubscribe and click routes |
| `rust/crates/adapters/jt_mail/src/{smtp,imap,parse,lib}.rs` | changed | headers, From name, attachment bytes from poll |
| `rust/crates/adapters/jt_netgsm/src/{iys,lib}.rs` | changed | `ConsentSync::search` |
| `rust/crates/adapters/jt_files/src/{serve,lib}.rs` | changed | purpose `attachment` |
| `rust/bin/jeeta/src/{scheduler,v1_import}.rs` | changed | five intervals; import flags |
| `rust/panel/src/pages/{ProspectsPage,ProspectDetail,ResearchTasksPage,DistributionPage,OutreachPage,OutreachCampaign,OutreachTemplates,OutreachSettings,LeadsReport}.tsx` (+ tests), `api/{prospects,research,distribution,outreach}.ts`, `api/types.ts`, `layout/Shell.tsx`, `App.tsx`, `i18n/{tr,en}.json`, Inbox and Home pages | new/changed | panel |
| `docs/operations/{leads-outreach,v1-import}.md` | new | operator runbooks |
| `rust/Makefile` | changed | `smoke-leads` |

---

## Contracts (defined in the first task of each phase; every later task uses exactly these names)

```rust
// ---- jt_prospects (L1-T1) ----
define_id!(ProspectId); define_id!(ResearchTaskId);
#[serde(rename_all = "snake_case")] pub enum ProspectStatus { New, Qualified, Rejected, Promoted, DoNotContact }
#[serde(rename_all = "snake_case")] pub enum EntityKind { LegalEntity, SoleTrader, UnknownBusiness }
#[serde(rename_all = "snake_case")] pub enum RejectReason { NotIcp, ClosedBusiness, NoContactData, Competitor, AlreadyCustomer, Duplicate, Other }
#[serde(rename_all = "snake_case")] pub enum DncReason { Objected, Legal, Other }
#[serde(rename_all = "snake_case")] pub enum KeyKind { Phone, Email, Instagram, Tiktok, Domain, NameCity }
impl KeyKind { pub const ALL: &[KeyKind]; pub fn key(self) -> &'static str; pub fn hard(self) -> bool; }
pub struct Key { pub kind: KeyKind, pub value: String }
pub struct Prospect { /* spec §3.1, field for field */ }
pub struct ContactFields { pub phone, email, website, instagram, tiktok, address: Option<Field<String>>,
                           pub contact_person: Option<Field<ContactPerson>> }
pub struct ContactPerson { pub name: String, pub role: String }
pub struct Field<T> { pub value: T, pub evidence: Evidence, #[serde(default = "yes")] pub deliverable: bool }
pub struct Evidence { pub sources: Vec<SourceRef>, pub captured_at: OffsetDateTime, pub recorder: Recorder }
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRef { Url { url: String, note: Option<String> }, Manual { note: String }, Import { system: String, record: String } }
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recorder { Agent { connection_id: AgentConnectionId, user_id: UserId }, Human { user_id: UserId }, Import { system: String, record: String },
                    System { job: String } }   // L1 review (spec D30): a job's own writes, e.g. L2's standing-task planner
pub struct Signal { pub text: String, pub source: SourceRef }
pub struct SizeHint { pub branches: Option<u16>, pub employees: Option<EmployeeBand>, pub note: Option<String> }
pub enum EmployeeBand { B1To9, B10To49, B50To249, B250Plus }   // serde "1-9" | "10-49" | "50-249" | "250+"
pub struct Origin { pub via: OriginVia, pub discovered_at: Vec<SourceRef>, pub distinct_from: Vec<ProspectId>, pub recorder: Recorder, pub at: OffsetDateTime }
pub enum OriginVia { ResearchTask, Manual, Agent, V1Import, System }
pub struct ScoreSummary { pub score: u8, pub digest: String, pub at: OffsetDateTime }
pub struct Decision { pub kind: DecisionKind, pub note: String, pub by: Recorder, pub at: OffsetDateTime }
pub enum DecisionKind { Rejected(RejectReason), DoNotContact(DncReason) }
pub struct Promotion { pub person_id: PersonId, pub journey_id: JourneyId, pub at: OffsetDateTime, pub score: Option<u8>, pub bucket: Option<Bucket> }

// Input shapes (the agent never sends a Recorder: Jeeta fills it from Ctx)
#[serde(deny_unknown_fields)] pub struct FieldInput<T> { pub value: T, pub sources: Vec<SourceRefInput>, pub captured_at: OffsetDateTime }
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceRefInput { Url { url: String, #[serde(default)] note: Option<String> }, Manual { note: String } }
#[serde(deny_unknown_fields)] pub struct CreateInput { pub business_name: String, pub entity_kind: EntityKind,
    #[serde(default)] pub sector: Option<String>, city, district, language, segment_key: Option<String>,
    #[serde(default)] pub country: Option<String>, #[serde(default)] pub labels: Vec<String>,
    #[serde(default)] pub phone, email, website, instagram, tiktok, address: Option<FieldInput<String>>,
    #[serde(default)] pub contact_person: Option<FieldInput<ContactPerson>>, #[serde(default)] pub size: Option<FieldInput<SizeHint>>,
    #[serde(default)] pub signals: Vec<SignalInput>, #[serde(default)] pub notes: String,
    #[serde(default)] pub research_task_id: Option<ResearchTaskId>, #[serde(default)] pub discovered_at: Vec<SourceRefInput>,
    #[serde(default)] pub distinct_from: Vec<ProspectId>, #[serde(default)] pub request_key: Option<String> }
#[serde(deny_unknown_fields)] pub struct UpdateInput { pub expected_revision: u32, #[serde(default)] pub set: SetFields, #[serde(default)] pub clear: Vec<FieldName>,
    #[serde(default)] pub distinct_from: Vec<ProspectId> }
#[serde(rename_all = "snake_case")] pub enum FieldName { Sector, City, District, Language, SegmentKey, Labels, Phone, Email, Website,
    Instagram, Tiktok, Address, ContactPerson, Size, Signals, Notes }

pub fn validate_create(input: &CreateInput, now: OffsetDateTime, recorder: &Recorder) -> Result<(), ProspectError>;
pub fn build(input: CreateInput, id: ProspectId, ws: WorkspaceId, now: OffsetDateTime, recorder: Recorder) -> Prospect; // after validate
pub fn apply_update(p: &mut Prospect, input: UpdateInput, now: OffsetDateTime, recorder: Recorder) -> Result<Vec<FieldName>, ProspectError>;
pub fn derive_keys(p: &Prospect) -> Vec<Key>;                      // hard and soft; deduplicated; stable order
pub fn normalise_handle(kind: KeyKind, raw: &str) -> Result<String, ProspectError>;
pub fn website_domain(url: &str) -> Result<Option<String>, ProspectError>; // None for platform hosts; Err for non-http(s)
pub fn name_city(name: &str, city: &str) -> Option<String>;
pub fn blocklist_material(kind: KeyKind, normalised: &str) -> Vec<u8>; // kind.key() ‖ 0x00 ‖ normalised
pub const FREE_MAIL_DOMAINS: &[&str]; pub const PLATFORM_HOSTS: &[&str];
#[derive(thiserror::Error)] pub enum ProspectError { #[error("{field}: {reason}")] Invalid { field: &'static str, reason: &'static str } }

pub enum StatusEvent { Qualify, Reject { reason: RejectReason }, Reopen, Promote, DoNotContact { reason: DncReason } }
pub fn next_status(from: ProspectStatus, event: &StatusEvent) -> Result<ProspectStatus, StatusError>;
#[derive(thiserror::Error)] #[error("a {from} prospect cannot be {event}")] pub struct StatusError { pub from: &'static str, pub event: &'static str }
pub fn scrub_for_dnc(p: &mut Prospect);                             // spec §3.2

#[serde(rename = ...)] pub enum Bucket { B0To24, B25To49, B50To74, B75To100 }  // "0-24" ...
pub fn bucket(score: u8) -> Bucket;
#[serde(deny_unknown_fields)] pub struct ScoreInput { pub score: u8, pub reasons: Vec<ReasonInput>, pub rubric_digest: String }
#[serde(deny_unknown_fields)] pub struct ReasonInput { pub criterion: String, pub points: u8, pub evidence: String, #[serde(default)] pub source: Option<SourceRefInput> }
pub fn validate_score(input: &ScoreInput, rubric: &jt_strategy::Rubric, recorder: &Recorder) -> Result<(), ProspectError>; // a manual source is a person's only

pub struct Brief { pub segment_key: Option<String>, pub sectors: Vec<String>, pub areas: Vec<jt_strategy::Area>, pub signals: Vec<String>,
                   pub exclusions: Vec<String>, pub size_hint: String, pub language: Option<String>, pub note: String }
pub fn validate_brief(b: &Brief) -> Result<(), ProspectError>;
#[serde(tag = "type", rename_all = "snake_case")] pub enum TaskKind { Standing { icp_key: String }, AdHoc { target_count: u16 } }
pub enum TaskStatus { Open, Done, Canceled, Superseded }
pub struct Claim { pub by: Recorder, pub until: OffsetDateTime }

pub struct ProspectsPolicy { pub rejected_retention_days: u16 /*30*/, pub unpromoted_retention_days: u16 /*180*/,
    pub rejected_memory_days: u16 /*365*/, pub max_promotions_per_day: u16 /*100*/, pub agents_promote_qualified_only: bool /*true*/ }
pub fn purge_after(policy: &ProspectsPolicy, status: ProspectStatus, decided_at: Option<OffsetDateTime>, updated_at: OffsetDateTime) -> Option<OffsetDateTime>;
pub struct PurgeCutoffs { pub rejected: OffsetDateTime, pub unpromoted: OffsetDateTime }   // L1 review (spec D35)
pub fn purge_cutoffs(policy: &ProspectsPolicy, now: OffsetDateTime) -> PurgeCutoffs;      // due at now ⟺ purge_after ≤ now
pub const MAX_DAILY_PROSPECTS: u32 = 500;
pub const PLAYBOOK_VERSION: u32 = 1; pub const TEXT: &str;          // spec Appendix A, verbatim
// As built (L1-T1), beyond the names above: `normalise_key(kind, raw) -> Result<String, ProspectError>`
// (a raw value of any kind as its key: `check`, do-not-contact by raw keys); `KeyKind::parse`;
// `ALL`/`key()`/`parse()` on ProspectStatus, RejectReason, DncReason, EntityKind, Bucket (+ `range()`),
// TaskStatus; `FieldName::{key, touches_keys}`; `Prospect::field_names()`; `Recorder::is_agent()`;
// `SignalInput { text, source: SourceRefInput }`; `SetFields` holds the FieldName fields as Options
// (labels and signals as `Option<Vec<_>>`); `ContactPerson` and `SizeHint` refuse unknown fields both
// ways (they are `FieldInput` values); `StatusError.event` is the refused event as a past participle.
// `jt_strategy::{Area, Rubric, Criterion}` (types and KEYS only) land in L1-T1, because `Brief` and
// `validate_score` name them; `Prospecting`, `IcpEntry` and `Sections.prospecting` stay L2-T1.
// L1 review (2026-11-03, spec D28–D36): `KeyKind::hard()` is also "the kinds the blocklist holds";
// `normalise_phone(raw) -> Result<String, ProspectError>` (spec D34; `normalise_key(Phone, _)` is it) and
// `phone_is_dialable(normalised) -> bool` (false for `TR444_PREFIX` "tr444:" keys; such a phone field is not
// `deliverable`); `PLATFORM_HOSTS: &[(&str, PlatformKind)]` with `PlatformKind { SocialProfile, LinkInBio,
// Messaging, MapListing, Marketplace, ShortLink, SharedHost }` and `PlatformKind::reason()`, `PLATFORM_NAMES`
// (google, yandex under any country domain), `MAX_HOST_CHARS = 253`; `classify_website(url) ->
// Result<WebsiteHost { Domain(String), Platform(PlatformKind), IpAddress }, ProspectError>` (`website_domain` is
// its domain); `website_handle(kind, url) -> Option<String>` (a profile URL on the platform's host);
// `normalise_handle` refuses reserved first path segments and a TikTok path without `@` (`not_a_profile_url`)
// and strips `www.`/`m.` only before the platform's host; `Recorder::is_human()`.

// ---- jt_strategy (L2-T1) ----
pub struct Prospecting { pub icp: Vec<IcpEntry>, pub rubric: Rubric }
pub struct IcpEntry { pub key, segment_key: String, pub sectors: Vec<String>, pub areas: Vec<Area>, pub signals, exclusions: Vec<String>,
                      pub size_hint: String, pub language: Option<String>, pub daily_cap: u16, pub backlog_target: u16 }
pub struct Area { pub city: String, pub district: Option<String> }
pub struct Rubric { pub criteria: Vec<Criterion>, pub qualify_at: u8 }
pub struct Criterion { pub key: String, pub description: String, pub weight: u8 }
// Sections gains `pub prospecting: Prospecting`; Sections::KEYS gains "prospecting"; each with `KEYS` for the strict parse.

// ---- jt_inbox (L3-T1, L4-T2) ----
#[serde(rename_all = "snake_case")] #[derive(Default)] pub enum RecipientKind { #[default] Unknown, Business, Individual }
// Person gains `#[serde(default)] pub recipient_kind: RecipientKind`.
// Source gains (before the untagged V1Import): `Prospect { prospect_id: Uuid, origin: String }` -> {"prospect": {...}}
pub enum CommercialBasis { Consent, BusinessRecipient }
pub fn commercial_basis(consents: &[Consent], suppressions: &[Suppression], channel: Channel,
                        recipient: RecipientKind, b2b_channels: &[Channel]) -> Result<CommercialBasis, IzinYok>;
// JourneyEventKind gains `OutreachSent { campaign_id: Uuid, step: u8 }` (rank-neutral, no effects).
define_id!(RuleId); define_id!(AssignmentId);
#[serde(rename_all = "snake_case")] pub enum SourceKind { Prospect, Channel, MetaAds, Form, Import, Repeat }
pub fn source_kind(s: &Source) -> SourceKind;
pub struct Match { pub sources: Vec<SourceKind>, pub cities, sectors, languages, segments: Vec<String>, pub min_score: Option<u8> }
#[serde(tag = "kind", rename_all = "snake_case")] pub enum MemberPool { Members { user_ids: Vec<UserId> }, AllEligible }
#[serde(rename_all = "snake_case")] pub enum Method { RoundRobin, LeastLoaded }
pub struct Rule { pub id: RuleId, pub name: String, pub enabled: bool, pub when: Match, pub to: MemberPool, pub method: Method,
                  pub sla_minutes: Option<u32>, pub cursor: Option<UserId> }
pub struct LeadFacts { pub source: SourceKind, pub city, sector, segment, language: Option<String>, pub score: Option<u8> }
pub struct Candidate { pub user_id: UserId, pub eligible: bool, pub on_shift: bool, pub open_owned: u32,
                       pub languages, cities, sectors: Vec<String> }       // the rep's own filters
#[serde(rename_all = "snake_case")] pub enum Cause { Rule, Default, Manual, SlaReassign, MemberLeft, Import, NoEligible }
pub struct Choice { pub user_id: Option<UserId>, pub rule_id: Option<RuleId>, pub cause: Cause, pub sla_minutes: Option<u32> }
pub fn choose(rules: &[Rule], default_rule: bool, facts: &LeadFacts, candidates: &[Candidate], exclude: &[UserId]) -> Choice;
pub fn rule_matches(m: &Match, facts: &LeadFacts) -> bool;               // empty list = any; unknown fact never matches a non-empty list

// ---- jt_outreach (L4-T1) ----
define_id!(TemplateId); define_id!(CampaignId); define_id!(EnrollmentId); define_id!(SendId);
pub enum Var { FirstName, ContactName, Company, City, District, Sector, SenderName, SenderCompany, Custom(String) }
pub struct Template { pub id: TemplateId, pub name: String, pub language: Lang, pub subject: String, pub body: String, pub revision: u32, pub archived: bool }
#[serde(rename_all = "snake_case")] pub enum Lang { Tr, En }
pub fn validate_template(subject: &str, body: &str) -> Result<TemplateFacts, TemplateError>;  // vars used, links found
pub struct TemplateFacts { pub vars: Vec<Var>, pub links: Vec<String> }
pub struct StepSnapshot { pub template_revision: u32, pub subject: String, pub body: String, pub links: Vec<String>, pub language: Lang }
pub struct RenderVars { pub values: BTreeMap<String, String> }      // "company", "custom.opener", ...
pub struct Footer { pub sender_company: String, pub sender_address: String, pub privacy_notice_url: String, pub unsubscribe_url: String, pub source: FooterSource }
pub enum FooterSource { PublicBusinessData, Consent }
pub struct Rendered { pub subject: String, pub text: String }
pub fn render(s: &StepSnapshot, vars: &RenderVars, footer: &Footer, link_url: Option<&dyn Fn(usize) -> String>) -> Result<Rendered, RenderError>;
#[derive(thiserror::Error)] pub enum RenderError { #[error("missing_variable:{0}")] MissingVariable(String), #[error("header_unsafe")] HeaderUnsafe }
pub struct Step { pub template_id: TemplateId, pub delay_days: u16, pub same_thread: bool, #[serde(default)] pub snapshot: Option<StepSnapshot> }
pub struct Schedule { pub start_at: Option<OffsetDateTime>, pub window: jt_capability::Hours }
pub struct Throttle { pub per_hour: u16, pub per_day: u16 }
pub struct Audience { pub people: Option<PeopleFilter>, pub prospects: Option<ProspectFilter>, pub explicit: Vec<PersonId> }
pub struct Definition { pub sender_name: String, pub steps: Vec<Step>, pub audience: Audience, pub schedule: Schedule,
                        pub throttle: Throttle, pub click_tracking: bool, pub evergreen: bool, pub segment_key: Option<String> }
#[serde(rename_all = "snake_case")] pub enum CampaignStatus { Draft, AwaitingApproval, Scheduled, Running, Paused, Completed, Canceled }
pub struct Approval { pub revision: u32, pub by: UserId, pub at: OffsetDateTime }
pub enum CampaignEvent { Launch { approval_required: bool, now: OffsetDateTime }, Approve { revision: u32 }, Pause { reason: String },
                         Resume { approval_required: bool }, Complete, Cancel, Edit }
pub fn campaign_next(status: CampaignStatus, approval: Option<&Approval>, revision: u32, start_at: Option<OffsetDateTime>,
                     event: &CampaignEvent) -> Result<(CampaignStatus, ApprovalChange), CampaignError>;
pub enum ApprovalChange { Keep, Void, Set }
pub fn validate_definition(d: &Definition) -> Result<(), CampaignError>;
#[serde(rename_all = "snake_case")] pub enum EnrollmentStatus { Active, Completed, Stopped, Skipped }
#[serde(rename_all = "snake_case")] pub enum StopReason { Replied, Bounced, Complained, Unsubscribed, ConsentWithdrawn, MeetingBooked, JourneyWon,
    JourneyLost, PersonErased, PersonMerged, HumanHoldsConversation, DoNotContact, CampaignCanceled, Manual, Refused(String), MissingVariable(String) }
#[serde(rename_all = "snake_case")] pub enum SkipReason { NoDeliverableEmail, Suppressed, NoBasis, DoNotContact, ActiveElsewhere, PersonGone, JourneyClosed, PromotionCap }
impl StopReason { pub fn key(&self) -> String; } impl SkipReason { pub fn key(self) -> &'static str; }
pub struct WarmupPolicy { pub enabled: bool, pub start: u16 /*20*/, pub step: u16 /*10*/, pub max: u16 /*150*/ }
pub fn warmup_cap(p: &WarmupPolicy, day_index: u32) -> u32;          // u32::MAX when disabled
pub const MAILBOX_DAY_CEILING: u32 = 500; pub const DOMAIN_PER_HOUR: u32 = 5;
pub struct Frequency { pub min_gap_days: u16 /*3*/, pub max_per_30_days: u16 /*4*/ }
pub fn frequency_next_allowed(f: &Frequency, sends: &[OffsetDateTime], now: OffsetDateTime) -> Option<OffsetDateTime>; // None = now ok
pub fn rewrite_links(text: &str, links: &[String], url_for: &dyn Fn(usize) -> String) -> String;
pub fn mac_input(purpose: MacPurpose, send: SendId, link: Option<u16>) -> Vec<u8>;
pub enum MacPurpose { Unsubscribe, Click }                          // hmac_key purposes "outreach.unsubscribe", "outreach.click"
pub struct OutreachFacts { pub platform_enabled: bool, pub status: CampaignStatus, pub approval_required: bool, pub approved_revision: Option<u32>,
                           pub revision: u32, pub blocklisted: bool, pub inbound_since_enrollment: bool, pub meeting_since_enrollment: bool,
                           pub sender_identity_complete: bool }
pub fn outreach_fence(f: &OutreachFacts) -> Result<(), OutreachRefusal>;   // F2, F3, F7, F9, F10 in this order
#[serde(rename_all = "snake_case")] pub enum OutreachRefusal { OutreachDisabledOnPlatform, CampaignNotRunning, ApprovalRequired, DoNotContact, Replied, MeetingBooked, SenderIdentityMissing }

// ---- jt_app ports (L1-T3, L3-T2, L4-T3, L6-T1): spec §6.1, names verbatim ----
// ---- jt_app::usecases::replies (L4-T5) ----
pub(super) enum Target { Conversation(ConversationId), Person(PersonId, Channel), PersonVia(PersonId, CapabilityId) }
pub(super) enum Purpose<'a> { Reply, Quote(..), Appointment(..), Outreach(&'a OutreachSend) }
pub struct OutreachSend { pub send_id: SendId, pub enrollment_id: EnrollmentId, pub campaign_id: CampaignId, pub step: u8,
                          pub basis: CommercialBasis, pub from_name: String, pub unsubscribe_https: String, pub unsubscribe_mailto: String }
```

Rules shared by all phases:
- **Lock order:** inbox workspace lock (`people().lock_workspace()`) → pool lock (`prospects().lock_pool()`) →
  rows. A use case that needs only the pool takes only the pool lock. **A policy read never locks**: the pool
  reads the leads policy with `workspace_policy().read()`; `get()` (which takes the workspace-policy lock) is
  for a policy write only, and no use case of L2/L3 takes the pool lock after a locking policy read (spec D31).
  The leads policy is written key by key with `patch_leads` (only the keys given are stored).
- **Recorder** is built by `usecases::prospects::recorder(ctx)` from `ctx.actor` (agent → `Agent { connection_id,
  user_id }`, human → `Human`, system → refused for pool writes except the importer). A job's own records (L2's
  standing tasks) name `Recorder::System { job }`.
- **Request keys store ids, never answers** (spec D33): a stored response is `{<entity>_id}` (`prospect_id`,
  `task_id`, `campaign_id`, …) and a replay reads the row again; a replay is checked again after the use case's
  lock (a racing request with the same key replays once the first commits). Erasure, do-not-contact and purge
  delete the matching rows with `RequestKeyRepo::forget(prefix, field, value)`. Every request key of L2–L4 keeps
  this rule.
- **Hard keys only block** (spec D28): only phone, email, Instagram and TikTok are hashed onto the blocklist
  (do-not-contact, erasure, rejection memory, a person's erasure) and only their hits refuse; soft keys come back
  as `Flag`s. **Objections always run** (spec D29): `catalog::OBJECTION_USE_CASES` (do-not-contact, erase) are
  status-exempt (`Always`) and strategy-exempt.
- **Errors:** fences `FORBIDDEN {reason}`; duplicates and caps `CONFLICT {reason, ...}`; input `VALIDATION
  {field}`; the reason keys are the snake_case names in the spec.
- **No provider I/O inside a transaction** (bug class "cron-lock pool starvation"): the dispatcher commits before
  `send_step`; the İYS lookup runs before the enqueue transaction.

## Phase order and sizes

| Phase | Tasks | Size | Depends on | Unblocks |
|---|---|---|---|---|
| L1 Pool core | T1 domain (M), T2 migration + permissions (M), T3 ports/repos/fakes (L), T4 create/update/check/list/get (L), T5 score/decide/DNC/erase/settings/purge (M), T6 catalog + surfaces (M) | ~L+ | — | L2, L3, L7 |
| L2 Research | T1 strategy section (M), T2 tasks + plan job (M), T3 playbook + work items (S) | M | L1 | agents researching |
| L3 Promotion + distribution | T1 inbox domain (M), T2 migration 0021 + repos (M), T3 promote (L), T4 distribution use cases + job + hooks (L), T5 surfaces + pins (M) | L | L1 | L4, L7 |
| L4 Outreach | T1 domain (L), T2 commercial basis + OutreachSent (M), T3 migration 0022 + repos (M), T4 templates/campaigns (L), T5 enrollment + dispatch (L), T6 hooks + reports (M), T7 surfaces + pins (M) | XL | L3 | L5 |
| L5 Public endpoints | T1 mail headers (S), T2 unsubscribe + click routes (M) | M | L4-T5 | turning on `JEETA_OUTREACH_ENABLED` |
| L6 Attachments | T1 migration 0023 + repo + files purpose (M), T2 inbound (L), T3 outbound + erasure + purge (M) | L | — (parallel to L1) | — |
| L7 v1 import | T1 routing + pool intake + rollback (L), T2 export runbook + staging dry run (S) | M | L1, L3 | v1 switch-off |
| L8 Panel | T1 plumbing (S), T2 pool + tasks (L), T3 distribution (M), T4 outreach (L), T5 inbox + home (M), T6 reports (M) | XL | each its backend phase | owner use |
| L9 Smoke + docs | T1 smoke_leads (M), T2 runbooks (S), T3 request-key purge job (S) | M | all | release |

v1 switch-off needs L1, L2, L3, L4, L5, L7 and L8-T2..T5 merged and deployed, the owner's answers to spec §15
Q1–Q4, and the staging dry run read by the owner. L6 is not required (v1 never stored attachments).

---

## L1 — Pool core

### Task L1-T1: `jt_prospects` domain crate

**Files:** `rust/crates/domain/jt_prospects/{Cargo.toml,src/*.rs,tests/*.rs}`; workspace `Cargo.toml` members;
`jt_archtest/tests/dependency_boundaries.rs` `DOMAIN_CRATES` gains `("jt_prospects", &["jt_inbox", "jt_strategy",
"url"])` with a comment (phones and emails normalise through `jt_inbox::normalise`; `url` parses websites and does
IDNA; the rubric and areas are the strategy's types). As built: no `jt_capability` (nothing in the crate uses it).

The crate holds the contract types above and the pure rules of spec §3.1–3.4 and §3.6 (retention arithmetic
only). `playbook::TEXT` is Appendix A verbatim (`jt_archtest` pins it to the spec in L1-T6).

Sketch of the folding used by `name_city`:
```rust
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let c = match c { 'İ' => 'i', 'I' => 'ı', c => c };
        for l in c.to_lowercase() {
            out.push(match l { 'ç' => 'c', 'ğ' => 'g', 'ı' => 'i', 'ö' => 'o', 'ş' => 's', 'ü' => 'u',
                               c if c.is_alphanumeric() => c, _ => ' ' });
        }
    }
    out.split_whitespace().filter(|t| !LEGAL_FORM_TOKENS.contains(t)).collect::<Vec<_>>().join(" ")
}
```

- [ ] **Tests first** (`tests/keys.rs`): `phone_keys_use_inbox_normalisation` (national, local, +90 forms →
  one value), `email_key_lowercases_and_domain_key_skips_free_mail`, `website_domain_strips_www_and_idna`
  (`https://www.Örnek.com.tr/x` → `xn--rnek-...` form), `platform_hosts_are_not_domains`,
  `instagram_url_becomes_handle_key`, `tiktok_at_handle_is_normalised`, `name_city_folds_turkish_and_legal_forms`
  (`"ÖRNEK Kafe Ltd. Şti."`, `"İstanbul"` → `"ornek kafe|istanbul"`), `no_name_city_without_city`,
  `derive_keys_is_deduplicated_and_stable`, `blocklist_material_separates_kinds`.
  (`tests/status.rs`): `every_allowed_transition` (table of spec §3.2), `every_other_pair_is_refused`,
  `scrub_for_dnc_empties_personal_fields_and_keeps_ids`.
  (`tests/evidence.rs`): `agent_fields_need_a_url_source`, `manual_sources_are_for_humans_only`,
  `captured_at_window`, `recorder_is_never_read_from_input` (a JSON body with `recorder` is refused by
  `deny_unknown_fields`), `website_must_be_http_or_https`, `website_on_platform_host_is_refused`,
  `labels_signals_and_lengths_are_bounded`, `deliverable_defaults_to_true_on_read`.
  (`tests/score.rs`): `score_must_equal_sum_of_points`, `every_criterion_exactly_once`,
  `points_bounded_by_weight`, `buckets_are_fixed`.
  (`tests/policy.rs`): `purge_after_rejected_is_decision_plus_retention`,
  `purge_after_unpromoted_moves_with_updates`, `promoted_and_dnc_have_no_purge_time`.
- [ ] `cargo test -p jt_prospects` red → implement → green; fmt, clippy; `cargo test -p jt_archtest --test
  dependency_boundaries`.
- [ ] **Commit** `feat(prospects): the pool's pure domain`.
- L1 review fixes (2026-11-03): phones pre-normalise (`normalise_phone`, `tr444:`), handles come only from
  profile URLs, `PLATFORM_HOSTS` is a table of kinds with their reasons (Turkish marketplaces, maps, short
  links, `google.*`/`yandex.*`, `sites.google.com`), an IP and an overlong host have their own reasons, the
  fold folds â/î/û, `Recorder::System`, `validate_score` takes the recorder, `purge_cutoffs`. Tests
  `turkish_phone_forms_normalise_before_the_inbox_rules`, `tr444_numbers_are_a_distinct_key_and_never_dialled`,
  `instagram_post_reel_and_story_urls_are_no_handle`, `bare_handles_keep_www_and_m`,
  `tiktok_profile_urls_need_the_at`, `ip_and_overlong_hosts_are_no_domains`, `a_system_recorder_gives_no_manual_source`,
  `manual_sources_in_reasons_are_for_humans_only`, `purge_cutoffs_agree_with_purge_after`.

### Task L1-T2: permissions and migration 0020

**Files:** `rust/crates/domain/jt_tenancy/src/role.rs` (`ProspectsWork` `"prospects.work"`, `ProspectsManage`
`"prospects.manage"`; rep unchanged); `rust/migrations/0020_prospects.{up,down}.sql` (spec §4.1: the
`workspace_policies.leads_policy` column, the five tables, indexes, RLS in the 0006 form, the role backfill in the
0017 form); pins: `jt_pg/tests/migrations.rs`
(`TABLES_AFTER_ALL` 74 → 79, `MIGRATIONS` 17 → 18, down list), `jt_archtest/tests/studio_rules.rs` table count
74 → 79 with the comment extended, `jt_tenancy` role tests, `jt_app/tests/roles.rs`-style permission lists.

(Outreach adds two more permissions and 0022 in L4-T3; each phase moves the pins by its own increment.)

- [ ] **Tests first:** `sql_scoping` sees the five tables with FORCE RLS and one `_ws` policy each; the
  repeatability test runs 0020 up/down twice; `role_backfill_adds_prospects_permissions_to_owner_and_manager`;
  `rep_role_has_no_prospects_permissions`; `prospect_keys_hard_index_refuses_a_second_phone` (Postgres, CI);
  `blocklist_reason_and_expiry_agree` (check constraint).
  As built: the down refuses while the blocklist holds `do_not_contact`/`erased` entries (spec D27,
  `prospects_down_refuses_while_the_blocklist_holds_an_objection`) and keeps a `leads_policy` a workspace set
  (`prospects_down_keeps_a_leads_policy_a_workspace_set`); `every_migration_has_a_down_file` lists the versions
  (`1..=17` and `20`: 0018/0019 are the parallel branches'); every round-trip test that runs older downs runs
  0020's first (its tables reference `people`, `journeys` and `strategy_versions`).
- [ ] CI red → implement → green; **commit** `feat(prospects): tables, RLS and the prospects permissions`.
- L1 review fixes (2026-11-03, 0020 amended in place, see the deploy hazards above): `prospects.purge_after`
  is gone; `decided_at` (set exactly when rejected or do-not-contact, `prospects_decided_check`) and the partial
  indexes `prospects_purge_rejected`, `prospects_purge_unpromoted` replace `prospects_purge` (index pin 10 →
  11); `prospect_blocklist.kind` holds hard kinds only and every entry has `key_fingerprint`. Tests
  `blocklist_holds_hard_keys_only`, `a_prospect_is_decided_exactly_when_rejected_or_do_not_contact`.

### Task L1-T3: ports, Postgres repos, fakes, contract tests

**Files:** `jt_app/src/ports/prospects.rs` (+ `ports/mod.rs` `TenantRepos::{prospects, research_tasks,
prospect_blocklist}`; every `TenantRepos` impl gains them; `WorkspacePolicy.leads: LeadsPolicy` with every part of
spec §6.1, read key by key over `LeadsPolicy::default()`), `jt_pg/src/repos/{prospects,research,policies}.rs`,
`jt_testkit/src/fakes/prospects.rs`, `jt_testkit/src/prospects_contract.rs`, `jt_pg/tests/prospects_repos.rs`.

```rust
#[async_trait]
pub trait ProspectRepo: Send + Sync {
    async fn lock_pool(&mut self) -> Result<(), AppError>;                        // pg_advisory_xact_lock(hashtext('jeeta.pool.'||ws))
    async fn insert(&mut self, p: &Prospect, keys: &[Key]) -> Result<Inserted, AppError>; // Inserted::Ok | DuplicateKey { kind, prospect_id }
    async fn update(&mut self, p: &Prospect, keys: &[Key], expected_revision: u32) -> Result<Updated, AppError>; // Ok | Stale | DuplicateKey
    async fn get(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError>;
    async fn lock(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError>;
    async fn list(&mut self, q: &ProspectQuery) -> Result<Page<ProspectRow>, AppError>; // (created_at desc, id) cursor
    async fn find_by_keys(&mut self, keys: &[Key]) -> Result<Vec<(KeyKind, ProspectId)>, AppError>;
    async fn record_score(&mut self, row: &ScoreRow) -> Result<(), AppError>;  // inserts the row AND sets latest_* in one statement pair
    async fn scores(&mut self, id: ProspectId, limit: u32) -> Result<Vec<ScoreRow>, AppError>;
    async fn set_status(&mut self, id: ProspectId, status: ProspectStatus, decision: Option<&Decision>, purge_after: Option<OffsetDateTime>,
                        expected_revision: u32) -> Result<Updated, AppError>;
    async fn set_promoted(&mut self, id: ProspectId, promotion: &Promotion) -> Result<(), AppError>;
    async fn by_person(&mut self, person: PersonId) -> Result<Option<Prospect>, AppError>;
    async fn delete(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError>;   // returns the keys it held
    async fn due_for_purge(&mut self, now: OffsetDateTime, limit: u32) -> Result<Vec<ProspectId>, AppError>;
    async fn created_between(&mut self, task: Option<ResearchTaskId>, from: OffsetDateTime, to: OffsetDateTime) -> Result<u32, AppError>;
    async fn promoted_between(&mut self, from: OffsetDateTime, to: OffsetDateTime) -> Result<u32, AppError>;
    async fn count_unscored(&mut self, digest: &str) -> Result<u32, AppError>;
    async fn count_qualified_unpromoted(&mut self) -> Result<u32, AppError>;
    async fn backlog(&mut self, segment_key: &str) -> Result<u32, AppError>;
}
#[async_trait] pub trait ResearchTaskRepo: Send + Sync { /* insert, get, lock, list(ResearchTaskQuery), open_standing(version), set_status, set_claim */ }
#[async_trait] pub trait BlocklistRepo: Send + Sync {
    async fn contains(&mut self, kind: KeyKind, hash: &str, now: OffsetDateTime) -> Result<Option<BlockReason>, AppError>; // expired rejected entries ignored
    async fn insert(&mut self, kind: KeyKind, hash: &str, reason: BlockReason, at: OffsetDateTime, expires_at: Option<OffsetDateTime>) -> Result<(), AppError>; // DNC/erased upgrade rejected
    async fn lift(&mut self, kind: KeyKind, hash: &str) -> Result<bool, AppError>; // only do_not_contact entries; erased never lifts
    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError>;
}
```
- `update` and `set_status` recompute `purge_after` from the policy passed by the use case; the repo never reads
  a clock.
- As built (contract changes): `ProspectRepo` gains `keys_of(id) -> Vec<Key>` (update re-checks only the keys an
  edit adds; erase and do-not-contact hash what the row holds); `set_status` takes `at: OffsetDateTime` too (it
  sets `updated_at`, which the unpromoted retention counts from: a reopen restarts it) and refuses `Promoted`
  (`set_promoted` does that); `record_score` moves neither the revision nor `updated_at` (a score is not an
  edit) and makes the row the latest only when it is not older than the latest; `update` writes the whole record
  and its keys (the stored revision becomes `expected_revision + 1`). `Page<T> { items, next: Option<ListCursor
  { created_at, id: Uuid }> }`, `ProspectQuery { status, research_task_id, city, segment_key, bucket, limit, after
  }`, `ProspectRow::of(&Prospect)` (no contact values: `fields` names what is held) and `prospect_matches` (the
  one filter both adapters list by) live in `ports/prospects.rs`, with `BlockReason { Rejected, DoNotContact,
  Erased }` and `is_key_hash`. `ScoreRow.reasons` is `Vec<jt_prospects::Reason>` (the stored form of
  `ReasonInput`, `ReasonInput::into_reason`). `ResearchTaskRepo`: `insert(&ResearchTask) -> bool` (`false` when
  the ICP entry already has an open standing task of that version), `get`, `lock`, `list(&ResearchTaskQuery {
  status, limit, after }) -> Page<ResearchTask>`, `open_standing(version)`, `set_status(id, status, at, note)`,
  `set_claim(id, Option<&Claim>)`; `jt_prospects::ResearchTask` is spec §3.7's record. `LeadsPolicy { timezone,
  prospects, distribution: DistributionPolicy { mode: DistributionMode { Auto, Manual }, max_reassignments },
  attachments: AttachmentsPolicy { retention_days } }`: the outreach part joins in L4-T3 with `jt_outreach`'s
  `WarmupPolicy` and `Frequency`. The pool lock is `pg_advisory_xact_lock(hashtextextended('prospect_pool:' || ws,
  0))`.
- The fake keeps the same uniqueness and upgrade rules (no "count-mock drift": the fake's counts are computed from
  its rows; memory "enrollment-progress count mock drift").
- [ ] **Contract tests** (fake and Postgres): `insert_then_get_round_trips_every_field`,
  `hard_key_duplicate_is_reported_with_its_owner`, `soft_keys_never_conflict`, `update_is_revision_checked`,
  `update_replaces_keys`, `record_score_sets_latest_in_the_same_call`, `list_filters_and_cursor`,
  `delete_returns_keys_and_cascades_scores`, `due_for_purge_respects_time`, `blocklist_dnc_upgrades_rejected`,
  `blocklist_expired_rejected_is_ignored`, `lift_refuses_erased`, `rows_are_workspace_scoped`,
  `leads_policy_merges_defaults_key_by_key` (a stored partial object reads every missing key as its default:
  bug class "stale stored aggregate").
  Postgres only: `concurrent_inserts_with_one_phone_create_one_prospect`, `pool_lock_serialises_two_bundles`.
- [ ] CI red → green; **commit** `feat(prospects): pool repositories, fake and contracts`.
- L1 review fixes (2026-11-03), contract changes: `WorkspacePolicyRepo::read()` (no lock) and
  `patch_leads(patch: Value, at) -> LeadsPolicy` (merges `patch` key by key into the stored object, which holds
  only the keys someone set; `ports::merge_object`, `ports::leads_policy_of`); `set` no longer writes the leads
  policy. `ProspectRepo`: `purge_after` is never stored (reads answer `None`); `set_status(id, status, decision,
  at, expected_revision)` (no purge time); `due_for_purge(cutoffs: PurgeCutoffs, limit)` selects by status and
  `decided_at`/`updated_at`; `set_promoted -> Promoted { Ok, NotPromotable { status }, PersonAlreadyLinked {
  prospect_id } }` (spec D32, the repository checks the status); `delete_scores(id) -> u64`; an update racing a
  writer without the pool lock is `CONFLICT {reason: duplicate, prospect_id}`; a key over 400 characters and a
  decision that does not match the status are `INTERNAL` in both adapters. `ProspectRow.decided_at`.
  `BlocklistRepo::insert(.., key_fingerprint: &str)` (hard kinds only, `is_key_fingerprint`) and
  `key_fingerprints() -> Vec<(String, u64)>`. `RequestKeyRepo::forget(prefix, field, value) -> u64`. New contract
  tests `keys_are_bounded_and_decisions_match_the_status`, `blocklist_counts_entries_by_key_fingerprint`,
  `request_keys_are_forgotten_by_prefix_and_field`; Postgres only `the_stored_leads_policy_holds_only_the_keys_set`
  (the fake's twin reads its snapshot), `a_policy_read_takes_no_lock`, `a_racing_update_answers_duplicate_with_the_holder`.

### Task L1-T4: create, update, check, list, get

**Files:** `jt_app/src/usecases/prospects/{mod,pool,dedupe}.rs`, `jt_app/tests/prospects_pool.rs`.

Behaviour (spec §3.3, §3.7 caps):
```rust
pub async fn create(deps: &Deps, ctx: &Ctx, input: CreateInput) -> Result<ProspectOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;                         // refuses System
    jt_prospects::validate_create(&input, ctx.now, &recorder).map_err(invalid_from)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if let Some(out) = replay(r.as_mut(), "prospects.create", &input.request_key, ctx.now).await? { return Ok(out); }
    r.prospects().lock_pool().await?;
    let policy = leads_policy(r.as_mut()).await?;
    caps::check_create(r.as_mut(), &policy, input.research_task_id, ctx.now).await?; // workspace 500/day, task daily_cap (local day)
    let p = jt_prospects::build(input, ProspectId::from(deps.ids.uuid()), ctx.workspace_id, ctx.now, recorder);
    let keys = jt_prospects::derive_keys(&p);
    dedupe::check(deps, r.as_mut(), &keys, &p.origin.distinct_from, None, ctx.now).await?; // erased → blocklist → in_inbox → duplicate → possible_duplicate
    match r.prospects().insert(&p, &keys).await? { Inserted::Ok => {}, Inserted::DuplicateKey { prospect_id, .. } => return Err(duplicate(prospect_id)) }
    record(r.as_mut(), ctx, "prospects.created", "prospect", p.id, json!({"research_task_id": p.research_task_id, "fields": field_names(&p)})).await?;
    store_replay(...); r.commit().await?; Ok(ProspectOut::of(p))
}
```
- `dedupe::check` hashes each hard and soft key with `deps.seal.hmac_key(ws, "prospects.blocklist")` over
  `blocklist_material`; erased identities through `inbox::erasure::check_identity` (phone, email); inbox identities
  through `people().find_by_identity` (phone, email) — a read, no inbox lock.
- `check` runs `dedupe::check` without writing and answers `{ok: true}` or the same reason objects, never a
  hash.
- `update` (`prospects.update`): `apply_update`, re-derives keys, re-runs dedupe only for changed keys, clears
  with `clear` (bug class "clear doesn't persist": a test clears and re-reads), revision-checked.
- `list` answers rows without evidence; `get` answers the prospect with evidence, its scores (latest 20), its
  duplicate candidates (soft-key matches now) and its ledger entries (`ledger.list` by subject).
- [ ] **Tests first:** `create_records_the_agent_connection_as_recorder`, `create_by_human_records_the_user`,
  `system_actor_cannot_create`, `refuses_erased_identity_before_anything_else`, `refuses_blocklisted_key`,
  `previously_rejected_key_is_a_conflict`, `phone_in_inbox_answers_in_inbox_with_person_id`,
  `duplicate_hard_key_names_the_prospect`, `possible_duplicate_lists_candidates`,
  `distinct_from_lets_a_branch_through_and_is_recorded`, `daily_cap_per_task_in_workspace_time_zone` (clock at
  23:30 UTC with tz `Europe/Istanbul` and again with `America/New_York`: a third zone, bug class
  "server-local vs workspace tz"), `workspace_ceiling_500`, `request_key_replays`, `check_writes_nothing`,
  `update_changes_keys_and_rechecks_dedupe`, `update_clear_persists`, `stale_revision_is_a_conflict`,
  `list_filters_by_status_task_city_score_bucket`, `get_includes_evidence_and_scores`,
  `pool_requires_prospects_work` (a rep key is `FORBIDDEN`), `ledger_payloads_hold_no_values` (scan every
  `prospects.*` entry payload for the fixture's phone, email and name: none).
- [ ] `cargo test -p jt_app --test prospects_pool` red → green; **commit** `feat(prospects): record and dedupe
  prospects`.
- As built: `ProspectOut { prospect }`; `CheckInput { business_name, city, phone, email, website, instagram,
  tiktok, distinct_from }` → `CheckOut { ok, ...refusal details }` (`200` either way); `ListInput { status,
  research_task_id, city, segment_key, bucket, limit, before_at, before_id }` → `ListOut { items:
  [ProspectRow], next: {before_at, before_id} }`; `GetOut { prospect, scores, duplicate_candidates, ledger }`
  (the pool's ledger entries about it, found among its newest 1000). Every key, hard and soft, is checked
  against the blocklist (an objection to a business covers its domain and name too); a research task must be
  open (`CONFLICT task_closed`); `update` refuses promoted and do-not-contact prospects (`not_editable`) and a
  stale read before any check (`stale_revision {revision}`); request keys are stored as `prospects.create:<key>`
  so they never meet another operation's. `usecases::hours::local_day(tz, now)` (L3 moves the calls fence's
  hours there too) counts the caps' day from local midnight to the next one, so a clock change's day is 23 or
  25 hours.
- L1 review fixes (2026-11-03): only hard keys are checked against the blocklist and only hard keys refuse
  (spec D28; this replaces "every key, hard and soft, is checked against the blocklist" above); soft keys come
  back as `usecases::prospects::Flag { PossibleDuplicate { candidates }, PreviouslyRejectedSoft { candidates } }`
  (serde tag `flag`), so `ProspectOut { prospect, flags }`, `CheckOut { ok, ...refusal, flags }` and
  `DuplicateCandidate` gains `status`. The request key stores `{prospect_id}` and a replay reads the row again
  (checked again after the pool lock, so a racing create with the same key replays); a `tr444:` phone is no inbox
  identity; every answer's `purge_after` (and each list row's) is computed from the current policy. Tests
  `possible_duplicate_is_a_flag_not_a_refusal`, `distinct_from_silences_the_flag_and_is_recorded`,
  `a_soft_key_of_a_rejection_is_a_soft_flag`, `request_key_replays` (stores the id only; replays the current
  revision); the Postgres use-case test `a_racing_create_with_the_same_request_key_replays`.

### Task L1-T5: score, decide, do-not-contact, lift, erase, settings, purge job

**Files:** `jt_app/src/usecases/prospects/{score,blocklist,erase,settings}.rs`, `jobs.rs` (`Job::ProspectsPurge`
`"prospects_purge"`), `bin/jeeta/src/scheduler.rs` (1 day), `jt_app/tests/{prospects_kvkk,jobs}.rs`.

- `score`: needs the approved strategy's `prospecting.rubric` (`CONFLICT {reason: prospecting_off}` when empty);
  `rubric_digest(&Rubric)` (sha256 over `serde_json::to_vec`); `validate_score`; `record_score`; auto-qualify
  (system actor entry `prospects.qualified {auto: true}`) when `new` and score ≥ `qualify_at`.
- `decide {decision: qualify | reject | reopen, reason?, note?, expected_revision}`: `next_status`; reopen needs a
  human with `prospects.manage`; `purge_after` from the policy.
- `do_not_contact {confirm: true, prospect_id?, keys?: [{kind, value}], reason, note}`: with a prospect → status
  `do_not_contact`, `scrub_for_dnc`, its keys deleted and hashed as `do_not_contact`; with raw keys → hashes only
  (each value normalised by its kind first; invalid → `VALIDATION`). Ledger names kinds, not values.
- `dnc_lift {kind, value}`: human, `prospects.manage`; only `do_not_contact` entries.
- `erase {confirm: true}`: human, `prospects.manage`; promoted → `CONFLICT {reason: erase_the_person}`; deletes the
  row; hashes every key as `erased`.
- `settings_get/set`: `ProspectsPolicy` inside `leads_policy` (column from 0020); bounds: retention days 1..=730,
  rejected memory 0..=1095, promotions per day 1..=1000.
- `purge` job body: per workspace (every status), `due_for_purge(now, 500)`; for each rejected one write
  `rejected` hashes with `expires_at = now + rejected_memory_days` before `delete`; then `purge_expired`; one
  `prospects.purged {count}` system entry per workspace when count > 0.
- [ ] **Tests first:** `score_with_stale_digest_is_rubric_mismatch`, `score_without_prospecting_is_refused`,
  `score_at_threshold_auto_qualifies_once`, `lower_score_never_unqualifies_a_human_decision`,
  `reject_requires_a_known_reason_and_note_for_other`, `reopen_is_human_manager_only`,
  `dnc_scrubs_and_blocks_reentry_after_purge`, `dnc_with_raw_keys_blocks_create`, `lift_requires_a_human_manager`,
  `agent_cannot_lift`, `erase_deletes_now_and_blocks_reentry`, `erase_of_promoted_points_to_the_person`,
  `purge_deletes_rejected_after_retention_and_remembers_keys_for_a_year`,
  `purge_deletes_stale_unpromoted_but_not_promoted`, `rejected_memory_expires`, `purge_runs_in_suspended_workspaces`.
- [ ] Green; **commit** `feat(prospects): scores, decisions, do-not-contact, erasure and purge`.
- As built: needs the strategy's `prospecting` section, so L2-T1 lands before this task. `score` takes
  `ScoreInput`, scores `new` and `qualified` prospects only (`not_scorable`) and answers `{score, status,
  qualified}`; `decide` takes `{decision: qualify|reject|reopen, reason?, note?, expected_revision}` (notes at
  most 500 characters); `human_only` (`FORBIDDEN {reason: human_only}`) guards reopen, lift and erase;
  do-not-contact on a promoted prospect is `CONFLICT {reason: promoted, person_id}` (the objection belongs to the
  inbox person); `erase`, `do_not_contact`, `dnc_lift` and `purge` live in `prospects/blocklist.rs`;
  `settings_set` also takes `timezone` (an IANA zone) and writes `prospects.settings_set {fields}`;
  `rejected_memory_days = 0` remembers nothing. Entries about no one prospect (raw keys, a lift, a purge, the
  settings) have the subject `prospect_pool:<workspace>`.
- L1 review fixes (2026-11-03): `score` answers `prospecting_off` while the approved strategy has no ICP entry
  (whatever its rubric) and refuses an agent's manual source in a reason. `do_not_contact` and `erase` hash hard
  keys only (`not_a_hard_key` for a raw soft key or a soft lift); marking a prospect deletes its score rows (the
  latest score number stays) and the request keys that recorded it; raw keys also mark every live prospect
  holding one (a promoted holder's person is answered: `DncOut { prospect_id, prospects, people, kinds }`, one
  entry per prospect plus one about the pool); `erase` forgets the request keys too; both are
  `catalog::OBJECTION_USE_CASES` (run in any status, no strategy gate, spec D29). The purge reads the current
  policy (`purge_cutoffs`) in batches of `PURGE_BATCH` = 500, each its own transaction with its own
  `prospects.purged {count}` entry, at most `MAX_PURGE_BATCHES` = 20 a run (`Purged.batches`), forgetting the
  request keys of each prospect it deletes. `settings_set` patches only the keys given (`patch_leads`) and takes
  no pool lock; a shortened retention reaches existing prospects at the next purge. Every pool write reads the
  policy with `read()`. Tests `an_empty_icp_switches_scoring_off_whatever_the_rubric`,
  `an_agent_gives_no_manual_source_in_a_score`, `dnc_by_raw_keys_marks_the_prospects_holding_them`,
  `a_soft_key_is_never_lifted`, `a_shortened_retention_reaches_existing_prospects`,
  `purge_catches_up_beyond_one_batch`, `objections_are_recordable_in_a_suspended_workspace`; the DNC and erase
  tests assert the scores and request keys are gone; `ledger_payloads_hold_no_values` covers score, decide,
  do-not-contact (both forms), erase and the settings.

### Task L1-T6: catalog rows, MCP tools, panel routes, pins

As built: **12 rows, not 14**: `prospects.playbook` answers the ICP, the rubric digest and the research tasks'
remaining caps, which exist only with L2, so L2-T3 registers it with its handler; `prospects.report` reads
promotions and outreach, so L4-T6 registers it with `prospects/report.rs`. The pins move by 12 here (catalog
169 → 181, registry 140 → 152, `("prospects", 12)`), by one more in L2-T3 and in L4-T6, and by the plan's own
counts elsewhere. MCP schemas are written out by hand (the domain crates do not depend on `schemars`), with
`confirm` a boolean the use case requires true.

**Files:** `jt_app/src/catalog.rs` (the 14 `prospects.*` rows of spec §7.1 other than `prospects.promote`, which
L3-T5 registers with its handler), `jt_mcp/src/tools/{prospects,mod}.rs`, `jt_panel_http/src/routes/{prospects,mod}.rs`;
pins: `jt_app/tests/catalog.rs` (169 → 183 at this step), `jt_archtest/tests/m4_productisation.rs`
(`POST_M4_ADDED` + 14), `twin_rule.rs` (`MCP_TOOLS_BY_DOMAIN` + `("prospects", 14)`, total,
`destructive_confirmation_tools_are_explicitly_listed` + two), `studio_rules.rs`,
`jt_mcp/tests/{registry,billing/m4_billing_mcp}.rs`, `twin_parity.rs` cases; new `jt_archtest/tests/leads_rules.rs`
with `playbook_text_matches_the_spec_appendix` (compares `jt_prospects::playbook::TEXT` with the spec's Appendix A
block, read from `docs/` at test time, so they never drift) — moved here from L1-T1.

Inputs are the domain input types (schemars derive on them, `deny_unknown_fields`); MCP descriptions (risk last):
- `prospects.create`: "Record one business you researched with your own tools. Every contact field needs a
  public source URL where the business publishes it, and captured_at. Answers duplicate, possible_duplicate
  (resend with distinct_from), in_inbox, previously_rejected, do_not_contact or daily_cap. Read
  jeeta.prospects.playbook first. [risk: WRITE]".
- `prospects.do_not_contact`: "... Requires confirm: true. [risk: DESTRUCTIVE]".
- [ ] **Tests first:** the pins above red; `twin_parity` answers the same for each row; `gate_rule` lists them as
  Gated; MCP `prospects_mcp.rs`: `tools_listed_with_risks`, `create_through_mcp_records_connection`.
- [ ] Green; **commit** `feat(prospects): pool tools and routes`.
- L1 review fixes (2026-11-03): `prospects.do_not_contact` and `prospects.erase` are `Exempt` and
  `StatusExemption::Always` (`catalog::OBJECTION_USE_CASES`; the gate pins in `jt_app/tests/{catalog,gate}.rs`,
  `jt_archtest/tests/{gate_rule,m4_productisation}.rs` list them); the MCP descriptions report the flags, hard
  keys only and the suspended-workspace rule, and no description names `jeeta.prospects.playbook` until L2-T3
  registers it (the create tool says to call `jeeta.prospects.check` first); the do-not-contact and lift schemas
  offer hard kinds only. Appendix A was edited (the flags; what a website is) before the playbook was ever
  served, so it stays version 1; from its first serve on, every edit bumps it.

---

## L2 — Research tasks and the playbook

### Task L2-T1: the strategy's `prospecting` section

**Files:** `jt_strategy/src/{sections,rules,parse}.rs`, `jt_strategy/tests/rules.rs`, `jt_mcp/src/tools/strategy.rs`
(the section enum comes from `Sections::KEYS`), `jt_app/src/usecases/strategy.rs` (no change beyond the type),
`jt_app/src/usecases/prospects/mod.rs` (`rubric_digest`), panel types (L8).

- Types of the contracts; `#[serde(default)]` on `Prospecting` and its parts; `KEYS` constants.
- `validate_sections` gaps under `prospecting.`: `icp[i].segment_key` unknown, `icp[i].sectors` empty,
  `icp[i].areas` empty, `icp[i].daily_cap` outside 1..=200, `icp` keys unique, `rubric.criteria` count 1..=12 and
  keys unique, `rubric.weights_sum` ≠ 100, `rubric.qualify_at` outside 1..=100 — only when `icp` is non-empty.
- `diff` reports `prospecting` changes; `next_draft_from` copies it.
- [ ] **Tests first** (`jt_strategy/tests/rules.rs`): `empty_prospecting_is_not_a_gap`,
  `prospecting_gaps_are_reported`, `icp_segment_must_exist`, `rubric_weights_must_sum_to_100`,
  `prospecting_round_trips_and_reads_tolerantly`, `strict_parse_refuses_unknown_prospecting_keys`,
  `diff_reports_prospecting`, the `Sections::KEYS` tests updated; (`jt_app/tests/strategy.rs`)
  `rubric_digest_is_stable_and_order_sensitive`.
- [ ] Green; **commit** `feat(strategy): the prospecting section (ICP and rubric)`.
- As built: pulled forward before L1-T5, whose score reads the approved strategy's rubric. `rubric_digest` and
  `rubric_digest_is_stable_and_order_sensitive` land with L1-T5 (`usecases/prospects/score.rs`), where the
  digest is first used. The gaps also bound each entry's signals and exclusions (ten each) and
  `backlog_target` (2000) and need a criterion's description; `Area` requires `city` at the strict parse; the
  `jeeta.strategy.write_section` description names the section's shape.

### Task L2-T2: research tasks and the `research_plan` job

**Files:** `jt_app/src/usecases/research.rs`, `jobs.rs` (`Job::ResearchPlan` `"research_plan"`, 1 h), scheduler,
`catalog.rs` (5 `research.*` rows), `jt_mcp/src/tools/research.rs`, `jt_panel_http/src/routes/research.rs`, pins
(+5: catalog 183 → 188, `("research", 5)`), `jt_app/tests/research_tasks.rs`.

- `tasks_create {brief, target_count, daily_cap, request_key?}`: `validate_brief`; `rubric_digest` of the approved
  rubric; `kind = AdHoc`. The request key stores `{task_id}` only and a replay reads the task again (rule
  "request keys store ids"); standing tasks the planner inserts name `created_by: Recorder::System { job:
  "research_plan" }`. Neither takes the pool lock after a locking policy read.
- `tasks_get` answers the task, `remaining_today`, `found` (prospects with that task id), and the 20 newest
  prospects of the task.
- `tasks_claim`: sets `claim = {recorder, until: now + 2h}`; answers who else holds it if another recorder's lease
  is live (`claimed_by_other`, still `200`, advisory).
- `tasks_close {outcome: done | canceled, note}`; an ad-hoc task becomes `done` by itself when `found ≥ target`
  (checked in `prospects.create`'s transaction).
- `plan` job body: per active workspace with an approved strategy, insert missing standing tasks (the partial
  unique index makes a concurrent double insert a no-op: `on conflict do nothing`), supersede open tasks of other
  versions. `strategy.approve` calls the same function in its transaction so the first tasks exist at once.
- [ ] **Tests first:** `approval_creates_one_standing_task_per_icp_entry`, `plan_is_idempotent`,
  `new_version_supersedes_old_tasks`, `adhoc_task_validates_brief`, `adhoc_task_completes_at_target`,
  `remaining_today_counts_the_local_day`, `backlog_target_zeroes_remaining`, `claim_lease_and_other_claimer`,
  `close_requires_prospects_work`.
- [ ] Green; **commit** `feat(research): research tasks from the ICP`.
- As built (2026-11-03): with the playbook, **6 rows** (catalog 181 → 187, registry 152 → 158,
  `("prospects", 13)`, `("research", 5)`). Domain: `jt_prospects::{standing_brief, Brief::normalised,
  validate_ad_hoc, Capacity, remaining_today, CLAIM_LEASE, MAX_TASK_TARGET, MAX_TASK_DAILY_CAP}`; port
  `ProspectRepo::count_for_task(task) -> u32` (both adapters, the list contract). `usecases::research::{tasks_list,
  tasks_get, tasks_create, tasks_claim, tasks_close}` answer `TaskOut { task, remaining_today }`, `ListOut { items,
  next }`, `GetOut { task, remaining_today, found, prospects }` (rows, purge time from the current policy),
  `ClaimOut { task_id, claimed, claim, held_by_other }`; `CloseInput { outcome: done | canceled, note? }`. The
  planner is `research::plan_in(deps, ctx, r, &StrategyVersion) -> Planned { created, superseded }` (recorded by
  `Recorder::System { job: "research_plan" }`, ledger under the system actor `research_plan`); `research::plan`
  is the job body; `strategy.approve` runs `plan_in` in its transaction; `Job::ResearchPlan` (`Job::ALL` 29 →
  30), active workspaces with an approved version, 1 h. `prospects.create` holds the task row (`lock`) and closes
  an ad-hoc task at its target (`research::close_if_found`, `research.task_closed {outcome: done, auto: true}`).
  Decisions D37–D41 (spec). Tests in `jt_app/tests/research_tasks.rs` (with an active workspace: a registration
  starts `pending_payment`, which the planner skips) and `strategy.rs`
  (`approval_creates_one_standing_task_per_icp_entry`, through the real consultation); Postgres parity
  `research_tasks_and_the_playbook_answer_the_same_over_the_panel_and_mcp`.

### Task L2-T3: playbook tool and work items

**Files:** `jt_app/src/usecases/prospects/playbook.rs`, `work.rs` (`WorkKind::{ResearchDue, ProspectsToScore,
ProspectsToPromote}` with `cleared_by`), `jt_mcp/src/tools/work.rs` description lists the new kinds,
`jt_app/tests/work.rs`.

- `playbook` answers spec §3.8's shape.
- `work.pending` adds the three kinds for callers with `prospects.work`, after `inbox` items, only when the
  strategy is approved and prospecting is on.
- [ ] **Tests first:** `playbook_carries_text_rubric_digest_and_remaining`, `research_due_lists_open_tasks_with_remaining`,
  `no_research_due_when_backlog_full`, `prospects_to_score_counts_unscored_under_current_digest`,
  `prospects_to_promote_counts_qualified`, `prospect_items_hidden_without_permission`,
  `prospect_items_respect_status_exemption` (pending payment → none).
- [ ] Green; **commit** `feat(prospects): the agent playbook and research work items`.
- As built (2026-11-03): `usecases::prospects::playbook` answers `PlaybookOut { version, text, workspace:
  PlaybookWorkspace { prospecting_on, icp, rubric, rubric_digest (None while off), caps { timezone,
  daily_prospects, recorded_today, max_promotions_per_day, resets_at }, remaining_today [{task_id, icp_key,
  remaining}], retention_days { rejected, unpromoted, rejected_memory }, blocklist_rules { listed, flagged } } }`.
  `WorkKind::{ResearchDue { task_id, remaining_today }, ProspectsToScore { count }}` (priority 3, cleared by
  `prospects.create` / `prospects.score`) for keys with `prospects.work`, under an approved version with
  prospecting on, after the inbox and Studio items; **`ProspectsToPromote` moves to L3-T5** with
  `prospects.promote` (spec D42). Tests in `jt_app/tests/prospects_playbook.rs` (and `work.rs`'s catalogued-kinds
  list); the MCP descriptions now name `jeeta.prospects.playbook`, and `prospects_mcp.rs` checks that every
  `jeeta.*` tool a pool or research description names is registered.

---

## L3 — Promotion and distribution

### Task L3-T1: inbox domain additions

**Files:** `jt_inbox/src/{person,identity?,distribution,ids,lib}.rs`, `jt_inbox/tests/{distribution,person}.rs`,
`jt_inbox/src/tests.rs` (serde of `Source::Prospect`).

- `RecipientKind` and `Person.recipient_kind`; `Source::Prospect` (serialises `{"prospect": {"prospect_id":…,
  "origin":…}}`; an existing `V1Import` row still reads as `V1Import`).
- `distribution.rs` as the contracts; `choose` steps: for each enabled rule in order whose `when` matches:
  eligible = candidates in the pool, `eligible`, not in `exclude`, passing the rep's own filters; on-shift first;
  `RoundRobin` = the first eligible user id greater than the rule's cursor in byte order, wrapping; `LeastLoaded` =
  min `open_owned`, ties by the round-robin order. No rule → the default rule (all eligible, round robin with the
  default cursor) when `default_rule`; none eligible → `Choice { user_id: None, cause: NoEligible }`.
- [ ] **Tests first:** `source_prospect_round_trips_and_v1_import_still_reads`,
  `recipient_kind_defaults_to_unknown`, `rules_apply_in_order`, `matching_rule_without_eligible_falls_through`,
  `default_rule_catches_the_rest`, `manual_mode_has_no_default`, `on_shift_members_come_first`,
  `round_robin_wraps_after_cursor`, `least_loaded_breaks_ties_by_round_robin`, `rep_filters_apply_only_to_known_facts`,
  `excluded_users_are_skipped`, `unknown_fact_never_matches_non_empty_list`.
- [ ] `cargo test -p jt_inbox` green; **commit** `feat(inbox): recipient kind, prospect source and distribution
  choice`.
- As built (2026-11-03, `87e30c1a`): `choose(rules, default: DefaultRule, facts, candidates, exclude)` with
  `DefaultRule::{Off, On { cursor }}` (spec D43) instead of a `bool`; `RepProfile { user_id, accepting, max_open,
  languages, cities, sectors, hours, away_until, updated_at }` with `default_for` and `takes_new(now,
  open_owned)`; `Cause::{key, parse, ALL}`, `Method::{key, parse}`, `SourceKind::{key, ALL}`,
  `LeadFacts::source_only`, `RecipientKind::{key, parse, ALL}`, `fold` (Turkish-aware) exported; a rep's own
  filters narrow known facts only. Test `stored_rules_and_profiles_read_tolerantly`, `fold_is_turkish_aware`.

### Task L3-T2: migration 0021, ports, repos, fakes; `leads_policy`

**Files:** `rust/migrations/0027_distribution.{up,down}.sql` (spec §4.2, the assignment immutability trigger),
`jt_app/src/ports/{distribution,mod}.rs` (`RepProfileRepo`, `RuleRepo`, `AssignmentRepo`; `PersonRepo`
reads/writes `recipient_kind` and gains `set_recipient_kind`), `jt_pg/src/repos/{distribution,inbox/people}.rs`,
fakes, `jt_testkit/src/distribution_contract.rs`, pins (tables 79 → 82, migrations 18 → 19).

- `AssignmentRepo::touch(journey, user, at)` sets `acted_at` on the live row only if its `user_id = user` and
  `acted_at` is null; returns whether it did.
- [ ] **Contract tests:** `one_live_assignment_per_journey`, `supersede_then_insert_in_one_bundle`,
  `touch_marks_only_the_owner_once`, `due_sla_lists_unacted_past_due`, `ownerless_open_excludes_closed_and_owned`,
  `rules_replace_all_keeps_positions_unique`, `rep_profile_default_when_absent`, `recipient_kind_round_trips`; Postgres only: `assignment_rows_refuse_other_updates_and_deletes`.
- [ ] CI green; **commit** `feat(distribution): rules, rep profiles and the assignment log`.
- As built (`d0783934`): pins tables 79 → 82, migrations 19 → 20 (0018 is on the base). `journey_assignments`
  cascades with its journey (the trigger refuses any other delete), checks the member against the cause
  (`journey_assignments_user_check`) and a due time against a member, and has the extra indexes
  `journey_assignments_journey` and `journey_assignments_log`. Ports (`ports/distribution.rs`): `AssignmentRow`,
  `AssignmentQuery`/`AssignmentPage`/`AssignmentCursor`, `OwnerlessScope { Undecided, All }`, `Ownerless { count,
  oldest_journey_id }`, `assignment_row_valid`; `RepProfileRepo { get (default when absent), list, set }`,
  `RuleRepo { list, replace_all(rules, at), set_cursor -> bool }`, `AssignmentRepo { live, insert, supersede,
  touch, due_sla(now, max_reassignments, limit), count_stalled(now, max), ownerless_open(scope, limit),
  count_ownerless, previous_assignees, reassignments, default_cursor, open_owned, list }` (spec D44, D45).
  `PersonRepo::set_recipient_kind(id, kind, at)`. The fake records advisory locks in order
  (`InMemoryUow::lock_journal`). Every round-trip test that runs 0020's down runs 0021's first.

### Task L3-T3: `prospects.promote`

**Files:** `jt_app/src/usecases/prospects/promote.rs` (`promote` the use case, `promote_one(deps, ctx, r, id) ->
PromoteOutcome` the per-prospect transaction body that L4-T5's enrollment reuses), `inbox/people.rs`
(`match_or_create` takes an optional `recipient_kind` for new people and sets `company`; `PersonOut.prospect`),
`inbox/context.rs` (context `prospect`), `inbox/erasure.rs` (scrub the linked prospect; blocklist hashes for its
hard keys only, spec D28: its Instagram and TikTok handles, phone and email being the erased-identity hashes;
never its domain or name_city), `jt_app/tests/prospects_promote.rs`. The catalog row comes in L3-T5.

L1 review notes (2026-11-03) for this task: `inbox.people.erase` also clears the **unlinked** prospects holding
that person's phone or email (scrub, or delete when the person's erasure says the business must not be
re-collected, with erased hashes of their hard keys) and forgets their request keys
(`RequestKeyRepo::forget("prospects.create:", "prospect_id", id)`); `set_promoted` answers `Promoted::{Ok,
NotPromotable, PersonAlreadyLinked}`, which promotion turns into `refused {not_qualified | already_promoted |
person_already_linked}` outcomes; the promotion request key stores the ids only.

Per spec §3.5; sketch of the transaction:
```rust
let mut r = deps.uow.tenant(ctx.workspace_id).await?;
r.people().lock_workspace().await?; r.people().set_write_time(ctx.now).await?;
r.prospects().lock_pool().await?;
let p = r.prospects().lock(id).await?.ok_or_else(not_found)?;
eligible_for_promotion(&p, ctx, &policy)?;                  // status, agents_promote_qualified_only, daily cap
let identities = promotion_identities(&p)?;                 // deliverable email/phone with evidence
recheck_blocklist_and_erasure(deps, r.as_mut(), &p).await?;
let out = people::match_or_create(deps, ctx, r.as_mut(), people::CreateInput {
    display_name, identities, source: Source::Prospect { prospect_id: p.id.as_uuid(), origin: origin_key(&p) },
}, None).await;                                             // identity_split → commit the suggestion, refuse this one
let journey = journey_for(deps, ctx, r.as_mut(), &out.person).await?; // open → reuse; Lost → refuse; Won → Repeat
people::set_business_if_unknown(r.as_mut(), out.person.id).await?;
r.prospects().set_promoted(p.id, &Promotion { person_id, journey_id, at: ctx.now, score, bucket }).await?;
distribution::assign(deps, ctx, r.as_mut(), &journey, Cause::Rule).await?;   // L3-T4; a stub that records no_eligible until then
record(..."prospects.promoted"...).await?; r.commit().await?;
```
- [ ] **Tests first:** `promote_creates_person_journey_and_links`, `promoted_person_is_business_with_company`,
  `no_consent_is_recorded`, `agent_cannot_promote_new`, `human_can_promote_new`,
  `existing_person_with_open_journey_is_reused`, `existing_lost_journey_refuses`, `existing_won_opens_repeat`,
  `identity_split_commits_suggestion_and_refuses`, `undeliverable_email_is_not_an_identity`,
  `no_identity_refuses`, `promotion_cap_per_local_day`, `batch_reports_per_item_outcomes`,
  `blocklisted_since_creation_refuses`, `context_shows_prospect_facts`, `erasing_the_person_scrubs_the_prospect_and_blocks_its_handles`,
  `promotion_takes_inbox_then_pool_lock` (a fake that records lock order).
- [ ] Green; **commit** `feat(prospects): promotion into the inbox`.
- As built (`ef85b14c`, with L3-T4: promotion runs distribution inline, distribution reads the linked
  prospect): `PromoteInput { prospect_ids (1..=50), request_key }` → `PromoteOut { items: [PromoteOutcome ::
  Promoted { prospect_id, person_id, journey_id, created_person, owner_id } | AlreadyPromoted { .. } | Refused {
  prospect_id, reason, details } ] }` (serde tag `outcome`); a repeated id is promoted once; `promote_one(deps,
  ctx, id, request_key)` is the per-prospect body. `people::match_or_create_with(.., Option<NewPerson { company,
  recipient_kind }>)` beside the unchanged `match_or_create`; `dedupe::blocked` re-checks erased identities and
  objection hashes (spec D48); `ProspectSummary { prospect_id, business_name, entity_kind, sector, city, district,
  segment_key, language, origin, research_task_id, evidence: [FieldEvidence { field, sources, captured_at,
  deliverable }], signals, latest_score, reasons, promotion }` in `ContextOut.prospect` and `PersonOut.prospect`
  (`promote::summary_for`); `blocklist::on_person_erased` (spec D46). Decisions D46–D49. Tests in
  `jt_app/tests/prospects_promote.rs`, plus `an_individual_stays_an_individual`, `request_key_replays_the_promotion`,
  `erasing_a_person_deletes_unlinked_prospects_holding_its_phone`.

### Task L3-T4: distribution use cases, the `lead_distribution` job, hooks, work items

**Files:** `jt_app/src/usecases/{distribution,hours}.rs` (move `within_hours`/`local_day` from `calls.rs` and add
`add_working_minutes`; `calls.rs` calls them; its tests unchanged), `inbox/journeys.rs` (`assign_owner` writes a
`manual` decision; `report` touches), `inbox/{tasks,context}.rs` and the note path (touch), `calls.rs`
(`place` touches), `inbox/replies.rs` (`record_result_in` touches for `Author::Human`), `inbox/context.rs`
(`release_member` writes `member_left` rows), `jobs.rs` (`Job::LeadDistribution` `"lead_distribution"`, 1 min),
`work.rs` (`OwnerlessJourneys`, `AssignmentStalled`), `jt_app/tests/distribution.rs`.

- `assign(deps, ctx, r, journey, cause)`: builds `LeadFacts` (source kind, linked prospect facts), candidates
  (active members with `inbox.work` from roles, profiles, `open_owned` counts, `on_shift` through
  `hours::within_hours`), calls `choose`, writes `journeys.assign_owner` + a decision row (superseding the live
  one), updates the rule cursor, computes `sla_due_at` with `add_working_minutes` in the owner's hours (none →
  wall-clock minutes), ledger `distribution.assigned` or `distribution.no_eligible`.
- Job body per active workspace: (1) up to 200 open journeys with no owner and no live decision → `assign` with
  cause `rule`/`default` (an imported journey — `Source::V1Import` — gets an `import` decision with no owner
  instead); (2) `due_sla(now, 200)` → reassign excluding previous assignees, cause `sla_reassign`, at most
  `max_reassignments`; past it leave the owner and count it stalled. Each journey in its own transaction (inbox
  lock), so a long run never holds a connection across many decisions.
- `distribution.get`, `rules_set` (replace all, positions 0..n, validates member ids are active, SLA bounds),
  `rep_set` (own profile with `inbox.work`; others with `inbox.manage`), `assignments_list`, `backfill {limit ≤
  200}`.
- [ ] **Tests first:** `every_creation_path_ends_owned_or_counted` — one test creating journeys through the
  consumer (inbound WhatsApp fixture), `inbox.people.create`, `inbox.journeys.open`, lead ads (`leadgen`),
  promotion, v1 import, member removal and merge undo, then one job tick: each is owned, or `no_eligible`/`import`
  and counted in `ownerless_journeys`; `solo_owner_gets_everything_without_setup`, `manual_mode_raises_work_item`,
  `rules_route_by_city_and_source`, `capacity_and_away_skip_members`, `on_shift_preferred`,
  `sla_counts_only_working_minutes` (tz `Europe/Istanbul` and a third zone), `owner_reply_marks_acted`,
  `agent_reply_does_not_mark_acted`, `reassign_after_sla_excludes_previous`, `stalled_after_max_reassignments`,
  `manual_assignment_has_no_sla_and_supersedes`, `member_left_rows_written`, `backfill_is_capped`,
  `rep_can_edit_only_own_profile`, `calls_hours_behaviour_unchanged` (the existing calls tests stay green).
- [ ] Green; **commit** `feat(distribution): rule-based assignment, SLA reassignment, never silent`.
- As built (`ef85b14c`, one commit with L3-T3): `usecases::distribution::{get, rules_set, rep_set,
  assignments_list, backfill, run}` with `RuleInput`, `RulesSetInput { rules, mode?, max_reassignments? }`,
  `RepSetInput` (whole replacement, spec D50), `RepOut`, `DistributionOut`, `AssignmentsListInput`,
  `AssignmentsOut`, `BackfillInput`, `Distributed { assigned, no_eligible, imported, reassigned, kept }`;
  `assign_in(deps, ctx, r, journey, import_waits)` (inline and job), `record_manual`, `record_member_left`,
  `touch` (spec D51; the reply touches when a person enqueues it). `hours::{within, add_working_minutes}`; the
  calls fence's local day is now `hours::local_day` (a clock-change day is 23 or 25 hours, as the pool's).
  `Job::LeadDistribution` (`Job::ALL` 30 → 31, 1 min). `WorkKind::{OwnerlessJourneys { count,
  oldest_journey_id }, AssignmentStalled { count }}` (priority 2, `inbox.manage`, cleared by
  `inbox.journeys.assign_owner`). Two L2 work hints held runs of spaces (lost line continuations): fixed. Tests
  in `jt_app/tests/distribution.rs`; the plan's `owner_reply_marks_acted` is `owner_acts_mark_acted` (a note;
  a person's reply touches in `enqueue_in`), and the consumer and lead-ads paths of
  `every_creation_path_ends_owned_or_counted` are covered by the job (they create ownerless journeys like a
  person created by hand).

### Task L3-T5: surfaces and pins for promotion, distribution and `inbox.people.set_kind`

L2 note (spec D42): this task also adds `WorkKind::ProspectsToPromote { count }` (priority 3, cleared by
`prospects.promote`, `count_qualified_unpromoted`) to `work.pending`, with the test
`prospects_to_promote_counts_qualified`.

**Files:** catalog (`prospects.promote`, 5 `distribution.*`, `inbox.people.set_kind`),
`jt_mcp/src/tools/{prospects,distribution,inbox}.rs`, `jt_panel_http/src/routes/{prospects,distribution,inbox}.rs`,
pins (+7: catalog 188 → 195; `("prospects", 14)` → 15; `("distribution", 5)`; inbox 46 → 47), `inbox_rules.rs`,
`gate_rule.rs`, `jt_mcp/tests/inbox_mcp.rs`, `twin_parity.rs`.
- [ ] **Tests first:** pins red; parity cases; `promote_tool_answers_per_item_outcomes`,
  `set_kind_records_note_in_ledger_without_value`.
- [ ] Green; **commit** `feat(distribution): promotion and distribution tools and routes`.
- As built (`b25d0df4`): pins catalog 187 → 194, registry 158 → 165, `POST_M4_ADDED` 33 → 40, `("prospects",
  14)`, `("distribution", 5)`, inbox 46 → 47. `inbox.people.set_kind { kind }` answers the person; the same kind
  again records nothing; ledger `inbox.person.kind_set {person_id, from, to}` (spec D52 for its gate).
  `WorkKind::ProspectsToPromote { count }` (`PoolPending.to_promote`). Parity
  `promotion_distribution_and_the_recipient_kind_answer_the_same_over_the_panel_and_mcp`.

---

## L4 — Outreach

### Task L4-T1: `jt_outreach` domain crate

**Files:** `rust/crates/domain/jt_outreach/{Cargo.toml,src/*.rs,tests/*.rs}`; `DOMAIN_CRATES` gains
`("jt_outreach", &["jt_inbox", "jt_capability", "jt_prospects", "url"])`.

Template grammar (hand-written parser, no regex crate): `{{` name (`|` fallback)? `}}`; names as `Var`; fallback
1..=80 chars without `{`/`}`; `{{` without a close or a lone `}}` is an error; a literal brace pair is written
`{{"{{"}}` (documented, rare). Links: `http://` or `https://` up to whitespace, trailing `.,;:!?)]'"` trimmed;
any other scheme-like token (`javascript:`, `data:`) in the body is refused.

`render`: substitute; subject must stay one line ≤ 200 chars after substitution (`HeaderUnsafe` otherwise);
rewrite links when `link_url` is given (only the snapshot's `links`, by index); append the footer for the step's
language.
- [ ] **Tests first** (`tests/template.rs`): `parses_vars_and_fallbacks`, `unknown_var_is_refused`,
  `unbalanced_braces_are_refused`, `custom_keys_are_bounded`, `links_are_found_and_trimmed`,
  `non_http_schemes_are_refused`; (`tests/render.rs`) `missing_value_without_fallback_is_an_error`,
  `fallback_is_used`, `subject_newline_from_a_value_is_unsafe`, `links_rewritten_only_from_snapshot`,
  `variable_urls_are_left_alone`, `footer_tr_and_en`, `footer_source_line_depends_on_basis`; (`tests/campaign.rs`)
  every `campaign_next` pair, `edit_voids_approval`, `resume_requires_current_approval`,
  `validate_definition_bounds` (steps 1..=6, first delay 0, others 1..=30, throttle bounds, window valid);
  (`tests/throttle.rs`) `warmup_schedule_and_cap`, `warmup_disabled_is_unbounded`, `frequency_gap_and_window`,
  (`tests/links.rs`) `mac_inputs_differ_by_purpose_and_link`; (`tests/fence.rs`) `refusals_in_order`.
- [ ] `cargo test -p jt_outreach` green; **commit** `feat(outreach): templates, campaigns and throttles (pure)`.
- As built (`a9523fcc`, spec D54–D58), contract changes: `CampaignEvent::{Launch { approval_required, now },
  Approve { revision, now }, Start { now }, Pause { reason: PauseReason }, Resume { approval_required, now },
  Complete, Cancel, Edit}` with `key()`; `PauseReason::{Manual, BounceRate, Complaints, MailboxDown,
  StrategyChanged}`; `CampaignError::{Invalid { field, reason }, Transition { from, event }, StaleRevision,
  NotYet}`; `requires_approval(policy, mailbox)`; `validate_campaign_name`, `validate_template_name`;
  `TemplateError::{Invalid { field, reason }, UnknownVariable { field, name }}` with `field()`/`reason()`;
  `RenderError` gains `FooterIncomplete` (a blank or multi-line footer value) and `TemplateInvalid` (a stored
  snapshot that no longer parses); `Footer::render(lang)`; `Var` serialises as its key (`Var::parse`,
  `custom_key`); `OwnerFilter::{User { user_id }, Unowned}`; `Definition`, `Step`, `Schedule`, `Throttle`,
  `Audience` and both filters refuse unknown fields (a step carries no attachments). Beyond the contracts:
  `warmup_day_index(days, today)` (an idle stretch over 30 days starts again), `BudgetInput`/`budget`
  (`⌈per_hour / 60⌉` a run), `domain_ok`, `DOMAIN_POSTPONE`, `auto_pause(newest_first)`, `SendOutcome` (with
  `can_become`, `left_the_mailbox`), `next_step_after(steps, sent, sent_at)`, `validate_personalization`,
  `unsubscribe_path`/`click_path`, `MAC_BYTES`, `launch_fence(platform_enabled, sender_identity_complete)`
  (F2 then F10), and `OutreachPolicy { requires_approval, b2b_basis, require_iys_lookup, legal_ack:
  Option<LegalAck { counsel_confirmed, note, by, at }>, sender_company, sender_address, privacy_notice_url,
  warmup, frequency, click_tracking_default }` with `b2b_channels()` (none without the counsel's
  confirmation; email only, `B2B_BASIS_CHANNELS`) and `sender_identity_complete()`. `StopReason` serialises as
  its key (`refused:<key>`, `missing_variable:<key>`). `report.rs` is not built here: the repository's
  `StepCounts` (L4-T3) are the counts, and L4-T6 adds the report rows it needs. Tests beyond the plan's:
  `lengths_and_lines_are_bounded`, `the_footer_is_never_blank`, `a_future_start_schedules_and_start_waits_for_it`,
  `approval_is_bound_to_the_revision`, `definitions_refuse_unknown_fields_and_round_trip`,
  `warmup_day_index_counts_earlier_send_days_and_resets_after_idle`, `budget_takes_the_smallest_remainder`,
  `auto_pause_on_bounces_and_complaints`, `public_paths_name_the_workspace_the_send_and_the_mac`,
  `a_locked_platform_refuses_whatever_else_holds`, `approval_counts_only_when_required`, the policy tests
  (`b2b_basis_is_off_by_default`, `b2b_channels_need_the_counsel_confirmation_and_are_email_only`,
  `sender_identity_needs_company_address_and_a_privacy_link`) and the enrollment tests
  (`stop_and_skip_keys_are_stable`, `the_next_step_follows_the_delays`, `send_outcomes_move_forward_only`,
  `personalization_is_bounded`).

### Task L4-T2: commercial basis and `OutreachSent`

**Files:** `jt_inbox/src/{consent,fence,journey,lib}.rs`, `jt_inbox/tests/{compliance,reducer}.rs`,
`jt_app/src/usecases/inbox/replies.rs` (`fence` computes `consent_ok` through `commercial_basis` with
`person.recipient_kind` and `leads_policy.outreach.b2b_basis`; the stored fence snapshot gains `basis`).

- [ ] **Tests first:** `commercial_basis_matrix` (consent explicit/implied/withdrawn/none × suppression on/off ×
  kind unknown/business/individual × channel in/out of `b2b_channels`), `withdrawal_beats_business_basis`,
  `commercial_allowed_unchanged` (the old function's tests still pass), `outreach_sent_is_rank_neutral`,
  `outreach_sent_duplicate_key_is_suppressed`, `outreach_sent_after_terminal_is_a_noop_like_replied`;
  (`jt_app/tests/inbox_replies.rs`) `business_basis_off_by_default_refuses_izin_yok`,
  `business_basis_on_allows_email_only`, `basis_recorded_in_fence_snapshot`.
- [ ] Green; **commit** `feat(inbox): business-recipient basis and the OutreachSent event`.
- As built (`370893a3`, spec D53, D58, D60): `CommercialBasis::key()` (`consent`, `business_recipient`);
  `commercial_allowed` is `commercial_basis(.., Unknown, &[])` (its tests unchanged);
  `commercial_basis` fails closed on rows of more than one person, consents and suppressions alike.
  `OutreachSent` after closure is a no-op for the system like `Replied`. The **full `OutreachPolicy` lands
  here**: `LeadsPolicy.outreach: jt_outreach::OutreachPolicy` (read key by key). The platform switch is
  `PlatformAppConfig::outreach_enabled()`, default `false` (`FakeAppConfig.outreach_enabled`); reading
  `JEETA_OUTREACH_ENABLED` in `bin/jeeta`'s config lands with the launch that needs it (L4-T4), so the
  binary stays off until then. The reply fence takes a `Sending { author, intent, outreach_enabled }`
  and answers `Option<CommercialBasis>` (`None` for a reply); the business channels are
  `OutreachPolicy::b2b_channels()` only while the switch is on (D53); the claim's fence snapshot gains
  `basis` (`null` for a reply). `FooterSource: From<CommercialBasis>` (D58). Tests as named, in
  `jt_inbox/tests/{compliance,reducer}.rs` and `jt_app/tests/inbox_replies.rs`.

### Task L4-T3: permissions, migration 0022, ports, repos, fakes

L1 review note (2026-11-03): every outreach request key (campaign saves, launches, enrollments, sends) stores
the ids it recorded only, and a replay reads the rows again (rule "request keys store ids"); an erasure, an
unsubscribe or a do-not-contact mark forgets the matching keys.

**Files:** `jt_tenancy/src/role.rs` (`OutreachWork`, `OutreachManage`), `rust/migrations/0026_outreach.{up,down}.sql`
(spec §4.3, role backfill), `jt_app/src/ports/outreach.rs`, `jt_pg/src/repos/outreach/{mod,templates,campaigns,
enrollments,sends}.rs`, fakes, `jt_testkit/src/outreach_contract.rs`, pins (tables 82 → 86, migrations 19 → 20,
permissions).

```rust
#[async_trait] pub trait EnrollmentRepo: Send + Sync {
    async fn insert_many(&mut self, rows: &[EnrollmentRow]) -> Result<InsertReport, AppError>; // one-active-per-person conflicts → skipped(active_elsewhere)
    async fn due(&mut self, campaign: CampaignId, now: OffsetDateTime, limit: u32) -> Result<Vec<EnrollmentRow>, AppError>; // skip locked, materialized CTE
    async fn advance(&mut self, id: EnrollmentId, next_step: u8, next_send_at: Option<OffsetDateTime>, sent_at: OffsetDateTime) -> Result<(), AppError>; // None → completed
    async fn postpone(&mut self, id: EnrollmentId, until: OffsetDateTime) -> Result<(), AppError>;
    async fn stop(&mut self, id: EnrollmentId, reason: &StopReason, at: OffsetDateTime) -> Result<bool, AppError>;
    async fn stop_all_for(&mut self, person: PersonId, reason: &StopReason, at: OffsetDateTime) -> Result<u32, AppError>;
    async fn active_for(&mut self, person: PersonId) -> Result<Option<EnrollmentRow>, AppError>;
    async fn personalize(&mut self, id: EnrollmentId, values: &BTreeMap<String, String>) -> Result<(), AppError>;
    async fn list(&mut self, campaign: CampaignId, q: &EnrollmentQuery) -> Result<Page<EnrollmentRow>, AppError>;
    async fn count_active(&mut self, campaign: CampaignId) -> Result<u32, AppError>;
}
#[async_trait] pub trait OutreachSendRepo: Send + Sync {
    async fn insert(&mut self, row: &SendRow) -> Result<(), AppError>;
    async fn by_outbox(&mut self, outbox: Uuid) -> Result<Option<SendRow>, AppError>;
    async fn get(&mut self, id: SendId) -> Result<Option<SendRow>, AppError>;
    async fn set_outcome(&mut self, id: SendId, outcome: SendOutcome, at: OffsetDateTime) -> Result<(), AppError>;
    async fn mark_replied(&mut self, id: SendId, threaded: bool, at: OffsetDateTime) -> Result<bool, AppError>;
    async fn latest_for_person(&mut self, person: PersonId, since: OffsetDateTime) -> Result<Option<SendRow>, AppError>;
    async fn click(&mut self, id: SendId, automated: bool, at: OffsetDateTime) -> Result<(), AppError>;
    async fn unsubscribed(&mut self, id: SendId, at: OffsetDateTime) -> Result<(), AppError>;
    async fn count_mailbox_since(&mut self, mailbox: CapabilityId, since: OffsetDateTime) -> Result<u32, AppError>;
    async fn count_campaign_since(&mut self, campaign: CampaignId, since: OffsetDateTime) -> Result<u32, AppError>;
    async fn count_domain_since(&mut self, mailbox: CapabilityId, domain: &str, since: OffsetDateTime) -> Result<u32, AppError>;
    async fn person_send_times(&mut self, person: PersonId, since: OffsetDateTime) -> Result<Vec<OffsetDateTime>, AppError>;
    async fn mailbox_send_days(&mut self, mailbox: CapabilityId, tz_offset_query: &DayQuery) -> Result<Vec<Date>, AppError>; // for warm-up day_index
    async fn recent_outcomes(&mut self, campaign: CampaignId, n: u32) -> Result<Vec<SendOutcome>, AppError>;
    async fn report(&mut self, q: &ReportQuery) -> Result<Vec<ReportRow>, AppError>;
}
```
- [ ] **Contract tests:** `one_active_enrollment_per_person`, `due_skips_locked_and_future`, `advance_completes_after_last`,
  `stop_all_for_stops_only_active`, `send_outcome_written_once_per_transition`, `counts_by_window`,
  `domain_counts_by_mailbox`, `report_groups_by_step`; Postgres only: `concurrent_due_picks_never_overlap`.
- [ ] CI green; **commit** `feat(outreach): tables, permissions and repositories`.
- As built (`f3f5ec49`, spec D59): `Permission::{OutreachWork, OutreachManage}` after the pool's two (owner and
  manager through `Permission::all()` and the 0022 backfill; rep none); the panel's `Permission` union and its
  `permissions.*` labels are not pinned by a Rust test and wait for L8. Pins: tables 82 → 86, migrations 20 → 21
  (versions gain 22), `studio_rules` 86, `sql_scoping` lists the four tables; every `migrations.rs` test that
  runs 0020's or 0021's down runs 0022's first (`outreach_down`, `TABLES_BEFORE_OUTREACH`); new
  `outreach_migration_is_repeatable_and_grants_only_the_system_owner_and_manager` and
  `outreach_enrollment_checks_hold`. Ports (`ports/outreach.rs`), contract changes: rows `TemplateRow {
  template, created_by: Actor, updated_at }`, `CampaignRow { id, name, mailbox_id, status, definition,
  revision, approval, pause_reason, strategy_version_id, created_by: Actor, created_at, updated_at,
  launched_at, completed_at }` (`campaign_row_valid`), `EnrollmentRow { .., status, stop: Option<StopReason>,
  skip: Option<SkipReason>, next_step, next_send_at, personalization, basis: Option<CommercialBasis>, .. }`
  (`enrollment_row_valid`, `enrollment_reason`: the stored `reason` is the stop or skip key), `SendRow`;
  `TemplateRepo { insert, get, lock, update(row, expected_revision) -> bool, list(TemplateQuery) }`;
  `CampaignRepo { insert (mailbox and strategy version of the workspace, else NOT_FOUND), get, lock,
  update(row, expected_revision) -> bool, list(CampaignQuery), by_status(status, limit) }` (one revision-checked
  write for saves and state changes, instead of `save`/`set_status`); `EnrollmentRepo { insert_many ->
  InsertReport { inserted, active_elsewhere, already_enrolled }, get, due, advance -> bool, postpone -> bool,
  stop, stop_all_for, stop_campaign, active_for, personalize -> bool, list, count_active }` (`stop_campaign`
  is new, for a cancel); `OutreachSendRepo { insert, get, by_outbox, set_outcome -> bool (only as
  `can_become` allows; a first `sent` keeps its time), mark_replied, latest_for_person (not refused), click
  (NOT_FOUND without the send), unsubscribed, count_mailbox_since, count_campaign_since, count_domain_since,
  person_send_times, recent_outcomes, report(ReportQuery { campaign_id, from, to }) -> Vec<StepCounts> }`
  (counts per campaign and step by current outcome; L4-T6 groups them by campaign or template).
  `mailbox_send_days` is not built here: the warm-up's local days need the window's time zone, which the
  dispatcher (L4-T5) has; it can count them from `count_mailbox_since` per day or add the method then.
  `TenantRepos::{outreach_templates, outreach_campaigns, outreach_enrollments, outreach_sends}` in every
  impl. Postgres in `jt_pg/src/repos/outreach.rs` (`due`: a materialized CTE `for update skip locked`;
  `insert_many`: `on conflict do nothing`, then the row again as skipped `active_elsewhere`); the fake in
  `jt_testkit/src/fakes/outreach.rs` (counts from its rows). Contract tests (`outreach_contract.rs`, run by
  `outreach_fakes.rs` and `outreach_repos.rs`): the plan's eight (`due_skips_locked_and_future` covers the
  future and inactive rows; locks are Postgres's) plus `templates_round_trip_and_are_revision_checked`,
  `campaigns_round_trip_and_are_revision_checked`, `rows_are_workspace_scoped`; Postgres only
  `concurrent_due_picks_never_overlap`.

### Task L4-T4: templates and campaigns

**Files:** `jt_app/src/usecases/outreach/{mod,templates,campaigns,audience,settings}.rs`,
`jt_app/tests/outreach_campaigns.rs`.

- `templates_save {template_id?, expected_revision?, name, language, subject, body}` (create or new revision,
  `validate_template`), `templates_archive`, `templates_list`.
- `campaigns_save {campaign_id?, expected_revision?, name, mailbox_id, definition}`: mailbox must be a `mailbox`
  capability of the workspace; `validate_definition`; templates must exist and be unarchived; only in
  `Draft`/`Paused`; bumps revision, voids approval.
- `audience_preview {definition.audience, mailbox_id}` → counts `{eligible, by_skip_reason: {..}, basis:
  {consent, business_recipient}, promotions_needed}` computed with the same function enrollment uses (L4-T5), no
  write.
- `campaigns_launch {expected_revision}`: F2 (platform switch from `deps.apps`/config: `outreach_enabled()`), F10,
  `requires_approval` → `campaign_next(Launch)`; snapshots each step (template revision, subject, body, links,
  language); `Scheduled` when `start_at` is in the future, else `Running`; enrollment (L4-T5) runs in the same use
  case after the status write (its own transactions, ≤ 500 people each).
- `campaigns_approve {expected_revision}`: human with `outreach.manage`, else `human_required`.
- `campaigns_control {action: pause | resume | cancel}`: resume re-checks approval; cancel stops active enrollments
  (`campaign_canceled`) and needs `outreach.manage`.
- `settings_get/set`: `OutreachPolicy`; `b2b_basis` and `require_iys_lookup` need a human whose role is `owner`
  and `legal_ack {counsel_confirmed: true, note}` (ledger `outreach.b2b_basis_set`).
- [ ] **Tests first:** `template_save_validates_and_versions`, `campaign_save_bumps_revision_and_voids_approval`,
  `save_refused_while_running`, `mailbox_must_be_a_mailbox`, `launch_refused_when_platform_disabled`,
  `launch_refused_without_sender_identity`, `launch_without_approval_runs`, `launch_with_policy_approval_waits`,
  `manager_launch_approves_in_one_call`,
  `mailbox_requires_human_approval_forces_approval`, `agent_cannot_approve`, `stale_revision_approval_refused`,
  `resume_after_edit_needs_new_approval`, `snapshot_freezes_template_content`, `cancel_needs_manage`,
  `b2b_basis_only_by_human_owner_with_ack`, `preview_counts_match_enrollment`.
- [ ] Green; **commit** `feat(outreach): templates, campaigns, approval and settings`.
- As built (`1f7d78b9`, spec D64, D65): `usecases::outreach::{templates, campaigns, audience, settings}`
  with `templates_save(TemplateSaveInput { template_id?, expected_revision?, name, language, subject, body,
  request_key? }) -> TemplateOut { template, facts, updated_at }` (`TemplateFacts` serialises), `templates_archive`,
  `templates_list(TemplateListInput { include_archived, limit, before_at, before_id })`; `campaigns_save
  (CampaignSaveInput { campaign_id?, expected_revision?, name, mailbox_id, definition, request_key? }) ->
  CampaignOut { campaign, approval_required, active_enrollments, enrollment? }`, `campaigns_get`, `campaigns_list
  (CampaignListInput { status, limit, before_at, before_id })`, `campaigns_launch(id, LaunchInput {
  expected_revision })`, `campaigns_approve(id, ApproveInput { expected_revision })`, `campaigns_control(id,
  ControlInput { action: pause | resume | cancel })`; `audience_preview(PreviewInput { audience, mailbox_id }) ->
  PreviewOut { eligible, by_skip_reason, basis { consent, business_recipient }, promotions_needed,
  business_basis_in_force, truncated }`; `settings_get/set(SettingsInput)` -> `SettingsOut { ..OutreachPolicy,
  sender_identity_complete, platform_enabled, b2b_channels_in_force }`. Request keys (creations only) store
  `{template_id}`/`{campaign_id}`. A campaign needs an approved strategy version (`strategy_required`) and is made
  under it. `campaigns_get`/`campaigns_list` are built here (the rows come in L4-T7). New: `JourneyRepo::list_open
  (after, limit)` (both adapters) for the people filter; `jt_outreach::validate_audience` is public;
  `bin/jeeta` reads `JEETA_OUTREACH_ENABLED` (`EnvPlatformApps.outreach_enabled`, a start log line, `.env.example`,
  README table). The single lock test file is `jt_app/tests/outreach_lock.rs`; the campaign tests are in
  `outreach_campaigns.rs` with the shared fixture `tests/support/outreach.rs`. `launch_refused_when_platform_disabled`
  is in the lock file; `preview_counts_match_enrollment` lands with L4-T5 (`enroll_skips_with_reasons`); beyond
  the plan: `resume_and_approval_refused_when_platform_disabled`, `settings_bounds_and_the_stored_warmup_are_checked`,
  `preview_counts_by_skip_reason_and_basis`.

### Task L4-T5: enrollment, personalization and the dispatcher

**Files:** `jt_app/src/usecases/outreach/{enroll,dispatch,links}.rs` (links: URL builders only here; routes in
L5), `inbox/replies.rs` (`Target::PersonVia`, `Purpose::Outreach`, `prepare` unchanged here), `jobs.rs`
(`Job::OutreachDispatch` `"outreach_dispatch"`, 1 min), `ports/connectors.rs` (`ConsentSync::search` default
body), `jt_netgsm/src/lib.rs` (implement `search` over `iys_search`), `work.rs` (`PersonalizationDue`,
`CampaignBlocked`, `CampaignApproval`, `PromotedNotContacted`), `jt_app/tests/outreach_dispatch.rs`.

- `enroll {audience: true | person_ids | prospect_ids, personalization?}`: resolves people (prospect filters
  promote first through `prospects::promote::promote_one`, capped), computes skip reasons, `insert_many`, ledger
  `outreach.enrolled {count, skipped}`.
- `personalize {items: [{enrollment_id, values}] ≤ 100}`: keys must be `custom.*` vars used by the campaign.
- Dispatcher per spec §3.11, sketch:
```rust
for campaign in running_campaigns(&mut r).await? {
    let budget = budgets(deps, &mut r, &campaign, now).await?;          // window, mailbox day, warm-up, hour, pacing
    if budget == 0 { continue; }
    let due = { let mut t = tenant(); let rows = t.outreach_enrollments().due(campaign.id, now, budget).await?; t.commit().await?; rows };
    for e in due {
        match precheck(deps, &campaign, &e, now).await? {             // stop / postpone / ok (iys lookup before any tx)
            Pre::Stop(reason) => stop(deps, &e, reason).await?,
            Pre::Postpone(until) => postpone(deps, &e, until).await?,
            Pre::Ok(basis) => {
                let outbox = enqueue(deps, &campaign, &e, basis, now).await;  // one tx: enqueue_in + outreach_sends + advance
                match outbox { Ok(id) => { replies::send_step(deps, &system_ctx, id).await.ok(); }
                               Err(e) if e.code == Forbidden => stop(deps, &e_row, Refused(reason(&e))).await?,
                               Err(other) => return Err(other) }
            }
        }
    }
    auto_pause_if_needed(deps, &campaign).await?;
}
```
- The outreach `enqueue` takes the inbox lock, rechecks `outreach_fence`, then calls `enqueue_in(...,
  Target::PersonVia(person, campaign.mailbox_id), ReplyInput { intent: Commercial, subject, text, in_reply_to,
  references, request_key: Some(format!("outreach:{}:{}", enrollment, step)) }, Purpose::Outreach(&send))`; the
  request key makes a crash-and-rerun idempotent.
- `enqueue_in` for `Purpose::Outreach`: author `System`; fence with `by_agent = true` (human hold applies);
  refuses `journey_won`; sets `intent.outreach`, `mail.from_name`, `mail.list_unsubscribe`; never takes the
  0019 `held` branch (test added there or here, whichever lands second, spec §4.6).
- `claim` re-runs `outreach_fence` from the intent's `outreach` ids (campaign running, approval, blocklist,
  inbound since enrollment, meeting) — both branches (bug class "partial invariant enforcement").
- [ ] **Tests first:** `enroll_skips_with_reasons`, `enroll_promotes_qualified_prospects_within_cap`,
  `one_active_enrollment_across_campaigns`, `personalize_only_custom_vars_of_the_campaign`,
  `dispatch_respects_window_and_mailbox_hours`, `dispatch_respects_daily_hourly_and_pacing_budgets`,
  `warmup_limits_new_mailbox_and_resets_after_idle`, `domain_pacing_postpones`, `frequency_cap_across_campaigns`,
  `missing_variable_stops_with_reason`, `personalization_due_raised_within_24h`,
  `refused_at_enqueue_stops_enrollment` (IZIN_YOK, do_not_contact, human holds), `refused_at_claim_too`
  (state changed between enqueue and claim: each of F3, F5, F6, F7, F8, F9), `stop_rules_hold_without_hooks`
  (hooks disabled in the fake: a reply, a meeting and a won journey still stop at dispatch),
  `same_thread_step_replies_to_previous_message_id`, `rerun_after_crash_is_idempotent`,
  `send_uses_named_mailbox_even_with_two`, `auto_pause_on_bounce_rate`, `auto_pause_on_complaints`,
  `iys_lookup_caches_and_refuses_ret`, `iys_lookup_unavailable_without_capability`, `iys_budget_8_per_minute`,
  `no_provider_io_inside_a_transaction` (the fake connector asserts no open bundle when called).
- [ ] Green; **commit** `feat(outreach): enrollment and the dispatcher on the outbox`.
- As built (`62dc640c`, spec D66–D70; the footer rule D62/D63 first, `0e19fc2d`): `usecases::outreach::{enroll,
  dispatch}`: `enroll(id, EnrollInput { audience | person_ids | prospect_ids }) -> EnrollOut { campaign_id,
  enrolled, skipped, already_enrolled, promoted, waiting_for_promotion, truncated }` (a scheduled, running or
  paused campaign, else `not_enrollable`; launch and the approval that starts a campaign enroll its audience
  themselves, `CampaignOut.enrollment`), `personalize(PersonalizeInput { items: [{ enrollment_id, values }] })
  -> PersonalizeOut { updated }` (1..=100; keys with or without `custom.`; `unused_key`; ledger
  `outreach.personalized {count}`); `dispatch::run(deps, ctx) -> Dispatched { started, campaigns, queued, stopped,
  postponed, paused, completed, iys_lookups }`, `dispatch::facts`, `dispatch::claim_fence`. `replies`:
  `Target::PersonVia(person, capability)` (a verified, sealed mailbox, else `capability_down`), `Purpose::Outreach
  (&OutreachSend { outbox_id, send_id, enrollment_id, campaign_id, step, from_name, language })` (the outbox id is
  chosen first so click links can name it; intent `outreach {send_id, enrollment_id, campaign_id, step}`,
  `use_case: "outreach.dispatch"`, gated), `Sending.outreach` (a human's hold stops it, `journey_won` refuses it),
  `MailMessage.from_name` = the campaign's sender name; the claim runs `claim_fence` before the inbox fence.
  `Target`, `Purpose` and `enqueue_in` are `pub(crate)`. `Job::OutreachDispatch` `"outreach_dispatch"` (1 min,
  active workspaces, nothing while the switch is off; `Job::ALL` 32 -> 33, scheduler interval and its test,
  `jt_app/tests/jobs.rs`). `ConsentSync::search(cred, recipient, channel) -> IysAnswer { Granted, Refused, Absent }`
  (default `Permanent`; NetGSM over `iys_search`; `ScriptedConnector::push_consent_search`,
  `ConnectorCall::ConsentSearch`); `jobs::iys_credentials`/`iys_credential` factored out of the İYS sync;
  `OutreachSendRepo::mailbox_send_days(mailbox, tz, since)` (both adapters, contract
  `mailbox_send_days_are_local_days`); `hours::local_date`. The four outreach work items move to L4-T7 (D69), with
  `personalization_due_raised_within_24h`. Tests in `jt_app/tests/outreach_dispatch.rs` (23) and the lock file:
  the plan's names, with `warmup_limits_a_new_mailbox` (the idle reset is `jt_outreach`'s
  `warmup_day_index_counts_earlier_send_days_and_resets_after_idle`), `refused_at_claim_too` covering a paused
  campaign, a reply and the blocklist (the other fences are the inbox fence's own tests), plus
  `an_outreach_email_goes_through_the_outbox_with_its_footer_and_sender_name` and
  `a_mailbox_that_is_down_pauses_the_campaign`; `no_provider_io_inside_a_transaction` is not built (the fakes model
  no open bundle to assert on): the dispatcher commits before `send_step` and before the İYS lookup by
  construction. Lock tests added: `the_dispatcher_sends_nothing_while_locked`,
  `a_queued_outreach_intent_is_refused_at_claim_while_locked`,
  `a_business_recipient_without_consent_is_skipped_while_the_b2b_basis_is_off`. Not here (L4-T6): the receipt
  (`OutreachSent` instead of `Replied`, the send row's outcome; until then an outreach receipt applies `Replied`
  and the send row stays `queued`), the hooks, the reports. `test_send` is L4-T7's.

### Task L4-T6: stop hooks and reports

**Files:** `jt_app/src/usecases/outreach/{hooks,report}.rs`; calls from `inbox/consumer.rs` (`message`,
`mail_evidence`, consent withdrawal), `inbox/replies.rs` (`record_result_in`: `OutreachSent` instead of `Replied`
for outreach intents, `on_receipt` sets `sent`/`failed`/`unknown`), `inbox/journeys.rs` + `consumer::apply_from` +
`appointments::book` (`on_journey_event`), `inbox/erasure.rs` (`on_erased`), `inbox/merge.rs` (`on_merged`),
`prospects/report.rs`, `jt_app/tests/{outreach_hooks,prospects_report}.rs`.

- [ ] **Tests first:** `threaded_reply_marks_that_send`, `unthreaded_reply_marks_latest_within_30_days`,
  `reply_stops_every_active_enrollment_of_the_person`, `reply_makes_conversation_ours_and_reply_due`,
  `bounce_marks_send_stops_and_flags_prospect_email`, `complaint_counts_for_auto_pause`,
  `withdrawn_consent_stops`, `meeting_booked_stops`, `won_and_lost_stop`, `erasure_stops_and_keeps_ids`,
  `merge_stops_source_enrollments`, `outreach_receipt_keeps_journey_new`, `our_answer_after_reply_moves_to_contacted`,
  `outreach_report_counts_by_step_and_template`, `prospects_report_groups_by_bucket_at_promotion`,
  `won_revenue_grouped_per_currency`, `report_ranges_are_half_open`.
- [ ] Green; **commit** `feat(outreach): stop hooks and reports`.
- As built (`77bddf08`, spec D71, D72): `usecases::outreach::hooks::{on_receipt, on_inbound,
  on_bounce, on_withdrawn, on_suppressed, on_journey_event, on_erased, on_merged}` (crate-private), called from
  `replies::save_result` (every outbox result: `sent` at its send time, `failed`, `unknown`, `refused`; the
  claim's refusals and the merge's included), `consumer::message` (any channel; `In-Reply-To` for email),
  `consumer::mail_evidence` (before the evidence settles the entry), `consumer::consent_event` and
  `consent::record_consent` (withdrawn), `consent::add_suppression` (a manual email suppression,
  `refused:suppressed`), `journeys::report`, `consumer::apply_from`, `appointments::enqueue`, `erasure::erase`
  and `merge::apply`. `record_result_with` applies `OutreachSent {campaign_id, step}` for an outreach intent.
  New ports: `EnrollmentRepo::for_person(person)` (by id) and `ProspectRepo::report_rows(from, to, limit)`
  (created or promoted in the range, oldest first, `MAX_REPORT_ROWS` 10,000), both adapters, asserted in the
  contracts `stop_all_for_stops_only_active`, `rows_are_workspace_scoped` and `status_promotion_and_counts`.
  Reports: `usecases::outreach::report::{report, ReportInput {campaign_id?, from, to, group_by: campaign |
  step | template}, ReportOut, ReportGroup}` and `usecases::prospects::report::{report, ReportInput {from, to,
  group_by: source | research_task | segment | sector | city | score_bucket | rubric_digest}, ReportOut,
  ReportGroup, Rates}`, both through `usecases::report_range` (`MAX_REPORT_DAYS` 366); no
  `jt_outreach/report.rs`. `prospects.report`'s row, tool and `GET /api/prospects/report` land here (catalog
  227, registry 189, `POST_M4_ADDED` 64, `("prospects", 15)`, README, parity
  `the_pool_report_answers_the_same_over_the_panel_and_mcp`); `outreach.report`'s row with L4-T7. Tests: the
  plan's names in `outreach_hooks.rs` (14) and `prospects_report.rs` (3), plus
  `a_refused_claim_marks_the_send_refused`; `refused_at_enqueue_stops_enrollment` now writes Cem's withdrawal
  straight to the repos (the hook would stop the enrollment first), and the dispatcher's first test reads the
  receipt's `sent`. D67's open point (rewinding a step lost to a claim's refusal) is not built: the send row
  says `refused` and the report counts it.

### Task L4-T7: outreach surfaces and pins

**Files:** catalog (18 `outreach.*` rows), `jt_mcp/src/tools/outreach.rs`, `jt_panel_http/src/routes/outreach.rs`,
pins (+18: catalog 195 → 213; `("outreach", 18)`), parity, gate, `outreach_mcp.rs`.
- [ ] **Tests first:** pins red; `test_send_only_to_a_members_login_address` (and refused to any other address),
  parity for each row; MCP descriptions name `JEETA_OUTREACH_ENABLED` and the B2B basis.
- [ ] Green; **commit** `feat(outreach): outreach tools and routes`.
- As built (`32f4c61b`, spec D73–D75): the 18 rows of §7.1 (all `Gated`, its routes and risks exactly:
  no `Destructive` row, so the twin rule's destructive list is unchanged), `jt_mcp/src/tools/outreach.rs`
  (the descriptions of every tool that can lead to a send name `JEETA_OUTREACH_ENABLED`,
  `outreach_disabled_on_platform`, the business-recipient basis and the counsel's confirmation; the approval's
  `human_required`; the settings' `owner_required` and `legal_ack`), `jt_panel_http/src/routes/outreach.rs`;
  `jt_mcp` and `jt_panel_http` now depend on `jt_outreach` (its ids). New use cases:
  `enrollments_list(campaign, EnrollmentListInput {status?, limit?, after?}) -> {items, next}` (the panel's
  shape), `enrollments_stop(id, StopInput {})` (`manual`; `CONFLICT not_active {status}`), `test_send(campaign,
  TestSendInput {step?, to?}) -> TestSendOut {to, step, message_id, state}` (D73; `replies::Purpose::TestSend`,
  `TestSend`, `Sending.test`, `test_send::claim_check`). Work items (D69, D75): `usecases::outreach::work::
  pending_in` and `WorkKind::{PersonalizationDue {campaign_id, count}, CampaignBlocked {campaign_id, reason},
  CampaignApproval {campaign_id, revision}, PromotedNotContacted {count}}`. Pins: catalog 245, registry 207,
  `POST_M4_ADDED` 82, `("outreach", 18)`, README table. Tests: `test_send_only_to_a_members_login_address`,
  `an_outreach_email_on_a_mailbox_requiring_approval_is_never_held` (spec §4.6, 0019 being in),
  `personalization_due_raised_within_24h`, `the_outreach_work_items_name_who_clears_them`,
  `promoted_not_contacted_counts_prospects_nobody_wrote_to` (`outreach_dispatch.rs`), the lock file's
  `a_test_email_is_refused_while_locked` (at the use case and at claim), `jt_mcp/tests/outreach_mcp.rs` (risks,
  permissions, schemas, the lock and basis words, named tools registered), parity
  `outreach_answers_the_same_over_the_panel_and_mcp`. For L5-T2: a test email's unsubscribe link names its outbox
  entry like any commercial email's (D63) and leads to the member's own inbox person; its click links are not
  rewritten; `outreach_sends.by_outbox` answers none for it.

---

## L5 — Public endpoints and mail headers

### Task L5-T1: `MailMessage` headers in `jt_mail`

**Files:** `jt_app/src/ports/connectors.rs` (`MailMessage.from_name`, `list_unsubscribe`, `attachment_files`, all
`#[serde(default)]` so stored intents still read), `jt_mail/src/smtp.rs`, `jt_mail/tests/mail.rs`.

- `From`: `Mailbox::new(Some(name), address)` when `from_name` is set (CR/LF or > 80 chars → `Permanent`).
- `List-Unsubscribe: <https…>, <mailto…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` as lettre custom
  headers (V-L1: check the pinned lettre version's `Header` trait before writing them).
- [ ] **Tests first:** `outreach_headers_are_on_the_wire` (the in-process SMTP fixture reads them back),
  `from_display_name_is_encoded`, `header_injection_in_name_or_urls_is_refused`,
  `old_intents_without_new_fields_still_send`.
- [ ] Green; **commit** `feat(mail): sender name and one-click unsubscribe headers`.
- As built (`8a2c6df4`): `MailMessage.{from_name, list_unsubscribe: Option<ListUnsubscribe { https, mailto:
  Option }>, attachment_files: Vec<Uuid>}`, each `#[serde(default, skip_serializing_if = ..)]` (a stored intent
  reads and writes back unchanged). `smtp::wire` writes `From` with the name (lettre's `Mailbox::new`, RFC 2047
  encoded), and `List-Unsubscribe`/`List-Unsubscribe-Post` as lettre 0.11 raw headers
  (`HeaderValue::new(HeaderName::new_from_ascii_str(..), ..)`, which encodes and folds). Refused before any
  connection: a name that is blank, over 80 characters or holds a control character; an unsubscribe address that is
  not an `https` URL with a host (or, for the fallback, not `mailto:`), or holds spaces, controls, `<`, `>` or `,`,
  or is over **900 bytes** (stricter than §8's 2,048: one header line holds it whole). Tests as named, in
  `jt_mail/tests/mail.rs`. L5-T2 must honour D63 (see the spec): token = the outbox entry id; MAC purposes
  `outreach.unsubscribe` and `outreach.click`; `usecases::outreach::links::verify`; a token's outbox entry leads to
  the conversation and the person, and `outreach_sends.by_outbox(token)` to an outreach send (its campaign's
  snapshot links for a click).

### Task L5-T2: unsubscribe and click routes

**Files:** `jt_app/src/usecases/outreach/links.rs` (`unsubscribe_page`, `unsubscribe`, `click` taking
`(ws, send_id, mac, ...)`; MAC with `deps.seal.hmac_key(ws, "outreach.unsubscribe"|"outreach.click")` and
`mac_input`, constant-time compare), `jt_webhook/src/{links,lib}.rs` (routes merged in `router`),
`jt_app/src/usecases/inbox/consumer.rs` (`mailto` subject `unsubscribe`), `jt_webhook/tests/links.rs`,
`jt_app/tests/outreach_links.rs`.

- Routes as spec §3.14; workspace status ignored for unsubscribe; HTML with escaped text, `Cache-Control:
  no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; style-src
  'unsafe-inline'; form-action 'self'`; body limit 1 KiB on `POST`.
- [ ] **Tests first:** `get_shows_page_and_never_unsubscribes`, `post_one_click_unsubscribes_without_cookies`,
  `post_from_page_form_unsubscribes`, `repeat_post_is_idempotent`, `bad_mac_is_404_and_writes_nothing`,
  `unknown_send_is_404`, `suspended_workspace_still_unsubscribes`, `erased_person_answers_200_and_reveals_nothing`,
  `unsubscribe_writes_suppression_consent_stops_and_ledger`, `mailto_subject_unsubscribe_is_honoured`,
  `click_redirects_to_snapshot_link`, `click_unknown_link_is_404`, `click_within_60s_is_automated`,
  `head_is_automated`, `click_disabled_campaign_has_no_rewritten_links`, `no_client_data_stored`.
- [ ] Green; **commit** `feat(outreach): one-click unsubscribe and click redirect`.
- As built (`614eeecd`, fix `1f6b8ccf`; spec D76–D78): `usecases::outreach::links::{unsubscribe_page(deps, ws,
  token, mac), unsubscribe(..)} -> Option<LinkPage {lang, sender_company}>` and `click(deps, ws, token, link, mac,
  ClickFrom {head, user_agent}) -> Option<String>` take the path's raw segments (the token is the outbox entry id,
  D63, not a send id; `None` is the route's `404`); `unsubscribed_by_mail` (crate) for the consumer's
  `consent_event`; `hooks::on_unsubscribed`; `AUTOMATED_CLICK_WINDOW`, `MAIL_UNSUBSCRIBE_WINDOW`,
  `UNSUBSCRIBE_ACTOR`; `Lang` re-exported for the adapter. `replies::OutreachSend.links` (intent
  `outreach.links`, D78). `jt_webhook::links` (`UNSUBSCRIBE_BODY_LIMIT`, `PAGE_POLICY`, `escape`), its routes merged
  in `router`; `jt_panel_http::security_headers` keeps a policy that forbids framing (D76). `jt_webhook`
  dev-depends on `jt_inbox`, `jt_outreach`, `jt_strategy`, `serde`, `uuid`: its `tests/links.rs` includes
  `jt_app/tests/support`. No catalog row, tool, permission or pin changes (public routes, no caller). Tests: the
  plan's names (13 in `jt_webhook/tests/links.rs`, with `a_suspended_workspace_still_redirects_and_records_nothing`,
  `an_unsubscribe_body_over_1_kib_is_413_and_writes_nothing`,
  `the_pages_escape_the_sender_company_and_follow_the_footer_language`; 3 in `jt_app/tests/outreach_links.rs`, with
  `a_click_goes_where_the_emails_own_link_went_even_after_an_edit`, `an_inbox_commercial_email_unsubscribes_its_person`,
  `a_test_emails_link_unsubscribes_the_members_inbox_person`, `a_link_that_does_not_hold_writes_nothing`,
  `an_erased_recipient_answers_the_page_and_writes_nothing`), the lock file's
  `the_public_links_only_ever_reduce_what_may_be_sent`, `jeeta`'s
  `the_public_links_are_served_outside_the_panel_checks_with_their_own_policy`, and (the fix: a `&dyn Fn` held
  across an await made the dispatcher's future non-`Send`, which only `jeeta`'s build saw)
  `every_job_run_can_move_between_threads` in `outreach_dispatch.rs`.

After L5 is deployed, the operator may set `JEETA_OUTREACH_ENABLED=1` on staging for the smoke (L9) and on
production only after spec §15 Q1 is answered.

---

## L6 — Attachments

### Task L6-T1: migration 0023, `MailFileRepo`, the `attachment` file purpose

**Files:** `rust/migrations/0028_mail_files.{up,down}.sql`, `jt_app/src/ports/mail_files.rs`,
`jt_pg/src/repos/inbox/mail_files.rs`, fake, `jt_testkit/src/mail_files_contract.rs`, `jt_files/src/{lib,serve}.rs`
(purpose `attachment`: signature v2 with the purpose; response headers of spec §3.15), pins (tables 86 → 87,
migrations 20 → 21).
- [ ] **Tests first:** contract `insert_link_attach_purge`, `rows_are_workspace_scoped`; `jt_files/tests/serve.rs`
  `attachment_purpose_forces_download_headers`, `attachment_address_does_not_verify_as_device`.
- [ ] CI green; **commit** `feat(inbox): mail file records and download-only file addresses`.
- As built (`67a054d1`, spec D80–D82): `rust/migrations/0028_mail_files.{up,down}.sql` (§4.4's table with the checks of
  D80; the down is refused while a queued or held outbox entry names mail files), `jt_app::ports::mail_files`
  (`MailFileRow`, `MailFileDirection`, `MailFileState::holds_bytes`, `SkipReason`, `mail_file_row_valid`,
  `MAX_MAIL_FILE_PAGE`; `MailFileRepo { insert, get, lock, link_event_to_message, attach, for_messages,
  due_for_purge, mark_deleted, erase_person, erase_event, kept, inbound_bytes_since }`, D81) and
  `TenantRepos::mail_files` in every impl, `jt_pg/src/repos/inbox/mail_files.rs` (a refused check or foreign key
  is `INTERNAL`), `jt_testkit/src/fakes/mail_files.rs`, the contract `jt_testkit::mail_files_contract`
  (`insert_link_attach_purge`, `rows_are_workspace_scoped`, and
  `erasure_blanks_names_and_answers_the_files_to_delete`) run by `jt_testkit/tests/mail_files_fakes.rs` and
  `jt_pg/tests/mail_files_repos.rs`, and `mail_files_migration_is_repeatable_and_its_down_refuses_waiting_attachments`.
  `jt_files`: `ATTACHMENT_PURPOSE`, `ATTACHMENT_POLICY`, `DiskFiles::attachment_url`, the download headers of D82
  (`FileStore::attachment_url`, default refusing; `StreamedFile.filename`); tests as named in
  `jt_files/tests/serve.rs`. Pins: tables 100, migrations 28 (`versions()` `1..=28`); `outreach_down` runs 0028's
  down first (`TABLES_BEFORE_MAIL_FILES`), and so do the two inbox round trips and `PROSPECTS_DOWN`; README.

### Task L6-T2: inbound attachments

**Files:** `jt_app/src/ports/connectors.rs` (`PolledMail`, `InboundAttachment`; `MailboxPoller::poll` returns
`Vec<PolledMail>`), `jt_mail/src/{imap,parse}.rs`, `jt_app/src/usecases/jobs.rs` (`run_mail_inbox_poll`),
`jt_app/src/usecases/inbox/{attachments,consumer}.rs`, fakes (`jt_testkit` mailbox poller), `jt_mail/tests/mail.rs`,
`jt_app/tests/inbox_attachments.rs`.

- The poll job: for each non-sent draft, put attachments within caps **before** the storing transaction (Studio
  `Staging` pattern: delete stored files if the transaction fails or the draft is a duplicate), insert
  `mail_files` rows and the `file_id`s into the payload's attachment entries in the transaction.
- The consumer's `message` links `mail_files` of `(capability, event external id)` to the new message and person.
- [ ] **Tests first:** `poll_returns_attachment_bytes_for_inbox_mail_only`, `attachments_stored_as_octet_stream`,
  `caps_skip_with_reason` (file, count, daily bytes), `duplicate_draft_deletes_its_files`,
  `failed_transaction_deletes_its_files`, `consumer_links_files_to_message_and_person`,
  `messages_list_shows_attachments`, `payload_never_holds_bytes`.
- [ ] Green; **commit** `feat(inbox): keep inbound mail attachments`.
- As built (`627f4fdb`, spec D83, D84): `PolledMail { draft, attachments }` and `InboundAttachment { filename,
  declared_mime, bytes }` (no names or bytes in `Debug`), `From<InboundEventDraft> for PolledMail`;
  `MailboxPoller::poll -> (Vec<PolledMail>, MailboxCursor)`; `jt_mail::parse::polled` (the payload's entries gain
  `declared_mime`); `ScriptedConnector::push_mailbox_poll` keeps taking drafts, `push_mailbox_poll_mail` takes
  emails with bytes. `usecases::inbox::attachments::{PolledFiles {store, screen, record, commit_started, settle},
  AttachmentView, record_name, store_name, record_mime, MAX_INBOUND_FILE_BYTES, MAX_INBOUND_FILES,
  MAX_INBOUND_DAILY_BYTES, INBOUND_DAY}` (the plan's `store_polled_attachments`), called from
  `jobs::run_mail_inbox_poll`; `consumer::message` links, `consume_event` erases an erased sender's email's
  files; `MessageView.attachments`; `studio::files::cleanup_files` keeps `MailFileRepo::kept`. jt_mail's tests read
  drafts through a local `PollDrafts`. Tests: the plan's names in `jt_app/tests/inbox_attachments.rs` and jt_mail,
  plus `an_erased_senders_email_keeps_no_files` and `the_store_sweep_keeps_mail_files`.

### Task L6-T3: outbound attachments, erasure, purge

**Files:** `jt_app/src/usecases/inbox/{attachments,replies,quotes,erasure}.rs`, `jobs.rs` (`Job::MailFilesPurge`
`"mail_files_purge"`, 1 day), catalog (`inbox.attachments_upload`, `inbox.attachments_get`), MCP and routes, pins
(+2: catalog 213 → 215; inbox 47 → 49; Job::ALL reaches 33), `jt_app/tests/inbox_attachments.rs`.

- `upload` validates type by magic bytes, ≤ 7 MiB, `request_key` replay; `staged`, `expires_at = now + 7 d`.
- `reply`/`send`/`quotes.send` with `attachments`: email conversations only (`attachments_require_email`), ≤ 5,
  staged files of this workspace not yet attached; intent stores ids; `prepare` reads bytes through
  `deps.files.read` into `MailMessage.attachments` after the claim and before the provider call; the rows become
  `attached` with the message id in the result transaction.
- `get` answers metadata and `files.provider_url`-style signed address with purpose `attachment`, 10 minutes.
- Erasure: `ErasureRepo::scrub` blanks file names and returns ids; the use case deletes bytes after commit and
  marks rows `deleted`.
- Purge job: inbound past retention, staged past expiry.
- [ ] **Tests first:** `upload_checks_magic_bytes_and_size`, `attach_only_on_email`, `attach_at_most_five_and_within_message_bound`,
  `prepare_reads_bytes_and_intent_holds_ids_only`, `quote_with_attachment_sets_file_ref`,
  `get_answers_a_download_address`, `erasure_deletes_files`, `purge_respects_retention_and_staging`,
  `attachments_require_inbox_work`.
- [ ] Green; **commit** `feat(inbox): outbound attachments, erasure and retention`.
- As built (`9b47e88f`, spec D85–D89): `attachments::{upload(UploadInput {request_key, filename, mime, data_base64})
  -> AttachmentOut, get(file_id) -> AttachmentGetOut, staged_for_send, attached_for_claim, read_for_send, purge,
  bytes_fit, wire_bytes, message_fits}` and the constants `MAX_UPLOAD_BYTES`, `MAX_UPLOAD_BODY_BYTES`,
  `MAX_ATTACHMENTS`, `MESSAGE_BOUND_BYTES`, `HEADER_ROOM_BYTES`, `STAGED_FOR`, `DOWNLOAD_FOR`, `MAX_PURGE_BATCHES`,
  `UPLOAD_TYPES`, `DOCX`, `XLSX`. `ReplyInput.attachments`, `replies::SendInput.attachments`,
  `quotes::SendInput.attachments` (`#[serde(default)]`); files are attached at enqueue (D86, not in the result
  transaction); the claim checks them, `send_step` reads them (D87). Erasure through `erase_person` (D88).
  `Job::MailFilesPurge` `"mail_files_purge"` (daily, every status; `Job::ALL` 36, the scheduler's interval and its
  pin, README job table). Rows `inbox.attachments_upload` (`POST /api/inbox/attachments`, 10 MiB body) and
  `inbox.attachments_get` (`GET /api/inbox/attachments/{file_id}`), both `Exempt` and in `EXEMPT_INBOX`, MCP tools
  `jeeta.inbox.attachments_{upload,get}`, schemas (and `attachments` on reply, send and quotes.send); the reply,
  send, quotes and messages-list descriptions name the files. Pins: catalog 247, registry 209, inbox 55,
  `POST_M4_ADDED` 84; README rows. Tests: the plan's names in `inbox_attachments.rs` (18 there in all).

---

## L7 — v1 import

### Task L7-T1: routing, pool intake, rollback

L1 review note (2026-11-03): the rollback must unlink the promoted prospects it imported (or delete them, by
`promoted_person_id`) **before** `delete from people`: `prospects_person_fkey` has no on-delete rule, so a
`people` row a prospect still names cannot be deleted. Imported rejections carry their decision time
(`prospects_decided_check`); an imported key over 400 characters or a soft blocklist key is refused before the
write.

**Files:** `jt_app/src/usecases/v1_import.rs` (export v2 fields on `Lead`, `route`, `pool_intake`, notes for
activities and offers, owner mapping), `jt_app/src/ports/v1_import.rs` (`ImportRepos` gains
`member_by_email(&str) -> Option<UserId>`, `imported_prospect(lead) -> Option<ProspectId>`,
`untouched_prospect(id) -> bool`, `rollback_prospect(id) -> bool`), `jt_pg/src/v1_import.rs`,
`bin/jeeta/src/v1_import.rs` (unchanged flags; the report gains the new counts), `jt_app/tests/v1_import_routing.rs`,
`jt_pg/tests/m4_v1_import.rs` (extended).

```rust
pub enum Route { Inbox, Pool, SkipDeleted, SkipMerged }
pub fn route(l: &Lead) -> Route {
    if l.deleted_at.is_some() { return Route::SkipDeleted }
    if l.merged_into_id.is_some() { return Route::SkipMerged }
    if l.status != "NEW" || l.contact.as_ref().is_some_and(Contact::any) || INBOUND_SOURCES.contains(&l.source.as_str()) {
        return Route::Inbox
    }
    Route::Pool
}
const INBOUND_SOURCES: &[&str] = &["INSTAGRAM","WEBSITE","PHONE","EMAIL","ADS","REFERRAL","HARDWARE_QUOTE","FIELD_VISIT"];
```
- Pool intake builds a `Prospect` through `jt_prospects::build` with `Recorder::Import { system: "v1", record:
  lead.id }` (the importer is the one system actor allowed to write the pool), dedupe as `create` does (counts
  instead of errors), `v1-legacy` score row, DNC hashes for opt-outs, `deliverable = false` for bounced email,
  `purge_after` from the import time.
- Inbox route keeps today's code and adds activity notes, the offers note, tags/attribution/score lines, and the
  owner from `owner_email` with an `import` decision.
- [ ] **Tests first:** `route_table` (each row of spec §10), `contacted_new_lead_goes_to_inbox`,
  `inbound_source_new_lead_goes_to_inbox`, `research_lead_never_contacted_goes_to_pool`,
  `pool_prospect_carries_import_provenance`, `pool_duplicates_and_in_inbox_are_counted`,
  `opt_outs_become_dnc_hashes`, `bounced_email_is_undeliverable`, `activities_become_notes_except_status_change`,
  `offers_become_one_note_without_quotes`, `owner_mapped_by_email_or_left_for_backfill`,
  `dry_run_writes_nothing_and_reports_counts`, `rollback_removes_unchanged_prospects_and_keeps_touched`,
  `old_export_without_new_fields_still_imports_to_inbox` (format 1 compatibility), `report_holds_counts_only`.
- [ ] Green (CI for `jt_pg`); **commit** `feat(import): route v1 leads between the inbox and the pool`.
- As built (`58ac3067`, branch `feat/leads-import`): `Lead` gains the format-2 fields (all optional, nested
  structs `Contact`, `Activity`, `Offer`, `Attribution`, `Research` also `deny_unknown_fields`; `format` other than 2
  is `input_invalid`). `route` follows spec §10 and also sends a format-1 line and a format-2 line without a
  `contact` object to the inbox (D90). `run` gained `seal: &dyn SecretBox` (the blocklist's keyed hashes; the binary
  builds the serve `AesSecretBox` from `JEETA_SECRET_KEY`); inbox leads run before pool leads (D91). Pure
  `pool_record(ws, lead, now) -> Option<PoolRecord>` builds the prospect through `jt_prospects::build` and then sets
  every field's evidence to `SourceRef::Import`/`Recorder::Import` (D92); `Lead::{activity_notes, offers_note,
  dnc_keys}`, `owner_of`. **Contract changes:** `ImportRepos` gained nothing — members come from
  `memberships().list()`, the prospect checks and the prospect rollback use `prospects()` (D96);
  `usecases::prospects::{blocklist_hash_in, blocklist_fingerprint_in}` (seal + workspace) under the existing
  `blocklist_hash`/`blocklist_fingerprint`; `PgTenantRepos::untouched` also keeps a person a prospect is promoted
  to, an outreach enrollment or a mail file names (D97). `Report` gains `to_inbox`, `to_pool`, `pooled`,
  `skipped_deleted`, `skipped_merged`, `pool_duplicates`, `pool_in_inbox`, `pool_dnc`, `pool_blocked`, `pool_invalid`,
  `owners_mapped`, `owners_unmapped`, `activities_as_notes`, `offers_as_notes`, `prospects_rolled_back`,
  `prospects_kept` (27 counters, all numbers). No migration. Tests: `jt_app/tests/v1_import_routing.rs` (15, pure:
  the plan's names plus `imported_values_out_of_bounds_are_refused_before_the_write`); `jt_pg/tests/m4_v1_import.rs`
  gains `pool_duplicates_and_in_inbox_are_counted`, `opt_outs_become_dnc_hashes`,
  `dry_run_writes_nothing_and_reports_counts`, `rollback_removes_unchanged_prospects_and_keeps_touched`,
  `rollback_keeps_a_person_a_prospect_was_promoted_to`, `inbox_route_writes_activity_and_offer_notes_and_maps_the_owner`
  (CI only); every existing call passes `&PlainSecretBox`; the format-1 test (`exported_jsonl_…`, the unchanged
  `scripts/v1-export-leads.sql`) is `old_export_without_new_fields_still_imports_to_inbox`'s database half. The plan
  test names that are database behaviour (`dry_run_…`, `pool_duplicates_…`, `opt_outs_…`) exist in both files.


### Task L7-T2: export runbook and the staging dry run

**Files:** `docs/operations/v1-import.md` (the export query of spec Appendix B with the column check against
`schema.prisma`, file handling on the operator's machine, dry run, owner review, import, spot checks, rollback,
v1 read-only switch).
- [ ] Run the export against a **staging copy** of v1, `jeeta import-v1 --workspace … --input … --dry-run` against
  staging Rust; record only the counts in the PR description (no values).
- [ ] **Commit** `docs(import): the v1 lead export and import runbook`.
- As built (`bcf64a97`): `docs/operations/v1-import.md`. The export query lives in the runbook, not in
  `scripts/` (it must be re-checked against v1's schema at each export; the format-1 script stays for its test). It
  differs from Appendix B: deleted and merged leads are left out at export (D98), offers and `lastContactAt` are
  added, the attribution is `landingPath`/`referrerHost` only. A names-only column check against
  `information_schema` must print `0`. **The staging dry run was not run** (owner guardrail: no server work in this
  task); the coordinator runs §3 of the runbook after the cutover and records only counts.


---

## L8 — Panel

Each panel task lands after its backend phase; tests are vitest with `mockFetch`, Turkish strings from `tr.json`,
per-row pending state on every row action, one request key per draft, and the Enter guard.

### Task L8-T1: plumbing
**Files:** `api/{prospects,research,distribution,outreach}.ts`, `api/types.ts` (types with the Rust source in a doc
comment; `Permission` union + four keys; `WorkKind` + nine kinds), `App.tsx` routes, `layout/Shell.tsx` nav
("Aday havuzu", "Kampanyalar"), `i18n/{tr,en}.json` (`nav.*`, `permissions.*`), `layout/Shell.test.tsx`.
- [ ] Tests: `nav_lists_new_pages_for_permitted_users`, `permissions_copy_parity`; **commit** `feat(panel): leads
  plumbing`.
- As built (`f695cb31`, branch `feat/leads-panel`): `api/{prospects,research,distribution,outreach}.ts` wrap every
  §7.1 row of those four domains (the inbox rows are L8-T5's); `api/types.ts` holds their shapes, each naming its Rust
  source; `jt_prospects::Evidence` is `FieldEvidence` there (the capabilities' `Evidence` holds the name). The
  `Permission` union already had the pool's two keys (L1) and gains `outreach.work`/`outreach.manage` with their copy.
  `WorkKind` gains the nine kinds; the four outreach ones (`promoted_not_contacted`, `campaign_approval {campaign_id,
  revision}`, `campaign_blocked {campaign_id, reason}`, `personalization_due {campaign_id, count}`) follow spec
  §3.17 until L4-T7 builds them. Home gets a line of copy per new kind (without counts, through `itemText`'s default);
  their `itemLink`s and `home_renders_every_new_kind` stay L8-T5's. The menu's first permission-gated entries:
  "Aday havuzu" needs `prospects.work`, "Kampanyalar" `outreach.work`. Shapes assumed while the outreach use cases
  are missing (marked in `api/outreach.ts`): `GET .../campaigns/{id}/enrollments?status&limit&after` →
  `{items: EnrollmentRow[], next: EnrollmentId | null}` (the repository's `EnrollmentQuery`/`EnrollmentPage`);
  `POST /api/outreach/enrollments/{id}/stop` with `{}` (the panel reads the list again, never the answer);
  `POST .../campaigns/{id}/test` with `{}` (a wrapper only, no button); `GET /api/outreach/report?campaign_id&from&to&
  group_by` → `{group_by, rows: [{key, enrolled, skipped{}, sent, failed, bounced, complained, replied,
  replied_threaded, unsubscribed, clicked, automated_clicks, meetings, won, stopped{}}]}` (spec §3.16; no page until
  L8-T6). The outreach routes being added at §7.1's paths over `usecases::outreach` types need no change here.

### Task L8-T2: prospect pool and research tasks
**Files:** `pages/ProspectsPage.tsx` (pattern `PeoplePage` + `DataTable` from `TeamPage`), `pages/ProspectDetail.tsx`
(pattern `CallDetail`), `pages/ResearchTasksPage.tsx`, tests.
- [ ] Tests: `filters_and_paging`, `bulk_promote_shows_per_item_outcomes`, `reject_requires_reason`,
  `dnc_requires_typed_confirmation`, `erase_requires_SIL`, `evidence_links_open_safely`, `score_history_shows_reasons`,
  `task_progress_and_create_form`; **commit** `feat(panel): the prospect pool`.
- As built (`2f7c26b9`): `pages/{ProspectsPage,ProspectDetail,ResearchTasksPage,LeadsShared}.tsx`, `lib/leads.ts`
  (`useDraftKey`: one request key per draft, kept across a retry, dropped on an answer; `useInFlight`: the Enter guard;
  `webUrl`), `test/leads.ts` fixtures. The pool's filters are the five `prospects.list` takes (status, score bucket,
  research task, city, segment; it refuses unknown keys): spec §9's sector, label and text filters wait for
  `usecases::prospects::ListInput` to gain them. List rows carry no `origin.via`, so the "Kaynak" column says research task or direct.
  Bulk promote is one call (outcomes per item); bulk reject and do-not-contact run one call per prospect in turn and
  list each outcome (one prospect's refusal keeps its dialog open with the reason). Do-not-contact is confirmed by
  typing `ENGELLE`/`BLOCK`, erasure by `SİL`/`ERASE`; reopen and erase show only with `prospects.manage`, promote
  only with `inbox.work`. Recorders are named from `GET /api/agents` (connection `client_name`) and `GET /api/team`.
  A task's found count and newest prospects are read (`tasks_get`) when its progress disclosure opens.
  `lib/errors.ts` gives the pool's and research's refusal reasons panel copy (`leads.errors.*`). Tests beyond the
  plan's: `each_row_promote_has_its_own_pending_state`, `a_retried_promotion_reuses_its_request_key`,
  `reject_from_a_row_needs_a_reason`, `reject_enter_cannot_double_submit`,
  `the_reject_draft_resets_when_the_prospect_changes`, `erase_and_reopen_need_prospects_manage`,
  `create_enter_cannot_double_submit`, `each_claim_has_its_own_pending_state`, `names_the_leads_refusals`.

### Task L8-T3: distribution
**Files:** `pages/DistributionPage.tsx` (a tab on Team), tests.
- [ ] Tests: `rules_reorder_and_save`, `rep_can_edit_only_own_row`, `ownerless_count_and_backfill`, `assignment_log`;
  **commit** `feat(panel): lead distribution`.
- As built (`fab4da29`): `pages/DistributionPage.tsx` at `/team/distribution`; Team and it share `TeamTabs` (shown with
  `inbox.work`). Rules move with up/down buttons (no drag); match lists are typed comma separated (`ListInput` keeps
  the text as typed); rules, mode and reassignment limit save whole with `inbox.manage`, everyone else sees them
  read-only; the draft is rebuilt only when the stored rules change, never on a refetch. The rep table's edit button
  is on one's own row with `inbox.work` and on every row with `inbox.manage`; the editor is keyed by the member and
  sends the whole profile (`RepSetInput` replaces it, so hours and away time go back as they are unless changed).
  Backfill is `inbox.manage`'s and shows the `Distributed` counts; the log filters by member and pages by its cursor.
  The inbox's "Sahipsiz" queue link waits for L8-T5. Tests beyond the plan's:
  `rules_save_enter_cannot_double_submit`, `rep_editor_resets_when_another_member_is_chosen`.

### Task L8-T4: outreach
**Files:** `pages/{OutreachPage,OutreachCampaign,OutreachTemplates,OutreachSettings}.tsx`, tests.
- [ ] Tests: `template_editor_renders_sample_and_footer`, `unknown_variable_error_shown`, `audience_preview_skip_reasons`,
  `launch_blocked_reasons_shown`, `approval_card_for_managers_only`, `b2b_section_owner_only_with_ack`,
  `enrollment_stop_per_row`, `deliverability_warning_shown`; **commit** `feat(panel): outreach campaigns`.
- As built (`039c80bc`): `pages/{OutreachPage,OutreachCampaign,OutreachTemplates,OutreachSettings,OutreachShared}.tsx`,
  `lib/outreach.ts`; routes `/outreach`, `/outreach/new`, `/outreach/:id`, `/outreach/templates`, `/outreach/settings`.
  The lock is said on every outreach page while `platform_enabled` is false; launch and resume are disabled with
  their blockers listed (platform switch, sender identity) and a server refusal is shown in the panel's words. The
  campaign list has no progress counts (`CampaignRow` carries none): enrolled/sent/replied/unsubscribed wait for
  `outreach.report` (L4-T6, L8-T6). The template preview runs a TypeScript copy of `jt_outreach`'s grammar and of
  `Footer::render`'s TR/EN lines (`lib/outreach.ts`, preview only; footer.rs and it change together); unknown
  variables are named before a save and from a refused one. The audience preview asks `audience_preview` 400 ms
  after the last edit once a mailbox is chosen. The approval card's button is for `outreach.manage` (the panel's
  caller is always a person); the B2B section shows for role `owner` with `outreach.manage` and sends `legal_ack`
  whenever the save opens the basis or turns the İYS lookup off. Enrollment rows carry ids only, so they link to the
  person and the prospect; each row's stop is its own mutation. Not built here: test send (no button), personalization
  editing, the report tab (L8-T6). Tests beyond the plan's: `template_editor_resets_on_template_change`,
  `a_new_template_is_saved_once_with_its_request_key`, `a_new_campaign_is_saved_with_its_steps_and_one_request_key`,
  `the_lock_is_said_while_the_platform_switch_is_off`, `general_settings_save_once`, `campaigns_with_status_and_the_lock`.

### Task L8-T5: inbox and home
**Files:** `pages/InboxJourneyPanel.tsx` (prospect facts, sequence, recipient kind, assignment history),
`pages/InboxConversation.tsx` (attachments, composer upload, reset on conversation change), `pages/InboxPage.tsx`
("Sahipsiz" queue), `pages/HomePage.tsx` (`itemText`, `itemLink` for the nine kinds), tests.
- [ ] Tests: `prospect_facts_in_journey_panel`, `stop_sequence_from_inbox`, `attachment_chip_downloads`,
  `composer_attachment_resets_on_conversation_change`, `home_renders_every_new_kind`; **commit** `feat(panel): leads
  in the inbox and home`.

### Task L8-T6: reports
**Files:** `pages/LeadsReport.tsx`, the campaign report tab, tests.
- [ ] Tests: `grouping_selector`, `local_day_ranges_sent_as_instants`, `revenue_per_currency_never_summed`;
  **commit** `feat(panel): lead and outreach reports`.

---

## L9 — Smoke and runbooks

### Task L9-T1: `make smoke-leads`
**Files:** `jt_app/tests/smoke_leads.rs`, `rust/Makefile` (`smoke-leads: cargo test --locked -p jt_app --test
smoke_leads`).
- [ ] The scripted flow of spec §11 "Smoke", in process (fakes + in-process SMTP/IMAP fixtures as `jt_mail/tests/support`),
  asserting headers, footer, reply stop, Contacted after our answer, unsubscribe effects and report numbers.
- [ ] `jt_archtest/tests/leads_rules.rs` gains `playbook_tools_exist_in_the_catalog` (every `jeeta.*` name in
  `jt_prospects::playbook::TEXT` is an MCP tool of the registry), now that every tool it names exists.
- [ ] **Commit** `test(leads): end-to-end smoke`.

### Task L9-T2: operator runbooks
**Files:** `docs/operations/leads-outreach.md` (enabling `JEETA_OUTREACH_ENABLED`, SPF/DKIM/DMARC checklist for
the customer's domain with V-E1/V-E2 to verify, warm-up, auto-pause handling, blocklist export before a down
migration, the legal checklist of spec §12).
- The blocklist's keyed hashes cannot be rebuilt (spec D36): a hash is computed from a value that is gone, so a
  change of the platform master key (or of the `prospects.blocklist` HMAC derivation) orphans every entry of the
  old key and silently lifts every objection. The runbook says: never rotate the master key without a plan for
  the blocklist; before any key change, count the entries per key fingerprint
  (`BlocklistRepo::key_fingerprints`) and keep the old key available until the owner decides.
- [ ] **Commit** `docs(operations): leads and outreach runbook`.

### Task L9-T3: purge expired request keys (L1 review, spec D33)
Request keys are kept until a later request reuses the key; nothing deletes an expired one (inbox's included).
**Files:** `jt_app/src/ports/inbox.rs` (`RequestKeyRepo::purge_expired(before) -> u64`), both adapters and the
contract, `jobs.rs` (`Job::PurgeRequestKeys` `"purge_request_keys"`, daily, every workspace whatever its status),
`bin/jeeta/src/scheduler.rs`, the job pins. Expired = `at <= now - 24 h`.
- [ ] **Tests first:** `purge_request_keys_deletes_only_expired`, `purge_request_keys_runs_in_suspended_workspaces`.
- [ ] Green; **commit** `feat(jobs): purge expired request keys`.
- As built (`fb8db71d`, spec D79): `RequestKeyRepo::purge_expired(before) -> u64` deletes `at <= before`;
  `ports::inbox::REQUEST_KEY_TTL` (24 hours); both adapters, contract `inbox_contract::request_keys_purge_expired`
  (fakes and Postgres). `jobs::run_purge_request_keys`, `Job::PurgeRequestKeys` `"purge_request_keys"` last in
  `Job::ALL` (34 -> 35), `Intervals::purge_request_keys` (a day) and the schedule pin, the README job table. Tests
  as named, in `jt_app/tests/jobs.rs` (the second also covers a workspace that cannot be reached).

---

## Self-review against the spec and the requirements

| Requirement (owner's brief) | Where |
|---|---|
| No external API; agents research with own tools; channels are the customer's | spec D2, §3.8, Appendix A; plan global constraints (no egress host), L1–L2 |
| Separate pool; promotion makes person + journey | spec D1, D8, §3.5; L1, L3-T3 |
| AI completes processes; approval only where turned on | spec D7 (auto-qualify), D11, D19, §3.17 (`promoted_not_contacted`, `prospects_to_promote`); L4-T4 |
| Pool fields, mandatory provenance, statuses | spec §3.1, §3.2, D4; L1-T1, L1-T4 |
| Dedupe keys vs pool and inbox | spec §3.3, D5; L1-T4 |
| Score + reasons + rubric version | spec §3.4, D7; L1-T5, L2-T1 |
| Promotion: provenance, consent none, business flag, İYS, lawyer points | spec §3.5, §3.12, §12; L3-T3, L4-T2 |
| KVKK: minimisation, retention, purge, erasure, DNC surviving purge, ledger | spec §3.6, D9, §3.18; L1-T5, L3-T3 |
| Research tasks from ICP or by human/agent; caps; work queue; playbook | spec §3.7, §3.8, §3.17; L2 |
| Distribution: rules, capacity, hours, availability, SLA, override, never silent | spec §3.9, D11; L3-T4 |
| Bulk email: templates, unsubscribe, sender identity, audiences, campaigns, throttles, warm-up, sequences with stops | spec §3.10–3.11, D12–D16; L4 |
| Fences: İYS/consent, suppression, unsubscribe link + RFC 8058, bounces, hours | spec §3.11 table, §3.12, §3.14; L4-T5, L5 |
| Content by the agent, approval rule, tracking without third parties, no pixel | spec D12, D19, D20; L4-T4, L5-T2 |
| Reporting per campaign/step/template | spec §3.16; L4-T6, L8-T6 |
| Attachments inbound and outbound | spec §3.15, D21; L6 |
| Learning loop | spec §3.16, Appendix A "Learning"; L4-T6 |
| v1 import split, provenance, dry run | spec §10, D23; L7 |
| Migrations 0020+, RLS, catalog/archtest pins, Job::ALL, tables | spec §4, §7.3; each phase's pin step |
| Consistency with the parallel design (`held`, counts, channels) | spec §4.6, §3.13 |

Checks made against the code at `958fcfe3` while writing this plan:
- `people::match_or_create` creates a journey for every new person (`journeys::initial`), so promotion needs no
  second journey path; `journeys::open` holds the Won → `Repeat` and Lost → `reopen_required` rules reused here.
- `record_result_in` applies `Replied` on every successful send (hence `OutreachSent`, L4-T2).
- `enqueue_in`'s `Target::Person` refuses two verified mailboxes (`ambiguous send capability`), hence
  `Target::PersonVia`.
- `MailMessage` has no header fields and `smtp::wire` writes `From` from the credential only (L5-T1).
- `jt_mail::parse` keeps attachment `filename` and `size` only; `inbox_mask_personal` already blanks `attachments`.
- Capability `daily_ops_cap` and `active_hours` are enforced only by calls and Studio today; outreach enforces them
  for its sends without changing inbox replies.
- `/files` serves the stored `Content-Type` with `nosniff` and no `Content-Disposition` (L6-T1 adds the purpose).
- Domain crates cannot depend on `chrono-tz` (`DOMAIN_ALLOW`), so working-hours arithmetic lives in
  `jt_app::usecases::hours`.
- The importer's `Lead` is `deny_unknown_fields`; new export fields are added as known optional fields.
- Pins verified: `CATALOG.len() == 169`, registry 140, inbox tools 46, tables 74, `Job::ALL` 28, migrations 17.
