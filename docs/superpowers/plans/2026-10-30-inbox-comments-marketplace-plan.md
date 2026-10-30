# Inbox comments and marketplace questions (phase 1): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the Rust inbox answers public comments on Instagram and Facebook posts, Trendyol and Hepsiburada
customer questions and Amazon.com.tr buyer messages, next to DMs, each with its post/product context, its
platform's reply modes and limits, moderation, deadlines and approval.

**Architecture:** spec `docs/superpowers/specs/2026-10-30-inbox-comments-marketplace-design.md` (read it first;
§ numbers below are its sections). A conversation stays person × capability; a new **public item** (one
comment or question) carries the reply target, thread, window, deadline and answer state. Comments live on the
`instagram`/`facebook_page` capabilities, questions on new `trendyol`/`hepsiburada` capabilities (new
`jt_marketplace` adapter), Amazon on `mailbox`. Adapters write one **public-item envelope** into inbound
events; one provider-agnostic intake turns it into person, conversation, message, item and subject. Replies use
the existing outbox with a new `held` state for approval. Meta comment code is inert until the token's granted
scopes hold the comment permissions.

**Tech stack:** Rust (axum, sqlx/Postgres with FORCE RLS, tokio, async-trait), React panel (vitest, i18next).

**Global constraints (as every Rust plan here):** hexagonal boundaries (`jt_archtest`); catalog rows, handlers,
permissions, schemas, status gates and exact-set pins change together (spec §7.3 lists every pin); migrations
are repeatable `up`/`down` pairs with ENABLE + FORCE RLS on every tenant table (`jt_archtest/tests/sql_scoping.rs`);
English identifiers, TR + EN panel copy with parity; `tracing` never carries a comment/question text, a handle,
a token or a seller key; no provider I/O inside a database transaction (read, release, call, compare-and-swap
write); no deploy and no push to shared branches from a worker. **No provider fact goes into a code comment
without its source link**; a fact the spec marks VERIFY (V-xx, spec §12) is written as a named constant whose
doc cites the verification task. Crates whose tests use `jt_testkit` (it depends on `jt_pg`) do not build tests on
Windows: CI on Linux is the check for `jt_app`, `jt_meta`, `jt_webhook`, `jt_pg`, `jt_archtest`; locally run
`cargo check -p <crate> --tests` (and `jt_app` with `--features tokio/time`). `jt_inbox`, `jt_connector`,
`jt_capability` and the new `jt_marketplace` (no `jt_testkit`, like `jt_tiktok`) test on Windows.

**Per-task loop:** write the named failing tests → run them (red) → implement → run the crate's tests (green) →
`cargo fmt --all -- --check` and `cargo clippy -p <crate> --all-targets -- -D warnings` → commit (message ends
with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Once per PR: `cargo test --locked --workspace`
in CI, `pnpm --dir rust/panel test` when the panel is touched.

**Base and branches:** every task branches from the latest `origin/feat/rust-panel-money-inputs` and lands by PR
into it. **Migration `0019_inbox_public`**: `0018_tiktok_webhooks` (TikTok branch) lands first; if this work is
ready first, it waits or the two swap numbers — whichever merges second renumbers, and both carry the union
provider list `('meta','netgsm','x','mail','tiktok','trendyol','hepsiburada')`. Pins touched by two tasks of
this plan (Job::ALL by M4 and T3; the catalog by F7 only) are bumped by whichever lands second on top of the
first.

**Order and parallelism:**

```
F1 ─ F2 ─ F3 ─ F4 ─┬─ F5 ─┬─ F6 ─ F7 ─ F8 ─ F9 ─ R1
                   │      └─ A1
                   ├─ M1 ─ M2 ─ M3 ─ M4 ─ M5   (M4/M5 need F5)
                   ├─ T1 ─ T2 ─ T3             (T3 needs F5)
                   └─ H0 ─ H1                  (H1 after T1; H0 any time)
P1 ─ P2 ─ P3 after F7 (API shapes) ; R2 last
```

---

## File structure

| Path | New/changed | Responsibility |
|---|---|---|
| `rust/crates/domain/jt_inbox/src/{identity,erasure,ids,lib}.rs` | changed | 4 channels, 4 namespaces, `public_channel_for_kind`, `conversation_channel`, ids |
| `rust/crates/domain/jt_inbox/src/public.rs`, `src/relay.rs`, `tests/{public,relay}.rs` | new | public items, rules, fence, transitions; Amazon relay recognizer |
| `rust/crates/domain/jt_capability/src/kind.rs`, `tests/rules.rs` | changed | `KindGroup::Marketplace`, kinds, `default_policy` |
| `rust/crates/domain/jt_connector/src/{provider,credential,event,lib}.rs`, new `src/comments.rs`, `tests/rules.rs` | changed/new | 2 providers, 2 credentials, 2 event kinds, `comment_grant` and the comment scope lists |
| `rust/migrations/0019_inbox_public.{up,down}.sql` | new | spec §4 |
| `rust/crates/adapters/jt_pg/src/repos/inbox/{public_items,public_subjects,public_cursors}.rs`, `repos/inbox/{merges,outbox}.rs`, `uow.rs` | new/changed | repos, held state, merge snapshot v2 |
| `rust/crates/jt_testkit/src/fakes/{inbox,public,providers,compliance}.rs`, `src/inbox_contract.rs` | new/changed | in-memory repos, contract tests, scripted public surfaces |
| `rust/crates/jt_app/src/ports/{public,connectors,inbox,mod}.rs` | new/changed | repo ports, `PublicSurface`, `PublicPoller`, `PublicEnvelope`, registry defaults, `InboxPolicy` merge |
| `rust/crates/jt_app/src/usecases/inbox/{public,consumer,replies,context,conversations,merge,erasure,schema,mod}.rs` | new/changed | intake, fence, approval, moderation, reads |
| `rust/crates/jt_app/src/usecases/{webhook,jobs,work,connector}.rs` | changed | `Delivery::Disabled`, 2 jobs + SLA, work kinds, credential inputs |
| `rust/crates/jt_app/src/catalog.rs` | changed | 6 rows (spec §7.1) |
| `rust/crates/adapters/jt_mcp/src/tools/{inbox,connector}.rs` | changed | 6 tools, credential shapes |
| `rust/crates/adapters/jt_panel_http/src/routes/inbox.rs` | changed | 6 routes |
| `rust/crates/adapters/jt_meta/src/{webhook,comments,oauth,probe,assets,graph,ports,lib}.rs` | new/changed | Meta comments |
| `rust/crates/adapters/jt_webhook/src/{lib,meta}.rs` | changed | `disabled_meta` counter |
| `rust/crates/adapters/jt_marketplace/{Cargo.toml,src/{lib,client,trendyol,hepsiburada,envelope}.rs,tests/{support/mod,trendyol,hepsiburada}.rs}` | new | marketplace adapter |
| `rust/crates/adapters/jt_outbound/src/fixed_hosts.rs` | changed | `trendyol` (+ `hepsiburada` in H1) |
| `rust/bin/jeeta/src/{config,connectors,scheduler}.rs`, `Cargo.toml` | changed | env flags, registry wiring, intervals |
| `rust/Cargo.toml` | changed | `jt_marketplace` member + workspace dep |
| `rust/crates/jt_archtest/tests/*.rs` | changed | pins (spec §7.3), adapter list |
| `rust/panel/src/{api/inbox.ts,api/types.ts,pages/InboxPage.tsx,pages/InboxConversation.tsx,pages/InboxPublic.tsx,pages/InboxApprovals.tsx,pages/ConnectPage.tsx,lib/capabilities.ts,i18n/{tr,en}.json}` | new/changed | panel |
| `rust/crates/jt_app/tests/{inbox_public_intake,inbox_public_reply,inbox_public_moderation,inbox_public_reads,inbox_public_jobs,smoke_inbox_public}.rs`, `rust/Makefile` | new/changed | app tests, smoke |
| `docs/operations/inbox-public-rollout.md` | new (R2) | Meta rollout steps, env flags, live checks |

---

## Contracts (defined in F1–F4; every later task uses exactly these names)

```rust
// jt_inbox::identity — new variants (serde snake_case), existing ones unchanged
pub enum Channel { /* … */ InstagramComment, FacebookComment, TrendyolQuestion, HepsiburadaQuestion }
pub enum IdentityChannel { /* … */ InstagramCommenter, FacebookCommenter, TrendyolBuyer, HepsiburadaBuyer }
impl Channel { pub const fn is_public(self) -> bool; }  // the 4 new ones
pub fn public_channel_for_kind(kind_key: &str) -> Option<Channel>; // instagram, facebook_page, trendyol, hepsiburada
pub fn conversation_channel(kind_key: &str) -> Option<Channel>;    // channel_for_kind(k).or(public_channel_for_kind(k))

// jt_inbox::ids
define_id!(PublicItemId); define_id!(PublicSubjectId);

// jt_inbox::public (`pub mod public`; its types are also re-exported at the crate root, its
// functions and constants are reached as `jt_inbox::public::…`)
pub enum PublicKind { Comment, Question }
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AnswerState {
    Awaiting,
    Pending { message_id: MessageId },
    Answered { by: AnsweredBy, message_id: Option<MessageId>, #[serde(with = "time::serde::rfc3339")] at: OffsetDateTime },
    Rejected { reason: String, #[serde(with = "time::serde::rfc3339")] at: OffsetDateTime },
    Handled { by: EventSource, reason: HandledReason, #[serde(with = "time::serde::rfc3339")] at: OffsetDateTime },
    Expired { #[serde(with = "time::serde::rfc3339")] at: OffsetDateTime },
}
impl AnswerState { pub fn key(&self) -> &'static str; } // "awaiting" … "expired" (= 0019's answer_state)
pub enum AnsweredBy { Us, Elsewhere }
pub enum Moderation { Visible, Hidden, Deleted, Removed, Reported }
impl Moderation { pub fn key(self) -> &'static str; pub fn from_key(k: &str) -> Option<Moderation>; }
pub enum HandledReason { NoReplyNeeded, Spam, Duplicate, AnsweredElsewhere }
pub enum Visibility { Public, Private }
pub enum SubjectKind { Post, Product }
pub struct PublicItem { /* spec §3.3, field for field */ }
impl PublicItem { pub fn awaiting(&self) -> bool; } // Awaiting|Rejected and Visible
pub struct PublicSubject { pub id: PublicSubjectId, pub workspace_id: WorkspaceId, pub capability_id: CapabilityId,
    pub kind: SubjectKind, pub external_id: String, pub title: String, pub url: Option<String>,
    pub image_url: Option<String>, pub facts: serde_json::Value, pub publication_id: Option<uuid::Uuid>,
    pub first_seen_at: OffsetDateTime, pub updated_at: OffsetDateTime }
pub const MAX_SUBJECT_TITLE_CHARS: usize = 280;
pub struct TextBounds { pub min: usize, pub max: usize }
pub struct PrivateRule { pub window: Duration, pub max_chars: usize }
pub struct PublicRules { pub public: Option<TextBounds>, pub private: Option<PrivateRule>,
    pub one_answer: bool, pub moderated: bool, pub hide: bool, pub delete: bool, pub report: bool,
    pub marketplace: bool }
pub fn rules(channel: Channel) -> Option<PublicRules>; // None for private channels
// The bounds behind `rules`, each a named constant (F1): INSTAGRAM_COMMENT_MAX, INSTAGRAM_PRIVATE_MAX,
// FACEBOOK_COMMENT_MAX (V-M8), FACEBOOK_PRIVATE_MAX (= jt_meta's MAX_MESSENGER_TEXT), TRENDYOL_ANSWER,
// PRIVATE_REPLY_WINDOW, HEPSIBURADA_ANSWER_BOUNDS: Option<TextBounds> = None and
// HEPSIBURADA_MODERATED: bool = true (V-H3/V-H4, set by H0). Trendyol `report: false` until V-T5.
#[derive(… thiserror::Error)] #[serde(rename_all = "snake_case")]
pub enum PublicRefusal { ItemRequired, ItemNotInConversation, ItemRemoved, DeadlinePassed, AlreadyAnswered,
    AgentAlreadyReplied, ItemNotOwed, PrivateReplyUnsupported, PrivateWindowClosed, PrivateReplyUsed,
    TextTooShort, TextTooLong, ContactDataInPublicReply, ContactDataInMarketplaceAnswer,
    CommercialOnPublicSurface, CommentsNotEnabled, HepsiburadaUnverified }
// Display = the snake_case key, e.g. "private_window_closed".
pub fn reply_allowed(item: &PublicItem, rules: &PublicRules, visibility: Visibility, by_agent: bool,
    now: OffsetDateTime) -> Result<(), PublicRefusal>;
pub fn check_text(rules: &PublicRules, visibility: Visibility, text: &str, person_contacts: &[String])
    -> Result<(), PublicRefusal>;
// Both answer `HepsiburadaUnverified` for a public reply while `rules.public` is None. `check_text`
// counts characters (the minimum without leading/trailing whitespace); `person_contacts` are the
// person's normalised emails and E.164 phones (a phone matches by its last ten digits in any
// digit run of the text).
pub enum ItemEvent { AnswerSent { message_id: MessageId, moderated: bool }, AnswerConfirmed,
    AnswerRejected { reason: String }, AnsweredElsewhere { message_id: Option<MessageId> },
    MarkedHandled { by: EventSource, reason: HandledReason }, Expired, Hidden, Unhidden, Deleted, Removed,
    Reported, PrivateReplySent { message_id: MessageId } }
#[derive(Debug, thiserror::Error)] #[error("{from} cannot take {event}")]
pub struct ItemTransitionError { pub from: &'static str, pub event: &'static str } // also Clone, Copy, PartialEq, Eq
impl ItemEvent { pub fn key(&self) -> &'static str; } // "answer_sent" … "private_reply_sent"
// `from` is the answer key for answer events, the moderation key for moderation events, and
// "private_reply_used" / "private_window_closed" for PrivateReplySent. `apply` never sets agent_replied.
pub fn apply(item: &PublicItem, event: ItemEvent, at: OffsetDateTime) -> Result<PublicItem, ItemTransitionError>;
/// Ours while any item is owed; else Theirs; a Snoozed or Closed state is kept.
pub fn derived_state(items: &[PublicItem], current: &ConvState) -> ConvState;

// jt_inbox::relay (`pub mod relay`; Relay and RelayRefusal also at the crate root)
pub enum Relay { AmazonTr }                                          // serde "amazon_tr"
pub const AMAZON_TR_RELAY_DOMAIN: &str = "marketplace.amazon.com.tr"; // V-A1
pub enum RelayRefusal { CommercialOnRelay, LinkInRelayReply }        // Display/serde = snake_case key
pub const RELAY_DEADLINE: Duration = Duration::hours(24);
pub fn marketplace_relay(email_normalized: &str) -> Option<Relay>;   // "@marketplace.amazon.com.tr" (V-A1)
pub fn amazon_order_id(text: &str) -> Option<String>;               // \d{3}-\d{7}-\d{7}
pub fn relay_display_name(raw: &str) -> String;                      // drops " - Amazon Marketplace" (V-A2)
pub fn relay_reply_allowed(text: &str, commercial: bool) -> Result<(), RelayRefusal>; // CommercialOnRelay, LinkInRelayReply

// jt_connector
pub enum Provider { /* … */ Trendyol, Hepsiburada }          // keys "trendyol", "hepsiburada"
pub enum Credential { /* … */
    #[serde(rename = "trendyol_seller")] TrendyolSeller { seller_id: String, api_key: String, api_secret: String },
    #[serde(rename = "hepsiburada_merchant")] HepsiburadaMerchant { merchant_id: String, username: String, password: String } }
pub enum EventKind { /* … */ Comment, Question }              // keys "comment", "question"
// jt_connector::comments
pub const FACEBOOK_COMMENT_SCOPES: &[&str] = &["instagram_manage_comments", "pages_manage_engagement", "pages_read_user_content"];
pub const INSTAGRAM_COMMENT_SCOPES: &[&str] = &["instagram_business_manage_comments", "instagram_business_manage_messages"];
pub struct CommentGrant { pub read: bool, pub reply: bool, pub hide: bool, pub delete_others: bool, pub private_reply: bool }
impl CommentGrant { pub fn enabled(&self) -> bool { self.read && self.reply } }
pub fn comment_grant(kind_key: &str, scopes: &[&str]) -> CommentGrant;   // spec §5.3 table

// jt_capability
pub enum KindGroup { /* … */ Marketplace }                    // key "marketplace", reach Connector
impl CapabilityKind { pub fn default_policy(&self) -> Policy; } // Policy::default() for every kind: the
// marketplaces start WITHOUT approval (decision 2026-10-30 by the owner's delegate, spec §3.7)

// jt_app::ports::connectors (spec §6.1 for PublicSurface, PublicPoller, PublicTarget, PrivateReceipt,
// ModerationAction, ReportReason, SubjectFacts; the registry's two default methods)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublicEnvelope { pub kind: PublicKind, pub account_id: String, pub external_id: String,
    pub parent_external_id: Option<String>, pub root_external_id: String, pub status: EnvelopeStatus,
    pub author: EnvelopeAuthor, pub text: String,
    #[serde(with = "time::serde::rfc3339")] pub created_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")] pub deadline: Option<OffsetDateTime>,
    #[serde(default)] pub live: bool, #[serde(default)] pub subject: Option<EnvelopeSubject>,
    #[serde(default)] pub answer: Option<EnvelopeAnswer>, #[serde(default)] pub rejection: Option<EnvelopeRejection> }
pub enum EnvelopeStatus { Open, Edited, Removed, Answered, Pending, Rejected, Expired, Reported }
pub struct EnvelopeAuthor { pub id: Option<String>, pub name: Option<String>, #[serde(default)] pub is_self: bool }
pub struct EnvelopeSubject { pub kind: SubjectKind, pub external_id: String, #[serde(default)] pub title: String,
    pub url: Option<String>, pub image_url: Option<String>, #[serde(default)] pub facts: Value }
pub struct EnvelopeAnswer { pub text: String, #[serde(default, with = "time::serde::rfc3339::option")] pub at: Option<OffsetDateTime> }
pub struct EnvelopeRejection { pub reason: String, #[serde(default, with = "time::serde::rfc3339::option")] pub at: Option<OffsetDateTime> }
impl PublicEnvelope {
    /// `{"public": <self>, "provider_item": provider_item}`.
    pub fn into_payload(self, provider_item: Value) -> Value;
    pub fn from_payload(payload: &Value) -> Option<PublicEnvelope>;
}

// jt_app::ports::public (re-exported from ports::inbox)
#[async_trait] pub trait PublicItemRepo: Send + Sync {
    async fn insert(&mut self, item: PublicItem) -> Result<bool, AppError>;   // false: (capability, external_id) replay
    async fn get(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError>;
    async fn lock(&mut self, id: PublicItemId) -> Result<Option<PublicItem>, AppError>;
    async fn find_by_external(&mut self, capability: CapabilityId, external_id: &str) -> Result<Option<PublicItem>, AppError>;
    async fn update(&mut self, item: PublicItem) -> Result<(), AppError>;     // NOT_FOUND when missing
    async fn for_conversation(&mut self, conversation: ConversationId) -> Result<Vec<PublicItem>, AppError>; // (created_at,id)
    async fn thread(&mut self, capability: CapabilityId, root_external_id: &str, limit: u32) -> Result<Vec<PublicItem>, AppError>;
    async fn due_before(&mut self, before: OffsetDateTime, limit: u32) -> Result<Vec<PublicItem>, AppError>;
    async fn to_reconcile(&mut self, capability: CapabilityId, limit: u32) -> Result<Vec<PublicItem>, AppError>; // checked_at nulls first, id
    async fn mark_checked(&mut self, ids: &[PublicItemId], at: OffsetDateTime) -> Result<(), AppError>;
    async fn agent_public_replies_since(&mut self, capability: CapabilityId, since: OffsetDateTime) -> Result<u32, AppError>;
}
#[async_trait] pub trait PublicSubjectRepo: Send + Sync {
    async fn upsert(&mut self, subject: PublicSubject) -> Result<PublicSubject, AppError>; // keeps id, first_seen_at
    async fn get(&mut self, id: PublicSubjectId) -> Result<Option<PublicSubject>, AppError>;
    async fn find_by_external(&mut self, capability: CapabilityId, external_id: &str) -> Result<Option<PublicSubject>, AppError>;
}
#[async_trait] pub trait PublicCursorRepo: Send + Sync {
    async fn get(&mut self, capability: CapabilityId) -> Result<Option<Value>, AppError>;
    async fn store(&mut self, capability: CapabilityId, cursor: Value, at: OffsetDateTime) -> Result<(), AppError>;
}
// TenantRepos: fn public_items(&mut self) -> &mut dyn PublicItemRepo; public_subjects(); public_cursors().
// Semantics fixed in F3 (ports/public.rs docs): insert checks capability, conversation, message,
// subject and private-reply references (NOT_FOUND) and answers false only on a (capability,
// external_id) replay; update writes message_id, subject_id, deadline, private_reply_until, answer,
// moderation, private_reply_message_id, agent_replied, checked_at, updated_at (never the conversation:
// merges move items); due_before/to_reconcile take answers awaiting|rejected|pending; mark_checked
// leaves updated_at (the compare-and-swap version); agent_public_replies_since counts agent_replied
// items whose answer message (Pending/Answered message_id) is at >= since; subject upsert keeps id,
// first_seen_at and a publication_id the write leaves None; a cursor is a JSON object (INTERNAL else).

// jt_app::ports::inbox (F3)
pub struct PublicItemParent { pub id: PublicItemId, pub conversation_id: ConversationId }
pub const MERGE_SNAPSHOT_VERSION: u32 = 2; // MergeSnapshot.public_items: #[serde(default)] Vec<PublicItemParent>
// jt_testkit::inbox_contract::Fixture (F3): account(kind, external_id), public_conversation(person, cap),
// comment_message(conversation, external_id, minutes), public_item(&conversation, message, external_id, minutes);
// jt_testkit::fakes::StoredCursor; MemInbox.{public_items, public_subjects, public_cursors}.
```

---

## F — foundation

### Task F1: `jt_inbox` channels, namespaces, public items, relay (size M)

**Files:** modify `rust/crates/domain/jt_inbox/src/{identity.rs,erasure.rs,ids.rs,lib.rs,tests.rs}`; create
`src/public.rs`, `src/relay.rs`, `tests/public.rs`, `tests/relay.rs`; modify
`rust/crates/jt_testkit/src/fakes/compliance.rs` (the `Channel` → key match gains four arms; it is compiled by
F1's `cargo check` but tested in CI).

- [ ] **Tests first (`tests/public.rs`):**
  - `public_channels_map_to_their_kinds_and_namespaces` — each of the four: `public_channel_for_kind`,
    `identity_channel`, `is_public`; `channel_for_kind("instagram") == None` still (existing test untouched);
    `conversation_channel` covers all 11 channels' kinds.
  - `new_namespaces_are_opaque` — `normalise(InstagramCommenter, "  17  ") == Ok("17")`, empty refused.
  - `erasure_namespaces_are_stable` — `identity_hash` of each new namespace differs from every other
    namespace for the same value; the names are `instagram_commenter`, `facebook_commenter`, `trendyol_buyer`,
    `hepsiburada_buyer`.
  - `rules_table_is_the_spec_table` — exact `PublicRules` per channel; `rules(Channel::Email) == None`;
    Trendyol bounds 10..=2000, `one_answer`, `moderated`; Hepsiburada `public == None` until H0
    (`HEPSIBURADA_ANSWER_BOUNDS: Option<TextBounds> = None`).
  - `answer_state_serialises_with_a_state_tag` — `{"state":"pending","message_id":…}`; `key()` equals the tag.
  - `awaiting_means_owed_and_visible` — Awaiting/Rejected × each moderation.
  - `reply_allowed_matrix` — table-driven, one row per refusal of spec §3.6 rule 4 plus the allowed cases
    (human public reply on an answered comment allowed; agent second reply refused `agent_already_replied`;
    private at `created_at + 7 d` allowed, `+ 7 d + 1 s` refused `private_window_closed`; question past
    `deadline` refused `deadline_passed`; Trendyol `Pending` refused `already_answered`).
  - `check_text_bounds_and_contact_fences` — Trendyol 9 chars `text_too_short`, 2001 `text_too_long`; a public
    IG reply quoting the person's own phone identity written another way (spaces, a leading 0 instead of
    `+90`) refused `contact_data_in_public_reply`, the business's own URL allowed; a marketplace answer with
    `https://`, an email or 10+ digits refused `contact_data_in_marketplace_answer`. Test values use made-up
    numbers and `example.com` addresses only (public repository).
  - `transitions` — every row of spec §3.4 table, and `apply(Answered, AnswerSent) -> Err` with
    `ItemTransitionError { from: "answered", event: "answer_sent" }`; `Hidden` keeps the answer state.
  - `derived_state_follows_owed_items` — owed → Ours; none → Theirs; `Snoozed{until}` kept; `Closed` kept.
- [ ] **Tests first (`tests/relay.rs`):** `amazon_relay_domain_only` (`x@marketplace.amazon.com.tr` yes;
  `x@amazon.com.tr`, `x@marketplace.amazon.com.tr.evil.example` no), `order_id_from_subject_and_body`,
  `display_name_drops_the_suffix`, `relay_reply_refuses_commercial_and_links`.
- [ ] Run `cargo test -p jt_inbox` (Windows) → red; implement (`public.rs` holds the bounds as named constants
  with a doc line naming their V-id); green.
- [ ] fmt + clippy; **commit** `feat(inbox): public items, their rules and the public channels`.

```rust
// shape of rules() — constants carry their verification id
pub const INSTAGRAM_COMMENT_MAX: usize = 2_200;  // V-M8 (spec §12): re-read before M2 merges
pub const INSTAGRAM_PRIVATE_MAX: usize = 1_000;  // V-M8
pub const FACEBOOK_COMMENT_MAX: usize = 8_000;   // V-M8
pub const TRENDYOL_ANSWER: TextBounds = TextBounds { min: 10, max: 2_000 }; // documented (answerQuestion)
pub const PRIVATE_REPLY_WINDOW: Duration = Duration::days(7);
pub fn rules(channel: Channel) -> Option<PublicRules> {
    Some(match channel {
        Channel::InstagramComment => PublicRules { public: Some(TextBounds { min: 1, max: INSTAGRAM_COMMENT_MAX }),
            private: Some(PrivateRule { window: PRIVATE_REPLY_WINDOW, max_chars: INSTAGRAM_PRIVATE_MAX }),
            one_answer: false, moderated: false, hide: true, delete: true, report: false, marketplace: false },
        // … FacebookComment, TrendyolQuestion, HepsiburadaQuestion
        _ => return None,
    })
}
```

**Acceptance:** `cargo test -p jt_inbox` green; no existing `jt_inbox` test edited except `tests.rs` gaining
the new variants in its exhaustive lists. **Risk:** low.

### Task F2: capability group, providers, credentials, event kinds, comment grant (size S)

**Files:** `rust/crates/domain/jt_capability/src/kind.rs`, `tests/rules.rs`;
`rust/crates/domain/jt_connector/src/{provider.rs,credential.rs,event.rs,lib.rs}`, new `src/comments.rs`,
`tests/rules.rs`. The two new `Provider` variants and the new group reach further (done in F2): the
exhaustive provider matches in `jt_app/src/ports/connectors.rs` (`OAuthCallback::of_flow`: none) and
`jt_app/src/usecases/connector.rs` (`reconnect`: `use_set_credentials`, like NetGSM and mail);
`bin/jeeta/src/connectors.rs` (no adapter yet: `connector` and the rest answer `None`; its registry tests
list the two providers with no operations and skip them as `NOT_YET_SERVED`, as does the adapter test of
`bin/jeeta/src/serve.rs`; **T1 and H1 remove their provider from both**); the `jeeta.capability.declare`
description in `jt_mcp/src/tools/capabilities.rs` names `marketplace` (pinned by `jt_mcp/tests/registry.rs`).

- [ ] **Tests first:**
  - `jt_capability/tests/rules.rs`: `EXPECTED_KINDS` gains `(KindGroup::Marketplace, &["trendyol", "hepsiburada"])`;
    `KINDS.len() == 53`; `count(Reach::Connector)` 26 → 28 and `feeds(Cash)` 47 → 49;
    `marketplace_kinds_answer_without_approval_by_default` (`default_policy().requires_human_approval` false
    for both and for `instagram`; every kind's default policy is `Policy::default()`: decision 2026-10-30,
    spec §3.7); `marketplace_group_is_reached_by_connector`.
  - `jt_connector/tests/rules.rs`: the provider-coverage test sees `trendyol` → `Trendyol`, `hepsiburada` →
    `Hepsiburada`; `provider_keys_round_trip` includes both; `marketplace_credentials_mask_and_redact`
    (`Debug` shows `***` for `api_key`, `api_secret`, `password`; `redact_for_public` = `{kind, seller_id}` /
    `{kind, merchant_id}`; sealed form round-trips with `kind` tags); `comment_and_question_event_kinds_round_trip`;
    `comment_grant_matrix` (Page token with `pages_read_engagement`+`pages_manage_engagement` → enabled, delete
    others only with `pages_read_user_content`, private only with `pages_messaging`; IG via Facebook Login with
    `instagram_manage_comments` → enabled; Instagram Login with `instagram_business_manage_comments` → enabled,
    private only with `instagram_business_manage_messages`; today's `FACEBOOK_SCOPES` alone → **not** enabled
    for any kind; `trendyol` → not a comment kind, all false).
- [ ] Run `cargo test -p jt_capability -p jt_connector` (Windows) → red; implement; green.
- [ ] **Commit** `feat(connector): marketplace providers and credentials, comment grants`.

```rust
pub fn comment_grant(kind_key: &str, scopes: &[&str]) -> CommentGrant {
    let has = |s: &str| scopes.contains(&s);
    match kind_key {
        "facebook_page" => { let rw = has("pages_read_engagement") && has("pages_manage_engagement");
            CommentGrant { read: rw, reply: rw, hide: rw, delete_others: rw && has("pages_read_user_content"),
                private_reply: rw && has("pages_messaging") } }
        "instagram" => { let fb = has("instagram_manage_comments"); let ig = has("instagram_business_manage_comments");
            let on = fb || ig;
            CommentGrant { read: on, reply: on, hide: on, delete_others: on,
                private_reply: (fb && has("instagram_manage_messages")) || (ig && has("instagram_business_manage_messages")) } }
        _ => CommentGrant::default(),
    }
}
```

**Acceptance:** both crates green on Windows. **Risk:** low.

### Task F3: migration 0019, Postgres repos, fakes, merge snapshot (size L)

**Files:** create `rust/migrations/0019_inbox_public.{up,down}.sql` (spec §4.1/§4.2 verbatim; the two function
bodies copied from the latest migration that defines them — 0008, or 0018 if it changed them — plus the added
keys/candidates); create `rust/crates/adapters/jt_pg/src/repos/inbox/{public_items.rs,public_subjects.rs,public_cursors.rs}`;
modify `repos/inbox/{mod.rs,merges.rs,outbox.rs}`, `uow.rs` (accessors), `tests/migrations.rs`;
create `rust/crates/adapters/jt_pg/tests/inbox_public.rs`; modify `rust/crates/jt_app/src/ports/{mod.rs,inbox.rs}` and
create `ports/public.rs` (the three repo traits only); `rust/crates/jt_testkit/src/fakes/inbox.rs` + new
`fakes/public.rs`, `src/inbox_contract.rs` (contract tests for the three repos run on both);
`rust/crates/jt_archtest/tests/studio_rules.rs` (tables 74 → 77).

- [ ] **Tests first:**
  - `jt_pg/tests/migrations.rs`: `TABLES_AFTER_ALL = 77`, `MIGRATIONS = 19` (18 if 0018 is not merged yet: the
    versions are then `1..=17, 19`), the down list starts with `"0019_inbox_public"`;
    `public_tables_force_rls_with_one_policy` (the three tables, policies `public_subjects_ws`,
    `public_items_ws`, `public_cursors_ws`); `answer_state_is_generated` (insert with
    `{"state":"pending","message_id":…}` reads `answer_state = 'pending'`; writing the column is refused);
    `outbox_accepts_held`; `inbox_public_down_refuses_while_rows_need_the_wider_checks` (done in F3 in place
    of "down keeps the wider constraints": a `held` outbox row or a `trendyol` inbound event makes `down`
    raise and change nothing; without them it narrows both checks and drops the tables; up/down/up twice
    changes nothing). The tests that run 0006's or 0009's down on a fully migrated database
    (`migrations.rs`, `inbox_schema.rs`, `studio_repos.rs`) run 0019's down first.
  - `jt_pg/tests/inbox_public.rs`: `mask_personal_blanks_the_envelope` (`author`, `provider_item`, `text`,
    `username`, `userName`, string `message` blanked; a WhatsApp `message` object keeps its `id` and loses
    `text.body`); `event_person_finds_a_commenter` (an IG comment event payload matches its
    `instagram_commenter` identity, scoped by the capability's external id); `merge_moves_items_and_undo_restores_them`
    (two commenters on one `instagram` capability merged: their conversations coalesce, both items point at
    the survivor; undo puts each back); `reconcile_order_rotates` (after `mark_checked` the next call returns
    the next least-recently-checked items, never the same first N). The merge and rotation tests are
    contracts (`inbox_merge_contract::public_items_follow_merges_and_undo`,
    `inbox_contract::reconcile_order_rotates`) run on the fake and on PostgreSQL.
  - `jt_testkit/src/inbox_contract.rs`: `public_items_contract` (insert replay → false, find_by_external,
    for_conversation order, thread, due_before, to_reconcile order, agent_public_replies_since),
    `public_subjects_contract` (upsert keeps id and first_seen_at), `public_cursors_contract`; run against the
    fake and Postgres.
- [ ] CI red → implement → green. `MergeSnapshot` gains `#[serde(default)] public_items: Vec<PublicItemParent>`
  and `version: 2`; `apply_snapshot` runs `update public_items set conversation_id = target` **before** the
  coalesced conversations are deleted; `restore_snapshot` puts them back; the fake mirrors both; the undo
  use case (`usecases/inbox/merge.rs`) accepts snapshot versions 1 and 2. Every `TenantRepos`
  implementation gains the three accessors (also the delegating test bundles in
  `jt_webhook/tests/support`, `jt_app/tests/{capability_locks,strategy}.rs`,
  `jt_testkit/src/activation_control.rs`).
- [ ] **Commit** `feat(inbox): 0019 public items, subjects, cursors and held replies`.

**Acceptance:** the migration repeats; the three tables are tenant-scoped; merges never trip the new foreign
keys. **Risk:** medium (merge code); mitigated by the apply/undo test.

### Task F4: application ports, envelope, registry, policy, credential inputs, env flags (size M)

**Files:** `rust/crates/jt_app/src/ports/connectors.rs` (`PublicSurface`, `PublicPoller`, `PublicTarget`,
`PrivateReceipt`, `ModerationAction`, `ReportReason`, `SubjectFacts`, `PublicEnvelope` and its parts,
registry defaults; `MetaApp.comment_scopes`, `InstagramApp.comment_scopes`); `ports/mod.rs`
(`InboxPolicy` defaults and key-wise merge); `rust/crates/adapters/jt_pg/src/repos/policies.rs` (merge on
read);
`usecases/connector.rs` (`CredentialInput::{TrendyolSeller, HepsiburadaMerchant}`, normalisation, external id
equals the seller/merchant id, `default_policy` at creation); `rust/bin/jeeta/src/config.rs`
(`JEETA_META_COMMENT_SCOPES`, `JEETA_INSTAGRAM_COMMENT_SCOPES`); every `MetaApp { … }`/`InstagramApp { … }`
literal (testkit `fakes/providers.rs`, `jt_meta/src/graph.rs` tests, `jt_meta/tests/support/mod.rs`,
`jt_x/tests/x.rs`, `bin` config tests) gains `comment_scopes: false`; `jt_mcp/src/tools/connector.rs` (the
set-credentials schema's two shapes).

- [ ] **Tests first:**
  - `jt_app/src/ports/connectors.rs` unit tests: `envelope_round_trips_through_a_payload`,
    `envelope_from_payload_ignores_unknown_fields`, `envelope_requires_its_identity_fields`,
    `meta_app_debug_shows_comment_scopes_flag`.
  - `jt_app/tests/connector.rs`: `trendyol_credentials_seal_and_the_kind_starts_without_approval`,
    `trendyol_external_id_must_equal_the_seller_id`, `hepsiburada_credentials_seal`,
    `marketplace_credential_errors_never_repeat_the_secret`.
  - `jt_pg` policies test `stored_policy_without_new_keys_gets_their_defaults` (a stored
    `{"max_response_s":{"whatsapp":900}}` reads back with `instagram`, `trendyol`, … at their defaults and
    `whatsapp` at 900).
  - `bin/jeeta/src/config.rs`: `comment_scope_flags_default_off`, `comment_scope_flags_read_1_and_true`.
- [ ] CI red → implement → green (`cargo check -p jt_app --tests --features tokio/time` locally).
- [ ] **Commit** `feat(inbox): public-surface ports, the item envelope and marketplace credentials`.

**Acceptance:** every `ConnectorRegistry` implementation compiles unchanged (defaults); no behaviour changes
yet. **Risk:** low.

### Task F5: intake — webhook gate and consumer (size L)

**Files:** create `rust/crates/jt_app/src/usecases/inbox/public.rs` (`comments_enabled`, `intake`,
`settle_state`, `subject_fetch`); modify `usecases/inbox/{consumer.rs,mod.rs}`, `usecases/webhook.rs`
(`Delivery::Disabled`), `rust/crates/adapters/jt_webhook/src/{lib.rs,meta.rs}` (`disabled_meta` counter and
warning); `jt_testkit/src/fakes/providers.rs` (a scripted `PublicSurface` with `subject`); create
`rust/crates/jt_app/tests/inbox_public_intake.rs`.

- [ ] **Tests first (`inbox_public_intake.rs`, fakes; envelopes built in the test):**
  - `ig_comment_creates_person_conversation_message_item_and_subject_without_a_journey`
  - `commenter_identity_is_scoped_to_the_account` (`instagram_commenter`, `<ig account>:<from.id>`)
  - `second_comment_same_person_same_conversation_two_items`
  - `replayed_comment_is_a_duplicate`
  - `facebook_comment_without_author_is_a_one_off_person` (`c:<comment_id>`)
  - `comment_event_on_messenger_capability_is_remapped_to_the_page` and `…_without_a_page_capability_is_no_surface`
  - `comment_routed_to_messenger_is_kept_when_the_page_grant_holds` (`comments_enabled` reads the surface kind)
  - `own_comment_marks_the_parent_answered_elsewhere` and `own_comment_binds_our_sending_reply` (echo binding)
  - `edited_comment_adds_a_revision_and_keeps_the_answer_state`
  - `removed_comment_is_removed_and_not_owed`
  - `question_open_then_answered_elsewhere` (Trendyol envelope `answered` with a text we never sent)
  - `question_status_for_an_unknown_item_is_deferred`
  - `trendyol_buyer_without_customer_id_is_a_one_off_person`; `trendyol_name_hidden_when_show_user_name_false`
  - `erased_commenter_is_dropped`
  - `comment_not_stored_when_comments_are_not_enabled` (`receive_for_accounts` → `Delivery::Disabled`; nothing
    written) and `comment_ignored_by_consumer_when_grant_later_revoked`
  - `subject_is_fetched_once_and_linked_to_the_studio_publication`
  - `conversation_state_is_ours_while_an_item_is_owed`
  - `private_reply_echo_is_a_duplicate_not_a_deferral` (a DM echo whose `mid` is a public conversation's
    outbound message)
- [ ] CI red → implement → green.

```rust
// consumer::route, after the existing DM remap
if event.provider == Provider::Meta && event.kind == EventKind::Comment {
    cap = match surface_sibling(r, &cap).await? { Some(c) => c, None => return Ok("no_surface") };
}
if matches!(event.kind, EventKind::Comment | EventKind::Question) {
    return super::public::intake(deps, ctx, r, event, &cap, subject.as_ref()).await;
}
// public::intake (sketch)
pub(crate) async fn intake(deps: &Deps, ctx: &Ctx, r: &mut dyn TenantRepos, event: &InboundEvent,
    cap: &Capability, fetched: Option<&SubjectFacts>) -> Result<&'static str, AppError> {
    if !comments_enabled(cap) { return Ok("comments_not_enabled"); }
    let env = PublicEnvelope::from_payload(&event.payload).ok_or_else(malformed)?;
    if env.author.is_self || env.author.id.as_deref() == cap.external_id.as_deref() { return own(deps, ctx, r, cap, &env).await; }
    match env.status { EnvelopeStatus::Open | EnvelopeStatus::Edited => {}, _ => return status(deps, ctx, r, cap, &env).await }
    let channel = public_channel_for_kind(&cap.kind_key).ok_or_else(malformed)?;
    let raw = env.author.id.clone().unwrap_or_else(|| one_off(&env));   // "c:<id>" / "q:<id>"
    let key = scope_opaque(account(cap)?, &normalise(channel.identity_channel(), &raw).map_err(|_| malformed())?);
    super::erasure::check_identity(r, channel.identity_channel(), &key).await?;
    // dedupe → match_or_create (Source::Channel(channel), no journey) → subject upsert → upsert_on_inbound
    // → insert message → record_inbound_sender → insert item → settle_state
    Ok("consumed")
}
/// The grant is read for the surface kind: routing may hand a Page's comment to its `messenger` row.
pub(crate) fn comments_enabled(cap: &Capability) -> bool {
    if matches!(cap.kind_key.as_str(), "trendyol" | "hepsiburada") { return true; }
    let scopes = scopes_of(&cap.connector_public);          // connector_public.access.scopes
    comment_grant(surface_kind(&cap.kind_key), &scopes).enabled()
}
```

**Acceptance:** no DM test changes; a comment event of a capability without the grant writes nothing anywhere.
**Risk:** medium (consumer routing); mitigated by the remap and no-surface tests.

### Task F6: replies, approval and receipts on public conversations (size L)

**Files:** `rust/crates/jt_app/src/usecases/inbox/{replies.rs,public.rs,schema.rs}` (`ReplyInput.item_id`,
`.visibility`; `reply` schema), `usecases/jobs.rs` (`outbox_recover` ignores `held`, pinned by a test);
create `rust/crates/jt_app/tests/inbox_public_reply.rs`; `jt_testkit/src/fakes/providers.rs` (scripted
`reply_public`/`reply_private` results incl. `Unknown`, `recipient_id`).

- [ ] **Tests first:**
  - fence: `public_reply_requires_item_id`, `item_fields_refused_on_a_dm_conversation`,
    `commercial_refused_on_public`, `comments_not_enabled_refuses_reply`, one test per `PublicRefusal` reached
    through `inbox.reply` (agent and human), `daily_ops_cap_counts_agent_public_replies`,
    `fence_runs_again_at_claim` (item answered elsewhere between enqueue and claim → refused at claim).
  - approval: `agent_reply_is_held_when_capability_requires_approval`, `human_reply_is_never_held`,
    `held_rows_are_never_claimed_or_recovered`, `approve_by_human_sends_with_the_approver_as_author`,
    `approve_with_edit_replaces_the_text_and_refences`, `approve_refused_for_agents` (`human_required`),
    `approve_refused_when_the_item_stopped_being_answerable`, `discard_by_drafter_or_human_only`.
  - receipts: `public_reply_receipt_answers_the_item` (IG: `Answered{Us}`, `agent_replied`),
    `trendyol_answer_receipt_is_pending`, `private_reply_marks_the_item_and_links_the_dm_identity`,
    `private_reply_identity_collision_suggests_a_merge`, `removed_item_error_marks_removed_and_fails_the_send`,
    `unknown_is_never_resent`, `replied_applies_only_with_a_journey`,
    `state_stays_ours_while_another_item_is_owed`.
- [ ] CI red → implement → green.

```rust
// replies::enqueue_in (public branch)
if let Some(channel) = public_channel_for_kind(&c.kind_key) {
    let item = super::public::locked_item(r, input.item_id, c.id).await?;      // ItemRequired / ItemNotInConversation
    super::public::fence(r, ctx, &c, &cap, &item, channel, &input, author).await?;   // §3.6 rules 1–6
    intent["public"] = json!({"item_id": item.id, "visibility": visibility, "target": target(&item),
                              "drafted_by": ctx.actor});
    let held = cap.policy.requires_human_approval && !matches!(ctx.actor, Actor::Human { .. });
    // row.state = if held { "held" } else { "queued" }; ledger "inbox.public.held" when held
}
// send_step: intent.public → deps.connectors.public(provider)?.reply_public | reply_private
// record_result_in: intent.public → public::on_receipt(deps, ctx, r, &row, &result).await?
```

**Acceptance:** every DM reply test passes unedited. **Risk:** medium (shared send path); mitigated by the
unedited DM tests and the claim re-fence test.

### Task F7: moderation, mark handled, report, approve/discard rows: catalog, MCP, HTTP, pins (size M)

**Files:** `rust/crates/jt_app/src/usecases/inbox/{public.rs,schema.rs}`, `rust/crates/jt_app/src/catalog.rs`,
`rust/crates/adapters/jt_mcp/src/tools/inbox.rs`, `rust/crates/adapters/jt_panel_http/src/routes/inbox.rs`;
pins: `jt_app/tests/catalog.rs`, `jt_archtest/tests/{m4_productisation,studio_rules,twin_rule,inbox_rules,gate_rule,twin_parity}.rs`,
`jt_mcp/tests/{inbox_mcp.rs,billing/m4_billing_mcp.rs}`; create `rust/crates/jt_app/tests/inbox_public_moderation.rs`.

- [ ] **Tests first:**
  - `inbox_public_moderation.rs`: `agent_hides_and_unhides`, `hide_refused_on_marketplace_items`,
    `delete_needs_manage_confirm_and_a_human` (`agent_cannot_delete`), `delete_marks_deleted_and_not_owed`,
    `mark_handled_batch_up_to_100_and_one_ledger_line`, `mark_handled_refuses_a_foreign_or_closed_item`,
    `report_only_where_the_surface_reports`, `moderation_without_grant_refused` (`comments_not_enabled`),
    `moderation_provider_call_holds_no_transaction` (the scripted surface asserts no open tenant bundle during
    the call), `lost_race_is_skipped_not_doubled` (item changed between check and write).
  - pins (spec §7.3): catalog 175 rows with the six in the expected table; `POST_M4_ADDED: [_; 21]`; registry
    146; `the_registry_holds_146_tools` with `("inbox", 52)`; destructive set + `jeeta.inbox.public_delete`;
    inbox rows 52 in `inbox_rules.rs` and `gate_rule.rs`; `inbox_mcp.rs` 52 and the manage set +
    `inbox.public.delete`; `m4_billing_mcp.rs` 146; `inbox_catalog_schemas_match_both_surfaces` covers the new
    schemas.
  - `twin_parity.rs`: `public_hide_twins`, `public_delete_twins`, `public_mark_handled_twins`,
    `public_report_twins`, `public_approve_twins`, `public_discard_twins` (same answer and same ledger line on
    MCP and HTTP).
- [ ] CI red → implement → green.

```rust
// catalog.rs, after inbox.commission_rates.set
twin("inbox.public.hide", GateMode::Gated, "jeeta.inbox.public_hide", ("POST", "/api/inbox/items/{item_id}/hide"), Write),
twin("inbox.public.delete", GateMode::Gated, "jeeta.inbox.public_delete", ("POST", "/api/inbox/items/{item_id}/delete"), Destructive),
twin("inbox.public.mark_handled", GateMode::Gated, "jeeta.inbox.public_mark_handled", ("POST", "/api/inbox/items/handled"), Write),
twin("inbox.public.report", GateMode::Gated, "jeeta.inbox.public_report", ("POST", "/api/inbox/items/{item_id}/report"), Write),
twin("inbox.public.approve", GateMode::Gated, "jeeta.inbox.public_approve", ("POST", "/api/inbox/replies/{outbox_id}/approve"), Write),
twin("inbox.public.discard", GateMode::Gated, "jeeta.inbox.public_discard", ("POST", "/api/inbox/replies/{outbox_id}/discard"), Write),
// schema::input
"public.hide" => object(json!({"hidden":{"type":"boolean"}}), &["hidden"]),
"public.delete" => object(json!({"confirm":{"type":"boolean","default":false}}), &[]),
"public.mark_handled" => object(json!({"item_ids":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"string","format":"uuid"}},
    "reason":{"enum":["no_reply_needed","spam","duplicate","answered_elsewhere"]}}), &["item_ids","reason"]),
"public.report" => object(json!({"reason":{"enum":["spam","offensive","personal_data","irrelevant","other"]}}), &["reason"]),
"public.approve" => object(json!({"text":{"type":["string","null"],"minLength":1},"request_key":{"type":["string","null"]}}), &[]),
// "public.discard" → the default empty object; schema::tool adds "item_id" / "outbox_id"
```

**Acceptance:** archtest and catalog pins green with exactly six new rows. **Risk:** low (mechanical), but the
pins are spread: run `cargo test -p jt_archtest -p jt_mcp` in CI before review.

### Task F8: reads, pending, work items, SLA and deadlines (size M)

**Files:** `rust/crates/jt_app/src/usecases/inbox/{context.rs,conversations.rs,public.rs}`,
`usecases/work.rs` (`AnswerDeadline`, `ApproveReply`, `EnableComments`), `usecases/jobs.rs`
(`run_inbox_timer` for `ResponseSla`); create `rust/crates/jt_app/tests/inbox_public_reads.rs`.

- [ ] **Tests first:**
  - `context_of_a_comment_conversation_has_items_subjects_threads_rules_and_hint`
  - `context_of_a_question_has_the_deadline_and_the_marketplace_rules`
  - `context_of_a_dm_has_no_public_part` (output unchanged for DMs)
  - `conversation_view_has_surface_owed_items_next_deadline_and_held_replies`
  - `messages_list_marks_item_messages`
  - `pending_lists_public_due_and_approvals` (approvals only to human callers)
  - `work_answer_deadline_within_24h_sorted_by_urgency`, `work_approve_reply_for_humans_only`,
    `work_enable_comments_when_flag_on_and_grant_missing` (and none when the flag is off)
  - `sla_uses_the_oldest_owed_item`, `sla_hands_over_two_hours_before_a_deadline`,
    `sla_expires_items_past_their_deadline`, `sla_maps_relay_mail_to_amazon`,
    `sla_defaults_apply_to_stored_policies` (uses F4's merge)
- [ ] CI red → implement → green.
- [ ] **Commit** `feat(inbox): public context, views, deadlines and work items`.

**Acceptance:** DM outputs unchanged except additive fields. **Risk:** low.

### Task F9: erasure inventory and end-to-end erasure of public data (size S)

**Files:** `rust/crates/jt_app/src/usecases/inbox/erasure.rs` (`event_identities` reads the envelope author in
its namespace), `jt_testkit/src/fakes/inbox.rs` (in-memory erasure of public payloads); create tests in
`rust/crates/jt_app/tests/inbox_public_intake.rs` (`erase_commenter_scrubs_messages_and_payloads`,
`erased_commenter_new_comment_dropped`, `items_keep_no_personal_text`) and `jt_pg/tests/inbox_public.rs`
(`erasure_masks_comment_and_question_events`).

- [ ] CI red → implement → green; **commit** `feat(inbox): erasure covers comments and questions`.

**Acceptance:** an erased commenter leaves no handle or text in messages, identities or event payloads.
**Risk:** low.

---

## M — Meta comments (after F4; M4/M5 after F5)

### Task M1: webhook parsing into the envelope (size M)

**Files:** `rust/crates/adapters/jt_meta/src/webhook.rs` (module docs' tables, `feed` and
`comments`/`live_comments` changes), `tests/webhook.rs`, fixtures under `tests/fixtures/comments/*.json`
(written from Meta's reference samples, ids made up; no real handle or text).

- [ ] **Tests first:** `feed_comment_add_is_a_comment_event`, `feed_comment_edit_and_remove`,
  `feed_reply_has_parent_and_root`, `feed_posts_reactions_and_visitor_posts_are_left_out`,
  `ig_comment_and_reply`, `ig_live_comment_is_flagged_live`, `own_comment_is_self`,
  `feed_comment_without_from_has_no_author_id`, `comment_external_ids_are_stable_per_state`,
  `scoped_body_keeps_a_comment_entry`, `unknown_fields_ignored`, `existing_message_fixtures_unchanged`.
- [ ] CI red → implement → green; **commit** `feat(meta): comment webhooks become public-item events`.

**Acceptance:** every existing webhook test passes unedited. **Risk:** low.

### Task M2: replies, private replies, moderation and subjects over Graph (size M)

**Files:** create `rust/crates/adapters/jt_meta/src/comments.rs`; modify `graph.rs` (`graph_delete`,
`instagram_delete`, the "object does not exist" reason), `ports.rs` (`impl PublicSurface for MetaConnector`),
`lib.rs` (docs); `tests/comments.rs`, `tests/support/mod.rs` (mock routes).

- [ ] **Before code:** V-M1/V-M8/V-M10 — read Meta's current reference for every call of spec §8.1, update the
  table in `comments.rs` docs with the source links; any difference changes the table and the tests first.
- [ ] **Tests first:** `ig_public_reply_posts_to_replies`, `fb_public_reply_posts_to_comments`,
  `ig_login_reply_goes_to_graph_instagram`, `private_reply_targets_the_comment_id_and_returns_recipient`,
  `hide_unhide_use_each_platforms_field`, `delete_uses_delete`, `subject_fields_for_media_and_posts`,
  `deleted_comment_maps_to_item_removed`, `lost_answer_is_unknown`, `token_never_in_url_and_proof_on_graph`,
  `refused_without_grant_before_any_call`.
- [ ] CI red → implement → green; **commit** `feat(meta): reply to, hide and delete comments`.

**Acceptance:** the adapter refuses every comment call for a credential whose grant lacks it. **Risk:** low.

### Task M3: scopes behind flags, subscription union, probe facts, Instagram Login (size M)

**Files:** `rust/crates/adapters/jt_meta/src/{oauth.rs,probe.rs,assets.rs,messaging.rs}`, `tests/graph.rs`.

- [ ] **Tests first:** `authorize_url_omits_comment_scopes_when_flag_off` (byte-equal to today's URL),
  `authorize_url_appends_comment_scopes_when_flag_on`, `login_config_url_unchanged_by_the_flag`,
  `instagram_authorize_appends_its_comment_scopes_when_flag_on`,
  `page_subscription_without_grant_is_exactly_todays_fields`, `page_subscription_with_grant_adds_feed`,
  `refused_feed_is_dropped_and_retried`, `refused_leadgen_and_feed_both_dropped`,
  `instagram_login_subscribes_comment_fields_with_grant`, `probe_reports_comment_grant_facts`,
  `instagram_login_assets_add_instagram_dm_with_messages_scope`,
  `instagram_login_dm_send_goes_to_graph_instagram` (and is refused without the messages scope).
- [ ] CI red → implement → green; **commit** `feat(meta): ask for comment scopes only when enabled`.

```rust
// probe.rs: the union replaces the two-step leadgen logic
let mut fields = vec![PAGE_MESSAGING_FIELDS.to_owned()];
if grants_leads(cred, public) { fields.push(PAGE_LEADGEN_FIELD.into()); }
if comment_grant(kind, &scopes_of(cred, public)).enabled() { fields.push(PAGE_FEED_FIELD.into()); }
loop {
    match subscribe_fields(connector, &app, page, token, &fields.join(",")).await {
        Ok(()) => break,
        Err(e) => match refused_optional_field(&e, &fields) { Some(i) => { fields.remove(i); } None => return Err(e) },
    }
}
```

**Acceptance:** with both flags off and no granted comment scope, every Meta request the system makes is
byte-for-byte today's (pinned by the "exactly today's" tests). **Risk:** medium (live subscription code);
mitigated by those pins.

### Task M4: comments backfill poll and `comments_poll` job (size M)

**Files:** `rust/crates/adapters/jt_meta/src/comments.rs` (`impl PublicPoller`), `tests/comments.rs`;
`rust/crates/jt_app/src/usecases/jobs.rs` (`Job::CommentsPoll`, `run_comments_poll`), `jt_app/tests/jobs.rs`,
`rust/crates/jt_app/tests/inbox_public_jobs.rs`, `rust/bin/jeeta/src/scheduler.rs` (interval `HOUR`, test);
`jt_testkit/src/fakes/providers.rs` (scripted poller).

- [ ] **Tests first:** adapter `poll_reads_recent_media_with_changed_counts_only`,
  `poll_is_bounded_per_run_and_resumes_from_the_cursor`, `reconcile_finds_our_reply_text`; app
  `comments_poll_skips_capabilities_without_grant`, `comments_poll_stores_like_webhooks_and_dedupes`,
  `comments_poll_binds_unknown_replies_by_reconciliation`, `comments_poll_holds_no_transaction_during_io`;
  `every_job_has_a_lock_named_after_it` gains `comments_poll`; scheduler interval test.
- [ ] CI red → implement → green; **commit** `feat(meta): hourly comments backfill`.

**Acceptance:** Job::ALL has `CommentsPoll` (29, or 30 after T3). **Risk:** low.

### Task M4b (optional, after V-M3): exact-match link of commenter and DM identities (size S)

Only if V-M3 shows an Instagram comment's `from.id` equals the DM IGSID for the same account. **Files:**
`usecases/inbox/public.rs` (at intake: if an active `InstagramDm` identity with the same scoped value exists,
add the commenter identity to that person). **Tests:** `commenter_joins_the_dm_person_when_ids_are_equal`,
`no_link_for_facebook`. **Commit** `feat(inbox): an Instagram commenter joins their DM person`.

### Task M5: gate end-to-end with signed deliveries (size S)

**Files:** `rust/crates/adapters/jt_webhook/tests/meta.rs`, `tests/support/mod.rs`.

- [ ] **Tests first:** `signed_comment_delivery_is_stored_when_granted`,
  `signed_comment_delivery_is_dropped_and_counted_when_not_granted` (`disabled_meta`, no tenant row, warning
  carries no id), `mixed_delivery_keeps_messages_and_drops_comments`.
- [ ] CI red → implement → green; **commit** `test(webhook): comment deliveries through the gate`.

---

## T — Trendyol (after F4; T3 after F5)

### Task T1: `jt_marketplace` crate, Trendyol client, probe, connector, egress, wiring (size M)

**Files:** create `rust/crates/adapters/jt_marketplace/{Cargo.toml,src/{lib.rs,client.rs,trendyol.rs,envelope.rs},tests/{support/mod.rs,trendyol.rs}}`
(manifest like `jt_tiktok`: `jt_app`, `jt_connector`, `jt_inbox`, `jt_outbound`, `serde_json`, `time`, `url`,
`tracing`, `async-trait`; dev: `jt_outbound` with `test-loopback`, `axum`, `tokio`; **no `jt_testkit`**, so it
tests on Windows); modify `rust/Cargo.toml` (member, workspace dep), `rust/crates/adapters/jt_outbound/src/fixed_hosts.rs`
(+ `host("trendyol", "apigw.trendyol.com")`, both pinned tests), `rust/crates/jt_archtest/tests/dependency_boundaries.rs`
(`jt_marketplace` in the no-reqwest/no-sqlx list and `CONNECTOR_ADAPTERS`), `rust/bin/jeeta/{Cargo.toml,src/connectors.rs}`
(registry: `connector`, `public`, `public_poller` for `Provider::Trendyol`).

- [ ] **Before code:** V-T1/V-T2 — confirm the base URL and the User-Agent rule in Trendyol's current docs; note
  the source in `trendyol.rs` docs.
- [ ] **Tests first (`tests/trendyol.rs`, in-process mock):** `every_call_has_basic_auth_and_the_integrator_user_agent`,
  `probe_names_the_seller_from_the_path_it_was_served`, `probe_auth_failure_is_auth`, `throttle_reads_retry_after`,
  `server_error_is_transient`, `secrets_never_in_errors_or_debug`, `only_trendyol_hosts_are_reached`.
- [ ] `cargo test -p jt_marketplace` (Windows) red → implement → green; `cargo test -p jt_outbound` green;
  **commit** `feat(marketplace): the Trendyol connector`.

```rust
pub const TRENDYOL_INTEGRATOR: &str = "JeetaGrowth";
fn user_agent(seller_id: &str) -> String { format!("{seller_id} - {TRENDYOL_INTEGRATOR}") }
pub struct TrendyolBases { pub api: Url }      // production: https://apigw.trendyol.com/integration (V-T1)
```

**Acceptance:** a `trendyol` capability can be created with `connector.set_credentials` and probed. **Risk:** low.

### Task T2: Trendyol questions poll, reconcile and answer (size M)

**Files:** `rust/crates/adapters/jt_marketplace/src/{trendyol.rs,envelope.rs}`, `tests/trendyol.rs`,
fixtures `tests/fixtures/trendyol/*.json` (shapes from the reference pages; made-up ids, names and texts).

- [ ] **Tests first:** `first_poll_scans_fourteen_days_in_one_window`, `windows_never_exceed_fourteen_days`,
  `pages_of_fifty_until_short`, `cursor_advances_only_after_the_window_is_read`, `run_stops_at_twenty_pages`,
  `each_status_maps_to_the_envelope` (WAITING_FOR_ANSWER, WAITING_FOR_APPROVE, ANSWERED, REJECTED, REPORTED),
  `external_id_changes_with_state`, `buyer_name_only_when_shown`, `product_becomes_the_subject`,
  `reconcile_reads_details_by_id`, `answer_posts_the_text_and_its_lost_answer_is_unknown`,
  `answer_bounds_checked_before_the_call`.
- [ ] `cargo test -p jt_marketplace` red → implement → green; **commit** `feat(marketplace): Trendyol questions`.

**Acceptance:** the envelope tests cover every status the spec maps. **Risk:** low (V-T3 rate limits may change
the per-run budget constants).

### Task T3: `marketplace_poll` job (size S)

**Files:** `rust/crates/jt_app/src/usecases/jobs.rs` (`Job::MarketplacePoll`, `run_marketplace_poll`: the
`run_mail_inbox_poll` shape — read sealed credential and cursor, release, poll and reconcile with no
transaction, then lock the capability, compare `updated_at` + sealed bytes + cursor, `store_polled`,
`public_cursors().store`, `mark_checked`, commit, consume the workspace); `jt_app/tests/{jobs,inbox_public_jobs}.rs`;
`rust/bin/jeeta/src/scheduler.rs` (`5 * MINUTE`, test).

- [ ] **Tests first:** `marketplace_poll_runs_for_receiving_workspaces_only`,
  `marketplace_poll_stores_drafts_cursor_and_checks_atomically`, `credential_changed_meanwhile_writes_nothing`,
  `throttled_capability_is_skipped_for_the_run`, `reconcile_rotates_through_open_items`,
  `unknown_answer_settles_to_failed_after_two_empty_reconciliations` (spec §6.5), names list + scheduler test.
- [ ] CI red → implement → green; **commit** `feat(inbox): poll marketplace questions every five minutes`.

**Acceptance:** Job::ALL has `MarketplacePoll`. **Risk:** low.

---

## H — Hepsiburada

### Task H0: verify Hepsiburada's "Satıcıya Sor" API (size S, no code)

The portal refuses automated access (research). A human or an agent driving the owner's Chrome reads
`developers.hepsiburada.com` (Soru Cevaplama, Satıcıya Sor, Sorun Bildirme) and, with a merchant API credential
(spec §15 Q2), records:
- hosts (production and test), paths, auth pair and headers (incl. any User-Agent rule);
- list filters, paging, statuses beyond 1/2/4, field names (question id, buyer id/name, product, `expireDate`,
  answer), answer bounds, moderation, report reasons, rate limits.

- [ ] Write the facts with their source links into `jt_marketplace/src/hepsiburada.rs` module docs, request and
  response samples (ids, names, texts made up) into `tests/fixtures/hepsiburada/`, and set
  `HEPSIBURADA_ANSWER_BOUNDS` in `jt_inbox::public` (+ its test row); **commit**
  `docs(marketplace): Hepsiburada's ask-the-seller API as verified`.

### Task H1: Hepsiburada connector, poll, answer, report (size M)

**Files:** `rust/crates/adapters/jt_marketplace/src/hepsiburada.rs`, `tests/hepsiburada.rs`;
`jt_outbound/src/fixed_hosts.rs` (the verified host(s) under `hepsiburada`, both pinned tests);
`bin/jeeta/src/connectors.rs`; panel form fields in P3 follow H0.

- [ ] **Tests first:** the T1/T2 set for Hepsiburada (auth/probe/errors/poll/status map/answer/bounds) plus
  `expire_date_becomes_the_deadline`, `expired_status_is_expired`, `report_maps_reasons_to_the_documented_codes`.
- [ ] `cargo test -p jt_marketplace` red → implement → green; **commit** `feat(marketplace): Hepsiburada questions`.

---

## A — Amazon relay (after F5)

### Task A1: relay classification, fences, context (size S)

**Files:** `rust/crates/jt_app/src/usecases/inbox/{consumer.rs,replies.rs,context.rs,public.rs}`; create tests
in `rust/crates/jt_app/tests/inbox_public_intake.rs` and `inbox_public_reply.rs`.

- [ ] **Before code:** V-A1/V-A2/V-A3 from a real relay mail in the owner's mailbox (headers only noted; no
  buyer data into the repo) and Amazon's current buyer-seller messaging rules.
- [ ] **Tests first:** `relay_mail_opens_no_journey`, `relay_display_name_is_cleaned`,
  `non_relay_amazon_mail_is_ordinary`, `relay_reply_refuses_commercial_and_links`,
  `relay_reply_goes_to_the_relay_address_from_the_mailbox`, `relay_context_has_order_id_and_deadline`,
  `relay_deadline_work_item`.
- [ ] CI red → implement → green; **commit** `feat(inbox): Amazon buyer messages over the mailbox`.

---

## P — panel (after F7/F8 API shapes)

### Task P1: types, list badges, deadlines, approvals queue (size M)

**Files:** `rust/panel/src/api/{types.ts,inbox.ts}` (ConversationView, PublicItem, PublicContext, held
replies, the six calls; capability kinds `trendyol`, `hepsiburada` and group `marketplace`),
`src/pages/InboxPage.tsx`, new `src/pages/InboxApprovals.tsx`, `src/lib/capabilities.ts`, i18n, tests
`src/pages/Inbox.test.tsx`.

- [ ] **Tests first:** `list_shows_surface_badges`, `deadline_countdown_turns_red_under_two_hours`,
  `approvals_queue_lists_held_replies`, `marketplace_kinds_have_labels`, i18n parity.
- [ ] `pnpm --dir rust/panel test` and `typecheck` red → implement → green; **commit**
  `feat(panel): comments, questions and Amazon in the inbox list`.

### Task P2: public conversation view, composer, held card (size L)

**Files:** new `rust/panel/src/pages/InboxPublic.tsx` (subject cards, items with threads, per-item actions,
composer), `src/pages/InboxConversation.tsx` (renders `InboxPublic` for public/relay conversations), i18n,
`src/pages/InboxPublic.test.tsx`.

- [ ] **Tests first:** `subject_card_shows_post_or_product`, `items_show_their_state_badges_and_thread`,
  `composer_defaults_to_the_oldest_owed_item`, `private_toggle_only_when_allowed_and_shows_time_left`,
  `character_counter_enforces_surface_bounds`, `marketplace_note_shown`, `approval_note_when_required`,
  `each_item_action_has_its_own_pending_state`, `composer_resets_on_item_change`,
  `enter_cannot_double_submit`, `delete_needs_typed_confirmation_and_manage`, `held_card_approve_edit_discard`,
  `amazon_badge_order_id_and_no_links_note`.
- [ ] `pnpm --dir rust/panel test` red → implement → green; **commit** `feat(panel): answer comments and questions`.

### Task P3: connect forms and comment status (size M)

**Files:** `rust/panel/src/pages/ConnectPage.tsx` (+ test), `src/pages/ProviderSetup.tsx` if the forms live
there, i18n.

- [ ] **Tests first:** `trendyol_form_sends_the_seller_shape`, `hepsiburada_form_follows_h0_fields`,
  `secrets_are_not_echoed_after_save`, `meta_card_shows_comment_status_off_reconnect_on`.
- [ ] `pnpm --dir rust/panel test` red → implement → green; **commit** `feat(panel): connect marketplaces, see comment status`.

---

## R — smoke, operations, live checks

### Task R1: `make smoke-inbox-public` (size S)

**Files:** create `rust/crates/jt_app/tests/smoke_inbox_public.rs`; `rust/Makefile` (`smoke-inbox-public:
cargo test --locked -p jt_app --test smoke_inbox_public`).

- [ ] Scenario 1: scripted Meta comment (granted) → consumer → `inbox.context` → agent `inbox.reply` (public;
  capability requires approval) → `held` → human `inbox.public.approve` → receipt → item `answered`, ledger
  lines in order. Scenario 2: scripted Trendyol poll → question → agent answer (the scenario turns approval
  on for the capability; the default is off, spec §3.7) → approve → `pending` → poll `ANSWERED` →
  `answered`. Scenario 3: comment without grant → nothing stored.
- [ ] CI green; **commit** `test(inbox): smoke for comments and questions`.

### Task R2: operations doc and live verification (size S, after everything merged)

**Files:** create `docs/operations/inbox-public-rollout.md`: spec §11 steps with the exact env names and
dashboard fields; the V-list of spec §12 with who runs each and where its result is recorded.

- [ ] Run the V-checks that need no new Meta permission on staging with the owner's accounts (V-T*, V-A*,
  V-H* after H0, V-M6 with an existing Studio post); record results in the doc (no ids, handles or texts of
  real customers).
- [ ] After the new Meta App Review is approved: run V-M1–V-M10 and the rollout steps; record.
- [ ] **Commit** `docs(operations): rolling out comments and marketplace questions`.

---

## Self-review against the spec

- §2 decisions → D1/D2 (F5 surface remap, no key change), D3 (F1), D4 (F5 no-journey test), D5 (F6 identity
  link and collision tests), D6/D7 (F6), D8 (F1 fence matrix, F7 delete), D9 (F6 commercial refusal), D10 (F9),
  D11 (F2 grant, F5 drop, M3 byte-equal pins, M4 skip), D12 (F4 envelope, M1, T2), D13 (T1–T3), D14 (A1),
  D15 (H1 `expireDate`, F8), D16 (F5 subject + publication), D17 (M4).
- §3.6 every refusal reason has a named test (F1 matrix, F6 through `inbox.reply`, A1 relay).
- §4 migration → F3 (tables, generated column, held, down semantics, masks, event matching, merges).
- §6.9 jobs → M4, T3, F8 (SLA); §7 catalog and every pin of §7.3 → F7 (+ F3 tables, M4/T3 jobs, F2 kinds,
  T1/H1 hosts, P1 panel kinds).
- §8 adapters → M1–M5, T1–T3, H0–H1, A1; §9 panel → P1–P3; §10 tests → each task + R1; §11/§12 → R2.
- §13 later phases are not in this plan (each needs its gate first).
