//! The pool's report (spec 2026-10-30-leads-pool-outreach-design.md §3.16, D22;
//! `prospects.report`): computed at read time from the prospects and their journeys' events,
//! nothing stored, so it never goes stale.
//!
//! Two cohorts over the half-open range `[from, to)`:
//! - the prospects **created** in it: `created`, `scored` (a score recorded), `qualified`
//!   (qualified or promoted now), `rejected` by reason (rejected now);
//! - the prospects **promoted** in it: `promoted`, and what their journey did since the
//!   promotion, each counted once per prospect: `contacted` (an outreach email or another
//!   outbound message), `replied` (an inbound message), `meetings`, `quoted`, `won`, `lost` by
//!   reason, and `won_revenue` per currency (**never summed across currencies**), with the rates
//!   promoted → replied, replied → meeting, meeting → won.
//!
//! A prospect is grouped by its record (a promoted prospect is never edited or scored again, so
//! its record is its snapshot at promotion): its source (`origin.via`), research task, segment,
//! sector, city, score bucket (the promotion's, else the latest score's) or rubric digest.

use std::collections::BTreeMap;

use jt_inbox::JourneyEventKind;
use jt_prospects::{DecisionKind, Prospect, ProspectStatus};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::prospects::MAX_REPORT_ROWS;
use crate::usecases::{Deps, report_range};

/// The most journey events read per promoted prospect.
const EVENTS_PER_JOURNEY: u32 = 500;

/// What a pool report groups by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    #[default]
    Source,
    ResearchTask,
    Segment,
    Sector,
    City,
    ScoreBucket,
    RubricDigest,
}

/// `jeeta.prospects.report`'s input: the range `[from, to)` (RFC 3339 instants, at most 366
/// days) and the grouping (`source` unless given).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub group_by: GroupBy,
}

/// The funnel's rates, `None` while their denominator is zero; rounded to four places.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Rates {
    pub promoted_to_replied: Option<f64>,
    pub replied_to_meeting: Option<f64>,
    pub meeting_to_won: Option<f64>,
}

/// One group's counts (see the module docs).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ReportGroup {
    /// The group's value; `None` for the prospects without one.
    pub key: Option<String>,
    pub created: u32,
    pub scored: u32,
    pub qualified: u32,
    /// By reason key.
    pub rejected: BTreeMap<String, u32>,
    pub promoted: u32,
    pub contacted: u32,
    pub replied: u32,
    pub meetings: u32,
    pub quoted: u32,
    pub won: u32,
    /// By lost-reason key.
    pub lost: BTreeMap<String, u32>,
    /// Minor units per currency code; never summed across currencies.
    pub won_revenue: BTreeMap<String, i64>,
    pub rates: Rates,
}

/// A pool report.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReportOut {
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub to: OffsetDateTime,
    pub group_by: GroupBy,
    /// By key, the prospects without one first.
    pub groups: Vec<ReportGroup>,
    /// More prospects fall in the range than one report reads (`MAX_REPORT_ROWS`).
    pub truncated: bool,
}

/// The key prospect `p` is grouped under.
fn key_of(p: &Prospect, by: GroupBy) -> Option<String> {
    match by {
        GroupBy::Source => serde_json::to_value(p.origin.via)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned)),
        GroupBy::ResearchTask => p.research_task_id.map(|t| t.to_string()),
        GroupBy::Segment => p.segment_key.clone(),
        GroupBy::Sector => p.sector.clone(),
        GroupBy::City => p.city.clone(),
        GroupBy::ScoreBucket => p
            .promoted
            .as_ref()
            .and_then(|x| x.bucket)
            .or_else(|| {
                p.latest_score
                    .as_ref()
                    .map(|s| jt_prospects::bucket(s.score))
            })
            .map(|b| b.key().to_owned()),
        GroupBy::RubricDigest => p.latest_score.as_ref().map(|s| s.digest.clone()),
    }
}

/// `n / d`, rounded to four places; `None` when `d` is zero.
fn rate(n: u32, d: u32) -> Option<f64> {
    (d > 0).then(|| (f64::from(n) / f64::from(d) * 10_000.0).round() / 10_000.0)
}

/// `jeeta.prospects.report` (see the module docs). Needs `prospects.work`.
pub async fn report(deps: &Deps, ctx: &Ctx, input: ReportInput) -> Result<ReportOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let (from, to) = report_range(&input.from, &input.to)?;
    let within = |at: OffsetDateTime| at >= from && at < to;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let rows = r.prospects().report_rows(from, to, MAX_REPORT_ROWS).await?;
    let truncated = rows.len() >= MAX_REPORT_ROWS as usize;
    let mut groups: BTreeMap<Option<String>, ReportGroup> = BTreeMap::new();
    for p in &rows {
        let key = key_of(p, input.group_by);
        let g = groups.entry(key.clone()).or_insert_with(|| ReportGroup {
            key,
            ..ReportGroup::default()
        });
        if within(p.created_at) {
            g.created += 1;
            g.scored += u32::from(p.latest_score.is_some());
            g.qualified += u32::from(matches!(
                p.status,
                ProspectStatus::Qualified | ProspectStatus::Promoted
            ));
            if p.status == ProspectStatus::Rejected
                && let Some(DecisionKind::Rejected(reason)) = p.decision.as_ref().map(|d| d.kind)
            {
                *g.rejected.entry(reason.key().to_owned()).or_default() += 1;
            }
        }
        let Some(promotion) = p.promoted.as_ref().filter(|x| within(x.at)) else {
            continue;
        };
        g.promoted += 1;
        let events = r
            .journeys()
            .events(promotion.journey_id, EVENTS_PER_JOURNEY)
            .await?;
        let (mut contacted, mut replied, mut meeting, mut quoted, mut won) =
            (false, false, false, false, false);
        let mut lost = None;
        for ev in events.iter().filter(|ev| ev.at >= promotion.at) {
            match &ev.kind {
                JourneyEventKind::OutreachSent { .. } | JourneyEventKind::Replied => {
                    contacted = true;
                }
                JourneyEventKind::MessageReceived => replied = true,
                JourneyEventKind::AppointmentBooked => meeting = true,
                JourneyEventKind::QuoteSent => quoted = true,
                JourneyEventKind::Won {
                    amount_minor,
                    currency,
                    ..
                } => {
                    won = true;
                    *g.won_revenue.entry(currency.clone()).or_default() += amount_minor;
                }
                JourneyEventKind::Lost { reason_key } => lost = Some(reason_key.clone()),
                _ => {}
            }
        }
        g.contacted += u32::from(contacted);
        g.replied += u32::from(replied);
        g.meetings += u32::from(meeting);
        g.quoted += u32::from(quoted);
        g.won += u32::from(won);
        if let Some(reason) = lost {
            *g.lost.entry(reason).or_default() += 1;
        }
    }
    let groups = groups
        .into_values()
        .map(|mut g| {
            g.rates = Rates {
                promoted_to_replied: rate(g.replied, g.promoted),
                replied_to_meeting: rate(g.meetings, g.replied),
                meeting_to_won: rate(g.won, g.meetings),
            };
            g
        })
        .collect();
    Ok(ReportOut {
        from,
        to,
        group_by: input.group_by,
        groups,
        truncated,
    })
}
