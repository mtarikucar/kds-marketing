//! Public items: one comment on a post, or one customer question on a marketplace product, the
//! unit of work of a public conversation (spec 2026-10-30-inbox-comments-marketplace-design.md
//! §3.3–§3.6). A conversation stays one person on one capability; each of their comments (or
//! questions) is an item with its own reply target, thread, window, deadline and answer state.
//!
//! Here, pure: the rules per surface ([`rules`]), the reply fence over an item
//! ([`reply_allowed`]) and over a text ([`check_text`]), the item lifecycle ([`apply`]) and the
//! conversation state the owed items imply ([`derived_state`]).
//!
//! Provider limits that are not verified yet are named constants whose doc names their
//! verification id (spec §12); a constant set from a provider's documentation cites it.

use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Duration, OffsetDateTime};

use crate::{
    Channel, ConvState, ConversationId, EventSource, MessageId, PublicItemId, PublicSubjectId,
    epoch,
};

/// What a public item is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicKind {
    /// A comment on a post (Instagram, Facebook).
    Comment,
    /// A customer question on a product (Trendyol, Hepsiburada).
    Question,
}

/// Where an item's answer stands. Stored as JSON tagged by `state`; migration
/// `0019_inbox_public` derives its `answer_state` column from that tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AnswerState {
    /// Owed an answer.
    Awaiting,
    /// Our answer is in the platform's review before it is published (Trendyol).
    Pending {
        /// Our outbound answer.
        message_id: MessageId,
    },
    /// Answered, by us or outside Jeeta.
    Answered {
        /// Who answered.
        by: AnsweredBy,
        /// The answer's message, when Jeeta holds one; missing reads as `None`.
        #[serde(default)]
        message_id: Option<MessageId>,
        /// When the answer was seen.
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
    /// The platform refused our answer: owed again.
    Rejected {
        /// The platform's reason, as it gave it.
        reason: String,
        /// When the refusal was seen.
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
    /// Settled without a reply (`inbox.public.mark_handled`).
    Handled {
        /// Who settled it.
        by: EventSource,
        /// Why no reply is needed.
        reason: HandledReason,
        /// When it was settled.
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
    /// Its deadline passed unanswered, or the platform says it expired.
    Expired {
        /// When it was seen expired.
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
}

impl AnswerState {
    /// The `state` tag: `"awaiting"`, `"pending"`, `"answered"`, `"rejected"`, `"handled"` or
    /// `"expired"`; the values of 0019's `answer_state` column.
    pub fn key(&self) -> &'static str {
        match self {
            AnswerState::Awaiting => "awaiting",
            AnswerState::Pending { .. } => "pending",
            AnswerState::Answered { .. } => "answered",
            AnswerState::Rejected { .. } => "rejected",
            AnswerState::Handled { .. } => "handled",
            AnswerState::Expired { .. } => "expired",
        }
    }
}

/// Who answered an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnsweredBy {
    /// Jeeta, through its outbox.
    Us,
    /// Outside Jeeta: the platform's own app, or the platform's own assistant.
    Elsewhere,
}

/// Whether an item is shown on its platform. Independent of its answer state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Moderation {
    /// Shown; the storage default.
    #[default]
    Visible,
    /// Hidden by us; reversible, and not owed while hidden.
    Hidden,
    /// Deleted by us.
    Deleted,
    /// Removed by its author or by the platform.
    Removed,
    /// Reported by us to the marketplace.
    Reported,
}

impl Moderation {
    /// The stable key, e.g. `"hidden"`; also what serde writes and 0019's `moderation` column.
    pub fn key(self) -> &'static str {
        match self {
            Moderation::Visible => "visible",
            Moderation::Hidden => "hidden",
            Moderation::Deleted => "deleted",
            Moderation::Removed => "removed",
            Moderation::Reported => "reported",
        }
    }

    /// The moderation with this key (exact, case-sensitive), if any.
    pub fn from_key(key: &str) -> Option<Moderation> {
        [
            Moderation::Visible,
            Moderation::Hidden,
            Moderation::Deleted,
            Moderation::Removed,
            Moderation::Reported,
        ]
        .into_iter()
        .find(|m| m.key() == key)
    }
}

/// Why an item needs no reply: the reasons `inbox.public.mark_handled` takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandledReason {
    /// Nothing to answer (a thank-you, an emoji).
    NoReplyNeeded,
    /// Spam.
    Spam,
    /// The same as another item.
    Duplicate,
    /// Answered somewhere Jeeta does not see.
    AnsweredElsewhere,
}

/// Where a reply to an item goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// Under the item, in front of everyone; the default.
    #[default]
    Public,
    /// To the item's author privately (Instagram's and Facebook's private reply).
    Private,
}

/// What a subject is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    /// A post (Instagram media, a Facebook Page post).
    Post,
    /// A marketplace product.
    Product,
}

/// One comment or one question (spec §3.3).
///
/// Stored, so reading is tolerant: an unknown field is ignored and a missing field reads as the
/// default named on it, except the identity and relationship fields and the answer, the item's
/// state, which are never invented.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicItem {
    /// The item's id.
    pub id: PublicItemId,
    /// The tenant that owns the item.
    pub workspace_id: WorkspaceId,
    /// The capability whose post or product it is on.
    pub capability_id: CapabilityId,
    /// The author's conversation on that capability.
    pub conversation_id: ConversationId,
    /// The inbound message: the latest revision after an edit.
    pub message_id: MessageId,
    /// The post or product, once known; missing reads as `None`.
    #[serde(default)]
    pub subject_id: Option<PublicSubjectId>,
    /// A comment or a question.
    pub kind: PublicKind,
    /// The provider's comment or question id: the reply target.
    pub external_id: String,
    /// The comment it answers; `None` at the top level. Missing reads as `None`.
    #[serde(default)]
    pub parent_external_id: Option<String>,
    /// The thread's top-level comment: itself at the top level.
    pub root_external_id: String,
    /// When the provider says it was written; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// The provider's answer deadline, when it gives one; missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub deadline: Option<OffsetDateTime>,
    /// Until when one private reply may be sent, on a surface that allows one; missing reads as
    /// `None` (no private reply).
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub private_reply_until: Option<OffsetDateTime>,
    /// Where its answer stands; required.
    pub answer: AnswerState,
    /// Whether it is shown; missing reads as `Visible`.
    #[serde(default)]
    pub moderation: Moderation,
    /// The private reply sent, if one was; missing reads as `None`.
    #[serde(default)]
    pub private_reply_message_id: Option<MessageId>,
    /// Whether the agent has replied publicly (the agent replies once per item); missing reads
    /// as `false`.
    #[serde(default)]
    pub agent_replied: bool,
    /// The last reconciliation against the provider; missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub checked_at: Option<OffsetDateTime>,
    /// The last change; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

impl PublicItem {
    /// Owed a reply: `Awaiting` or `Rejected`, and `Visible`.
    pub fn awaiting(&self) -> bool {
        matches!(
            self.answer,
            AnswerState::Awaiting | AnswerState::Rejected { .. }
        ) && self.moderation == Moderation::Visible
    }
}

/// The longest subject title kept, in characters: a caption excerpt or a product name.
pub const MAX_SUBJECT_TITLE_CHARS: usize = 280;

/// The post or product items are about, unique per capability and external id (spec §3.3).
///
/// Stored, so reading is tolerant: an unknown field is ignored and a missing field reads as the
/// default named on it, except the identity fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicSubject {
    /// The subject's id.
    pub id: PublicSubjectId,
    /// The tenant that owns it.
    pub workspace_id: WorkspaceId,
    /// The capability whose post or product it is.
    pub capability_id: CapabilityId,
    /// A post or a product.
    pub kind: SubjectKind,
    /// The provider's post (media) or product id.
    pub external_id: String,
    /// A caption excerpt or the product's name, at most [`MAX_SUBJECT_TITLE_CHARS`]
    /// characters; missing reads as empty.
    #[serde(default)]
    pub title: String,
    /// Its permalink; missing reads as `None`.
    #[serde(default)]
    pub url: Option<String>,
    /// A thumbnail on the provider's CDN, which may expire; missing reads as `None`.
    #[serde(default)]
    pub image_url: Option<String>,
    /// Further provider facts (media product type, barcode, ...); missing reads as `{}`.
    #[serde(default = "empty_object")]
    pub facts: Value,
    /// The Studio publication that made the post, when one did; missing reads as `None`.
    #[serde(default)]
    pub publication_id: Option<uuid::Uuid>,
    /// When it was first seen; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub first_seen_at: OffsetDateTime,
    /// The last refresh; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// How long a reply's text may be, in characters, both ends included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextBounds {
    /// The fewest characters, not counting leading and trailing whitespace.
    pub min: usize,
    /// The most characters.
    pub max: usize,
}

/// The private reply a surface allows: once per item, within `window` of the item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrivateRule {
    /// From the item's `created_at`.
    pub window: Duration,
    /// The longest private reply, in characters.
    pub max_chars: usize,
}

/// What a surface allows (spec §3.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicRules {
    /// The public reply's bounds; `None` while they are not verified (no public reply then).
    pub public: Option<TextBounds>,
    /// The private reply, on a surface that has one.
    pub private: Option<PrivateRule>,
    /// Whether an item takes one answer only.
    pub one_answer: bool,
    /// Whether the platform reviews an answer before it is published.
    pub moderated: bool,
    /// Whether an item can be hidden.
    pub hide: bool,
    /// Whether an item can be deleted.
    pub delete: bool,
    /// Whether an item can be reported.
    pub report: bool,
    /// Whether it is a marketplace (no link or contact data in an answer).
    pub marketplace: bool,
}

/// The longest Instagram comment reply. VERIFY V-M8 (spec §12): re-read Meta's reference before
/// task M2 merges.
pub const INSTAGRAM_COMMENT_MAX: usize = 2_200;
/// The longest Instagram private reply. VERIFY V-M8 (spec §12).
pub const INSTAGRAM_PRIVATE_MAX: usize = 1_000;
/// The longest Facebook comment reply. VERIFY V-M8 (spec §12).
pub const FACEBOOK_COMMENT_MAX: usize = 8_000;
/// The longest Facebook private reply: a Messenger text, as the Meta adapter bounds it
/// (`MAX_MESSENGER_TEXT` in `jt_meta::messaging`).
pub const FACEBOOK_PRIVATE_MAX: usize = 2_000;
/// A Trendyol answer's bounds, as documented for answering a question
/// (<https://developers.trendyol.com/reference/answerquestion.md>).
pub const TRENDYOL_ANSWER: TextBounds = TextBounds {
    min: 10,
    max: 2_000,
};
/// A Hepsiburada answer's bounds: unknown until task H0 reads them from Hepsiburada's developer
/// portal (VERIFY V-H3, spec §12); until then no Hepsiburada answer is sent
/// ([`PublicRefusal::HepsiburadaUnverified`]).
pub const HEPSIBURADA_ANSWER_BOUNDS: Option<TextBounds> = None;
/// Whether Hepsiburada reviews an answer before publishing it. VERIFY V-H4 (spec §12): until H0
/// says, an answer waits as pending until a poll shows it answered.
pub const HEPSIBURADA_MODERATED: bool = true;
/// How long after a comment one private reply may be sent. VERIFY V-M8 (spec §12).
pub const PRIVATE_REPLY_WINDOW: Duration = Duration::days(7);

/// What `channel` allows; `None` for a private channel.
pub fn rules(channel: Channel) -> Option<PublicRules> {
    let comment = |public_max, private_max| PublicRules {
        public: Some(TextBounds {
            min: 1,
            max: public_max,
        }),
        private: Some(PrivateRule {
            window: PRIVATE_REPLY_WINDOW,
            max_chars: private_max,
        }),
        one_answer: false,
        moderated: false,
        hide: true,
        delete: true,
        report: false,
        marketplace: false,
    };
    Some(match channel {
        Channel::InstagramComment => comment(INSTAGRAM_COMMENT_MAX, INSTAGRAM_PRIVATE_MAX),
        Channel::FacebookComment => comment(FACEBOOK_COMMENT_MAX, FACEBOOK_PRIVATE_MAX),
        // Whether a Trendyol question can be reported is VERIFY V-T5 (spec §12): not until then.
        Channel::TrendyolQuestion => PublicRules {
            public: Some(TRENDYOL_ANSWER),
            private: None,
            one_answer: true,
            moderated: true,
            hide: false,
            delete: false,
            report: false,
            marketplace: true,
        },
        Channel::HepsiburadaQuestion => PublicRules {
            public: HEPSIBURADA_ANSWER_BOUNDS,
            private: None,
            one_answer: true,
            moderated: HEPSIBURADA_MODERATED,
            hide: false,
            delete: false,
            report: true,
            marketplace: true,
        },
        Channel::WhatsApp
        | Channel::InstagramDm
        | Channel::Messenger
        | Channel::Sms
        | Channel::Email
        | Channel::Webchat
        | Channel::Phone => return None,
    })
}

/// Stable reasons a reply on a public conversation is refused (spec §3.6). `Display` and serde
/// give the `snake_case` key, e.g. `"private_window_closed"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum PublicRefusal {
    /// A reply on a public conversation names no item.
    #[error("item_required")]
    ItemRequired,
    /// The item is another conversation's.
    #[error("item_not_in_conversation")]
    ItemNotInConversation,
    /// The item was deleted or removed.
    #[error("item_removed")]
    ItemRemoved,
    /// The item expired or its deadline passed.
    #[error("deadline_passed")]
    DeadlinePassed,
    /// A one-answer item is answered, or its answer is in review.
    #[error("already_answered")]
    AlreadyAnswered,
    /// The agent replied publicly to this item already.
    #[error("agent_already_replied")]
    AgentAlreadyReplied,
    /// The agent replies only to an owed item.
    #[error("item_not_owed")]
    ItemNotOwed,
    /// The surface has no private reply.
    #[error("private_reply_unsupported")]
    PrivateReplyUnsupported,
    /// The private reply window closed.
    #[error("private_window_closed")]
    PrivateWindowClosed,
    /// The one private reply was sent already.
    #[error("private_reply_used")]
    PrivateReplyUsed,
    /// The text is shorter than the surface allows.
    #[error("text_too_short")]
    TextTooShort,
    /// The text is longer than the surface allows.
    #[error("text_too_long")]
    TextTooLong,
    /// A public reply repeats the person's own phone number or email address.
    #[error("contact_data_in_public_reply")]
    ContactDataInPublicReply,
    /// A marketplace answer holds a link, an email address or a phone number.
    #[error("contact_data_in_marketplace_answer")]
    ContactDataInMarketplaceAnswer,
    /// Commercial intent on a public surface.
    #[error("commercial_on_public_surface")]
    CommercialOnPublicSurface,
    /// The capability's grant does not hold the comment permissions.
    #[error("comments_not_enabled")]
    CommentsNotEnabled,
    /// Hepsiburada's answer rules are not verified yet (task H0).
    #[error("hepsiburada_unverified")]
    HepsiburadaUnverified,
}

/// Whether a reply of `visibility` may go to `item` now (spec §3.6 rule 4), by the agent when
/// `by_agent`: a deleted or removed item takes none; a public reply needs verified bounds, an
/// unexpired item before its deadline, a one-answer item not answered or in review, and from
/// the agent an owed item it has not replied to; a private reply needs a surface that has one,
/// its window open and none sent. A human may reply publicly again on a comment.
pub fn reply_allowed(
    item: &PublicItem,
    rules: &PublicRules,
    visibility: Visibility,
    by_agent: bool,
    now: OffsetDateTime,
) -> Result<(), PublicRefusal> {
    if matches!(item.moderation, Moderation::Deleted | Moderation::Removed) {
        return Err(PublicRefusal::ItemRemoved);
    }
    match visibility {
        Visibility::Public => {
            if rules.public.is_none() {
                return Err(PublicRefusal::HepsiburadaUnverified);
            }
            if matches!(item.answer, AnswerState::Expired { .. })
                || item.deadline.is_some_and(|deadline| now > deadline)
            {
                return Err(PublicRefusal::DeadlinePassed);
            }
            if rules.one_answer
                && matches!(
                    item.answer,
                    AnswerState::Pending { .. } | AnswerState::Answered { .. }
                )
            {
                return Err(PublicRefusal::AlreadyAnswered);
            }
            if by_agent && item.agent_replied {
                return Err(PublicRefusal::AgentAlreadyReplied);
            }
            if by_agent && !item.awaiting() {
                return Err(PublicRefusal::ItemNotOwed);
            }
        }
        Visibility::Private => {
            if rules.private.is_none() {
                return Err(PublicRefusal::PrivateReplyUnsupported);
            }
            if item.private_reply_until.is_none_or(|until| now > until) {
                return Err(PublicRefusal::PrivateWindowClosed);
            }
            if item.private_reply_message_id.is_some() {
                return Err(PublicRefusal::PrivateReplyUsed);
            }
        }
    }
    Ok(())
}

/// Whether `text` may be sent as a reply of `visibility` under `rules` (spec §3.6 rule 5):
/// within the surface's bounds (characters; the minimum not counting leading and trailing
/// whitespace); a public reply never repeats one of `person_contacts` (the person's own
/// normalised email addresses and E.164 phone numbers), however the text writes it; a
/// marketplace answer holds no link, email address or phone-number-like run of ten or more
/// digits at all. A private reply is checked for its bounds only.
pub fn check_text(
    rules: &PublicRules,
    visibility: Visibility,
    text: &str,
    person_contacts: &[String],
) -> Result<(), PublicRefusal> {
    let bounds = match visibility {
        Visibility::Public => rules.public.ok_or(PublicRefusal::HepsiburadaUnverified)?,
        Visibility::Private => {
            let private = rules
                .private
                .ok_or(PublicRefusal::PrivateReplyUnsupported)?;
            TextBounds {
                min: 1,
                max: private.max_chars,
            }
        }
    };
    if text.trim().chars().count() < bounds.min {
        return Err(PublicRefusal::TextTooShort);
    }
    if text.chars().count() > bounds.max {
        return Err(PublicRefusal::TextTooLong);
    }
    if visibility == Visibility::Private {
        return Ok(());
    }
    if person_contacts
        .iter()
        .any(|contact| repeats_contact(text, contact))
    {
        return Err(PublicRefusal::ContactDataInPublicReply);
    }
    if rules.marketplace
        && (has_link(text) || has_email(text) || digit_runs(text).any(|run| run.len() >= 10))
    {
        return Err(PublicRefusal::ContactDataInMarketplaceAnswer);
    }
    Ok(())
}

/// Whether `text` repeats `contact`: an email address anywhere, case-insensitively; a phone
/// number as a run of digits holding its last ten digits (its national number for `+90`), so
/// that spaces, dashes, dots, brackets, a leading `0` or a country code do not hide it.
fn repeats_contact(text: &str, contact: &str) -> bool {
    if contact.contains('@') {
        return text.to_lowercase().contains(&contact.to_lowercase());
    }
    let digits: String = contact.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 7 {
        return false;
    }
    let national = &digits[digits.len().saturating_sub(10)..];
    digit_runs(text).any(|run| run.contains(national))
}

/// The digits of each phone-like run in `text`: ASCII digits joined by spaces, dashes, dots,
/// brackets or a plus sign; any other character ends a run.
pub(crate) fn digit_runs(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !(c.is_ascii_digit() || matches!(c, ' ' | '-' | '.' | '(' | ')' | '+')))
        .map(|run| run.chars().filter(char::is_ascii_digit).collect::<String>())
        .filter(|digits| !digits.is_empty())
}

/// Whether `text` holds a web link: `http://`, `https://` or `www.`, in any case.
pub(crate) fn has_link(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["http://", "https://", "www."]
        .iter()
        .any(|marker| lower.contains(marker))
}

/// Whether `text` holds something shaped like an email address: a word with an `@` that has
/// something before it and a dot somewhere after it.
pub(crate) fn has_email(text: &str) -> bool {
    text.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | ',' | ';' | '"' | '\''))
        .any(|word| {
            word.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && domain
                        .trim_end_matches(['.', ')', '!', '?', ':'])
                        .split_once('.')
                        .is_some_and(|(host, tld)| !host.is_empty() && !tld.is_empty())
            })
        })
}

/// What happens to an item (spec §3.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemEvent {
    /// Our public reply or answer was received by the platform.
    AnswerSent {
        /// Our outbound message.
        message_id: MessageId,
        /// Whether the platform reviews it first ([`PublicRules::moderated`]).
        moderated: bool,
    },
    /// The platform shows our answer published.
    AnswerConfirmed,
    /// The platform refused our answer.
    AnswerRejected {
        /// The platform's reason.
        reason: String,
    },
    /// Answered outside Jeeta.
    AnsweredElsewhere {
        /// The answer's message, when Jeeta recorded one.
        message_id: Option<MessageId>,
    },
    /// Settled without a reply.
    MarkedHandled {
        /// Who settled it.
        by: EventSource,
        /// Why.
        reason: HandledReason,
    },
    /// Its deadline passed, or the platform says it expired.
    Expired,
    /// Hidden by us.
    Hidden,
    /// Shown again by us.
    Unhidden,
    /// Deleted by us.
    Deleted,
    /// Removed by its author or the platform.
    Removed,
    /// Reported by us.
    Reported,
    /// Our private reply was received by the platform.
    PrivateReplySent {
        /// Our outbound private message.
        message_id: MessageId,
    },
}

impl ItemEvent {
    /// The stable key, e.g. `"answer_sent"`.
    pub fn key(&self) -> &'static str {
        match self {
            ItemEvent::AnswerSent { .. } => "answer_sent",
            ItemEvent::AnswerConfirmed => "answer_confirmed",
            ItemEvent::AnswerRejected { .. } => "answer_rejected",
            ItemEvent::AnsweredElsewhere { .. } => "answered_elsewhere",
            ItemEvent::MarkedHandled { .. } => "marked_handled",
            ItemEvent::Expired => "expired",
            ItemEvent::Hidden => "hidden",
            ItemEvent::Unhidden => "unhidden",
            ItemEvent::Deleted => "deleted",
            ItemEvent::Removed => "removed",
            ItemEvent::Reported => "reported",
            ItemEvent::PrivateReplySent { .. } => "private_reply_sent",
        }
    }
}

/// An event the item cannot take in its state: nothing is written. `from` is the answer state's
/// key for an answer event, the moderation's key for a moderation event, and
/// `"private_reply_used"` or `"private_window_closed"` for a private reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{from} cannot take {event}")]
pub struct ItemTransitionError {
    /// The state it was in.
    pub from: &'static str,
    /// The event's key.
    pub event: &'static str,
}

/// The item after `event` at `at` (spec §3.4), with `updated_at = at`; any pair the table does
/// not list is an [`ItemTransitionError`]. Answer events move the answer state only, moderation
/// events the moderation only; a private reply sets `private_reply_message_id` once, while the
/// window is open. `agent_replied` is the caller's to set.
pub fn apply(
    item: &PublicItem,
    event: ItemEvent,
    at: OffsetDateTime,
) -> Result<PublicItem, ItemTransitionError> {
    let refuse = |from: &'static str| ItemTransitionError {
        from,
        event: event.key(),
    };
    let answer_from = |allowed: fn(&AnswerState) -> bool| {
        if allowed(&item.answer) {
            Ok(())
        } else {
            Err(refuse(item.answer.key()))
        }
    };
    let moderation_from = |allowed: &[Moderation]| {
        if allowed.contains(&item.moderation) {
            Ok(())
        } else {
            Err(refuse(item.moderation.key()))
        }
    };
    let owed = |a: &AnswerState| matches!(a, AnswerState::Awaiting | AnswerState::Rejected { .. });
    let mut next = item.clone();
    match &event {
        ItemEvent::AnswerSent {
            message_id,
            moderated,
        } => {
            answer_from(owed)?;
            next.answer = if *moderated {
                AnswerState::Pending {
                    message_id: *message_id,
                }
            } else {
                AnswerState::Answered {
                    by: AnsweredBy::Us,
                    message_id: Some(*message_id),
                    at,
                }
            };
        }
        ItemEvent::AnswerConfirmed => {
            let AnswerState::Pending { message_id } = item.answer else {
                return Err(refuse(item.answer.key()));
            };
            next.answer = AnswerState::Answered {
                by: AnsweredBy::Us,
                message_id: Some(message_id),
                at,
            };
        }
        ItemEvent::AnswerRejected { reason } => {
            answer_from(|a| matches!(a, AnswerState::Pending { .. }))?;
            next.answer = AnswerState::Rejected {
                reason: reason.clone(),
                at,
            };
        }
        ItemEvent::AnsweredElsewhere { message_id } => {
            answer_from(|a| {
                matches!(
                    a,
                    AnswerState::Awaiting
                        | AnswerState::Rejected { .. }
                        | AnswerState::Pending { .. }
                )
            })?;
            next.answer = AnswerState::Answered {
                by: AnsweredBy::Elsewhere,
                message_id: *message_id,
                at,
            };
        }
        ItemEvent::MarkedHandled { by, reason } => {
            answer_from(owed)?;
            next.answer = AnswerState::Handled {
                by: *by,
                reason: *reason,
                at,
            };
        }
        ItemEvent::Expired => {
            answer_from(owed)?;
            next.answer = AnswerState::Expired { at };
        }
        ItemEvent::Hidden => {
            moderation_from(&[Moderation::Visible])?;
            next.moderation = Moderation::Hidden;
        }
        ItemEvent::Unhidden => {
            moderation_from(&[Moderation::Hidden])?;
            next.moderation = Moderation::Visible;
        }
        ItemEvent::Deleted => {
            moderation_from(&[Moderation::Visible, Moderation::Hidden])?;
            next.moderation = Moderation::Deleted;
        }
        ItemEvent::Removed => {
            moderation_from(&[Moderation::Visible, Moderation::Hidden])?;
            next.moderation = Moderation::Removed;
        }
        ItemEvent::Reported => {
            moderation_from(&[Moderation::Visible])?;
            next.moderation = Moderation::Reported;
        }
        ItemEvent::PrivateReplySent { message_id } => {
            if item.private_reply_message_id.is_some() {
                return Err(refuse("private_reply_used"));
            }
            if item.private_reply_until.is_none_or(|until| at > until) {
                return Err(refuse("private_window_closed"));
            }
            next.private_reply_message_id = Some(*message_id);
        }
    }
    next.updated_at = at;
    Ok(next)
}

/// The state a public conversation takes from its items: `Ours` while any item is owed, else
/// `Theirs`; a `Snoozed` or `Closed` state is kept (the next inbound item reopens it, as a
/// message does).
pub fn derived_state(items: &[PublicItem], current: &ConvState) -> ConvState {
    match current {
        ConvState::Snoozed { .. } | ConvState::Closed => current.clone(),
        ConvState::Open | ConvState::Ours | ConvState::Theirs => {
            if items.iter().any(PublicItem::awaiting) {
                ConvState::Ours
            } else {
                ConvState::Theirs
            }
        }
    }
}
