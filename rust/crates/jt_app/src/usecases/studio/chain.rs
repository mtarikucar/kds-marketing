//! Short-lived execution fences and separate historical read authority.
use crate::{
    error::{AppError, ErrorCode},
    ports::{TenantRepos, studio::ApprovalTarget},
    usecases::Deps,
};
use chrono::{Datelike, Timelike};
use jt_capability::{Capability, CapabilityId, EffectiveStatus, effective_status};
use jt_strategy::{LaneKind, StrategyVersionId};
use jt_studio::{AdSetBindingId, Chain, ChainContext, PublicationId, StudioPolicy, validate_chain};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Clone, Debug)]
pub struct ExecutionInput {
    pub chain: Chain,
    pub capability_id: CapabilityId,
    pub target: ApprovalTarget,
    pub expected_revision: u64,
}
#[derive(Clone, Debug)]
pub struct ExecutionPermit {
    pub strategy_version_id: StrategyVersionId,
    pub control_revision: u64,
    pub lane: LaneKind,
}
#[derive(Clone, Copy, Debug)]
pub enum HistoricalTarget {
    Publication(PublicationId),
    Binding(AdSetBindingId),
}
/// Read/reconcile authority only; deliberately not convertible into ExecutionPermit.
#[derive(Clone, Debug)]
pub struct MeasurementPermit {
    pub chain: Chain,
    pub capability: Capability,
}
/// The kinds the organic lane publishes to.
pub(crate) const ORGANIC_KINDS: &[&str] = &[
    "x",
    "instagram",
    "facebook_page",
    "tiktok",
    "linkedin_member",
    "linkedin_page",
];
pub(crate) fn same_account(kind: &str, left: &str, right: &str) -> bool {
    jt_capability::canonical_external_id(kind, left)
        == jt_capability::canonical_external_id(kind, right)
}
pub(crate) fn refuse(reason: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: reason.into(),
        details: json!({"reason":reason}),
    }
}
pub(crate) async fn active(r: &mut dyn TenantRepos) -> Result<WorkspaceId, AppError> {
    let w = r.workspace().get().await?;
    if w.status != WorkspaceStatus::Active {
        return Err(AppError::workspace_inactive(w.status));
    }
    Ok(w.id)
}
/// Fail closed on stale, revoked, expired or scope-limited connector access. The metadata is
/// written from the sealed credential by the connector use cases, never accepted from callers.
pub(crate) fn capability_access(
    c: &Capability,
    now: OffsetDateTime,
    write: bool,
) -> Result<(), AppError> {
    if effective_status(c, now) != EffectiveStatus::Verified
        || !c.has_sealed_config
        || c.connector_public["reconnect_required"] == true
    {
        return Err(refuse("capability_unavailable"));
    }
    let access = &c.connector_public["access"];
    if !access["expires_at"].is_null() {
        let expiry = access["expires_at"]
            .as_str()
            .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
            .ok_or_else(|| refuse("invalid_access_expiry"))?;
        if expiry <= now {
            return Err(refuse("access_expired"));
        }
    }
    let scopes: Vec<_> = access["scopes"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let required: &[&str] = match (c.kind_key.as_str(), write) {
        ("x", true) => &["tweet.write"],
        ("x", false) => &["tweet.read"],
        ("meta_ads", true) => &["ads_management"],
        ("meta_ads", false) => &["ads_read", "ads_management"],
        ("instagram", true) => &[
            "instagram_content_publish",
            "instagram_business_content_publish",
        ],
        ("instagram", false) => &[
            "instagram_manage_insights",
            "instagram_business_manage_insights",
        ],
        ("facebook_page", true) => &["pages_manage_posts"],
        ("facebook_page", false) => &["read_insights", "pages_read_engagement"],
        ("tiktok", true) => &["video.publish"],
        // Counters need `video.list` (posts) or `user.info.stats` (the account); a publication's
        // status (TikTok publishes in the background) is read with `video.publish`.
        ("tiktok", false) => &["video.list", "user.info.stats", "video.publish"],
        ("linkedin_member", true) => &["w_member_social"],
        // LinkedIn has no read API for a member's posts: reading asks for no scope, and the
        // adapter answers that it has no counters (measurement records the refusal once).
        ("linkedin_member", false) => &[],
        ("linkedin_page", true) => &["w_organization_social"],
        // Share statistics and follower counts need the admin scope (the page ACL behind
        // them), not `r_organization_social`.
        ("linkedin_page", false) => &["rw_organization_admin"],
        _ => return Err(refuse("unsupported_studio_capability")),
    };
    if !required.is_empty() && !required.iter().any(|s| scopes.contains(s)) {
        return Err(refuse("credential_scope_missing"));
    }
    Ok(())
}
pub(crate) fn hours(c: &Capability, now: OffsetDateTime) -> Result<(), AppError> {
    if let Some(h) = &c.policy.active_hours {
        let timezone: chrono_tz::Tz =
            h.tz.parse()
                .map_err(|_| refuse("invalid_work_hours_timezone"))?;
        let utc = chrono::DateTime::from_timestamp(now.unix_timestamp(), now.nanosecond())
            .ok_or_else(|| refuse("invalid_work_hours_time"))?;
        let local = utc.with_timezone(&timezone);
        if !h
            .days
            .contains(&(local.weekday().number_from_monday() as u8))
            || local.hour() < u32::from(h.from)
            || local.hour() >= u32::from(h.to)
        {
            return Err(refuse("outside_work_hours"));
        }
    }
    if c.policy.daily_ops_cap == Some(0) {
        return Err(refuse("daily_ops_cap"));
    }
    Ok(())
}
pub async fn authorize_execution(
    r: &mut dyn TenantRepos,
    input: ExecutionInput,
) -> Result<ExecutionPermit, AppError> {
    authorize_execution_at(r, input, OffsetDateTime::now_utc()).await
}
/// Clock-explicit implementation used by dispatchers and deterministic tests.
pub async fn authorize_execution_at(
    r: &mut dyn TenantRepos,
    input: ExecutionInput,
    now: OffsetDateTime,
) -> Result<ExecutionPermit, AppError> {
    // All Studio execution paths take the workspace frame before the capability.
    // The capability lock permits FK key-share checks while fencing policy/access changes.
    let version = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let c = r
        .capabilities()
        .lock(input.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let control = r.studio_control().lock_control().await?;
    let ws = active(r).await?;
    if ws != input.chain.workspace_id {
        return Err(AppError::not_found("chain"));
    }
    let arm = r
        .studio()
        .get_arm(input.chain.arm_id)
        .await?
        .ok_or_else(|| AppError::not_found("arm"))?;
    let lane = arm.key.lane;
    if control.is_braked(lane) {
        return Err(refuse("studio_braked"));
    }
    let birth = r
        .strategy()
        .find(input.chain.born_version_id)
        .await?
        .ok_or_else(|| AppError::not_found("birth strategy"))?;
    let birth_h = r.hypotheses().list(birth.id).await?;
    let hypotheses = r.hypotheses().list(version.id).await?;
    let groups: Vec<_> = r
        .capability_groups()
        .list()
        .await?
        .into_iter()
        .filter(|(_, ids)| ids.contains(&c.id))
        .map(|(g, _)| g.id.0)
        .collect();
    validate_chain(
        &input.chain,
        &ChainContext {
            workspace_id: ws,
            birth_version: &birth,
            birth_hypotheses: &birth_h,
            current_version: &version,
            hypotheses: &hypotheses,
            arm: &arm,
            target: &c,
            target_group_ids: &groups,
            supported_kinds: if lane == LaneKind::Paid {
                &["meta_ads"]
            } else {
                ORGANIC_KINDS
            },
            lane,
        },
    )
    .map_err(|e| refuse(&e.to_string()))?;
    let policy = StudioPolicy {
        expected_revision: input.expected_revision,
        requires_human_approval: control
            .lanes
            .get(&lane)
            .is_some_and(|l| l.requires_human_approval),
        capability_requires_human_approval: c.policy.requires_human_approval,
        // TikTok's guidelines: a human passes its posting screen whatever the policies above say.
        posting_screen_required: jt_studio::requires_posting_screen(&c.kind_key),
        approval: None,
    };
    match input.target {
        ApprovalTarget::Slot(id) => {
            capability_access(&c, now, true)?;
            hours(&c, now)?;
            let s = r
                .studio()
                .get_slot(id)
                .await?
                .ok_or_else(|| AppError::not_found("slot"))?;
            if s.chain != input.chain
                || s.capability_id != c.id
                || lane != LaneKind::Organic
                || s.state != jt_studio::SlotState::Ready
                || s.revision != input.expected_revision
            {
                return Err(refuse("execution_target_changed"));
            }
            let _p = r
                .studio()
                .get_piece(id, s.revision)
                .await?
                .ok_or_else(|| AppError::not_found("piece"))?;
            StudioPolicy {
                approval: r.studio().get_approval(input.target, s.revision).await?,
                ..policy
            }
            .check_approval(s.revision)
            .map_err(|e| refuse(&e.to_string()))?;
        }
        ApprovalTarget::BudgetMove(id) => {
            let m = r
                .studio()
                .get_budget_move(id)
                .await?
                .ok_or_else(|| AppError::not_found("budget move"))?;
            let b = r
                .studio()
                .get_binding(m.binding_id)
                .await?
                .ok_or_else(|| AppError::not_found("binding"))?;
            if m.chain != input.chain
                || b.capability_id != c.id
                || lane != LaneKind::Paid
                || m.state != jt_studio::BudgetMoveState::Queued
            {
                return Err(refuse("execution_target_changed"));
            }
            binding_current(&b, &c)?;
            if !m.matches_binding_generation(&b) {
                return Err(refuse("binding_stale"));
            }
            capability_access(&c, now, true)?;
            hours(&c, now)?;
            m.check_approval(&policy)
                .map_err(|e| refuse(&e.to_string()))?;
            check_caps(
                r,
                &version,
                &c,
                lane,
                m.daily_budget_minor,
                &m.currency,
                now,
            )
            .await?;
        }
    }
    Ok(ExecutionPermit {
        strategy_version_id: version.id,
        control_revision: control.revision,
        lane,
    })
}
/// A conservative daily-budget liability check. T8's atomic reservation remains mandatory
/// before a paid write; a consent receipt or this read-only check never reserves spend.
pub(crate) async fn check_caps(
    r: &mut dyn TenantRepos,
    v: &jt_strategy::StrategyVersion,
    c: &Capability,
    lane: LaneKind,
    daily: i64,
    currency: &str,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let l = v
        .sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == lane && l.currency == currency)
        .ok_or_else(|| refuse("lane_budget_missing"))?;
    let period = match l.period {
        jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
        jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
    };
    let (_, until) = jt_capability::period_window(period, now);
    let amount = jt_studio::daily_liability(daily, period, now, until)
        .map_err(|_| refuse("unknown_budget_cost"))?;
    if amount > l.cap_minor || c.policy.spend_cap_minor.is_some_and(|cap| amount > cap) {
        return Err(AppError::budget_cap(
            json!({"requested_minor":amount,"cap_minor":l.cap_minor}),
        ));
    }
    if c.budget_item_ids.is_empty() {
        return Err(refuse("budget_items_required"));
    }
    for id in &c.budget_item_ids {
        let item = r
            .budget()
            .lock_item(*id)
            .await?
            .ok_or_else(|| AppError::not_found("budget item"))?;
        if item.retired_at.is_some() || item.unit != jt_capability::Unit::Currency(currency.into())
        {
            return Err(refuse("budget_currency_or_status"));
        }
        let (from, to) = jt_capability::period_window(item.period, now);
        let used = r.budget().spent_between(*id, from, to).await?;
        let amount = jt_studio::daily_liability(daily, item.period, now, until)
            .map_err(|_| refuse("unknown_budget_cost"))?;
        if i128::from(used) + i128::from(amount) > i128::from(item.cap) {
            return Err(AppError::budget_cap(
                json!({"requested_minor":amount,"cap_minor":item.cap}),
            ));
        }
    }
    Ok(())
}
pub async fn authorize_measurement(
    r: &mut dyn TenantRepos,
    target: HistoricalTarget,
) -> Result<MeasurementPermit, AppError> {
    authorize_measurement_at(r, target, OffsetDateTime::now_utc()).await
}
pub async fn authorize_measurement_at(
    r: &mut dyn TenantRepos,
    target: HistoricalTarget,
    now: OffsetDateTime,
) -> Result<MeasurementPermit, AppError> {
    let ws = active(r).await?;
    let (chain, id, account) = match target {
        HistoricalTarget::Publication(id) => {
            let p = r
                .studio()
                .get_publication(id)
                .await?
                .ok_or_else(|| AppError::not_found("publication"))?;
            (
                p.chain,
                p.capability_id,
                Some(
                    p.account_id
                        .ok_or_else(|| refuse("historical_account_missing"))?,
                ),
            )
        }
        HistoricalTarget::Binding(id) => {
            let b = r
                .studio()
                .get_binding(id)
                .await?
                .ok_or_else(|| AppError::not_found("binding"))?;
            (b.chain, b.capability_id, Some(b.account_id))
        }
    };
    let c = r
        .capabilities()
        .find(id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if chain.workspace_id != ws
        || c.workspace_id != ws
        || account.as_ref().is_some_and(|a| {
            !c.external_id
                .as_deref()
                .is_some_and(|id| same_account(&c.kind_key, id, a))
        })
    {
        return Err(refuse("historical_account_changed"));
    }
    capability_access(&c, now, false)?;
    Ok(MeasurementPermit {
        chain,
        capability: c,
    })
}
/// Run immediately before a single provider call, and again for every next item. This is the
/// iteration boundary: calls admitted before a concurrent brake may finish and record evidence.
/// No DB locks survive into `call`, and a failed fence leaves queue/attempt state untouched.
pub async fn dispatch_execution<T, F, Fut>(
    d: &Deps,
    input: ExecutionInput,
    call: F,
) -> Result<T, AppError>
where
    F: FnOnce(ExecutionPermit) -> Fut,
    Fut: std::future::Future<Output = Result<T, AppError>>,
{
    let mut r = d.uow.tenant(input.chain.workspace_id).await?;
    let capability = r
        .capabilities()
        .find(input.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let provider = jt_connector::provider_for_kind(&capability.kind_key)
        .ok_or_else(|| refuse("connector_unavailable"))?;
    if match input.target {
        ApprovalTarget::Slot(_) => d.connectors.publisher(provider).is_none(),
        ApprovalTarget::BudgetMove(_) => d.connectors.ads(provider).is_none(),
    } {
        return Err(refuse("connector_unavailable"));
    }
    let permit = authorize_execution_at(r.as_mut(), input, d.clock.now()).await?;
    r.commit().await?;
    call(permit).await
}

pub(crate) fn binding_current(b: &jt_studio::AdSetBinding, c: &Capability) -> Result<(), AppError> {
    if b.capability_id != c.id
        || b.verified_at.is_none()
        || b.verified_at != c.last_verified_at
        || b.verification_evidence != c.evidence
        || !c
            .external_id
            .as_deref()
            .is_some_and(|id| same_account(&c.kind_key, id, &b.account_id))
    {
        return Err(refuse("binding_stale"));
    }
    Ok(())
}

/// Historical read authority for a captured receipt before Publication bookkeeping completes.
/// This cannot authorize a write, and deliberately survives strategy archive and the brake.
pub(crate) async fn authorize_publication_recovery(
    r: &mut dyn TenantRepos,
    attempt: &jt_studio::PublishAttempt,
    now: OffsetDateTime,
) -> Result<Capability, AppError> {
    let ws = active(r).await?;
    let c = r
        .capabilities()
        .find(attempt.capability_id())
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if attempt.piece().chain.workspace_id != ws
        || c.workspace_id != ws
        || !attempt
            .account_id()
            .zip(c.external_id.as_deref())
            .is_some_and(|(a, b)| same_account(&c.kind_key, a, b))
    {
        return Err(refuse("historical_account_changed"));
    }
    capability_access(&c, now, false)?;
    Ok(c)
}
