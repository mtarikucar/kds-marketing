//! The knowledge base (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4): the owner's cards,
//! rules and goals, the notes a person writes to the agents, and the agents' proposals. The owner's
//! edits apply at once: there is no draft, submit or approval.
//!
//! - [`seed`]: every workspace gets its knowledge base once, from its strategy versions.
//! - [`cards`]: `strategy.card_create`, `card_update`, `card_archive`, `card_history`.
//! - [`rules`]: `strategy.rules_save`, `post_approval_set` and `goals_save`.
//! - [`notes`]: `strategy.note_add`, `note_withdraw`, `note_claim`, `note_file`, `note_release`.
//! - [`proposals`]: `strategy.proposal_create`, `proposal_accept`, `proposal_skip`.
//!
//! Not registered yet: no catalog row, panel route or MCP tool calls these (they arrive with the
//! design's next step, with the internal frame they feed: the frame apply, its bootstrap from the
//! first card text, the mirror of the rules' caps, and the wakes a change asks for).
//!
//! **Every knowledge write** (a card, the rules, the goals, an accepted proposal, a filed note)
//! runs in one tenant bundle (design §4.4): it takes its locks in the one order of §4.10.13
//! ([`lock`]: the draft and the execution frame first when the write may write a frame, then the
//! settings, then the row it changes, and nothing earlier after), writes the row, appends one
//! revision row (the subject as it now is), moves the knowledge base's revision once per bundle
//! (and the posting or prospecting revision when a card the frame is derived from changed), and
//! writes `strategy.knowledge_changed` (`strategy.rules_changed` for the rules) with the frame
//! in force. Texts live in the revision rows, never in the ledger.
//!
//! **Who.** The owner's page writes need `team.manage` and a person in person (`FORBIDDEN`
//! `human_required` for an agent); the agents' notes and proposals need any work permission
//! ([`WORK_PERMISSIONS`]) and an agent connection (`FORBIDDEN` `agent_only` for a person).

pub mod cards;
pub mod notes;
pub mod proposals;
pub mod rules;
pub mod seed;

use jt_knowledge::{Card, Cause, Invalid, KnowledgeSettings, Subject};
use jt_ledger::Actor;
use jt_strategy::StrategyVersionId;
use jt_tenancy::{AgentConnectionId, Permission, UserId};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{Deps, ledger_entry};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;

/// The work permissions an agent files notes and makes proposals with (design §5.1).
pub const WORK_PERMISSIONS: &[Permission] = &[
    Permission::ContentWork,
    Permission::SocialWork,
    Permission::AdsWork,
    Permission::MaterialsWork,
    Permission::ProspectsWork,
    Permission::OutreachWork,
    Permission::InboxWork,
];

/// `VALIDATION` naming `details.field` and `details.reason` for a value the knowledge base does
/// not take.
pub(crate) fn invalid(e: Invalid) -> AppError {
    AppError::validation(e.message, json!({ "field": e.field, "reason": e.reason }))
}

/// A refusal with `details.reason = reason`, and `extra`'s keys beside it.
pub(crate) fn refused(code: ErrorCode, reason: &str, message: &str, extra: Value) -> AppError {
    let mut details = json!({ "reason": reason });
    if let (Some(map), Value::Object(more)) = (details.as_object_mut(), extra) {
        map.extend(more);
    }
    AppError {
        code,
        message: message.to_owned(),
        details,
    }
}

/// `CONFLICT` with `details.reason = reason`.
pub(crate) fn conflict(reason: &str, message: &str) -> AppError {
    refused(ErrorCode::Conflict, reason, message, json!({}))
}

/// The person acting in person: a human, not through an agent connection; else `FORBIDDEN`
/// `human_required`.
pub(crate) fn person(ctx: &Ctx) -> Result<UserId, AppError> {
    match ctx.actor {
        Actor::Human { user_id } if ctx.agent_connection_id.is_none() => Ok(user_id),
        _ => Err(refused(
            ErrorCode::Forbidden,
            "human_required",
            "only a person in person changes the knowledge base this way",
            json!({}),
        )),
    }
}

/// The agent connection acting; else `FORBIDDEN` `agent_only`.
pub(crate) fn agent(ctx: &Ctx) -> Result<AgentConnectionId, AppError> {
    match (&ctx.actor, ctx.agent_connection_id) {
        (Actor::Agent { connection_id, .. }, _) => Ok(*connection_id),
        (_, Some(connection_id)) => Ok(connection_id),
        _ => Err(refused(
            ErrorCode::Forbidden,
            "agent_only",
            "only an agent does this",
            json!({}),
        )),
    }
}

/// An editor of the owner's page: `team.manage` (else `FORBIDDEN` naming it), in person (else
/// `FORBIDDEN` `human_required`).
pub(crate) fn editor(ctx: &Ctx) -> Result<UserId, AppError> {
    ctx.require(Permission::TeamManage)?;
    person(ctx)
}

/// The knowledge base of a bundle, locked for one write, with the frame in force.
pub(crate) struct Locked {
    pub(crate) settings: KnowledgeSettings,
    /// The frame in force when the write began (none before a workspace's first one).
    pub(crate) frame: Option<StrategyVersionId>,
    /// Whether this bundle moved the knowledge base's revision already.
    bumped: bool,
}

/// Takes a knowledge write's locks in the order of design §4.10.13 and answers the settings,
/// seeded beforehand by [`seed::ensure`] (`INTERNAL` otherwise).
///
/// `frame_write` says whether the write may write a frame ([`FrameWrite`]: the rules' mirror
/// always, a card write when no frame exists yet, for its bootstrap). When it may, the draft and
/// then the execution frame are locked first (`StrategyRepo::lock_draft`,
/// `lock_execution_frame`); the settings after them, and nothing earlier after that.
pub(crate) async fn lock(
    r: &mut dyn TenantRepos,
    frame_write: FrameWrite,
) -> Result<Locked, AppError> {
    let take = match frame_write {
        FrameWrite::Always => true,
        FrameWrite::WithoutFrame => r.strategy().current_approved().await?.is_none(),
        FrameWrite::Never => false,
    };
    let frame = if take {
        r.strategy().lock_draft().await?;
        r.strategy().lock_execution_frame().await?
    } else {
        r.strategy().current_approved().await?
    };
    let settings = r
        .knowledge()
        .lock_settings()
        .await?
        .ok_or_else(|| AppError::internal("the knowledge base is not seeded"))?;
    Ok(Locked {
        settings,
        frame: frame.map(|v| v.id),
        bumped: false,
    })
}

/// Whether a write may write the internal frame, for [`lock`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrameWrite {
    /// The rules: their caps are mirrored into the frame.
    Always,
    /// A card write: it bootstraps the first frame of a workspace that has none.
    WithoutFrame,
    /// Nothing the frame holds.
    Never,
}

/// One change of a knowledge write, for [`Locked::record`].
pub(crate) struct Change<'a> {
    pub(crate) subject: Subject,
    /// The card as it now is, for a card's change.
    pub(crate) card: Option<&'a Card>,
    pub(crate) cause: Cause,
    /// The proposal or the note it came from.
    pub(crate) source_id: Option<Uuid>,
    /// The person whose change it is (`changed_by`).
    pub(crate) person: Option<UserId>,
    /// A card the posting part of the frame is derived from changed.
    pub(crate) posting: bool,
    /// A card the prospecting part of the frame is derived from changed.
    pub(crate) prospecting: bool,
}

impl Locked {
    /// Records `change` (design §4.4 steps 2 to 4): moves the knowledge base's revision once
    /// per bundle, and the posting or prospecting revision to it when they moved; appends the
    /// revision row; writes the ledger entry. The caller saves the row it changed and, once all
    /// its changes are recorded, the settings ([`Locked::save`]).
    pub(crate) async fn record(
        &mut self,
        r: &mut dyn TenantRepos,
        deps: &Deps,
        ctx: &Ctx,
        change: Change<'_>,
    ) -> Result<u64, AppError> {
        if !self.bumped {
            self.settings.revision += 1;
            self.bumped = true;
        }
        let kb = self.settings.revision;
        self.settings.changed_at = Some(ctx.now);
        self.settings.changed_by = change.person;
        if change.posting {
            self.settings.posting_revision = kb;
        }
        if change.prospecting {
            self.settings.prospecting_revision = kb;
        }
        let (revision, content) = match (change.subject, change.card) {
            (Subject::Card, Some(card)) => (card.revision, card.content()),
            (Subject::Rules, None) => (self.settings.rules_revision, self.settings.rules_content()),
            (Subject::Goals, None) => (self.settings.goals_revision, self.settings.goals_content()),
            _ => return Err(AppError::internal("a card change names its card")),
        };
        let row = jt_knowledge::Revision {
            id: jt_knowledge::KnowledgeRevisionId(deps.ids.uuid()),
            subject: change.subject,
            card_id: change.card.map(|c| c.id),
            revision,
            kb_revision: kb,
            content,
            cause: change.cause,
            source_id: change.source_id,
            at: ctx.now,
            by: ctx.actor.clone(),
        };
        r.knowledge().append_revision(&row).await?;
        let mut entry = match change.subject {
            Subject::Rules => {
                let s = &self.settings;
                let cap = |c: &Option<jt_knowledge::Cap>| {
                    c.as_ref().map(
                        |c| json!({ "amount_minor": c.amount_minor, "period": c.period.key() }),
                    )
                };
                ledger_entry(
                    ctx,
                    "strategy.rules_changed",
                    "knowledge_settings",
                    ctx.workspace_id,
                    json!({
                        "prohibitions": s.prohibitions.len(),
                        "ad_budget": cap(&s.ad_cap),
                        "message_budget": cap(&s.message_cap),
                        "post_approval": s.post_approval,
                        "post_approval_accounts": s.post_approval_accounts.len(),
                        "revision": revision,
                        "kb_revision": kb,
                        "cause": change.cause.key(),
                    }),
                )?
            }
            subject => {
                let (kind, id) = match change.card {
                    Some(card) => ("knowledge_card", card.id.to_string()),
                    None => ("knowledge_settings", ctx.workspace_id.to_string()),
                };
                ledger_entry(
                    ctx,
                    "strategy.knowledge_changed",
                    kind,
                    id,
                    json!({
                        "subject": subject.key(),
                        "card_id": change.card.map(|c| c.id),
                        "key": change.card.and_then(|c| c.key.clone()),
                        "revision": revision,
                        "kb_revision": kb,
                        "cause": change.cause.key(),
                    }),
                )?
            }
        };
        entry.strategy_version_id = self.frame.map(|v| v.as_uuid());
        r.ledger().append(entry).await?;
        Ok(kb)
    }

    /// Stores the settings as the write left them.
    pub(crate) async fn save(&self, r: &mut dyn TenantRepos) -> Result<(), AppError> {
        r.knowledge().save_settings(&self.settings).await
    }
}

/// Whether a change of `card` from `before` touches what a derivation reads (its title, body,
/// attachments, or whether it is live): which parts move, `(posting, prospecting)`.
pub(crate) fn moves(before: Option<&Card>, after: &Card) -> (bool, bool) {
    let changed = before.is_none_or(|b| {
        b.title != after.title
            || b.body != after.body
            || b.attachments != after.attachments
            || b.is_live() != after.is_live()
    });
    let key = after.key.as_deref();
    (
        changed && jt_knowledge::feeds_posting(key),
        changed && jt_knowledge::feeds_prospecting(key),
    )
}

/// The context of the system acting for a write the caller's call started (the seeding): the
/// same workspace and time, the actor `component`.
pub(crate) fn system(ctx: &Ctx, component: &str) -> Ctx {
    Ctx {
        workspace_id: ctx.workspace_id,
        actor: Actor::System {
            component: component.to_owned(),
        },
        permissions: Default::default(),
        role_key: None,
        now: ctx.now,
        agent_connection_id: None,
    }
}
