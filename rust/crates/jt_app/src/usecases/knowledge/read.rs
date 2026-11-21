//! Reading the knowledge base (design §4.11.1, §4.12, §5.4):
//!
//! - `strategy.knowledge_get` (`GET /api/knowledge`, `jeeta.strategy.knowledge_get`): everything
//!   the owner's page and the agents read. It seeds a workspace not seeded yet first, in a bundle
//!   of its own (§4.3).
//! - `Live`: what the agents' work reads take from the knowledge base, read once in the
//!   caller's bundle and without a lock: the identity the cards give, the prohibitions, the
//!   goals, the voice and the open notes (`inbox.context`, `studio.slot_get`, `studio.overview`).
//! - `project`: the compatibility projection of `strategy.get` (§5.4, K7).
//!
//! Every read here is live: an owner's edit is in the next read, with no approval in between.

use std::collections::BTreeMap;

use jt_capability::{Capability, CapabilityId};
use jt_knowledge::frame::{self as kframe, DerivePart};
use jt_knowledge::{
    Attachment, Card, KnowledgeCardId, KnowledgeNoteId, KnowledgeSettings, Note, NoteOutcome,
    NoteStatus, Proposal, ProposalStatus, cut, is_empty,
};
use jt_strategy::{
    HypothesisCadence, HypothesisId, Identity, LaneKind, Prospecting, Segment, StrategyVersion,
    StrategyVersionId,
};
use jt_studio::FileId;
use jt_tenancy::{Permission, UserId};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::rules::GoalsOut;
use super::{WORK_PERMISSIONS, frame, seed};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::strategy::{StrategyOut, VersionOut};
use crate::usecases::studio::budget::is_metered;
use crate::usecases::studio::owner_request;
use crate::usecases::studio::posts::postable;
use crate::usecases::wake::{self, AgentReach};

/// How long a file's link in a read stays usable.
pub const LINK_MINUTES: i64 = 30;
/// How many closed notes the read shows besides the open ones.
pub const CLOSED_NOTES: usize = 5;
/// The longest text of a card or a note the agents' work reads carry (§4.12).
pub const BRIEF_TEXT_CHARS: usize = 2_000;
/// How many open notes the agents' work reads carry, newest first.
pub const BRIEF_NOTES: usize = 5;
/// How many notes are read to find the open ones and the last closed ones.
const NOTES_READ: u32 = 200;

/// `strategy.knowledge_get`'s answer (design §4.11.1).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct KnowledgeOut {
    /// The knowledge base's revision: what a derivation sends as `kb_revision`.
    pub revision: u64,
    /// No live card has text (§4.5.1): the agents do not know the business yet.
    pub empty: bool,
    /// The live cards, by position.
    pub cards: Vec<CardOut>,
    pub rules: RulesView,
    pub goals: GoalsOut,
    /// The open notes and the last [`CLOSED_NOTES`] closed ones, newest first.
    pub notes: Vec<NoteOut>,
    /// Whether an agent that files notes (any work permission) can be reached now.
    pub notes_agent: AgentReach,
    /// The pending proposals, newest first.
    pub proposals: Vec<Proposal>,
    /// The internal frame in force; none before the first card text.
    pub frame: Option<FrameOut>,
}

/// A live card as the read shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CardOut {
    pub id: KnowledgeCardId,
    /// A seed card's fixed key; none for the owner's own.
    pub key: Option<String>,
    pub title: String,
    pub body: String,
    pub attachments: Vec<AttachmentOut>,
    pub position: u32,
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// The last time an agent filed a note into it, with its summary.
    pub filed: Option<Filed>,
}

/// An attachment of a card or a note, a file with a short-lived link.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentOut {
    Link {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    File {
        file_id: FileId,
        name: String,
        mime: String,
        /// Usable for [`LINK_MINUTES`]; none when the file cannot be served.
        url: Option<String>,
        #[serde(with = "time::serde::rfc3339::option")]
        expires_at: Option<OffsetDateTime>,
    },
}

/// When an agent last filed a note into a card, and what it said.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Filed {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub summary: Option<String>,
}

/// The rules as the read shows them: the stored box, the listed accounts named, and what the
/// page's lines need (§4.11).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RulesView {
    pub revision: u64,
    pub prohibitions: Vec<String>,
    pub ad_cap: Option<jt_knowledge::Cap>,
    pub message_cap: Option<jt_knowledge::Cap>,
    pub post_approval: bool,
    pub post_approval_accounts: Vec<AccountRef>,
    /// A TikTok account is connected (its posts wait for its posting screen).
    pub tiktok_connected: bool,
    /// The workspace has a metered capability (an SMS line, or a capability with a budget item
    /// or a spend cap): the paid-message limit applies to it.
    pub metered: bool,
    /// The inbox's automatic replies.
    pub auto_reply: AutoReplyView,
}

/// The inbox's automatic replies as the rules show them (`inbox::autoreply`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AutoReplyView {
    /// The platform has a model configured: the switches can be turned on.
    pub available: bool,
    /// Why they are off for every conversation: `no_key` (no model on the server) or
    /// `standard_missing` (on, but the range or the "Standart iş ve fiyat" card is missing).
    pub off_reason: Option<&'static str>,
    /// The capabilities they answer on.
    pub capability_ids: Vec<CapabilityId>,
    pub price: Option<jt_knowledge::PriceRange>,
    /// The live capabilities they can be turned on for (WhatsApp numbers), named.
    pub accounts: Vec<AccountRef>,
    /// The owner's email notices of a hand-over or an order (`inbox::notices`).
    pub notify: NotifyView,
    /// The bargaining discount, in percent: the preferred step and the largest (0: none).
    pub discount_preferred_pct: u8,
    pub discount_max_pct: u8,
}

/// The owner's email notices as the rules show them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NotifyView {
    /// A verified mailbox exists: the notices can go out.
    pub available: bool,
    /// They are on (the default).
    pub on: bool,
    /// The address they go out from: the mailbox's.
    pub from: Option<String>,
}

/// A social account the rules name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccountRef {
    pub capability_id: CapabilityId,
    /// Empty for an account no longer in the workspace.
    pub name: String,
    pub kind: String,
}

/// A note as the read shows it (never its claim's token hash).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoteOut {
    pub id: KnowledgeNoteId,
    pub text: String,
    pub links: Vec<String>,
    pub files: Vec<AttachmentOut>,
    pub status: NoteStatus,
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by: UserId,
    /// Until when an agent holds it, while one does.
    #[serde(with = "time::serde::rfc3339::option")]
    pub claimed_until: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub closed_at: Option<OffsetDateTime>,
    pub outcome: Option<NoteOutcome>,
}

/// The frame as agents read it (§4.10.3): what to send unchanged, verbatim.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FrameOut {
    pub id: StrategyVersionId,
    pub number: i32,
    /// The knowledge base's revision now.
    pub revision: u64,
    pub posting_derived: u64,
    pub prospecting_derived: u64,
    /// The derivations a card change waits for.
    pub derive_due: Vec<DerivePart>,
    pub audience: Vec<Segment>,
    pub objective: String,
    /// The live topics, without the owner's request and the closing topics.
    pub topics: Vec<FrameTopic>,
    /// Topics left out of a derivation, kept for the posts that still name them.
    pub closing: Vec<ClosingTopic>,
    pub prospecting: Prospecting,
}

/// A live topic of the frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FrameTopic {
    pub id: HypothesisId,
    pub title: String,
    pub segment_key: String,
    pub angle: String,
    pub metric: String,
    pub cadence: BTreeMap<LaneKind, HypothesisCadence>,
    /// A planned or ready post, a binding, a queued budget move or an ad names it.
    pub has_posts: bool,
}

/// A closing topic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClosingTopic {
    pub id: HypothesisId,
    pub title: String,
}

/// `strategy.knowledge_get`: the knowledge base (see [`KnowledgeOut`]). Needs `workspace.read`
/// (every member and every key). Seeds a workspace not seeded yet first.
pub async fn knowledge_get(deps: &Deps, ctx: &Ctx) -> Result<KnowledgeOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let settings = r
        .knowledge()
        .settings()
        .await?
        .ok_or_else(|| AppError::internal("the knowledge base is not seeded"))?;
    let in_force = r.strategy().current_approved().await?;
    read_in(deps, ctx, r.as_mut(), settings, in_force.as_ref()).await
}

/// [`KnowledgeOut`] of a seeded workspace, under the frame `in_force`, in the caller's bundle.
async fn read_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    settings: KnowledgeSettings,
    in_force: Option<&StrategyVersion>,
) -> Result<KnowledgeOut, AppError> {
    let expires_at = ctx.now + Duration::minutes(LINK_MINUTES);
    let all_cards = r.knowledge().cards().await?;
    let notes = r.knowledge().notes(None, NOTES_READ).await?;
    let mut cards = Vec::new();
    for c in all_cards.iter().filter(|c| c.is_live()) {
        let mut attachments = Vec::with_capacity(c.attachments.len());
        for a in &c.attachments {
            attachments.push(attachment_out(deps, ctx, a, expires_at).await);
        }
        cards.push(CardOut {
            id: c.id,
            key: c.key.clone(),
            title: c.title.clone(),
            body: c.body.clone(),
            attachments,
            position: c.position,
            revision: c.revision,
            updated_at: c.updated_at,
            filed: filed(&notes, c.id),
        });
    }
    let capabilities = r.capabilities().list(CapabilityFilter::default()).await?;
    let rules = rules_view(deps, ctx, &settings, &capabilities, &all_cards);
    let mut shown: Vec<&Note> = notes.iter().filter(|n| n.is_open()).collect();
    shown.extend(notes.iter().filter(|n| !n.is_open()).take(CLOSED_NOTES));
    shown.sort_by_key(|n| std::cmp::Reverse((n.created_at, n.id)));
    let mut notes_out = Vec::with_capacity(shown.len());
    for n in shown {
        notes_out.push(note_out(deps, ctx, r, n, expires_at).await?);
    }
    let notes_agent = wake::reach(r, ctx.now, WORK_PERMISSIONS).await?;
    let proposals = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await?;
    let frame = match in_force {
        Some(v) => Some(frame_out(r, &settings, v).await?),
        None => None,
    };
    Ok(KnowledgeOut {
        revision: settings.revision,
        empty: is_empty(&all_cards),
        cards,
        rules,
        goals: GoalsOut {
            revision: settings.goals_revision,
            items: settings.goals.clone(),
        },
        notes: notes_out,
        notes_agent,
        proposals,
        frame,
    })
}

/// The newest filing of a note into card `id`, among `notes` (newest first).
fn filed(notes: &[Note], id: KnowledgeCardId) -> Option<Filed> {
    notes
        .iter()
        .filter(|n| n.status == NoteStatus::Filed)
        .find(|n| {
            n.outcome
                .as_ref()
                .is_some_and(|o| o.cards.iter().any(|c| c.card_id == id))
        })
        .map(|n| Filed {
            at: n.closed_at.unwrap_or(n.created_at),
            summary: n.outcome.as_ref().and_then(|o| o.summary.clone()),
        })
}

/// `a` with a link to its file usable until `expires_at`.
async fn attachment_out(
    deps: &Deps,
    ctx: &Ctx,
    a: &Attachment,
    expires_at: OffsetDateTime,
) -> AttachmentOut {
    match a {
        Attachment::Link { url, title } => AttachmentOut::Link {
            url: url.clone(),
            title: title.clone(),
        },
        Attachment::File {
            file_id,
            name,
            mime,
        } => {
            let url = deps
                .files
                .device_url(ctx.workspace_id, *file_id, expires_at)
                .await
                .ok()
                .map(|u| u.to_string());
            AttachmentOut::File {
                file_id: *file_id,
                name: name.clone(),
                mime: mime.clone(),
                expires_at: url.as_ref().map(|_| expires_at),
                url,
            }
        }
    }
}

/// Note `n` as the read shows it, its files named and linked.
async fn note_out(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    n: &Note,
    expires_at: OffsetDateTime,
) -> Result<NoteOut, AppError> {
    let mut files = Vec::with_capacity(n.file_ids.len());
    for id in &n.file_ids {
        let (name, mime) = match r.studio().get_file(*id).await? {
            Some(f) => (f.filename, f.mime),
            None => (String::new(), String::new()),
        };
        let file = Attachment::File {
            file_id: *id,
            name,
            mime,
        };
        files.push(attachment_out(deps, ctx, &file, expires_at).await);
    }
    Ok(NoteOut {
        id: n.id,
        text: n.text.clone(),
        links: n.links.clone(),
        files,
        status: n.status,
        revision: n.revision,
        created_at: n.created_at,
        created_by: n.created_by,
        claimed_until: n.live_claim(ctx.now).map(|c| c.until),
        closed_at: n.closed_at,
        outcome: n.outcome.clone(),
    })
}

/// The rules of `s` as the read shows them, the listed accounts named from `capabilities`.
fn rules_view(
    deps: &Deps,
    ctx: &Ctx,
    s: &KnowledgeSettings,
    capabilities: &[Capability],
    cards: &[Card],
) -> RulesView {
    let model_on = deps.connectors.reply_model().is_some();
    let auto_reply = AutoReplyView {
        available: model_on,
        off_reason: crate::usecases::inbox::autoreply::off_reason(model_on, s, cards),
        capability_ids: s
            .auto_reply
            .iter()
            .flat_map(|a| a.capability_ids.iter().copied().map(CapabilityId))
            .collect(),
        price: s.auto_reply.as_ref().and_then(|a| a.price.clone()),
        accounts: capabilities
            .iter()
            .filter(|c| {
                c.status != jt_capability::StoredStatus::Retired
                    && jt_knowledge::AUTO_REPLY_KINDS.contains(&c.kind_key.as_str())
            })
            .map(|c| AccountRef {
                capability_id: c.id,
                name: c.name.clone(),
                kind: c.kind_key.clone(),
            })
            .collect(),
        discount_preferred_pct: s
            .auto_reply
            .as_ref()
            .map_or(0, |a| a.discount_preferred_pct),
        discount_max_pct: s.auto_reply.as_ref().map_or(0, |a| a.discount_max_pct),
        notify: {
            let mailbox = crate::usecases::inbox::notices::mailbox(capabilities);
            NotifyView {
                available: mailbox.is_some(),
                on: s.auto_reply.as_ref().is_none_or(|a| a.notifies()),
                from: mailbox.and_then(|m| m.external_id.clone()),
            }
        },
    };
    let post_approval_accounts = s
        .post_approval_accounts
        .iter()
        .map(|id| {
            let c = capabilities.iter().find(|c| c.id.as_uuid() == *id);
            AccountRef {
                capability_id: CapabilityId(*id),
                name: c.map(|c| c.name.clone()).unwrap_or_default(),
                kind: c.map(|c| c.kind_key.clone()).unwrap_or_default(),
            }
        })
        .collect();
    RulesView {
        revision: s.rules_revision,
        prohibitions: s.prohibitions.clone(),
        ad_cap: s.ad_cap.clone(),
        message_cap: s.message_cap.clone(),
        post_approval: s.post_approval,
        post_approval_accounts,
        tiktok_connected: capabilities
            .iter()
            .any(|c| c.kind_key == "tiktok" && postable(deps, c, ctx.now)),
        metered: capabilities
            .iter()
            .any(|c| c.status != jt_capability::StoredStatus::Retired && is_metered(c)),
        auto_reply,
    }
}

/// The frame `v` as agents read it, under the knowledge base's `settings`.
async fn frame_out(
    r: &mut dyn TenantRepos,
    settings: &KnowledgeSettings,
    v: &StrategyVersion,
) -> Result<FrameOut, AppError> {
    let retained = frame::retained(r).await?;
    let mut topics = Vec::new();
    let mut closing = Vec::new();
    for h in r.hypotheses().list(v.id).await? {
        if !h.state.is_live() || owner_request::is(v.workspace_id, h.id) {
            continue;
        }
        if settings.closing_topic_ids.contains(&h.id) {
            closing.push(ClosingTopic {
                id: h.id,
                title: h.title,
            });
            continue;
        }
        topics.push(FrameTopic {
            has_posts: retained.contains_key(&h.id),
            id: h.id,
            title: h.title,
            segment_key: h.segment_key,
            angle: h.angle,
            metric: h.metric,
            cadence: h.cadence,
        });
    }
    let mut derive_due = Vec::new();
    if settings.posting_due() {
        derive_due.push(DerivePart::Posting);
    }
    if settings.prospecting_due() {
        derive_due.push(DerivePart::Prospecting);
    }
    Ok(FrameOut {
        id: v.id,
        number: v.number,
        revision: settings.revision,
        posting_derived: settings.posting_derived,
        prospecting_derived: settings.prospecting_derived,
        derive_due,
        audience: v.sections.audience.clone(),
        objective: v.sections.goals.objective.clone(),
        topics,
        closing,
        prospecting: v.sections.prospecting.clone(),
    })
}

// ---------------------------------------------------------------------------------------------
// What the agents' work reads take (§4.12)
// ---------------------------------------------------------------------------------------------

/// A card as the agents' work reads carry it: its text cut at [`BRIEF_TEXT_CHARS`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BriefCard {
    pub key: Option<String>,
    pub title: String,
    pub body: String,
    /// The body was cut.
    pub truncated: bool,
}

/// The knowledge base as `inbox.context` carries it (§4.12).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeBrief {
    /// The live cards with text, by position.
    pub cards: Vec<BriefCard>,
    /// The prohibitions: no agent crosses them.
    pub rules: Vec<String>,
    pub goals: Vec<String>,
    /// What the owner told the agents and no agent has filed yet: it binds at once.
    pub notes: Vec<String>,
    pub revision: u64,
}

/// The knowledge base of a seeded workspace, as the agents' work reads take it: read once,
/// without a lock.
pub(crate) struct Live {
    pub(crate) settings: KnowledgeSettings,
    cards: Vec<Card>,
    /// The open notes, newest first.
    open_notes: Vec<Note>,
    workspace_name: String,
}

impl Live {
    /// The knowledge base of the bundle's workspace; none before it is seeded (the reads then
    /// keep what the frame says).
    pub(crate) async fn read(r: &mut dyn TenantRepos) -> Result<Option<Live>, AppError> {
        let Some(settings) = r.knowledge().settings().await? else {
            return Ok(None);
        };
        let cards = r.knowledge().cards().await?;
        let open_notes = r
            .knowledge()
            .notes(Some(NoteStatus::Open), BRIEF_NOTES as u32)
            .await?;
        let workspace_name = r.workspace().get().await?.name;
        Ok(Some(Live {
            settings,
            cards,
            open_notes,
            workspace_name,
        }))
    }

    /// The identity the cards give (design §4.10.1, D34), what sets the business apart taken
    /// from `frame` (the frame's own).
    pub(crate) fn identity(&self, frame: Option<&StrategyVersion>) -> Identity {
        let usp = frame.map_or("", |v| v.sections.identity.usp.as_str());
        kframe::identity(&self.cards, usp, &self.workspace_name)
    }

    /// The voice card's text.
    pub(crate) fn voice(&self) -> String {
        self.cards
            .iter()
            .find(|c| c.is_live() && c.key.as_deref() == Some("voice"))
            .map(|c| c.body.trim().to_owned())
            .unwrap_or_default()
    }

    /// The open notes' texts, newest first, each cut at [`BRIEF_TEXT_CHARS`].
    pub(crate) fn notes(&self) -> Vec<String> {
        self.open_notes
            .iter()
            .take(BRIEF_NOTES)
            .map(|n| cut(&n.text, BRIEF_TEXT_CHARS))
            .collect()
    }

    /// The workspace's name.
    pub(crate) fn workspace_name(&self) -> &str {
        &self.workspace_name
    }

    /// The live cards with text as the automatic replies read them (`inbox::autoreply`), by
    /// position, `(title, text)`: the standard card and "Ürünler ve fiyat" whole, every other cut
    /// at [`BRIEF_TEXT_CHARS`].
    pub(crate) fn reply_cards(&self) -> Vec<(String, String)> {
        let mut live: Vec<&Card> = self
            .cards
            .iter()
            .filter(|c| c.is_live() && c.has_text())
            .collect();
        live.sort_by_key(|c| (c.position, c.created_at, c.id));
        live.into_iter()
            .map(|c| {
                let whole = matches!(
                    c.key.as_deref(),
                    Some(k) if k == jt_knowledge::REPLY_STANDARD.0 || k == "products_prices"
                );
                let body = if whole {
                    c.body.trim().to_owned()
                } else {
                    cut(c.body.trim(), BRIEF_TEXT_CHARS)
                };
                (c.title.clone(), body)
            })
            .collect()
    }

    /// Every live card's title, text and links, as one text: what a link in an automatic reply
    /// must come from.
    pub(crate) fn card_texts(&self) -> String {
        let mut out = String::new();
        for c in self.cards.iter().filter(|c| c.is_live()) {
            out.push_str(&c.title);
            out.push('\n');
            out.push_str(&c.body);
            out.push('\n');
            for a in &c.attachments {
                if let Attachment::Link { url, .. } = a {
                    out.push_str(url);
                    out.push('\n');
                }
            }
        }
        out
    }

    /// The closing topics: offered no new work (§4.10.6).
    pub(crate) fn closing(&self) -> &[HypothesisId] {
        &self.settings.closing_topic_ids
    }

    /// The knowledge base as `inbox.context` carries it.
    pub(crate) fn brief(&self) -> KnowledgeBrief {
        let mut live: Vec<&Card> = self
            .cards
            .iter()
            .filter(|c| c.is_live() && c.has_text())
            .collect();
        live.sort_by_key(|c| (c.position, c.created_at, c.id));
        KnowledgeBrief {
            cards: live
                .into_iter()
                .map(|c| BriefCard {
                    key: c.key.clone(),
                    title: c.title.clone(),
                    body: cut(&c.body, BRIEF_TEXT_CHARS),
                    truncated: c.body.chars().count() > BRIEF_TEXT_CHARS,
                })
                .collect(),
            rules: self.settings.prohibitions.clone(),
            goals: self.settings.goals.clone(),
            notes: self.notes(),
            revision: self.settings.revision,
        }
    }
}

/// The closing topics of the bundle's workspace (none before it is seeded).
pub(crate) async fn closing_topics(r: &mut dyn TenantRepos) -> Result<Vec<HypothesisId>, AppError> {
    Ok(r.knowledge()
        .settings()
        .await?
        .map(|s| s.closing_topic_ids)
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------------------------
// `strategy.get`'s compatibility projection (§5.4)
// ---------------------------------------------------------------------------------------------

/// The compatibility projection of `strategy.get` (design §5.4, K7), onto `out` as the versions
/// read it: on a seeded workspace, `approved` is the frame in force with the owner's live words
/// (the identity the cards give, the prohibitions, the goals as KPIs), `channels = [any]`, its
/// topics without the owner's request and the closing ones, no gaps and no assumptions; and
/// `knowledge` is what `strategy.knowledge_get` answers. A workspace not seeded yet is answered as
/// the versions are: reading the strategy never seeds (seeding archives an open draft, which an
/// older routine reading this may be working on).
pub(crate) async fn project(deps: &Deps, ctx: &Ctx, out: &mut StrategyOut) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(live) = Live::read(r.as_mut()).await? else {
        return Ok(());
    };
    let in_force = r.strategy().current_approved().await?;
    if let (Some(approved), Some(v)) = (out.approved.as_mut(), in_force.as_ref()) {
        projected(approved, &live, v);
    }
    let settings = live.settings.clone();
    out.knowledge = Some(read_in(deps, ctx, r.as_mut(), settings, in_force.as_ref()).await?);
    Ok(())
}

/// `approved` (the frame `v` as the versions read it) with the knowledge base's live words.
fn projected(approved: &mut VersionOut, live: &Live, v: &StrategyVersion) {
    let s = &mut approved.sections;
    s.identity = live.identity(Some(v));
    s.prohibitions = live.settings.prohibitions.clone();
    s.goals.kpis = kframe::kpis(&live.settings.goals);
    s.channels = kframe::any_channels();
    approved
        .hypotheses
        .retain(|h| !owner_request::is(v.workspace_id, h.id) && !live.closing().contains(&h.id));
    approved.gaps.clear();
    approved.assumptions.clear();
}
