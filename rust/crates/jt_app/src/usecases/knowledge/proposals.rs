//! "Ajanın önerileri" (design §4.9): `strategy.proposal_create` (an agent with a work
//! permission), `strategy.proposal_accept` and `strategy.proposal_skip` (the owner's page:
//! `team.manage`, a person in person).
//!
//! A proposal is a change an agent learned while working and the owner did not say: a new card,
//! a card's whole new text, a rule or a goal, with a one-line reason in Turkish. Nothing changes
//! until the owner adds it; it closes by itself after 14 days (60 for the system's own).
//!
//! Refusals at create: `CONFLICT` `too_many_proposals` (20 pending, the system's not counted),
//! `CONFLICT` `proposal_rate` (10 a day from one connection), `CONFLICT` `proposal_exists` (the
//! same kind, card and text pending), `NOT_FOUND` (no such card), `CONFLICT` `card_archived`,
//! `VALIDATION` (the limits). Accepting is a knowledge write (see [`super`]); a `card_edit` whose
//! card moved past the revision it was written against is `CONFLICT` `proposal_superseded`, and
//! the proposal is then superseded (committed): accepting would overwrite the owner's newer text.
//! A proposal past its time is expired the same way (`CONFLICT` `proposal_expired`); one already
//! decided is `CONFLICT` `proposal_closed`.

use jt_knowledge::{
    AGENT_PROPOSAL_TTL, Card, Cause, KnowledgeCardId, KnowledgeProposalId, MAX_GOALS,
    MAX_LIVE_CARDS, MAX_PENDING_PROPOSALS, MAX_PROHIBITIONS, MAX_PROPOSALS_PER_DAY, Proposal,
    ProposalKind, ProposalStatus, Proposer, Subject, append_lines, validate_proposal,
    validate_text,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Duration;

use super::cards::{live, next_position, supersede_edits, too_many_cards};
use super::{
    Change, FrameWrite, WORK_PERMISSIONS, agent, conflict, editor, invalid, lock, moves, refused,
    seed,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::usecases::{Deps, hash_token, ledger_entry};

/// The request receipts' action.
const PROPOSAL_CREATE: &str = "strategy.proposal_create";

/// `strategy.proposal_create`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalCreateInput {
    /// 1 to 128 characters; a replay answers the same proposal.
    pub request_key: String,
    pub kind: ProposalKind,
    #[serde(default)]
    pub card_id: Option<KnowledgeCardId>,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    pub reason: String,
}

/// Makes a pending proposal for the owner (see the module docs).
pub async fn proposal_create(
    deps: &Deps,
    ctx: &Ctx,
    input: ProposalCreateInput,
) -> Result<Proposal, AppError> {
    let connection = agent(ctx)?;
    ctx.require_any(WORK_PERMISSIONS)?;
    let key = validate_text("request_key", &input.request_key, 1, 128).map_err(invalid)?;
    let draft = validate_proposal(
        input.kind,
        input.card_id,
        input.title.as_deref(),
        &input.body,
        &input.reason,
    )
    .map_err(invalid)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    // The settings' lock serialises the limits below.
    lock(r.as_mut(), FrameWrite::Never).await?;
    let payload = json!(hash_token(&serde_json::to_string(&input).map_err(|e| {
        AppError::internal(format!("cannot encode the input: {e}"))
    })?));
    if let Some(id) = r
        .studio()
        .request_replay(PROPOSAL_CREATE, &key, &payload)
        .await?
    {
        let id: KnowledgeProposalId = serde_json::from_value(id)
            .map_err(|_| AppError::internal("a request receipt holds no proposal"))?;
        return r
            .knowledge()
            .proposal(id)
            .await?
            .ok_or_else(|| AppError::internal("a proposal a receipt names is gone"));
    }
    let base_revision = match draft.card_id {
        Some(card_id) => {
            let card = r.knowledge().card(card_id).await?.ok_or_else(|| {
                refused(
                    ErrorCode::NotFound,
                    "no_such_card",
                    "no such card",
                    json!({ "field": "card_id" }),
                )
            })?;
            if !card.is_live() {
                return Err(conflict("card_archived", "the card is removed"));
            }
            Some(card.revision)
        }
        None => None,
    };
    let pending = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await?;
    if pending.iter().filter(|p| !p.is_system()).count() >= MAX_PENDING_PROPOSALS {
        return Err(refused(
            ErrorCode::Conflict,
            "too_many_proposals",
            &format!("at most {MAX_PENDING_PROPOSALS} proposals wait for the owner"),
            json!({ "max": MAX_PENDING_PROPOSALS }),
        ));
    }
    let today = r
        .knowledge()
        .proposals_by(connection, ctx.now - Duration::days(1))
        .await?;
    if today as usize >= MAX_PROPOSALS_PER_DAY {
        return Err(refused(
            ErrorCode::Conflict,
            "proposal_rate",
            &format!("an agent makes at most {MAX_PROPOSALS_PER_DAY} proposals a day"),
            json!({ "max": MAX_PROPOSALS_PER_DAY }),
        ));
    }
    if pending
        .iter()
        .any(|p| p.kind == draft.kind && p.card_id == draft.card_id && p.body == draft.body)
    {
        return Err(conflict(
            "proposal_exists",
            "the same proposal waits for the owner",
        ));
    }
    let proposal = Proposal {
        id: KnowledgeProposalId(deps.ids.uuid()),
        kind: draft.kind,
        card_id: draft.card_id,
        title: draft.title,
        body: draft.body,
        reason: draft.reason,
        status: ProposalStatus::Pending,
        base_revision,
        proposed_at: ctx.now,
        proposed_by: Proposer::Agent {
            connection_id: connection,
        },
        expires_at: ctx.now + AGENT_PROPOSAL_TTL,
        decided_at: None,
        decided_by: None,
        applied_revision: None,
    };
    r.knowledge().insert_proposal(&proposal).await?;
    r.studio()
        .request_receipt(PROPOSAL_CREATE, &key, &payload, &json!(proposal.id))
        .await?;
    ledger(
        r.as_mut(),
        ctx,
        "strategy.proposal_created",
        &proposal,
        json!({}),
    )
    .await?;
    r.commit().await?;
    Ok(proposal)
}

/// Adds pending proposal `id` to the knowledge base (see the module docs) and answers it,
/// accepted.
pub async fn proposal_accept(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeProposalId,
) -> Result<Proposal, AppError> {
    let person = editor(ctx)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let kind = r
        .knowledge()
        .proposal(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such proposal"))?
        .kind;
    let frame_write = match kind {
        ProposalKind::CardNew | ProposalKind::CardEdit => FrameWrite::WithoutFrame,
        ProposalKind::RuleAdd | ProposalKind::GoalAdd => FrameWrite::Never,
    };
    let mut kb = lock(r.as_mut(), frame_write).await?;
    let mut p = pending(r.as_mut(), id).await?;
    if p.expires_at <= ctx.now {
        return close(r, ctx, p, ProposalStatus::Expired, "proposal_expired").await;
    }
    match p.kind {
        ProposalKind::CardNew => {
            let cards = r.knowledge().cards().await?;
            if live(&cards) >= MAX_LIVE_CARDS {
                return Err(too_many_cards());
            }
            let card = Card {
                id: KnowledgeCardId(deps.ids.uuid()),
                key: None,
                title: p.title.clone().unwrap_or_default(),
                body: p.body.clone(),
                attachments: Vec::new(),
                position: next_position(&cards),
                revision: 1,
                created_at: ctx.now,
                created_by: ctx.actor.clone(),
                updated_at: ctx.now,
                updated_by: ctx.actor.clone(),
                archived_at: None,
            };
            r.knowledge().insert_card(&card).await?;
            let (posting, prospecting) = moves(None, &card);
            let c = accepted(
                &p,
                person,
                Subject::Card,
                Some(&card),
                (posting, prospecting),
            );
            kb.record(r.as_mut(), deps, ctx, c).await?;
        }
        ProposalKind::CardEdit => {
            let card_id = p
                .card_id
                .ok_or_else(|| AppError::internal("a card edit names its card"))?;
            let before = r
                .knowledge()
                .lock_card(card_id)
                .await?
                .ok_or_else(|| AppError::internal("a card a proposal names is gone"))?;
            if Some(before.revision) != p.base_revision || !before.is_live() {
                return close(r, ctx, p, ProposalStatus::Superseded, "proposal_superseded").await;
            }
            let mut card = before.clone();
            if let Some(title) = &p.title {
                card.title = title.clone();
            }
            card.body = p.body.clone();
            card.revision += 1;
            card.updated_at = ctx.now;
            card.updated_by = ctx.actor.clone();
            r.knowledge().save_card(&card).await?;
            let c = accepted(
                &p,
                person,
                Subject::Card,
                Some(&card),
                moves(Some(&before), &card),
            );
            kb.record(r.as_mut(), deps, ctx, c).await?;
            supersede_edits(r.as_mut(), card_id, ctx.now).await?;
        }
        ProposalKind::RuleAdd => {
            let added = append_lines(
                "body",
                &mut kb.settings.prohibitions,
                std::slice::from_ref(&p.body),
                MAX_PROHIBITIONS,
            )
            .map_err(invalid)?;
            if !added.is_empty() {
                kb.settings.rules_revision += 1;
                let c = accepted(&p, person, Subject::Rules, None, (false, false));
                kb.record(r.as_mut(), deps, ctx, c).await?;
            }
        }
        ProposalKind::GoalAdd => {
            let added = append_lines(
                "body",
                &mut kb.settings.goals,
                std::slice::from_ref(&p.body),
                MAX_GOALS,
            )
            .map_err(invalid)?;
            if !added.is_empty() {
                kb.settings.goals_revision += 1;
                let c = accepted(&p, person, Subject::Goals, None, (false, false));
                kb.record(r.as_mut(), deps, ctx, c).await?;
            }
        }
    }
    p.status = ProposalStatus::Accepted;
    p.decided_at = Some(ctx.now);
    p.decided_by = Some(person);
    p.applied_revision = Some(kb.settings.revision);
    r.knowledge().save_proposal(&p).await?;
    kb.save(r.as_mut()).await?;
    ledger(r.as_mut(), ctx, "strategy.proposal_accepted", &p, json!({})).await?;
    r.commit().await?;
    Ok(p)
}

/// Skips pending proposal `id` ("Geç").
pub async fn proposal_skip(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeProposalId,
) -> Result<Proposal, AppError> {
    let person = editor(ctx)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut p = pending(r.as_mut(), id).await?;
    p.status = ProposalStatus::Skipped;
    p.decided_at = Some(ctx.now);
    p.decided_by = Some(person);
    r.knowledge().save_proposal(&p).await?;
    ledger(r.as_mut(), ctx, "strategy.proposal_skipped", &p, json!({})).await?;
    r.commit().await?;
    Ok(p)
}

/// The change accepting `p` records, as `person`'s, moving the parts `(posting, prospecting)`.
fn accepted<'a>(
    p: &Proposal,
    person: jt_tenancy::UserId,
    subject: Subject,
    card: Option<&'a Card>,
    (posting, prospecting): (bool, bool),
) -> Change<'a> {
    Change {
        subject,
        card,
        cause: Cause::Proposal,
        source_id: Some(p.id.as_uuid()),
        person: Some(person),
        posting,
        prospecting,
    }
}

/// Proposal `id`, locked, still pending: `NOT_FOUND`, or `CONFLICT` `proposal_closed` with its
/// status.
async fn pending(r: &mut dyn TenantRepos, id: KnowledgeProposalId) -> Result<Proposal, AppError> {
    let p = r
        .knowledge()
        .lock_proposal(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such proposal"))?;
    if !p.is_pending() {
        return Err(refused(
            ErrorCode::Conflict,
            "proposal_closed",
            "the proposal is already decided",
            json!({ "status": p.status.key() }),
        ));
    }
    Ok(p)
}

/// Closes `p` as `status` (decided by nobody), commits, and refuses with `reason`.
async fn close(
    mut r: Box<dyn TenantRepos>,
    ctx: &Ctx,
    mut p: Proposal,
    status: ProposalStatus,
    reason: &str,
) -> Result<Proposal, AppError> {
    p.status = status;
    p.decided_at = Some(ctx.now);
    p.decided_by = None;
    r.knowledge().save_proposal(&p).await?;
    r.commit().await?;
    Err(conflict(
        reason,
        match status {
            ProposalStatus::Expired => "the proposal waited past its time",
            _ => "the card changed since the proposal was written: it is no longer offered",
        },
    ))
}

/// Appends the ledger entry `action` about `p`.
async fn ledger(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    p: &Proposal,
    payload: Value,
) -> Result<(), AppError> {
    let mut payload = payload;
    if let Some(map) = payload.as_object_mut() {
        map.insert("proposal_id".into(), json!(p.id));
        map.insert("kind".into(), json!(p.kind.key()));
        map.insert("card_id".into(), json!(p.card_id));
    }
    let mut entry = ledger_entry(ctx, action, "knowledge_proposal", p.id, payload)?;
    entry.strategy_version_id = r
        .strategy()
        .current_approved()
        .await?
        .map(|v| v.id.as_uuid());
    r.ledger().append(entry).await?;
    Ok(())
}
