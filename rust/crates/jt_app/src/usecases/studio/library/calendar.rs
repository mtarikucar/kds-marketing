//! The workspace's calendar (its edits of the Turkish defaults and the dates its owner enters, spec
//! §4.4, D12) and its materials policy (D18).
use super::{invalid, open, refused};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::materials::{Calendar, CalendarEntry, MaterialPolicy, OccasionKind},
    usecases::{Deps, ledger_entry, studio::control::human_approver},
};
use jt_studio::istanbul_day;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::Date;

/// `studio.calendar_list`'s input: the year (this Istanbul year when absent).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarQuery {
    #[serde(default)]
    pub year: Option<i32>,
}

/// A year's effective calendar, the workspace's own rows of it, and the materials policy.
#[derive(Clone, Debug, Serialize)]
pub struct CalendarOut {
    pub year: i32,
    /// The defaults overlaid by the workspace's rows; an entry without a window is inactive.
    pub entries: Vec<CalendarEntry>,
    /// What the workspace changed or entered for the year.
    pub rows: Vec<CalendarEntry>,
    pub policy: MaterialPolicy,
}

/// `studio.calendar_set`'s input: the row of `key` and `year`, replacing the one there.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarSetInput {
    pub key: String,
    pub year: i32,
    pub name: String,
    pub kind: OccasionKind,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub window_start: Option<Date>,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub window_end: Option<Date>,
    #[serde(default)]
    pub lead_days: Option<u16>,
    pub enabled: bool,
}

/// `VALIDATION` unless `year` is a calendar year Studio keeps.
fn check_year(year: i32) -> Result<(), AppError> {
    if (2000..=2100).contains(&year) {
        Ok(())
    } else {
        Err(refused(
            "year",
            "out_of_range",
            "the year must be 2000 to 2100",
        ))
    }
}

/// The effective calendar of a year, its workspace rows and the materials policy.
pub async fn calendar_list(d: &Deps, ctx: &Ctx, q: CalendarQuery) -> Result<CalendarOut, AppError> {
    let year = q.year.unwrap_or_else(|| istanbul_day(ctx.now).year());
    check_year(year)?;
    let mut r = open(d, ctx).await?;
    let rows: Vec<CalendarEntry> = r
        .studio_materials()
        .calendar_rows()
        .await?
        .into_iter()
        .filter(|e| e.year == year)
        .collect();
    let policy = r.studio_materials().material_policy().await?;
    Ok(CalendarOut {
        year,
        entries: Calendar::effective(year..=year, &rows).entries,
        rows,
        policy,
    })
}

/// An owner or manager edits a year's entry of the calendar or enters its dates (D4, D12).
pub async fn calendar_set(
    d: &Deps,
    ctx: &Ctx,
    i: CalendarSetInput,
) -> Result<CalendarEntry, AppError> {
    human_approver(ctx)?;
    check_year(i.year)?;
    let row = CalendarEntry {
        key: i.key,
        year: i.year,
        name: i.name,
        kind: i.kind,
        window_start: i.window_start,
        window_end: i.window_end,
        lead_days: i.lead_days,
        enabled: i.enabled,
    };
    row.validate().map_err(invalid)?;
    let mut r = open(d, ctx).await?;
    // The calendar decides which season materials are in their window: the publisher's fence.
    r.studio_control().lock_control().await?;
    r.studio_materials().save_calendar_row(row.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.calendar.set",
            "studio_calendar",
            format!("{}:{}", row.key, row.year),
            json!({"key":row.key,"year":row.year,"kind":row.kind,"enabled":row.enabled,
                "dated":row.window_start.is_some(),"lead_days":row.lead_days}),
        )?)
        .await?;
    r.commit().await?;
    Ok(row)
}

/// An owner or manager sets the materials policy (D18): lead, reuse and recap days.
pub async fn material_policy_set(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialPolicy,
) -> Result<MaterialPolicy, AppError> {
    human_approver(ctx)?;
    i.validate().map_err(invalid)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    r.studio_materials().save_material_policy(i).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.material.policy_set",
            "studio_material_policy",
            ctx.workspace_id,
            json!({"lead_days":i.lead_days,"reuse_days":i.reuse_days,"recap_days":i.recap_days}),
        )?)
        .await?;
    r.commit().await?;
    Ok(i)
}
