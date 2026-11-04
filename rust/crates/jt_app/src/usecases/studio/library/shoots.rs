//! The çekim listesi (spec §4.6, D11): what to shoot or upload. The planner's requests close
//! themselves; an agent or a person adds requests of its own and resolves them.
use super::{conflict, invalid, is_agent, open, refused};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::materials::{ShootReason, ShootRequest, ShootRequestId, ShootStatus},
    usecases::{
        Deps, ledger_entry,
        studio::files::{decode, encode, key},
    },
};
use jt_studio::istanbul_day;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Date, Duration};

/// Which requests `studio.shoot_list` answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShootFilter {
    #[default]
    Open,
    Done,
    Dismissed,
    All,
}

/// `studio.shoot_list`'s filter.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShootQuery {
    #[serde(default)]
    pub status: ShootFilter,
}

/// `studio.shoot_request`'s input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShootRequestInput {
    pub request_key: String,
    /// What to shoot or upload, for the owner (Turkish).
    pub text: String,
    /// The Monday of the week it is for; this Istanbul week when absent.
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub week_start: Option<Date>,
}

/// How a request ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShootResolution {
    Done,
    Dismissed,
}

/// `studio.shoot_resolve`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShootResolveInput {
    pub request_id: ShootRequestId,
    pub status: ShootResolution,
}

/// The Istanbul Monday of `day`'s week.
fn monday(day: Date) -> Date {
    day - Duration::days(i64::from(day.weekday().number_days_from_monday()))
}

/// The çekim listesi: open requests unless `status` says otherwise, newest week first.
pub async fn shoot_list(d: &Deps, ctx: &Ctx, q: ShootQuery) -> Result<Vec<ShootRequest>, AppError> {
    let mut r = open(d, ctx).await?;
    Ok(r.studio_materials()
        .list_shoot_requests()
        .await?
        .into_iter()
        .filter(|s| match q.status {
            ShootFilter::Open => s.status == ShootStatus::Open,
            ShootFilter::Done => s.status == ShootStatus::Done,
            ShootFilter::Dismissed => s.status == ShootStatus::Dismissed,
            ShootFilter::All => true,
        })
        .collect())
}

/// Adds a request to the çekim listesi, keyed `agent:{request_key}` or `human:{request_key}`;
/// replayed by that key (an agent's and a person's keys never meet).
pub async fn shoot_request(
    d: &Deps,
    ctx: &Ctx,
    i: ShootRequestInput,
) -> Result<ShootRequest, AppError> {
    key(&i.request_key)?;
    if i.week_start.is_some_and(|w| monday(w) != w) {
        return Err(refused(
            "week_start",
            "not_a_monday",
            "a week starts on a Monday",
        ));
    }
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    // An agent's keys and a person's are apart: the request's key replays it.
    let shoot_key = format!(
        "{}:{}",
        if is_agent(ctx) { "agent" } else { "human" },
        i.request_key
    );
    let mut r = open(d, ctx).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.shoot_request", &shoot_key, &payload)
        .await?
    {
        return decode(v);
    }
    let request = ShootRequest {
        id: ShootRequestId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        key: shoot_key.clone(),
        reason: ShootReason::Requested,
        text: i.text.trim().to_owned(),
        week_start: i
            .week_start
            .unwrap_or_else(|| monday(istanbul_day(ctx.now))),
        status: ShootStatus::Open,
        created_by: ctx.actor.clone(),
        created_at: ctx.now,
        resolved_by: None,
        resolved_at: None,
    };
    request.validate().map_err(invalid)?;
    if !r
        .studio_materials()
        .insert_shoot_request(request.clone())
        .await?
    {
        return Err(conflict("request_key_taken"));
    }
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.shoot.requested",
            "studio_shoot_request",
            request.id,
            json!({"reason":"requested","week_start":request.week_start.to_string()}),
        )?)
        .await?;
    r.studio()
        .request_receipt(
            "studio.shoot_request",
            &shoot_key,
            &payload,
            &encode(&request)?,
        )
        .await?;
    r.commit().await?;
    Ok(request)
}

/// Marks a request done or dismissed. The planner's own requests close themselves once their
/// condition holds; an agent resolves only requests a person or an agent added
/// (`CONFLICT` `closes_itself`), a person any. Resolving again as the same is no change; as the
/// other is `CONFLICT` `already_resolved`.
pub async fn shoot_resolve(
    d: &Deps,
    ctx: &Ctx,
    i: ShootResolveInput,
) -> Result<ShootRequest, AppError> {
    let status = match i.status {
        ShootResolution::Done => ShootStatus::Done,
        ShootResolution::Dismissed => ShootStatus::Dismissed,
    };
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let current = r
        .studio_materials()
        .get_shoot_request(i.request_id)
        .await?
        .ok_or_else(|| AppError::not_found("shoot request"))?;
    if current.status == status {
        return Ok(current);
    }
    if current.status != ShootStatus::Open {
        return Err(conflict("already_resolved"));
    }
    if is_agent(ctx) && current.reason.is_system() {
        return Err(conflict("closes_itself"));
    }
    let request = ShootRequest {
        status,
        resolved_by: Some(ctx.actor.clone()),
        resolved_at: Some(ctx.now),
        ..current
    };
    request.validate().map_err(invalid)?;
    r.studio_materials()
        .update_shoot_request(request.clone())
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.shoot.resolved",
            "studio_shoot_request",
            request.id,
            json!({"status":status.key(),"system":request.reason.is_system()}),
        )?)
        .await?;
    r.commit().await?;
    Ok(request)
}
