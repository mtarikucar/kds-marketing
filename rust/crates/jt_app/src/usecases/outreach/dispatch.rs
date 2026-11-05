//! The outreach dispatcher (spec §3.11; job `outreach_dispatch`, every minute, active
//! workspaces): due enrollments of running campaigns become outbox entries, through the same
//! pipeline every inbox send takes (D14), within the window, the budgets and the warm-up.
//!
//! - **Nothing while locked**: with the platform switch `JEETA_OUTREACH_ENABLED` off a run does
//!   nothing at all (F2); every send is fenced again at enqueue and at claim
//!   (`claim_fence`), the switch first.
//! - **Per campaign**, oldest launch first: the sender identity (F10), the mailbox (a mailbox that
//!   is not live pauses the campaign, `mailbox_down`), the window (the campaign's ∩ the mailbox's
//!   `active_hours`), the budget (`jt_outreach::budget` over the mailbox's local day, warm-up
//!   included, the campaign's day and hour, and the per-minute pacing), then the due enrollments.
//! - **Per enrollment**, each authoritative (D16): the person gone or the journey closed stops;
//!   the frequency cap and the domain pacing postpone; a business-basis send to an address not
//!   looked up in the last 30 days waits for an İYS lookup (at most [`IYS_LOOKUPS_PER_RUN`] a run,
//!   before any transaction; a `RET` is recorded as a withdrawal); the step is rendered (a missing
//!   `custom.*` value waits up to [`PERSONALIZATION_WAIT`], any other missing value stops); then
//!   one transaction under the inbox lock re-runs the outreach fence (F3, F7, F9), queues the
//!   email through `replies::enqueue_in` (`Target::PersonVia`, `Purpose::Outreach`: the inbox
//!   fence, the footer and the one-click unsubscribe of every commercial email), writes the
//!   `outreach_sends` row and advances the enrollment. The provider is called after the commit
//!   (`replies::send_step`), never inside a transaction.
//! - A refusal about the person stops the enrollment (`refused:<reason>`, or its own stop
//!   reason); one about the campaign or the workspace (approval, the mailbox, the strategy) leaves
//!   the enrollment due and ends the campaign's run.
//! - **Auto-pause** after each campaign's run (`jt_outreach::auto_pause` over its newest 200
//!   outcomes), and a running campaign with no active enrollment left (and not evergreen)
//!   completes.

use std::collections::BTreeSet;

use jt_capability::{Capability, EffectiveStatus, effective_status};
use jt_inbox::{
    Channel, CommercialBasis, ConsentKind, ConsentSource, IdentityChannel, JourneyEventKind,
    JourneyStatus, PersonId, SendIntent, SuppressionReason,
};
use jt_outreach::{
    BudgetInput, CampaignEvent, CampaignStatus, DOMAIN_POSTPONE, OutreachFacts, OutreachRefusal,
    PauseReason, RenderError, RenderVars, SendId, SendOutcome, StopReason, auto_pause, budget,
    campaign_next, domain_ok, frequency_next_allowed, next_step_after, outreach_fence, render_body,
    requires_approval, warmup_cap, warmup_day_index,
};
use jt_tenancy::Permission;
use serde::Serialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use super::audience::{Basis, Verdict, person_keys, person_verdict};
use super::{outreach_policy, record};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::connectors::IysAnswer;
use crate::ports::outreach::{CampaignRow, EnrollmentRow, SendRow};
use crate::usecases::inbox::replies::{self, Enqueued, OutreachSend, Purpose, ReplyInput, Target};
use crate::usecases::{Deps, hours};

/// The most İYS lookups one run makes in a workspace: the dispatcher runs every minute, and
/// NetGSM's İYS budget is 10 calls a minute (spec §3.12), two left for the hourly sync.
pub const IYS_LOOKUPS_PER_RUN: u32 = 8;
/// How long an İYS answer stands for a business-basis send (spec §3.12).
pub const IYS_CACHE: Duration = Duration::days(30);
/// How long a step waits for a missing `custom.*` value before it stops
/// (`missing_variable:custom.<key>`).
pub const PERSONALIZATION_WAIT: Duration = Duration::hours(72);
/// How long a send waiting for something (a personalization, an İYS answer) is put off.
const RETRY_LATER: Duration = Duration::hours(1);
/// How long a send whose İYS lookup failed is put off.
const IYS_RETRY: Duration = Duration::minutes(15);
/// The most campaigns of a state one run takes.
const CAMPAIGNS_PER_RUN: u32 = 50;
/// How far back the mailbox's sending days count for the warm-up.
const WARMUP_LOOKBACK: Duration = Duration::days(400);

/// What one run did in one workspace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Dispatched {
    /// Scheduled campaigns whose start came.
    pub started: u32,
    /// Running campaigns looked at.
    pub campaigns: u32,
    /// Emails queued (and handed to the provider).
    pub queued: u32,
    pub stopped: u32,
    pub postponed: u32,
    pub paused: u32,
    pub completed: u32,
    /// İYS lookups made.
    pub iys_lookups: u32,
}

/// The context a send is queued under: the job's system actor, with the inbox's send
/// permission.
fn sender(ctx: &Ctx) -> Ctx {
    let mut c = ctx.clone();
    c.permissions = BTreeSet::from([Permission::InboxWork]);
    c
}

/// The job body for one workspace (see the module docs).
pub async fn run(deps: &Deps, ctx: &Ctx) -> Result<Dispatched, AppError> {
    let mut out = Dispatched::default();
    if !deps.apps.outreach_enabled() {
        return Ok(out);
    }
    start_scheduled(deps, ctx, &mut out).await?;
    let campaigns = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.outreach_campaigns()
            .by_status(CampaignStatus::Running, CAMPAIGNS_PER_RUN)
            .await?
    };
    let mut iys_budget = IYS_LOOKUPS_PER_RUN;
    for c in campaigns {
        out.campaigns += 1;
        if let Err(e) = campaign(deps, ctx, &c, &mut iys_budget, &mut out).await {
            tracing::warn!(
                workspace_id = %ctx.workspace_id,
                campaign_id = %c.id,
                code = ?e.code,
                "an outreach campaign's run failed"
            );
        }
        settle(deps, ctx, c.id, &mut out).await?;
    }
    Ok(out)
}

/// Starts the scheduled campaigns whose start time came.
async fn start_scheduled(deps: &Deps, ctx: &Ctx, out: &mut Dispatched) -> Result<(), AppError> {
    let due: Vec<CampaignRow> = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.outreach_campaigns()
            .by_status(CampaignStatus::Scheduled, CAMPAIGNS_PER_RUN)
            .await?
            .into_iter()
            .filter(|c| {
                c.definition
                    .schedule
                    .start_at
                    .is_none_or(|at| at <= ctx.now)
            })
            .collect()
    };
    for c in due {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let Some(mut row) = r.outreach_campaigns().lock(c.id).await? else {
            continue;
        };
        let Ok((to, _)) = campaign_next(
            row.status,
            row.approval.as_ref(),
            row.revision,
            row.definition.schedule.start_at,
            &CampaignEvent::Start { now: ctx.now },
        ) else {
            continue;
        };
        let expected = row.revision;
        row.status = to;
        row.updated_at = ctx.now;
        if r.outreach_campaigns().update(&row, expected).await? {
            record(
                r.as_mut(),
                ctx,
                "outreach.campaign_started",
                "outreach_campaign",
                row.id,
                json!({ "campaign_id": row.id }),
            )
            .await?;
            r.commit().await?;
            out.started += 1;
        }
    }
    Ok(())
}

/// Whether a mailbox capability can send now: verified and sealed.
fn live(cap: &Capability, now: OffsetDateTime) -> bool {
    effective_status(cap, now) == EffectiveStatus::Verified && cap.has_sealed_config
}

/// Pauses a running campaign for `reason` (its own transaction); whether it did.
async fn pause(
    deps: &Deps,
    ctx: &Ctx,
    id: jt_outreach::CampaignId,
    reason: PauseReason,
) -> Result<bool, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(mut row) = r.outreach_campaigns().lock(id).await? else {
        return Ok(false);
    };
    let Ok((to, _)) = campaign_next(
        row.status,
        row.approval.as_ref(),
        row.revision,
        row.definition.schedule.start_at,
        &CampaignEvent::Pause { reason },
    ) else {
        return Ok(false);
    };
    let expected = row.revision;
    row.status = to;
    row.pause_reason = Some(reason);
    row.updated_at = ctx.now;
    if !r.outreach_campaigns().update(&row, expected).await? {
        return Ok(false);
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.campaign_paused",
        "outreach_campaign",
        id,
        json!({ "campaign_id": id, "reason": reason.key() }),
    )
    .await?;
    r.commit().await?;
    Ok(true)
}

/// After a campaign's run: pauses it on its bounces or complaints, completes it once no active
/// enrollment is left (an evergreen one stays running).
async fn settle(
    deps: &Deps,
    ctx: &Ctx,
    id: jt_outreach::CampaignId,
    out: &mut Dispatched,
) -> Result<(), AppError> {
    let (outcomes, active, campaign) = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let outcomes = r.outreach_sends().recent_outcomes(id, 200).await?;
        let active = r.outreach_enrollments().count_active(id).await?;
        (outcomes, active, r.outreach_campaigns().get(id).await?)
    };
    let Some(campaign) = campaign.filter(|c| c.status == CampaignStatus::Running) else {
        return Ok(());
    };
    if let Some(reason) = auto_pause(&outcomes) {
        if pause(deps, ctx, id, reason).await? {
            out.paused += 1;
        }
        return Ok(());
    }
    if active == 0 && !campaign.definition.evergreen {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let Some(mut row) = r.outreach_campaigns().lock(id).await? else {
            return Ok(());
        };
        if campaign_next(
            row.status,
            row.approval.as_ref(),
            row.revision,
            row.definition.schedule.start_at,
            &CampaignEvent::Complete,
        )
        .is_err()
        {
            return Ok(());
        }
        let expected = row.revision;
        row.status = CampaignStatus::Completed;
        row.completed_at = Some(ctx.now);
        row.updated_at = ctx.now;
        if r.outreach_campaigns().update(&row, expected).await? {
            record(
                r.as_mut(),
                ctx,
                "outreach.campaign_completed",
                "outreach_campaign",
                id,
                json!({ "campaign_id": id }),
            )
            .await?;
            r.commit().await?;
            out.completed += 1;
        }
    }
    Ok(())
}

/// How many emails the campaign may send in this run: the window, then `jt_outreach::budget`.
async fn allowance(
    r: &mut dyn TenantRepos,
    c: &CampaignRow,
    cap: &Capability,
    policy: &jt_outreach::OutreachPolicy,
    now: OffsetDateTime,
) -> Result<u32, AppError> {
    let window = &c.definition.schedule.window;
    let open = hours::within(window, now)?
        && cap
            .policy
            .active_hours
            .as_ref()
            .map_or(Ok(true), |h| hours::within(h, now))?;
    if !open {
        return Ok(0);
    }
    let (day_start, _) = hours::local_day(&window.tz, now)?;
    let warmup = if policy.warmup.enabled {
        let days = r
            .outreach_sends()
            .mailbox_send_days(c.mailbox_id, &window.tz, now - WARMUP_LOOKBACK)
            .await?;
        let today = hours::local_date(&window.tz, now)?;
        warmup_cap(&policy.warmup, warmup_day_index(&days, today))
    } else {
        u32::MAX
    };
    let sends = r.outreach_sends();
    let input = BudgetInput {
        mailbox_daily_ops_cap: cap.policy.daily_ops_cap,
        warmup_cap: warmup,
        mailbox_sent_today: sends.count_mailbox_since(c.mailbox_id, day_start).await?,
        per_day: c.definition.throttle.per_day,
        campaign_sent_today: sends.count_campaign_since(c.id, day_start).await?,
        per_hour: c.definition.throttle.per_hour,
        campaign_sent_last_hour: sends
            .count_campaign_since(c.id, now - Duration::hours(1))
            .await?,
    };
    Ok(budget(&input))
}

/// One running campaign's run.
async fn campaign(
    deps: &Deps,
    ctx: &Ctx,
    c: &CampaignRow,
    iys_budget: &mut u32,
    out: &mut Dispatched,
) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = outreach_policy(r.as_mut()).await?;
    let cap = r.capabilities().find(c.mailbox_id).await?;
    if !policy.sender_identity_complete() {
        return Ok(());
    }
    let Some(cap) = cap.filter(|cap| live(cap, ctx.now)) else {
        drop(r);
        if pause(deps, ctx, c.id, PauseReason::MailboxDown).await? {
            out.paused += 1;
        }
        return Ok(());
    };
    let n = allowance(r.as_mut(), c, &cap, &policy, ctx.now).await?;
    if n == 0 {
        return Ok(());
    }
    let due = r.outreach_enrollments().due(c.id, ctx.now, n).await?;
    r.commit().await?;
    for e in due {
        match one(deps, ctx, c, &policy, &e, iys_budget, out).await? {
            Next::Go => {}
            Next::EndCampaign => break,
        }
    }
    Ok(())
}

/// Whether the campaign's run goes on after one enrollment.
enum Next {
    Go,
    /// A refusal about the campaign or the workspace: the rest would meet it too.
    EndCampaign,
}

/// Stops enrollment `id` for `reason` in its own transaction.
async fn stop(
    deps: &Deps,
    ctx: &Ctx,
    e: &EnrollmentRow,
    reason: &StopReason,
    out: &mut Dispatched,
) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    stop_in(r.as_mut(), ctx, e, reason).await?;
    r.commit().await?;
    out.stopped += 1;
    Ok(())
}

async fn stop_in(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    e: &EnrollmentRow,
    reason: &StopReason,
) -> Result<(), AppError> {
    if r.outreach_enrollments().stop(e.id, reason, ctx.now).await? {
        record(
            r,
            ctx,
            "outreach.enrollment_stopped",
            "outreach_enrollment",
            e.id,
            json!({ "enrollment_id": e.id, "campaign_id": e.campaign_id, "reason": reason.key() }),
        )
        .await?;
    }
    Ok(())
}

/// Puts enrollment `id` off until `until`.
async fn postpone(
    deps: &Deps,
    ctx: &Ctx,
    e: &EnrollmentRow,
    until: OffsetDateTime,
    out: &mut Dispatched,
) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.outreach_enrollments().postpone(e.id, until).await?;
    r.commit().await?;
    out.postponed += 1;
    Ok(())
}

/// The stop reason a person-level refusal of the inbox fence gives; `None` for one about the
/// campaign, the mailbox or the workspace.
fn person_refusal(reason: &str) -> Option<StopReason> {
    Some(match reason {
        "person_erased" => StopReason::PersonErased,
        "person_merged" => StopReason::PersonMerged,
        "journey_lost" => StopReason::JourneyLost,
        "journey_won" => StopReason::JourneyWon,
        "human_holds_conversation" => StopReason::HumanHoldsConversation,
        "IZIN_YOK"
        | "executor_changed"
        | "reply_recipient_unavailable"
        | "ambiguous_reply_recipient"
        | "do_not_contact"
        | "unsupported_reply_channel" => StopReason::Refused(reason.to_owned()),
        _ => return None,
    })
}

/// The stop reason of an outreach fence refusal about the person; `None` for one about the
/// campaign or the platform.
fn fence_stop(refusal: OutreachRefusal) -> Option<StopReason> {
    match refusal {
        OutreachRefusal::Replied => Some(StopReason::Replied),
        OutreachRefusal::MeetingBooked => Some(StopReason::MeetingBooked),
        OutreachRefusal::DoNotContact => Some(StopReason::DoNotContact),
        _ => None,
    }
}

/// The values a step renders with: the person's (and their prospect's) facts, the sender's, and
/// the enrollment's `custom.*` personalization.
async fn vars(
    r: &mut dyn TenantRepos,
    c: &CampaignRow,
    policy: &jt_outreach::OutreachPolicy,
    e: &EnrollmentRow,
) -> Result<RenderVars, AppError> {
    let mut v = RenderVars::default();
    let mut put = |k: &str, value: Option<String>| {
        if let Some(value) = value.filter(|s| !s.trim().is_empty()) {
            v.values.insert(k.to_owned(), value);
        }
    };
    let person = r.people().get(e.person_id).await?;
    let prospect = r.prospects().by_person(e.person_id).await?;
    let contact = prospect
        .as_ref()
        .and_then(|p| p.contact.contact_person.as_ref())
        .map(|f| f.value.name.clone())
        .or_else(|| person.as_ref().map(|p| p.display_name.clone()));
    put(
        "first_name",
        contact
            .as_deref()
            .and_then(|n| n.split_whitespace().next())
            .map(str::to_owned),
    );
    put("contact_name", contact);
    put(
        "company",
        prospect
            .as_ref()
            .map(|p| p.business_name.clone())
            .filter(|n| n != "—")
            .or_else(|| person.as_ref().map(|p| p.company.clone())),
    );
    put("city", prospect.as_ref().and_then(|p| p.city.clone()));
    put(
        "district",
        prospect.as_ref().and_then(|p| p.district.clone()),
    );
    put("sector", prospect.as_ref().and_then(|p| p.sector.clone()));
    put("sender_name", Some(c.definition.sender_name.clone()));
    put("sender_company", Some(policy.sender_company.clone()));
    for (k, value) in &e.personalization {
        put(&format!("custom.{k}"), Some(value.clone()));
    }
    Ok(v)
}

/// When the enrollment's next step first became due.
fn step_due(c: &CampaignRow, e: &EnrollmentRow) -> OffsetDateTime {
    let step = usize::from(e.next_step.saturating_sub(1));
    match (e.last_sent_at, c.definition.steps.get(step)) {
        (Some(at), Some(s)) => at + Duration::days(i64::from(s.delay_days)),
        _ => c
            .definition
            .schedule
            .start_at
            .map_or(e.enrolled_at, |at| at.max(e.enrolled_at)),
    }
}

/// The person's one active email address, if exactly one.
async fn email_of(r: &mut dyn TenantRepos, person: PersonId) -> Result<Option<String>, AppError> {
    let emails: Vec<String> = r
        .identities()
        .list(person)
        .await?
        .into_iter()
        .filter(|i| i.active && i.channel == IdentityChannel::Email)
        .map(|i| i.value_normalized)
        .collect();
    Ok((emails.len() == 1).then(|| emails[0].clone()))
}

/// What became of an İYS check before a business-basis send.
enum Iys {
    /// Nothing to look up, or the answer is recorded: go on.
    Go,
    Wait(OffsetDateTime),
    Stop(StopReason),
}

/// Before a business-basis send (spec §3.12): when the policy asks for it, the address is looked
/// up in İYS unless an İYS answer of the last 30 days is recorded or an outreach email reached
/// the person in that time (a lookup preceded it). The lookup runs outside any transaction; `RET`
/// is recorded as a withdrawal (the fence then refuses), `ONAY` as an explicit consent, `YOK`
/// leaves nothing. No İYS capability: `iys_lookup_unavailable`.
async fn iys(
    deps: &Deps,
    ctx: &Ctx,
    policy: &jt_outreach::OutreachPolicy,
    e: &EnrollmentRow,
    email: &str,
    budget_left: &mut u32,
    out: &mut Dispatched,
) -> Result<Iys, AppError> {
    if !policy.require_iys_lookup {
        return Ok(Iys::Go);
    }
    let since = ctx.now - IYS_CACHE;
    let credential = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let cached = crate::usecases::inbox::consent::history(r.as_mut(), e.person_id)
            .await?
            .consents
            .iter()
            .any(|c| {
                c.channel == Channel::Email && c.source == ConsentSource::IysSync && c.at >= since
            });
        let reached = !r
            .outreach_sends()
            .person_send_times(e.person_id, since)
            .await?
            .is_empty();
        if cached || reached {
            return Ok(Iys::Go);
        }
        if *budget_left == 0 {
            return Ok(Iys::Wait(ctx.now + Duration::minutes(1)));
        }
        match crate::usecases::jobs::iys_credential(deps, r.as_mut(), ctx.workspace_id).await? {
            Some(cred) => cred,
            None => {
                return Ok(Iys::Stop(StopReason::Refused(
                    "iys_lookup_unavailable".into(),
                )));
            }
        }
    };
    let Some(sync) = deps.connectors.consent(jt_connector::Provider::Netgsm) else {
        return Ok(Iys::Stop(StopReason::Refused(
            "iys_lookup_unavailable".into(),
        )));
    };
    *budget_left -= 1;
    out.iys_lookups += 1;
    let answer = sync.search(&credential, email, "EPOSTA").await;
    let kind = match answer {
        Ok(IysAnswer::Granted) => ConsentKind::Explicit,
        Ok(IysAnswer::Refused) => ConsentKind::Withdrawn,
        Ok(IysAnswer::Absent) => return Ok(Iys::Go),
        Err(_) => return Ok(Iys::Wait(ctx.now + IYS_RETRY)),
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.consents()
        .insert(jt_inbox::Consent {
            id: jt_inbox::ConsentId::from(deps.ids.uuid()),
            person_id: e.person_id,
            channel: Channel::Email,
            kind,
            source: ConsentSource::IysSync,
            at: ctx.now,
            // Read from İYS: nothing to push back to it.
            sync_state: jt_inbox::SyncState::Sent,
            attempts: 0,
        })
        .await?;
    record(
        r.as_mut(),
        ctx,
        "outreach.iys_looked_up",
        "person",
        e.person_id,
        json!({ "person_id": e.person_id, "answer": if kind == ConsentKind::Withdrawn { "refused" } else { "granted" } }),
    )
    .await?;
    r.commit().await?;
    Ok(if kind == ConsentKind::Withdrawn {
        Iys::Stop(StopReason::ConsentWithdrawn)
    } else {
        Iys::Go
    })
}

/// One due enrollment (see the module docs).
async fn one(
    deps: &Deps,
    ctx: &Ctx,
    c: &CampaignRow,
    policy: &jt_outreach::OutreachPolicy,
    e: &EnrollmentRow,
    iys_budget: &mut u32,
    out: &mut Dispatched,
) -> Result<Next, AppError> {
    // Pre-checks, reads only.
    let (verdict, email, times, domain_sent, previous, render_vars, host) = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let person = r.people().get(e.person_id).await?;
        match person {
            None => {
                drop(r);
                stop(deps, ctx, e, &StopReason::PersonErased, out).await?;
                return Ok(Next::Go);
            }
            Some(p) if p.erased_at.is_some() => {
                drop(r);
                stop(deps, ctx, e, &StopReason::PersonErased, out).await?;
                return Ok(Next::Go);
            }
            Some(p) if p.merged_into.is_some() => {
                drop(r);
                stop(deps, ctx, e, &StopReason::PersonMerged, out).await?;
                return Ok(Next::Go);
            }
            Some(_) => {}
        }
        let journey =
            crate::usecases::inbox::active_or_latest_journey(r.as_mut(), e.person_id).await?;
        let closed = match journey.as_ref().map(|j| j.status) {
            Some(JourneyStatus::Won) => Some(StopReason::JourneyWon),
            Some(JourneyStatus::Lost) => Some(StopReason::JourneyLost),
            _ => None,
        };
        if let Some(reason) = closed {
            drop(r);
            stop(deps, ctx, e, &reason, out).await?;
            return Ok(Next::Go);
        }
        let basis = Basis::read(deps, r.as_mut(), ctx.now).await?;
        let verdict = person_verdict(deps, ctx, r.as_mut(), e.person_id, &basis, Some(c.id))
            .await?
            .verdict;
        let email = email_of(r.as_mut(), e.person_id).await?;
        let times = r
            .outreach_sends()
            .person_send_times(e.person_id, ctx.now - Duration::days(30))
            .await?;
        let domain = email
            .as_deref()
            .and_then(|m| m.rsplit_once('@'))
            .map(|(_, d)| d.to_lowercase());
        let domain_sent = match &domain {
            Some(d) => {
                r.outreach_sends()
                    .count_domain_since(c.mailbox_id, d, ctx.now - Duration::hours(1))
                    .await?
            }
            None => 0,
        };
        let previous = r
            .outreach_sends()
            .latest_for_person(e.person_id, e.enrolled_at)
            .await?
            .filter(|s| s.enrollment_id == e.id && s.step + 1 == e.next_step);
        let render_vars = vars(r.as_mut(), c, policy, e).await?;
        let host = crate::usecases::outreach::links::https_base(deps)
            .and_then(|u| u.host_str().map(str::to_owned));
        (
            verdict,
            email,
            times,
            domain_sent,
            previous,
            render_vars,
            host,
        )
    };
    let basis = match verdict {
        Verdict::Eligible(b) => b,
        Verdict::Skip(reason) => {
            let stop_reason = match reason {
                jt_outreach::SkipReason::DoNotContact => StopReason::DoNotContact,
                jt_outreach::SkipReason::Suppressed => {
                    suppression_stop(deps, ctx, e.person_id).await?
                }
                jt_outreach::SkipReason::NoBasis => StopReason::Refused("IZIN_YOK".into()),
                other => StopReason::Refused(other.key().to_owned()),
            };
            stop(deps, ctx, e, &stop_reason, out).await?;
            return Ok(Next::Go);
        }
    };
    let Some(email) = email else {
        stop(
            deps,
            ctx,
            e,
            &StopReason::Refused("no_deliverable_email".into()),
            out,
        )
        .await?;
        return Ok(Next::Go);
    };
    if let Some(at) = frequency_next_allowed(&policy.frequency, &times, ctx.now) {
        postpone(deps, ctx, e, at, out).await?;
        return Ok(Next::Go);
    }
    if !domain_ok(domain_sent) {
        postpone(deps, ctx, e, ctx.now + DOMAIN_POSTPONE, out).await?;
        return Ok(Next::Go);
    }
    if basis == CommercialBasis::BusinessRecipient {
        match iys(deps, ctx, policy, e, &email, iys_budget, out).await? {
            Iys::Go => {}
            Iys::Wait(until) => {
                postpone(deps, ctx, e, until, out).await?;
                return Ok(Next::Go);
            }
            Iys::Stop(reason) => {
                stop(deps, ctx, e, &reason, out).await?;
                return Ok(Next::Go);
            }
        }
    }
    let step = e.next_step;
    let Some(snapshot) = c
        .definition
        .steps
        .get(usize::from(step.saturating_sub(1)))
        .and_then(|s| s.snapshot.clone())
    else {
        stop(
            deps,
            ctx,
            e,
            &StopReason::Refused("no_snapshot".into()),
            out,
        )
        .await?;
        return Ok(Next::Go);
    };
    let outbox_id = deps.ids.uuid();
    let base = crate::usecases::outreach::links::https_base(deps);
    let click = |i: usize| -> String {
        let index = u16::try_from(i).unwrap_or(u16::MAX);
        base.as_ref()
            .and_then(|b| {
                crate::usecases::outreach::links::click_url(
                    deps,
                    b,
                    ctx.workspace_id,
                    outbox_id,
                    index,
                )
                .ok()
            })
            .unwrap_or_default()
    };
    // A plain flag for what follows: the `&dyn Fn` is not `Send`, so it must not live across
    // the awaits below (the dispatcher's future runs on the scheduler's threads).
    let tracked = c.definition.click_tracking && base.is_some();
    let link_url: Option<&dyn Fn(usize) -> String> = tracked.then_some(&click);
    let rendered = match render_body(&snapshot, &render_vars, link_url) {
        Ok(r) => r,
        Err(RenderError::MissingVariable(key)) => {
            if key.starts_with("custom.") && ctx.now - step_due(c, e) < PERSONALIZATION_WAIT {
                postpone(deps, ctx, e, ctx.now + RETRY_LATER, out).await?;
            } else {
                stop(deps, ctx, e, &StopReason::MissingVariable(key), out).await?;
            }
            return Ok(Next::Go);
        }
        Err(other) => {
            stop(deps, ctx, e, &StopReason::Refused(other.to_string()), out).await?;
            return Ok(Next::Go);
        }
    };
    let same_thread = c
        .definition
        .steps
        .get(usize::from(step.saturating_sub(1)))
        .is_some_and(|s| s.same_thread);
    let (in_reply_to, references) = match (&previous, &host) {
        (Some(p), Some(host)) if same_thread => {
            let id = format!("<{}@{host}>", p.outbox_id);
            (Some(id.clone()), vec![id])
        }
        _ => (None, Vec::new()),
    };
    let send = OutreachSend {
        outbox_id,
        send_id: SendId::from(deps.ids.uuid()),
        enrollment_id: e.id,
        campaign_id: c.id,
        step,
        from_name: c.definition.sender_name.clone(),
        language: snapshot.language,
        // What a click redirect of this email leads to: the snapshot it was rendered from (a
        // later edit of the campaign re-snapshots its steps, spec D65).
        links: if tracked {
            snapshot.links.clone()
        } else {
            Vec::new()
        },
    };
    let sender = sender(ctx);
    // One transaction under the inbox lock: the fences, the outbox entry, the send row and the
    // enrollment's next step.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let Some(fresh) = r.outreach_campaigns().get(c.id).await? else {
        return Ok(Next::EndCampaign);
    };
    let Some(enrollment) = r
        .outreach_enrollments()
        .get(e.id)
        .await?
        .filter(|x| x.status == jt_outreach::EnrollmentStatus::Active && x.next_step == step)
    else {
        return Ok(Next::Go);
    };
    let facts = facts(deps, ctx, r.as_mut(), &fresh, &enrollment).await?;
    if let Err(refusal) = outreach_fence(&facts) {
        return Ok(match fence_stop(refusal) {
            Some(reason) => {
                stop_in(r.as_mut(), ctx, &enrollment, &reason).await?;
                r.commit().await?;
                out.stopped += 1;
                Next::Go
            }
            None => Next::EndCampaign,
        });
    }
    let queued = replies::enqueue_in(
        deps,
        &sender,
        r.as_mut(),
        Target::PersonVia(e.person_id, c.mailbox_id),
        ReplyInput {
            text: rendered.text,
            intent: SendIntent::Commercial,
            request_key: Some(format!("outreach:{}:{step}", e.id)),
            subject: Some(rendered.subject),
            in_reply_to,
            references,
            item_id: None,
            visibility: None,
        },
        Purpose::Outreach(&send),
    )
    .await;
    let id = match queued {
        Ok(Enqueued::New(id)) => id,
        Ok(Enqueued::Existing(_)) => return Ok(Next::Go),
        Err(err) if matches!(err.code, ErrorCode::Forbidden | ErrorCode::Validation) => {
            let reason = err
                .details
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or(&err.message)
                .to_owned();
            return Ok(match person_refusal(&reason) {
                Some(stop_reason) => {
                    stop_in(r.as_mut(), ctx, &enrollment, &stop_reason).await?;
                    r.commit().await?;
                    out.stopped += 1;
                    Next::Go
                }
                None => Next::EndCampaign,
            });
        }
        Err(err) => return Err(err),
    };
    let message_id = r
        .outbox()
        .get(id)
        .await?
        .ok_or_else(|| AppError::internal("a queued outbox entry is gone"))?
        .message_id;
    let domain = email
        .rsplit_once('@')
        .map(|(_, d)| d.to_lowercase())
        .unwrap_or_default();
    r.outreach_sends()
        .insert(&SendRow {
            id: send.send_id,
            enrollment_id: e.id,
            campaign_id: c.id,
            mailbox_id: c.mailbox_id,
            step,
            outbox_id: id,
            message_id,
            recipient_domain: domain,
            outcome: SendOutcome::Queued,
            created_at: ctx.now,
            sent_at: None,
            replied_at: None,
            replied_threaded: None,
            first_clicked_at: None,
            clicks: 0,
            automated_clicks: 0,
            unsubscribed_at: None,
        })
        .await?;
    let (next_step, next_send_at) = match next_step_after(&c.definition.steps, step, ctx.now) {
        Some((n, at)) => (n, Some(at)),
        None => (step + 1, None),
    };
    r.outreach_enrollments()
        .advance(e.id, next_step, next_send_at, ctx.now)
        .await?;
    r.commit().await?;
    out.queued += 1;
    // The provider is called with no transaction open.
    if let Err(err) = replies::send_step(deps, &sender, id).await {
        tracing::warn!(
            workspace_id = %ctx.workspace_id,
            outbox_id = %id,
            code = ?err.code,
            "an outreach email was queued but its send step failed"
        );
    }
    Ok(Next::Go)
}

/// The stop reason of a person whose email is suppressed: what suppressed it.
async fn suppression_stop(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
) -> Result<StopReason, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let reasons: Vec<SuppressionReason> =
        crate::usecases::inbox::consent::history(r.as_mut(), person)
            .await?
            .suppressions
            .into_iter()
            .filter(|s| s.channel == Channel::Email)
            .map(|s| s.reason)
            .collect();
    Ok(if reasons.contains(&SuppressionReason::Unsubscribe) {
        StopReason::Unsubscribed
    } else if reasons.contains(&SuppressionReason::Complaint) {
        StopReason::Complained
    } else if reasons.contains(&SuppressionReason::Bounce) {
        StopReason::Bounced
    } else {
        StopReason::Refused("suppressed".into())
    })
}

/// The outreach fence's facts for enrollment `e` of campaign `c` now, read in `r` (which holds
/// the inbox lock): the platform switch, the campaign and its approval, the do-not-contact list,
/// an inbound from the person or a meeting booked since the enrollment, the sender identity.
pub(crate) async fn facts(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    c: &CampaignRow,
    e: &EnrollmentRow,
) -> Result<OutreachFacts, AppError> {
    let policy = outreach_policy(r).await?;
    let mailbox_human = r
        .capabilities()
        .find(c.mailbox_id)
        .await?
        .is_some_and(|cap| cap.policy.requires_human_approval);
    let emails: Vec<String> = email_of(r, e.person_id).await?.into_iter().collect();
    let keys = person_keys(r, e.person_id, &emails).await?;
    let blocklisted = crate::usecases::prospects::dedupe::blocked(deps, ctx, r, &keys, ctx.now)
        .await?
        .is_some();
    let inbound = r
        .conversations()
        .lock_for_person(e.person_id)
        .await?
        .iter()
        .any(|conv| conv.last_inbound_at.is_some_and(|at| at > e.enrolled_at));
    let journey = match e.journey_id {
        Some(id) => r.journeys().get(id).await?,
        None => crate::usecases::inbox::active_or_latest_journey(r, e.person_id).await?,
    };
    let meeting = match journey {
        Some(j) => r
            .journeys()
            .events(j.id, 500)
            .await?
            .iter()
            .any(|ev| ev.kind == JourneyEventKind::AppointmentBooked && ev.at > e.enrolled_at),
        None => false,
    };
    Ok(OutreachFacts {
        platform_enabled: deps.apps.outreach_enabled(),
        status: c.status,
        approval_required: requires_approval(policy.requires_approval, mailbox_human),
        approved_revision: c.approval.as_ref().map(|a| a.revision),
        revision: c.revision,
        blocklisted,
        inbound_since_enrollment: inbound,
        meeting_since_enrollment: meeting,
        sender_identity_complete: policy.sender_identity_complete(),
    })
}

/// The outreach fence again at claim, from the ids an outreach intent records (`outreach:
/// {campaign_id, enrollment_id, ...}`): `Err` with the refusal's key when it refuses (a campaign
/// or enrollment that is gone is `campaign_not_running`).
pub(crate) async fn claim_fence(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    outreach: &Value,
) -> Result<Result<(), String>, AppError> {
    let not_running = || Err(OutreachRefusal::CampaignNotRunning.key().to_owned());
    let (Some(campaign), Some(enrollment)) = (
        outreach
            .get("campaign_id")
            .and_then(|v| serde_json::from_value::<jt_outreach::CampaignId>(v.clone()).ok()),
        outreach
            .get("enrollment_id")
            .and_then(|v| serde_json::from_value::<jt_outreach::EnrollmentId>(v.clone()).ok()),
    ) else {
        return Ok(not_running());
    };
    let Some(c) = r.outreach_campaigns().get(campaign).await? else {
        return Ok(not_running());
    };
    let Some(e) = r.outreach_enrollments().get(enrollment).await? else {
        return Ok(not_running());
    };
    let facts = facts(deps, ctx, r, &c, &e).await?;
    Ok(outreach_fence(&facts).map_err(|refusal| refusal.key().to_owned()))
}
