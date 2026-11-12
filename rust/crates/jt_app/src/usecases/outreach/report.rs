//! Outreach's report (spec 2026-10-30-leads-pool-outreach-design.md §3.16, D22;
//! `outreach.report`): computed at read time from the send rows, the enrollments and the
//! journeys' events, nothing stored.
//!
//! Over the half-open range `[from, to)`, of one campaign or all of them:
//! - the **sends** created in it (`OutreachSendRepo::report`), per campaign and step: `sent`
//!   (accepted by the mailbox's server: sent, bounced or complained of), `unknown`, `failed`,
//!   `refused` (at claim), `bounced`, `complained`, `replied` (threaded and unthreaded),
//!   `unsubscribed`, `unique_clicks` (sends clicked at least once, `None` while no campaign of the
//!   group tracks clicks) and `automated_clicks`;
//! - the **enrollments**: `enrolled` and `skipped` by reason (enrolled in the range), `stopped`
//!   by reason (stopped in the range);
//! - the **people reached**: `meetings_30d` and `won_30d`, the enrolled people whose first email
//!   of the campaign went out in the range and whose journey booked a meeting or was won within
//!   30 days of it.
//!
//! Grouped by campaign, by step (campaign and step) or by template (across campaigns). What
//! belongs to a person rather than a send is counted at step 1 (enrolled, skipped, meetings,
//! won), a stop at the last step sent before it (step 1 when none was).

use std::collections::BTreeMap;

use jt_inbox::JourneyEventKind;
use jt_outreach::{CampaignId, EnrollmentStatus, TemplateId};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::campaigns::no_such_campaign;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::outreach::{
    CampaignQuery, CampaignRow, EnrollmentQuery, MAX_OUTREACH_PAGE, ReportQuery,
};
use crate::usecases::{Deps, report_range};

/// How long after a person's first email a meeting or a win counts for the campaign.
pub const ATTRIBUTION_WINDOW: Duration = Duration::days(30);
/// The most campaigns one report reads.
const MAX_CAMPAIGNS: usize = 200;
/// The most enrollments one report reads, over every campaign.
const MAX_ENROLLMENTS: usize = 20_000;
/// The most journey events read per person reached.
const EVENTS_PER_JOURNEY: u32 = 500;

/// What an outreach report groups by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    #[default]
    Campaign,
    Step,
    Template,
}

/// `jeeta.outreach.report`'s input: the range `[from, to)` (RFC 3339 instants, at most 366
/// days), one campaign or all, and the grouping (`campaign` unless given).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    #[serde(default)]
    pub campaign_id: Option<CampaignId>,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub group_by: GroupBy,
}

/// One group's counts (see the module docs).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ReportGroup {
    /// Set when grouped by campaign or step.
    pub campaign_id: Option<CampaignId>,
    /// Set when grouped by step.
    pub step: Option<u8>,
    /// Set when grouped by step or template.
    pub template_id: Option<TemplateId>,
    pub enrolled: u32,
    /// By skip reason key.
    pub skipped: BTreeMap<String, u32>,
    pub sent: u32,
    pub unknown: u32,
    pub failed: u32,
    pub refused: u32,
    pub bounced: u32,
    pub complained: u32,
    pub replied: u32,
    pub replied_threaded: u32,
    pub replied_unthreaded: u32,
    pub unsubscribed: u32,
    pub unique_clicks: Option<u32>,
    pub automated_clicks: u32,
    pub meetings_30d: u32,
    pub won_30d: u32,
    /// By stop reason key.
    pub stopped: BTreeMap<String, u32>,
}

/// An outreach report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReportOut {
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub to: OffsetDateTime,
    pub campaign_id: Option<CampaignId>,
    pub group_by: GroupBy,
    /// By campaign, step and template id.
    pub groups: Vec<ReportGroup>,
    /// More campaigns or enrollments than one report reads.
    pub truncated: bool,
}

type Key = (Option<CampaignId>, Option<u8>, Option<TemplateId>);

/// The groups being counted.
struct Groups {
    by: GroupBy,
    rows: BTreeMap<Key, ReportGroup>,
}

impl Groups {
    /// The group of campaign `c`'s step `step` (1-based).
    fn of(&mut self, c: &CampaignRow, step: u8) -> &mut ReportGroup {
        let template = c
            .definition
            .steps
            .get(usize::from(step.max(1) - 1))
            .map(|s| s.template_id);
        let key: Key = match self.by {
            GroupBy::Campaign => (Some(c.id), None, None),
            GroupBy::Step => (Some(c.id), Some(step), template),
            GroupBy::Template => (None, None, template),
        };
        let g = self.rows.entry(key).or_insert_with(|| ReportGroup {
            campaign_id: key.0,
            step: key.1,
            template_id: key.2,
            ..ReportGroup::default()
        });
        if c.definition.click_tracking && g.unique_clicks.is_none() {
            g.unique_clicks = Some(0);
        }
        g
    }
}

/// `jeeta.outreach.report` (see the module docs). Needs `outreach.work`.
pub async fn report(deps: &Deps, ctx: &Ctx, input: ReportInput) -> Result<ReportOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let (from, to) = report_range(&input.from, &input.to)?;
    let within = |at: OffsetDateTime| at >= from && at < to;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut truncated = false;
    let campaigns: Vec<CampaignRow> = match input.campaign_id {
        Some(id) => vec![
            r.outreach_campaigns()
                .get(id)
                .await?
                .ok_or_else(no_such_campaign)?,
        ],
        None => {
            let mut all = Vec::new();
            let mut before = None;
            loop {
                let page = r
                    .outreach_campaigns()
                    .list(&CampaignQuery {
                        status: None,
                        limit: MAX_OUTREACH_PAGE,
                        before,
                    })
                    .await?;
                all.extend(page.items);
                match page.next {
                    Some(next) if all.len() < MAX_CAMPAIGNS => before = Some(next),
                    Some(_) => {
                        truncated = true;
                        break;
                    }
                    None => break,
                }
            }
            all.truncate(MAX_CAMPAIGNS);
            all
        }
    };
    let by_id: BTreeMap<CampaignId, &CampaignRow> = campaigns.iter().map(|c| (c.id, c)).collect();
    let mut groups = Groups {
        by: input.group_by,
        rows: BTreeMap::new(),
    };
    // The sends, per campaign and step.
    let counts = r
        .outreach_sends()
        .report(&ReportQuery {
            campaign_id: input.campaign_id,
            from,
            to,
        })
        .await?;
    for s in counts {
        let Some(c) = by_id.get(&s.campaign_id) else {
            continue;
        };
        let g = groups.of(c, s.step);
        g.sent += s.sent + s.bounced + s.complained;
        g.unknown += s.unknown;
        g.failed += s.failed;
        g.refused += s.refused;
        g.bounced += s.bounced;
        g.complained += s.complained;
        g.replied += s.replied;
        g.replied_threaded += s.replied_threaded;
        g.replied_unthreaded += s.replied.saturating_sub(s.replied_threaded);
        g.unsubscribed += s.unsubscribed;
        if let Some(n) = g.unique_clicks.as_mut() {
            *n += s.clicked;
        }
        g.automated_clicks += s.automated_clicks;
    }
    // The enrollments and the people reached.
    let mut read = 0usize;
    for c in &campaigns {
        let mut after = None;
        loop {
            let page = r
                .outreach_enrollments()
                .list(
                    c.id,
                    &EnrollmentQuery {
                        status: None,
                        limit: MAX_OUTREACH_PAGE,
                        after,
                    },
                )
                .await?;
            read += page.items.len();
            for e in &page.items {
                if within(e.enrolled_at) {
                    let g = groups.of(c, 1);
                    match e.skip {
                        Some(reason) => {
                            *g.skipped.entry(reason.key().to_owned()).or_default() += 1;
                        }
                        None => g.enrolled += 1,
                    }
                }
                if let (Some(reason), Some(at)) = (&e.stop, e.stopped_at)
                    && within(at)
                {
                    let g = groups.of(c, e.next_step.saturating_sub(1).max(1));
                    *g.stopped.entry(reason.key()).or_default() += 1;
                }
                if e.status == EnrollmentStatus::Skipped || e.last_sent_at.is_none() {
                    continue;
                }
                // The person's first email of this enrollment: their first send since enrolling
                // (one active enrollment at a time, so it is this campaign's step 1).
                let Some(first) = r
                    .outreach_sends()
                    .person_send_times(e.person_id, e.enrolled_at)
                    .await?
                    .into_iter()
                    .next()
                    .filter(|at| within(*at))
                else {
                    continue;
                };
                let journey = match e.journey_id {
                    Some(id) => Some(id),
                    None => {
                        crate::usecases::inbox::active_or_latest_journey(r.as_mut(), e.person_id)
                            .await?
                            .map(|j| j.id)
                    }
                };
                let Some(journey) = journey else {
                    continue;
                };
                let events = r.journeys().events(journey, EVENTS_PER_JOURNEY).await?;
                let window = |at: OffsetDateTime| at >= first && at < first + ATTRIBUTION_WINDOW;
                let meeting = events
                    .iter()
                    .any(|ev| ev.kind == JourneyEventKind::AppointmentBooked && window(ev.at));
                let won = events
                    .iter()
                    .any(|ev| matches!(ev.kind, JourneyEventKind::Won { .. }) && window(ev.at));
                let g = groups.of(c, 1);
                g.meetings_30d += u32::from(meeting);
                g.won_30d += u32::from(won);
            }
            match page.next {
                Some(next) if read < MAX_ENROLLMENTS => after = Some(next),
                Some(_) => {
                    truncated = true;
                    break;
                }
                None => break,
            }
        }
        if read >= MAX_ENROLLMENTS {
            truncated |= campaigns.last().is_some_and(|last| last.id != c.id);
            break;
        }
    }
    Ok(ReportOut {
        from,
        to,
        campaign_id: input.campaign_id,
        group_by: input.group_by,
        groups: groups.rows.into_values().collect(),
        truncated,
    })
}
