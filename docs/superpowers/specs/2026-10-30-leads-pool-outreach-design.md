# Leads and outreach: prospect pool, research tasks, distribution, bulk email (Rust)

Date: 2026-10-30. Status: draft for the owner's review.

Inputs: the owner's rules of 2026-10-30 (below), v1's lead and email features (`backend/prisma/schema.prisma`,
`backend/src/modules/marketing/**`), and the Rust code at `958fcfe3` (`origin/feat/rust-panel-money-inputs`).
Conventions follow `2026-10-22-jeeta-rust-yeniden-yazim-design.md` (§4.2 three rules, §4.5 twins, §7 inbox,
§10 data) and stay consistent with the parallel design `2026-10-30-inbox-comments-marketplace-design.md`
(branch `feat/inbox-comments-marketplace`).

Branch: `feat/leads-pool-outreach`. Migrations: **`0020_prospects`, `0021_distribution`, `0022_outreach`,
`0023_mail_files`**. `0018` is taken by the TikTok webhooks work and `0019` by the inbox comments/marketplace
work; this program starts at 0020 and touches neither of their objects (§4.6). Every count in this document is
relative to `958fcfe3`; a rebase over another branch adds that branch's increments (§7.3).

Markers: **VERIFY (V-xx)** is an external technical fact to check before code depends on it (§13);
**LAWYER (L-xx)** is a legal point the owner's lawyer confirms (§12). Implementers write no provider or legal
fact into code comments without its source (bug class "subagent invented justifications").

---

## 1. Goal, scope, non-goals

**Goal.** Cover v1's lead and email features in the Rust stack so v1 can be switched off, under the owner's
2026-10-30 rules: agents research prospects with their own tools and record them in a separate pool; Jeeta
stores, validates, dedupes, assigns, fences and reports; promoted prospects become inbox people with journeys;
agents run plain-text email outreach (one-off and sequences) through the customer's own mailbox within fences.

**Owner rules (binding, 2026-10-30).**
1. **No external API dependency.** Jeeta calls no data, enrichment or AI API (no Firecrawl, Apify, Google
   Places, LLM). Connected agents (Claude, Codex… over MCP) research with their own tools (web search, browser,
   the device bridge phone) and write through Jeeta's MCP tools. Channels a customer connects with their own
   account (SMTP/IMAP mailbox, WhatsApp, Meta, NetGSM) are the customer's channels, not a platform dependency.
2. **Researched prospects live in a separate pool** ("aday havuzu"), not in the inbox. A prospect becomes a
   person and a journey only when promoted.
3. **The AI completes processes.** The agent acts autonomously within fences by default; a human approves only
   where the owner turned approval on.

**In scope.**
1. Prospect pool: model, mandatory provenance, statuses, dedupe, score, promotion, KVKK retention/erasure,
   do-not-contact list, ledger (§3.1–3.6).
2. Research tasks generated from the strategy's ICP or created by people or agents; daily caps; the work
   queue; the served agent playbook (§3.7, §3.8, Appendix A).
3. Lead distribution: rules, rep capacity/hours/availability, SLA reassignment, manual override, never
   silently ownerless (§3.9).
4. Bulk email: templates, audiences, campaigns, sequences, fences, approval, tracking, unsubscribe and click
   endpoints, reports (§3.10–3.14).
5. Email attachments, inbound and outbound (§3.15).
6. Scoring and the learning loop (§3.4, §3.16).
7. v1 import mapping: contacted leads to the inbox, never-contacted research leads to the pool (§10).

**Non-goals** (each a later phase): HTML email and its editor; open-tracking pixels (never, §3.14);
A/B variants (v1 had them); SMS/WhatsApp campaigns (the inbox's `inbox.send` already covers one-off commercial
SMS/WhatsApp with consent); a public web form builder; enrichment of any kind by Jeeta; malware scanning of
attachments (§14); cold DMs on any social platform (the parallel design forbids them on the phone fallback too).

---

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | A **prospect pool** (`prospects`) separate from `people`. Prospects never appear in inbox queues, never get conversations, never receive messages. | Owner rule 2. Keeps the inbox (spec §7) the place of relationships; the pool is a staging area with its own retention. |
| D2 | **Jeeta never researches.** No research provider adapter, no egress host, no job that fetches pages. Agents record what they found through `jeeta.prospects.*`; Jeeta serves the playbook (Appendix A) and the brief. | Owner rule 1; spec §4.2 rule 1 ("intelligence outside"). |
| D3 | The pool holds **businesses only**: `entity_kind` is `legal_entity`, `sole_trader` or `unknown_business`; there is no individual kind. A contact person is a name and role published by the business itself. | Owner: no private individuals' data. KVKK data minimisation. A sole trader's data is personal data (L-02), so it is treated as such everywhere. |
| D4 | **Provenance is mandatory per contact field** (phone, email, website, Instagram, TikTok, address, contact person): at least one source URL, `captured_at`, and the recorder. The recorder is set by Jeeta from the authenticated actor (agent connection, human, import), never from input. Each record also carries record-level provenance (how it was found, which task). | Owner scope 1. Evidence makes review, objection handling and KVKK answers possible; a recorder from input could be forged. |
| D5 | **Dedupe keys**: hard keys `phone` (E.164), `email`, `instagram`, `tiktok` are unique among live prospects (database-enforced); soft keys `domain` and `name_city` produce `possible_duplicate` unless the writer names the candidates in `distinct_from`. Every write also checks inbox identities (`in_inbox`), the do-not-contact blocklist and erased identities. | Chains share a website and a brand name; one business must not become two prospects through formatting. Soft keys keep branches possible without silent duplicates. |
| D6 | Statuses `new → qualified → promoted`, `rejected` (fixed reason list), `do_not_contact`; a pure state machine. Promoted is terminal in the pool. | One writer of state, as journeys (B4). |
| D7 | **The rubric is the strategy's.** A new optional strategy section `prospecting` (ICP entries and the rubric) is approved with the strategy. Agents write scores 0–100 with reasons per criterion; a score names the rubric digest it was computed under; a score at or above `qualify_at` qualifies the prospect automatically. | Owner scope 6 ("rubric owned by the workspace (strategy)"); spec §5 ("strategy is everything"); owner rule 3. |
| D8 | **Promotion** runs the inbox's single matching function `people::match_or_create` (spec §7.2.6), opens a journey with source `Source::Prospect`, records **no consent** (state none), marks the person `recipient_kind = business`, and links the prospect to the person. Prospect facts stay on the prospect record (shown in the inbox context), not copied into notes. Agents promote only qualified prospects; humans may also promote `new` ones. | One matching path, no second identity store; the evidence stays in one place; erasure of the person reaches the prospect through the link. |
| D9 | **KVKK**: rejected prospects are purged after 30 days, unpromoted ones after 180 days without an update (owner decides, Q2; L-05); erasure on request deletes now; a **do-not-contact blocklist** of per-workspace keyed hashes (HMAC) survives purge; rejected prospects leave hashed keys for 365 days so agents do not re-collect them. The ledger never carries prospect values. | Minimisation and storage limitation; objection must survive deletion; keyed hashes resist dictionary attacks on low-entropy phone numbers (the erasure tombstones of 0008 are unkeyed SHA-256). |
| D10 | **Research tasks**: one standing task per ICP entry per approved strategy version (created by a job), plus ad-hoc tasks from people or agents. Daily caps per task and per workspace; a soft claim lease. Offered through `jeeta.work.pending` as `research_due`. | The existing entry point for agents (spec §4.2 rule 3); no new wake-up mechanism. |
| D11 | **Distribution**: ordered rules (match on source, city, sector, segment, language, score) to a member pool by round robin or least loaded, rep profiles (accepting, capacity, languages, cities, sectors, working hours, away), applied inline at promotion and by a one-minute job to every open journey without an owner; SLA reassignment in the rep's working hours; manual override. **No open journey is ever ownerless without a recorded decision and a visible work item.** | v1 had distribution `DISABLED` from signup and 453 ownerless leads nobody saw (memory "lead assignment disabled"). A job covers every journey creation path, present and future. |
| D12 | **Outreach email is plain text** (the mail adapter sends text only today), from the connected mailbox; templates with a strict variable set; Jeeta appends a **mandatory footer** (sender identity, data-source line, privacy notice link, unsubscribe link). Campaign steps carry **no attachments**. | Deliverability for cold B2B mail; no tracking pixel possible; legal identity and opt-out in every message (L-07); attachments in cold mail raise spam scores and malware risk. |
| D13 | A **campaign** is 1–6 steps (a one-off is one step); its audience is frozen into enrollments at launch (optional refresh for evergreen campaigns); **one active enrollment per person** in the workspace. | Predictable volume; no person in two sequences at once. |
| D14 | Every outreach email goes through **the existing outbox pipeline** (durable intent, fence at enqueue and again at claim, provider call without locks, receipt in one transaction, no blind retry) via a new `Target::PersonVia(person, mailbox)` and `Purpose::Outreach`. Outreach sends obey a human's hold on the conversation like agent sends. | One send path, one set of guarantees (spec §7.4 M2a). `inbox.send` picks the single verified mailbox and refuses two; a campaign names its mailbox. |
| D15 | **Throttles**: per mailbox per local day = min(capability `daily_ops_cap`, warm-up cap, 500); per campaign per hour and per day; sending window = campaign hours ∩ the mailbox's `active_hours`; per recipient domain at most 5 per hour per mailbox; per person at most one outreach email in 3 days and 4 in 30 days across campaigns; **auto-pause** on a hard-bounce rate above 5 % over the last 50 sends or any 2 complaints in 200. | Deliverability of the customer's own domain; the mailbox's existing policy fields are honoured (today they are enforced only for calls and Studio). The numbers are product defaults the owner can change (Q2), not provider facts. |
| D16 | **Stop rules are fixed and authoritative at dispatch**: reply (any inbound from the person after enrollment), bounce or complaint, unsubscribe or withdrawn consent, meeting booked, journey won or lost, person erased or merged, a human holds the conversation, blocklisted keys, campaign canceled. Event hooks stop enrollments early only so reports are timely. | Correctness never depends on every hook being wired (bug class "partial invariant enforcement"). |
| D17 | **Commercial basis** for outreach: an effective consent (existing), or — off by default — a **business-recipient basis** on email for `recipient_kind = business` people without withdrawal, suppression or an İYS refusal. Only a human **owner** can enable it, recording the lawyer's confirmation; while it is off, outreach reaches only consented people and the audience preview says so. | L-01, L-03. The safe default keeps Jeeta from sending unsolicited commercial email until counsel confirms the B2B exemption. |
| D18 | A new journey event **`OutreachSent`** replaces `Replied` for outreach receipts: it records the touch without moving `New → Contacted`. The person's reply (inbound) and our answer (`Replied`) move the journey as today. | Today every successful outbound send applies `Replied`; cold sends would mark every promoted prospect "contacted" and empty the funnel's meaning. |
| D19 | **Approval** is campaign-level and revision-bound (the Studio pattern: a human approves a revision; any edit voids it). It is required only when the workspace's outreach policy says so or the sending mailbox's `requires_human_approval` is on. Outreach does **not** use the per-message `held` outbox state of the parallel design. | Owner rule 3; one approval per campaign, not per email; reusing `held` would hold thousands of system sends. |
| D20 | **Tracking without third parties**: replies through IMAP (threaded by our Message-ID, else person-level); click tracking through a Jeeta redirect, **off by default**, per campaign; **no open pixel**. Unsubscribe: RFC 8058 one-click `POST`, a confirmation page on `GET` (a `GET` never unsubscribes), and a `mailto:` fallback; both public routes are honoured even for a suspended workspace. | Privacy; link scanners prefetch `GET`; opting out is an obligation that outlives a billing state. |
| D21 | **Attachments**: inbound files stored in the file store as `application/octet-stream`, served as downloads only (`Content-Disposition: attachment`), size caps, 180-day retention, erased with the person; outbound files uploaded by the agent and attached to replies, commercial sends and quotes; bytes are read at send time, never stored in the outbox intent. | v1 and Rust keep only "has attachment" today; inline serving of stored files from Jeeta's origin would let an HTML attachment run in the panel's origin. |
| D22 | **Reports are computed at read time** from prospects, journeys, journey events and outreach sends; revenue is grouped per currency, never summed across currencies. | Bug classes "stale stored aggregate" and "mixed-currency aggregate". |
| D23 | **v1 import routes by evidence**: leads past `NEW`, leads with any contact evidence, and leads from inbound sources go to the inbox (today's path); never-contacted research-staged leads go to the pool. Dry run first; provenance kept; rollback covers both. | Owner scope 7. Today the importer sends all 1,143 leads to the inbox. |
| D24 | Platform kill switch **`JEETA_OUTREACH_ENABLED`** (default off): campaigns can be prepared, but launch refuses until the operator turns it on (after L5 is deployed and the lawyer's points are answered). | Merge dark; nothing is sent before the legal gate. |
| D25 | Four new permissions: `prospects.work`, `prospects.manage`, `outreach.work`, `outreach.manage`. Owner and manager hold them; the rep role holds none by default. Distribution uses the existing `inbox.work`/`inbox.manage`. | Data minimisation inside the team: the pool is not everyone's; a custom role can grant it. |
| D26 | **Retention, decided 2026-10-30 by the owner's delegate** (answers §15 Q2): rejected prospects are purged 30 days after the rejection, unpromoted ones 180 days after their last update, a purged rejection's keys are remembered 365 days, inbound attachments are kept 180 days; the do-not-contact list is per-workspace keyed hashes (HMAC) and survives every purge. These are the policy defaults (`ProspectsPolicy`, `LeadsPolicy.attachments`); a workspace manager may change the pool's within the bounds of §7.1. L-05 still asks the lawyer to confirm them. | The owner's delegate took the proposed numbers; the lawyer's answer can still move them without code. |
| D27 | **`0020` down refuses while the blocklist holds a `do_not_contact` or `erased` entry** (built in L1-T2; stricter than §4.1's first draft): the operator exports those hashes and deletes them by hand before a schema rollback. Rejection memory does not hold a rollback up. | An objection must outlive deletion (D9), a rollback included; a refusing down is the repository's pattern for unsafe states (0015). |

---

## 3. The model

### 3.1 Prospect (`jt_prospects::Prospect`)

```rust
pub struct Prospect {
    pub id: ProspectId,
    pub workspace_id: WorkspaceId,
    pub status: ProspectStatus,            // §3.2
    pub business_name: String,             // 1..=200, trimmed
    pub entity_kind: EntityKind,           // LegalEntity | SoleTrader | UnknownBusiness
    pub sector: Option<String>,            // 1..=80, free text in the workspace's words (e.g. "kafe")
    pub city: Option<String>,              // 1..=80
    pub district: Option<String>,          // 1..=80
    pub country: String,                   // ISO 3166-1 alpha-2, default "TR"
    pub language: Option<String>,          // BCP 47 primary tag, 2..=8 ("tr", "en")
    pub segment_key: Option<String>,       // a strategy audience segment key
    pub labels: Vec<String>,               // <= 20, each 1..=40
    pub contact: ContactFields,            // every field with Evidence (D4)
    pub size: Option<Field<SizeHint>>,     // branches, employee band, note
    pub signals: Vec<Signal>,              // <= 20; why it fits, each with a source
    pub notes: String,                     // <= 2000; never about private individuals (playbook)
    pub origin: Origin,                    // record-level provenance
    pub research_task_id: Option<ResearchTaskId>,
    pub latest_score: Option<ScoreSummary>,// written only with a score row (§3.4)
    pub decision: Option<Decision>,        // reject/DNC reason, who, when
    pub promoted: Option<Promotion>,       // person_id, journey_id, at, score/bucket at promotion
    pub purge_after: Option<OffsetDateTime>,
    pub revision: u32,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}
pub struct ContactFields {
    pub phone: Option<Field<String>>,      // E.164 after jt_inbox::normalise(Phone)
    pub email: Option<Field<String>>,      // jt_inbox::normalise(Email)
    pub website: Option<Field<String>>,    // absolute http(s) URL, <= 2048
    pub instagram: Option<Field<String>>,  // handle, [a-z0-9._]{1,30}
    pub tiktok: Option<Field<String>>,     // handle, [a-z0-9._]{2,24}
    pub address: Option<Field<String>>,    // <= 300
    pub contact_person: Option<Field<ContactPerson>>, // name <= 120 and role <= 80, as the business publishes them
}
pub struct Field<T> { pub value: T, pub evidence: Evidence, pub deliverable: bool /* false after a hard bounce (email) */ }
pub struct Evidence {
    pub sources: Vec<SourceRef>,           // 1..=5 (agents); humans may give a Manual note instead
    pub captured_at: OffsetDateTime,       // within [now - 365 d, now + 5 min]
    pub recorder: Recorder,                // set by Jeeta from ctx.actor; never deserialised from input
}
pub enum SourceRef { Url { url: String /* http(s), <= 2048 */, note: Option<String> /* <= 200 */ },
                     Manual { note: String /* 1..=200, humans only: "business card at a fair" */ },
                     Import { system: String /* "v1" */, record: String } }
pub enum Recorder { Agent { connection_id: AgentConnectionId, user_id: UserId }, Human { user_id: UserId },
                    Import { system: String, record: String } }
pub struct Signal { pub text: String /* 1..=200 */, pub source: SourceRef }
pub struct SizeHint { pub branches: Option<u16>, pub employees: Option<EmployeeBand>, pub note: Option<String> /* <= 120 */ }
pub enum EmployeeBand { B1To9, B10To49, B50To249, B250Plus }
pub struct Origin { pub via: OriginVia /* ResearchTask | Manual | Agent | V1Import */, pub discovered_at: Vec<SourceRef> /* 0..=5 */,
                    pub recorder: Recorder, pub at: OffsetDateTime }
```

- `website` pointing at a platform host (Instagram, Facebook, TikTok, link-in-bio, maps short links; the fixed
  list `PLATFORM_HOSTS`) is refused with `website_is_a_platform_profile`: the handle field is the place for it.
- Unknown fields in input are refused (`deny_unknown_fields`); stored rows read tolerantly (spec §7, as `jt_inbox`).
- A field's `deliverable: false` (set when a promoted person's email hard-bounced, or imported from v1's
  `emailBouncedAt`) keeps the value as evidence but excludes it from promotion identities.

### 3.2 Status machine (`jt_prospects::apply(status, event) -> Result<ProspectStatus, StatusError>`)

| Event | From | To | Who |
|---|---|---|---|
| `Qualify` | new | qualified | agent, human, system (score ≥ `qualify_at`) |
| `Reject { reason, note }` | new, qualified | rejected | agent, human |
| `Reopen` | rejected | new | human with `prospects.manage` |
| `Promote` | qualified; new (human only) | promoted | agent (qualified only), human |
| `DoNotContact { reason }` | new, qualified, rejected | do_not_contact | agent, human |
| `Erase` | new, qualified, rejected, do_not_contact | (row deleted) | human with `prospects.manage`; a promoted prospect is erased with its person (`inbox.people.erase`, §3.6), else `erase_the_person` |

Reject reasons (fixed, stable keys): `not_icp`, `closed_business`, `no_contact_data`, `competitor`,
`already_customer`, `duplicate`, `other` (note required). DNC reasons: `objected` (the business asked),
`legal`, `other` (note required). Any other pair is `StatusError` (nothing written). `do_not_contact` scrubs the
row's personal fields in the same transaction (business name kept as `"—"`, contact fields, signals, notes and
evidence emptied) and writes the blocklist hashes (§3.6).

### 3.3 Dedupe (`jt_prospects::keys`)

| Kind | Derived from | Normalisation | Strength |
|---|---|---|---|
| `phone` | phone | `jt_inbox::normalise(Phone)` (E.164; TR national forms gain +90) | hard |
| `email` | email | `jt_inbox::normalise(Email)` | hard |
| `instagram` | instagram, or a website on `instagram.com/<h>` | lowercase, strip `@`, `[a-z0-9._]{1,30}` | hard |
| `tiktok` | tiktok, or `tiktok.com/@<h>` | lowercase, strip `@`, `[a-z0-9._]{2,24}` | hard |
| `domain` | website host; email domain unless a free-mail domain (`FREE_MAIL_DOMAINS`: gmail.com, hotmail.com, outlook.com, yahoo.com, yandex.com, icloud.com, …) | lowercase, IDNA to ASCII (the `url` crate), strip one leading `www.`; never platform hosts | soft |
| `name_city` | business name + city | Turkish-aware fold (İ→i, I→ı, then ç→c ğ→g ı→i ö→o ş→s ü→u), drop punctuation, drop legal-form tokens (`ltd`, `sti`, `şti`, `as`, `a.ş`, `limited`, `sirketi`, `şirketi`, `tic`, `san`, `ve`), collapse spaces; `name|city`; none without a city | soft |

The registrable domain (eTLD+1) is **not** computed: it needs the Public Suffix List, an external data set;
the soft key makes the difference harmless.

On every create and on every update that changes a key, in this order:
1. Each hard key against **erased identities** (`erasure::check_identity` for phone/email) → `FORBIDDEN
   {reason: erased_identity}`, and against the **blocklist** (DNC and rejected memory) → `FORBIDDEN {reason:
   do_not_contact}` or `CONFLICT {reason: previously_rejected}`. No other detail is returned.
2. Phone and email against **active inbox identities** (`people().find_by_identity`) → `CONFLICT {reason:
   in_inbox, person_id}`: the business is already a relationship; the agent adds a note to that person's
   journey instead.
3. Hard keys against **live prospects** (`prospect_keys` unique index) → `CONFLICT {reason: duplicate,
   prospect_id}`.
4. Soft keys against live prospects → `CONFLICT {reason: possible_duplicate, candidates: [{prospect_id,
   business_name, city, matched: [domain|name_city]}]}` unless every candidate is listed in `distinct_from`
   (recorded in the record's origin).

`jeeta.prospects.check` runs the same checks without writing (the playbook says to call it before researching
a business deeply). Pool writes take a per-workspace pool lock (`prospects().lock_pool()`, a transaction
advisory lock); promotion takes the inbox lock (`people().lock_workspace()`) **first**, then the pool lock: one
lock order everywhere.

### 3.4 Score and rubric

The strategy section `prospecting` (§3.7) holds the rubric:

```rust
pub struct Rubric { pub criteria: Vec<Criterion> /* 1..=12 */, pub qualify_at: u8 /* 1..=100 */ }
pub struct Criterion { pub key: String /* [a-z0-9_]{2,32}, unique */, pub description: String /* 1..=300 */, pub weight: u8 }
// weights sum to exactly 100
```

- **Rubric digest** = lowercase hex SHA-256 of the canonical JSON of `Rubric` (field order as declared,
  criteria in order), computed in `jt_app::usecases::prospects::rubric_digest`. Two strategy versions with the
  same rubric share the digest, so their scores stay comparable.
- **Score write** (`prospects.score`): `{prospect_id, score: 0..=100, reasons: [{criterion, points: 0..=weight,
  evidence: 1..=300 chars, source: SourceRef?}], rubric_digest}`. Rules: `rubric_digest` equals the digest of
  the approved strategy's rubric, else `CONFLICT {reason: rubric_mismatch, current}`; every criterion appears
  exactly once; `score == sum(points)`; scores are append-only rows (`prospect_scores`), and the prospect's
  `latest_score` is written by the same repository call (one writer, one transaction).
- **Auto-qualify**: a score ≥ `qualify_at` on a `new` prospect applies `Qualify` (actor: system,
  `prospects.qualified {auto: true}`). A lower score never un-qualifies a human's qualification.
- **Buckets** (fixed, stable across rubrics): `0-24`, `25-49`, `50-74`, `75-100`.
- v1 scores import with digest `"v1-legacy"` (§10) and never auto-qualify.

### 3.5 Promotion (`prospects.promote`)

Input `{prospect_ids: [1..=50], request_key?}`; each prospect is promoted in its own transaction and the
answer lists one outcome per id (`promoted`, `already_promoted`, `refused {reason}`).

Per prospect, inside one transaction (inbox lock, then pool lock):
1. Status `qualified`, or `new` when the actor is human (`promote_requires_qualified` for agents) →
   else `refused {not_qualified}`. Daily promotion cap (§3.7) → `refused {daily_cap}`.
2. Identities: the email and phone fields whose `deliverable` is true; none → `refused {no_contact_identity}`.
   Blocklist and erased checks again (state may have changed since creation).
3. `people::match_or_create(CreateInput { display_name: contact_person.name or business_name, identities,
   source: Source::Prospect { prospect_id, origin } }, None)`:
   - a new person gets `company = business_name`, `recipient_kind = Business`, a `New` journey with source
     `Source::Prospect`;
   - an existing person (identity matched) is reused: an open journey is reused; a latest `Lost` journey →
     `refused {lost_journey_exists}` (a human reopens it, spec §7.3); a latest `Won` journey → a new journey
     with `Source::Repeat`, as `journeys::open` does;
   - an identity split → `refused {identity_split, merge_suggestion}` (the suggestion is committed, as today).
4. No consent row is written (consent state "none"); the person's `recipient_kind` becomes `Business` unless a
   human set `Individual` (L-02).
5. The prospect becomes `promoted` with `{person_id, journey_id, at, score, bucket}` (the score at promotion is
   frozen on purpose: it is the learning loop's input).
6. **Distribution runs inline** (§3.9) so the journey has an owner when the transaction commits.
7. Ledger `prospects.promoted {prospect_id, person_id, journey_id, created_person}`; `inbox.person.created`
   and `inbox.journey.opened` as the inbox writes them.

The inbox context (`inbox.context`, `inbox.people.get`) gains `prospect: Option<ProspectSummary>` (business
facts, evidence counts and links, signals, latest score and reasons) read through the link, so the agent sees
why this business was chosen.

### 3.6 KVKK: minimisation, retention, erasure, do-not-contact

- **Minimisation**: business contact data the business publishes itself; no private individuals (D3); notes
  must not describe individuals (playbook); the pool is visible only to `prospects.work`.
- **Retention** (`ProspectsPolicy`, defaults; owner decides Q2, L-05):
  - `rejected_retention_days = 30` after the rejection;
  - `unpromoted_retention_days = 180` after the last update of a `new`/`qualified` prospect (a re-verification
    by the agent is an update and extends it);
  - `rejected_memory_days = 365`: purging a rejected prospect writes its keys' hashes with `reason = rejected`
    and that expiry;
  - promoted prospects are never purged by the pool: their lifetime is the person's.
  `purge_after` is recomputed on every status change and update (the use case computes it with
  `jt_prospects::purge_after` and the repository stores it in the same statement); the daily `prospects_purge`
  job deletes rows past it (keys and scores with them) and expired rejected-memory hashes. Ledger
  `prospects.purged {count}` (system), no identifiers.
- **Erasure** (`prospects.erase {confirm: true}`, `prospects.manage`): deletes the row now and writes DNC
  hashes for every key (an erasure request implies the business does not want to be re-collected; L-06).
  `inbox.people.erase` of a promoted person scrubs the linked prospect (all personal fields and evidence
  emptied, ids kept) and writes DNC hashes of its non-identity keys (domain, handles, name_city); phone and email
  are covered by the existing erased-identity hashes.
- **Do-not-contact blocklist** (`prospect_blocklist`): `(workspace_id, kind, key_hash)` with `reason ∈
  {do_not_contact, erased, rejected}`, `expires_at` (null for the first two). `key_hash` = hex
  HMAC-SHA256(`seal.hmac_key(ws, "prospects.blocklist")`, `kind ‖ 0x00 ‖ normalised value`). The key derives
  from the platform master key (same lifetime as sealed credentials). Checked on prospect create/update,
  promotion and every outreach dispatch (D16). `prospects.do_not_contact` also accepts raw keys without a
  prospect (an objection that reached a rep by phone). Lifting an entry (`prospects.dnc_lift`) needs a human
  with `prospects.manage` and the raw value (the hash is recomputed); an agent can never lift one.
- **Ledger**: `prospects.*` entries carry ids, field names, statuses and reasons, **never values**, so the
  immutable ledger holds nothing a purge or erasure would have to mask.

### 3.7 Research tasks and the strategy's `prospecting` section

**Strategy section** (`jt_strategy::Sections.prospecting`, `#[serde(default)]`, written with
`strategy.write_section`, approved with the version):

```rust
pub struct Prospecting { pub icp: Vec<IcpEntry> /* 0..=10 */, pub rubric: Rubric }
pub struct IcpEntry {
    pub key: String,                 // [a-z0-9_]{2,32}, unique
    pub segment_key: String,         // an audience segment key of the same version
    pub sectors: Vec<String>,        // 1..=10
    pub areas: Vec<Area>,            // 1..=20; Area { city, district: Option }
    pub signals: Vec<String>,        // 0..=10: what to look for
    pub exclusions: Vec<String>,     // 0..=10: what disqualifies
    pub size_hint: String,           // <= 200
    pub language: Option<String>,
    pub daily_cap: u16,              // 1..=200 prospects created per local day for this entry
    pub backlog_target: u16,         // 0..=2000: stop asking for research while this many are unpromoted
}
```

Empty `icp` means prospecting is off and is not a gap. With entries, `validate_sections` reports gaps: unknown
segment key, no sector, no area, rubric criteria count, weights not summing to 100, `qualify_at` outside
1..=100. `validate_sections`, `diff` and `next_draft_from` destructure `Sections` in full, so the compiler forces
each to decide the new field.

**Research task** (`research_tasks`):

```rust
pub struct ResearchTask {
    pub id: ResearchTaskId, pub workspace_id: WorkspaceId,
    pub kind: TaskKind,                    // Standing { icp_key } | AdHoc { target_count: 1..=500 }
    pub strategy_version_id: StrategyVersionId,
    pub brief: Brief,                      // segment_key, sectors, areas, signals, exclusions, size_hint, language, note (<= 1000)
    pub rubric_digest: String,
    pub daily_cap: u16,
    pub status: TaskStatus,                // Open | Done | Canceled | Superseded
    pub claim: Option<Claim>,              // { by: Recorder, until: now + 2 h }
    pub created_by: Recorder, pub created_at: OffsetDateTime, pub closed_at: Option<OffsetDateTime>, pub close_note: String,
}
```

- **Standing tasks**: the hourly `research_plan` job makes sure each ICP entry of the approved version has one
  open standing task, and marks open tasks of older versions `superseded`.
- **Ad-hoc tasks**: created by a human or an agent (`research.tasks_create`) with a brief (validated like an ICP
  entry, segment optional) and a target count; done when the count is reached or closed by hand.
- **Caps** (the workspace's local day, `leads_policy.timezone`, default `Europe/Istanbul`): per task its
  `daily_cap`; per workspace `MAX_DAILY_PROSPECTS = 500` created per day and `max_promotions_per_day` (default
  100). Exceeded → `CONFLICT {reason: daily_cap, resets_at}`.
- **Claim**: `research.tasks_claim` sets a 2-hour soft lease for the calling recorder; another agent's claim
  makes the task show as claimed (it may still record, the lease is advisory).
- **Remaining today** = `daily_cap` − prospects created today with that `research_task_id`; for a standing task
  zero also when the backlog (unpromoted `new`+`qualified` prospects of its segment) is at `backlog_target`.

### 3.8 The agent playbook

`jeeta.prospects.playbook` (Read, `prospects.work`) answers `{version, text, workspace: {icp, rubric,
rubric_digest, caps, remaining_today: [{task_id, remaining}], retention_days, blocklist_rules}}`. The text is the
constant `jt_prospects::playbook::TEXT` (English, for agents; Appendix A), versioned (`PLAYBOOK_VERSION`); the
panel shows the same text on the pool page. Every `research_due` work item's hint names the tool. The playbook
says how to research with the agent's own tools, what to record and with what evidence, what is forbidden
(private individuals, guessed emails, leaked databases, people-search sites, bulk scraping, contacting before
promotion), the pacing, the dedupe-first habit, scoring with reasons, and when to promote.

### 3.9 Distribution

**Rep profile** (`rep_profiles`, one per member; a member without a row reads as the default profile):
`{user_id, accepting: true, max_open: Option<u16> (open owned journeys), languages, cities, sectors (each
0..=20; empty = any), hours: Option<Hours> (the capability `Hours` type: tz, from, to, days), away_until}`.
Eligible member: active membership whose role holds `inbox.work`, accepting, not away, under `max_open`, and
matching the rep's own filters when the lead's fact is known.

**Rule** (`distribution_rules`, ordered by `position`):

```rust
pub struct Rule { pub id: RuleId, pub name: String, pub enabled: bool, pub when: Match, pub to: MemberPool,
                  pub method: Method, pub sla_minutes: Option<u32> /* 5..=10080 */, pub cursor: Option<UserId> }
pub struct Match { pub sources: Vec<SourceKind>, pub cities: Vec<String>, pub sectors: Vec<String>,
                   pub languages: Vec<String>, pub segments: Vec<String>, pub min_score: Option<u8> } // empty = any
pub enum SourceKind { Prospect, Channel, MetaAds, Form, Import, Repeat }
pub enum MemberPool { Members { user_ids: Vec<UserId> }, AllEligible }
pub enum Method { RoundRobin, LeastLoaded }
```

**Lead facts** of a journey: its source kind; the linked prospect's city, sector, segment, language and score
bucket (inbound journeys usually know only the source and channel).

**Decision** (`jt_inbox::distribution::choose(rules, facts, candidates) -> Choice`, pure): the first enabled rule
whose `when` matches and that has at least one eligible member wins; within it, members **on shift** (working
hours now, computed in `jt_app` with `chrono-tz`) come first, else all eligible; round robin takes the next user
id after the rule's cursor in a stable order; least loaded takes the fewest open owned journeys, ties by round
robin. After the listed rules an **implicit default rule** (`AllEligible`, round robin) applies unless the
workspace's distribution mode is `manual`. A solo owner is therefore assigned everything with no setup.

**When it runs**: inline at promotion (§3.5) and in `lead_distribution` (every minute) for every open journey
without an owner and without a live decision: new inbound journeys (consumer, lead ads, forms), people created by
hand, journeys reopened by `journeys.open`, owners cleared because the member left (`release_member` already
clears them), v1 imports. Each decision is a `journey_assignments` row: `{journey_id, user_id?, cause:
rule|default|manual|sla_reassign|member_left|import|no_eligible, rule_id?, sla_due_at?, acted_at?,
superseded_at?, by}`. A decision with no eligible member is recorded with `cause = no_eligible`.

**Never silent**: the aggregated work item `ownerless_journeys {count, oldest_journey_id}` (priority 2, for
`inbox.manage`) counts every open journey without an owner, whatever the cause; the inbox gets an "Sahipsiz"
queue; `manual` mode raises the same item for every new journey. v1-imported open journeys without a mapped owner
are counted there too and are distributed only by `distribution.backfill` (a manager's call, at most 200 a call),
so an import never floods reps.

**SLA**: when the assigning rule has `sla_minutes`, `sla_due_at` = the assignment time plus that many minutes
**inside the owner's working hours** (`jt_app::usecases::hours::add_working_minutes`, shared with the calls fence
that today has its own copy). The owner **acts** when, after the assignment, they reply in any of the person's
conversations, report a journey event, add a note, complete a task or place a call; each of those use cases
calls `distribution::touch(r, journey, user, at)`. The job reassigns an assignment past its due time with no act
to the next eligible member of the same rule, excluding previous assignees of this journey, at most
`max_reassignments` (default 2) times; then `assignment_stalled {count}` (priority 2) asks a manager. Manual
assignments carry no SLA.

**Manual override**: `inbox.journeys.assign_owner` (unchanged surface) writes a `manual` decision superseding the
live one.

### 3.10 Outreach: templates, campaigns, sequences

**Template** (`outreach_templates`): `{id, name (1..=120), language (tr|en), subject (1..=200, one line),
body (1..=20,000), revision, archived}`. Variables `{{name}}` or `{{name|fallback}}`; allowed names
`first_name`, `contact_name`, `company`, `city`, `district`, `sector`, `sender_name`, `sender_company`, and
`custom.<key>` (`[a-z0-9_]{1,32}`, supplied per enrollment by the agent). An unknown name, an unbalanced brace or
a link that is not `http(s)` is refused at save. At render a missing value without a fallback skips the
enrollment with `missing_variable:<name>` (never sent with a blank).

**Footer** (appended by Jeeta after the body, not editable; copy in TR and EN by template language, L-07):

```
--
{sender_company} · {sender_address}
{source_line}
Kişisel verilerin işlenmesi hakkında: {privacy_notice_url}
Bu e-postaları almak istemiyorsanız: {unsubscribe_url}
```

`source_line` is "Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz." for people
whose first touch is a prospect, and "Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz." for
consented people. A campaign cannot launch until `outreach.settings` holds `sender_company`, `sender_address` and
`privacy_notice_url` (`sender_identity_missing`).

**Campaign** (`outreach_campaigns`):

```rust
pub struct Campaign {
    pub id: CampaignId, pub name: String,
    pub mailbox_id: CapabilityId,          // a `mailbox` capability; the sender
    pub sender_name: String,               // display name, 1..=80, no control characters
    pub steps: Vec<Step>,                  // 1..=6
    pub audience: Audience,
    pub schedule: Schedule,                // start_at, window: Hours (tz, from, to, days)
    pub throttle: Throttle,                // per_hour 1..=60, per_day 1..=500
    pub click_tracking: bool,              // default false
    pub evergreen: bool,                   // refresh the audience daily while running
    pub status: CampaignStatus,            // Draft | AwaitingApproval | Scheduled | Running | Paused | Completed | Canceled
    pub pause_reason: Option<String>,      // manual | bounce_rate | complaints | mailbox_down | strategy_changed
    pub revision: u32, pub approval: Option<Approval>, // { revision, by: UserId, at }
    pub strategy_version_id: StrategyVersionId, pub segment_key: Option<String>,
    pub created_by: Recorder, pub launched_at: Option<OffsetDateTime>, pub completed_at: Option<OffsetDateTime>,
}
pub struct Step { pub template_id: TemplateId, pub delay_days: u16 /* 0 for step 1, then 1..=30 */,
                  pub same_thread: bool, pub snapshot: Option<StepSnapshot> /* set at launch */ }
pub struct StepSnapshot { pub template_revision: u32, pub subject: String, pub body: String, pub links: Vec<String> }
```

- **Snapshot at launch**: each step copies its template's subject, body and the body's links; later template
  edits never reach a running campaign.
- **State machine** (`jt_outreach::campaign::apply`): `Draft → AwaitingApproval` (launch, approval required) or
  `→ Scheduled/Running` (launch, not required); `AwaitingApproval → Scheduled/Running` (approve, human, matching
  revision); `Running ↔ Paused` (pause/resume; resume re-checks approval at the current revision); `Running →
  Completed` (no active enrollment left, not evergreen); any non-final → `Canceled`. Saving a campaign in any
  state but `Draft`/`Paused` is refused; saving bumps `revision` and voids the approval.
- **Audience** (`Audience { people: Option<PeopleFilter>, prospects: Option<ProspectFilter>, explicit:
  Vec<PersonId> (<= 500) }`): `PeopleFilter { journey_statuses (open stages), owner (user | none),
  source_kinds, recipient_kind, segments, cities, sectors (through the linked prospect), opened_after,
  opened_before }`; `ProspectFilter { segment_keys, research_task_ids, cities, sectors, min_score }` over
  **qualified** prospects, which enrollment promotes first (§3.5 rules and caps; the rest wait for the next
  refresh). At most 5,000 enrollments per campaign.
- **Enrollment** (`outreach_enrollments`): `{id, campaign_id, person_id, journey_id?, prospect_id?, status:
  active | completed | stopped | skipped, reason?, next_step, next_send_at, personalization:
  map<custom key, string ≤ 500> (≤ 20 keys), basis: consent | business_recipient, enrolled_at, stopped_at?,
  last_sent_at?}`; unique `(campaign_id, person_id)`; at most one `active` enrollment per person in the
  workspace. Skipped at enrollment (with the reason shown in the preview): no deliverable email, suppressed, no
  basis, blocklisted, active elsewhere, erased/merged, journey closed.
- **Personalization**: the agent writes per-recipient values (`outreach.personalize`, ≤ 100 a call); a step whose
  template uses a `custom.*` variable without a fallback waits for it and raises `personalization_due` when the
  send is within 24 hours.

### 3.11 Dispatch and fences

**`outreach_dispatch`** (every minute) per workspace with a running campaign, oldest launch first:

1. **Budgets**: mailbox remaining today = min(mailbox `daily_ops_cap`, warm-up cap, 500) − outreach sends of
   that mailbox today (local day of the campaign window's tz); campaign remaining today = `per_day` − its sends
   today; campaign remaining this hour = `per_hour` − its sends in the last 60 minutes; per-minute pacing =
   ⌈per_hour / 60⌉. Window closed (campaign window ∩ mailbox `active_hours`) → nothing.
2. **Warm-up** (`jt_outreach::warmup_cap(day_index, policy)`): `day_index` = number of earlier local days with at
   least one outreach send from this mailbox; reset to 0 when the last outreach send is older than 30 days; cap =
   min(start + step × day_index, max). Defaults start 20, step 10, max 150 (product defaults; a human may turn
   warm-up off for an established mailbox).
3. **Pick** due active enrollments (`next_send_at ≤ now`) up to the budget, `for update skip locked`, by
   `(next_send_at, id)`.
4. **Pre-checks** per enrollment, each authoritative (D16): stop conditions; per-person frequency (another
   outreach send in 3 days or 4 in 30 days → postpone to the first allowed time); per recipient domain (5 an hour
   per mailbox → postpone 20 minutes); İYS lookup for `business_recipient` basis (below).
5. **Render** the step (snapshot + variables + footer + unsubscribe URL + click rewriting) and **enqueue** through
   `replies::enqueue_in(Target::PersonVia(person, mailbox), ReplyInput { intent: Commercial, subject, text,
   in_reply_to: previous step's Message-ID when `same_thread`, references }, Purpose::Outreach(OutreachSend
   {...}))` with author `System` and the fence's human-hold rule applied as for an agent. The same transaction
   writes the `outreach_sends` row (`queued`) and advances the enrollment (`next_step + 1`, `next_send_at = now +
   next delay`, or `completed`).
6. **Send** outside the transaction (`send_step`), as `inbox.reply` does; `outbox_recover` covers crashes.
7. A **fence refusal** stops the enrollment with the refusal reason (new transaction, ledger
   `outreach.enrollment.stopped`); a transient provider failure leaves the send `failed`/`unknown` as the outbox
   records it and moves on (no blind retry).
8. **Auto-pause** when the campaign's last 50 sends hold more than 5 % hard bounces or its last 200 hold 2
   complaints (`pause_reason = bounce_rate | complaints`, work item `campaign_blocked`).

**Fences** (`jt_outreach::fence` plus the inbox fence; checked at enqueue and again at claim unless noted):

| # | Check | Where | Refusal |
|---|---|---|---|
| F1 | Approved strategy, active workspace | enqueue, claim (existing) | `strategy_required`, `workspace_inactive` |
| F2 | Platform switch `JEETA_OUTREACH_ENABLED` | launch, dispatch | `outreach_disabled_on_platform` |
| F3 | Campaign `running`; its revision is the approved one when approval is required | dispatch, claim | `campaign_not_running`, `approval_required` |
| F4 | Mailbox capability live and sealed (existing) | enqueue, claim | `capability_down` |
| F5 | Person not erased or merged; journey not Lost (existing) and not Won | enqueue, claim | `person_erased`, `person_merged`, `journey_lost`, `journey_won` |
| F6 | No suppression on email; commercial basis (D17, §3.12) | enqueue, claim | `IZIN_YOK` |
| F7 | Person's email/phone/prospect keys not on the blocklist | dispatch, claim | `do_not_contact` |
| F8 | No human holds the email conversation | enqueue, claim | `human_holds_conversation` |
| F9 | No inbound from the person since enrollment; no meeting booked | dispatch, claim | `replied`, `meeting_booked` |
| F10 | Sender identity and privacy notice configured | launch, dispatch | `sender_identity_missing` |
| F11 | Window, budgets, warm-up, frequency, domain pacing | dispatch only (a recovered send is not re-timed) | postponed, not refused |

### 3.12 Commercial basis and İYS (`jt_inbox::consent`)

```rust
pub enum RecipientKind { Unknown, Business, Individual }   // people.recipient_kind; default Unknown
pub enum CommercialBasis { Consent, BusinessRecipient }
/// Withdrawal or suppression on the channel always refuses; an effective explicit or contract consent is
/// `Consent`; otherwise a Business recipient on a channel in `b2b_channels` is `BusinessRecipient`.
pub fn commercial_basis(consents: &[Consent], suppressions: &[Suppression], channel: Channel,
                        recipient: RecipientKind, b2b_channels: &[Channel]) -> Result<CommercialBasis, IzinYok>;
```

- `commercial_allowed` keeps its meaning (`commercial_basis(.., Unknown, &[])`); `FenceCtx.consent_ok` keeps its
  name and is computed by the caller from `commercial_basis`; the existing tests stay green unchanged.
- `b2b_channels` comes from `outreach.settings.b2b_basis` (empty by default; this program allows only `email`).
  Setting it needs a **human owner** with `outreach.manage` and `legal_ack: {counsel_confirmed: true, note}`
  (ledger `outreach.b2b_basis_set`); an agent key never can.
- **İYS for business recipients** (L-03, V-I1): when `b2b_basis` is on and `require_iys_lookup` is on (default),
  the dispatcher looks the address up through the workspace's İYS-capable NetGSM capability (`ConsentSync::search`,
  a new port method over the existing `jt_netgsm` `iys_search`) before the first business-basis send to that
  address and caches the answer as a consent row (`source = iys_sync`; `RET` → `Withdrawn`, `ONAY` →
  `Explicit`; `YOK` → nothing) for 30 days. At most 8 lookups a minute per workspace (NetGSM's İYS budget is 10).
  No İYS capability → the business basis is unavailable (`iys_lookup_unavailable`) unless the owner turned
  `require_iys_lookup` off with the same legal acknowledgement.
- `recipient_kind` is set to `Business` by promotion and by a human or agent through `inbox.people.set_kind`
  (with a note); inbound people stay `Unknown`.
- The basis used is stored on the enrollment and in the send's fence snapshot (evidence for a later question).

### 3.13 Approval

`requires_approval(campaign) = outreach.settings.requires_approval || mailbox.policy.requires_human_approval`.
Launch then sets `AwaitingApproval` and raises `campaign_approval {campaign_id, revision}` (priority 2, humans with
`outreach.manage`), unless the caller is a human with `outreach.manage`, whose launch approves the revision it
launches; `outreach.campaigns_approve {expected_revision}` is a human act
(`human_required` otherwise), refused on a stale revision. Defaults: both off (owner rule 3). The per-message
`held` state of the parallel design is not used by outreach: when both land, `Purpose::Outreach` enqueues are
exempt from its hold rule, and that rule applies to `Actor::Agent` replies only (a coordination note for
whichever branch merges second, §4.6).

### 3.14 Tracking and public endpoints

**Replies.** The consumer's inbound path (`consumer::message`) calls `outreach::hooks::on_inbound(r, ctx,
person, message)`: an inbound message whose `In-Reply-To` (the header `jt_mail::parse` keeps; `References` is not
parsed today) names an outreach send's Message-ID (`<outbox_id@host>`) marks that send `replied`; otherwise the person's latest outreach send within 30 days is
marked `replied (unthreaded)`. Every active enrollment of the person stops with `replied`. The conversation
becomes `Ours` as today, so the agent gets `reply_due` and answers.

**Bounces and complaints.** `consumer::mail_evidence` already maps a DSN/ARF to the outbox row and writes the
suppression; it now also calls `on_bounce` (send `bounced`/`complained`, enrollment stopped, the prospect field's
`deliverable = false`).

**Unsubscribe** (`jt_webhook::links`, outside the panel's session and CSRF checks, inside security headers and the
access log):

| Request | Response |
|---|---|
| `GET /u/{workspace_id}/{send_id}/{mac}` | a small HTML page (TR/EN by template language) with one button that POSTs to the same URL; **never unsubscribes**; unknown or bad MAC → `404` |
| `POST /u/{workspace_id}/{send_id}/{mac}` (body `List-Unsubscribe=One-Click`, RFC 8058, or the page's form) | unsubscribes, idempotent; `200` small HTML; bad MAC → `404`; erased person → `200` (nothing to do, nothing revealed); no cookie, no session, no CSRF token required (RFC 8058) |

`mac` = first 16 bytes of HMAC-SHA256(`seal.hmac_key(ws, "outreach.unsubscribe")`, send id bytes), base64url
without padding, compared in constant time. Effects in one transaction: suppression `(person, email,
unsubscribe)`; consent `Withdrawn` (email, `customer`, now) — the hourly İYS sync pushes it as `RET` where İYS is
configured; every active enrollment of the person stops with `unsubscribed`; the send's `unsubscribed_at`;
ledger `outreach.unsubscribed` (system actor `unsubscribe_link`, `person_id`, masked on erasure as inbox entries
are). Honoured whatever the workspace's status (D20).

Every outreach email carries `List-Unsubscribe: <https://…/u/…>, <mailto:{from}?subject=unsubscribe>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369, RFC 8058). The `mailto:` lands in the same
mailbox; the consumer treats an inbound email whose subject is exactly `unsubscribe` (case-insensitive) from a
person with an outreach send in the last 90 days as an unsubscribe with the same effects. DKIM signing of these
headers is the mailbox provider's (V-E2); the campaign page warns that SPF, DKIM and DMARC must be set on the
sending domain (V-E1).

**Click redirect** (only when the campaign's `click_tracking` is on): `GET /c/{workspace_id}/{send_id}/{link}/{mac}`
(`mac` over send id and link index, purpose `"outreach.click"`) → `302` to `links[link]` of the step's snapshot;
unknown → `404`. A click within 60 seconds of the send, a `HEAD`, or a request without `User-Agent` is counted as
`automated` and not as a click. Nothing about the client (address, agent string) is stored. A suspended workspace
still redirects but records nothing. Only links of the approved snapshot are rewritten; links inside variable
values are left as they are.

**Open tracking**: none, by design (plain text; privacy).

### 3.15 Attachments (`mail_files`)

**Inbound.** `MailboxPoller::poll` returns each draft with its attachments' bytes (transport only, never in the
event payload). The `mail_inbox_poll` job, before its storing transaction, puts each attachment of a non-sent,
non-duplicate message into the file store as `application/octet-stream` (the declared type is kept as metadata),
within caps: ≤ 10 MiB per file (the message bound), ≤ 20 files per message, ≤ 500 MiB per workspace per day;
over a cap the file is recorded as `skipped {reason}`. In the transaction it inserts `mail_files` rows
(`direction = inbound`, `capability_id`, `event_external_id`, `filename`, `declared_mime`, `size_bytes`,
`sha256`) and writes `file_id` into the payload's attachment entries; a failed transaction deletes the stored
files (the Studio staging pattern). The consumer links the rows to the inbound `message_id` and `person_id`.

**Outbound.** `inbox.attachments_upload {request_key, filename, mime, data_base64}` (≤ 7 MiB decoded; types
`application/pdf`, `image/png`, `image/jpeg`, `text/plain`, `text/csv`, and the Office Open XML document and
spreadsheet types, each checked by magic bytes) stores a `staged` outbound file (expires after 7 days unused).
`inbox.reply`, `inbox.send` and `inbox.quotes.send` take `attachments: [file_id]` (≤ 5; total with the text ≤ the
10 MiB message bound; email conversations only). The intent stores the file ids; `prepare` reads the bytes into
`MailMessage.attachments` just before the provider call. A file is attached to one message (re-upload to reuse).
`quotes.send` with an attachment keeps `file_ref` as `mail_file:<id>` for the quote record.

**Reading.** `inbox.messages.list` items add `attachments: [{file_id, filename, declared_mime, size_bytes,
state}]`. `inbox.attachments_get` answers the metadata and a signed address valid 10 minutes with the new purpose
`attachment`, whose responses carry `Content-Disposition: attachment; filename*=UTF-8''…`,
`Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
sandbox`.

**Retention and erasure.** Inbound files are deleted after `attachments.retention_days` (default 180, owner
decides) by `mail_files_purge` (daily), staged outbound files after 7 days unused; the metadata row stays with
`deleted_at`. Person erasure deletes the files of that person's messages (bytes after commit, metadata scrubbed
in the scrub transaction).

### 3.16 Reporting and the learning loop

- `prospects.report {from, to, group_by: source | research_task | segment | sector | city | score_bucket |
  rubric_digest}` → per group: created, scored, qualified, rejected (by reason), promoted, contacted (an outreach
  or other outbound send after promotion), replied (an inbound after promotion), meetings (`AppointmentBooked`),
  quoted, won, lost (by reason), won revenue per currency, and the rates promoted→replied, replied→meeting,
  meeting→won. Grouping uses the prospect's snapshot at promotion (score bucket, rubric digest, task, segment).
- `outreach.report {campaign_id?, from, to, group_by: campaign | step | template}` → enrolled, skipped (by
  reason), sent, failed, bounced, complained, replied (threaded and unthreaded), unsubscribed, unique clicks
  (when on), automated clicks, meetings and won within 30 days of the person's first send, stopped (by reason).
- `[from, to)` are instants; the panel computes local-day bounds in the workspace's time zone.
- The playbook tells agents to read both reports weekly, to adapt targeting within the approved ICP, and to
  propose rubric or ICP changes to the owner through the strategy consultation (a new strategy version).

### 3.17 Work items (`work.pending` and `work.checkin`)

| Kind | Fields | Priority | Who | Cleared by |
|---|---|---|---|---|
| `research_due` | `task_id`, `remaining_today` | 3 | `prospects.work` | `prospects.create` |
| `prospects_to_score` | `count` (new prospects without a score under the current digest) | 3 | `prospects.work` | `prospects.score` |
| `prospects_to_promote` | `count` (qualified, unpromoted) | 3 | `prospects.work` | `prospects.promote` |
| `promoted_not_contacted` | `count` (promoted ≥ 2 days ago, open journey, no outbound) | 3 | `outreach.work` | `outreach.enroll` |
| `ownerless_journeys` | `count`, `oldest_journey_id` | 2 | `inbox.manage` | `inbox.journeys.assign_owner` |
| `assignment_stalled` | `count` | 2 | `inbox.manage` | `inbox.journeys.assign_owner` |
| `campaign_approval` | `campaign_id`, `revision` | 2 | humans with `outreach.manage` | `outreach.campaigns_approve` |
| `campaign_blocked` | `campaign_id`, `reason` | 2 | `outreach.work` | `outreach.campaigns_control` |
| `personalization_due` | `campaign_id`, `count` | 2 | `outreach.work` | `outreach.personalize` |

Each has an English hint naming the tool; the panel's Home renders its own copy (TR/EN).

### 3.18 Ledger

`prospects.created | updated {fields} | scored {score, digest} | qualified {auto} | rejected {reason} | reopened |
promoted | do_not_contact {reason, keys} | dnc_lifted {kind} | erased | purged {count}`;
`research.task_created | task_claimed | task_closed {outcome}`;
`distribution.assigned {journey_id, user_id, cause, rule_id} | reassigned | rules_set | rep_set | no_eligible`;
`outreach.template_saved | template_archived | campaign_saved {revision} | campaign_launched |
campaign_approved {revision} | campaign_paused {reason} | campaign_resumed | campaign_canceled |
campaign_completed | enrolled {count, skipped} | enrollment_stopped {reason} | unsubscribed | settings_set |
b2b_basis_set`; `inbox.attachment.uploaded`, `inbox.person.kind_set`. Payloads hold ids, counts, reasons and
field names only.

---

## 4. Persistence

All four migrations are repeatable `up`/`down` pairs; every new table has `workspace_id` with a foreign key to
`workspaces`, composite `(id, workspace_id)` uniqueness for child references, `enable` + `force row level
security`, and one `<table>_ws` policy in the 0006 form (archtest `sql_scoping`).

### 4.1 `0020_prospects`

```sql
select set_config('app.platform', 'on', true);
-- LeadsPolicy (pool retention and caps, distribution mode, outreach settings, attachment retention).
alter table workspace_policies add column if not exists leads_policy jsonb not null default '{}'
    check (jsonb_typeof(leads_policy) = 'object');
create table if not exists research_tasks (
    workspace_id uuid not null references workspaces (id), id uuid primary key,
    kind jsonb not null check (jsonb_typeof(kind) = 'object' and kind ? 'type'),
    strategy_version_id uuid not null, brief jsonb not null check (jsonb_typeof(brief) = 'object'),
    rubric_digest text not null check (char_length(rubric_digest) between 1 and 64),
    daily_cap integer not null check (daily_cap between 1 and 500),
    status text not null check (status in ('open','done','canceled','superseded')),
    claim jsonb, created_by jsonb not null, created_at timestamptz not null, closed_at timestamptz,
    close_note text not null default '' check (char_length(close_note) <= 1000),
    unique (id, workspace_id),
    foreign key (strategy_version_id, workspace_id) references strategy_versions (id, workspace_id)
);
create unique index if not exists research_tasks_one_standing on research_tasks
    (workspace_id, strategy_version_id, (kind->>'icp_key')) where status = 'open' and kind->>'type' = 'standing';
create table if not exists prospects (
    workspace_id uuid not null references workspaces (id), id uuid primary key,
    status text not null check (status in ('new','qualified','rejected','promoted','do_not_contact')),
    business_name text not null check (char_length(business_name) between 1 and 200),
    entity_kind text not null check (entity_kind in ('legal_entity','sole_trader','unknown_business')),
    sector text, city text, district text, country text not null default 'TR', language text, segment_key text,
    labels text[] not null default '{}',
    data jsonb not null check (jsonb_typeof(data) = 'object'),    -- contact, size, signals, notes, origin, decision
    research_task_id uuid,
    latest_score smallint check (latest_score between 0 and 100), latest_digest text,
    promoted_person_id uuid, promoted_journey_id uuid, promoted_at timestamptz, promoted_score smallint,
    purge_after timestamptz, revision bigint not null default 1 check (revision >= 1),
    created_at timestamptz not null, updated_at timestamptz not null,
    unique (id, workspace_id),
    foreign key (research_task_id, workspace_id) references research_tasks (id, workspace_id),
    foreign key (promoted_person_id, workspace_id) references people (id, workspace_id),
    foreign key (promoted_journey_id, workspace_id) references journeys (id, workspace_id),
    check ((status = 'promoted') = (promoted_person_id is not null))
);
create index if not exists prospects_list on prospects (workspace_id, status, created_at desc, id);
create index if not exists prospects_task on prospects (workspace_id, research_task_id, created_at);
create index if not exists prospects_purge on prospects (workspace_id, purge_after) where purge_after is not null;
create unique index if not exists prospects_person on prospects (workspace_id, promoted_person_id)
    where promoted_person_id is not null;
create table if not exists prospect_keys (
    workspace_id uuid not null references workspaces (id), prospect_id uuid not null,
    kind text not null check (kind in ('phone','email','instagram','tiktok','domain','name_city')),
    value text not null check (char_length(value) between 1 and 400),
    primary key (workspace_id, prospect_id, kind, value),
    foreign key (prospect_id, workspace_id) references prospects (id, workspace_id) on delete cascade
);
-- Hard keys are unique among the prospects that hold keys: new, qualified, rejected (until purged) and
-- promoted (kept for the pool's own "duplicate" answer). do_not_contact and erased rows hold none: their keys
-- live on only as blocklist hashes.
create unique index if not exists prospect_keys_hard on prospect_keys (workspace_id, kind, value)
    where kind in ('phone','email','instagram','tiktok');
create index if not exists prospect_keys_soft on prospect_keys (workspace_id, kind, value)
    where kind in ('domain','name_city');
create table if not exists prospect_scores (
    workspace_id uuid not null references workspaces (id), id uuid primary key, prospect_id uuid not null,
    score smallint not null check (score between 0 and 100), reasons jsonb not null check (jsonb_typeof(reasons) = 'array'),
    rubric_digest text not null, strategy_version_id uuid, recorder jsonb not null, at timestamptz not null,
    foreign key (prospect_id, workspace_id) references prospects (id, workspace_id) on delete cascade
);
create index if not exists prospect_scores_by_prospect on prospect_scores (workspace_id, prospect_id, at desc);
create table if not exists prospect_blocklist (
    workspace_id uuid not null references workspaces (id),
    kind text not null check (kind in ('phone','email','instagram','tiktok','domain','name_city')),
    key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
    reason text not null check (reason in ('do_not_contact','erased','rejected')),
    created_at timestamptz not null, expires_at timestamptz,
    check ((reason = 'rejected') = (expires_at is not null)),
    primary key (workspace_id, kind, key_hash)
);
create index if not exists prospect_blocklist_expiry on prospect_blocklist (workspace_id, expires_at)
    where expires_at is not null;
-- enable + force RLS and <table>_ws policies for the five tables, in the 0006 form.
-- owner and manager system roles gain prospects.work and prospects.manage (0017's backfill form).
```

Promoted prospects keep their keys. Because `in_inbox` is checked before `duplicate` (§3.3), a re-research of a
promoted business answers `in_inbox` while the person still holds that phone or email, and `duplicate` (with the
prospect id) for the handles or when the person's identities changed since; either way nothing is created.
A blocklist hit on a `do_not_contact`/`erased` entry overrides an existing `rejected` entry
(`insert … on conflict (workspace_id, kind, key_hash) do update set reason = excluded.reason, expires_at = null
where prospect_blocklist.reason = 'rejected'`).

Down: **refuses while the blocklist holds a `do_not_contact` or `erased` entry** (D27: the operator's runbook
exports those hashes and deletes them by hand first; rejection memory does not hold it up), then removes the two
permissions from the system roles, drops the five tables and drops `leads_policy` only when every row holds `{}`
(the 0014 pattern), else keeps it.

As built (L1-T2): `prospects` also has `latest_scored_at` (the `ScoreSummary.at`), checked null together with
`latest_score` and `latest_digest` (`prospects_latest_check`); `promoted_journey_id` and `promoted_at` are set
exactly when `promoted_person_id` is (`prospects_promoted_check`); `research_tasks` is closed exactly when it is
not open (`research_tasks_closed_check`) and has the list index `research_tasks_list`; the column checks bound
`sector`, `city`, `district` (1..=80), `country` (`^[A-Z]{2}$`), `language` (2..=8) and `segment_key` (2..=32).

### 4.2 `0021_distribution`

```sql
alter table people add column if not exists recipient_kind text not null default 'unknown'
    check (recipient_kind in ('unknown','business','individual'));
create table if not exists rep_profiles (
    workspace_id uuid not null references workspaces (id), user_id uuid not null references users (id),
    accepting boolean not null default true, max_open integer check (max_open between 1 and 10000),
    languages text[] not null default '{}', cities text[] not null default '{}', sectors text[] not null default '{}',
    hours jsonb, away_until timestamptz, updated_at timestamptz not null,
    primary key (workspace_id, user_id)
);
create table if not exists distribution_rules (
    workspace_id uuid not null references workspaces (id), id uuid primary key,
    position integer not null check (position between 0 and 99), name text not null check (char_length(name) between 1 and 80),
    enabled boolean not null default true, match jsonb not null, pool jsonb not null,
    method text not null check (method in ('round_robin','least_loaded')),
    sla_minutes integer check (sla_minutes between 5 and 10080), cursor_user_id uuid references users (id),
    updated_at timestamptz not null, unique (workspace_id, position)
);
create table if not exists journey_assignments (
    workspace_id uuid not null references workspaces (id), id uuid primary key, journey_id uuid not null,
    user_id uuid references users (id),
    cause text not null check (cause in ('rule','default','manual','sla_reassign','member_left','import','no_eligible')),
    rule_id uuid, assigned_at timestamptz not null, sla_due_at timestamptz, acted_at timestamptz,
    superseded_at timestamptz, by_actor jsonb not null,
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);
create unique index if not exists journey_assignments_live on journey_assignments (workspace_id, journey_id)
    where superseded_at is null;
create index if not exists journey_assignments_sla on journey_assignments (workspace_id, sla_due_at)
    where superseded_at is null and acted_at is null and sla_due_at is not null;
```

`journey_assignments` is append-only except `acted_at` and `superseded_at`, each written once (a trigger in the
`journey_attribution_immutable` style refuses other updates and deletes). The journey's `owner_id` stays the
truth for ownership (commission, queues); the assignment log is the decision history; both are written in the
same transaction by `distribution::assign`. Down: drops the three tables, and the `recipient_kind` column only
when every row is `unknown` (the 0014 pattern), else keeps it.

### 4.3 `0022_outreach`

```sql
create table if not exists outreach_templates (
    workspace_id uuid not null references workspaces (id), id uuid primary key,
    name text not null check (char_length(name) between 1 and 120), language text not null check (language in ('tr','en')),
    subject text not null check (char_length(subject) between 1 and 200), body text not null check (char_length(body) between 1 and 20000),
    revision bigint not null check (revision >= 1), archived boolean not null default false,
    created_by jsonb not null, updated_at timestamptz not null, unique (id, workspace_id)
);
create table if not exists outreach_campaigns (
    workspace_id uuid not null references workspaces (id), id uuid primary key,
    name text not null check (char_length(name) between 1 and 120), mailbox_id uuid not null,
    status text not null check (status in ('draft','awaiting_approval','scheduled','running','paused','completed','canceled')),
    definition jsonb not null check (jsonb_typeof(definition) = 'object'),  -- steps, audience, schedule, throttle, flags
    revision bigint not null check (revision >= 1), approval jsonb, pause_reason text,
    strategy_version_id uuid not null, created_by jsonb not null, created_at timestamptz not null, updated_at timestamptz not null,
    launched_at timestamptz, completed_at timestamptz, unique (id, workspace_id),
    foreign key (mailbox_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (strategy_version_id, workspace_id) references strategy_versions (id, workspace_id)
);
create index if not exists outreach_campaigns_running on outreach_campaigns (workspace_id, launched_at) where status = 'running';
create table if not exists outreach_enrollments (
    workspace_id uuid not null references workspaces (id), id uuid primary key, campaign_id uuid not null,
    person_id uuid not null, journey_id uuid, prospect_id uuid,
    status text not null check (status in ('active','completed','stopped','skipped')), reason text,
    next_step smallint not null default 1 check (next_step between 1 and 7), next_send_at timestamptz,
    personalization jsonb not null default '{}' check (jsonb_typeof(personalization) = 'object'),
    basis text check (basis in ('consent','business_recipient')),
    enrolled_at timestamptz not null, stopped_at timestamptz, last_sent_at timestamptz,
    unique (id, workspace_id), unique (workspace_id, campaign_id, person_id),
    foreign key (campaign_id, workspace_id) references outreach_campaigns (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id),
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id),
    foreign key (prospect_id, workspace_id) references prospects (id, workspace_id) on delete set null
);
create unique index if not exists outreach_enrollments_one_active on outreach_enrollments (workspace_id, person_id)
    where status = 'active';
create index if not exists outreach_enrollments_due on outreach_enrollments (workspace_id, campaign_id, next_send_at, id)
    where status = 'active';
create table if not exists outreach_sends (
    workspace_id uuid not null references workspaces (id), id uuid primary key, enrollment_id uuid not null,
    campaign_id uuid not null, mailbox_id uuid not null, step smallint not null check (step between 1 and 6),
    outbox_id uuid not null, message_id uuid not null, recipient_domain text not null,
    outcome text not null check (outcome in ('queued','sent','failed','unknown','refused','bounced','complained')),
    created_at timestamptz not null, sent_at timestamptz, replied_at timestamptz, replied_threaded boolean,
    first_clicked_at timestamptz, clicks integer not null default 0, automated_clicks integer not null default 0,
    unsubscribed_at timestamptz, unique (id, workspace_id), unique (workspace_id, outbox_id),
    foreign key (enrollment_id, workspace_id) references outreach_enrollments (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id)
);
create index if not exists outreach_sends_mailbox_day on outreach_sends (workspace_id, mailbox_id, created_at);
create index if not exists outreach_sends_campaign on outreach_sends (workspace_id, campaign_id, created_at);
create index if not exists outreach_sends_domain on outreach_sends (workspace_id, mailbox_id, recipient_domain, created_at);
-- RLS for the four tables; owner and manager gain outreach.work and outreach.manage.
```

`outreach_sends.outcome` is written only by the outreach hooks inside the transaction that records the outbox
result (`record_result_in`) or the evidence (`mail_evidence`), so it cannot drift from the outbox.

### 4.4 `0023_mail_files`

```sql
create table if not exists mail_files (
    workspace_id uuid not null references workspaces (id), id uuid primary key,   -- the FileStore id
    direction text not null check (direction in ('inbound','outbound')),
    state text not null check (state in ('stored','staged','attached','skipped','deleted')),
    skip_reason text, capability_id uuid, event_external_id text, message_id uuid, person_id uuid,
    filename text not null check (char_length(filename) <= 255), declared_mime text not null check (char_length(declared_mime) <= 255),
    size_bytes bigint not null check (size_bytes >= 0), sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null, expires_at timestamptz, deleted_at timestamptz,
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);
create index if not exists mail_files_message on mail_files (workspace_id, message_id);
create index if not exists mail_files_expiry on mail_files (workspace_id, expires_at) where deleted_at is null;
create index if not exists mail_files_event on mail_files (workspace_id, capability_id, event_external_id);
```

No change to `inbox_mask_personal`: it already blanks the whole `attachments` key of event payloads (0008).
`ErasureRepo::scrub` (Rust) also blanks `filename` of the person's `mail_files` and returns their ids for deletion.

### 4.5 Tables and pins

13 new tables (5 + 3 + 4 + 1): 74 → 87 on `958fcfe3`. Migrations 17 → 21 on `958fcfe3` (23 with 0018 and 0019).

### 4.6 Collision notes with the parallel branches

- 0018 and 0019 change `inbound_events_provider_check`, `outbox_state_check`, `inbox_mask_personal` and
  `inbox_event_person`; **0020–0023 change none of them**.
- `ReplyInput` gains `attachments` here and `item_id`/`visibility` there: independent optional fields.
- `WorkKind`, `Channel`, `TenantRepos`: disjoint additions; the second to merge rebases the pins (§7.3).
- `held`: §3.13. If 0019 merges first, L4-T5 adds the `Purpose::Outreach` exemption test to its hold rule; if this
  merges first, the 0019 implementer limits `held` to `Actor::Agent` replies.

---

## 5. Domain code

### 5.1 New crate `jt_prospects` (pure; allowlist: shared + `jt_inbox`, `jt_capability`, `jt_strategy`, `url`)

`ids.rs` (`ProspectId`, `ResearchTaskId`), `prospect.rs` (§3.1 types, `validate_create`, `validate_update`),
`evidence.rs` (`Evidence`, `SourceRef`, `Recorder`, `validate_evidence(field, &Evidence, now, recorder_kind)`),
`keys.rs` (`derive_keys(&Prospect) -> Vec<Key>`, `normalise_handle`, `website_domain`, `name_city`,
`FREE_MAIL_DOMAINS`, `PLATFORM_HOSTS`, `Key { kind, value, strength }`, `blocklist_material(kind, value) ->
Vec<u8>`), `status.rs` (§3.2), `score.rs` (`ScoreInput::validate(&Rubric)`, `bucket(score)`), `brief.rs`
(`Brief`, `validate_brief`), `policy.rs` (`ProspectsPolicy` with defaults and `purge_after(status, decided_at,
updated_at)`), `playbook.rs` (`TEXT`, `PLAYBOOK_VERSION`).

### 5.2 New crate `jt_outreach` (pure; allowlist: shared + `jt_inbox`, `jt_capability`, `jt_prospects`, `url`)

`ids.rs` (`TemplateId`, `CampaignId`, `EnrollmentId`, `SendId`), `template.rs` (parser, `validate_template`,
`variables_of`, `render(snapshot, vars, footer) -> Rendered { subject, text, links }`), `footer.rs` (TR/EN copy,
`Footer::render`), `campaign.rs` (§3.10 types and state machine), `audience.rs` (filters and their validation),
`enrollment.rs` (states, `stop_reason` keys, `Skip` reasons), `throttle.rs` (`warmup_cap`, `budget(...)`,
`frequency_ok(...)`, `domain_ok(...)`), `links.rs` (`rewrite(text, links, url_for) -> String`, URL token
format, `Mac` input bytes), `fence.rs` (`OutreachFence` facts and `check -> Result<(), Refusal>` for F2, F3, F7,
F9, F10, with stable keys), `report.rs` (row types).

### 5.3 `jt_inbox`

- `person.rs`: `Source::Prospect { prospect_id: Uuid, origin: String }` (before the untagged `V1Import`);
  `Person.recipient_kind: RecipientKind` (`#[serde(default)]`).
- `consent.rs`: `RecipientKind`, `CommercialBasis`, `commercial_basis` (§3.12).
- `fence.rs`: `FenceCtx.consent_ok` keeps its name and is now computed from `commercial_basis` by the caller;
  `SendIntent` unchanged.
- `journey.rs`: `JourneyEventKind::OutreachSent { campaign_id: Uuid, step: u8 }` — rank-neutral like
  `MessageReceived`, no effects, duplicate-key rules as every event (B4 tests extended).
- New `distribution.rs`: `Rule`, `Match`, `MemberPool`, `Method`, `SourceKind`, `LeadFacts`, `Candidate { user_id,
  on_shift, open_owned, eligible }`, `choose(rules, default_enabled, facts, candidates, cursors) -> Choice {
  user_id, rule_id, cause }` (pure; time-zone work stays in `jt_app`).
- `ids.rs`: `RuleId`, `AssignmentId`.

### 5.4 `jt_strategy`

`sections.rs`: `Prospecting`, `IcpEntry`, `Area`, `Rubric`, `Criterion` with `KEYS`; `Sections.prospecting`;
`Sections::KEYS` gains `"prospecting"`. `rules.rs`: gaps (§3.7), `diff` compares it, `next_draft_from` copies it.
`parse.rs`: strict parse of the section.

### 5.5 `jt_tenancy`

`Permission::{ProspectsWork, ProspectsManage, OutreachWork, OutreachManage}` with keys `prospects.work`,
`prospects.manage`, `outreach.work`, `outreach.manage`; `ALL_PERMISSIONS`; owner and manager through
`Permission::all()`; rep unchanged.

---

## 6. Application layer (`jt_app`)

### 6.1 Ports

- `ports/prospects.rs`: `ProspectRepo` (`lock_pool`, `insert(Prospect, keys)`, `update(Prospect, keys,
  expected_revision)`, `get`, `lock`, `list(ProspectQuery)`, `find_by_key(kind, value) -> Vec<ProspectId>`,
  `record_score(ScoreRow)` (row + latest in one call), `set_status(...)`, `promoted(...)`, `due_for_purge(now,
  limit)`, `delete(id)`, `created_today(task, from, to)`, `count_unscored(digest)`, `count_qualified_unpromoted`,
  `by_person(person)`), `ResearchTaskRepo` (`insert`, `get`, `lock`, `list`, `open_standing(version)`,
  `set_status`, `claim`), `BlocklistRepo` (`contains(kind, hash, now)`, `insert(entry)`, `lift(kind, hash)`,
  `purge_expired(now)`).
- `ports/distribution.rs`: `RepProfileRepo` (`get`, `list`, `set`), `RuleRepo` (`list`, `replace_all`,
  `set_cursor`), `AssignmentRepo` (`live(journey)`, `insert`, `supersede`, `touch(journey, user, at)`,
  `due_sla(now, limit)`, `ownerless_open(limit)`, `count_ownerless`, `count_stalled`, `previous_assignees`).
- `ports/outreach.rs`: `TemplateRepo`, `CampaignRepo` (`insert`, `get`, `lock`, `list`, `save(expected_revision)`,
  `set_status`, `running`), `EnrollmentRepo` (`insert_many`, `due(campaign, now, limit)` with `skip locked`,
  `advance`, `stop`, `stop_all_for(person, reason)`, `active_for(person)`, `personalize`), `OutreachSendRepo`
  (`insert`, `by_outbox`, `set_outcome`, `mark_replied`, `click`, `unsubscribed`, `counts_since(mailbox|campaign,
  since)`, `domain_count_since`, `person_sends_since`, `report(...)`).
- `ports/mail_files.rs`: `MailFileRepo` (`insert`, `link_event_to_message(capability, event_external_id, message,
  person)`, `stage`, `attach(ids, message)`, `get`, `for_messages`, `due_for_purge`, `mark_deleted`).
- `ports/connectors.rs`: `PolledMail { draft, attachments: Vec<InboundAttachment { filename, declared_mime,
  bytes }> }` and `MailboxPoller::poll -> (Vec<PolledMail>, MailboxCursor)`; `MailMessage` gains
  `#[serde(default)] from_name: Option<String>`, `#[serde(default)] list_unsubscribe: Option<ListUnsubscribe {
  https: String, mailto: Option<String> }>`, `#[serde(default)] attachment_files: Vec<Uuid>`;
  `ConsentSync::search(cred, recipient, channel) -> Result<IysAnswer, ConnectorError>` with a default body
  returning `Permanent("no consent lookup")`.
- `TenantRepos` gains `prospects()`, `research_tasks()`, `prospect_blocklist()`, `rep_profiles()`,
  `distribution_rules()`, `assignments()`, `outreach_templates()`, `outreach_campaigns()`,
  `outreach_enrollments()`, `outreach_sends()`, `mail_files()`. `WorkspacePolicy` gains `leads: LeadsPolicy {
  timezone, prospects: ProspectsPolicy, distribution: DistributionPolicy { mode, max_reassignments },
  outreach: OutreachPolicy { requires_approval, b2b_basis, require_iys_lookup, legal_ack, sender_company,
  sender_address, privacy_notice_url, warmup, frequency, click_tracking_default }, attachments: { retention_days }
  }`, read key by key over defaults (bug class "stale stored aggregate", as the parallel design does for
  `max_response_s`).

### 6.2 Use-case modules

| Module | Use cases |
|---|---|
| `usecases/prospects/{mod,pool,score,promote,blocklist,erase,report,settings,playbook}.rs` | §7.1 prospects rows; `rubric_digest`; `purge` (job body) |
| `usecases/research.rs` | §7.1 research rows; `plan` (job body) |
| `usecases/distribution.rs` | §7.1 distribution rows; `assign` (inline), `run` (job body), `touch` |
| `usecases/hours.rs` | `within_hours`, `local_day`, `add_working_minutes` (moved from `calls.rs`, which then uses them) |
| `usecases/outreach/{mod,templates,campaigns,audience,enroll,dispatch,hooks,links,report,settings}.rs` | §7.1 outreach rows; `dispatch` (job body); `hooks::{on_inbound, on_bounce, on_suppressed, on_journey_event, on_erased, on_merged}`; `links::{unsubscribe_page, unsubscribe, click}` |
| `usecases/inbox/attachments.rs` | upload, get, `store_polled_attachments`, `purge` (job body) |

### 6.3 Changes to existing use cases

| Where | Change |
|---|---|
| `inbox/replies.rs` | `Target::PersonVia(PersonId, CapabilityId)`; `Purpose::Outreach(OutreachSend)` (intent `outreach: {send_id, enrollment_id, campaign_id, step, basis}`, `mail.list_unsubscribe`, `mail.from_name`, author `System`, human-hold applied); `fence` computes `consent_ok` through `commercial_basis` with the person's `recipient_kind` and the policy's `b2b_basis`, and refuses `journey_won` for outreach; `ReplyInput.attachments` / `SendInput.attachments`; `prepare` loads `attachment_files` bytes; `record_result_in` applies `OutreachSent` instead of `Replied` for outreach intents and calls `outreach::hooks::on_receipt` |
| `inbox/consumer.rs` | `message` → `outreach::hooks::on_inbound` (reply stop; `unsubscribe` subject); `mail_evidence` → `on_bounce`; consent withdrawal → `on_suppressed`; inbound mail links `mail_files` |
| `inbox/people.rs` | `PersonOut` adds `recipient_kind` and `prospect`; new `set_kind` |
| `inbox/journeys.rs` | `assign_owner` writes a `manual` decision; `report` (and `consumer::apply_from`, `appointments::book`) call `outreach::hooks::on_journey_event` and `distribution::touch` (human actors) |
| `inbox/tasks.rs`, `inbox/notes` (`journeys::note`), `calls::place` | `distribution::touch` for human actors |
| `inbox/context.rs` | context adds `prospect` and `outreach: [EnrollmentSummary]`; `release_member` writes `member_left` decisions |
| `inbox/erasure.rs` | scrub linked prospect + blocklist hashes, stop enrollments, delete mail files after commit |
| `inbox/merge.rs` | `apply` stops the source person's active enrollments (`merged`); undo does not restart them |
| `inbox/quotes.rs` | `attachments` on email quotes; `file_ref = mail_file:<id>` |
| `strategy.rs` | `write_section("prospecting")`; approval runs `research::on_strategy_approved` (supersede tasks) |
| `work.rs` | the nine work kinds of §3.17 with their `cleared_by` |
| `jobs.rs` | five jobs (§6.4); `run_mail_inbox_poll` stores attachments |
| `v1_import.rs` | §10 |

### 6.4 Jobs

| Job | Interval | Workspaces | What |
|---|---|---|---|
| `research_plan` | 1 h | active | standing tasks per ICP entry of the approved version; supersede older |
| `prospects_purge` | 1 day | active, pending payment, suspended | delete prospects past `purge_after` (rejected memory hashes first), purge expired blocklist entries |
| `lead_distribution` | 1 min | active | ownerless open journeys without a live decision → `assign`; SLA reassignment; capped at 200 decisions per workspace per run |
| `outreach_dispatch` | 1 min | active | §3.11 |
| `mail_files_purge` | 1 day | every status | retention and staged-file expiry; bytes deleted, rows marked |

Job::ALL 28 → 33; scheduler intervals and their test; each job body skips a workspace whose lock is held and logs
counts only (no names, addresses or values in `tracing`).

---

## 7. Catalog

### 7.1 New rows (all twins, all `Gated`, workspace must be active)

| Use case | MCP tool | Route | Risk | Permission |
|---|---|---|---|---|
| `prospects.playbook` | `jeeta.prospects.playbook` | `GET /api/prospects/playbook` | Read | `prospects.work` |
| `prospects.check` | `jeeta.prospects.check` | `POST /api/prospects/check` | Read | `prospects.work` |
| `prospects.create` | `jeeta.prospects.create` | `POST /api/prospects` | Write | `prospects.work` |
| `prospects.update` | `jeeta.prospects.update` | `PATCH /api/prospects/{prospect_id}` | Write | `prospects.work` |
| `prospects.list` | `jeeta.prospects.list` | `GET /api/prospects` | Read | `prospects.work` |
| `prospects.get` | `jeeta.prospects.get` | `GET /api/prospects/{prospect_id}` | Read | `prospects.work` |
| `prospects.score` | `jeeta.prospects.score` | `POST /api/prospects/{prospect_id}/scores` | Write | `prospects.work` |
| `prospects.decide` | `jeeta.prospects.decide` | `POST /api/prospects/{prospect_id}/decision` | Write | `prospects.work`; reopen `prospects.manage`, human |
| `prospects.promote` | `jeeta.prospects.promote` | `POST /api/prospects/promote` | Write | `prospects.work` + `inbox.work` |
| `prospects.do_not_contact` | `jeeta.prospects.do_not_contact` | `POST /api/prospects/do-not-contact` | Destructive (`confirm`) | `prospects.work` |
| `prospects.dnc_lift` | `jeeta.prospects.dnc_lift` | `POST /api/prospects/do-not-contact/lift` | Write | `prospects.manage`, human |
| `prospects.erase` | `jeeta.prospects.erase` | `POST /api/prospects/{prospect_id}/erase` | Destructive (`confirm`) | `prospects.manage` |
| `prospects.report` | `jeeta.prospects.report` | `GET /api/prospects/report` | Read | `prospects.work` |
| `prospects.settings_get` | `jeeta.prospects.settings_get` | `GET /api/prospects/settings` | Read | `prospects.work` |
| `prospects.settings_set` | `jeeta.prospects.settings_set` | `PUT /api/prospects/settings` | Write | `prospects.manage` |
| `research.tasks_list` | `jeeta.research.tasks_list` | `GET /api/research/tasks` | Read | `prospects.work` |
| `research.tasks_get` | `jeeta.research.tasks_get` | `GET /api/research/tasks/{task_id}` | Read | `prospects.work` |
| `research.tasks_create` | `jeeta.research.tasks_create` | `POST /api/research/tasks` | Write | `prospects.work` |
| `research.tasks_claim` | `jeeta.research.tasks_claim` | `POST /api/research/tasks/{task_id}/claim` | Write | `prospects.work` |
| `research.tasks_close` | `jeeta.research.tasks_close` | `POST /api/research/tasks/{task_id}/close` | Write | `prospects.work` |
| `distribution.get` | `jeeta.distribution.get` | `GET /api/distribution` | Read | `inbox.work` |
| `distribution.rules_set` | `jeeta.distribution.rules_set` | `PUT /api/distribution/rules` | Write | `inbox.manage` |
| `distribution.rep_set` | `jeeta.distribution.rep_set` | `PUT /api/distribution/reps/{user_id}` | Write | `inbox.work` (own), `inbox.manage` (others) |
| `distribution.assignments_list` | `jeeta.distribution.assignments_list` | `GET /api/distribution/assignments` | Read | `inbox.work` |
| `distribution.backfill` | `jeeta.distribution.backfill` | `POST /api/distribution/backfill` | Write | `inbox.manage` |
| `outreach.templates_list` | `jeeta.outreach.templates_list` | `GET /api/outreach/templates` | Read | `outreach.work` |
| `outreach.templates_save` | `jeeta.outreach.templates_save` | `POST /api/outreach/templates` | Write | `outreach.work` |
| `outreach.templates_archive` | `jeeta.outreach.templates_archive` | `POST /api/outreach/templates/{template_id}/archive` | Write | `outreach.work` |
| `outreach.campaigns_list` | `jeeta.outreach.campaigns_list` | `GET /api/outreach/campaigns` | Read | `outreach.work` |
| `outreach.campaigns_get` | `jeeta.outreach.campaigns_get` | `GET /api/outreach/campaigns/{campaign_id}` | Read | `outreach.work` |
| `outreach.campaigns_save` | `jeeta.outreach.campaigns_save` | `POST /api/outreach/campaigns` | Write | `outreach.work` |
| `outreach.audience_preview` | `jeeta.outreach.audience_preview` | `POST /api/outreach/audience-preview` | Read | `outreach.work` |
| `outreach.campaigns_launch` | `jeeta.outreach.campaigns_launch` | `POST /api/outreach/campaigns/{campaign_id}/launch` | Write | `outreach.work` |
| `outreach.campaigns_approve` | `jeeta.outreach.campaigns_approve` | `POST /api/outreach/campaigns/{campaign_id}/approve` | Write | `outreach.manage`, human |
| `outreach.campaigns_control` | `jeeta.outreach.campaigns_control` | `POST /api/outreach/campaigns/{campaign_id}/control` | Write | `outreach.work`; cancel `outreach.manage` |
| `outreach.enroll` | `jeeta.outreach.enroll` | `POST /api/outreach/campaigns/{campaign_id}/enrollments` | Write | `outreach.work` |
| `outreach.enrollments_list` | `jeeta.outreach.enrollments_list` | `GET /api/outreach/campaigns/{campaign_id}/enrollments` | Read | `outreach.work` |
| `outreach.enrollments_stop` | `jeeta.outreach.enrollments_stop` | `POST /api/outreach/enrollments/{enrollment_id}/stop` | Write | `outreach.work` |
| `outreach.personalize` | `jeeta.outreach.personalize` | `POST /api/outreach/enrollments/personalization` | Write | `outreach.work` |
| `outreach.test_send` | `jeeta.outreach.test_send` | `POST /api/outreach/campaigns/{campaign_id}/test` | Write | `outreach.work` (to a member's own login address only) |
| `outreach.report` | `jeeta.outreach.report` | `GET /api/outreach/report` | Read | `outreach.work` |
| `outreach.settings_get` | `jeeta.outreach.settings_get` | `GET /api/outreach/settings` | Read | `outreach.work` |
| `outreach.settings_set` | `jeeta.outreach.settings_set` | `PUT /api/outreach/settings` | Write | `outreach.manage`; `b2b_basis`/`require_iys_lookup` owner, human |
| `inbox.attachments_upload` | `jeeta.inbox.attachments_upload` | `POST /api/inbox/attachments` | Write | `inbox.work` |
| `inbox.attachments_get` | `jeeta.inbox.attachments_get` | `GET /api/inbox/attachments/{file_id}` | Read | `inbox.work` |
| `inbox.people.set_kind` | `jeeta.inbox.people_set_kind` | `POST /api/inbox/people/{person_id}/kind` | Write | `inbox.work` |

`prospects.check`, `prospects.dnc_lift` and `outreach.audience_preview` are `POST` although two of them only read:
their bodies carry contact values or filters, and contact values never go into a URL (logs, history, proxies).

46 rows: prospects 15, research 5, distribution 5, outreach 18, inbox 3. Typed inputs (`deny_unknown_fields`,
schemars) shared by both surfaces (the `work`/`devices` pattern). MCP descriptions end with the risk and name the
fences an agent will meet (Appendix A is linked from `prospects.playbook`'s description). The two public routes
(§3.14) are not catalog rows: like `/hooks/*` and `/files/*` they have no authenticated caller.

### 7.2 Changed rows

`inbox.reply`, `inbox.send`, `inbox.quotes.send` (input `attachments`), `inbox.messages.list` (attachments),
`inbox.context` and `inbox.people.get` (`prospect`, `outreach`, `recipient_kind`), `inbox.journeys.assign_owner`
(writes a decision), `inbox.people.erase` (prospect, enrollments, files), `strategy.write_section` and
`strategy.get` (section `prospecting`), `work.pending`/`work.checkin` (§3.17).

### 7.3 Pins that change together (from `958fcfe3`; add the parallel branch's increments when it lands first)

| Pin | From → to |
|---|---|
| `jt_app/tests/catalog.rs` `CATALOG.len()` and its row table | 169 → 215 |
| `jt_archtest/tests/m4_productisation.rs` `POST_M4_ADDED` | `[_; 15]` → `[_; 61]`; registry 140 → 186 |
| `jt_archtest/tests/twin_rule.rs` `the_registry_holds_140_tools` (rename to `_186_`), `MCP_TOOLS_BY_DOMAIN` | + `prospects` 15, `research` 5, `distribution` 5, `outreach` 18; `inbox` 46 → 49 |
| `jt_archtest/tests/twin_rule.rs` `destructive_confirmation_tools_are_explicitly_listed` | + `jeeta.prospects.do_not_contact`, `jeeta.prospects.erase` |
| `jt_archtest/tests/studio_rules.rs` registry / tables | 140 → 186 / 74 → 87 |
| `jt_archtest/tests/inbox_rules.rs`, `gate_rule.rs` inbox rows; `jt_mcp/tests/inbox_mcp.rs` | 46 → 49 |
| `jt_mcp/tests/billing/m4_billing_mcp.rs` tools | 140 → 186 |
| `jt_pg/tests/migrations.rs` `TABLES_AFTER_ALL`, `MIGRATIONS`, down list | 74 → 87, 17 → 21, + four names |
| `jt_app/tests/jobs.rs` names; `bin/jeeta/src/scheduler.rs` intervals test | + five jobs |
| `jt_archtest/tests/dependency_boundaries.rs` `DOMAIN_CRATES` | + `jt_prospects`, `jt_outreach` |
| `jt_tenancy` role tests; panel `Permission` union and `permissions.*` i18n | + four permissions |
| `jt_strategy/tests/rules.rs` `Sections::KEYS` tests | + `prospecting` |
| `jt_files` serve tests | + purpose `attachment` |
| new `jt_archtest/tests/leads_rules.rs` | playbook text equals Appendix A; every tool the playbook names exists |
| panel `api/types.ts` `WorkKind` | + nine kinds |

With 0019 first: 175 → 221 rows, 146 → 192 tools, inbox 52 → 55, tables 77 → 90, Job::ALL 30 → 35.

---

## 8. Adapters

- **`jt_mail`**: `smtp::wire` sets `From` with `from_name` (refused if it holds CR/LF or is over 80 chars), adds
  `List-Unsubscribe` and `List-Unsubscribe-Post` when `list_unsubscribe` is set (lettre custom headers; V-L1),
  validates the URLs (https, ≤ 2048, no CR/LF); `imap::poll` returns `PolledMail` with attachment bytes for
  non-sent messages (the parser keeps metadata in the payload as today); `parse.rs` adds `declared_mime` to the
  metadata.
- **`jt_netgsm`**: implements `ConsentSync::search` over the existing `iys_search` (recipient type for business
  addresses: V-I1).
- **`jt_files`**: purpose `attachment` (signature `jeeta.files.v2` with the purpose), response headers of §3.15.
- **`jt_webhook::links`** (new module, merged in `jt_webhook::router`): the four public routes; HTML built with
  escaping helpers, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a strict CSP; bodies ≤ 1 KiB;
  calls `jt_app::usecases::outreach::links::*`. No new dependency (`WEBHOOK_ALLOW` unchanged).
- **`jt_pg`**: repos `repos/prospects.rs`, `repos/research.rs`, `repos/distribution.rs`, `repos/outreach/*.rs`,
  `repos/inbox/mail_files.rs`; the `skip locked` picks use a materialized CTE (the device-bridge over-lease
  lesson); `ErasureRepo::scrub` extensions; `ImportRepos` extensions for pool rows (§10).
- **`jt_mcp`**: `tools/{prospects,research,distribution,outreach}.rs`; inbox additions in `tools/inbox.rs`.
- **`jt_panel_http`**: `routes/{prospects,research,distribution,outreach}.rs`; inbox additions.
- **`jt_testkit`**: fakes for every new repo, contract tests `prospects_contract.rs`, `distribution_contract.rs`,
  `outreach_contract.rs`, `mail_files_contract.rs` run against fake and Postgres.

---

## 9. Panel (`rust/panel`)

| Page | Path | Content |
|---|---|---|
| Aday havuzu | `/prospects` | filters (status, segment, task, city, sector, score bucket, label, text), table (business, sector, city, score, status, origin, created), per-row and bulk actions (promote, reject, DNC) with per-row pending state; the playbook in a disclosure |
| Aday | `/prospects/:id` | fields with their evidence (source links open in a new tab with `rel="noopener noreferrer"`, captured time, recorder: agent connection name or member), signals, score history with reasons per criterion and digest, duplicate candidates, decision history (ledger), actions (qualify, reject with reason, promote, DNC with typed confirmation, erase with typed `SİL`/`ERASE`) |
| Araştırma görevleri | `/prospects/tasks` | standing and ad-hoc tasks, brief, today's progress and remaining, claim, create (form mirrors the brief), close |
| Dağıtım | `/team/distribution` (a tab of Team) | mode (auto/manual), ordered rules editor (drag or up/down, match chips, pool, method, SLA), rep availability table (accepting, capacity, languages, cities, sectors, hours, away), live counts (ownerless, stalled), "dağıt" backfill button, assignment log |
| Kampanyalar | `/outreach` | campaigns with status, progress (enrolled/sent/replied/unsubscribed), blockers |
| Kampanya | `/outreach/:id` | steps editor (template picker, delay, same thread), audience builder with live preview counts and skip reasons, schedule window, throttle, click tracking toggle, sender; approval card (approve at revision, who drafted), run controls, enrollments table with stop, report tab |
| Şablonlar | `/outreach/templates` | editor with variable chips, live render with sample values and the fixed footer, link list |
| E-posta ayarları | `/outreach/settings` | sender identity, privacy notice URL, approval switch, warm-up, frequency caps; the B2B basis section visible to owners only, with the legal acknowledgement text and the İYS lookup switch |
| Raporlar | `/prospects/report`, `/outreach/:id` report tab | the two reports with grouping selectors, local-day ranges |
| Inbox additions | `/inbox` | "Sahipsiz" journeys queue; journey panel: prospect facts and evidence, active sequence with stop, recipient kind badge and setter, owner assignment history; messages: attachment chips (download), composer attachment upload (email only), reset on conversation change (bug class "reused-component stale state") |
| Home | `/` | the nine work kinds (`itemText`, `itemLink`) |

Nav gains "Aday havuzu" and "Kampanyalar" (TR) / "Prospects" and "Campaigns" (EN). TR + EN copy with parity
(`i18n/parity.test.ts`); `Permission` union and `permissions.*` copy gain the four keys. Every mutation uses one
request key per draft and the pending guard on Enter (bug class "Enter double-submit").

---

## 10. v1 import

**Today** (`usecases/v1_import.rs`): every v1 lead becomes an inbox person (identities: phone, WhatsApp, email,
with legacy-alias matching), a journey with the v1 stage (`import_journey`, `Source::V1Import`), one note (v1
notes plus a "v1 bilgileri" block), a follow-up task when due in the future, withdrawals and suppressions for
opt-outs and bounces; 100-row transactions; dry run executes and rolls back each chunk; rollback deletes untouched
aggregates; counts-only report and ledger entry.

**Export v2** (operator, local file, never committed): the `Lead` allowlist gains optional fields (still
`deny_unknown_fields`; camelCase on the wire like the existing fields, written here in snake_case): `format` (2), `deleted_at`, `merged_into_id`, `contact { conversations_outbound,
conversations_inbound, campaign_sent, mail_sent, activities_outbound, offers, last_contact_at }`, `activities
[{id, type, title, description, outcome, created_at}]`, `offers [{id, status, plan_name, price, currency,
valid_until, created_at}]`, `tags [String]`, `attribution {utm_*, landing_path, referrer_host}` (query strings
other than `utm_*` dropped at export), `research {evidence, pain_point, pitch, stage, website, instagram, score,
created_at}` (from `research_candidates` with that `leadId`), `ai_score`, `ai_score_reason`, `scored_at`,
`owner_email`, `email_verified_status`. Appendix B sketches the export query (column names to be verified against
`schema.prisma`'s `@map`s at export time).

**Routing** (`v1_import::route(&Lead) -> Route`, pure):

| Condition (in order) | Route |
|---|---|
| `deleted_at` or `merged_into_id` set | skip (`skipped_deleted`, `skipped_merged`) |
| status other than `NEW` | inbox (today's path) |
| any contact evidence (`contact.*` > 0) | inbox |
| source in `INSTAGRAM, WEBSITE, PHONE, EMAIL, ADS, REFERRAL, HARDWARE_QUOTE, FIELD_VISIT` (they reached us, or we met them) | inbox |
| otherwise (`AI_RESEARCH`, `IMPORT`, `OTHER` and never contacted) | pool |

**Inbox route additions**: each v1 activity except `STATUS_CHANGE` becomes a note (`"v1 {type} · {outcome} ·
{title}\n{description}"`, author system, at its time, deterministic id `activity:<id>`); offers become one note
("v1 teklifleri", no quote rows: v1 offers have no delivery channel and Rust quotes require one, never invented);
tags and attribution become lines of the "v1 bilgileri" block; `ai_score` a line too; `owner_email` mapped to an
active member's user id becomes the journey owner with an `import` decision, an unmapped one leaves it ownerless
(`ownerless_journeys`, distributed by `distribution.backfill`).

**Pool route**: a prospect with deterministic id `entity_id(ws, lead, "prospect")`, status `new`, `entity_kind =
unknown_business`, `business_name`, `contact_person` (name only, role empty), phone/WhatsApp/email/address as
fields with `Recorder::Import { system: "v1", record: lead_id }`, `SourceRef::Import`, and the research website or
Instagram as an `Url` source when present; `city`, `district = region`, `sector` from `businessType` (lowercased),
`size` from `branchCount` (and `tableCount` in its note), signals from `currentSystem`, `painPoint` and research
`evidence` (as `Import` sources), labels from tags, notes from `notes` and custom fields; `origin.via = v1_import`;
`ai_score` as a score row with digest `v1-legacy`; `email_bounced_at` → the email field `deliverable = false`;
`email_opt_out` → a DNC hash for the email, `sms_opt_out`/`wa_opt_out` → for the phone. Retention starts at the
import (not at v1's `createdAt`, which would purge most rows on the first run; owner decides, Q4). Dedupe as §3.3:
a hard-key collision with an existing prospect counts `pool_duplicates`; a match with an inbox identity counts
`pool_in_inbox` and imports nothing for that lead (the relationship exists).

**Modes**: `--dry-run` (now also counts `to_inbox`, `to_pool`, `skipped_*`, `pool_duplicates`, `pool_in_inbox`,
`pool_dnc`, `owners_mapped`, `owners_unmapped`, `activities_as_notes`, `offers_as_notes`), import, `--rollback`
(also deletes unchanged imported prospects: revision 1, status `new`, no score but `v1-legacy`). Run order on
production: export → dry run on a staging copy → owner reads the counts → import → spot check → v1 read-only.

v1 research candidates still `PENDING` (not leads) are not in this export; whether to import them is Q4.

---

## 11. Tests

| Layer | Where | What |
|---|---|---|
| Pure domain | `jt_prospects/tests/{keys,status,evidence,score,brief,policy}.rs`; `jt_outreach/tests/{template,render,footer,campaign,throttle,links,fence}.rs`; `jt_inbox/tests/{distribution,consent_basis}.rs` and extended `reducer.rs`; `jt_strategy/tests/rules.rs` | key normalisation tables (Turkish folds, IDNA, platform hosts, free mail), every status pair, evidence windows and recorder kinds, score sums and digest mismatch, buckets, template parser (fallbacks, unknown names, braces, links), render with missing values, footer TR/EN, campaign state pairs and revision voiding, warm-up schedule and reset, budgets, frequency and domain pacing, link rewriting (punctuation, variables untouched), MAC input bytes, `commercial_basis` matrix (consent × suppression × withdrawal × kind × channel), `OutreachSent` rank-neutral and duplicate rules, `choose` (order, fallthrough, default rule, on-shift preference, round-robin cursor, least loaded ties, manual mode), prospecting gaps |
| Application (fakes) | `jt_app/tests/{prospects_pool,prospects_promote,prospects_kvkk,research_tasks,distribution,outreach_campaigns,outreach_dispatch,outreach_hooks,outreach_links,inbox_attachments,v1_import_routing}.rs` | dedupe order and every refusal; caps in a third time zone (bug class "server-local vs workspace tz"); provenance recorder from ctx, never input; auto-qualify; promotion reuse/new/lost/won/split; inline distribution; purge and rejected memory; DNC survives purge; erasure from both sides; never-silent: journeys from every creation path are owned or counted after one job tick; SLA in working hours and reassignment limit; dispatch budgets, window, pacing, warm-up; every fence refusal at enqueue **and** claim; stop rules authoritative without hooks; reply threaded/unthreaded; bounce, complaint, unsubscribe via POST, `GET` never unsubscribes, bad MAC, suspended workspace honoured, `mailto:` subject; click redirect, automated clicks, unknown link; approval revision voiding; `held` not applied to outreach; attachments caps, staging compensation, prepare reads bytes, erasure deletes; v1 routing table and counts |
| Persistence (Linux CI) | `jt_pg/tests/{migrations,prospects_repos,distribution_repos,outreach_repos,mail_files_repos,inbox_erasure}.rs` | up/down/up for 0020–0023; RLS on 13 tables; hard-key uniqueness under concurrency; `skip locked` picks never over-lease; one active enrollment per person; assignment log immutability trigger; scrub of prospect, enrollments and files |
| Gate | `jt_webhook/tests/links.rs` | the four public routes: status codes, headers, no cookies, body bounds |
| Adapters | `jt_mail/tests/mail.rs` | headers on the wire (`List-Unsubscribe`, `List-Unsubscribe-Post`, `From` name), header injection refused, attachments returned by poll, sent folder skipped; `jt_netgsm` search mapping; `jt_files` attachment purpose headers |
| Twins | `jt_archtest/tests/twin_parity.rs` | each new row answers the same on MCP and HTTP |
| Panel | `Prospects.test.tsx`, `ProspectDetail.test.tsx`, `ResearchTasks.test.tsx`, `Distribution.test.tsx`, `Outreach*.test.tsx`, `Inbox.test.tsx`, `HomePage.test.tsx` | filters, per-row pending, evidence links, approval card, audience preview, i18n parity |
| Smoke | `make smoke-leads` (`jt_app/tests/smoke_leads.rs`) | strategy with ICP → standing task → agent creates and scores prospects → auto-qualify → promote → distribution owner → campaign (2 steps) → dispatch → SMTP fixture receives headers and footer → IMAP fixture reply → enrollment stopped, journey Contacted after our answer → unsubscribe POST on another → report numbers |

---

## 12. Legal points for the owner's lawyer (LAWYER)

Not legal advice; each item blocks what is named until answered.

| Id | Question | Blocks |
|---|---|---|
| L-01 | Does the 6563 law's regulation (Ticari İletişim ve Ticari Elektronik İletiler Hakkında Yönetmelik) allow commercial email to esnaf/tacir recipients without prior consent, and on what conditions? | enabling `b2b_basis` |
| L-02 | Which pool data is personal data (sole traders, named contact persons at legal entities), and does the "business only, publicly published by the business" rule suffice for minimisation? | pool launch |
| L-03 | Must a sender check İYS for business recipients (tacir) before a commercial email, and does a `RET` there bind email to a business address? | `require_iys_lookup` default |
| L-04 | Lawful basis for collecting public business contact data for prospecting (KVKK art. 5(2)(f) legitimate interest?), and the balancing record the workspace keeps | pool launch |
| L-05 | Retention periods (rejected 30 days, unpromoted 180 days, rejected memory 365 days) | defaults |
| L-06 | Keeping hashed keys after erasure or objection to honour do-not-contact | blocklist design |
| L-07 | Footer: required sender identity fields, the data-source line, the information notice (KVKK art. 10) at first contact, and the opt-out wording | launch |
| L-08 | Click tracking disclosure in the privacy notice | `click_tracking` |
| L-09 | Inbound attachment retention (180 days) and handling of special-category data in attachments | attachments |
| L-10 | Who is data controller/processor between the workspace and Jeeta for pool data, and what the DPA says | product terms |

## 13. To verify (VERIFY)

| Id | What | Blocks |
|---|---|---|
| V-E1 | Current Gmail/Yahoo sender requirements for authenticated mail and one-click unsubscribe at the volumes in D15 | panel warning copy |
| V-E2 | Whether receivers require `List-Unsubscribe-Post` to be covered by DKIM, and how common mailbox providers (Google Workspace, Microsoft 365, cPanel hosts) sign submitted mail | docs |
| V-L1 | lettre's API for custom header types in the version pinned in `Cargo.lock` | L5-T1 |
| V-I1 | NetGSM `/iys/search` parameters for business (tacir) recipients and the answer shape | L4-T5 İYS lookup |
| V-R1 | That `RFC 8058` POST bodies from major receivers are `application/x-www-form-urlencoded` with `List-Unsubscribe=One-Click` (the route accepts any body that contains it, and an empty body from the confirm form) | L5-T2 |

## 14. Risks

| Risk | Mitigation |
|---|---|
| Unsolicited mail damages the customer's domain | B2B basis off by default (D17); warm-up, per-domain pacing, frequency caps, auto-pause (D15); one-click unsubscribe |
| An agent floods the pool | per-task and workspace daily caps; backlog target; playbook pacing |
| Bad data from research | evidence per field; human review in the panel; reject reasons feed the report |
| Distribution assigns hundreds of imported leads at once | import decisions are counted, not assigned; `backfill` is a manager's capped call |
| Attachments carry malware | stored as octet-stream, download-only with `sandbox` CSP; no preview; scanning is a later phase |
| Blocklist lost on key loss | the HMAC key derives from the master key that also opens credentials: the backup runbook already protects it |
| The two parallel branches collide on pins | §4.6, §7.3 |
| Strategy change mid-campaign | campaigns record their strategy version; a new approved version pauses running campaigns whose segment left the strategy (`strategy_changed`), others continue |

## 15. Open questions for the owner

1. **B2B basis.** Until your lawyer answers L-01/L-03, outreach can email only people who consented, which in
   practice means almost no cold outreach. Will you get that answer, and should the İYS lookup stay mandatory?
2. **Retention numbers.** Rejected 30 days, unpromoted 180 days, rejected memory 365 days, inbound attachments
   180 days — keep them? **Answered 2026-10-30 by the owner's delegate: kept (D26).**
3. **Your sender identity and privacy notice.** For your own workspace: the company title, address and the
   privacy notice (aydınlatma metni) URL the footer links to.
4. **v1 specifics.** (a) Import v1 research candidates still `PENDING` into the pool, or drop them? (b) Map v1
   owners by login email to Rust members? (c) Start the retention clock of imported prospects at import?

---

## Appendix A. Agent playbook (served by `jeeta.prospects.playbook`, `PLAYBOOK_VERSION = 1`)

```text
JEETA PROSPECTING PLAYBOOK v1

Purpose. You find businesses that fit this workspace's approved ideal customer profile (ICP), record them in
Jeeta's prospect pool with evidence, score them against the workspace's rubric, and promote the ones worth
contacting. Jeeta never browses or calls any data service: you research with your own tools (web search, a
browser, and, if this workspace has one, the phone through jeeta.devices.*). Jeeta stores, checks, dedupes,
assigns and fences what you record.

Before you start.
1. Call jeeta.work.checkin. Research when it lists research_due; score when it lists prospects_to_score;
   promote when it lists prospects_to_promote.
2. Read this playbook's workspace section: the ICP entries, the rubric and its digest, today's remaining caps.
3. Call jeeta.research.tasks_get for the task, and jeeta.research.tasks_claim before working on it.

Finding businesses.
- Work one ICP entry at a time: its sectors, areas, signals and exclusions.
- Discover candidates on public pages: search results, business directories, map listings viewed in a browser,
  the business's own website and its official social profiles.
- Before researching a business in depth, call jeeta.prospects.check with what you know (name and city, phone,
  website, handles). Skip it if the answer is duplicate, possible_duplicate, in_inbox, previously_rejected or
  do_not_contact.
- Pace yourself like a person: open pages one at a time; never run bulk or automated extraction against a site;
  respect robots.txt and each site's terms; never log in to see data that is not public.

What to record (jeeta.prospects.create).
- business_name, entity_kind (legal_entity for a company such as A.Ş. or Ltd. Şti., sole_trader for a
  sole proprietorship or esnaf, unknown_business if you cannot tell), sector, city, district, language,
  segment_key (from the ICP entry), size (branches, employee band), signals (why it fits, each with its source).
- Contact fields: phone, email, website, instagram, tiktok, address, contact_person. Each field needs at least
  one source URL of a public page where the business itself publishes that value (its website's contact page,
  its official profile, its listing). Give captured_at: when you saw it.
- Never record: a private individual who is not acting as a business; personal social accounts of employees or
  owners; home addresses; personal phone numbers or emails that the business does not publish as its contact;
  data from leaked databases, people-search or data-broker sites; emails you guessed from a pattern (such as
  name@domain) — only addresses you saw published; anything about health, religion, politics, ethnicity or
  other special categories.
- contact_person only when the business publishes the name and role itself (for example an "About" page);
  name and role only.
- Notes describe the business, never a person.

Scoring (jeeta.prospects.score).
- Score 0-100 with the workspace's rubric: one reason per criterion, the points you give it (up to its weight),
  and the evidence in one sentence with its source. The points must add up to the score. Send the rubric_digest
  from this playbook; if Jeeta answers rubric_mismatch, read the playbook again.
- A score at or above qualify_at qualifies the prospect automatically. Reject what does not fit with
  jeeta.prospects.decide and a reason (not_icp, closed_business, no_contact_data, competitor, already_customer,
  duplicate, other with a note).

Promoting (jeeta.prospects.promote).
- Promote qualified prospects you intend to contact soon. Promotion creates the person and the sales journey in
  the inbox; Jeeta assigns an owner by the workspace's rules. Do not promote more than you can contact this week.
- Never contact a prospect that is not promoted. Contact happens through Jeeta (campaigns or the inbox), never
  from your own accounts.

Objections and corrections.
- If a business asks not to be contacted, call jeeta.prospects.do_not_contact (reason objected) at once.
- If you find a recorded value is wrong or no longer published, update or clear it with jeeta.prospects.update.

Limits.
- Respect today's remaining count per task; Jeeta refuses beyond it (daily_cap).
- Rejected and unpromoted prospects are deleted after the workspace's retention period; do not keep copies of
  pool data in your own notes or memory beyond the current task.

Learning.
- Once a week read jeeta.prospects.report (by score bucket, sector and source) and jeeta.outreach.report. Adjust
  which businesses you look for within the approved ICP. To change the ICP or the rubric, propose it to the owner
  through the strategy consultation (jeeta.strategy.start_consultation); it applies once approved.
```

## Appendix B. v1 export sketch (operator; verify every column against `schema.prisma` `@map`s)

```sql
-- One JSON object per line; personal data stays on the operator's machine (never in the repository).
select json_build_object(
  'format', 2, 'id', l.id, 'businessName', l."businessName", 'contactPerson', l."contactPerson",
  'phone', l.phone, 'whatsapp', l.whatsapp, 'email', l.email, 'address', l.address, 'city', l.city,
  'region', l.region, 'businessType', l."businessType", 'tableCount', l."tableCount",
  'branchCount', l."branchCount", 'currentSystem', l."currentSystem", 'source', l.source,
  'status', l.status, 'lostReason', l."lostReason", 'notes', l.notes, 'nextFollowUp', l."nextFollowUp",
  'priority', l.priority, 'customFields', l."customFields", 'emailOptOut', l."emailOptOut",
  'smsOptOut', l."smsOptOut", 'waOptOut', l."waOptOut", 'emailBouncedAt', l."emailBouncedAt",
  'createdAt', l."createdAt", 'updatedAt', l."updatedAt", 'deletedAt', l."deletedAt",
  'mergedIntoId', l."mergedIntoId", 'aiScore', l."aiScore", 'aiScoreReason', l."aiScoreReason",
  'scoredAt', l."scoredAt", 'emailVerifiedStatus', l."emailVerifiedStatus",
  'ownerEmail', (select u.email from marketing_users u where u.id = l."assignedToId"),
  'contact', json_build_object(
     'conversationsOutbound', (select count(*) from messages m join conversations c on c.id = m."conversationId"
                               where c."leadId" = l.id and m.direction = 'OUTBOUND'),
     'conversationsInbound',  (select count(*) from messages m join conversations c on c.id = m."conversationId"
                               where c."leadId" = l.id and m.direction = 'INBOUND'),
     'campaignSent', (select count(*) from campaign_recipients r where r."leadId" = l.id and r.status = 'SENT'),
     'mailSent',     (select count(*) from mail_log g where g."leadId" = l.id and g.status = 'SENT'),
     'activitiesOutbound', (select count(*) from lead_activities a where a."leadId" = l.id
                            and a.type in ('CALL','VISIT','EMAIL','WHATSAPP','DEMO','MEETING')),
     'offers', (select count(*) from lead_offers o where o."leadId" = l.id and o.status <> 'DRAFT')),
  'activities', (select coalesce(json_agg(json_build_object('id', a.id, 'type', a.type, 'title', a.title,
                   'description', a.description, 'outcome', a.outcome, 'createdAt', a."createdAt")
                   order by a."createdAt"), '[]') from lead_activities a where a."leadId" = l.id),
  'tags', (select coalesce(json_agg(t.name), '[]') from lead_tags lt join tags t on t.id = lt."tagId"
           where lt."leadId" = l.id),
  'research', (select json_build_object('evidence', rc.evidence, 'painPoint', rc."painPoint", 'pitch', rc.pitch,
                 'stage', rc.stage, 'website', rc.website, 'instagram', rc.instagram, 'score', rc.score,
                 'createdAt', rc."createdAt")
               from research_candidates rc where rc."leadId" = l.id order by rc."createdAt" desc limit 1)
)
from leads l where l."workspaceId" = :workspace;
```
