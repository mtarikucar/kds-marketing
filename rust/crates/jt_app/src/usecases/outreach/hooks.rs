//! Outreach's stop hooks (spec 2026-10-30-leads-pool-outreach-design.md §3.14, D16): what
//! happens elsewhere in the inbox stops a person's enrollment at once and keeps the send rows
//! current, so the reports are timely.
//!
//! **The hooks are not the rule.** The dispatcher and the claim check every stop condition again
//! (`dispatch::facts`, the inbox fence), so a hook that did not run never lets an email out
//! (`stop_rules_hold_without_hooks`). Each hook runs inside its caller's transaction, after the
//! caller's own writes, and writes only outreach rows and their ledger entries (a bounce also
//! flags the prospect's email as undeliverable). Ledger payloads name ids and reasons only.
//!
//! - [`on_receipt`]: the outbox recorded a result (sent, failed, unknown, refused): the send row's
//!   outcome follows it (`outreach_sends.outcome` is written only here and by [`on_bounce`]).
//! - [`on_inbound`]: a message from the person: the send it answers (threaded by our Message-ID,
//!   else the person's latest within 30 days) is marked replied, and the enrollment stops
//!   (`replied`).
//! - [`on_bounce`]: a bounce or a complaint of an outreach email: the send is `bounced` or
//!   `complained`, the enrollment stops, and a bounce marks the prospect's email undeliverable.
//! - [`on_withdrawn`], [`on_suppressed`]: email consent withdrawn (`consent_withdrawn`), a manual
//!   suppression of email (`refused:suppressed`).
//! - [`on_journey_event`]: a booked meeting (`meeting_booked`), a won or a lost journey.
//! - [`on_erased`], [`on_merged`]: the person erased (their personalization cleared, the rows and
//!   their ids kept) or merged into another.

use std::collections::BTreeMap;

use jt_inbox::{Channel, JourneyEventKind, JourneyId, PersonId};
use jt_outreach::{SendId, SendOutcome, StopReason};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::record;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::inbox::OutboxRow;

/// How far back an unthreaded reply looks for the person's outreach email (spec §3.14).
pub const UNTHREADED_REPLY_WINDOW: Duration = Duration::days(30);

/// Stops the person's active enrollment (a person has at most one) for `reason`, when it was
/// enrolled before `before` (any, without it); whether one stopped.
async fn stop_active(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    reason: &StopReason,
    before: Option<OffsetDateTime>,
) -> Result<bool, AppError> {
    let Some(e) = r.outreach_enrollments().active_for(person).await? else {
        return Ok(false);
    };
    if before.is_some_and(|at| e.enrolled_at >= at) {
        return Ok(false);
    }
    if !r.outreach_enrollments().stop(e.id, reason, ctx.now).await? {
        return Ok(false);
    }
    record(
        r,
        ctx,
        "outreach.enrollment_stopped",
        "outreach_enrollment",
        e.id,
        json!({ "enrollment_id": e.id, "campaign_id": e.campaign_id, "reason": reason.key() }),
    )
    .await?;
    Ok(true)
}

/// The send id an outreach intent records (`outreach.send_id`), if it is one.
fn send_of(intent: &Value) -> Option<SendId> {
    intent
        .get("outreach")?
        .get("send_id")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// After the outbox recorded a result for entry `row`: an outreach email's send row takes the
/// outcome its state says (`sent` at the time it was handed to the provider, `failed`,
/// `unknown`, `refused`); any other entry or state changes nothing. A move the send's outcome
/// does not allow (a bounce already recorded) is left out.
pub(crate) async fn on_receipt(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    row: &OutboxRow,
) -> Result<(), AppError> {
    let Some(send) = send_of(&row.intent) else {
        return Ok(());
    };
    let (outcome, at) = match row.state.as_str() {
        "sent" => {
            let sent_at = row
                .fence_snapshot
                .as_ref()
                .and_then(|s| s.get("send_at"))
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i128>().ok())
                .and_then(|n| OffsetDateTime::from_unix_timestamp_nanos(n).ok())
                .unwrap_or(row.updated_at);
            (SendOutcome::Sent, sent_at)
        }
        "failed" => (SendOutcome::Failed, ctx.now),
        "unknown" => (SendOutcome::Unknown, ctx.now),
        "refused" => (SendOutcome::Refused, ctx.now),
        _ => return Ok(()),
    };
    r.outreach_sends().set_outcome(send, outcome, at).await?;
    Ok(())
}

/// The outbox entry a Message-ID of ours names (`<outbox_id@host>`).
fn outbox_of(message_id: &str) -> Option<Uuid> {
    let inner = message_id.trim().strip_prefix('<')?.strip_suffix('>')?;
    let (id, _) = inner.split_once('@')?;
    Uuid::parse_str(id).ok()
}

/// A message from `person` arrived at `at` (spec §3.14): the outreach email it answers is marked
/// replied (threaded when its `In-Reply-To` names that email's Message-ID and the email went to
/// this person; else, unthreaded, the person's latest outreach email of the last 30 days), and
/// the person's active enrollment, if enrolled before `at`, stops (`replied`).
pub(crate) async fn on_inbound(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    in_reply_to: Option<&str>,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    let mut threaded = None;
    if let Some(outbox) = in_reply_to.and_then(outbox_of)
        && let Some(send) = r.outreach_sends().by_outbox(outbox).await?
        && r.outreach_enrollments()
            .get(send.enrollment_id)
            .await?
            .is_some_and(|e| e.person_id == person)
    {
        threaded = Some(send.id);
    }
    match threaded {
        Some(id) => {
            r.outreach_sends().mark_replied(id, true, ctx.now).await?;
        }
        None => {
            if let Some(send) = r
                .outreach_sends()
                .latest_for_person(person, at - UNTHREADED_REPLY_WINDOW)
                .await?
            {
                r.outreach_sends()
                    .mark_replied(send.id, false, ctx.now)
                    .await?;
            }
        }
    }
    stop_active(r, ctx, person, &StopReason::Replied, Some(at)).await?;
    Ok(())
}

/// The mail evidence says outbox entry `row` bounced (or drew a complaint): an outreach email's
/// send is `bounced` (`complained`), the person's active enrollment stops for the same reason,
/// and a bounce marks the email of the prospect the person was promoted from undeliverable when
/// it is the address the email went to. Runs before the evidence settles the entry, so a send
/// whose outcome was unknown becomes `bounced` (not `failed`).
pub(crate) async fn on_bounce(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    row: &OutboxRow,
    complaint: bool,
) -> Result<(), AppError> {
    let Some(send) = r.outreach_sends().by_outbox(row.id).await? else {
        return Ok(());
    };
    let (outcome, reason) = if complaint {
        (SendOutcome::Complained, StopReason::Complained)
    } else {
        (SendOutcome::Bounced, StopReason::Bounced)
    };
    r.outreach_sends()
        .set_outcome(send.id, outcome, ctx.now)
        .await?;
    let Some(enrollment) = r.outreach_enrollments().get(send.enrollment_id).await? else {
        return Ok(());
    };
    let person = enrollment.person_id;
    stop_active(r, ctx, person, &reason, None).await?;
    if complaint {
        return Ok(());
    }
    let to = row.intent["mail"]["to"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    if to.is_empty() {
        return Ok(());
    }
    r.prospects().lock_pool().await?;
    let Some(mut p) = r.prospects().by_person(person).await? else {
        return Ok(());
    };
    let Some(email) = p.contact.email.as_mut() else {
        return Ok(());
    };
    if !email.deliverable || email.value.trim().to_lowercase() != to {
        return Ok(());
    }
    email.deliverable = false;
    let keys = r.prospects().keys_of(p.id).await?;
    let expected = p.revision;
    p.revision = expected + 1;
    p.updated_at = ctx.now;
    if r.prospects().update(&p, &keys, expected).await? != crate::ports::prospects::Updated::Ok {
        return Ok(());
    }
    crate::usecases::prospects::record(
        r,
        ctx,
        "prospects.updated",
        p.id,
        json!({ "fields": ["email"], "reason": "bounced" }),
    )
    .await
}

/// The person withdrew consent on `channel`: on email, their active enrollment stops
/// (`consent_withdrawn`).
pub(crate) async fn on_withdrawn(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    channel: Channel,
) -> Result<(), AppError> {
    if channel == Channel::Email {
        stop_active(r, ctx, person, &StopReason::ConsentWithdrawn, None).await?;
    }
    Ok(())
}

/// A person suppressed the person's `channel` by hand: on email, their active enrollment stops
/// (`refused:suppressed`, the dispatcher's reason for a manual suppression).
pub(crate) async fn on_suppressed(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    channel: Channel,
) -> Result<(), AppError> {
    if channel == Channel::Email {
        let reason = StopReason::Refused("suppressed".into());
        stop_active(r, ctx, person, &reason, None).await?;
    }
    Ok(())
}

/// Journey `journey` took event `kind`: a booked meeting stops its person's active enrollment
/// (`meeting_booked`), a win or a loss too (`journey_won`, `journey_lost`); any other event
/// changes nothing.
pub(crate) async fn on_journey_event(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    journey: JourneyId,
    kind: &JourneyEventKind,
) -> Result<(), AppError> {
    let reason = match kind {
        JourneyEventKind::AppointmentBooked => StopReason::MeetingBooked,
        JourneyEventKind::Won { .. } => StopReason::JourneyWon,
        JourneyEventKind::Lost { .. } => StopReason::JourneyLost,
        _ => return Ok(()),
    };
    let Some(j) = r.journeys().get(journey).await? else {
        return Ok(());
    };
    stop_active(r, ctx, j.person_id, &reason, None).await?;
    Ok(())
}

/// The person is erased: their active enrollment stops (`person_erased`) and every enrollment of
/// theirs loses its personalization (an agent's per-recipient text); the rows, their ids and
/// their reasons stay for the reports.
pub(crate) async fn on_erased(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
) -> Result<(), AppError> {
    stop_active(r, ctx, person, &StopReason::PersonErased, None).await?;
    let empty = BTreeMap::new();
    for e in r.outreach_enrollments().for_person(person).await? {
        if !e.personalization.is_empty() {
            r.outreach_enrollments().personalize(e.id, &empty).await?;
        }
    }
    Ok(())
}

/// Person `source` is merged into another: their active enrollment stops (`person_merged`); an
/// undo does not restart it.
pub(crate) async fn on_merged(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    source: PersonId,
) -> Result<(), AppError> {
    stop_active(r, ctx, source, &StopReason::PersonMerged, None).await?;
    Ok(())
}
