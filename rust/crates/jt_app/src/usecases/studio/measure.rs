//! Historical evidence reads; no strategy/execution gate and no provider I/O under locks.
use super::chain::{HistoricalTarget, authorize_measurement_at};
use crate::{
    error::AppError,
    ports::TenantRepos,
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
    },
};
use jt_connector::provider_for_kind;
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use serde_json::json;

/// Persist evidence and replace its contribution in one tenant transaction.
pub async fn record(d: &Deps, m: Measurement) -> Result<bool, AppError> {
    let mut r = d.uow.tenant(m.chain.workspace_id).await?;
    // Match strategy transitions: frame first, then Studio control. No active strategy required.
    r.strategy().lock_execution_frame().await?;
    r.studio_control().lock_control().await?;
    let target = if let Some(id) = m.publication_id {
        HistoricalTarget::Publication(id)
    } else {
        HistoricalTarget::Binding(
            m.binding_id
                .ok_or_else(|| AppError::conflict("measurement target"))?,
        )
    };
    authorize_measurement_at(r.as_mut(), target, d.clock.now()).await?;
    let before = r.studio().list_measurements().await?;
    if before.iter().any(|old| old == &m) {
        return Ok(false);
    }
    let changed = r.studio().record_measurement(m.clone()).await?;
    if changed && m.status == MeasurementStatus::Complete {
        let after = r.studio().list_measurements().await?;
        let old = observations(&before).map_err(invalid)?;
        let new = observations(&after).map_err(invalid)?;
        let contribution = |rows: &[Reward]| {
            rows.iter()
                .filter(|v| v.chain.arm_id == m.chain.arm_id)
                .fold((0.0, 0.0), |(a, b), v| (a + v.value, b + 1.0 - v.value))
        };
        let (oa, ob) = contribution(&old);
        let (na, nb) = contribution(&new);
        let arms = r.studio().list_arms().await?;
        let arm = arms
            .iter()
            .find(|a| a.id == m.chain.arm_id)
            .ok_or_else(|| AppError::not_found("arm"))?;
        let alpha = arm.alpha + na - oa;
        let beta = arm.beta + nb - ob;
        let weight = alpha / (alpha + beta);
        let observed: Vec<_> = arms
            .iter()
            .filter(|a| {
                a.key.hypothesis_id == m.chain.hypothesis_id
                    && new.iter().any(|v| v.chain.arm_id == a.id)
            })
            .collect();
        if !observed.is_empty() {
            let confidence = observed
                .iter()
                .map(|a| {
                    if a.id == arm.id {
                        weight
                    } else {
                        a.alpha / (a.alpha + a.beta)
                    }
                })
                .sum::<f64>()
                / observed.len() as f64;
            r.studio()
                .apply_learning(LearningUpdate {
                    chain: m.chain.clone(),
                    evidence_key: m.evidence_key.clone(),
                    alpha_delta: na - oa,
                    beta_delta: nb - ob,
                    weight_delta: weight - arm.weight,
                    derived_confidence: confidence as f32,
                })
                .await?;
        }
    }
    let mut pause_paid = false;
    if let Some(id) = m.binding_id {
        let b = r
            .studio()
            .get_binding(id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        if let Some(currency) = &m.currency {
            match super::budget::validate_observed_spend(r.as_mut(), &b, currency, d.clock.now())
                .await
            {
                Err(e) if e.code == crate::error::ErrorCode::BudgetCap => {
                    super::ads::brake_paid_in(
                        r.as_mut(),
                        &b,
                        d.clock.now(),
                        "observed_spend_over_cap",
                    )
                    .await?;
                    pause_paid = true;
                }
                Err(e) => return Err(e),
                Ok(()) => {}
            }
        }
    }
    let ctx = system_ctx(m.chain.workspace_id, d.clock.now());
    let mut e = crate::usecases::ledger_entry(
        &ctx,
        "studio.measurement.recorded",
        "studio_measurement",
        m.id,
        json!({"measurement":m,"born_version_id":m.chain.born_version_id,"hypothesis_id":m.chain.hypothesis_id}),
    )?;
    e.strategy_version_id = Some(m.chain.born_version_id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    if pause_paid {
        let _ = super::control::reconcile_bindings(d, m.chain.workspace_id).await;
    }
    Ok(changed)
}
fn invalid(e: StudioError) -> AppError {
    AppError::conflict(e.to_string())
}
async fn access(
    d: &Deps,
    r: &mut dyn TenantRepos,
    target: HistoricalTarget,
) -> Result<(jt_capability::Capability, jt_connector::Credential), AppError> {
    let p = authorize_measurement_at(r, target, d.clock.now()).await?;
    let sealed = r
        .capabilities()
        .read_sealed(p.capability.id)
        .await?
        .ok_or_else(|| AppError::conflict("missing credential"))?;
    let cred = open_credential(d, p.chain.workspace_id, &sealed)?;
    Ok((p.capability, cred))
}
pub async fn measure_due(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let (publications, bindings, rows) = {
        let mut r = d.uow.tenant(ws).await?;
        (
            r.studio().list_publications().await?,
            r.studio().list_bindings().await?,
            r.studio().list_measurements().await?,
        )
    };
    let now = d.clock.now();
    let mut changed = 0;
    for p in publications {
        for window in [
            MeasurementWindow::Hours24,
            MeasurementWindow::Hours72,
            MeasurementWindow::Days7,
        ] {
            let scheduled = p.published_at + window.delay();
            if scheduled > now
                || rows.iter().any(|m| {
                    m.publication_id == Some(p.id)
                        && m.window == window
                        && m.status == MeasurementStatus::Complete
                })
            {
                continue;
            }
            let previous = rows
                .iter()
                .find(|m| m.publication_id == Some(p.id) && m.window == window);
            if previous
                .and_then(|m| m.failure.as_ref())
                .is_some_and(|f| f.retry_at > now)
            {
                continue;
            }
            let result = match measure_publication(d, &p, window, scheduled).await {
                Ok(m) => record(d, m).await,
                Err(e) => Err(e),
            };
            match result {
                Ok(recorded) => changed += u32::from(recorded),
                Err(e) if target_failure(&e) => {
                    changed +=
                        u32::from(defer_publication(d, &p, window, scheduled, previous, &e).await?);
                }
                Err(e) => return Err(e),
            }
        }
    }
    for b in bindings {
        match measure_binding(d, &b).await {
            Ok(n) => changed += n,
            Err(e) if target_failure(&e) => {
                let mut r = d.uow.tenant(ws).await?;
                log_failure(
                    r.as_mut(),
                    &b.chain,
                    "studio_binding",
                    b.id.0,
                    &e,
                    None,
                    now,
                )
                .await?;
                r.commit().await?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(changed)
}
async fn measure_publication(
    d: &Deps,
    p: &Publication,
    window: MeasurementWindow,
    scheduled: time::OffsetDateTime,
) -> Result<Measurement, AppError> {
    let ws = p.chain.workspace_id;
    let now = d.clock.now();
    let (c, cred) = {
        let mut r = d.uow.tenant(ws).await?;
        access(d, r.as_mut(), HistoricalTarget::Publication(p.id)).await?
    };
    let provider =
        provider_for_kind(&c.kind_key).ok_or_else(|| AppError::conflict("unsupported insights"))?;
    let reader = d
        .connectors
        .insights(provider)
        .ok_or_else(|| AppError::conflict("unsupported insights"))?;
    let result = reader
        .post_metrics(&cred, &adapter_public(&c), &p.external_id)
        .await
        .map_err(provider_failure)?;
    let mut raw: std::collections::BTreeMap<String, Option<i64>> = result
        .metrics
        .into_iter()
        .map(|(k, v)| (k, Some(v)))
        .collect();
    if !raw.contains_key("impressions")
        && let Some(n) = raw
            .get("impression_count")
            .or_else(|| raw.get("post_impressions"))
            .copied()
    {
        raw.insert("impressions".into(), n);
    }
    if !raw.contains_key("engagements")
        && let Some(n) = raw.get("total_interactions").copied()
    {
        raw.insert("engagements".into(), n);
    }
    // Provider-specific engagement counters are optional, never filled with zero.
    if !raw.contains_key("engagements") {
        let values: Vec<_> = [
            "likes",
            "comments",
            "shares",
            "retweets",
            "replies",
            "reposts",
            "like_count",
            "reply_count",
            "retweet_count",
            "quote_count",
            "saved",
            "post_reactions_like_total",
            "post_clicks",
        ]
        .iter()
        .filter_map(|k| raw.get(*k).copied().flatten())
        .collect();
        if !values.is_empty() && values.iter().all(|v| *v >= 0) {
            raw.insert(
                "engagements".into(),
                values.into_iter().try_fold(0i64, |a, b| a.checked_add(b)),
            );
        }
    }
    let key = format!("post:{}:{window:?}", p.id);
    let mut m = Measurement {
        id: MeasurementId(super::planner::stable_id(ws, &key)),
        chain: p.chain.clone(),
        evidence_key: key,
        publication_id: Some(p.id),
        binding_id: None,
        window,
        evidence_revision: 0,
        scheduled_at: Some(scheduled),
        account_timezone: None,
        minor_unit_exponent: None,
        measured_at: now,
        source: c.kind_key,
        raw_metrics: raw,
        metric_scope: "post".into(),
        date: None,
        currency: None,
        status: MeasurementStatus::Complete,
        failure: None,
        rule_version: LEARNING_RULE.into(),
    };
    if reward(&m, &LearningPolicy::default())
        .map_err(invalid)?
        .is_none()
    {
        m.status = MeasurementStatus::Missing;
    }
    Ok(m)
}

// Storage/workspace errors are run failures; target access/provider failures are isolated.
fn target_failure(e: &AppError) -> bool {
    use crate::error::ErrorCode;
    matches!(
        e.code,
        ErrorCode::Conflict
            | ErrorCode::NotFound
            | ErrorCode::Forbidden
            | ErrorCode::Unauthenticated
            | ErrorCode::UpstreamUnavailable
    )
}
fn provider_failure(e: jt_connector::ConnectorError) -> AppError {
    super::chain::refuse(e.kind())
}
fn failure_category(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or(e.code.as_str())
}
async fn log_failure(
    r: &mut dyn TenantRepos,
    chain: &Chain,
    entity: &str,
    id: uuid::Uuid,
    error: &AppError,
    retry: Option<&MeasurementFailure>,
    now: time::OffsetDateTime,
) -> Result<(), AppError> {
    let ctx = system_ctx(chain.workspace_id, now);
    let mut entry = crate::usecases::ledger_entry(
        &ctx,
        "studio.measurement.failed",
        entity,
        id,
        json!({"chain":chain,"category":failure_category(error),"code":error.code,"retry":retry}),
    )?;
    entry.strategy_version_id = Some(chain.born_version_id.0);
    r.ledger().append(entry).await?;
    Ok(())
}
fn retry_delay(attempts: u32) -> time::Duration {
    time::Duration::hours(match attempts {
        0 | 1 => 1,
        2 => 6,
        _ => 24,
    })
}
async fn defer_publication(
    d: &Deps,
    p: &Publication,
    window: MeasurementWindow,
    scheduled: time::OffsetDateTime,
    previous: Option<&Measurement>,
    error: &AppError,
) -> Result<bool, AppError> {
    let now = d.clock.now();
    let attempts = previous
        .and_then(|m| m.failure.as_ref())
        .map_or(1, |f| f.attempts.saturating_add(1));
    let failure = MeasurementFailure {
        category: failure_category(error).into(),
        attempts,
        retry_at: now + retry_delay(attempts),
    };
    let key = format!("post:{}:{window:?}", p.id);
    let m = Measurement {
        id: MeasurementId(super::planner::stable_id(p.chain.workspace_id, &key)),
        chain: p.chain.clone(),
        evidence_key: key,
        publication_id: Some(p.id),
        binding_id: None,
        window,
        evidence_revision: 0,
        scheduled_at: Some(scheduled),
        account_timezone: None,
        minor_unit_exponent: None,
        measured_at: now,
        source: "studio".into(),
        raw_metrics: Default::default(),
        metric_scope: "post".into(),
        date: None,
        currency: None,
        status: MeasurementStatus::Failed,
        failure: Some(failure.clone()),
        rule_version: LEARNING_RULE.into(),
    };
    let mut r = d.uow.tenant(p.chain.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    r.studio_control().lock_control().await?;
    // Only this private path may store an inaccessible target's empty failure record.
    // The repository validates the tenant/target chain; normal evidence still needs access.
    if r.studio().list_measurements().await?.iter().any(|m| {
        m.publication_id == Some(p.id)
            && m.window == window
            && m.status == MeasurementStatus::Complete
    }) {
        return Ok(false);
    }
    let changed = r.studio().record_measurement(m).await?;
    log_failure(
        r.as_mut(),
        &p.chain,
        "studio_publication",
        p.id.0,
        error,
        Some(&failure),
        now,
    )
    .await?;
    r.commit().await?;
    Ok(changed)
}

async fn measure_binding(d: &Deps, b: &AdSetBinding) -> Result<u32, AppError> {
    let ws = b.chain.workspace_id;
    let now = d.clock.now();
    let (c, cred) = {
        let mut r = d.uow.tenant(ws).await?;
        access(d, r.as_mut(), HistoricalTarget::Binding(b.id)).await?
    };
    let ads = d
        .connectors
        .ads(provider_for_kind(&c.kind_key).ok_or_else(|| AppError::conflict("unsupported ads"))?)
        .ok_or_else(|| AppError::conflict("unsupported ads"))?;
    let public = adapter_public(&c);
    let context = ads
        .account_context(&cred, &public)
        .await
        .map_err(provider_failure)?;
    if !super::chain::same_account(&c.kind_key, &context.account_id, &b.account_id)
        || jt_connector::currency_minor_exponent(&context.currency)
            != Some(context.minor_unit_exponent)
    {
        return Err(AppError::conflict("ad account units mismatch"));
    }
    // Reading status is required even for paused sets; T8 consumes this same provider state.
    let sets = ads
        .list_adsets(&cred, &public)
        .await
        .map_err(provider_failure)?;
    if !sets
        .iter()
        .any(|s| s.id == b.adset_id && s.campaign_id == b.campaign_id)
    {
        return Err(AppError::conflict("bound ad set unavailable"));
    }
    let set = sets
        .iter()
        .find(|s| s.id == b.adset_id)
        .expect("verified membership");
    super::ads::reconcile_budget(d, b, set, &context.currency).await?;
    let drift = detect_drift(d, b, set, &context.currency).await?;
    if drift {
        let _ = super::control::reconcile_bindings(d, ws).await;
    }
    use chrono::Datelike;
    let timezone: chrono_tz::Tz = context
        .timezone
        .parse()
        .unwrap_or(chrono_tz::Europe::Istanbul);
    let local = chrono::DateTime::from_timestamp(now.unix_timestamp(), now.nanosecond())
        .ok_or_else(|| AppError::internal("invalid measurement time"))?
        .with_timezone(&timezone);
    let today = time::Date::from_calendar_date(
        local.year(),
        (local.month() as u8)
            .try_into()
            .map_err(|_| AppError::internal("invalid measurement month"))?,
        local.day() as u8,
    )
    .map_err(|_| AppError::internal("invalid measurement date"))?;
    let rows = ads
        .adset_insights(&cred, &public, today - time::Duration::days(7), today)
        .await
        .map_err(provider_failure)?;
    let existing = {
        let mut r = d.uow.tenant(ws).await?;
        r.studio().list_measurements().await?
    };
    let mut changed = 0;
    for row in rows.into_iter().filter(|m| {
        m.account_id == context.account_id
            && m.adset_id == b.adset_id
            && m.campaign_id == b.campaign_id
            && m.date <= today
            && m.date >= today - time::Duration::days(7)
    }) {
        let raw = std::collections::BTreeMap::from([
            ("impressions".into(), row.impressions),
            ("clicks".into(), row.clicks),
            ("spend_minor".into(), row.spend_minor),
            ("daily_budget_minor".into(), set.daily_budget_minor),
            (
                "active".into(),
                match set.status.as_str() {
                    "ACTIVE" => Some(1),
                    "PAUSED" => Some(0),
                    _ => None,
                },
            ),
        ]);
        let old = existing
            .iter()
            .filter(|m| m.binding_id == Some(b.id) && m.date == Some(row.date))
            .max_by_key(|m| m.evidence_revision);
        if old.is_some_and(|m| {
            m.raw_metrics == raw
                && super::budget::bucket_window(m)
                    .is_none_or(|(_, end)| now < end || m.measured_at >= end)
                && m.currency.as_ref() == Some(&context.currency)
                && m.minor_unit_exponent == Some(context.minor_unit_exponent)
        }) {
            continue;
        }
        let revision = old.map_or(0, |m| m.evidence_revision + 1);
        let key = format!("set:{}:{}:{revision}", b.id, row.date);
        let mut m = Measurement {
            id: MeasurementId(super::planner::stable_id(ws, &key)),
            chain: b.chain.clone(),
            evidence_key: key,
            publication_id: None,
            binding_id: Some(b.id),
            window: MeasurementWindow::Hours24,
            evidence_revision: revision,
            scheduled_at: Some(row.date.midnight().assume_utc()),
            account_timezone: Some(timezone.name().into()),
            minor_unit_exponent: Some(context.minor_unit_exponent),
            measured_at: now,
            source: c.kind_key.clone(),
            raw_metrics: raw,
            metric_scope: "adset".into(),
            date: Some(row.date),
            currency: Some(context.currency.clone()),
            status: MeasurementStatus::Complete,
            failure: None,
            rule_version: LEARNING_RULE.into(),
        };
        if reward(&m, &LearningPolicy::default())
            .map_err(invalid)?
            .is_none()
        {
            m.status = MeasurementStatus::Missing;
        }
        changed += u32::from(record(d, m).await?);
    }
    let braked = {
        let mut r = d.uow.tenant(ws).await?;
        r.studio_control()
            .lock_control()
            .await?
            .is_braked(jt_strategy::LaneKind::Paid)
    };
    if braked && !drift {
        let _ = super::control::reconcile_bindings(d, ws).await;
    }
    Ok(changed)
}

pub(super) fn system_ctx(ws: WorkspaceId, now: time::OffsetDateTime) -> crate::ctx::Ctx {
    crate::ctx::Ctx {
        workspace_id: ws,
        actor: jt_ledger::Actor::System {
            component: "scheduler:studio_measure".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// Compare against confirmed authorization; queued or unknown moves never become permission.
async fn detect_drift(
    d: &Deps,
    b: &AdSetBinding,
    set: &crate::ports::connectors::AdSet,
    currency: &str,
) -> Result<bool, AppError> {
    let mut r = d.uow.tenant(b.chain.workspace_id).await?;
    r.strategy().lock_execution_frame().await?;
    let flags = r.studio_control().lock_control().await?;
    let old = r.studio_control().binding_control(b.id).await?;
    let observed = match set.status.as_str() {
        "ACTIVE" => Some(AdStatus::Active),
        "PAUSED" => Some(AdStatus::Paused),
        _ => None,
    };
    let reservations = r.studio_budget().list_reservations().await?;
    let authorized = reservations
        .iter()
        .filter(|(r, o)| {
            r.request.binding_id == Some(b.id) && matches!(o, Some(SpendOutcome::Applied { .. }))
        })
        .max_by_key(|(r, _)| (r.request.at, r.id));
    let drift = (observed == Some(AdStatus::Active) && authorized.is_none())
        || authorized.is_some_and(|(r, _)| {
            r.request.daily_budget_minor != set.daily_budget_minor
                || r.request.currency != currency
                || set.lifetime_budget_minor.is_some()
        })
        || old
            .as_ref()
            .filter(|o| matches!(o.outcome, Some(BindingStatusOutcome::Applied { .. })))
            .is_some_and(|o| Some(o.desired) != observed)
        || (flags.is_braked(jt_strategy::LaneKind::Paid) && observed != Some(AdStatus::Paused));
    if drift && !flags.is_braked(jt_strategy::LaneKind::Paid) {
        r.studio_control()
            .set_brake(flags.revision, Some(jt_strategy::LaneKind::Paid), true)
            .await?;
        let ctx = system_ctx(b.chain.workspace_id, d.clock.now());
        let mut e = crate::usecases::ledger_entry(
            &ctx,
            "studio.external_drift",
            "studio_binding",
            b.id,
            json!({"chain":b.chain,"observed_status":observed,"observed_daily_budget_minor":set.daily_budget_minor,"currency":currency,"requires_action":true,"reason":"external_budget_or_status_change"}),
        )?;
        e.strategy_version_id = Some(b.chain.born_version_id.0);
        r.ledger().append(e).await?;
    }
    r.commit().await?;
    Ok(drift)
}
