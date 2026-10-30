# Messages and comments everywhere, phase 1: comments and marketplace questions in the inbox (Rust)

Date: 2026-10-30. Status: draft for the owner's review.

Inputs: the research report `2026-10-30-social-messages-comments-research.md` (same folder; Turkish), the
owner's direction of 2026-10-30 (messages and comments first; official APIs and existing services; the
physical phone only where no API exists; nothing left missing), and the Rust code at `958fcfe3`
(`origin/feat/rust-panel-money-inputs`). Conventions follow `2026-10-22-jeeta-rust-yeniden-yazim-design.md`
(§4.2 three rules, §4.5 panel/MCP twins, §7 inbox) and the M2a/M2b inbox plans.

Branch: `feat/inbox-comments-marketplace`. Migration: **`0019_inbox_public`**. `0018` is taken by the
TikTok webhooks work (`0018_tiktok_webhooks`, uncommitted in the `kds-marketing-tiktok2` worktree), which
widens `inbound_events_provider_check` to `('meta','netgsm','x','mail','tiktok')`; 0019 widens the same
constraint and must carry `tiktok` too (§4.1). Every count in this document is relative to `958fcfe3`; a
rebase over another branch adds that branch's increments.

Unverified provider facts are marked **VERIFY (V-xx)** and collected in §12. Implementers write no
provider fact into code comments without its source (see the plan's global constraints).

---

## 1. Goal, scope, non-goals

**Goal.** The inbox answers, besides DMs, (a) public comments on the workspace's Instagram and Facebook Page
posts, (b) customer questions on Trendyol and Hepsiburada products, and (c) Amazon.com.tr buyer messages
that reach a connected mailbox. Each arrives with its context (the post or product), each has the reply
modes its platform allows (public reply, Instagram/Facebook private reply, marketplace answer), its
platform's limits (length, window, one-shot, moderation, deadline), moderation where the platform offers
it (hide, delete, report), and a "handled without a reply" mark. The agent answers within fences; a human
approves where the policy says so.

**Phase 1 scope.**
1. The inbox model for public items (§3) and its persistence (§4).
2. Meta comments: Instagram (Facebook Login and Instagram Login) and Facebook Page comments, by webhook and a
   backfill poll; reply, private reply, hide, unhide, delete. Built now, **inert until the new Meta App
   Review grants the comment permissions** (§8.1, §11).
3. Trendyol and Hepsiburada customer questions: a new adapter crate, sealed per-seller credentials,
   polling, answering, reporting (Hepsiburada).
4. Amazon.com.tr buyer messages over the existing IMAP inbound mail.

**Non-goals of phase 1** (each sketched in §13 with its gate): WhatsApp Coexistence, n11 and Çiçeksepeti,
X DMs and mentions, TikTok DMs and comments, YouTube comments, Google Business Profile reviews, LinkedIn page
comments, Facebook recommendations, Instagram mentions, Messenger/Instagram HUMAN_AGENT, attachments in
answers, and the phone fallback (device bridge playbooks).

---

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Comments are served by the **SocialAccount capabilities that publish the posts** (`instagram`, `facebook_page`); questions by **new Marketplace capabilities** (`trendyol`, `hepsiburada`); Amazon by the existing **`mailbox`**. The DM siblings (`instagram_dm`, `messenger`) stay the DM surfaces. | The account that owns a post owns its comments and holds the same token (one Page token serves `facebook_page`, `messenger`, `instagram`, `instagram_dm`; assets.rs). No new connection step. Because a conversation is unique per `(person, capability)` (0006), comment conversations and DM conversations of one person are separate rows without a schema change. |
| D2 | A **conversation stays person × capability**. A public conversation holds all of one person's comments (or questions) on that account. The unit of work is the **public item**: one comment or one question, with its own target id, thread, deadline, private-reply window and answer state (§3.3). | Keeps every existing invariant untouched: send fences, executor generation, take-over, snooze, SLA, merges and conversation coalescing, panel queues. What differs per comment (target id, window, deadline, one-shot) lives on the item. Per-thread conversations would have meant replacing the `(workspace_id, person_id, capability_id)` key that merges, `upsert_on_inbound`, `find(person, cap)` and the fakes rely on. |
| D3 | **Four new contact channels and four identity namespaces**, one per platform (§3.1, §3.2). Commenter ids are not assumed equal to DM ids. | Consent, suppression and erasure hashes are keyed by channel/namespace; per-platform namespaces avoid collisions of numeric ids across marketplaces; whether an Instagram comment's `from.id` equals the DM IGSID is unverified (V-M3), and a Facebook comment author id is not a PSID. |
| D4 | People created from public items **have no journey**. A journey opens when the person writes a DM (the existing path), or when the agent or a human opens one (`inbox.journeys.open`). | The journey is the sales funnel (spec §7.3). Most comments are not leads and marketplace sales happen on the marketplace. The agent decides what is a lead (rule 1); a private reply that is answered by DM opens a journey through the existing DM path, attributed to the comment (first touch). |
| D5 | A commenter is **linked to their DM identity through the private-reply receipt** (`recipient_id`): the identity is added to the commenter's person; a collision becomes the existing merge suggestion. | Deterministic; never a guess. Uses `people` identity collision handling as it is. |
| D6 | Public replies go through **the existing outbox pipeline** (`inbox.reply` with `item_id` and `visibility`): durable intent, two fences, provider call without locks, receipt in one transaction, uncertain results never retried. | One send path, one set of guarantees (spec §7.4 M2a). |
| D7 | **Approval** is a new outbox state `held`. A reply is held when its capability's `requires_human_approval` is on (the existing policy flag: "every action through it waits for a human's approval"). **Marketplace kinds are created with it on**; comment surfaces keep the account's current policy (off by default, K8). Approval is a human act (`inbox.work`, actor human) that may edit the text; a held reply may be discarded by a human or by the agent that drafted it. | Research §"Dört pazar yeri": a pre-send approval queue is the market standard and Trendyol's moderation and one-answer rule make wasted answers costly; K8 keeps publication autonomous by default, so comments follow the account's existing flag. One flag per account, no second knob. Approving is no more power than writing the reply, which `inbox.work` already allows. |
| D8 | **Agent limits** on public surfaces: one public reply per item, no deletion, hiding allowed (reversible), commercial intent refused, the person's own contact data never echoed publicly, no links/contact data in marketplace answers. Humans: no per-item reply limit on comments; deletion with `inbox.manage` and `confirm`. | Brand-visible and partly irreversible actions; deterministic fences only (rule 2), the content decision stays the agent's (rule 1). |
| D9 | **İYS/ETK**: a public reply is not a commercial electronic message; no İYS check. `commercial` intent is refused on public surfaces and on Amazon relay conversations. A private reply is a `reply` within its platform window (it answers the person's own comment). | Spec §7.6: a one-to-one reply to a customer-initiated contact is not a commercial send. |
| D10 | **KVKK**: store what the inbox needs (ids, text, handle); person erasure scrubs it with the existing machinery plus new masks; an erased commenter's later comments are dropped like any erased identity; content on the platform is not touched by erasure (the panel says so and offers the moderation actions first). | Same erasure model as DMs (spec §7.6 M2b); the platform copy is the platform's. |
| D11 | **Meta comment code is inert until granted**: one predicate, `comments_enabled(capability)`, computed from the scopes stored with the capability's credential (`connector_public.access.scopes`), gates intake, consumption, polling, reply/moderation fences and the `feed` webhook subscription. Authorize URLs ask for the comment scopes only when the platform flags `JEETA_META_COMMENT_SCOPES` / `JEETA_INSTAGRAM_COMMENT_SCOPES` are on (default off), like `JEETA_LINKEDIN_ORG_SCOPES`. No Meta dashboard change before the current review (submitted 2026-10-27) is decided. | The live app's scopes, login configuration and webhook fields stay exactly as submitted; nothing new reaches Meta until the operator flips the flags after approval; per-token detection lights the feature up account by account as owners reconnect. |
| D12 | Adapters normalise every comment and question into **one public-item envelope** (§6.3); the consumer has one provider-agnostic intake for it. | Provider knowledge stays in adapters (hexagonal); one intake, one erasure mask shape. |
| D13 | Marketplaces: **one adapter crate `jt_marketplace`**, **two providers** `trendyol` and `hepsiburada` (separate egress scopes), **one job `marketplace_poll`** every 5 minutes, with reconciliation by id rotated by `checked_at`. | Least privilege per host; one place for the shared poll logic; rotation avoids the take-N sweep pinning to the oldest N (bug class "recovery-sweep window blindness"). |
| D14 | **Amazon relay is derived, not stored**: a pure recognizer over the conversation's bound inbound email identity. Relay conversations open no journey, get a 24-hour deadline, refuse commercial intent and links, and are answered with the existing email reply to the relay address. | Nothing to migrate; the mailbox flow already carries it (research §Amazon). |
| D15 | **Deadlines come only from providers** (Hepsiburada `expireDate`; Amazon's 24 hours from receipt). Business days are never computed locally. | Holidays and time zones (bug class "server-local vs workspace time zone"). |
| D16 | A **subject** (post or product) is its own record, linked to the Studio publication when one made the post. | The panel and agent see what was commented on; Studio context ("this comment is on hypothesis X") comes for free. |
| D17 | A **comments backfill poll** (hourly, last 7 days of media/posts) closes webhook gaps and imports the backlog when comments are first enabled. Same external ids as webhooks, so replays store nothing new. | Webhook outages and the first-enable backlog would otherwise lose comments still within the private-reply window. |

---

## 3. The model

### 3.1 Surfaces and channels

`jt_inbox::Channel` gains four variants; each maps to an identity namespace and a capability kind:

| Channel (serde key) | Capability kind | Identity namespace | Surface |
|---|---|---|---|
| `InstagramComment` (`instagram_comment`) | `instagram` | `InstagramCommenter` | public |
| `FacebookComment` (`facebook_comment`) | `facebook_page` | `FacebookCommenter` | public |
| `TrendyolQuestion` (`trendyol_question`) | `trendyol` | `TrendyolBuyer` | public |
| `HepsiburadaQuestion` (`hepsiburada_question`) | `hepsiburada` | `HepsiburadaBuyer` | public |

- `channel_for_kind` keeps its meaning (the private contact channel of a messaging/telephony kind) and its
  test (`channel_for_every_messaging_kind`) unchanged. New: `public_channel_for_kind(kind_key)` and
  `conversation_channel(kind_key) = channel_for_kind(k).or(public_channel_for_kind(k))`; `Channel::is_public()`.
  The reply fence, `people` identity checks and the erasure inventory use `conversation_channel`.
- The consent and suppression inputs keep their schema enums (no public channel can be recorded): consent
  does not apply to public surfaces (D9).
- Amazon relay conversations stay `Channel::Email` on a `mailbox` (D14).

### 3.2 People and identities

| Source | Identity value (before `scope_opaque(capability external id, …)`) | Display name |
|---|---|---|
| Instagram comment | `from.id` | `from.username` |
| Facebook comment | `from.id`; when Meta omits `from` (V-M4): `c:<comment_id>` (a one-off person) | `from.name` |
| Trendyol question | `customerId` (V-T4); without one: `q:<questionId>` (one-off) | `userName` only when `showUserName` is true, else empty |
| Hepsiburada question | the buyer id the API gives (V-H2); without one: `q:<questionId>` | as the API gives, else empty |
| Amazon relay mail | the relay address (existing `Email` namespace) | the `From` display name without the " - Amazon Marketplace" suffix (V-A2) |

- All go through `people::match_or_create` (spec §7.2: one matching function), `Source::Channel(<channel>)`
  as first touch, **no journey** (D4).
- **Linking (D5).** A private reply's receipt carries the recipient's messaging id (V-M5). The reply use
  case adds `InstagramDm` / `Messenger` identity `scope_opaque(account, recipient_id)` to the commenter's
  person through the existing identity-add path: no collision → linked (ledger
  `inbox.public.identity_linked`); collision with another person → the existing merge suggestion
  (`identity_collision`). Later DMs from that person land on the DM conversation of the same person.
- If V-M3 shows that an Instagram comment's `from.id` is the DM IGSID for the same account, task M4b adds an
  exact-match attach at intake (commenter identity added to the person holding the equal `InstagramDm`
  value). Phase 1 does not assume it.
- Merges move public items with their conversations (§6.6); undo restores them.

### 3.3 Conversations, public items, subjects

- **Conversation**: unchanged type and key. `upsert_on_inbound` on the surface capability; `state` is
  derived after every item change: `Ours` while any item is awaiting, else `Theirs` (a snooze or a close is
  kept until the next inbound item reopens, as today).
- **Public item** (new, `jt_inbox::PublicItem`): one comment or one question.

```rust
pub struct PublicItem {
    pub id: PublicItemId,
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    pub conversation_id: ConversationId,
    pub message_id: MessageId,               // the inbound message (latest revision after an edit)
    pub subject_id: Option<PublicSubjectId>, // the post or product, once known
    pub kind: PublicKind,                    // Comment | Question
    pub external_id: String,                 // comment id / question id: the reply target
    pub parent_external_id: Option<String>,  // the comment it answers (None: top level)
    pub root_external_id: String,            // the thread's top-level comment (itself when top level)
    pub created_at: OffsetDateTime,          // provider clock, clamped like activity_at
    pub deadline: Option<OffsetDateTime>,    // provider-given (Hepsiburada expireDate)
    pub private_reply_until: Option<OffsetDateTime>, // created_at + window, when the surface allows one
    pub answer: AnswerState,
    pub moderation: Moderation,
    pub private_reply_message_id: Option<MessageId>,
    pub agent_replied: bool,
    pub checked_at: Option<OffsetDateTime>,  // last reconciliation against the provider
    pub updated_at: OffsetDateTime,
}
pub enum PublicKind { Comment, Question }
#[serde(tag = "state", rename_all = "snake_case")]   // stored as JSON; 0019 derives `answer_state` from "state"
pub enum AnswerState {
    Awaiting,
    Pending { message_id: MessageId },                 // our answer is in the platform's review (Trendyol)
    Answered { by: AnsweredBy, message_id: Option<MessageId>, at: OffsetDateTime },
    Rejected { reason: String, at: OffsetDateTime },   // the platform refused our answer: owed again
    Handled { by: EventSource, reason: HandledReason, at: OffsetDateTime },
    Expired { at: OffsetDateTime },
}
pub enum AnsweredBy { Us, Elsewhere }                  // Elsewhere: the platform app, the platform's own AI
pub enum Moderation { Visible, Hidden, Deleted, Removed, Reported }
pub enum HandledReason { NoReplyNeeded, Spam, Duplicate, AnsweredElsewhere } // = mark_handled's reasons
pub enum Visibility { Public, Private }
impl PublicItem {
    /// Owed a reply: Awaiting or Rejected, and Visible.
    pub fn awaiting(&self) -> bool;
}
```

- **Thread.** Items of one `(capability, root_external_id)` form a thread across people; the agent's
  context shows the thread (§6.8). Another user's reply under someone's comment is that user's own item in
  that user's conversation.
- **Our own comments** (webhook `from.id` = the account's own id; a marketplace answer the provider shows
  that we did not send) are not items: they are outbound messages (`Author::System`) in the parent item's
  conversation, and the parent item becomes `Answered { by: Elsewhere }`; an outbound reply of ours in
  flight is bound instead (echo binding, §6.5).
- **Edits** (Facebook `verb: edited`, V-M7) add an inbound message `<comment_id>#edit:<time>` and move the
  item's `message_id` to it; the answer state is kept.
- **Subject** (new, `jt_inbox::PublicSubject`): `{ id, capability_id, kind: Post | Product, external_id,
  title (caption excerpt ≤ 280 chars or product name), url, image_url, facts (media_product_type, barcode,
  product main id…), publication_id (Studio), first_seen_at, updated_at }`, unique per
  `(capability, external_id)`. `publication_id` is found by `studio_publications (capability_id,
  external_id)` (V-M6: the post id formats match). Thumbnails are provider CDN URLs the panel loads
  directly; they may expire, the permalink stays.

### 3.4 Item lifecycle (pure, `jt_inbox::public::apply`)

| Event | From | To | Notes |
|---|---|---|---|
| `AnswerSent { message_id, moderated }` | Awaiting, Rejected | Pending (moderated surface) / Answered{Us} | receipt of a public reply or answer |
| `AnswerConfirmed` | Pending | Answered{Us} | provider shows our text published |
| `AnswerRejected { reason }` | Pending | Rejected | Trendyol refused our answer; owed again |
| `AnsweredElsewhere { at }` | Awaiting, Rejected, Pending | Answered{Elsewhere} | answered outside Jeeta |
| `MarkedHandled { by, reason }` | Awaiting, Rejected | Handled | `inbox.public.mark_handled` |
| `Expired { at }` | Awaiting, Rejected | Expired | deadline passed or provider says expired |
| `Hidden` / `Unhidden` | Visible ↔ Hidden | — | moderation only; a hidden item is not owed |
| `Deleted` | Visible, Hidden | Deleted | by us |
| `Removed` | Visible, Hidden | Removed | by its author or the platform |
| `Reported` | Visible | Reported | marketplace report |
| `PrivateReplySent { message_id }` | any with the window open and none sent | — | sets `private_reply_message_id` |

Any other pair is `ItemTransitionError` (refused, nothing written). A human may post further public
replies on an answered comment (Instagram/Facebook allow several); those do not change the state.

### 3.5 Rules per surface (`jt_inbox::public::rules(channel) -> Option<PublicRules>`)

| | Instagram comment | Facebook comment | Trendyol question | Hepsiburada question |
|---|---|---|---|---|
| Public reply length | 1–2,200 (V-M8) | 1–8,000 (V-M8) | **10–2,000** (documented) | from the docs (V-H3) |
| Private reply | 7 days from the comment, once, ≤ 1,000 chars (V-M8) | 7 days, once, ≤ 2,000 (`MAX_MESSENGER_TEXT`) | — | — |
| One answer per item | no | no | yes | yes |
| Moderated before publishing | no | no | **yes** | V-H4 |
| Hide / delete | yes / yes | yes / yes (others' comments need `pages_read_user_content`) | — | — |
| Report | — | — | V-T5 | yes ("Sorun Bildirme") |
| Deadline | — | — | — (V-T6) | `expireDate` |
| Live comments | ingested; private reply during the live only (V-M9); no public reply | — | — | — |

Values marked VERIFY are constants in `jt_inbox::public` set by the verification tasks; until H0 runs the
Hepsiburada bounds are `None` and the Hepsiburada answer path refuses (`hepsiburada_unverified`).

### 3.6 Reply fence for public conversations

`inbox.reply` on a public conversation requires `item_id` (`item_required`) and takes `visibility`
(default `public`). At enqueue **and again at claim** (both branches, bug class "partial invariant
enforcement"), in this order, after the existing domain fence (`may_send`: lost journey, erased, merged,
generation, human holds, capability live):

1. `intent == commercial` → `commercial_on_public_surface`.
2. Meta surface and `!comments_enabled(capability)` → `comments_not_enabled`.
3. `item.conversation_id != conversation` → `item_not_in_conversation`.
4. `public::reply_allowed(item, rules, visibility, by_agent, now)`:
   - moderation `Deleted | Removed` → `item_removed`;
   - public: `Expired` or past `deadline` → `deadline_passed`; one-answer surface already `Pending | Answered`
     → `already_answered`; by agent and `agent_replied` → `agent_already_replied`; by agent and not
     `awaiting()` → `item_not_owed`;
   - private: surface without one → `private_reply_unsupported`; `now > private_reply_until` →
     `private_window_closed`; already sent → `private_reply_used`.
5. `public::check_text(rules, visibility, text, person_contacts)`: bounds → `text_too_short` /
   `text_too_long`; a public reply containing one of the person's own identity values (normalised email or
   phone) → `contact_data_in_public_reply`; a marketplace answer containing a URL, an email address or a
   phone-number-like run of 10+ digits → `contact_data_in_marketplace_answer` (Trendyol rejects these in
   review, V-T7).
6. Capability `daily_ops_cap` counts agent public replies of the day on that capability → `daily_ops_cap`.

The 24-hour DM window does not apply to public conversations; rule 4 replaces it. Refusals use the existing
`inbox.send.refused` ledger entry and `Refused { reason }` message status.

### 3.7 Approval (held replies)

- At enqueue, after the fence: `capability.policy.requires_human_approval && !actor.is_human()` → the outbox
  row is written with state **`held`**, the message `Queued`; ledger `inbox.public.held`; no provider call.
  `reply` answers `{message_id, state: "held"}`.
- `inbox.public.approve(outbox_id, {text?})`: human actor with `inbox.work` (`human_required` otherwise).
  Re-runs the full fence with the approver as author (the message author becomes `Human(approver)`; the
  drafting agent is kept in `intent.public.drafted_by`); an edited text replaces the body before the fence;
  state → `queued`, then `send_step`. Ledger `inbox.public.approved { edited }`.
- `inbox.public.discard(outbox_id)`: a human with `inbox.work`, or the agent connection that drafted it.
  State → `refused` with reason `discarded`; message `Refused { reason: "discarded" }`. Ledger
  `inbox.public.discarded`.
- `claim` never takes a `held` row; `outbox_recover` lists only `queued`/`sending` (pinned by a test).
- A held reply whose item stops being answerable (deadline passed, answered elsewhere, removed) is refused at
  approval by the fence; the panel shows why.

### 3.8 Who may do what

| Action | Agent | Human | Risk | Permission |
|---|---|---|---|---|
| Public reply / marketplace answer | yes (once per item; held when the capability requires approval) | yes | Write | `inbox.work` |
| Private reply | yes, within window, once | yes | Write | `inbox.work` |
| Hide / unhide comment | yes | yes | Write | `inbox.work` |
| Delete comment | **no** (`agent_cannot_delete`) | yes, `confirm: true` | Destructive | `inbox.manage` |
| Mark handled (batch ≤ 100) | yes | yes | Write | `inbox.work` |
| Report question (Hepsiburada) | yes | yes | Write | `inbox.work` |
| Approve held reply | no (`human_required`) | yes | Write | `inbox.work` |
| Discard held reply | its drafter only | yes | Write | `inbox.work` |
| Open a journey for a commenter/asker | yes (existing `inbox.journeys.open`) | yes | Write | `inbox.work` |
| Take over / hand to agent / snooze / close | existing rules | existing rules | Write | existing |

### 3.9 Compliance and ledger

- **İYS/ETK** (D9). No consent row is read for a public reply; `commercial` is refused there.
- **KVKK.** Public comments are personal data made public by the person; processing for answering them is the
  workspace's (the data controller's) matter; Jeeta minimises what it keeps and erases on request (D10).
  Not legal advice; the owner's counsel decides the lawful basis text.
  - Erasure (`inbox.people.erase`) scrubs messages, identities and payloads as today; public items keep no
    personal text (ids, states, times only); subjects hold the business's own post text and product data.
  - `inbox_mask_personal` (0019) also masks `author`, `provider_item`, `username`, `userName`,
    `customerName` and **string-valued** `message` (Facebook's comment text; WhatsApp's `message` is an
    object and keeps recursing as before).
  - `inbox_event_person` (0019) matches the public envelope's author against the four new namespaces.
  - `erased_identities` hashes use the new namespace names (`instagram_commenter`, …); a later comment by an
    erased commenter is dropped (`erased_identity_drop`), as for DMs.
- **Ledger** (via `inbox::record`): `inbox.reply.queued` (existing, also public), `inbox.public.held`,
  `inbox.public.approved`, `inbox.public.discarded`, `inbox.public.moderated {item_id, action, reason?}`,
  `inbox.public.handled {item_ids, reason}`, `inbox.public.answer_rejected` (system),
  `inbox.public.expired` (system), `inbox.public.deadline_handover` (system),
  `inbox.public.identity_linked` (system). Intake writes no ledger entry (inbound events are records of the
  outside world, as today).

### 3.10 Journeys

- No journey at intake (D4). `Replied` is applied on a public reply's receipt **only if** the person has a
  journey (existing `record_result_in` behaviour): engaging a known lead publicly is contact.
- A private reply answered by DM: the DM path opens the journey with `first_touch` = the comment channel.
- The agent's hint (`work.pending`, `inbox.context.public.hint`): "open a journey when an item shows buying
  intent, then answer privately".

### 3.11 Deadlines and work items

- `inbox.pending` adds `public_due: [{conversation_id, item_id, channel, awaiting_since, deadline}]` and
  `approvals: [{outbox_id, conversation_id, item_id, deadline}]`.
- `work.pending` adds `WorkKind::AnswerDeadline { conversation_id, item_id: Option<PublicItemId>, deadline }`
  (an owed item or Amazon relay conversation due within 24 hours; most urgent first),
  `WorkKind::ApproveReply { outbox_id, conversation_id, deadline: Option<OffsetDateTime> }` (human callers
  only), `WorkKind::EnableComments { capability_id, name }` (the platform flag is on but this Meta
  capability's grant lacks the comment scopes: reconnect).
- The `response_sla` job (no new job) also: (a) uses the oldest owed item's `created_at` for public
  conversations; (b) maps relay mail conversations to the policy key `amazon`; (c) hands an agent-held
  conversation to its owner or the unassigned queue when an owed item's deadline is within
  `DEADLINE_HANDOVER = 2 h` (ledger `inbox.public.deadline_handover`); (d) marks items whose deadline passed
  `Expired` (ledger `inbox.public.expired`).
- `InboxPolicy::default().max_response_s` adds `instagram 3600`, `facebook_page 3600`, `trendyol 3600`,
  `hepsiburada 1800`, `amazon 3600`. Reading a stored policy **merges the defaults key by key** (a stored
  map written before this change lacks the new keys; bug class "stale stored aggregate").

---

## 4. Persistence: `0019_inbox_public`

### 4.1 Up

```sql
-- Public items (comments, marketplace questions), their subjects and poll cursors; held replies; the
-- marketplace providers' events. Repeatable: every statement is guarded.
select set_config('app.platform', 'on', true);

alter table inbound_events drop constraint if exists inbound_events_provider_check;
alter table inbound_events add constraint inbound_events_provider_check
    check (provider in ('meta','netgsm','x','mail','tiktok','trendyol','hepsiburada'));

create table if not exists public_subjects (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    capability_id uuid not null,
    kind text not null check (kind in ('post','product')),
    external_id text not null check (char_length(external_id) between 1 and 512),
    title text not null default '' check (char_length(title) <= 280),
    url text check (url is null or char_length(url) <= 2048),
    image_url text check (image_url is null or char_length(image_url) <= 4096),
    facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
    publication_id uuid,
    first_seen_at timestamptz not null, updated_at timestamptz not null,
    unique (id, workspace_id),
    unique (workspace_id, capability_id, external_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (workspace_id, publication_id) references studio_publications (workspace_id, id)
);

create table if not exists public_items (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    capability_id uuid not null, conversation_id uuid not null, message_id uuid not null,
    subject_id uuid,
    kind text not null check (kind in ('comment','question')),
    external_id text not null check (char_length(external_id) between 1 and 512),
    parent_external_id text, root_external_id text not null,
    created_at timestamptz not null, deadline timestamptz, private_reply_until timestamptz,
    answer jsonb not null check (jsonb_typeof(answer) = 'object' and answer ? 'state'),
    answer_state text generated always as (answer->>'state') stored
        check (answer_state in ('awaiting','pending','answered','rejected','handled','expired')),
    moderation text not null default 'visible'
        check (moderation in ('visible','hidden','deleted','removed','reported')),
    private_reply_message_id uuid,
    agent_replied boolean not null default false,
    checked_at timestamptz, updated_at timestamptz not null,
    unique (id, workspace_id),
    unique (workspace_id, capability_id, external_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (conversation_id, workspace_id) references conversations (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (subject_id, workspace_id) references public_subjects (id, workspace_id),
    foreign key (private_reply_message_id, workspace_id) references messages (id, workspace_id)
);
-- Owed items of a conversation (state derivation, context).
create index if not exists public_items_owed on public_items (workspace_id, conversation_id)
    where answer_state in ('awaiting','rejected') and moderation = 'visible';
-- Deadlines (SLA job, work items).
create index if not exists public_items_deadline on public_items (workspace_id, deadline)
    where deadline is not null and answer_state in ('awaiting','rejected','pending');
-- Threads.
create index if not exists public_items_thread
    on public_items (workspace_id, capability_id, root_external_id, created_at);
-- Reconciliation, least recently checked first (rotation, never pinned to the oldest N).
create index if not exists public_items_reconcile
    on public_items (workspace_id, capability_id, checked_at nulls first, id)
    where answer_state in ('awaiting','rejected','pending');

create table if not exists public_cursors (
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null,
    cursor jsonb not null check (jsonb_typeof(cursor) = 'object'),
    updated_at timestamptz not null,
    primary key (workspace_id, capability_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id)
);

-- Held replies wait for a human's approval; nothing claims them.
alter table outbox drop constraint if exists outbox_state_check;
alter table outbox add constraint outbox_state_check
    check (state in ('queued','sending','sent','failed','unknown','refused','held'));
```

Then: `create or replace function inbox_mask_personal(jsonb)` with the added keys of §3.9 (body copied from
0008, or from 0018 if it changed it); `create or replace function inbox_event_person(...)` with candidate
rows `(p#>>'{public,author,id}', <namespace by p#>>'{public,kind}' and capability kind>)` scoped with
`c.external_id || ':'`; and the three tables' `enable` + `force row level security` + `<table>_ws`
policies in the 0006 form (archtest `sql_scoping`).

The answer is stored as JSON (`AnswerState` serde) with a generated `answer_state` column for indexes; the
generated column is never written by the repository.

### 4.2 Down

Drops `public_items`, `public_subjects`, `public_cursors`; restores the two functions to their previous
bodies. The provider and outbox-state constraints are narrowed **only when no row needs the wider ones**
(`inbound_events` rows are append-only and never deleted; `held` outbox rows may exist): the 0014 pattern
(`do $$ … if not exists (…) then … end if; … $$`). Re-running changes nothing.

### 4.3 Tables and pins

3 new tables: `public_subjects`, `public_items`, `public_cursors` (74 → 77). Migrations 17 → 19 with
0018 merged (18 → 19 if 0018 merges after; whichever lands second renumbers and both carry the union
provider list).

---

## 5. Domain code

### 5.1 `jt_inbox`

- `identity.rs`: the four `Channel` and `IdentityChannel` variants; `Channel::identity_channel`,
  `Channel::is_public`, `public_channel_for_kind`, `conversation_channel`; `normalise` treats the new
  namespaces as opaque.
- `erasure.rs`: namespace names `instagram_commenter`, `facebook_commenter`, `trendyol_buyer`,
  `hepsiburada_buyer`.
- `ids.rs`: `PublicItemId`, `PublicSubjectId`.
- New `public.rs`: the types of §3.3, `rules`, `reply_allowed`, `check_text`, `apply` (§3.4),
  `PublicRefusal` (stable `snake_case` reasons, as listed in §3.6), `ItemTransitionError`.
- New `relay.rs`: `Relay { AmazonTr }`, `marketplace_relay(email_normalized) -> Option<Relay>` (domain
  `marketplace.amazon.com.tr`, V-A1), `amazon_order_id(text) -> Option<String>` (`\d{3}-\d{7}-\d{7}`),
  `RELAY_DEADLINE = 24 h`, `relay_display_name(raw) -> String`, `relay_reply_allowed(text, commercial)`
  (refusals `commercial_on_relay`, `link_in_relay_reply`, §8.4).

### 5.2 `jt_capability`

- `KindGroup::Marketplace` (`"marketplace"`, default reach `Connector`), kinds `trendyol`, `hepsiburada`
  (KINDS 51 → 53).
- `CapabilityKind::default_policy()`: `requires_human_approval: true` for the Marketplace group, else
  `Policy::default()`; used where a capability is first created.

### 5.3 `jt_connector`

- `Provider::Trendyol` (`"trendyol"`, kinds `["trendyol"]`), `Provider::Hepsiburada` (`"hepsiburada"`,
  kinds `["hepsiburada"]`).
- `Credential::TrendyolSeller { seller_id, api_key, api_secret }` (`kind = "trendyol_seller"`, public:
  `seller_id`), `Credential::HepsiburadaMerchant { merchant_id, username, password }`
  (`"hepsiburada_merchant"`, public: `merchant_id`; the exact pair is V-H1). `Debug` masks secrets.
- `EventKind::Comment` (`"comment"`), `EventKind::Question` (`"question"`).
- New `comments.rs`: `CommentGrant { read, reply, hide, delete_others, private_reply }`,
  `comment_grant(kind_key, scopes) -> CommentGrant`, `CommentGrant::enabled() = read && reply`:

| Kind / login | read, reply, hide | delete others' | private reply |
|---|---|---|---|
| `facebook_page` (Page token) | `pages_read_engagement` + `pages_manage_engagement` | + `pages_read_user_content` | `pages_messaging` |
| `instagram` (Facebook Login) | `instagram_manage_comments` (+ `instagram_basic`) | same | + `instagram_manage_messages` |
| `instagram` (Instagram Login) | `instagram_business_manage_comments` | same | + `instagram_business_manage_messages` |

  (The exact permission per Graph call is V-M1; the table is the design's rule and its test.)

---

## 6. Application layer (`jt_app`)

### 6.1 Ports

- `ports/public.rs` (re-exported from `ports::inbox`): `PublicItemRepo` (`insert` → `false` on a replay of
  `(capability, external_id)`, `get`, `lock`, `find_by_external`, `update`, `for_conversation`, `thread`,
  `due_before`, `to_reconcile(capability, limit)` ordered by `checked_at nulls first, id`,
  `mark_checked`, `agent_public_replies_since` for `daily_ops_cap`), `PublicSubjectRepo` (`upsert`, `get`, `find_by_external`), `PublicCursorRepo` (`get`,
  `store`). `TenantRepos` gains `public_items()`, `public_subjects()`, `public_cursors()`.
- `ports/connectors.rs`:

```rust
pub struct PublicTarget { pub kind: PublicKind, pub external_id: String,
    pub parent_external_id: Option<String>, pub subject_external_id: Option<String> }
pub struct PrivateReceipt { pub provider_id: String, pub recipient_id: Option<String> }
pub enum ModerationAction { Hide, Unhide, Delete, Report { reason: ReportReason } }
pub enum ReportReason { Spam, Offensive, PersonalData, Irrelevant, Other }
pub struct SubjectFacts { pub kind: SubjectKind, pub title: String, pub url: Option<String>,
    pub image_url: Option<String>, pub facts: Value }

/// Replies and moderation on public items (comments, marketplace questions).
#[async_trait]
pub trait PublicSurface: Send + Sync {
    async fn reply_public(&self, cred: &Credential, public: &Value, target: &PublicTarget, text: &str)
        -> Result<SendReceipt, ConnectorError>;
    async fn reply_private(&self, cred: &Credential, public: &Value, target: &PublicTarget, text: &str)
        -> Result<PrivateReceipt, ConnectorError> { Err(ConnectorError::permanent("no private replies")) }
    async fn moderate(&self, cred: &Credential, public: &Value, target: &PublicTarget,
        action: ModerationAction) -> Result<(), ConnectorError>;
    async fn subject(&self, cred: &Credential, public: &Value, subject_external_id: &str)
        -> Result<Option<SubjectFacts>, ConnectorError> { Ok(None) }
}
/// Polls public items: new ones from a cursor, and the current state of known ones.
#[async_trait]
pub trait PublicPoller: Send + Sync {
    async fn poll(&self, ws: WorkspaceId, cred: &Credential, public: &Value, cursor: &Value)
        -> Result<(Vec<InboundEventDraft>, Value), ConnectorError>;
    async fn reconcile(&self, cred: &Credential, public: &Value, targets: &[PublicTarget])
        -> Result<Vec<InboundEventDraft>, ConnectorError>;
}
// ConnectorRegistry gains, with default bodies returning None (six implementations exist):
fn public(&self, provider: Provider) -> Option<Arc<dyn PublicSurface>> { None }
fn public_poller(&self, provider: Provider) -> Option<Arc<dyn PublicPoller>> { None }
```

- `MetaApp.comment_scopes: bool`, `InstagramApp.comment_scopes: bool` (env `JEETA_META_COMMENT_SCOPES`,
  `JEETA_INSTAGRAM_COMMENT_SCOPES`; `1`/`true`; default off).
- `CredentialInput::TrendyolSeller` / `HepsiburadaMerchant` for `connector.set_credentials`, normalised like
  the others; for these kinds the capability's external id must equal the credential's seller/merchant id.

### 6.2 `comments_enabled`

`usecases::inbox::public::comments_enabled(cap) = comment_grant(surface_kind(cap.kind_key),
cap.connector_public.access.scopes).enabled()`, `true` for marketplace kinds. `surface_kind` maps a DM
sibling to its surface (`messenger` → `facebook_page`, `instagram_dm` → `instagram`): webhook routing may pick
the sibling (`kinds_of_hint`), and the Page token's grant is the same for both. Used by: the webhook intake
(drops), the consumer (ignores), `comments_poll` (skips), the reply and moderation fences (refuse),
`work.pending` (`EnableComments`), and the panel's capability card (via `connector.health` facts).

### 6.3 The public-item envelope

Adapters store each comment/question as an inbound event of kind `Comment` or `Question` whose payload is:

```json
{ "public": {
    "kind": "comment" | "question",
    "account_id": "<capability external id>",
    "external_id": "...", "parent_external_id": null, "root_external_id": "...",
    "status": "open" | "edited" | "removed" | "answered" | "pending" | "rejected" | "expired" | "reported",
    "author": { "id": "...", "name": "...", "is_self": false },
    "text": "...",
    "created_at": "RFC 3339", "deadline": null,
    "live": false,
    "subject": { "kind": "post" | "product", "external_id": "...", "title": "...", "url": null,
                 "image_url": null, "facts": {} },
    "answer": { "text": "...", "at": "RFC 3339" },
    "rejection": { "reason": "...", "at": "RFC 3339" }
  },
  "provider_item": { "...": "the provider's item as sent" } }
```

`ports::connectors::PublicEnvelope` is the typed form (serde), built by adapters and read by the consumer.
`external_id` of the event (the dedupe key): Meta `comment:<id>`, `comment:<id>:edited:<unix>`,
`comment:<id>:removed`; Trendyol `q:<id>:<status>:<answer or rejection time | "">`; Hepsiburada
`q:<id>:<status>:<time>` — every new provider state is a new event, a replayed state is a duplicate (bug
class "cumulative-snapshot idempotency").

### 6.4 Intake: webhook gate and consumer

- `webhook::receive_for_accounts`: a Meta `Comment` event whose routed capability fails
  `comments_enabled` is `Delivery::Disabled` (new variant): nothing written, counted by the gate
  (`disabled_meta`), warned once per delivery with provider, reason and count only.
- `consumer::route`: for `Comment` events of Meta, the capability is remapped to the **surface sibling**
  (`messenger` → `facebook_page`, `instagram_dm` → `instagram`), mirroring today's DM remap; without a live
  surface capability the event is consumed with outcome `no_surface`. `Comment` and `Question` go to
  `public::intake`:
  1. decode the envelope (malformed → validation error, as `decode` does);
  2. `author.is_self` (or `author.id == account_id`) → own comment: bind to a sending outbound reply of ours
     with the same parent and text (echo binding) or record an outbound `System` message on the parent
     item's conversation; parent → `Answered { Elsewhere }` unless bound; outcome `consumed`;
  3. `status` other than `open`/`edited` → apply to the known item (`answered` → `AnswerConfirmed` when our
     `Pending` text matches, else `AnsweredElsewhere`; `rejected` → `AnswerRejected`; `expired` →
     `Expired`; `removed` → `Removed`; `reported` → `Reported`); unknown item → `deferred` (a later poll
     brings its `open` state first) — questions only; comments without a known item are consumed;
  4. erasure check on the author identity (`erased_identity_drop`);
  5. message dedupe by `(capability, external_id)`; person (`match_or_create`, no journey); subject upsert
     (best-effort `PublicSurface::subject` fetch before the transaction, lock-free, like `sender_name`,
     only when unknown or older than a day); `upsert_on_inbound`; inbound message; `record_inbound_sender`;
     item insert; conversation state derivation (§3.3);
  6. outcome `consumed`.
- A DM echo (`message_echoes`) of a private reply finds no DM conversation: `echo` first looks the `mid` up
  among the messages of the surface sibling capability and answers `duplicate` instead of deferring (else
  every private reply would be abandoned after `DEFERRAL_GIVE_UP` with a ledger line).
- Amazon: `message` for `Provider::Mail` checks `marketplace_relay(sender)`; a relay mail opens **no
  journey** and applies no journey event; everything else as today.

### 6.5 Replies on public conversations

- `ReplyInput` gains `item_id: Option<PublicItemId>` and `visibility: Option<Visibility>`; on a private
  conversation both must be absent (`item_requires_public_conversation`).
- `enqueue_in`: a public conversation skips `recipient()`; its intent is
  `{"kind":"reply","public":{"item_id","visibility","target":PublicTarget,"drafted_by":<actor>}}`; the
  approval rule (§3.7) may write it `held`.
- `claim` re-runs the full fence, including §3.6; `prepare` needs `deps.connectors.public(provider)`.
- `send_step` dispatches by `intent.public.visibility` to `reply_public` / `reply_private`.
- `record_result_in` for public intents, in the same transaction:
  - `Ok`: message external id = the provider id; item `AnswerSent { moderated: rules.moderated }` (public)
    or `PrivateReplySent` (private) and `agent_replied` when by agent; private receipt `recipient_id` →
    identity link (D5); conversation state derivation; `Replied` only if a journey exists.
  - `Permanent` whose reason names a missing object (Graph `(#100)` subcode 33, V-M10; marketplace 404) →
    item `Removed`, outbox `failed` with `item_removed`.
  - `Unknown`: never retried. Comments: bound later by the own-comment echo (§6.4 step 2) or by
    `comments_poll` reconciliation (our text among the item's replies). Questions: reconciliation shows
    our text → `sent`; still waiting with no answer after `UNKNOWN_SETTLE = 15 min` and two reconciliations
    → `failed` with `not_received` (evidence, not a guess) and the item stays owed.
- `inbox.reply` output keeps its shape; `state` may be `held`.

### 6.6 Merges and erasure

- `MergeSnapshot` gains `public_items: Vec<PublicItemParent>` (`#[serde(default)]`, snapshot version 2);
  `apply_snapshot` moves each item to its target conversation before coalesced conversations are deleted;
  `restore_snapshot` moves them back. In-memory fakes mirror it.
- `erasure::event_identities` adds the envelope author in the namespace of its kind and capability.
- `erasure().scrub(person)` needs no new column (items hold no personal text).

### 6.7 Use cases (new)

In `usecases/inbox/public.rs`: `intake`, `comments_enabled`, `settle_state`, `hide`, `delete`,
`mark_handled`, `report`, `approve`, `discard`, `context`, `on_receipt`, `reconcile_unknown`. Each mutating
use case takes the workspace inbox lock first (`people().lock_workspace()`), then conversation → item →
outbox, as the reply path does. Provider I/O (moderation, report) runs **without a transaction**: lock and
check, release, call, then write the result in a second transaction that re-reads the item (compare and
swap on `updated_at`); a lost race is `skipped`, never a double action (bug class "cron-lock pool
starvation": no connection held across provider I/O).

### 6.8 Reads

- `inbox.context` adds `public: Option<PublicContext>`:
  `{ channel, rules, approval_required, hint, items: [{ item, subject, thread: [{author: "us"|"them"|"other",
  text, at, external_id}], private_reply_until, owed }] }` and `relay: Option<{ marketplace: "amazon_tr",
  order_id, deadline, rules }>`.
- `inbox.conversations.list`/`get` answer `ConversationView { #[serde(flatten)] conversation, surface:
  "private"|"public"|"relay", channel, owed_items, next_deadline, held_replies }` (computed; nothing stored).
- `inbox.messages.list` items (`MessageView`) add `item: Option<{item_id, kind, answer_state, visibility}>`.

### 6.9 Jobs

| Job | Interval | Workspaces | What |
|---|---|---|---|
| `marketplace_poll` (new) | 5 min | active, pending payment | per live `trendyol`/`hepsiburada` capability: `poll` from the cursor, then `reconcile` up to 50 items from `to_reconcile`; store drafts with `webhook::store_polled`, cursor and `mark_checked` in the same transaction under the compare-and-swap of `run_mail_inbox_poll`; consume the workspace after |
| `comments_poll` (new) | 1 h | active, pending payment | per Meta surface capability with `comments_enabled`: `poll` (media/posts of the last 7 days whose comment count changed, their comments), `reconcile` items with `Unknown` replies; same storage path |
| `response_sla` (changed) | 1 min | active | §3.11 (a)–(d) |

Job::ALL 28 → 30; scheduler intervals and their test; a throttled provider (`Throttle`) stops that
capability for the run and is logged once.

---

## 7. Catalog

### 7.1 New rows (all twins, all `Gated`, workspace must be active)

| Use case | MCP tool | Route | Risk | Permission | Input |
|---|---|---|---|---|---|
| `inbox.public.hide` | `jeeta.inbox.public_hide` | `POST /api/inbox/items/{item_id}/hide` | Write | `inbox.work` | `{hidden: boolean}` |
| `inbox.public.delete` | `jeeta.inbox.public_delete` | `POST /api/inbox/items/{item_id}/delete` | Destructive | `inbox.manage` | `{confirm: boolean}`; agents refused |
| `inbox.public.mark_handled` | `jeeta.inbox.public_mark_handled` | `POST /api/inbox/items/handled` | Write | `inbox.work` | `{item_ids: uuid[1..100], reason: no_reply_needed\|spam\|duplicate\|answered_elsewhere}` |
| `inbox.public.report` | `jeeta.inbox.public_report` | `POST /api/inbox/items/{item_id}/report` | Write | `inbox.work` | `{reason: spam\|offensive\|personal_data\|irrelevant\|other}` |
| `inbox.public.approve` | `jeeta.inbox.public_approve` | `POST /api/inbox/replies/{outbox_id}/approve` | Write | `inbox.work`, human | `{text: string\|null, request_key: string\|null}` |
| `inbox.public.discard` | `jeeta.inbox.public_discard` | `POST /api/inbox/replies/{outbox_id}/discard` | Write | `inbox.work`; agent: own drafts | `{}` |

Schemas in `usecases/inbox/schema.rs` (`input`/`tool`); `tool` adds `item_id` for hide/delete/report and
`outbox_id` for approve/discard. MCP descriptions name the risk and the approval behaviour.

### 7.2 Changed rows

`inbox.reply` (input `item_id`, `visibility`), `inbox.context`, `inbox.pending`, `inbox.conversations.list`,
`inbox.conversations.get`, `inbox.messages.list` (outputs, §6.8), `connector.set_credentials` (two
credential shapes), `connector.health` (comment grant facts), `work.pending` (§3.11).

### 7.3 Pins that change together

| Pin | From → to |
|---|---|
| `jt_app/tests/catalog.rs` `CATALOG.len()` + the expected-rows table | 169 → 175 |
| `jt_archtest/tests/m4_productisation.rs` `POST_M4_ADDED` (`[_; 15]` → `[_; 21]`) | registry 140 → 146 |
| `jt_archtest/tests/studio_rules.rs` registry / tables | 140 → 146 / 74 → 77 |
| `jt_archtest/tests/twin_rule.rs` `the_registry_holds_140_tools` (rename), `MCP_TOOLS_BY_DOMAIN` inbox | 140 → 146 / 46 → 52 |
| `jt_archtest/tests/twin_rule.rs` `destructive_confirmation_tools_are_explicitly_listed` | + `jeeta.inbox.public_delete` |
| `jt_archtest/tests/inbox_rules.rs`, `gate_rule.rs` inbox rows | 46 → 52 |
| `jt_mcp/tests/inbox_mcp.rs` tools / manage set | 46 → 52 / + `inbox.public.delete` |
| `jt_mcp/tests/billing/m4_billing_mcp.rs` tools | 140 → 146 |
| `jt_pg/tests/migrations.rs` `TABLES_AFTER_ALL`, `MIGRATIONS`, down list | 74 → 77, 17 → 19, + `0019_inbox_public` |
| `jt_app/tests/jobs.rs` names; `bin/jeeta/src/scheduler.rs` intervals test | + `marketplace_poll`, `comments_poll` |
| `jt_capability/tests/rules.rs` `KINDS.len()`, `EXPECTED_KINDS` | 51 → 53, + Marketplace |
| `jt_connector/tests/rules.rs` provider coverage | + 2 providers |
| `jt_outbound` `fixed_hosts_are_exactly_the_documented_set`, `each_connector_reaches_only_its_own_hosts` | + `trendyol` (+ `hepsiburada` after V-H1) |
| `jt_archtest/tests/dependency_boundaries.rs` adapter list | + `jt_marketplace` |
| panel `api/types.ts` kinds and groups | + 2 kinds, 1 group |

---

## 8. Adapters

### 8.1 Meta comments (`jt_meta`)

**Webhooks** (`webhook.rs`, pure): `page` entries' `changes[field = feed]` with `value.item == "comment"`
(`verb` `add` → `open`, `edited` → `edited`, `remove` → `removed`; V-M7) and `instagram` entries'
`changes[field = comments | live_comments]` become `Comment` events with the envelope; `author.is_self`
when `from.id` is the entry id. Everything else stays left out (posts, reactions, shares, visitor posts).
The module's routing/event tables are extended. Origins are entry-level (`change: None`), as for leads.

**Graph calls** (`comments.rs`; every call through `graph_*`/`instagram_*` with `appsecret_proof` rules as
today; a new `graph_delete`):

| Operation | Facebook Login (Page token) | Instagram Login |
|---|---|---|
| reply public (IG) | `POST /{comment-id}/replies` `message` | `POST graph.instagram.com/{comment-id}/replies` |
| reply public (FB) | `POST /{comment-id}/comments` `message` | — |
| private reply | `POST /me/messages` `{recipient: {comment_id}, message: {text}}` (Page token; IG via the linked Page) | `POST graph.instagram.com/me/messages` `{recipient: {comment_id}, …}` |
| hide / unhide | IG `POST /{comment-id}` with `hide` true or false; FB `POST /{comment-id}` with `is_hidden` true or false | IG `POST /{comment-id}` with `hide` |
| delete | `DELETE /{comment-id}` | `DELETE /{comment-id}` |
| subject (IG) | `GET /{media-id}?fields=caption,permalink,media_type,media_product_type,thumbnail_url,media_url,timestamp` | same on graph.instagram.com |
| subject (FB) | `GET /{post-id}?fields=message,permalink_url,full_picture,created_time` | — |
| poll IG | `GET /{ig-user-id}/media?fields=id,timestamp,comments_count&since=` then `GET /{media-id}/comments?fields=id,text,timestamp,username,from,parent_id,replies{…}` | same |
| poll FB | `GET /{page-id}/posts?fields=id,created_time,comments.summary(true).limit(0)&since=` then `GET /{post-id}/comments?filter=stream&fields=id,message,from,created_time,parent` | — |

Exact paths, fields and permissions are V-M1 (checked against Meta's current reference before T2 merges;
the table is updated in the module docs with the source link).

**Scopes and subscription** (`oauth.rs`, `probe.rs`):
- `FACEBOOK_COMMENT_SCOPES = ["instagram_manage_comments", "pages_manage_engagement",
  "pages_read_user_content"]` (defined in `jt_connector::comments` beside `comment_grant`, so the grant rule
  and the request use one list) appended to `FACEBOOK_SCOPES` in the authorize URL only when
  `meta.comment_scopes`; when the app uses a login configuration (`login_config_id`), the configuration in
  Meta's dashboard is what grants them (rollout step, §11). `INSTAGRAM_COMMENT_SCOPES =
  ["instagram_business_manage_comments", "instagram_business_manage_messages"]` appended when
  `instagram.comment_scopes`.
- `on_connected` subscribes a page to the **union** of fields its grant allows: `PAGE_MESSAGING_FIELDS`,
  `leadgen` when `leads_retrieval`, `feed` when `comment_grant(...).enabled()`. Meta replaces the app's
  fields on each call, so every kind on the page computes the same union from the same grant. A refusal
  naming one optional field drops that field and asks again (today's leadgen fallback, generalised); facts
  `{"subscribed": true, "leadgen": bool, "feed": bool}`.
- Instagram Login: `on_connected` for `instagram` with an Instagram Login token and the comment grant
  subscribes `POST graph.instagram.com/me/subscribed_apps?subscribed_fields=comments,live_comments`
  (+ `messages` with the messages scope) (V-M2); facts `{"subscribed": bool}`.
- Instagram Login assets add an `instagram_dm` asset when the grant holds `instagram_business_manage_messages`
  (so a private reply's DM answer has a DM surface), and `send_text` learns the Instagram Login DM send
  (`POST graph.instagram.com/me/messages`; today it refuses an Instagram Login token for DMs).
- Probe facts add `comments: {read, reply, hide, delete_others, private_reply}` (from the grant).
- Error mapping: a Graph "object does not exist" on a comment call is `Permanent` with a reason the use case
  recognises (`item_removed`, V-M10).

**Poller** (`PublicPoller`): cursor `{since, counts: {media_id: n}}` (≤ 7 days of media, at most 50 media
and 25 comment pages per capability per run); `reconcile` lists an item's replies to find our own text.

### 8.2 Trendyol (`jt_marketplace::trendyol`)

- Base `https://apigw.trendyol.com/integration` (V-T1). Auth `Authorization: Basic base64(api_key:api_secret)`.
  `User-Agent: <seller_id> - JeetaGrowth` (the required integrator form, `TRENDYOL_INTEGRATOR =
  "JeetaGrowth"`; whether an integrator registration exists is V-T2).
- List: `GET /qna/sellers/{sellerId}/questions/filter?status=&startDate=&endDate=&page=&size=&orderByField=CreatedDate&orderByDirection=ASC`
  (dates in epoch ms; **window ≤ 14 days**, **size ≤ 50** per the guide; without dates the last week).
  Detail: `GET /qna/sellers/{sellerId}/questions/{id}`. Answer: `POST /qna/sellers/{sellerId}/questions/{id}/answers`
  `{"text": "..."}` (10–2,000 chars).
- Statuses → envelope `status`: `WAITING_FOR_ANSWER` → `open`, `WAITING_FOR_APPROVE` → `pending` (V-T8),
  `ANSWERED` → `answered` (with `answer.text`), `REJECTED` → `rejected` (with the rejected answer and its
  reason), `REPORTED` → `reported`.
- Poll: cursor `{scanned_until_ms}`; first run scans the last 14 days; each run scans
  `[scanned_until − 1 h, min(now, from + 14 d)]` for `WAITING_FOR_ANSWER`, every page (≤ 20 pages per run),
  and advances the cursor only when the window was read to its end. Reconcile: detail by id for the items
  `to_reconcile` returns.
- Probe: one filter call with `size=1` for the seller; `account_id = seller_id` because Trendyol serves the
  seller path only to that seller's key (V-T1 must confirm a key for seller A is refused on seller B's
  path; without that the probe cannot prove the account and the kind stays unverified).
- Errors: 401/403 `Auth`/`Permission`, 429 `Throttle` (`Retry-After`), 5xx `Transient`, an answer POST whose
  response is lost `Unknown`; rate limits V-T3.
- Egress: `host("trendyol", "apigw.trendyol.com")`.

### 8.3 Hepsiburada (`jt_marketplace::hepsiburada`)

Known from the research: "Satıcıya Sor" lists questions by status (1 unanswered, 2 answered, 4 expired),
gives a question's detail, accepts an answer (attachments possible; phase 1 text only), reports an issue
("Sorun Bildirme"), and returns `expireDate` (one business day; a late answer is refused). Hosts, paths,
auth pair, field names, statuses beyond 1/2/4, answer bounds, moderation and rate limits are **all V-H**:
task H0 reads the developer portal by hand (it returns 403 to automated access), records request/response
samples as test fixtures and the facts with their source in the module docs, then H1 builds the same
contract as Trendyol (`Connector`, `PublicPoller`, `PublicSurface` incl. `Report`). The egress host is added
in H1.

### 8.4 Amazon.com.tr (`jt_inbox::relay`, consumer, replies)

- A mail whose sender is `@marketplace.amazon.com.tr` (V-A1) is a buyer message: no journey; the person's
  display name drops the " - Amazon Marketplace" suffix; `inbox.context.relay` gives the order id found in
  subject/body and the 24-hour deadline (from the last inbound mail).
- Replies are ordinary email replies to the relay address (the bound inbound identity). Fence additions:
  `commercial` refused (`commercial_on_relay`); text containing a URL or an email address refused
  (`link_in_relay_reply`; Amazon's buyer-seller messaging rules, V-A3).
- The mailbox must send from the address registered in Seller Central, or Amazon drops the reply (V-A4); the
  panel's mailbox card says so once a relay mail arrived.

---

## 9. Panel (`rust/panel`)

- **Inbox list**: a surface badge per row (DM / Yorum / Soru / Amazon), the channel's logo label, owed item
  count and a deadline countdown (red under 2 h); a queue filter "Onay bekleyenler" fed by
  `inbox.pending.approvals`.
- **Public conversation**: a subject card per item group (post thumbnail, caption excerpt, permalink; product
  image, name, link; Studio hypothesis link when known); items in order with their thread (other people's
  replies greyed), state badges (Bekliyor, Trendyol incelemesinde, Yanıtlandı, Başka yerden yanıtlandı,
  Reddedildi + neden, Yanıt gerekmiyor, Süresi doldu, Gizli, Silindi, Bildirildi) and per-item actions
  (Yanıtla, Gizle/Göster, Sil — manage, typed confirmation —, Yanıt gerekmiyor, Bildir). Per-row pending
  state for every action (bug class "per-row mutation loading").
- **Composer**: target item (default: the oldest owed), Herkese açık / Özel (DM) toggle shown only where the
  surface allows and the window is open ("Özel yanıt hakkı: 6 gün 3 saat, bir kez"), live character count
  with the surface's bounds, the marketplace note ("İletişim bilgisi ve bağlantı yazmayın; Trendyol yanıtı
  yayından önce inceler"), and the approval note when the capability requires approval. Reset on item or
  conversation change (bug class "reused-component stale state"); one request key per draft and the
  pending guard on Enter (bug class "Enter double-submit").
- **Held reply card**: Onayla / Düzenle ve onayla / Vazgeç, the deadline, the drafter.
- **Amazon**: an "Amazon alıcısı" badge, the order id, the 24-hour deadline, the no-links note.
- **Connect page**: Trendyol (Satıcı ID, API Key, API Secret) and Hepsiburada (fields per H0) credential forms;
  on Instagram/Facebook cards a "Yorumlar" line: kapalı (Meta onayı bekleniyor) / yeniden bağlanın / açık.
- TR + EN copy with parity (`i18n/parity.test.ts`).

---

## 10. Tests

| Layer | Where | What |
|---|---|---|
| Pure domain | `jt_inbox/tests/public.rs`, `relay.rs`; `jt_connector/tests/rules.rs`; `jt_capability/tests/rules.rs` | rules table; `reply_allowed` matrix (surface × visibility × agent/human × state × window × deadline); `check_text` bounds and contact fences; every `apply` transition and every refused pair; relay recognizer and order id; `comment_grant` matrix (each login, partial grants); credential redaction and `Debug`; provider coverage; default policy |
| Adapters | `jt_meta/tests/{webhook,comments}.rs`; `jt_marketplace/tests/{trendyol,hepsiburada}.rs` (in-process mock servers, the existing `support` pattern) | signed-body fixtures (feed add/edit/remove, IG comments, live comments, own comment, missing `from`, unknown fields); Graph calls and their bodies; error mapping incl. "object does not exist"; subscription union and per-field fallback; scope flags on/off; Trendyol auth header, User-Agent, 14-day window slicing, paging, 429, every status → envelope, answer bounds, probe |
| Application (fakes) | `jt_app/tests/inbox_public_{intake,reply,moderation,reads,jobs}.rs` | intake (person without journey, identity namespaces, subject, replay, erased drop, own comment, anonymous author, `Disabled` drop when not granted, surface remap); fences (each refusal reason); held → approve (edit) / discard (drafter, other agent refused); receipts (pending/answered/rejected, private-reply identity link and collision → merge suggestion, `Unknown` settle); moderation permissions (agent delete refused); mark handled batch; SLA handover and expiry; work items; DM echo of a private reply is `duplicate`; Amazon relay (no journey, fences) |
| Persistence (Linux CI) | `jt_pg/tests/{migrations,inbox_public}.rs` | up/down/up; RLS on the three tables; `answer_state` generated; merge moves items and undo restores them; erasure masks the envelope (`author`, `provider_item`, string `message`) and `inbox_event_person` finds a commenter's events |
| Gate | `jt_webhook/tests/meta.rs` | a signed comment delivery stored when granted, dropped (`disabled_meta`) when not |
| Twins | `jt_archtest/tests/twin_parity.rs` | each new row answers the same on MCP and HTTP |
| Panel | `Inbox.test.tsx`, `InboxPublic.test.tsx`, `ConnectPage.test.tsx` | badges, countdown, composer modes and bounds, approval actions, per-row pending, i18n parity |
| Smoke | `make smoke-inbox-public` (`jt_app/tests/smoke_inbox_public.rs`) | scripted Meta comment → consumer → context → agent public reply held → human approve → receipt → item answered; Trendyol question → answer → pending → reconcile answered |

---

## 11. Rollout and feature gating

1. **Merge dark.** Everything lands; Meta comments stay inert (D11); `trendyol`/`hepsiburada` can be
   connected by any workspace (credentials are the switch); Amazon relay applies to every mailbox.
2. **Marketplace pilot.** The owner connects his own Trendyol store (and Hepsiburada after H0/H1), watches a
   week of questions with approval on, then decides the default (§15 Q1).
3. **Current Meta review decided** (submitted 2026-10-27). Until then: no change to the live app's
   permissions, login configuration, webhook fields, or to the staging instance the reviewers use (the
   review's webhook points at staging); no comment-scope flag set anywhere the reviewers sign in.
4. **New Meta App Review**: `instagram_manage_comments`, `pages_manage_engagement`, `pages_read_user_content`
   (Facebook Login) and `instagram_business_manage_comments`, `instagram_business_manage_messages`
   (Instagram Login), with screencasts recorded on staging with the flags on **after step 3**, or earlier
   with a Meta test app on a separate instance.
5. **After approval**: add webhook fields (Page `feed`; Instagram `comments`, `live_comments`) in the app
   dashboard; add the permissions to the Facebook Login for Business configuration when one is used; set
   `JEETA_META_COMMENT_SCOPES=1` and `JEETA_INSTAGRAM_COMMENT_SCOPES=1`; deploy.
6. **Owners reconnect** (work item `EnableComments`); each reconnection's grant enables its capability,
   `on_connected` subscribes `feed`, `comments_poll` imports the last 7 days.

A kill switch per account is the capability's retirement or its `daily_ops_cap: 0` (agent public replies
stop; humans can still act).

---

## 12. To verify live (owner accounts on staging unless noted)

| Id | What | Blocks |
|---|---|---|
| V-M1 | Every Graph path, field and permission of §8.1 against Meta's current reference | M2 merge |
| V-M2 | Instagram Login per-account `subscribed_apps` fields for comments | M3 |
| V-M3 | Whether an IG comment `from.id` equals the DM IGSID of the same person and account | M4b (optional) |
| V-M4 | Whether Facebook feed webhooks carry `from` for ordinary users | intake fallback |
| V-M5 | Private-reply response carries `recipient_id` (IG and FB) | identity link |
| V-M6 | Studio's stored post id format equals the webhook's `media.id` / `post_id` | subject link |
| V-M7 | Facebook `verb` values for edits/removals/hides | parser |
| V-M8 | Length limits: IG comment, IG DM, FB comment | rules constants |
| V-M9 | Live comments: public reply impossible, private reply window | rules |
| V-M10 | Graph error for a deleted comment | error mapping |
| V-T1 | Trendyol base URL; a key for seller A refused on seller B's path | T1 probe |
| V-T2 | Integrator registration for the User-Agent | T1 |
| V-T3 | Trendyol rate limits | T2 budgets |
| V-T4 | `customerId` present and stable per buyer | identity |
| V-T5 | A Trendyol question report endpoint | rules |
| V-T6 | Any Trendyol answer deadline | rules |
| V-T7 | Trendyol review refuses contact data/links | fence wording |
| V-T8 | `WAITING_FOR_APPROVE` status exists and means "answer in review" | status map |
| V-H1–H4 | Hepsiburada hosts, paths, auth pair, fields, statuses, bounds, moderation, report reasons, rate limits | H1 |
| V-A1 | Relay sender domain for amazon.com.tr | A1 |
| V-A2 | Relay display-name format | A1 |
| V-A3 | Amazon's current link/contact rules for buyer-seller messages | A1 fence |
| V-A4 | Replies accepted only from the Seller Central address | A1 note |

---

## 13. Later phases (sketches, each with its gate)

- **WhatsApp Coexistence (phase 2).** Rust has no Embedded Signup flow today (`whatsapp_config_id` is read
  from the environment and used nowhere); build ES v4+ (popup, `waba_id`/`phone_number_id` exchange),
  subscribe `history`, `smb_message_echoes`, `smb_app_state_sync`; echoes become outbound `System` messages
  (the business app's sends), history imports as messages without journey events, a per-number monthly
  service-message counter feeds budget metering (1,000 free). Onboarding copy: messages sent from WhatsApp
  for Windows do not reach the API. Gate: Meta Tech Provider/Solution Partner status; a Turkish pilot number
  proves Coexistence works in Türkiye.
- **n11 and Çiçeksepeti (phase 2).** `jt_marketplace` modules, providers `n11`, `ciceksepeti`, channels
  `N11Question`, `CiceksepetiQuestion`; n11 SOAP `GetProductQuestionList` (1 call/min: poll ≥ 2 min) and the
  one-shot `SaveProductAnswerRequest` (1–2,048 chars) — the kind's default policy forces approval;
  Çiçeksepeti's private answer maps to `Visibility::Private`. Gate: sellers' keys; endpoint verification.
- **X DMs and mentions (phase 2).** Scopes `dm.read`, `dm.write` (re-consent of every X connection); poll
  `/2/dm_events` (30-day window) per account (Account Activity's 3 subscriptions do not scale); channels
  `XDm` (private, window rules per X) and `XMention` (public item, reply = a reply post); metering per call
  into the unified credit wallet ($0.010 read, $0.015 send, $0.20 reply with URL); XChat's encrypted events
  are out. Gate: X credit and the re-consent.
- **TikTok DMs and comments (phase 3).** A separate TikTok API for Business app (business-api.tiktok.com:
  its own host, credentials and egress scope, provider `tiktok_business`); comments of own videos (list,
  reply, hide, delete) as `TiktokComment` items; Business Messaging DMs as `TiktokDm` with the 48-hour,
  10-consecutive-messages rule as a window fence, text only in Türkiye; webhooks at-least-once at
  `/hooks/tiktok-business` with the same dedupe. Gate: data security & privacy review, Accounts API comment
  scopes, per-account Advanced Access; portal facts verified in a browser.
- **YouTube comments (phase 3).** New `jt_google` adapter (OAuth `youtube.force-ssl`), `commentThreads.list`
  by channel (1 unit) polled, `comments.insert` and `setModerationStatus` (50 units), a platform-wide daily
  quota ledger (10,000 units shared by all tenants); `YoutubeComment` items. Gate: Google OAuth verification
  of the scope and a quota increase audit.
- **Google Business Profile reviews (phase 3).** Same `jt_google`; serves the existing `review_google` kind;
  reviews as public items of a new `Review` kind (one reply per review, editable); no chat or Q&A (both
  closed). Gate: the GBP API access form (profile verified for more than 60 days, website listed).
- **LinkedIn page comments (phase 4).** Add `r_organization_social_feed`, `w_organization_social_feed` to
  `ORGANIZATION_SCOPES` behind the existing `JEETA_LINKEDIN_ORG_SCOPES`; Organization Social Action
  Notifications webhook (PUBLIC posts only) plus the 60-day pull; `LinkedinComment` items on `linkedin_page`.
  Gate: Community Management API approval (identity vetting failed in July 2026; appeal pending).
- **Facebook recommendations (phase 2).** Serves the existing `review_facebook` kind: the Page `ratings` edge
  and its webhook field, replies as comments on the recommendation; `FacebookReview` items. Gate: the same
  review as comments plus `pages_read_user_content`.
- **Instagram mentions (phase 2).** The `mentions` field; reply through `/{ig-user-id}/mentions`;
  `InstagramMention` items. Gate: the comments review (same permission).
- **HUMAN_AGENT (phase 2).** A human-only send path that extends the Messenger/Instagram DM window to 7 days
  with the `HUMAN_AGENT` tag; never for agent sends. Gate: Meta's separate HUMAN_AGENT application.
- **Attachments in answers (phase 2).** Hepsiburada's file answers through Jeeta files. Gate: H0 facts.
- **Phone fallback (phase 4, device bridge playbooks).** For LinkedIn DMs, Sahibinden/Armut/Emlakjet
  replies, WhatsApp Status/Channels/large groups, Facebook Groups and personal profiles: the agent uses the
  existing device tools (`jeeta.devices.observe/act`, every command logged) under a written playbook per
  platform; inbound comes from notification mail/SMS parsers where the platform sends them (IMAP, NetGSM)
  or from the agent reading the app; the conversation is kept with a new `inbox.messages.record` (manual
  inbound/outbound record on an `Unofficial { platform }` channel, labelled "resmi olmayan kanal" in the
  panel). Rules: replies to inbound only, human pace, no cold DMs, no invitations, never beyond a platform's
  reply window; the tenant's written consent is the phone capability's evidence. Gate: the owner's decision
  per platform and the tenant's consent (LinkedIn User Agreement §8.2 forbids automated messaging; the risk
  is the tenant's account).

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Merge/coalesce breaks with items pointing at a deleted conversation | items in the merge snapshot; persistence tests for apply and undo (§6.6) |
| A comment flood on a viral post fills the agent queue | batch `mark_handled`; hidden items not owed; `daily_ops_cap` |
| Wasted one-shot marketplace answers | approval on by default for marketplace kinds; contact/link fence; bounds |
| Meta review disturbed | D11 and §11 step 3: no scope, config, field or staging change before the decision |
| Hepsiburada facts wrong | H0 verification before any HB code; the HB answer path refuses until then |
| Trendyol key not bound to the seller path | V-T1 before the kind can be verified |
| Erased commenter's new public complaint is dropped | documented (D10); the platform still shows it; the owner can re-add the person explicitly |
| Thumbnails expire | permalink always shown; `comments_poll` refreshes subjects older than a day |

---

## 15. Open questions for the owner

1. **Default approval.** This design holds agent answers for approval on marketplace capabilities by default
   and lets agent comment replies go out unless the Instagram/Facebook capability's existing "requires human
   approval" is on (the same flag also holds Studio posts on that account). Keep these defaults?
2. **Hepsiburada access.** H0 needs someone to read Hepsiburada's developer portal (it refuses automated
   access) and a merchant API credential (yours or a pilot seller's) for the live checks. Who provides them?
