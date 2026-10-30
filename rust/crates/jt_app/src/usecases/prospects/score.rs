//! Scores against the approved strategy's rubric and the pool's decisions (spec §3.2, §3.4;
//! §7.1 `prospects.score`, `prospects.decide`).

use jt_ledger::Actor;
use jt_prospects::{
    Decision, DecisionKind, ProspectId, ProspectStatus, RejectReason, ScoreInput, StatusEvent,
    next_status, purge_after,
};
use jt_strategy::Rubric;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{invalid_from, leads_policy, no_such_prospect, record, recorder, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::prospects::{ScoreRow, Updated};
use crate::usecases::prospects::pool::{ProspectOut, stale};
use crate::usecases::{Deps, invalid};

/// The rubric's digest: lowercase hex SHA-256 of its JSON (fields in declared order, criteria in
/// order). Two strategy versions with the same rubric share it, so their scores compare.
pub fn rubric_digest(rubric: &Rubric) -> String {
    let bytes = serde_json::to_vec(rubric).unwrap_or_default();
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(&bytes) {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// What `prospects.score` answers: the score as stored and the prospect's status after it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScoreOut {
    pub score: ScoreRow,
    pub status: ProspectStatus,
    /// Whether this score qualified the prospect (at or above the rubric's `qualify_at`).
    pub qualified: bool,
}

/// The context the pool's automatic moves are recorded under: the system, in the caller's
/// workspace at the caller's time.
fn system(ctx: &Ctx, component: &str) -> Ctx {
    Ctx {
        actor: Actor::System {
            component: component.into(),
        },
        ..ctx.clone()
    }
}

/// `jeeta.prospects.score`: appends a score computed under the approved rubric (its digest must
/// be the one sent), and qualifies a `new` prospect whose score reaches `qualify_at`. A lower
/// score never un-qualifies.
pub async fn score(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    input: ScoreInput,
) -> Result<ScoreOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let approved = r.strategy().current_approved().await?;
    let Some(version) = approved.filter(|v| !v.sections.prospecting.rubric.criteria.is_empty())
    else {
        return Err(refused(
            ErrorCode::Conflict,
            "prospecting_off",
            "the approved strategy has no prospecting rubric",
            json!({}),
        ));
    };
    let rubric = &version.sections.prospecting.rubric;
    let current = rubric_digest(rubric);
    if input.rubric_digest != current {
        return Err(refused(
            ErrorCode::Conflict,
            "rubric_mismatch",
            "the score was computed under another rubric: read the playbook again",
            json!({ "current": current }),
        ));
    }
    jt_prospects::validate_score(&input, rubric).map_err(invalid_from)?;
    let p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
    if !matches!(p.status, ProspectStatus::New | ProspectStatus::Qualified) {
        return Err(refused(
            ErrorCode::Conflict,
            "not_scorable",
            "only new and qualified prospects are scored",
            json!({ "status": p.status.key() }),
        ));
    }
    let row = ScoreRow {
        id: deps.ids.uuid(),
        prospect_id: id,
        score: input.score,
        reasons: input.reasons.into_iter().map(|r| r.into_reason()).collect(),
        rubric_digest: current.clone(),
        strategy_version_id: Some(version.id),
        recorder,
        at: ctx.now,
    };
    r.prospects().record_score(&row).await?;
    record(
        r.as_mut(),
        ctx,
        "prospects.scored",
        id,
        json!({ "prospect_id": id, "score": row.score, "digest": current }),
    )
    .await?;
    let mut status = p.status;
    let qualified = p.status == ProspectStatus::New && row.score >= rubric.qualify_at;
    if qualified {
        let policy = leads_policy(r.as_mut()).await?;
        status = ProspectStatus::Qualified;
        let purge = purge_after(&policy.prospects, status, None, ctx.now);
        match r
            .prospects()
            .set_status(id, status, None, purge, ctx.now, p.revision)
            .await?
        {
            Updated::Ok => {}
            Updated::Stale | Updated::DuplicateKey { .. } => return Err(stale(p.revision + 1)),
        }
        record(
            r.as_mut(),
            &system(ctx, "prospects.auto_qualify"),
            "prospects.qualified",
            id,
            json!({ "prospect_id": id, "auto": true, "score": row.score }),
        )
        .await?;
    }
    r.commit().await?;
    Ok(ScoreOut {
        score: row,
        status,
        qualified,
    })
}

/// The decision `prospects.decide` makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecideKind {
    Qualify,
    Reject,
    /// A rejected prospect back to `new`: a person with `prospects.manage` only.
    Reopen,
}

/// `jeeta.prospects.decide`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecideInput {
    pub decision: DecideKind,
    /// A rejection's reason; required to reject.
    #[serde(default)]
    pub reason: Option<RejectReason>,
    /// Required with reason `other`; at most 500 characters.
    #[serde(default)]
    pub note: Option<String>,
    pub expected_revision: u32,
}

/// The longest decision note, in characters.
pub(crate) const MAX_DECISION_NOTE_CHARS: usize = 500;

/// A decision's note: trimmed, at most [`MAX_DECISION_NOTE_CHARS`], required when `needed`.
pub(crate) fn decision_note(note: Option<&str>, needed: bool) -> Result<String, AppError> {
    let note = note.unwrap_or_default().trim().to_owned();
    if note.chars().count() > MAX_DECISION_NOTE_CHARS {
        return Err(invalid("note", "a note is at most 500 characters"));
    }
    if needed && note.is_empty() {
        return Err(invalid("note", "reason other needs a note"));
    }
    Ok(note)
}

/// `FORBIDDEN {reason: human_only}` unless a person makes the call.
pub(crate) fn human_only(ctx: &Ctx, what: &str) -> Result<(), AppError> {
    if matches!(ctx.actor, Actor::Human { .. }) {
        Ok(())
    } else {
        Err(refused(
            ErrorCode::Forbidden,
            "human_only",
            &format!("only a person can {what}"),
            json!({}),
        ))
    }
}

/// `jeeta.prospects.decide`: qualify a new prospect, reject a new or qualified one with a
/// reason, or (a person with `prospects.manage`) reopen a rejection.
pub async fn decide(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    input: DecideInput,
) -> Result<ProspectOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    let event = match input.decision {
        DecideKind::Qualify => StatusEvent::Qualify,
        DecideKind::Reject => StatusEvent::Reject {
            reason: input
                .reason
                .ok_or_else(|| invalid("reason", "a rejection needs a reason"))?,
        },
        DecideKind::Reopen => {
            human_only(ctx, "reopen a rejected prospect")?;
            ctx.require(Permission::ProspectsManage)?;
            StatusEvent::Reopen
        }
    };
    let note = decision_note(
        input.note.as_deref(),
        matches!(
            event,
            StatusEvent::Reject {
                reason: RejectReason::Other
            }
        ),
    )?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
    if p.revision != input.expected_revision {
        return Err(stale(p.revision));
    }
    let to = next_status(p.status, &event).map_err(|e| {
        refused(
            ErrorCode::Conflict,
            "invalid_transition",
            &e.to_string(),
            json!({ "status": e.from }),
        )
    })?;
    let decision = match event {
        StatusEvent::Reject { reason } => Some(Decision {
            kind: DecisionKind::Rejected(reason),
            note,
            by: recorder,
            at: ctx.now,
        }),
        _ => None,
    };
    let policy = leads_policy(r.as_mut()).await?;
    let purge = purge_after(
        &policy.prospects,
        to,
        decision.as_ref().map(|d| d.at),
        ctx.now,
    );
    match r
        .prospects()
        .set_status(id, to, decision.as_ref(), purge, ctx.now, p.revision)
        .await?
    {
        Updated::Ok => {}
        Updated::Stale | Updated::DuplicateKey { .. } => return Err(stale(p.revision + 1)),
    }
    let (action, payload) = match event {
        StatusEvent::Qualify => (
            "prospects.qualified",
            json!({ "prospect_id": id, "auto": false }),
        ),
        StatusEvent::Reject { reason } => (
            "prospects.rejected",
            json!({ "prospect_id": id, "reason": reason.key() }),
        ),
        _ => ("prospects.reopened", json!({ "prospect_id": id })),
    };
    record(r.as_mut(), ctx, action, id, payload).await?;
    let prospect = r.prospects().get(id).await?.ok_or_else(no_such_prospect)?;
    r.commit().await?;
    Ok(ProspectOut { prospect })
}
