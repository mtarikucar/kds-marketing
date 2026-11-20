//! The frame apply (design §4.10.2): one function, `apply`, writes the internal frame from what
//! the knowledge base says, inside the caller's transaction, for one cause:
//!
//! - `derive`: an agent's derivation from the cards (its MCP tool comes with the agents' step;
//!   the core is here: the revision checks, the compare-and-set of `derivation_stale`, D37);
//! - `bootstrap`: the first card text of a workspace without a frame (D4);
//! - `rules`: the rules' caps mirrored into the lanes;
//! - `normalize` and `close`: `knowledge_settle`'s housekeeping.
//!
//! **Locks**, in the one order of §4.10.13 (D35): the draft, the execution frame, the settings,
//! then (in the transition hook) the studio control. [`apply`] takes them; a caller already
//! holding them (a card write, a rules save) calls `apply_locked` with its settings.
//!
//! **What is written.** Only a structural change makes a version (D34): equal frames write the
//! acknowledgements and the closing topics only. A new version is inserted as a draft (an open
//! draft, only ever an old routine's, is archived first: the version needs the slot), gets its
//! topics, the frame in force is archived and the new one approved, and then what approving did
//! runs here once: the transition hook (slots of retired topics retired, their versions freed),
//! the research planner with the carry rule, and the wakes (§4.10.8). A system cause whose frame
//! does not validate is a bug: nothing of the frame is written, `strategy.frame_skipped` is
//! ledgered, and the caller's own write still commits.

use std::collections::BTreeSet;

use jt_knowledge::frame::{
    self as kframe, Base, DerivePart, FrameCause, FrameParts, Knowledge, MergeInput, Merged,
    Refusal, Retained,
};
use jt_knowledge::seed::DRAFT_CLOSED_NOTE;
use jt_knowledge::{KnowledgeSettings, is_empty};
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, Gap, Hypothesis, HypothesisId,
    HypothesisState, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_studio::{BudgetMoveState, SlotState};
use jt_tenancy::UserId;
use serde::Serialize;
use serde_json::json;

use super::{conflict, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::ads::CampaignScope;
use crate::ports::studio::{SlotQuery, StrategyChange};
use crate::usecases::studio::owner_request;
use crate::usecases::studio::planner::stable_id;
use crate::usecases::{Deps, ledger_entry, research, wake};

/// A topic of the frame in force, as an agent names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TopicOut {
    pub id: HypothesisId,
    pub title: String,
    pub segment_key: String,
}

/// What an apply did.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Applied {
    /// Whether a version was written.
    pub applied: bool,
    /// Not applied, though the texts differ (they are written with the next structural change).
    pub text_only: bool,
    /// The cause it was applied for (`close` when a normalisation only retired closing topics).
    pub cause: FrameCause,
    /// The number of the frame in force after it; 0 without one.
    pub number: i32,
    pub version_id: Option<StrategyVersionId>,
    pub kept: u32,
    pub added: u32,
    pub retired: u32,
    /// Left out, kept for what still names them; retired by the system later.
    pub closing: Vec<HypothesisId>,
    /// Segments the merge carried for rows the call did not send.
    pub kept_segments: Vec<String>,
    /// The frame in force's topics, without the owner's request and closing topics.
    pub topics: Vec<TopicOut>,
    /// A system cause's frame that did not validate (a bug): nothing of the frame was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<Gap>>,
}

impl Applied {
    /// Nothing written, under the frame `in_force`, if any.
    fn none(cause: FrameCause, in_force: Option<&StrategyVersion>) -> Applied {
        Applied {
            applied: false,
            text_only: false,
            cause,
            number: in_force.map_or(0, |v| v.number),
            version_id: in_force.map(|v| v.id),
            kept: 0,
            added: 0,
            retired: 0,
            closing: Vec::new(),
            kept_segments: Vec::new(),
            topics: Vec::new(),
            skipped: None,
        }
    }
}

/// Whom an apply wakes for the work it changed (design §4.10.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waking {
    /// The person acting in person (`wake::request`).
    InPerson,
    /// On behalf of this person (`wake::request_for`).
    For(UserId),
    /// Nobody (the system's own housekeeping).
    Nobody,
}

/// What an apply is asked to do.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub cause: FrameCause,
    /// What the call brings: nothing for the system's causes.
    pub next: &'a FrameParts,
    /// Who approves the version it writes (`approved_by`): the key's issuer for a derivation,
    /// the person for the rules and the bootstrap, nobody for the housekeeping.
    pub approver: Option<UserId>,
    pub waking: Waking,
}

/// The bootstrap topic's id in workspace `ws`, stable across frames.
pub fn bootstrap_id(ws: jt_tenancy::WorkspaceId) -> HypothesisId {
    HypothesisId(stable_id(ws, kframe::BOOTSTRAP_TOPIC_KEY))
}

/// Applies a frame in the caller's bundle, taking its locks first (design §4.10.13): the draft,
/// the execution frame, the settings (`INTERNAL` when the knowledge base is not seeded). Saves
/// the settings; the caller commits.
pub async fn apply(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    req: Request<'_>,
) -> Result<Applied, AppError> {
    r.strategy().lock_draft().await?;
    r.strategy().lock_execution_frame().await?;
    let mut settings = r
        .knowledge()
        .lock_settings()
        .await?
        .ok_or_else(|| AppError::internal("the knowledge base is not seeded"))?;
    let out = apply_locked(deps, ctx, r, &mut settings, req).await?;
    r.knowledge().save_settings(&settings).await?;
    Ok(out)
}

/// The revision part `part` was last derived from.
fn derived(s: &KnowledgeSettings, part: DerivePart) -> u64 {
    match part {
        DerivePart::Posting => s.posting_derived,
        DerivePart::Prospecting => s.prospecting_derived,
    }
}

/// [`apply`] for a caller holding the draft, frame and settings locks, with its `settings`,
/// which the apply updates (the acknowledgements, the closing topics) and the caller saves.
pub(crate) async fn apply_locked(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    settings: &mut KnowledgeSettings,
    req: Request<'_>,
) -> Result<Applied, AppError> {
    let Request {
        cause,
        next,
        approver,
        waking,
    } = req;
    let ws = ctx.workspace_id;
    // Re-entrant: the caller took them first, in this order.
    let draft = r.strategy().lock_draft().await?;
    let previous = r.strategy().lock_execution_frame().await?;
    if cause == FrameCause::Derive {
        if next.kb_revision > settings.revision {
            return Err(refused(
                ErrorCode::Conflict,
                "kb_revision_ahead",
                "kb_revision is newer than the knowledge base: read jeeta.strategy.knowledge_get",
                json!({ "revision": settings.revision }),
            ));
        }
        for part in &next.parts {
            if next.kb_revision < derived(settings, *part) {
                return Err(refused(
                    ErrorCode::Conflict,
                    "derivation_stale",
                    "a newer derivation of this part was applied: read the knowledge base and \
                     derive again",
                    json!({ "part": part.key(), "derived": derived(settings, *part) }),
                ));
            }
        }
        if previous.is_none() {
            return Err(conflict(
                "knowledge_empty",
                "the knowledge base has no card text yet: nothing to derive; propose a card \
                 with jeeta.strategy.proposal_create",
            ));
        }
    }
    let previous = match (cause, previous) {
        (FrameCause::Bootstrap, Some(v)) => return Ok(Applied::none(cause, Some(&v))),
        (FrameCause::Bootstrap, None) => None,
        (_, None) => return Ok(Applied::none(cause, None)),
        (_, Some(v)) => Some(v),
    };
    let hypotheses = match &previous {
        Some(v) => r.hypotheses().list(v.id).await?,
        None => Vec::new(),
    };
    let retained = match &previous {
        Some(_) => retained(r).await?,
        None => Retained::new(),
    };
    let known = if next.topics.iter().flatten().any(|t| t.id.is_some()) {
        known_ids(r).await?
    } else {
        BTreeSet::new()
    };
    let cards = r.knowledge().cards().await?;
    let workspace_name = r.workspace().get().await?.name;
    let owner = owner_request::id(ws);
    let input = |retire_closing: bool| MergeInput {
        cause,
        base: previous.as_ref().map(|v| Base {
            sections: &v.sections,
            hypotheses: &hypotheses,
        }),
        next,
        knowledge: Knowledge {
            cards: &cards,
            settings,
            workspace_name: &workspace_name,
        },
        retained: &retained,
        known_ids: &known,
        owner_request: owner,
        bootstrap_id: bootstrap_id(ws),
        retire_closing,
    };
    let retire = matches!(cause, FrameCause::Normalize | FrameCause::Close);
    let mut new_id = || HypothesisId(deps.ids.uuid());
    let merged = match kframe::merge(&input(retire), &mut new_id) {
        Ok(m) => m,
        Err(Refusal::Reserved(field)) => {
            return Err(refused(
                ErrorCode::Forbidden,
                "hypothesis_reserved",
                "the owner's request is not a topic: leave it out",
                json!({ "field": field }),
            ));
        }
        Err(Refusal::Gaps(gaps)) if cause == FrameCause::Derive => {
            return Err(AppError::validation(
                "the derivation is not valid",
                json!({ "gaps": gaps }),
            ));
        }
        Err(Refusal::Gaps(gaps)) => {
            let mut entry = ledger_entry(
                ctx,
                "strategy.frame_skipped",
                "knowledge_settings",
                ws,
                json!({ "cause": cause.key(), "gaps": gaps }),
            )?;
            entry.strategy_version_id = previous.as_ref().map(|v| v.id.as_uuid());
            r.ledger().append(entry).await?;
            let mut out = Applied::none(cause, previous.as_ref());
            out.skipped = Some(gaps);
            return Ok(out);
        }
    };
    // A normalisation that only retired closing topics is a `close`.
    let before = previous
        .as_ref()
        .map(|v| kframe::structural(&v.sections, &hypotheses));
    let cause = if cause == FrameCause::Normalize {
        match kframe::merge(&input(false), &mut new_id) {
            Ok(plain) if before == Some(kframe::structural(&plain.sections, &plain.hypotheses)) => {
                FrameCause::Close
            }
            _ => cause,
        }
    } else {
        cause
    };
    let after = kframe::structural(&merged.sections, &merged.hypotheses);
    let (kept, added, retired) = merged.counts(owner);
    if before.as_ref() == Some(&after) {
        acknowledge(settings, next, cause, &merged, ctx);
        let v = previous.as_ref().expect("a frame to compare with");
        let mut out = Applied::none(cause, Some(v));
        out.text_only = kframe::texts(&v.sections, &hypotheses)
            != kframe::texts(&merged.sections, &merged.hypotheses);
        out.closing = merged.closing.clone();
        out.kept_segments = merged.kept_segments.clone();
        out.topics = topics(ws, &hypotheses, &merged.closing);
        return Ok(out);
    }

    // A new version (step 8).
    if let Some(d) = &draft {
        if r.strategy()
            .set_status(d.id, VersionStatus::Archived, ctx.now, None)
            .await?
            == 0
        {
            return Err(AppError::conflict("the draft has already moved"));
        }
        log(
            r,
            deps,
            ctx,
            d.id,
            ConsultationKind::Archived,
            DRAFT_CLOSED_NOTE,
        )
        .await?;
    }
    let number = r.strategy().next_number().await?;
    let mut version = StrategyVersion {
        id: StrategyVersionId(deps.ids.uuid()),
        workspace_id: ws,
        number,
        status: VersionStatus::Draft,
        sections: merged.sections.clone(),
        created_at: ctx.now,
        created_by: ctx.actor.clone(),
        submitted_at: None,
        approved_at: None,
        approved_by: None,
        archived_at: None,
    };
    r.strategy().insert(version.clone()).await?;
    r.hypotheses()
        .replace_all(version.id, merged.hypotheses.clone())
        .await?;
    if let Some(p) = &previous {
        moved(
            r.strategy()
                .set_status(p.id, VersionStatus::Archived, ctx.now, approver)
                .await?,
        )?;
        log(
            r,
            deps,
            ctx,
            p.id,
            ConsultationKind::Archived,
            &format!("superseded by version {number}"),
        )
        .await?;
    }
    match r
        .strategy()
        .set_status(version.id, VersionStatus::Approved, ctx.now, approver)
        .await
    {
        Ok(n) => moved(n)?,
        Err(e) if e.code == ErrorCode::Conflict => {
            return Err(AppError::conflict("another approval won"));
        }
        Err(e) => return Err(e),
    }
    version.status = VersionStatus::Approved;
    version.approved_at = Some(ctx.now);
    version.approved_by = approver;
    log(
        r,
        deps,
        ctx,
        version.id,
        ConsultationKind::Approved,
        &format!("frame {number} applied ({})", cause.key()),
    )
    .await?;
    let mut entry = ledger_entry(
        ctx,
        "strategy.frame_applied",
        "strategy_version",
        version.id,
        json!({
            "number": number,
            "cause": cause.key(),
            "parts": next.parts.iter().map(DerivePart::key).collect::<Vec<_>>(),
            "kept": kept,
            "added": added,
            "retired": retired,
            "closing": merged.closing,
            "kept_segments": merged.kept_segments,
            "kb_revision": if cause == FrameCause::Derive { next.kb_revision } else { settings.revision },
        }),
    )?;
    entry.strategy_version_id = Some(version.id.as_uuid());
    r.ledger().append(entry).await?;
    let state_ids = |state: HypothesisState| {
        merged
            .hypotheses
            .iter()
            .filter(|h| h.state == state)
            .map(|h| h.id)
            .collect::<Vec<_>>()
    };
    let change = StrategyChange {
        previous: previous.as_ref().map(|v| v.id),
        current: Some(version.id),
        kept: state_ids(HypothesisState::Kept),
        retired: state_ids(HypothesisState::Retired),
        added: state_ids(HypothesisState::Added),
        at: ctx.now,
    };
    deps.transition_hook.apply(r, &change).await?;
    research::plan_in(deps, ctx, r, &version).await?;
    acknowledge(settings, next, cause, &merged, ctx);
    if cause == FrameCause::Bootstrap {
        // The bootstrap frame is made of fallbacks: both derivations are due at once (design
        // §4.10.5), whichever cards the write that caused it touched.
        let revision = settings.revision.max(1);
        settings.posting_revision = settings.posting_revision.max(revision);
        settings.prospecting_revision = settings.prospecting_revision.max(revision);
    }

    // Wakes (§4.10.8): only for the structural parts that changed.
    let changed = match &previous {
        Some(v) => kframe::changed(
            (&v.sections, &hypotheses),
            (&merged.sections, &merged.hypotheses),
        ),
        None => kframe::Changed::default(),
    };
    let mut needs: Vec<wake::Need> = Vec::new();
    match cause {
        FrameCause::Bootstrap => needs.extend([wake::CONTENT, wake::SOCIAL]),
        FrameCause::Rules if changed.paid => needs.push(wake::ADS),
        FrameCause::Derive => {
            if changed.topics {
                needs.push(wake::SOCIAL);
            }
            if changed.paid {
                needs.push(wake::ADS);
            }
            if changed.prospecting {
                needs.push(wake::RESEARCH);
            }
        }
        _ => {}
    }
    frame_wakes(r, ctx, &needs, waking).await?;

    Ok(Applied {
        applied: true,
        text_only: false,
        cause,
        number,
        version_id: Some(version.id),
        kept,
        added,
        retired,
        closing: merged.closing.clone(),
        kept_segments: merged.kept_segments.clone(),
        topics: topics(ws, &merged.hypotheses, &merged.closing),
        skipped: None,
    })
}

/// Records the wakes of an apply (design §4.10.8), with the reason `knowledge_applied`.
async fn frame_wakes(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    needs: &[wake::Need],
    waking: Waking,
) -> Result<(), AppError> {
    if needs.is_empty() {
        return Ok(());
    }
    match waking {
        Waking::InPerson => wake::request(r, ctx, needs, wake::WakeReason::KnowledgeApplied).await,
        Waking::For(person) => {
            wake::request_for(r, ctx, needs, wake::WakeReason::KnowledgeApplied, person).await
        }
        Waking::Nobody => Ok(()),
    }
}

/// Step 9: the parts a derivation answered are acknowledged up to the revision it read (never
/// back), the closing topics are as the merge left them, and the time of the apply.
fn acknowledge(
    settings: &mut KnowledgeSettings,
    next: &FrameParts,
    cause: FrameCause,
    merged: &Merged,
    ctx: &Ctx,
) {
    if cause == FrameCause::Derive {
        for part in &next.parts {
            let mark = match part {
                DerivePart::Posting => &mut settings.posting_derived,
                DerivePart::Prospecting => &mut settings.prospecting_derived,
            };
            *mark = (*mark).max(next.kb_revision);
        }
    }
    settings.closing_topic_ids = merged.closing.clone();
    settings.frame_applied_at = Some(ctx.now);
}

/// The live topics of `hypotheses` but the owner's request and the `closing` ones.
fn topics(
    ws: jt_tenancy::WorkspaceId,
    hypotheses: &[Hypothesis],
    closing: &[HypothesisId],
) -> Vec<TopicOut> {
    hypotheses
        .iter()
        .filter(|h| h.state.is_live() && !owner_request::is(ws, h.id) && !closing.contains(&h.id))
        .map(|h| TopicOut {
            id: h.id,
            title: h.title.clone(),
            segment_key: h.segment_key.clone(),
        })
        .collect()
}

/// `CONFLICT` when a status move changed no version: another transaction moved it first.
fn moved(rows: u64) -> Result<(), AppError> {
    if rows == 0 {
        return Err(AppError::conflict("the version has already moved"));
    }
    Ok(())
}

/// Appends an entry of `kind` to version `id`'s consultation log, by the caller.
async fn log(
    r: &mut dyn TenantRepos,
    deps: &Deps,
    ctx: &Ctx,
    id: StrategyVersionId,
    kind: ConsultationKind,
    text: &str,
) -> Result<(), AppError> {
    let mut entry =
        ConsultationEntry::new(id, kind, None, text.to_owned(), ctx.actor.clone(), ctx.now)
            .map_err(|e| AppError::internal(e.to_string()))?;
    entry.id = ConsultationEntryId(deps.ids.uuid());
    r.consultation().append(entry).await?;
    Ok(())
}

/// Every hypothesis id any version of the workspace holds.
async fn known_ids(r: &mut dyn TenantRepos) -> Result<BTreeSet<HypothesisId>, AppError> {
    let mut out = BTreeSet::new();
    for v in r.strategy().list().await? {
        out.extend(r.hypotheses().list(v.id).await?.into_iter().map(|h| h.id));
    }
    Ok(out)
}

/// The retained set *R* (design §4.10.2 step 2, D9): the topics a planned or ready post, a
/// binding, a queued budget move or an ad of a campaign not ended names, with the content types
/// their arms use, per lane.
pub(crate) async fn retained(r: &mut dyn TenantRepos) -> Result<Retained, AppError> {
    let arms = r.studio().list_arms().await?;
    let mut out = Retained::new();
    let add = |out: &mut Retained, hypothesis: HypothesisId, arm: jt_studio::ArmId| {
        let lanes = out.entry(hypothesis).or_default();
        if let Some(a) = arms.iter().find(|a| a.id == arm) {
            lanes
                .entry(a.key.lane)
                .or_default()
                .insert(a.key.content_type.clone());
        }
    };
    let slots = r
        .studio()
        .list_slots(SlotQuery {
            from: time::Date::MIN.midnight().assume_utc(),
            until: time::Date::MAX.midnight().assume_utc(),
            hypothesis_id: None,
            lane: None,
        })
        .await?;
    for s in slots
        .iter()
        .filter(|s| matches!(s.state, SlotState::Planned | SlotState::Ready))
    {
        add(&mut out, s.chain.hypothesis_id, s.chain.arm_id);
    }
    for b in r.studio().list_bindings().await? {
        add(&mut out, b.chain.hypothesis_id, b.chain.arm_id);
    }
    for m in r.studio().list_budget_moves().await? {
        if matches!(m.state, BudgetMoveState::Queued | BudgetMoveState::Sending) {
            add(&mut out, m.chain.hypothesis_id, m.chain.arm_id);
        }
    }
    for c in r.ads().list_campaigns(CampaignScope::Open, None).await? {
        if c.ended.is_some() {
            continue;
        }
        for ad in c.plan.iter().flat_map(|p| p.ads.iter()) {
            out.entry(ad.hypothesis_id).or_default();
        }
    }
    Ok(out)
}

/// The bootstrap (design §4.10.5, D4): when the workspace has no frame and its knowledge base
/// now has a live card with text, the bootstrap frame, in the caller's bundle (which holds the
/// draft, frame and settings locks: a write that may bootstrap takes them first). `approver` is
/// the person whose write it is; `waking` whom it wakes. Answers the frame written, if any.
pub(crate) async fn bootstrap_if_due(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    settings: &mut KnowledgeSettings,
    approver: UserId,
    waking: Waking,
) -> Result<Option<StrategyVersionId>, AppError> {
    if r.strategy().current_approved().await?.is_some() || is_empty(&r.knowledge().cards().await?) {
        return Ok(None);
    }
    let out = apply_locked(
        deps,
        ctx,
        r,
        settings,
        Request {
            cause: FrameCause::Bootstrap,
            next: &FrameParts::default(),
            approver: Some(approver),
            waking,
        },
    )
    .await?;
    Ok(out.version_id.filter(|_| out.applied))
}
