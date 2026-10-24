//! Public controls and durable, restart-safe Meta status reconciliation.
use super::chain::{active, capability_access, check_caps, refuse};
pub use crate::ports::studio::ApprovalTarget;
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{connectors::AdStatus as ConnectorStatus, studio::*},
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        ledger_entry,
    },
};
use jt_ledger::Actor;
use jt_strategy::LaneKind;
use jt_studio::{AdStatus, BindingStatusOutcome, ChainContext, validate_chain};
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrakeInput {
    pub engaged: bool,
    pub lane: Option<LaneKind>,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioPolicyInput {
    pub lane: LaneKind,
    pub requires_human_approval: bool,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalInput {
    pub target: ApprovalTarget,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct ApprovalOut {
    pub target: ApprovalTarget,
    pub revision: u64,
    pub approval: ApprovalReceipt,
}

pub async fn brake(d: &Deps, ctx: &Ctx, input: BrakeInput) -> Result<StudioControl, AppError> {
    ctx.require(Permission::StudioManage)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = r.strategy().lock_execution_frame().await?;
    active(r.as_mut()).await?;
    let c = r
        .studio_control()
        .set_brake(input.expected_revision, input.lane, input.engaged)
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.brake",
        "studio_control",
        ctx.workspace_id,
        json!({"engaged":input.engaged,"lane":input.lane,"revision":c.revision,"takeover":true}),
    )?;
    e.strategy_version_id = frame.map(|v| v.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    // Flags survive even when provider calls fail. The scheduler retries status reconciliation;
    // it never retries publication. Provider outcomes are separate durable evidence.
    let _ = reconcile_bindings(d, ctx.workspace_id).await;
    Ok(c)
}
pub async fn policy_set(
    d: &Deps,
    ctx: &Ctx,
    input: StudioPolicyInput,
) -> Result<StudioControl, AppError> {
    ctx.require(Permission::StudioManage)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    active(r.as_mut()).await?;
    let c = r
        .studio_control()
        .set_policy(
            input.expected_revision,
            input.lane,
            input.requires_human_approval,
        )
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.policy_set",
        "studio_control",
        ctx.workspace_id,
        json!({"lane":input.lane,"requires_human_approval":input.requires_human_approval,"revision":c.revision,"takeover":true}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(c)
}
pub async fn approve(d: &Deps, ctx: &Ctx, input: ApprovalInput) -> Result<ApprovalOut, AppError> {
    ctx.require(Permission::StudioManage)?;
    let Actor::Human { user_id } = ctx.actor else {
        return Err(human_required());
    };
    if !ctx.is_owner_or_manager() || ctx.agent_connection_id.is_some() {
        return Err(human_required());
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    active(r.as_mut()).await?;
    r.studio_control().lock_control().await?;
    let chain = match input.target {
        ApprovalTarget::Slot(id) => {
            r.studio()
                .get_slot(id)
                .await?
                .ok_or_else(|| AppError::not_found("slot"))?
                .chain
        }
        ApprovalTarget::BudgetMove(id) => {
            r.studio()
                .get_budget_move(id)
                .await?
                .ok_or_else(|| AppError::not_found("budget move"))?
                .chain
        }
    };
    if !r
        .hypotheses()
        .list(frame.id)
        .await?
        .iter()
        .any(|h| h.id == chain.hypothesis_id && h.state.is_live())
    {
        return Err(refuse("hypothesis_inactive"));
    }
    let receipt = ApprovalReceipt {
        revision: input.expected_revision,
        by: user_id,
        at: ctx.now,
    };
    if !receipt.approves(input.expected_revision) {
        return Err(refuse("invalid_approval_revision"));
    }
    r.studio()
        .approve_target(input.target, receipt.clone())
        .await?;
    let out = ApprovalOut {
        target: input.target,
        revision: input.expected_revision,
        approval: receipt,
    };
    let mut e = ledger_entry(
        ctx,
        "studio.approve",
        "studio_approval",
        chain.arm_id,
        json!({"target":out.target,"revision":out.revision,"born_version_id":chain.born_version_id,"executed_version_id":frame.id,"takeover":true}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(out)
}
fn human_required() -> AppError {
    AppError {
        code: ErrorCode::Forbidden,
        message: "owner or manager human required".into(),
        details: json!({"reason":"owner_or_manager_human"}),
    }
}

/// Serializes status calls per tenant across processes. A crash leaves pending/unknown evidence;
/// the next run reads provider status before deciding whether another status write is necessary.
pub async fn reconcile_bindings(d: &Deps, ws: WorkspaceId) -> Result<(), AppError> {
    let Some(_guard) = d
        .job_lock
        .try_acquire(&format!("jeeta.studio.control.{ws}"))
        .await?
    else {
        return Ok(());
    };
    let mut r = d.uow.tenant(ws).await?;
    active(r.as_mut()).await?;
    let bindings = r.studio().list_bindings().await?;
    drop(r);
    let mut first_error = None;
    for b in bindings {
        if let Err(e) = reconcile_one(d, &b).await {
            // Keep the pending intent and redacted failure visible; a failed set never prevents
            // another bound set from receiving its safety pause.
            record_refusal(d, &b).await?;
            if first_error.is_none() {
                first_error = Some(e);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}
async fn record_refusal(d: &Deps, b: &AdSetBinding) -> Result<(), AppError> {
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    let flags = r.studio_control().lock_control().await?;
    let old = r.studio_control().binding_control(b.id).await?;
    let record = BindingControl {
        binding_id: b.id,
        chain: b.chain.clone(),
        desired: if flags.is_braked(LaneKind::Paid) {
            AdStatus::Paused
        } else {
            AdStatus::Active
        },
        observed: old.as_ref().and_then(|o| o.observed),
        paused_by_brake: old.as_ref().is_some_and(|o| o.paused_by_brake),
        outcome: Some(BindingStatusOutcome::Failed),
        at: d.clock.now(),
    };
    r.studio_control().save_binding_control(record).await?;
    let ctx = Ctx {
        workspace_id: b.chain.workspace_id,
        actor: Actor::System {
            component: "studio.control".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: d.clock.now(),
        agent_connection_id: None,
    };
    r.ledger()
        .append(ledger_entry(
            &ctx,
            "studio.binding_refused",
            "studio_binding",
            b.id,
            json!({"born_version_id":b.chain.born_version_id,"outcome":"failed"}),
        )?)
        .await?;
    r.commit().await
}
async fn status_access(
    d: &Deps,
    b: &AdSetBinding,
) -> Result<(jt_capability::Capability, jt_connector::Credential), AppError> {
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    active(r.as_mut()).await?;
    let c = r
        .capabilities()
        .find(b.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if c.kind_key != "meta_ads"
        || !c
            .external_id
            .as_deref()
            .is_some_and(|id| super::chain::same_account("meta_ads", id, &b.account_id))
    {
        return Err(refuse("historical_account_changed"));
    }
    capability_access(&c, d.clock.now(), true)?;
    let sealed = r
        .capabilities()
        .read_sealed(c.id)
        .await?
        .ok_or_else(|| refuse("capability_unavailable"))?;
    let credential = open_credential(d, b.chain.workspace_id, &sealed)?;
    Ok((c, credential))
}
async fn reconcile_one(d: &Deps, b: &AdSetBinding) -> Result<(), AppError> {
    let ws = b.chain.workspace_id;
    let mut r = d.uow.tenant(ws).await?;
    let control = r.studio_control().lock_control().await?;
    let old = r.studio_control().binding_control(b.id).await?;
    r.commit().await?;
    let braked = control.is_braked(LaneKind::Paid);
    if !braked && !old.as_ref().is_some_and(|o| o.paused_by_brake) {
        return Ok(());
    }
    let ads = d
        .connectors
        .ads(jt_connector::Provider::Meta)
        .ok_or_else(|| refuse("connector_unavailable"))?;
    let (cap, cred) = status_access(d, b).await?;
    let account = ads
        .account_context(&cred, &adapter_public(&cap))
        .await
        .map_err(|_| refuse("ad_account_read_failed"))?;
    if !super::chain::same_account("meta_ads", &account.account_id, &b.account_id) {
        return Err(refuse("historical_account_changed"));
    }
    let (cap, cred) = status_access(d, b).await?;
    let sets = ads
        .list_adsets(&cred, &adapter_public(&cap))
        .await
        .map_err(|_| refuse("ad_status_read_failed"))?;
    let set = sets
        .iter()
        .find(|s| s.id == b.adset_id)
        .ok_or_else(|| refuse("adset_not_in_account"))?;
    let observed = match set.status.as_str() {
        "ACTIVE" => AdStatus::Active,
        "PAUSED" => AdStatus::Paused,
        _ => return Err(refuse("ad_status_unknown")),
    };
    if braked && observed == AdStatus::Paused && !old.as_ref().is_some_and(|o| o.paused_by_brake) {
        return Ok(());
    } // manual pause
    let desired = if braked {
        AdStatus::Paused
    } else {
        AdStatus::Active
    };
    let mut record = BindingControl {
        binding_id: b.id,
        chain: b.chain.clone(),
        desired,
        observed: Some(observed),
        paused_by_brake: braked || old.as_ref().is_some_and(|o| o.paused_by_brake),
        outcome: None,
        at: d.clock.now(),
    };
    let mut r = d.uow.tenant(ws).await?;
    let frame = r.strategy().lock_execution_frame().await?;
    let fresh = r.studio_control().lock_control().await?;
    active(r.as_mut()).await?;
    if fresh.revision != control.revision {
        return Err(refuse("control_changed"));
    }
    let current_cap = r
        .capabilities()
        .find(b.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    capability_access(&current_cap, d.clock.now(), true)?;
    if !current_cap
        .external_id
        .as_deref()
        .is_some_and(|id| super::chain::same_account("meta_ads", id, &b.account_id))
    {
        return Err(refuse("historical_account_changed"));
    }
    let sealed = r
        .capabilities()
        .read_sealed(b.capability_id)
        .await?
        .ok_or_else(|| refuse("capability_unavailable"))?;
    let dispatch_credential = open_credential(d, ws, &sealed)?;
    let mut reservation = None;
    if desired == AdStatus::Active {
        let v = frame.ok_or_else(AppError::strategy_required)?;
        let c = r
            .capabilities()
            .find(b.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        capability_access(&c, d.clock.now(), true)?;
        super::chain::hours(&c, d.clock.now())?;
        let arm = r
            .studio()
            .get_arm(b.chain.arm_id)
            .await?
            .ok_or_else(|| AppError::not_found("arm"))?;
        let birth = r
            .strategy()
            .find(b.chain.born_version_id)
            .await?
            .ok_or_else(|| AppError::not_found("birth strategy"))?;
        let birth_h = r.hypotheses().list(birth.id).await?;
        let hypotheses = r.hypotheses().list(v.id).await?;
        let groups: Vec<_> = r
            .capability_groups()
            .list()
            .await?
            .into_iter()
            .filter(|(_, ids)| ids.contains(&c.id))
            .map(|(g, _)| g.id.0)
            .collect();
        validate_chain(
            &b.chain,
            &ChainContext {
                workspace_id: ws,
                birth_version: &birth,
                birth_hypotheses: &birth_h,
                current_version: &v,
                hypotheses: &hypotheses,
                arm: &arm,
                target: &c,
                target_group_ids: &groups,
                supported_kinds: &["meta_ads"],
                lane: LaneKind::Paid,
            },
        )
        .map_err(|e| refuse(&e.to_string()))?;
        let daily = set
            .daily_budget_minor
            .ok_or_else(|| refuse("unknown_budget_cost"))?;
        if c.policy.requires_human_approval
            || fresh
                .lanes
                .get(&LaneKind::Paid)
                .is_some_and(|l| l.requires_human_approval)
        {
            let m = r
                .studio()
                .latest_budget_move(b.id)
                .await?
                .ok_or_else(|| refuse("resume_requires_budget_move_approval"))?;
            if m.chain != b.chain
                || m.daily_budget_minor != daily
                || m.currency != account.currency
                || !matches!(
                    m.state,
                    jt_studio::BudgetMoveState::Queued | jt_studio::BudgetMoveState::Succeeded
                )
            {
                return Err(refuse("resume_requires_budget_move_approval"));
            }
            m.check_approval(&jt_studio::StudioPolicy {
                expected_revision: m.revision,
                requires_human_approval: true,
                ..Default::default()
            })
            .map_err(|e| refuse(&e.to_string()))?;
        }
        if set.lifetime_budget_minor.is_some() {
            return Err(refuse("unsupported_lifetime_budget"));
        }
        check_caps(
            r.as_mut(),
            &v,
            &c,
            LaneKind::Paid,
            daily,
            &account.currency,
            d.clock.now(),
        )
        .await?;
        let lane = v
            .sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid && l.currency == account.currency)
            .ok_or_else(|| refuse("lane_budget_missing"))?;
        let period = match lane.period {
            jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
            jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
        };
        let (from, until) = jt_capability::period_window(period, d.clock.now());
        let key = format!(
            "studio.resume:{}:{}:{}",
            b.id,
            fresh.revision,
            from.unix_timestamp()
        );
        let previous = r.studio_budget().find_reservation(&key).await?;
        // Preserve the original payload when retrying a durable reservation. The current frame,
        // caps and live provider daily budget were rechecked above; changed payloads still refuse.
        let at = previous.as_ref().map_or(d.clock.now(), |p| p.request.at);
        let amount = daily
            .checked_mul((until.date() - at.date()).whole_days().max(1))
            .ok_or_else(|| refuse("unknown_budget_cost"))?;
        reservation = Some(
            r.studio_budget()
                .reserve(ReserveSpend {
                    workspace_id: ws,
                    capability_id: c.id,
                    budget_item_ids: c.budget_item_ids,
                    lane: LaneKind::Paid,
                    executed_version_id: v.id,
                    amount_minor: amount,
                    currency: account.currency,
                    evidence_key: key,
                    at,
                })
                .await?
                .id,
        );
    }
    // Persist intent before I/O, including on restart. Re-reading observed state resolves a lost
    // status response; unlike publishing, setting a known desired status is idempotent.
    r.studio_control()
        .save_binding_control(record.clone())
        .await?;
    r.commit().await?;
    let outcome = if observed == desired {
        BindingStatusOutcome::Applied { observed }
    } else {
        // The transaction just committed is the final admission fence. No further awaited
        // operation occurs before the provider call; concurrent changes are in-flight races.
        match ads
            .set_status(
                &dispatch_credential,
                &b.adset_id,
                if desired == AdStatus::Paused {
                    ConnectorStatus::Paused
                } else {
                    ConnectorStatus::Active
                },
            )
            .await
        {
            Ok(()) => BindingStatusOutcome::Applied { observed: desired },
            Err(_) => BindingStatusOutcome::Unknown,
        }
    };
    record = record.record(outcome, d.clock.now());
    if record.observed == Some(AdStatus::Active) && desired == AdStatus::Active {
        record.paused_by_brake = false;
    }
    let mut r = d.uow.tenant(ws).await?;
    r.studio_control()
        .save_binding_control(record.clone())
        .await?;
    if let Some(id) = reservation {
        r.studio_budget().settle(id, SpendOutcome::Unknown).await?;
    }
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: "studio.control".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now: d.clock.now(),
        agent_connection_id: None,
    };
    r.ledger().append(ledger_entry(&ctx,"studio.binding_status","studio_binding",b.id,json!({"born_version_id":b.chain.born_version_id,"desired":record.desired,"outcome":record.outcome}))?).await?;
    r.commit().await?;
    Ok(())
}
