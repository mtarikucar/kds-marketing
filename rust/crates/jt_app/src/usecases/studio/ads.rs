//! Externally created ad sets only. All provider writes follow a durable fenced reservation.
use super::{
    budget::{lane_period, reserve_connector_spend},
    chain::{self, ExecutionInput, active, capability_access, refuse},
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        connectors::{AdAccountContext, AdSet},
        studio::ApprovalTarget,
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        ledger_entry,
    },
};
use jt_capability::{Capability, CapabilityId};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_strategy::{HypothesisId, LaneKind};
use jt_studio::*;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdSetsQuery {
    pub capability_id: CapabilityId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindAdSetInput {
    pub hypothesis_id: HypothesisId,
    pub arm_id: ArmId,
    pub capability_id: CapabilityId,
    pub adset_id: String,
    pub request_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetMoveInput {
    pub binding_id: AdSetBindingId,
    pub daily_budget_minor: i64,
    pub currency: String,
    pub request_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BudgetMoveOut {
    pub move_: BudgetMove,
    pub outcome: BudgetMoveState,
    pub spend_vs_cap: serde_json::Value,
}
fn key(k: &str) -> Result<(), AppError> {
    if k.trim().is_empty() || k.len() > 200 {
        Err(AppError::validation(
            "invalid request key",
            json!({"field":"request_key"}),
        ))
    } else {
        Ok(())
    }
}

async fn eligible(
    r: &mut dyn TenantRepos,
    id: CapabilityId,
    now: time::OffsetDateTime,
) -> Result<Capability, AppError> {
    let v = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    active(r).await?;
    let c = r
        .capabilities()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if c.kind_key != "meta_ads" || !v.sections.paid_enabled || c.external_id.is_none() {
        return Err(refuse("paid_lane_unavailable"));
    }
    capability_access(&c, now, false)?;
    let groups = r.capability_groups().list().await?;
    if !v.sections.channels.iter().any(|choice| {
        (choice.channel == "meta_ads" || choice.channel == "any")
            && choice.group_id.is_none_or(|id| {
                groups
                    .iter()
                    .any(|(g, ids)| g.id.0 == id && ids.contains(&c.id))
            })
    }) {
        return Err(refuse("paid_channel_not_selected"));
    }
    Ok(c)
}
pub(crate) async fn validate_paid_or_organic_chain(
    r: &mut dyn TenantRepos,
    chain: &Chain,
    c: &Capability,
    lane: LaneKind,
) -> Result<(), AppError> {
    let current = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let birth = r
        .strategy()
        .find(chain.born_version_id)
        .await?
        .ok_or_else(|| AppError::not_found("birth strategy"))?;
    let bh = r.hypotheses().list(birth.id).await?;
    let hs = r.hypotheses().list(current.id).await?;
    let arm = r
        .studio()
        .get_arm(chain.arm_id)
        .await?
        .ok_or_else(|| AppError::not_found("arm"))?;
    let groups: Vec<_> = r
        .capability_groups()
        .list()
        .await?
        .into_iter()
        .filter(|(_, ids)| ids.contains(&c.id))
        .map(|(g, _)| g.id.0)
        .collect();
    validate_chain(
        chain,
        &ChainContext {
            workspace_id: c.workspace_id,
            birth_version: &birth,
            birth_hypotheses: &bh,
            current_version: &current,
            hypotheses: &hs,
            arm: &arm,
            target: c,
            target_group_ids: &groups,
            supported_kinds: if lane == LaneKind::Paid {
                &["meta_ads"]
            } else {
                &["x", "facebook_page", "instagram"]
            },
            lane,
        },
    )
    .map_err(|e| refuse(&e.to_string()))
}
async fn credential(
    d: &Deps,
    r: &mut dyn TenantRepos,
    c: &Capability,
) -> Result<Credential, AppError> {
    let sealed = r
        .capabilities()
        .read_sealed(c.id)
        .await?
        .ok_or_else(|| refuse("missing_credential"))?;
    open_credential(d, c.workspace_id, &sealed)
}
fn units(ctx: &AdAccountContext, c: &Capability) -> Result<(), AppError> {
    if !c
        .external_id
        .as_deref()
        .is_some_and(|id| chain::same_account(&c.kind_key, id, &ctx.account_id))
        || jt_strategy::validate_currency(&ctx.currency).is_err()
        || jt_connector::currency_minor_exponent(&ctx.currency) != Some(ctx.minor_unit_exponent)
        || ctx.timezone.parse::<chrono_tz::Tz>().is_err()
    {
        return Err(refuse("ad_account_units_mismatch"));
    }
    Ok(())
}
async fn listing(
    d: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
) -> Result<(Capability, AdAccountContext, Vec<AdSet>), AppError> {
    let (c, cred) = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let c = eligible(r.as_mut(), id, d.clock.now()).await?;
        let cred = credential(d, r.as_mut(), &c).await?;
        r.commit().await?;
        (c, cred)
    };
    let ads = d
        .connectors
        .ads(Provider::Meta)
        .ok_or_else(|| refuse("connector_unavailable"))?;
    let account = ads
        .account_context(&cred, &adapter_public(&c))
        .await
        .map_err(|_| refuse("account_context_unavailable"))?;
    units(&account, &c)?;
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let fresh = eligible(r.as_mut(), id, d.clock.now()).await?;
        if fresh != c {
            return Err(refuse("capability_changed"));
        }
        r.commit().await?;
    }
    let sets = ads
        .list_adsets(&cred, &adapter_public(&c))
        .await
        .map_err(|_| refuse("adset_membership_unavailable"))?;
    Ok((c, account, sets))
}
pub async fn adsets_list(d: &Deps, ctx: &Ctx, i: AdSetsQuery) -> Result<Vec<AdSet>, AppError> {
    ctx.require(Permission::StudioWork)?;
    Ok(listing(d, ctx, i.capability_id).await?.2)
}
pub async fn adset_bind(d: &Deps, ctx: &Ctx, i: BindAdSetInput) -> Result<AdSetBinding, AppError> {
    ctx.require(Permission::StudioWork)?;
    key(&i.request_key)?;
    if i.adset_id.trim().is_empty() || i.adset_id.len() > 200 {
        return Err(AppError::validation(
            "invalid ad set",
            json!({"field":"adset_id"}),
        ));
    }
    let payload = serde_json::to_value(&i)?;
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        eligible(r.as_mut(), i.capability_id, d.clock.now()).await?;
        r.studio_control().lock_control().await?;
        if let Some(out) = r
            .studio()
            .request_replay("studio.adset_bind", &i.request_key, &payload)
            .await?
        {
            let b = serde_json::from_value(out)?;
            let braked = reassert_binding_brake(r.as_mut(), &b, d.clock.now()).await?;
            r.commit().await?;
            if braked {
                let _ = super::control::reconcile_bindings(d, ctx.workspace_id).await;
            }
            return Ok(b);
        }
    }
    let (c, account, sets) = listing(d, ctx, i.capability_id).await?;
    let set = sets
        .into_iter()
        .find(|s| s.id == i.adset_id)
        .ok_or_else(|| AppError::not_found("account ad set"))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let fresh = eligible(r.as_mut(), i.capability_id, d.clock.now()).await?;
    if fresh != c {
        return Err(refuse("capability_changed"));
    }
    r.studio_control().lock_control().await?;
    if let Some(out) = r
        .studio()
        .request_replay("studio.adset_bind", &i.request_key, &payload)
        .await?
    {
        let b = serde_json::from_value(out)?;
        let braked = reassert_binding_brake(r.as_mut(), &b, d.clock.now()).await?;
        r.commit().await?;
        if braked {
            let _ = super::control::reconcile_bindings(d, ctx.workspace_id).await;
        }
        return Ok(b);
    }
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let old = r
        .studio()
        .list_bindings()
        .await?
        .into_iter()
        .find(|b| b.capability_id == c.id && b.adset_id == i.adset_id);
    let chain = Chain {
        workspace_id: ctx.workspace_id,
        born_version_id: old.as_ref().map_or(frame.id, |b| b.chain.born_version_id),
        hypothesis_id: i.hypothesis_id,
        arm_id: i.arm_id,
    };
    validate_paid_or_organic_chain(r.as_mut(), &chain, &c, LaneKind::Paid).await?;
    let was_active = set.status == "ACTIVE";
    let b = AdSetBinding {
        id: old.as_ref().map_or(AdSetBindingId(d.ids.uuid()), |b| b.id),
        chain,
        capability_id: c.id,
        account_id: account.account_id,
        adset_id: set.id,
        campaign_id: set.campaign_id,
        verified_at: c.last_verified_at,
        verification_evidence: c.evidence,
    };
    if let Some(old) = old {
        b.validate_refresh_of(&old)
            .map_err(|_| refuse("binding_identity_changed"))?;
    }
    let old_control = r.studio_control().binding_control(b.id).await?;
    let b = r.studio().bind_adset(b, &i.request_key).await?;
    let observed = match set.status.as_str() {
        "ACTIVE" => Some(AdStatus::Active),
        "PAUSED" => Some(AdStatus::Paused),
        _ => None,
    };
    // An unchanged refresh keeps its durable status intent. A new verification generation
    // invalidates old resume/consent, but preserves ownership of a prior safety pause.
    if r.studio_control().binding_control(b.id).await?.is_none() {
        r.studio_control()
            .save_binding_control(BindingControl {
                binding_id: b.id,
                chain: b.chain.clone(),
                desired: observed.unwrap_or(AdStatus::Paused),
                resume_operation_id: None,
                observed,
                paused_by_brake: old_control.is_some_and(|c| c.paused_by_brake),
                outcome: observed.map(|observed| BindingStatusOutcome::Applied { observed }),
                at: d.clock.now(),
            })
            .await?;
    }
    r.studio()
        .request_receipt(
            "studio.adset_bind",
            &i.request_key,
            &payload,
            &serde_json::to_value(&b)?,
        )
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.adset_bind",
        "studio_binding",
        b.id,
        json!({"chain":b.chain,"capability_id":b.capability_id,"adset_id":b.adset_id,"executed_version_id":frame.id}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    if was_active {
        brake_paid_in(
            r.as_mut(),
            &b,
            d.clock.now(),
            "new_binding_requires_budget_authorization",
        )
        .await?;
    }
    r.commit().await?;
    if was_active {
        let _ = super::control::reconcile_bindings(d, ctx.workspace_id).await;
    }
    Ok(b)
}
fn execution(m: &BudgetMove, b: &AdSetBinding) -> ExecutionInput {
    ExecutionInput {
        chain: m.chain.clone(),
        capability_id: b.capability_id,
        target: ApprovalTarget::BudgetMove(m.id),
        expected_revision: m.revision,
    }
}
pub async fn budget_move(
    d: &Deps,
    ctx: &Ctx,
    i: BudgetMoveInput,
) -> Result<BudgetMoveOut, AppError> {
    ctx.require(Permission::StudioManage)?;
    key(&i.request_key)?;
    if i.daily_budget_minor <= 0 || jt_strategy::validate_currency(&i.currency).is_err() {
        return Err(AppError::validation(
            "positive daily budget and currency required",
            json!({"field":"daily_budget_minor"}),
        ));
    }
    let payload = serde_json::to_value(&i)?;
    let id = BudgetMoveId::new_v7();
    let pending = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let frame = r
            .strategy()
            .lock_execution_frame()
            .await?
            .ok_or_else(AppError::strategy_required)?;
        active(r.as_mut()).await?;
        let b = r
            .studio()
            .get_binding(i.binding_id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        let c = eligible(r.as_mut(), b.capability_id, d.clock.now()).await?;
        chain::binding_current(&b, &c)?;
        let flags = r.studio_control().lock_control().await?;
        if let Some(saved) = r
            .studio()
            .request_replay("studio.budget_move", &i.request_key, &payload)
            .await?
        {
            let prior: BudgetMoveId = serde_json::from_value(saved)?;
            let m = r
                .studio()
                .get_budget_move(prior)
                .await?
                .ok_or_else(|| AppError::not_found("budget move"))?;
            drop(r);
            return output(d, ctx.workspace_id, m).await;
        }
        validate_paid_or_organic_chain(r.as_mut(), &b.chain, &c, LaneKind::Paid).await?;
        capability_access(&c, d.clock.now(), true)?;
        chain::hours(&c, d.clock.now())?;
        if flags.is_braked(LaneKind::Paid) {
            return Err(refuse("studio_braked"));
        }
        chain::check_caps(
            r.as_mut(),
            &frame,
            &c,
            LaneKind::Paid,
            i.daily_budget_minor,
            &i.currency,
            d.clock.now(),
        )
        .await?;
        let m = BudgetMove {
            id,
            chain: b.chain.clone(),
            binding_id: b.id,
            binding_verified_at: b.verified_at,
            binding_verification_evidence: b.verification_evidence.clone(),
            revision: 1,
            daily_budget_minor: i.daily_budget_minor,
            currency: i.currency,
            state: BudgetMoveState::Queued,
            approval: None,
            reservation_id: None,
            executed_version_id: None,
        };
        r.studio().save_budget_move(m, &i.request_key).await?;
        r.studio()
            .request_receipt("studio.budget_move", &i.request_key, &payload, &json!(id))
            .await?;
        let mut e = ledger_entry(
            ctx,
            "studio.budget_move",
            "studio_budget_move",
            id,
            json!({"chain":b.chain,"daily_budget_minor":i.daily_budget_minor,"executed_version_id":frame.id}),
        )?;
        e.strategy_version_id = Some(frame.id.0);
        r.ledger().append(e).await?;
        let pending = c.policy.requires_human_approval
            || flags
                .lanes
                .get(&LaneKind::Paid)
                .is_some_and(|l| l.requires_human_approval);
        r.commit().await?;
        pending
    };
    if !pending {
        dispatch_move(d, ctx, id).await?;
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let m = r
        .studio()
        .get_budget_move(id)
        .await?
        .ok_or_else(|| AppError::not_found("budget move"))?;
    drop(r);
    output(d, ctx.workspace_id, m).await
}
async fn output(d: &Deps, ws: WorkspaceId, m: BudgetMove) -> Result<BudgetMoveOut, AppError> {
    let mut r = d.uow.tenant(ws).await?;
    let rows = r.studio_budget().list_reservations().await?;
    let frame = r.strategy().current_approved().await?;
    let measurements = r.studio().list_measurements().await?;
    let lane = frame.as_ref().and_then(|v| {
        v.sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid && l.currency == m.currency)
    });
    let mut used = 0i128;
    let mut cap = None;
    if let Some(lane) = lane {
        cap = Some(lane.cap_minor);
        let (from, until) = jt_capability::period_window(lane_period(lane.period), d.clock.now());
        used = super::budget::occupied(
            &rows,
            &measurements,
            None,
            Some(LaneKind::Paid),
            None,
            &m.currency,
            from,
            until,
            d.clock.now(),
        );
        for item in r.budget().list_items().await? {
            if item.unit == jt_capability::Unit::Currency(m.currency.clone()) {
                used += i128::from(r.budget().spent_between(item.id, from, until).await?);
            }
        }
    }
    let held = m
        .reservation_id
        .and_then(|id| rows.iter().find(|(v, _)| v.id == id))
        .map(|(v, _)| v.request.amount_minor);
    Ok(BudgetMoveOut {
        outcome: m.state,
        spend_vs_cap: json!({"reserved_minor":held,"cap_minor":cap,"committed_and_observed_minor":used,"remaining_minor":cap.map(|cap|(i128::from(cap)-used).max(0)),"daily_budget_is_actual_spend":false}),
        move_: m,
    })
}
pub async fn dispatch_move(d: &Deps, ctx: &Ctx, id: BudgetMoveId) -> Result<(), AppError> {
    let (m, b, c, cred) = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let m = r
            .studio()
            .get_budget_move(id)
            .await?
            .ok_or_else(|| AppError::not_found("budget move"))?;
        if m.state != BudgetMoveState::Queued {
            return Ok(());
        }
        let b = r
            .studio()
            .get_binding(m.binding_id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        chain::authorize_execution_at(r.as_mut(), execution(&m, &b), d.clock.now()).await?;
        let c = eligible(r.as_mut(), b.capability_id, d.clock.now()).await?;
        let cred = credential(d, r.as_mut(), &c).await?;
        r.commit().await?;
        (m, b, c, cred)
    };
    let ads = d
        .connectors
        .ads(Provider::Meta)
        .ok_or_else(|| refuse("connector_unavailable"))?;
    let account = ads
        .account_context(&cred, &adapter_public(&c))
        .await
        .map_err(|_| refuse("account_context_unavailable"))?;
    units(&account, &c)?;
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        chain::authorize_execution_at(r.as_mut(), execution(&m, &b), d.clock.now()).await?;
        r.commit().await?;
    }
    let sets = ads
        .list_adsets(&cred, &adapter_public(&c))
        .await
        .map_err(|_| refuse("adset_membership_unavailable"))?;
    let set = sets
        .iter()
        .find(|s| s.id == b.adset_id && s.campaign_id == b.campaign_id)
        .ok_or_else(|| refuse("bound_set_not_in_account"))?;
    if account.currency != m.currency || set.lifetime_budget_minor.is_some() {
        return Err(refuse("ad_account_units_mismatch"));
    }
    let mut sent = m.clone();
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let permit =
            chain::authorize_execution_at(r.as_mut(), execution(&m, &b), d.clock.now()).await?;
        let fresh = r
            .capabilities()
            .find(c.id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        if fresh != c {
            return Err(refuse("capability_changed"));
        }
        let frame = r
            .strategy()
            .lock_execution_frame()
            .await?
            .ok_or_else(AppError::strategy_required)?;
        let lane = frame
            .sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid && l.currency == m.currency)
            .ok_or_else(|| refuse("lane_budget_missing"))?;
        let period = lane_period(lane.period);
        let (_, until) = jt_capability::period_window(period, d.clock.now());
        let reservations = r.studio_budget().list_reservations().await?;
        let previous = reservations
            .iter()
            .filter(|(old, o)| {
                old.request.binding_id == Some(b.id)
                    && !matches!(o, Some(SpendOutcome::Refused))
                    && !reservations.iter().any(|(next, o)| {
                        next.request.replaces == Some(old.id)
                            && !matches!(o, Some(SpendOutcome::Refused))
                    })
            })
            .max_by_key(|(old, _)| old.id);
        if previous.is_some_and(|(_, o)| !matches!(o, Some(SpendOutcome::Applied { .. }))) {
            return Err(refuse("previous_write_unresolved"));
        }
        let reservation = reserve_connector_spend(
            r.as_mut(),
            ReserveSpend {
                binding_id: Some(b.id),
                workspace_id: ctx.workspace_id,
                capability_id: c.id,
                budget_item_ids: c.budget_item_ids.clone(),
                lane: LaneKind::Paid,
                executed_version_id: permit.strategy_version_id,
                amount_minor: daily_liability(m.daily_budget_minor, period, d.clock.now(), until)
                    .map_err(|_| refuse("invalid_daily_liability"))?,
                daily_budget_minor: Some(m.daily_budget_minor),
                currency: m.currency.clone(),
                evidence_key: format!("budget.move:{}", m.id),
                at: d.clock.now(),
                chain: Some(m.chain.clone()),
                replaces: previous.map(|(old, _)| old.id),
            },
        )
        .await?;
        sent.state = BudgetMoveState::Sending;
        sent.reservation_id = Some(reservation.id);
        sent.executed_version_id = Some(permit.strategy_version_id);
        r.studio()
            .transition_budget_move(sent.clone(), BudgetMoveState::Queued)
            .await?;
        let mut e = ledger_entry(
            ctx,
            "studio.budget_move.claimed",
            "studio_budget_move",
            sent.id,
            json!({"move":sent}),
        )?;
        e.strategy_version_id = sent.executed_version_id.map(|v| v.0);
        r.ledger().append(e).await?;
        r.commit().await?;
    }
    let result = ads
        .set_daily_budget(&cred, &b.adset_id, m.daily_budget_minor)
        .await;
    let outcome = match result {
        Ok(()) => {
            sent.state = BudgetMoveState::Succeeded;
            SpendOutcome::Applied {
                evidence_key: format!("budget.move:{}", m.id),
            }
        }
        Err(
            ConnectorError::Auth { .. }
            | ConnectorError::Permission { .. }
            | ConnectorError::Permanent { .. },
        ) => {
            sent.state = BudgetMoveState::Failed;
            SpendOutcome::Refused
        }
        Err(_) => {
            sent.state = BudgetMoveState::Unknown;
            SpendOutcome::Unknown
        }
    };
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    r.studio_control().lock_control().await?;
    r.studio_budget()
        .settle(sent.reservation_id.expect("reserved"), outcome)
        .await?;
    r.studio()
        .transition_budget_move(sent.clone(), BudgetMoveState::Sending)
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.budget_move.outcome",
        "studio_budget_move",
        sent.id,
        json!({"move":sent,"residual_provider_exposure":sent.state==BudgetMoveState::Unknown}),
    )?;
    e.strategy_version_id = sent.executed_version_id.map(|v| v.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(())
}
/// Used by both adapters so payload mutation can never hide inside a state transition.
pub fn validate_move_transition(
    old: &BudgetMove,
    new: &BudgetMove,
    expected: BudgetMoveState,
) -> Result<(), AppError> {
    let mut allowed = old.clone();
    allowed.state = new.state;
    if expected == BudgetMoveState::Queued {
        allowed.reservation_id = new.reservation_id;
        allowed.executed_version_id = new.executed_version_id;
    }
    if old.state != expected
        || allowed != *new
        || !matches!(
            (old.state, new.state),
            (BudgetMoveState::Queued, BudgetMoveState::Sending)
                | (
                    BudgetMoveState::Sending,
                    BudgetMoveState::Succeeded | BudgetMoveState::Failed | BudgetMoveState::Unknown
                )
                | (
                    BudgetMoveState::Unknown,
                    BudgetMoveState::Succeeded | BudgetMoveState::Failed
                )
        )
    {
        return Err(refuse("budget_move_state_changed"));
    }
    Ok(())
}
pub async fn dispatch_due(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let moves = {
        let mut r = d.uow.tenant(ws).await?;
        r.studio().list_budget_moves().await?
    };
    let mut changed = 0;
    for m in moves
        .into_iter()
        .filter(|m| m.state == BudgetMoveState::Queued)
    {
        let ctx = super::measure::system_ctx(ws, d.clock.now());
        match dispatch_move(d, &ctx, m.id).await {
            Ok(()) => changed += 1,
            Err(e) if e.code != crate::error::ErrorCode::Internal => {}
            Err(e) => return Err(e),
        }
    }
    Ok(changed)
}

/// Read-back is evidence of the current absolute setting, never permission to retry a write.
pub(crate) async fn reconcile_budget(
    d: &Deps,
    b: &AdSetBinding,
    set: &AdSet,
    currency: &str,
) -> Result<(), AppError> {
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    r.studio_control().lock_control().await?;
    let moves = r.studio().list_budget_moves().await?;
    if let Some(mut m) = moves
        .into_iter()
        .filter(|m| {
            m.binding_id == b.id
                && matches!(m.state, BudgetMoveState::Sending | BudgetMoveState::Unknown)
        })
        .max_by_key(|m| m.id)
        && set.daily_budget_minor == Some(m.daily_budget_minor)
        && set.lifetime_budget_minor.is_none()
        && currency == m.currency
    {
        let before = m.state;
        m.state = BudgetMoveState::Succeeded;
        r.studio_budget()
            .settle(
                m.reservation_id
                    .ok_or_else(|| refuse("reservation_missing"))?,
                SpendOutcome::Applied {
                    evidence_key: format!("budget.move:{}", m.id),
                },
            )
            .await?;
        r.studio().transition_budget_move(m.clone(), before).await?;
        let ctx = super::measure::system_ctx(b.chain.workspace_id, d.clock.now());
        r.ledger().append(ledger_entry(&ctx,"studio.budget_move.reconciled","studio_budget_move",m.id,json!({"chain":m.chain,"executed_version_id":m.executed_version_id,"daily_budget_minor":m.daily_budget_minor}))?).await?;
    }
    r.commit().await
}

/// Period/frame refresh uses the same locked caps. No increase is allocated automatically.
/// On refusal the existing lane is braked before a safety pause is attempted.
pub async fn recheck_periods(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let bindings = {
        let mut r = d.uow.tenant(ws).await?;
        r.studio().list_bindings().await?
    };
    let mut changed = 0;
    for b in bindings {
        let result = refresh_period(d, &b).await;
        match result {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(_) => {
                brake_paid(d, &b, "period_or_frame_budget_refused").await?;
                // Flags are durable before any pause I/O; failed pauses retain provider exposure.
                let _ = super::control::reconcile_bindings(d, ws).await;
            }
        }
    }
    Ok(changed)
}
async fn refresh_period(d: &Deps, b: &AdSetBinding) -> Result<bool, AppError> {
    let now = d.clock.now();
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    let frame = r.strategy().lock_execution_frame().await?;
    let rows = r.studio_budget().list_reservations().await?;
    let Some((old, _)) = rows
        .iter()
        .filter(|(r, outcome)| {
            r.request.binding_id == Some(b.id) && !matches!(outcome, Some(SpendOutcome::Refused))
        })
        .filter(|(r, _)| {
            !rows.iter().any(|(n, o)| {
                n.request.replaces == Some(r.id) && !matches!(o, Some(SpendOutcome::Refused))
            })
        })
        .max_by_key(|(r, _)| r.id)
    else {
        // No reservation is not evidence that the externally managed set is inactive.
        return Err(refuse("binding_requires_budget_authorization"));
    };
    let frame = frame.ok_or_else(AppError::strategy_required)?;
    if old.request.executed_version_id == frame.id
        && old.lane_window.is_some_and(|(_, until)| now < until)
        && old.item_windows.values().all(|(_, until)| now < *until)
    {
        return Ok(false);
    }
    let c = r
        .capabilities()
        .lock(b.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let flags = r.studio_control().lock_control().await?;
    if flags.is_braked(LaneKind::Paid) {
        return Ok(false);
    }
    chain::binding_current(b, &c)?;
    capability_access(&c, now, true)?;
    let daily = old
        .request
        .daily_budget_minor
        .ok_or_else(|| refuse("daily_budget_missing"))?;
    if c.policy.requires_human_approval
        || flags
            .lanes
            .get(&LaneKind::Paid)
            .is_some_and(|l| l.requires_human_approval)
    {
        let m = r
            .studio()
            .latest_budget_move(b.id)
            .await?
            .ok_or_else(|| refuse("approval_required"))?;
        m.check_approval(&StudioPolicy {
            expected_revision: m.revision,
            requires_human_approval: true,
            ..Default::default()
        })
        .map_err(|_| refuse("approval_required"))?;
        if m.daily_budget_minor != daily {
            return Err(refuse("approval_payload_changed"));
        }
    }
    let lane = frame
        .sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == LaneKind::Paid && l.currency == old.request.currency)
        .ok_or_else(|| refuse("lane_budget_missing"))?;
    let period = lane_period(lane.period);
    let (_, until) = jt_capability::period_window(period, now);
    let req = ReserveSpend {
        binding_id: Some(b.id),
        chain: Some(b.chain.clone()),
        replaces: Some(old.id),
        at: now,
        evidence_key: format!(
            "rollover:{}:{}:{}:{}",
            b.id,
            frame.id,
            until.unix_timestamp(),
            now.date()
        ),
        executed_version_id: frame.id,
        amount_minor: daily_liability(daily, period, now, until)
            .map_err(|_| refuse("invalid_daily_liability"))?,
        budget_item_ids: c.budget_item_ids,
        ..old.request.clone()
    };
    let saved = reserve_connector_spend(r.as_mut(), req).await?;
    r.studio_budget()
        .settle(
            saved.id,
            SpendOutcome::Applied {
                evidence_key: saved.request.evidence_key,
            },
        )
        .await?;
    let ctx = super::measure::system_ctx(b.chain.workspace_id, now);
    r.ledger()
        .append(ledger_entry(
            &ctx,
            "studio.budget_rollover",
            "studio_binding",
            b.id,
            json!({"chain":b.chain,"executed_version_id":frame.id,"reservation_id":saved.id}),
        )?)
        .await?;
    r.commit().await?;
    Ok(true)
}
async fn reassert_binding_brake(
    r: &mut dyn TenantRepos,
    b: &AdSetBinding,
    now: time::OffsetDateTime,
) -> Result<bool, AppError> {
    let current = r
        .studio()
        .get_binding(b.id)
        .await?
        .ok_or_else(|| AppError::not_found("binding"))?;
    let frame = r.strategy().current_approved().await?;
    let rows = r.studio_budget().list_reservations().await?;
    let moves = r.studio().list_budget_moves().await?;
    let control = r.studio_control().binding_control(b.id).await?;
    let resume_prefix = control
        .as_ref()
        .filter(|c| {
            c.desired == AdStatus::Active
                && matches!(
                    c.outcome,
                    Some(BindingStatusOutcome::Applied {
                        observed: AdStatus::Active
                    })
                )
        })
        .and_then(|c| c.resume_operation_id)
        .map(|id| format!("studio.resume:{}:{id}:", b.id));
    let authorized = rows.iter().any(|(reservation, outcome)| {
        if reservation.request.binding_id != Some(b.id)
            || reservation.request.chain.as_ref() != Some(&current.chain)
            || !matches!(outcome, Some(SpendOutcome::Applied { .. }))
            || frame
                .as_ref()
                .is_none_or(|v| reservation.request.executed_version_id != v.id)
            || !reservation
                .lane_window
                .is_some_and(|(from, until)| from <= now && now < until)
            || !reservation
                .item_windows
                .values()
                .all(|(from, until)| *from <= now && now < *until)
            || rows.iter().any(|(next, outcome)| {
                next.request.replaces == Some(reservation.id)
                    && !matches!(outcome, Some(SpendOutcome::Refused))
            })
        {
            return false;
        }
        // Rollover carries its original authorization forward, never across a binding
        // verification change. A current resume intent is cleared on binding refresh.
        let mut ancestor = reservation;
        for _ in 0..rows.len() {
            if moves.iter().any(|m| {
                m.binding_id == current.id
                    && m.state == BudgetMoveState::Succeeded
                    && m.binding_verified_at == current.verified_at
                    && m.binding_verification_evidence == current.verification_evidence
                    && m.reservation_id == Some(ancestor.id)
            }) || resume_prefix
                .as_ref()
                .is_some_and(|prefix| ancestor.request.evidence_key.starts_with(prefix))
            {
                return true;
            }
            let Some(previous) = ancestor
                .request
                .replaces
                .and_then(|id| rows.iter().find(|(row, _)| row.id == id))
            else {
                return false;
            };
            ancestor = &previous.0;
        }
        false
    });
    if !authorized
        && control
            .as_ref()
            .is_none_or(|c| c.observed != Some(AdStatus::Paused) || c.paused_by_brake)
    {
        brake_paid_in(r, b, now, "binding_requires_budget_authorization").await?;
        return Ok(true);
    }
    Ok(false)
}

pub(crate) async fn brake_paid(d: &Deps, b: &AdSetBinding, reason: &str) -> Result<(), AppError> {
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    brake_paid_in(r.as_mut(), b, d.clock.now(), reason).await?;
    r.commit().await
}

/// Persist safety intent alongside the evidence/binding, before any provider I/O.
pub(super) async fn brake_paid_in(
    r: &mut dyn TenantRepos,
    b: &AdSetBinding,
    now: time::OffsetDateTime,
    reason: &str,
) -> Result<(), AppError> {
    let flags = r.studio_control().lock_control().await?;
    if !flags.is_braked(LaneKind::Paid) {
        r.studio_control()
            .set_brake(flags.revision, Some(LaneKind::Paid), true)
            .await?;
        let ctx = super::measure::system_ctx(b.chain.workspace_id, now);
        r.ledger().append(ledger_entry(&ctx,"studio.paid.refused","studio_binding",b.id,json!({"chain":b.chain,"reason":reason,"requires_action":true,"residual_provider_exposure":true}))?).await?;
    }
    Ok(())
}
