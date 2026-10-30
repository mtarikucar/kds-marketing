//! The pool's settings (spec §3.6, §3.7; §7.1 `prospects.settings_get`, `settings_set`): the
//! retention periods, the promotion cap and the time zone the daily caps count in, kept in the
//! workspace's leads policy.

use jt_prospects::ProspectsPolicy;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::usecases::{Deps, hours, invalid, nothing_to_change};

/// What `prospects.settings_get` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SettingsOut {
    /// The IANA time zone the pool's daily caps count in.
    pub timezone: String,
    #[serde(flatten)]
    pub prospects: ProspectsPolicy,
}

/// `jeeta.prospects.settings_set`'s input: the keys to change, each within its bounds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInput {
    #[serde(default)]
    pub timezone: Option<String>,
    /// `1..=730`.
    #[serde(default)]
    pub rejected_retention_days: Option<u16>,
    /// `1..=730`.
    #[serde(default)]
    pub unpromoted_retention_days: Option<u16>,
    /// `0..=1095`.
    #[serde(default)]
    pub rejected_memory_days: Option<u16>,
    /// `1..=1000`.
    #[serde(default)]
    pub max_promotions_per_day: Option<u16>,
    #[serde(default)]
    pub agents_promote_qualified_only: Option<bool>,
}

const FIELDS: &[&str] = &[
    "timezone",
    "rejected_retention_days",
    "unpromoted_retention_days",
    "rejected_memory_days",
    "max_promotions_per_day",
    "agents_promote_qualified_only",
];

fn within(field: &str, v: Option<u16>, min: u16, max: u16) -> Result<(), AppError> {
    match v {
        Some(v) if !(min..=max).contains(&v) => {
            Err(invalid(field, &format!("{field} is {min}..={max}")))
        }
        _ => Ok(()),
    }
}

/// `jeeta.prospects.settings_get`.
pub async fn settings_get(deps: &Deps, ctx: &Ctx) -> Result<SettingsOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let leads = super::leads_policy(r.as_mut()).await?;
    Ok(SettingsOut {
        timezone: leads.timezone,
        prospects: leads.prospects,
    })
}

/// `jeeta.prospects.settings_set`: changes the keys given, keeps every other one; the new
/// periods apply to each prospect's purge time at its next change.
pub async fn settings_set(
    deps: &Deps,
    ctx: &Ctx,
    input: SettingsInput,
) -> Result<SettingsOut, AppError> {
    ctx.require(Permission::ProspectsManage)?;
    let changed: Vec<&str> = [
        input.timezone.is_some(),
        input.rejected_retention_days.is_some(),
        input.unpromoted_retention_days.is_some(),
        input.rejected_memory_days.is_some(),
        input.max_promotions_per_day.is_some(),
        input.agents_promote_qualified_only.is_some(),
    ]
    .into_iter()
    .zip(FIELDS)
    .filter_map(|(given, f)| given.then_some(*f))
    .collect();
    if changed.is_empty() {
        return Err(nothing_to_change(FIELDS));
    }
    let timezone = input.timezone.as_deref().map(str::trim);
    if timezone.is_some_and(|tz| !hours::known_time_zone(tz)) {
        return Err(invalid(
            "timezone",
            "timezone is an IANA time zone, e.g. Europe/Istanbul",
        ));
    }
    within(
        "rejected_retention_days",
        input.rejected_retention_days,
        1,
        730,
    )?;
    within(
        "unpromoted_retention_days",
        input.unpromoted_retention_days,
        1,
        730,
    )?;
    within("rejected_memory_days", input.rejected_memory_days, 0, 1095)?;
    within(
        "max_promotions_per_day",
        input.max_promotions_per_day,
        1,
        1000,
    )?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut policy = r.workspace_policy().get().await?;
    let leads = &mut policy.leads;
    if let Some(tz) = timezone {
        leads.timezone = tz.to_owned();
    }
    let p = &mut leads.prospects;
    p.rejected_retention_days = input
        .rejected_retention_days
        .unwrap_or(p.rejected_retention_days);
    p.unpromoted_retention_days = input
        .unpromoted_retention_days
        .unwrap_or(p.unpromoted_retention_days);
    p.rejected_memory_days = input.rejected_memory_days.unwrap_or(p.rejected_memory_days);
    p.max_promotions_per_day = input
        .max_promotions_per_day
        .unwrap_or(p.max_promotions_per_day);
    p.agents_promote_qualified_only = input
        .agents_promote_qualified_only
        .unwrap_or(p.agents_promote_qualified_only);
    let out = SettingsOut {
        timezone: leads.timezone.clone(),
        prospects: leads.prospects.clone(),
    };
    r.workspace_policy().set(policy, ctx.now).await?;
    let version = crate::usecases::capabilities::version_in_force(r.as_mut()).await?;
    crate::usecases::capabilities::append(
        r.as_mut(),
        ctx,
        "prospects.settings_set",
        "prospect_pool",
        ctx.workspace_id,
        version,
        json!({ "fields": changed }),
    )
    .await?;
    r.commit().await?;
    Ok(out)
}
