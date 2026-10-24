//! Pending work and slot context are projections of durable records, never another queue.
use super::chain::{active, capability_access};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        studio::{ApprovalTarget, SlotQuery},
    },
    usecases::{Deps, ledger_entry},
};
use jt_strategy::{Hypothesis, Identity, StrategyVersion};
use jt_studio::*;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrandRules {
    pub identity: Identity,
    pub prohibitions: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SlotOut {
    pub slot: Slot,
    pub piece: Option<Piece>,
    pub hypothesis: Hypothesis,
    pub brand_rules: BrandRules,
    pub learned: Arm,
    pub attempts: Vec<PublishAttempt>,
    pub measurements: Vec<Measurement>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingSlot {
    pub slot: Slot,
    pub overdue: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blocker {
    pub target: ApprovalTarget,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct PendingStudioOut {
    pub paid_alerts: Vec<serde_json::Value>,
    pub slots: Vec<PendingSlot>,
    pub approvals: Vec<ApprovalTarget>,
    pub budget_moves: Vec<BudgetMove>,
    pub blockers: Vec<Blocker>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotInput {
    pub slot_id: SlotId,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelSlotInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyInput {}

pub(crate) async fn gated(r: &mut dyn TenantRepos, ctx: &Ctx) -> Result<StrategyVersion, AppError> {
    ctx.require(Permission::StudioWork)?;
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    active(r).await?;
    Ok(frame)
}
pub async fn pending(d: &Deps, ctx: &Ctx) -> Result<PendingStudioOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(r.as_mut(), ctx).await?;
    pending_in(r.as_mut(), ctx).await
}
pub(crate) async fn pending_in(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
) -> Result<PendingStudioOut, AppError> {
    let control = r.studio_control().lock_control().await?;
    let slots = r
        .studio()
        .list_slots(SlotQuery {
            from: time::Date::MIN.midnight().assume_utc(),
            until: ctx.now + Duration::days(7),
            hypothesis_id: None,
            lane: None,
        })
        .await?;
    let mut out = PendingStudioOut::default();
    if control.is_braked(jt_strategy::LaneKind::Paid) {
        for binding in r.studio().list_bindings().await? {
            let status = r.studio_control().binding_control(binding.id).await?;
            out.paid_alerts.push(json!({"binding_id":binding.id,"reason":"paid_lane_braked","next_action":"review_budget_and_provider_status","residual_provider_exposure":status.as_ref().is_none_or(|s|!s.confirmed_paused())}));
        }
    }

    for s in slots {
        let target = ApprovalTarget::Slot(s.id);
        for a in r.studio().slot_evidence(s.id).await?.0 {
            let category = match a.outcome() {
                Some(
                    jt_studio::PublishOutcome::Failed(e)
                    | jt_studio::PublishOutcome::Unknown(e)
                    | jt_studio::PublishOutcome::Refused(e),
                ) => Some(*e),
                Some(jt_studio::PublishOutcome::Observed(_)) => {
                    Some(jt_studio::RedactedPublishError::Unknown)
                }
                _ => None,
            };
            if let Some(e) = category {
                let reason = serde_json::to_value(e)?
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned();
                out.blockers.push(Blocker {
                    target,
                    reason: format!("publish_{reason}"),
                    next_action: Some(
                        if matches!(
                            e,
                            jt_studio::RedactedPublishError::Auth
                                | jt_studio::RedactedPublishError::Permission
                        ) {
                            "reconnect_capability"
                        } else {
                            "review_publication_duplicate_risk"
                        }
                        .into(),
                    ),
                });
            }
        }

        if !matches!(s.state, SlotState::Planned | SlotState::Ready) {
            continue;
        }
        let arm = r
            .studio()
            .get_arm(s.chain.arm_id)
            .await?
            .ok_or_else(|| AppError::not_found("arm"))?;
        let cap = r
            .capabilities()
            .find(s.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;

        if control.is_braked(arm.key.lane) {
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: "studio_braked".into(),
            });
        }
        if let Err(e) = capability_access(&cap, ctx.now, true) {
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: e.message,
            });
        }
        let required = cap.policy.requires_human_approval
            || control
                .lanes
                .get(&arm.key.lane)
                .is_some_and(|l| l.requires_human_approval);
        if s.state == SlotState::Ready
            && required
            && r.studio().get_approval(target, s.revision).await?.is_none()
        {
            out.approvals.push(target);
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: "human_approval_required".into(),
            });
        }
        out.slots.push(PendingSlot {
            overdue: s.scheduled_at < ctx.now,
            slot: s,
        });
    }
    out.budget_moves = r
        .studio()
        .list_budget_moves()
        .await?
        .into_iter()
        .filter(|m| m.state == BudgetMoveState::Queued)
        .collect();
    for m in &out.budget_moves {
        let b = r
            .studio()
            .get_binding(m.binding_id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        let cap = r
            .capabilities()
            .find(b.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        let target = ApprovalTarget::BudgetMove(m.id);
        if super::chain::binding_current(&b, &cap).is_err() || !m.matches_binding_generation(&b) {
            out.blockers.push(Blocker {
                target,
                reason: "binding_stale".into(),
                next_action: Some("rebind_adset".into()),
            });
        }
        if control.is_braked(jt_strategy::LaneKind::Paid) {
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: "studio_braked".into(),
            });
        }
        if let Err(e) = capability_access(&cap, ctx.now, true) {
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: e.message,
            });
        }
        if (cap.policy.requires_human_approval
            || control
                .lanes
                .get(&jt_strategy::LaneKind::Paid)
                .is_some_and(|l| l.requires_human_approval))
            && r.studio().get_approval(target, m.revision).await?.is_none()
        {
            out.approvals.push(target);
            out.blockers.push(Blocker {
                next_action: None,
                target,
                reason: "human_approval_required".into(),
            });
        }
    }
    Ok(out)
}
pub async fn slot_get(d: &Deps, ctx: &Ctx, id: SlotId) -> Result<SlotOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(r.as_mut(), ctx).await?;
    slot_in(r.as_mut(), id, &frame).await
}
pub(crate) async fn slot_in(
    r: &mut dyn TenantRepos,
    id: SlotId,
    frame: &StrategyVersion,
) -> Result<SlotOut, AppError> {
    let slot = r
        .studio()
        .get_slot(id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    let learned = r
        .studio()
        .get_arm(slot.chain.arm_id)
        .await?
        .ok_or_else(|| AppError::not_found("arm"))?;
    let hypothesis = match r
        .hypotheses()
        .list(frame.id)
        .await?
        .into_iter()
        .find(|h| h.id == slot.chain.hypothesis_id)
    {
        Some(h) => h,
        None => r
            .hypotheses()
            .list(slot.chain.born_version_id)
            .await?
            .into_iter()
            .find(|h| h.id == slot.chain.hypothesis_id)
            .ok_or_else(|| AppError::not_found("hypothesis"))?,
    };
    let (attempts, measurements) = r.studio().slot_evidence(id).await?;
    let mut piece = r.studio().get_piece(id, slot.revision).await?;
    if piece.is_none() && slot.revision > 0 {
        piece = r.studio().get_piece(id, slot.revision - 1).await?;
    }
    if piece.is_none()
        && let Some(a) = attempts.last()
    {
        piece = r.studio().get_piece(id, a.piece().revision).await?;
    }
    Ok(SlotOut {
        slot,
        piece,
        hypothesis,
        brand_rules: BrandRules {
            identity: frame.sections.identity.clone(),
            prohibitions: frame.sections.prohibitions.clone(),
        },
        learned,
        attempts,
        measurements,
    })
}
pub async fn slot_cancel(d: &Deps, ctx: &Ctx, input: CancelSlotInput) -> Result<SlotOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    if input.reason.trim().is_empty() || input.reason.len() > 2000 {
        return Err(AppError::validation(
            "cancellation reason required (max 2000 bytes)",
            json!({"field":"reason"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(r.as_mut(), ctx).await?;
    r.studio_control().lock_control().await?;
    let s = r
        .studio()
        .retire_slot(input.slot_id, input.expected_revision, "cancelled")
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.slot_cancel",
        "studio_slot",
        s.id,
        json!({"reason":input.reason,"born_version_id":s.chain.born_version_id,"executed_version_id":frame.id,"revision":s.revision}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    let out = slot_in(r.as_mut(), s.id, &frame).await?;
    r.commit().await?;
    Ok(out)
}
