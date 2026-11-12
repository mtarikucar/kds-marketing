//! Outreach's pending work (spec 2026-10-30-leads-pool-outreach-design.md §3.17, D69), listed by
//! `work.pending` for a caller holding `outreach.work`:
//!
//! - `personalization_due {campaign_id, count}`: a running or scheduled campaign's active
//!   enrollments due within 24 hours whose next step uses a `custom.*` variable without a
//!   fallback that their personalization lacks (cleared by `outreach.personalize`);
//! - `campaign_blocked {campaign_id, reason}`: a campaign paused for its bounces, its complaints,
//!   its mailbox or the strategy, not by hand (cleared by `outreach.campaigns_control`);
//! - `campaign_approval {campaign_id, revision}`: a campaign waiting for approval, for a person
//!   with `outreach.manage` only (cleared by `outreach.campaigns_approve`);
//! - `promoted_not_contacted {count}`: prospects promoted two to thirty days ago whose journey is
//!   open, with no outbound message since and no enrollment (cleared by `outreach.enroll`).
//!
//! Reads only, bounded: at most [`ENROLLMENTS_READ`] enrollments a campaign and
//! [`PROMOTED_READ`] promoted prospects (a count at the bound means at least that many).

use std::collections::BTreeMap;

use jt_inbox::JourneyEventKind;
use jt_ledger::Actor;
use jt_outreach::{
    CampaignId, CampaignStatus, PauseReason, RenderError, RenderVars, StepSnapshot, render_body,
};
use jt_prospects::ProspectStatus;
use jt_tenancy::Permission;
use time::Duration;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::outreach::{CampaignRow, EnrollmentQuery, EnrollmentRow, MAX_OUTREACH_PAGE};
use crate::ports::prospects::ProspectQuery;

/// How soon a step's send makes a missing personalization due.
pub const PERSONALIZATION_HORIZON: Duration = Duration::hours(24);
/// How long after its promotion a prospect not contacted is listed, and for how long.
pub const NOT_CONTACTED_AFTER: Duration = Duration::days(2);
const NOT_CONTACTED_UNTIL: Duration = Duration::days(30);
/// The most active enrollments read a campaign.
pub const ENROLLMENTS_READ: usize = 1_000;
/// The most promoted prospects read (the newest).
pub const PROMOTED_READ: u32 = 100;
/// The most campaigns of a state read.
const CAMPAIGNS_READ: u32 = 50;
/// The most journey events read per promoted prospect.
const EVENTS_READ: u32 = 200;

/// What is pending in outreach for the caller.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OutreachPending {
    pub personalization_due: Vec<(CampaignId, u32)>,
    pub blocked: Vec<(CampaignId, PauseReason)>,
    pub approvals: Vec<(CampaignId, u32)>,
    pub promoted_not_contacted: u32,
}

/// Each step's snapshot of campaign `c` with the keys of its variables that are not
/// `custom.*` (filled with a placeholder, so only a missing personalization is missing).
fn steps_of(c: &CampaignRow) -> Vec<Option<(StepSnapshot, Vec<String>)>> {
    c.definition
        .steps
        .iter()
        .map(|s| {
            let snapshot = s.snapshot.clone()?;
            let facts = jt_outreach::validate_template(&snapshot.subject, &snapshot.body).ok()?;
            let others = facts
                .vars
                .iter()
                .map(|v| v.key())
                .filter(|k| !k.starts_with("custom."))
                .collect();
            Some((snapshot, others))
        })
        .collect()
}

/// Whether enrollment `e`'s next step needs a `custom.*` value its personalization lacks.
fn misses_personalization(
    steps: &[Option<(StepSnapshot, Vec<String>)>],
    e: &EnrollmentRow,
) -> bool {
    let Some(Some((snapshot, others))) = steps.get(usize::from(e.next_step).wrapping_sub(1)) else {
        return false;
    };
    let mut values: BTreeMap<String, String> =
        others.iter().map(|k| (k.clone(), "x".to_owned())).collect();
    for (k, v) in &e.personalization {
        values.insert(format!("custom.{k}"), v.clone());
    }
    matches!(
        render_body(snapshot, &RenderVars { values }, None),
        Err(RenderError::MissingVariable(key)) if key.starts_with("custom.")
    )
}

/// How many of campaign `c`'s active enrollments are due within the horizon and miss a value.
async fn personalization_due(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    c: &CampaignRow,
) -> Result<u32, AppError> {
    let steps = steps_of(c);
    if !steps
        .iter()
        .flatten()
        .any(|(s, _)| s.subject.contains("custom.") || s.body.contains("custom."))
    {
        return Ok(0);
    }
    let horizon = ctx.now + PERSONALIZATION_HORIZON;
    let (mut due, mut read, mut after) = (0u32, 0usize, None);
    loop {
        let page = r
            .outreach_enrollments()
            .list(
                c.id,
                &EnrollmentQuery {
                    status: Some(jt_outreach::EnrollmentStatus::Active),
                    limit: MAX_OUTREACH_PAGE,
                    after,
                },
            )
            .await?;
        read += page.items.len();
        due += page
            .items
            .iter()
            .filter(|e| e.next_send_at.is_some_and(|at| at <= horizon))
            .filter(|e| misses_personalization(&steps, e))
            .count() as u32;
        match page.next {
            Some(next) if read < ENROLLMENTS_READ => after = Some(next),
            _ => break,
        }
    }
    Ok(due)
}

/// How many prospects promoted two to thirty days ago (of the newest [`PROMOTED_READ`]) have an
/// open journey with no outbound message since their promotion and no enrollment.
async fn promoted_not_contacted(r: &mut dyn TenantRepos, ctx: &Ctx) -> Result<u32, AppError> {
    let (from, to) = (ctx.now - NOT_CONTACTED_UNTIL, ctx.now - NOT_CONTACTED_AFTER);
    let page = r
        .prospects()
        .list(&ProspectQuery {
            status: Some(ProspectStatus::Promoted),
            limit: PROMOTED_READ,
            ..ProspectQuery::default()
        })
        .await?;
    let mut count = 0;
    for p in page.items {
        let Some(x) = p.promoted.filter(|x| x.at >= from && x.at < to) else {
            continue;
        };
        if !r
            .outreach_enrollments()
            .for_person(x.person_id)
            .await?
            .is_empty()
        {
            continue;
        }
        let open = r
            .journeys()
            .get(x.journey_id)
            .await?
            .is_some_and(|j| j.closed_at.is_none());
        if !open {
            continue;
        }
        let contacted = r
            .journeys()
            .events(x.journey_id, EVENTS_READ)
            .await?
            .iter()
            .any(|ev| {
                ev.at >= x.at
                    && matches!(
                        ev.kind,
                        JourneyEventKind::OutreachSent { .. } | JourneyEventKind::Replied
                    )
            });
        count += u32::from(!contacted);
    }
    Ok(count)
}

/// Outreach's pending work for `ctx` (see the module docs), read in `r`.
pub(crate) async fn pending_in(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
) -> Result<OutreachPending, AppError> {
    let mut out = OutreachPending::default();
    for status in [CampaignStatus::Running, CampaignStatus::Scheduled] {
        for c in r
            .outreach_campaigns()
            .by_status(status, CAMPAIGNS_READ)
            .await?
        {
            let due = personalization_due(r, ctx, &c).await?;
            if due > 0 {
                out.personalization_due.push((c.id, due));
            }
        }
    }
    for c in r
        .outreach_campaigns()
        .by_status(CampaignStatus::Paused, CAMPAIGNS_READ)
        .await?
    {
        if let Some(reason) = c.pause_reason.filter(|r| *r != PauseReason::Manual) {
            out.blocked.push((c.id, reason));
        }
    }
    if matches!(ctx.actor, Actor::Human { .. })
        && ctx.permissions.contains(&Permission::OutreachManage)
    {
        for c in r
            .outreach_campaigns()
            .by_status(CampaignStatus::AwaitingApproval, CAMPAIGNS_READ)
            .await?
        {
            out.approvals.push((c.id, c.revision));
        }
    }
    out.promoted_not_contacted = promoted_not_contacted(r, ctx).await?;
    Ok(out)
}
