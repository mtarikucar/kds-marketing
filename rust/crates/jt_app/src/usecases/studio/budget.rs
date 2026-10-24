//! One atomic cap gate for every connector. Call under frame/control locks before I/O.
use super::chain::{active, refuse};
use crate::{error::AppError, ports::TenantRepos};
use jt_capability::{BudgetItemId, Capability, Period, Unit, period_window};
use jt_strategy::LaneKind;
use jt_studio::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

pub async fn reserve_connector_spend(
    r: &mut dyn TenantRepos,
    mut request: ReserveSpend,
) -> Result<SpendReservation, AppError> {
    r.strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    request.budget_item_ids.sort();
    request.budget_item_ids.dedup();
    if let Some(saved) = r
        .studio_budget()
        .find_reservation(&request.evidence_key)
        .await?
        && saved.request == request
    {
        // Reading a durable receipt is allowed after archive; admitting another provider
        // operation through that receipt still requires the current execution fence.
        validate_reservation(r, &request).await?;
    }
    r.studio_budget().reserve(request).await
}

/// Shared implementation for PostgreSQL and the transactional fake. Their reserve method
/// holds the strategy/control locks through validation and insertion.
pub async fn validate_reservation(
    r: &mut dyn TenantRepos,
    req: &ReserveSpend,
) -> Result<SpendReservation, AppError> {
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let c = r
        .capabilities()
        .lock(req.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let flags = r.studio_control().lock_control().await?;
    if active(r).await? != req.workspace_id || frame.id != req.executed_version_id {
        return Err(refuse("strategy_changed"));
    }
    if flags.is_braked(req.lane) {
        return Err(refuse("studio_braked"));
    }
    if req.amount_minor < 0
        || req.at < frame.approved_at.unwrap_or(frame.created_at)
        || req.evidence_key.trim().is_empty()
        || req.budget_item_ids.is_empty()
        || c.budget_item_ids.iter().copied().collect::<BTreeSet<_>>()
            != req.budget_item_ids.iter().copied().collect()
    {
        return Err(refuse("invalid_spend_context"));
    }
    super::chain::hours(&c, req.at)?;
    if req.daily_budget_minor.is_some() && (req.chain.is_none() || req.binding_id.is_none()) {
        return Err(refuse("paid_chain_required"));
    }
    if let Some(id) = req.binding_id {
        let b = r
            .studio()
            .get_binding(id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        if req.chain.as_ref() != Some(&b.chain) || req.capability_id != b.capability_id {
            return Err(refuse("binding_mismatch"));
        }
    }
    if let Some(chain) = &req.chain {
        super::chain::capability_access(&c, req.at, true)?;
        super::ads::validate_paid_or_organic_chain(r, chain, &c, req.lane).await?;
    }
    let lane = frame
        .sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == req.lane && l.currency == req.currency)
        .ok_or_else(|| refuse("lane_budget_missing"))?;
    let period = lane_period(lane.period);
    let (from, until) = period_window(period, req.at);
    let rows = r.studio_budget().list_reservations().await?;
    let replay = rows.iter().position(|(r, _)| r.request == *req);
    if replay.is_none()
        && let Some(id) = req.replaces
    {
        let (old, state) = rows
            .iter()
            .find(|(v, _)| v.id == id)
            .ok_or_else(|| refuse("replacement_missing"))?;
        if old.request.binding_id != req.binding_id
            || old.request.capability_id != req.capability_id
            || old.request.chain != req.chain
            || old.request.currency != req.currency
            || old.request.lane != req.lane
            || old.request.daily_budget_minor.is_none()
            || req.daily_budget_minor.is_none()
            || !matches!(state, Some(SpendOutcome::Applied { .. }))
            || rows.iter().any(|(v, o)| {
                v.request.replaces == Some(id) && !matches!(o, Some(SpendOutcome::Refused))
            })
        {
            return Err(refuse("replacement_unresolved"));
        }
    }
    let measurements = r.studio().list_measurements().await?;
    if let Some(daily) = req.daily_budget_minor
        && req.amount_minor
            != daily_liability(daily, period, req.at, until)
                .map_err(|_| refuse("invalid_daily_liability"))?
    {
        return Err(refuse("invalid_daily_liability"));
    }
    let mut proposed = SpendReservation {
        lane_window: Some((from, until)),
        item_windows: BTreeMap::new(),
        id: ReservationId::new_v7(),
        request: req.clone(),
        item_amounts: BTreeMap::new(),
    };
    let mut combined = rows.clone();
    let candidate = if let Some(index) = replay {
        proposed = rows[index].0.clone();
        index
    } else {
        combined.push((proposed.clone(), None));
        combined.len() - 1
    };
    attribute_bindings(r, &mut combined, req).await?;
    let mut items = req.budget_item_ids.clone();
    items.sort();
    items.dedup();
    // Manual historical entries remain truthful; compare them independently of connector evidence.
    let mut manual_lane = 0i128;
    for item in r.budget().list_items().await? {
        if item.unit == Unit::Currency(req.currency.clone()) {
            manual_lane += i128::from(r.budget().spent_between(item.id, from, until).await?);
        }
    }
    check(
        occupied(
            &combined,
            &measurements,
            None,
            Some(req.lane),
            None,
            &req.currency,
            from,
            until,
            req.at,
        ) + manual_lane,
        lane.cap_minor,
    )?;
    if let Some(cap) = c.policy.spend_cap_minor {
        check(
            occupied(
                &combined,
                &measurements,
                None,
                None,
                Some(c.id),
                &req.currency,
                from,
                until,
                req.at,
            ),
            cap,
        )?;
    }
    for id in items {
        let item = r
            .budget()
            .lock_item(id)
            .await?
            .ok_or_else(|| AppError::not_found("budget item"))?;
        if item.retired_at.is_some() || item.unit != Unit::Currency(req.currency.clone()) {
            return Err(refuse("budget_currency_or_status"));
        }
        let amount = match req.daily_budget_minor {
            Some(daily) => daily_liability(daily, item.period, req.at, until)
                .map_err(|_| refuse("invalid_daily_liability"))?,
            None => req.amount_minor,
        };
        proposed.item_amounts.insert(id, amount);
        let (item_from, item_until) = period_window(item.period, req.at);
        proposed.item_windows.insert(
            id,
            (
                item_from,
                if item.period == Period::Total {
                    until
                } else {
                    item_until
                },
            ),
        );
        combined[candidate].0 = proposed.clone();
        let (a, b) = period_window(item.period, req.at);
        let manual = r.budget().spent_between(id, a, b).await?;
        check(
            i128::from(manual)
                + occupied(
                    &combined,
                    &measurements,
                    Some(id),
                    None,
                    None,
                    &req.currency,
                    a,
                    b,
                    req.at,
                ),
            item.cap,
        )?;
    }
    Ok(proposed)
}
/// Observation accounting deliberately has no execution, work-hour, or operation gates.
/// Call with the frame/control locks held, after persisting the measurement.
pub(super) async fn validate_observed_spend(
    r: &mut dyn TenantRepos,
    binding: &AdSetBinding,
    currency: &str,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    let frame = r.strategy().current_approved().await?;
    let c = r
        .capabilities()
        .find(binding.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let req = ReserveSpend {
        workspace_id: binding.chain.workspace_id,
        capability_id: c.id,
        budget_item_ids: c.budget_item_ids.clone(),
        lane: LaneKind::Paid,
        executed_version_id: frame
            .as_ref()
            .map_or(binding.chain.born_version_id, |v| v.id),
        amount_minor: 0,
        daily_budget_minor: None,
        currency: currency.into(),
        evidence_key: String::new(),
        at,
        binding_id: Some(binding.id),
        chain: Some(binding.chain.clone()),
        replaces: None,
    };
    let mut rows = r.studio_budget().list_reservations().await?;
    attribute_bindings(r, &mut rows, &req).await?;
    let measurements = r.studio().list_measurements().await?;
    if let Some(lane) = frame.as_ref().and_then(|v| {
        v.sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == LaneKind::Paid && l.currency == currency)
    }) {
        let (from, until) = period_window(lane_period(lane.period), at);
        let mut manual = 0i128;
        for item in r.budget().list_items().await? {
            if item.unit == Unit::Currency(currency.into()) {
                manual += i128::from(r.budget().spent_between(item.id, from, until).await?);
            }
        }
        check(
            manual
                + occupied(
                    &rows,
                    &measurements,
                    None,
                    Some(LaneKind::Paid),
                    None,
                    currency,
                    from,
                    until,
                    at,
                ),
            lane.cap_minor,
        )?;
        if let Some(cap) = c.policy.spend_cap_minor {
            check(
                occupied(
                    &rows,
                    &measurements,
                    None,
                    None,
                    Some(c.id),
                    currency,
                    from,
                    until,
                    at,
                ),
                cap,
            )?;
        }
    }
    // Item caps still apply without a current lane/frame and even to retired items:
    // those restrictions cannot erase spend that the provider already incurred.
    for id in &c.budget_item_ids {
        let item = r
            .budget()
            .lock_item(*id)
            .await?
            .ok_or_else(|| AppError::not_found("budget item"))?;
        if item.unit != Unit::Currency(currency.into()) {
            continue;
        }
        let (from, until) = period_window(item.period, at);
        let manual = r.budget().spent_between(*id, from, until).await?;
        check(
            i128::from(manual)
                + occupied(
                    &rows,
                    &measurements,
                    Some(*id),
                    None,
                    None,
                    currency,
                    from,
                    until,
                    at,
                ),
            item.cap,
        )?;
    }
    Ok(())
}

async fn attribute_bindings(
    r: &mut dyn TenantRepos,
    combined: &mut Vec<(SpendReservation, Option<SpendOutcome>)>,
    req: &ReserveSpend,
) -> Result<(), AppError> {
    // Attribute external spend even before the first authorized write. These zero-value
    // accounting rows are transient; they never authorize a provider operation.
    for binding in r.studio().list_bindings().await? {
        if let Some(capability) = r.capabilities().find(binding.capability_id).await? {
            combined.push((
                SpendReservation {
                    id: ReservationId::new_v7(),
                    lane_window: None,
                    item_windows: BTreeMap::new(),
                    item_amounts: BTreeMap::new(),
                    request: ReserveSpend {
                        workspace_id: req.workspace_id,
                        capability_id: capability.id,
                        budget_item_ids: capability.budget_item_ids,
                        lane: LaneKind::Paid,
                        executed_version_id: req.executed_version_id,
                        amount_minor: 0,
                        daily_budget_minor: None,
                        currency: req.currency.clone(),
                        evidence_key: String::new(),
                        at: req.at,
                        binding_id: Some(binding.id),
                        chain: Some(binding.chain),
                        replaces: None,
                    },
                },
                None,
            ));
        }
    }
    Ok(())
}

fn check(used: i128, cap: i64) -> Result<(), AppError> {
    if used > i128::from(cap) {
        Err(AppError::budget_cap(
            json!({"cap_minor":cap,"requested_minor":used}),
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn lane_period(p: jt_strategy::Period) -> Period {
    match p {
        jt_strategy::Period::Weekly => Period::Weekly,
        jt_strategy::Period::Monthly => Period::Monthly,
    }
}

/// Observations correct one provider daily bucket. Uncertain writes keep their full exposure;
/// confirmed replacements retain elapsed exposure and replace future liability.
#[allow(clippy::too_many_arguments)]
pub fn occupied(
    rows: &[(SpendReservation, Option<SpendOutcome>)],
    measurements: &[Measurement],
    item: Option<BudgetItemId>,
    lane: Option<LaneKind>,
    capability: Option<jt_capability::CapabilityId>,
    currency: &str,
    from: OffsetDateTime,
    until: OffsetDateTime,
    now: OffsetDateTime,
) -> i128 {
    let relevant: Vec<_> = rows
        .iter()
        .filter(|(r, _)| {
            r.request.currency == currency
                && item.is_none_or(|id| r.request.budget_item_ids.contains(&id))
                && lane.is_none_or(|l| r.request.lane == l)
                && capability.is_none_or(|c| r.request.capability_id == c)
        })
        .collect();
    let mut buckets: BTreeMap<(AdSetBindingId, time::Date), &Measurement> = BTreeMap::new();
    for m in measurements.iter().filter(|m| {
        m.binding_id.is_some()
            && m.currency.as_deref() == Some(currency)
            && m.raw_metrics
                .get("spend_minor")
                .copied()
                .flatten()
                .is_some_and(|n| n >= 0)
    }) {
        if (lane == Some(LaneKind::Paid) && item.is_none() && capability.is_none()
            || relevant
                .iter()
                .any(|(r, _)| r.request.binding_id == m.binding_id))
            && let Some(date) = m.date
        {
            let key = (m.binding_id.expect("bound measurement"), date);
            if buckets
                .get(&key)
                .is_none_or(|old| old.evidence_revision < m.evidence_revision)
            {
                buckets.insert(key, m);
            }
        }
    }
    let mut actual = 0i128;
    for m in buckets.values() {
        if let Some((a, b)) = bucket_window(m)
            && a < until
            && b > from
        {
            actual += i128::from(m.raw_metrics["spend_minor"].unwrap_or(0));
        }
    }
    let mut held: BTreeMap<(ReservationId, time::Date), i128> = BTreeMap::new();
    for (r, outcome) in relevant {
        if matches!(outcome, Some(SpendOutcome::Refused)) {
            continue;
        }
        let mut root = r.id;
        for _ in 0..rows.len() {
            match rows
                .iter()
                .find(|(n, _)| n.id == root)
                .and_then(|(n, _)| n.request.replaces)
            {
                Some(id) => root = id,
                None => break,
            }
        }
        if let Some(SpendOutcome::Settled { actual_minor, .. }) = outcome {
            if r.request.at >= from && r.request.at < until {
                actual += i128::from(*actual_minor);
            }
            continue;
        }
        let amount = item
            .and_then(|id| r.item_amounts.get(&id))
            .copied()
            .unwrap_or(r.request.amount_minor);
        let Some(daily) = r.request.daily_budget_minor else {
            actual += i128::from(amount);
            continue;
        };
        if daily <= 0 {
            continue;
        }
        let own_until = item
            .and_then(|id| r.item_windows.get(&id))
            .copied()
            .or(r.lane_window)
            .map(|(_, b)| b)
            .unwrap_or(until);
        // A confirmed replacement changes future exposure only. A partially elapsed day
        // retains the greatest authorized amount until its provider buckets reconcile.
        let end = rows
            .iter()
            .filter(|(n, o)| {
                n.request.replaces == Some(r.id) && matches!(o, Some(SpendOutcome::Applied { .. }))
            })
            .map(|(n, _)| n.request.at)
            .min()
            .unwrap_or(own_until)
            .min(own_until);
        let mut day = r.request.at.date().midnight().assume_utc();
        let mut left = i128::from(amount);
        while day < end && r.request.at < end && left > 0 {
            let next = day + time::Duration::days(1);
            let exposure = left.min(i128::from(daily));
            let reconciled = matches!(outcome, Some(SpendOutcome::Applied { .. }))
                && covered(r.request.binding_id, day, next, &buckets, now);
            let in_period = day < until && next > from;
            // Applied historic exposure belongs to its original UTC cap period. Unknown
            // operations remain held; cumulative Total caps still include every old day.
            if !reconciled && (in_period || !matches!(outcome, Some(SpendOutcome::Applied { .. })))
            {
                held.entry((root, day.date()))
                    .and_modify(|v| *v = (*v).max(exposure))
                    .or_insert(exposure);
            }
            left -= exposure;
            day = next;
        }
    }
    actual + held.values().sum::<i128>()
}
fn covered(
    binding: Option<AdSetBindingId>,
    from: OffsetDateTime,
    until: OffsetDateTime,
    buckets: &BTreeMap<(AdSetBindingId, time::Date), &Measurement>,
    now: OffsetDateTime,
) -> bool {
    let mut windows: Vec<_> = buckets
        .values()
        .filter(|m| m.binding_id == binding)
        .filter_map(|m| bucket_window(m).filter(|(_, b)| *b <= now && m.measured_at >= *b))
        .collect();
    windows.sort();
    let mut cursor = from;
    for (a, b) in windows {
        if a <= cursor && b > cursor {
            cursor = b;
        }
    }
    cursor >= until
}
pub(crate) fn bucket_window(m: &Measurement) -> Option<(OffsetDateTime, OffsetDateTime)> {
    use chrono::TimeZone;
    let date = m.date?;
    let tz: chrono_tz::Tz = m.account_timezone.as_deref()?.parse().ok()?;
    let start =
        chrono::NaiveDate::from_ymd_opt(date.year(), date.month() as u32, u32::from(date.day()))?;
    let a = tz
        .from_local_datetime(&start.and_hms_opt(0, 0, 0)?)
        .single()?;
    let b = tz
        .from_local_datetime(&start.succ_opt()?.and_hms_opt(0, 0, 0)?)
        .single()?;
    Some((
        OffsetDateTime::from_unix_timestamp(a.timestamp()).ok()?,
        OffsetDateTime::from_unix_timestamp(b.timestamp()).ok()?,
    ))
}

/// Metered operations need a persisted price and an explicit quantity. Supported organic
/// publishing without linked budgets is intrinsically unmetered; SMS is always metered.
pub async fn reserve_metered(
    r: &mut dyn TenantRepos,
    c: &Capability,
    chain: Option<Chain>,
    quantity: Option<u64>,
    key: String,
    at: OffsetDateTime,
) -> Result<Option<SpendReservation>, AppError> {
    if c.budget_item_ids.is_empty()
        && c.kind_key != "sms_line"
        && c.policy.spend_cap_minor.is_none()
    {
        return Ok(None);
    }
    r.strategy().lock_execution_frame().await?;
    r.capabilities().lock(c.id).await?;
    r.studio_control().lock_control().await?;
    let quantity = quantity
        .filter(|n| *n > 0)
        .ok_or_else(|| refuse("billable_quantity_required"))?;
    let mut price = None;
    let mut currency = None;
    for id in &c.budget_item_ids {
        let item = r
            .budget()
            .lock_item(*id)
            .await?
            .ok_or_else(|| AppError::not_found("budget item"))?;
        let Unit::Currency(unit) = item.unit else {
            return Err(refuse("unsupported_budget_unit"));
        };
        let cost = item
            .unit_cost_minor
            .filter(|v| *v >= 0)
            .ok_or_else(|| refuse("unknown_unit_price"))?;
        if currency.as_ref().is_some_and(|v| v != &unit) || price.is_some_and(|v| v != cost) {
            return Err(refuse("inconsistent_unit_price"));
        }
        currency = Some(unit);
        price = Some(cost);
    }
    let amount = price
        .and_then(|p| p.checked_mul(i64::try_from(quantity).ok()?))
        .ok_or_else(|| refuse("unknown_unit_price"))?;
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    reserve_connector_spend(
        r,
        ReserveSpend {
            binding_id: None,
            workspace_id: c.workspace_id,
            capability_id: c.id,
            budget_item_ids: c.budget_item_ids.clone(),
            lane: LaneKind::Organic,
            executed_version_id: frame.id,
            amount_minor: amount,
            daily_budget_minor: None,
            currency: currency.ok_or_else(|| refuse("unknown_currency"))?,
            evidence_key: key,
            at,
            chain,
            replaces: None,
        },
    )
    .await
    .map(Some)
}

/// Success with no provider cost keeps the known upper bound as exposure, not fabricated spend.
pub async fn settle_metered(
    r: &mut dyn TenantRepos,
    spend: SpendReservation,
    result: Result<Option<i64>, &str>,
) -> Result<(), AppError> {
    let outcome = match result {
        Ok(Some(actual_minor)) if actual_minor >= 0 => SpendOutcome::Settled {
            actual_minor,
            evidence_key: spend.request.evidence_key,
        },
        Err("auth" | "permission" | "permanent") => SpendOutcome::Refused,
        _ => SpendOutcome::Unknown,
    };
    r.studio_budget().settle(spend.id, outcome).await
}
