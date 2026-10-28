//! The workspace's phone calls (spec `2026-10-27-agent-voice-calls-design.md`): a rep's
//! click-to-call through the NetGSM PBX (phase V0), an agent-driven call through the workspace's
//! voice bridge (phase V1: [`bridge`] is the bridge's own surface, [`listen`] and [`say`] the
//! agent's turns, [`session`] the timers and the scripted ending), the call log, and the call
//! policy. Every placed call passes the fence of `jt_calls::fence_call` twice: once when the
//! session is created and again, re-reading every fact, in the transaction that dials (review
//! focus 1): for a rep's call the transaction right before the PBX is asked (the provider call
//! itself runs outside any transaction), for an agent's call the one that queues the bridge's
//! `dial`.
//!
//! **The agent's loop.** `calls.place{mode: "agent", plan}` → `calls.listen` → think →
//! `calls.say` → `calls.listen` … → `calls.end` (or `calls.transfer`). The server never composes
//! a sentence: every text the bridge plays is the plan's (opening, holding phrases, fallback
//! lines, closing), the policy's (the recording announcement) or one the agent passed to
//! `calls.say`. A slow agent hears holding phrases covering for it, a silent or disconnected one
//! its fallback lines and then the closing: the call always ends by script
//! (`jobs::run_call_timers`).
//!
//! Phone numbers never leave unmasked (`jt_calls::mask_e164`): not in outputs, not in ledger
//! payloads; only `calls.get` shows a human holding `calls.manage` the number itself, and the
//! voice bridge ([`bridge`]) is handed the number it dials.

pub mod bridge;
pub mod listen;
pub mod say;
pub mod session;

use jt_calls::{
    CallCommandId, CallDirection, CallId, CallMode, CallOutcome, CallPlan, CallPolicy, CallPurpose,
    CallSession, CallState, Command, EndCause, FenceInput, MAX_SUMMARY_CHARS, RecordingState,
    RefusalReason, RelationshipEvidence, Turn, TurnClock, fence_call, mask_e164,
};
use jt_capability::{
    Capability, CapabilityId, EffectiveStatus, StoredStatus, Unit, effective_status,
};
use jt_connector::Provider;
use jt_inbox::{
    AppointmentState, EventSource, IdentityChannel, Journey, JourneyEventKind, JourneyId,
    JourneyStatus, Note, NoteId, PersonId, Task, TaskId, TaskStatus,
};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, Permission, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use super::capabilities::{append, version_in_force};
use super::connector::{adapter_public, open_credential, pbx_policy_of};
use super::failure::failure_reason;
use super::{Deps, invalid};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::calls::{CallFilter, MAX_CALL_PAGE};
use crate::ports::{CapabilityFilter, TenantRepos};
use bridge::VOICE_BRIDGE_KIND;

/// The longest a long-poll (`calls.listen`, the voice bridge's commands) waits, in seconds.
pub const MAX_WAIT_S: u32 = 25;
/// How often a waiting long-poll reads again when no signal woke it: what another server
/// instance committed reaches it within this.
pub const FALLBACK_TICK: std::time::Duration = std::time::Duration::from_secs(1);

/// The kind of capability a rep's call goes through.
const PBX_KIND: &str = "netgsm_pbx";
/// The longest extension, in digits.
const MAX_EXTENSION_DIGITS: usize = 16;
/// How far back an appointment or a quote counts as an existing relationship (spec §8.4).
const RELATIONSHIP_DAYS: i64 = 180;
/// How far back an inbound call allows a callback (spec §8.4).
const CALLBACK_DAYS: i64 = 7;
/// The time zone a day's call count is taken in when the capability names none.
const DEFAULT_TZ: &str = "Europe/Istanbul";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// Who talks on a placed call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceMode {
    Human,
    Agent,
}

/// `calls.place`: whom to call (a person, or a phone number one of them holds), why, and who
/// talks. A rep's call names the rep's PBX extension; an agent's call brings its plan (and no
/// extension).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaceInput {
    #[serde(default)]
    pub person_id: Option<PersonId>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub journey_id: Option<JourneyId>,
    pub purpose: CallPurpose,
    pub mode: PlaceMode,
    #[serde(default)]
    pub rep_extension: Option<String>,
    #[serde(default)]
    pub plan: Option<CallPlan>,
    /// The capability the call goes through: a `netgsm_pbx` for a rep's call, a `voice_bridge`
    /// for an agent's; the workspace's only live one of the kind when left out.
    #[serde(default)]
    pub capability_id: Option<CapabilityId>,
}

/// A follow-up task `calls.end` opens on the journey.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowUp {
    pub title: String,
    #[serde(with = "time::serde::rfc3339")]
    pub due_at: OffsetDateTime,
}

/// `calls.end`: how the call went, what was said (at most 2000 characters), and a follow-up.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EndInput {
    pub outcome: CallOutcome,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub follow_up_task: Option<FollowUp>,
}

/// `calls.list`: newest first, filtered.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    #[serde(default)]
    pub person_id: Option<PersonId>,
    #[serde(default)]
    pub state: Option<CallState>,
    #[serde(default)]
    pub direction: Option<CallDirection>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub since: Option<OffsetDateTime>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A call as it is shown: the session with its number masked (`counterpart`), the number itself
/// (`counterpart_e164`) only for a human holding `calls.manage`, and its turns.
#[derive(Clone, Debug, Serialize)]
pub struct CallOut {
    pub call: Value,
    pub turns: Vec<Turn>,
}

/// `calls.policy_set`'s body: a whole policy, read strictly (an unknown field is refused).
#[derive(Clone, Debug)]
pub struct PolicyInput(pub CallPolicy);

impl<'de> Deserialize<'de> for PolicyInput {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(d)?;
        let known =
            serde_json::to_value(CallPolicy::default()).map_err(serde::de::Error::custom)?;
        if let (Some(given), Some(known)) = (raw.as_object(), known.as_object())
            && let Some(unknown) = given.keys().find(|k| !known.contains_key(*k))
        {
            return Err(serde::de::Error::custom(format!(
                "unknown field `{unknown}`"
            )));
        }
        serde_json::from_value(raw)
            .map(PolicyInput)
            .map_err(serde::de::Error::custom)
    }
}

/// The call as an output shows it (see [`CallOut`]).
fn view(session: &CallSession, reveal: bool) -> Value {
    let mut value = serde_json::to_value(session).unwrap_or_else(|_| json!({}));
    if let Some(fields) = value.as_object_mut() {
        fields.remove("clock");
        fields.remove("counterpart_e164");
        fields.insert(
            "counterpart".into(),
            json!(mask_e164(&session.counterpart_e164)),
        );
        if reveal {
            fields.insert("counterpart_e164".into(), json!(session.counterpart_e164));
        }
    }
    value
}

/// Whether `ctx` may see a call's number: a person (never an agent: MCP outputs stay masked)
/// holding `calls.manage`.
fn reveals(ctx: &Ctx) -> bool {
    matches!(ctx.actor, Actor::Human { .. }) && ctx.permissions.contains(&Permission::CallsManage)
}

/// `CONFLICT` for a refused call, its reason in `details.reason`.
fn refusal(reason: RefusalReason) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: format!("the call is refused: {}", reason.key()),
        details: json!({ "reason": reason.key() }),
    }
}

async fn ledger(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    id: impl std::fmt::Display,
    payload: Value,
) -> Result<(), AppError> {
    let in_force = version_in_force(r).await?;
    append(r, ctx, action, "call", id, in_force, payload).await
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

/// The workspace's call policy (the defaults while none is stored). Needs `calls.work`.
pub async fn policy_get(deps: &Deps, ctx: &Ctx) -> Result<CallPolicy, AppError> {
    ctx.require(Permission::CallsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.calls().policy().await
}

/// Replaces the call policy with `input` once it validates (`VALIDATION` naming the field).
/// Turning the assistant disclosure off is a person's decision: an agent asking for it is
/// `FORBIDDEN`. Writes `calls.policy_set` (payload: which fields changed). Needs `calls.manage`.
pub async fn policy_set(
    deps: &Deps,
    ctx: &Ctx,
    PolicyInput(policy): PolicyInput,
) -> Result<CallPolicy, AppError> {
    ctx.require(Permission::CallsManage)?;
    policy
        .validate()
        .map_err(|e| invalid(e.field, &format!("{} {}", e.field, e.message)))?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let before = r.calls().policy().await?;
    if !policy.disclose_assistant
        && before.disclose_assistant
        && !matches!(ctx.actor, Actor::Human { .. })
    {
        return Err(AppError {
            code: ErrorCode::Forbidden,
            message: "only a person turns the assistant disclosure off".into(),
            details: json!({ "reason": "disclosure_human_only" }),
        });
    }
    let (old, new) = (
        serde_json::to_value(&before).unwrap_or_default(),
        serde_json::to_value(&policy).unwrap_or_default(),
    );
    let changed: Vec<&String> = new
        .as_object()
        .map(|n| n.keys().filter(|k| old.get(*k) != n.get(*k)).collect())
        .unwrap_or_default();
    r.calls().set_policy(policy.clone(), ctx.now).await?;
    ledger(
        r.as_mut(),
        ctx,
        "calls.policy_set",
        ctx.workspace_id,
        json!({ "fields": changed }),
    )
    .await?;
    r.commit().await?;
    Ok(policy)
}

// ---------------------------------------------------------------------------------------------
// The fence's facts
// ---------------------------------------------------------------------------------------------

/// Whether `c`'s working hours allow an operation at `now` (no hours: always).
pub(crate) fn within_hours(c: &Capability, now: OffsetDateTime) -> Result<bool, AppError> {
    use chrono::{Datelike, Timelike};
    let Some(h) = &c.policy.active_hours else {
        return Ok(true);
    };
    let tz: chrono_tz::Tz =
        h.tz.parse()
            .map_err(|_| AppError::conflict("invalid work hours time zone"))?;
    let utc = chrono::DateTime::from_timestamp(now.unix_timestamp(), now.nanosecond())
        .ok_or_else(|| AppError::conflict("invalid work hours time"))?;
    let local = utc.with_timezone(&tz);
    Ok(h.days
        .contains(&(local.weekday().number_from_monday() as u8))
        && local.hour() >= u32::from(h.from)
        && local.hour() < u32::from(h.to))
}

/// The local day holding `now` in the capability's working-hours time zone (else Istanbul).
fn local_day(c: &Capability, now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    use chrono::TimeZone;
    let name = c
        .policy
        .active_hours
        .as_ref()
        .map_or(DEFAULT_TZ, |h| h.tz.as_str());
    let tz: chrono_tz::Tz = name.parse().unwrap_or(chrono_tz::Europe::Istanbul);
    let utc = chrono::DateTime::from_timestamp(now.unix_timestamp(), 0).unwrap_or_default();
    let date = utc.with_timezone(&tz).date_naive();
    let start = date
        .and_hms_opt(0, 0, 0)
        .and_then(|m| tz.from_local_datetime(&m).earliest())
        .map(|d| d.timestamp())
        .unwrap_or(now.unix_timestamp());
    let from = OffsetDateTime::from_unix_timestamp(start).unwrap_or(now);
    (from, from + Duration::days(1))
}

/// What the fence needs to know about one call, read in the caller's bundle.
struct Facts {
    capability: Capability,
    person_id: PersonId,
    journey_id: Option<JourneyId>,
    e164: String,
    verdict: Result<(), RefusalReason>,
}

/// Who talks on the call the fence decides on: a rep at a PBX extension, or the agent through a
/// voice bridge with its plan's opening (which must disclose the assistant when the policy asks).
#[derive(Clone, Copy)]
enum Line<'a> {
    Rep { extension: &'a str },
    Agent { opening: &'a str },
}

/// The workspace's capability of `kind` for the call: the one named (it must be of `kind`), or
/// the only live one. `None` when there is none to use; for a voice bridge, several live ones and
/// none named is `VALIDATION` naming `capability_id`.
async fn line_capability(
    r: &mut dyn TenantRepos,
    kind: &'static str,
    named: Option<CapabilityId>,
) -> Result<Option<Capability>, AppError> {
    if let Some(id) = named {
        let c = r
            .capabilities()
            .find(id)
            .await?
            .ok_or_else(|| AppError::not_found("no such capability"))?;
        if c.kind_key != kind {
            return Err(invalid(
                "capability_id",
                if kind == PBX_KIND {
                    "a rep's call goes through a netgsm_pbx capability"
                } else {
                    "an agent's call goes through a voice_bridge capability"
                },
            ));
        }
        return Ok(Some(c));
    }
    let live: Vec<Capability> = r
        .capabilities()
        .list(CapabilityFilter {
            kind: Some(kind),
            ..CapabilityFilter::default()
        })
        .await?
        .into_iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .collect();
    if kind == VOICE_BRIDGE_KIND && live.len() > 1 {
        return Err(invalid(
            "capability_id",
            "the workspace has several voice bridges: name capability_id",
        ));
    }
    Ok(match <[Capability; 1]>::try_from(live) {
        Ok([only]) => Some(only),
        Err(_) => None,
    })
}

/// The person called: `person_id`, or the person holding `phone`. Neither is `VALIDATION`; an
/// unknown person or number `NOT_FOUND`.
async fn person_of(
    r: &mut dyn TenantRepos,
    person_id: Option<PersonId>,
    phone: Option<&str>,
) -> Result<jt_inbox::Person, AppError> {
    if let Some(id) = person_id {
        return r
            .people()
            .get(id)
            .await?
            .ok_or_else(|| AppError::not_found("no such person"));
    }
    let phone = phone.ok_or_else(|| invalid("person_id", "give person_id or phone"))?;
    let normalized = jt_inbox::normalise(IdentityChannel::Phone, phone)
        .map_err(|_| invalid("phone", "not a phone number"))?;
    r.people()
        .find_by_identity(IdentityChannel::Phone, &normalized)
        .await?
        .ok_or_else(|| AppError::not_found("no person holds this phone number"))
}

/// The most calls a voice bridge carries at once by its registration (`max_calls`), one when it
/// did not say.
fn bridge_lines(bridge: &Capability) -> u64 {
    bridge.connector_public["bridge"]["max_calls"]
        .as_u64()
        .unwrap_or(1)
        .max(1)
}

/// Whether an agent's call through `bridge` finds the line busy: the bridge carries as many live
/// agent calls as it has lines, or `connection` (the agent placing it) already has one on the
/// line (spec §8.7: one live agent call per agent connection). `own` is the session being
/// dialed, which counts for neither.
async fn agent_line_busy(
    r: &mut dyn TenantRepos,
    bridge: &Capability,
    connection: Option<AgentConnectionId>,
    own: Option<CallId>,
) -> Result<bool, AppError> {
    let live: Vec<CallSession> = r
        .calls()
        .live()
        .await?
        .into_iter()
        .filter(|s| s.mode == CallMode::Agent && Some(s.id) != own)
        .collect();
    let on_bridge = live.iter().filter(|s| s.capability_id == bridge.id).count();
    let mine = connection.is_some_and(|c| live.iter().any(|s| s.agent_connection_id == Some(c)));
    Ok(u64::try_from(on_bridge).unwrap_or(u64::MAX) >= bridge_lines(bridge) || mine)
}

/// Gathers the fence's facts for a call to `person_id` (or `phone`) for `purpose` on `line`
/// through `capability` (a `netgsm_pbx` for a rep, a `voice_bridge` for the agent), and decides.
/// `own` is the session being dialed: it is not counted against the day's cap and does not make
/// its own line busy.
#[allow(clippy::too_many_arguments)]
async fn facts(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    capability: Option<CapabilityId>,
    person_id: Option<PersonId>,
    phone: Option<&str>,
    journey_id: Option<JourneyId>,
    purpose: CallPurpose,
    line: Line<'_>,
    own: Option<CallId>,
) -> Result<Result<Facts, RefusalReason>, AppError> {
    let now = ctx.now;
    let kind = match line {
        Line::Rep { .. } => PBX_KIND,
        Line::Agent { .. } => VOICE_BRIDGE_KIND,
    };
    let Some(capability) = line_capability(r, kind, capability).await? else {
        return Ok(Err(RefusalReason::BridgeOffline));
    };
    let person = person_of(r, person_id, phone).await?;
    let identities = r.identities().list(person.id).await?;
    let wanted = phone.and_then(|p| jt_inbox::normalise(IdentityChannel::Phone, p).ok());
    let identity = identities
        .iter()
        .filter(|i| i.active && i.channel == IdentityChannel::Phone)
        .filter(|i| i.value_normalized.starts_with('+'))
        .find(|i| wanted.as_deref().is_none_or(|w| w == i.value_normalized));
    let e164 = identity
        .map(|i| i.value_normalized.clone())
        .unwrap_or_default();
    let consents = r.consents().list(person.id).await?;
    let suppressions = r.suppressions().list(person.id).await?;
    let latest = r.journeys().latest_for(person.id).await?;
    let journey = match journey_id {
        Some(id) => {
            let j = r
                .journeys()
                .get(id)
                .await?
                .ok_or_else(|| AppError::not_found("no such journey"))?;
            if j.person_id != person.id {
                return Err(invalid("journey_id", "the journey is another person's"));
            }
            Some(j)
        }
        None => latest.clone(),
    };
    let mut relationship = RelationshipEvidence {
        won: latest
            .as_ref()
            .is_some_and(|j| j.status == JourneyStatus::Won),
        inbound_call_within_7d: r
            .calls()
            .inbound_since(person.id, now - Duration::days(CALLBACK_DAYS))
            .await?,
        ..RelationshipEvidence::default()
    };
    if let Some(j) = &latest {
        let since = now - Duration::days(RELATIONSHIP_DAYS);
        relationship.recent_appointment_or_quote =
            r.journeys().events(j.id, 200).await?.iter().any(|e| {
                e.at >= since
                    && matches!(
                        e.kind,
                        JourneyEventKind::AppointmentBooked | JourneyEventKind::QuoteSent
                    )
            });
        relationship.open_appointment = r
            .appointments()
            .list(j.id)
            .await?
            .iter()
            .any(|a| a.appointment.state == AppointmentState::Booked);
    }
    let policy = r.calls().policy().await?;
    let (from, to) = local_day(&capability, now);
    let calls_today = r
        .calls()
        .count_started(capability.id, from, to, own)
        .await?;
    let (remaining, per_minute) = budget_left(r, &capability, &policy, now).await?;
    let (busy, disclosure_present) = match line {
        Line::Rep { extension } => (r.calls().extension_busy(extension, own).await?, true),
        Line::Agent { opening } => (
            agent_line_busy(r, &capability, ctx.agent_connection_id, own).await?,
            policy.discloses(opening),
        ),
    };
    let verdict = fence_call(&FenceInput {
        purpose,
        workspace_active: r.workspace().get().await?.status == WorkspaceStatus::Active,
        strategy_approved: r.strategy().current_approved().await?.is_some(),
        bridge_online: effective_status(&capability, now) == EffectiveStatus::Verified,
        bridge_busy: busy,
        person_erased: person.erased_at.is_some(),
        person_merged: person.merged_into.is_some(),
        has_phone_identity: !e164.is_empty(),
        consents: &consents,
        suppressions: &suppressions,
        latest_journey_status: latest.as_ref().map(|j| j.status),
        relationship,
        hours_ok: within_hours(&capability, now)?,
        calls_today,
        daily_cap: capability.policy.daily_ops_cap,
        budget_remaining_minor: remaining,
        per_minute_minor: per_minute,
        disclosure_present,
    });
    Ok(Ok(Facts {
        capability,
        person_id: person.id,
        journey_id: journey.map(|j| j.id),
        e164,
        verdict,
    }))
}

/// What the capability's first live budget item has left this period and what one minute takes
/// from it, in its unit: the tariff estimate for a currency item, one for a minutes or count
/// item. Without a linked item, nothing is left and a minute takes the estimate.
async fn budget_left(
    r: &mut dyn TenantRepos,
    capability: &Capability,
    policy: &CallPolicy,
    now: OffsetDateTime,
) -> Result<(Option<i64>, i64), AppError> {
    for id in &capability.budget_item_ids {
        if let Some((item, left)) = super::budget::left_in_period(r, *id, now).await? {
            let minute = match item.unit {
                Unit::Currency(_) => policy.estimated_minor_per_minute,
                Unit::Minutes | Unit::Count(_) => 1,
            };
            return Ok((Some(left), minute));
        }
    }
    Ok((None, policy.estimated_minor_per_minute))
}

// ---------------------------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------------------------

/// Whether `ext` is a PBX extension: 1 to 16 digits.
fn extension_is_valid(ext: &str) -> bool {
    !ext.is_empty() && ext.len() <= MAX_EXTENSION_DIGITS && ext.bytes().all(|b| b.is_ascii_digit())
}

fn extension(input: &PlaceInput) -> Result<String, AppError> {
    let ext = input
        .rep_extension
        .as_deref()
        .map(str::trim)
        .ok_or_else(|| {
            invalid(
                "rep_extension",
                "a rep's call names the rep's PBX extension",
            )
        })?;
    if !extension_is_valid(ext) {
        return Err(invalid("rep_extension", "an extension is 1 to 16 digits"));
    }
    Ok(ext.to_owned())
}

/// The `calls.refused` payload of a refusal for `reason` of a call for `purpose` on a line of
/// `mode` (`human`, `agent`), naming the session when one existed.
fn refused_payload(
    reason: RefusalReason,
    purpose: CallPurpose,
    mode: &str,
    call: Option<CallId>,
) -> Value {
    let mut payload = json!({
        "reason": reason.key(),
        "purpose": purpose,
        "mode": mode,
    });
    if let Some(call) = call {
        payload["call_id"] = json!(call);
    }
    payload
}

/// The first fence's verdict on a call not yet made: the facts when it may be made; otherwise
/// `calls.refused` is written and committed, and the refusal returned.
async fn first_fence(
    mut r: Box<dyn TenantRepos>,
    ctx: &Ctx,
    gathered: Result<Facts, RefusalReason>,
    refused: impl Fn(RefusalReason) -> Value,
) -> Result<(Box<dyn TenantRepos>, Facts), AppError> {
    let reason = match gathered {
        Ok(facts) => match facts.verdict {
            Ok(()) => return Ok((r, facts)),
            Err(reason) => reason,
        },
        Err(reason) => reason,
    };
    ledger(
        r.as_mut(),
        ctx,
        "calls.refused",
        ctx.workspace_id,
        refused(reason),
    )
    .await?;
    r.commit().await?;
    Err(refusal(reason))
}

/// Places a call (see the module docs).
///
/// A rep's call (`mode: "human"`) rings the rep's extension, then the person, through the
/// workspace's verified `netgsm_pbx`. A provider failure ends the session `failed` with the
/// failure line and writes `calls.failed`; success keeps the PBX's correlation id (`crm_id`).
///
/// An agent's call (`mode: "agent"`) brings its plan (`VALIDATION` naming the plan's field when a
/// sentence, a count or the duration is out of bounds) and no extension, and goes through the
/// workspace's voice bridge: verified (a heartbeat within the minute), with a free line (it
/// carries fewer agent calls than its `max_calls`, and the agent placing it has none on the line:
/// else `bridge_busy`), its opening containing the policy's disclosure sentence while the policy
/// asks for one (`disclosure_missing`; the plan's `disclose_assistant` is forced on with it). The
/// session's bridge call id is its own id; the transaction that passes the second fence queues
/// the bridge's `dial` (the number and the plan, for the bridge to pre-synthesise). Recording is
/// asked for only when the bridge's capability allows it (`recording_allowed`) and the policy has
/// an announcement to play first.
///
/// The fence runs when the session is created and again, every fact read afresh, right before
/// dialing; a refusal is `CONFLICT` with the stable reason in `details.reason`, and writes
/// `calls.refused` once (payload: reason, purpose, mode, and the call when a session existed).
/// A dialed call writes `calls.placed` (call, purpose, mode, capability). Needs `calls.work`; the
/// catalog marks it SPEND.
pub async fn place(deps: &Deps, ctx: &Ctx, input: PlaceInput) -> Result<CallOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    if input.mode == PlaceMode::Agent {
        return place_agent(deps, ctx, input).await;
    }
    if input.plan.is_some() {
        return Err(invalid("plan", "a rep's call has no plan"));
    }
    let ext = extension(&input)?;
    let refused = |reason: RefusalReason, call: Option<CallId>| {
        refused_payload(reason, input.purpose, "human", call)
    };

    // 1. The first fence, and the session.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let gathered = facts(
        r.as_mut(),
        ctx,
        input.capability_id,
        input.person_id,
        input.phone.as_deref(),
        input.journey_id,
        input.purpose,
        Line::Rep { extension: &ext },
        None,
    )
    .await?;
    let (mut r, facts) = first_fence(r, ctx, gathered, |reason| refused(reason, None)).await?;
    let id = CallId(deps.ids.uuid());
    let pbx_policy = pbx_policy_of(&facts.capability);
    let session = CallSession {
        id,
        workspace_id: ctx.workspace_id,
        capability_id: facts.capability.id,
        direction: CallDirection::Outbound,
        purpose: input.purpose,
        person_id: Some(facts.person_id),
        journey_id: facts.journey_id,
        mode: CallMode::Human {
            rep_extension: ext.clone(),
        },
        state: CallState::Dialing,
        plan: None,
        counterpart_e164: facts.e164.clone(),
        bridge_call_id: None,
        pbx_unique_id: None,
        crm_id: None,
        agent_connection_id: ctx.agent_connection_id,
        placed_by: ctx.actor.clone(),
        started_at: ctx.now,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording: if pbx_policy.recording_allowed {
            RecordingState::Recording { file_ref: None }
        } else {
            RecordingState::Off
        },
        metrics: Default::default(),
        clock: TurnClock::default(),
    };
    r.calls().insert(session, ctx.now).await?;
    r.commit().await?;

    // 2. The fence again, every fact read afresh, right before dialing.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::internal("the call session vanished"))?;
    let again = facts_for(r.as_mut(), ctx, &session).await?;
    if let Err(reason) = again {
        jt_calls::end(&mut session, EndCause::Refused(reason), ctx.now);
        r.calls().update(session, ctx.now).await?;
        ledger(
            r.as_mut(),
            ctx,
            "calls.refused",
            id,
            refused(reason, Some(id)),
        )
        .await?;
        r.commit().await?;
        return Err(refusal(reason));
    }
    let capability = r
        .capabilities()
        .find(session.capability_id)
        .await?
        .ok_or_else(|| AppError::internal("the call's capability vanished"))?;
    let sealed = r
        .capabilities()
        .read_sealed(capability.id)
        .await?
        .ok_or_else(|| AppError::conflict("the PBX has no credentials"))?;
    let public = adapter_public(&capability);
    r.commit().await?;

    // 3. The PBX, outside any transaction.
    let telephony = deps
        .connectors
        .telephony(Provider::Netgsm)
        .ok_or_else(|| AppError::conflict("no telephony adapter is configured"))?;
    let credential = open_credential(deps, ctx.workspace_id, &sealed)?;
    let answer = telephony
        .click_to_call(&credential, &public, &ext, &session.counterpart_e164)
        .await;
    drop(credential);

    // 4. The receipt or the failure.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::internal("the call session vanished"))?;
    match answer {
        Ok(receipt) => {
            session.crm_id = Some(receipt.provider_id);
            r.calls().update(session.clone(), ctx.now).await?;
            ledger(
                r.as_mut(),
                ctx,
                "calls.placed",
                id,
                json!({
                    "call_id": id,
                    "purpose": session.purpose,
                    "mode": "human",
                    "capability_id": session.capability_id,
                }),
            )
            .await?;
        }
        Err(e) => {
            let line = failure_reason(Some(Provider::Netgsm), &e);
            jt_calls::end(&mut session, EndCause::Failed(line), ctx.now);
            r.calls().update(session.clone(), ctx.now).await?;
            ledger(
                r.as_mut(),
                ctx,
                "calls.failed",
                id,
                json!({ "call_id": id, "error_kind": e.kind() }),
            )
            .await?;
        }
    }
    r.commit().await?;
    Ok(CallOut {
        call: view(&session, reveals(ctx)),
        turns: vec![],
    })
}

/// Places an agent's call (see [`place`]).
async fn place_agent(deps: &Deps, ctx: &Ctx, input: PlaceInput) -> Result<CallOut, AppError> {
    if input.rep_extension.is_some() {
        return Err(invalid(
            "rep_extension",
            "an agent's call has no rep extension",
        ));
    }
    let mut plan = input
        .plan
        .clone()
        .ok_or_else(|| invalid("plan", "an agent's call brings its plan"))?;
    plan.validate()
        .map_err(|e| invalid(e.field(), &e.to_string()))?;
    let refused = |reason: RefusalReason, call: Option<CallId>| {
        refused_payload(reason, input.purpose, "agent", call)
    };

    // 1. The first fence, and the session.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let gathered = facts(
        r.as_mut(),
        ctx,
        input.capability_id,
        input.person_id,
        input.phone.as_deref(),
        input.journey_id,
        input.purpose,
        Line::Agent {
            opening: &plan.opening,
        },
        None,
    )
    .await?;
    let (mut r, facts) = first_fence(r, ctx, gathered, |reason| refused(reason, None)).await?;
    let policy = r.calls().policy().await?;
    plan.disclose_assistant |= policy.disclose_assistant;
    let id = CallId(deps.ids.uuid());
    let recording = if pbx_policy_of(&facts.capability).recording_allowed && policy.may_record() {
        RecordingState::Pending
    } else {
        RecordingState::Off
    };
    let session = CallSession {
        id,
        workspace_id: ctx.workspace_id,
        capability_id: facts.capability.id,
        direction: CallDirection::Outbound,
        purpose: input.purpose,
        person_id: Some(facts.person_id),
        journey_id: facts.journey_id,
        mode: CallMode::Agent,
        state: CallState::Dialing,
        plan: Some(plan),
        counterpart_e164: facts.e164.clone(),
        bridge_call_id: Some(id.to_string()),
        pbx_unique_id: None,
        crm_id: None,
        agent_connection_id: ctx.agent_connection_id,
        placed_by: ctx.actor.clone(),
        started_at: ctx.now,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording,
        metrics: Default::default(),
        clock: TurnClock::default(),
    };
    r.calls().insert(session, ctx.now).await?;
    r.commit().await?;

    // 2. The fence again, every fact read afresh, in the transaction that dials.
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::internal("the call session vanished"))?;
    if let Err(reason) = facts_for(r.as_mut(), ctx, &session).await? {
        jt_calls::end(&mut session, EndCause::Refused(reason), ctx.now);
        r.calls().update(session, ctx.now).await?;
        ledger(
            r.as_mut(),
            ctx,
            "calls.refused",
            id,
            refused(reason, Some(id)),
        )
        .await?;
        r.commit().await?;
        return Err(refusal(reason));
    }
    let plan = session
        .plan
        .clone()
        .ok_or_else(|| AppError::internal("an agent's call lost its plan"))?;
    let dial = Command::Dial {
        to_e164: session.counterpart_e164.clone(),
        plan,
    };
    r.calls()
        .enqueue_commands(id, vec![(CallCommandId(deps.ids.uuid()), dial)], ctx.now)
        .await?;
    ledger(
        r.as_mut(),
        ctx,
        "calls.placed",
        id,
        json!({
            "call_id": id,
            "purpose": session.purpose,
            "mode": "agent",
            "capability_id": session.capability_id,
        }),
    )
    .await?;
    r.commit().await?;
    deps.call_signals.notify(ctx.workspace_id);
    Ok(CallOut {
        call: view(&session, reveals(ctx)),
        turns: vec![],
    })
}

/// The fence's verdict on `session`, every fact read again.
async fn facts_for(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    session: &CallSession,
) -> Result<Result<(), RefusalReason>, AppError> {
    let phone = (!session.counterpart_e164.is_empty()).then_some(session.counterpart_e164.as_str());
    let line = match (&session.mode, &session.plan) {
        (CallMode::Human { rep_extension }, _) => Line::Rep {
            extension: rep_extension,
        },
        (CallMode::Agent, Some(plan)) => Line::Agent {
            opening: &plan.opening,
        },
        (CallMode::Agent, None) => return Err(AppError::internal("an agent's call has no plan")),
    };
    Ok(
        match facts(
            r,
            ctx,
            Some(session.capability_id),
            session.person_id,
            phone,
            session.journey_id,
            session.purpose,
            line,
            Some(session.id),
        )
        .await?
        {
            Ok(facts) => facts.verdict,
            Err(reason) => Err(reason),
        },
    )
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/// Call `id` with its turns. Needs `calls.work`.
pub async fn get(deps: &Deps, ctx: &Ctx, id: CallId) -> Result<CallOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let session = r
        .calls()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such call"))?;
    let turns = r.calls().turns(id, None, MAX_CALL_PAGE).await?;
    Ok(CallOut {
        call: view(&session, reveals(ctx)),
        turns,
    })
}

/// The workspace's calls, newest first, numbers masked. Needs `calls.work`.
pub async fn list(deps: &Deps, ctx: &Ctx, query: ListQuery) -> Result<Vec<Value>, AppError> {
    ctx.require(Permission::CallsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let calls = r
        .calls()
        .list(CallFilter {
            person_id: query.person_id,
            state: query.state,
            direction: query.direction,
            since: query.since,
            before: None,
            limit: query.limit.unwrap_or(50).clamp(1, MAX_CALL_PAGE),
        })
        .await?;
    Ok(calls.iter().map(|s| view(s, false)).collect())
}

// ---------------------------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------------------------

/// Who reported a call's journey event: the person, an agent, or the system (the voice bridge,
/// the timers).
fn event_source(ctx: &Ctx) -> EventSource {
    match &ctx.actor {
        Actor::Human { user_id } => EventSource::Human(*user_id),
        Actor::Agent { .. } => EventSource::Agent,
        Actor::System { .. } => EventSource::System,
    }
}

/// Records how call `id` went (see [`EndInput`]): a call still on the line is ended
/// (`agent_ended`; an agent's answered call hears its plan's closing, then the bridge hangs up);
/// the journey gets `CallMade{connected}` (connected as the outcome says, else whether the call
/// was answered) unless the call's end already wrote it or the journey is lost; the summary
/// becomes a note and the follow-up a task on the journey; with a known duration and a tariff,
/// the spend is recorded once on the capability's budget item. Ending a call twice changes
/// nothing and answers the call. Writes `calls.ended` (cause, outcome, duration, turns), unless
/// the call is an agent's that had already ended (its end wrote `calls.ended`), when it writes
/// `calls.outcome_recorded` (the outcome). Needs `calls.work`.
pub async fn end(deps: &Deps, ctx: &Ctx, id: CallId, input: EndInput) -> Result<CallOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if summary
        .as_ref()
        .is_some_and(|s| s.chars().count() > MAX_SUMMARY_CHARS)
    {
        return Err(invalid("summary", "a summary is at most 2000 characters"));
    }
    if let Some(task) = &input.follow_up_task
        && (task.title.trim().is_empty() || task.title.chars().count() > 200)
    {
        return Err(invalid(
            "follow_up_task.title",
            "a task title is 1 to 200 characters",
        ));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such call"))?;
    if session.outcome.is_some() {
        let turns = r.calls().turns(id, None, MAX_CALL_PAGE).await?;
        return Ok(CallOut {
            call: view(&session, reveals(ctx)),
            turns,
        });
    }
    if matches!(session.end_cause, Some(EndCause::Refused(_))) {
        return Err(AppError::conflict("a refused call was never placed"));
    }
    // An agent's call that ended on its own (the line, the timers, a transfer) was settled then.
    let settled = session.mode == CallMode::Agent && session.state == CallState::Ended;
    let mut pending = session::Pending::default();
    if session.state != CallState::Ended {
        pending.add(jt_calls::end(&mut session, EndCause::AgentEnded, ctx.now));
        // The closing still plays; the call's record ends now.
        jt_calls::close(&mut session, EndCause::AgentEnded, ctx.now);
    }
    let queued = pending.store(deps, r.as_mut(), id, ctx.now).await?;
    session.outcome = Some(input.outcome);
    session.summary = summary.clone();
    let source = event_source(ctx);
    if session.person_id.is_some() {
        journey_effects(deps, ctx, r.as_mut(), &mut session, source, summary, &input).await?;
    }
    charge(deps, ctx, r.as_mut(), &mut session).await?;
    r.calls().update(session.clone(), ctx.now).await?;
    if settled {
        ledger(
            r.as_mut(),
            ctx,
            "calls.outcome_recorded",
            id,
            json!({ "call_id": id, "outcome": input.outcome }),
        )
        .await?;
    } else {
        ledger(
            r.as_mut(),
            ctx,
            "calls.ended",
            id,
            json!({
                "call_id": id,
                "cause": session.end_cause.as_ref().map(EndCause::key),
                "outcome": input.outcome,
                "duration_s": session.duration_s,
                "turns": session.metrics.turns,
            }),
        )
        .await?;
    }
    r.commit().await?;
    if queued {
        deps.call_signals.notify(ctx.workspace_id);
    }
    let turns = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.calls().turns(id, None, MAX_CALL_PAGE).await?
    };
    Ok(CallOut {
        call: view(&session, reveals(ctx)),
        turns,
    })
}

/// The journey a call's effects go to: the session's, else the person's open one (opened when
/// there is none; a lost one is kept); `None` for a call without a person, or whose person is
/// gone or erased. The session is pointed at it.
async fn call_journey(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    session: &mut CallSession,
) -> Result<Option<Journey>, AppError> {
    let Some(person_id) = session.person_id else {
        return Ok(None);
    };
    let Some(person) = r.people().get(person_id).await? else {
        return Ok(None);
    };
    if person.erased_at.is_some() {
        return Ok(None);
    }
    let journey = match session.journey_id {
        Some(id) => r.journeys().get(id).await?,
        None => None,
    };
    let journey = match journey {
        Some(j) => j,
        None => super::inbox::consumer::journey(deps, ctx, r, &person).await?,
    };
    session.journey_id = Some(journey.id);
    Ok(Some(journey))
}

/// Writes `CallMade{connected}` for `session` on `journey` as `source` reported it, once per
/// call (keyed by the PBX's call id when it has one, else by the session), and never on a lost
/// journey.
async fn call_made(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    session: &CallSession,
    journey: &Journey,
    connected: bool,
    source: EventSource,
) -> Result<(), AppError> {
    let key = session
        .pbx_unique_id
        .as_ref()
        .map_or_else(|| format!("calls:{}", session.id), |u| format!("call:{u}"));
    if journey.status == JourneyStatus::Lost || r.journeys().event_by_key(&key).await?.is_some() {
        return Ok(());
    }
    super::inbox::consumer::apply_from(
        deps,
        ctx,
        r,
        journey.clone(),
        key,
        JourneyEventKind::CallMade { connected },
        source,
    )
    .await
}

/// The journey event, note and task of an ended call (see [`end`]).
async fn journey_effects(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    session: &mut CallSession,
    source: EventSource,
    summary: Option<String>,
    input: &EndInput,
) -> Result<(), AppError> {
    let Some(journey) = call_journey(deps, ctx, r, session).await? else {
        return Ok(());
    };
    let connected = input
        .outcome
        .reached()
        .unwrap_or(session.answered_at.is_some());
    call_made(deps, ctx, r, session, &journey, connected, source).await?;
    if let Some(text) = summary {
        r.notes()
            .insert(Note {
                id: NoteId::from(deps.ids.uuid()),
                workspace_id: ctx.workspace_id,
                journey_id: journey.id,
                author: source,
                text,
                at: ctx.now,
            })
            .await?;
    }
    if let Some(task) = &input.follow_up_task {
        r.tasks()
            .insert(Task {
                id: TaskId::from(deps.ids.uuid()),
                workspace_id: ctx.workspace_id,
                journey_id: journey.id,
                title: task.title.trim().to_owned(),
                due_at: task.due_at,
                assignee: match ctx.actor {
                    Actor::Human { user_id } => Some(user_id),
                    _ => None,
                },
                status: TaskStatus::Open,
            })
            .await?;
    }
    Ok(())
}

/// What an agent's call that has just ended leaves behind, whichever way it ended (the bridge's
/// hangup or error, the timers' closing, a transfer; spec §7, §8.6, §12): the person's journey
/// gets `CallMade{connected: answered}` (not for a call refused before dialing or failed at the
/// bridge, nor on a lost journey or an erased person), the spend is recorded on the bridge's
/// budget item, and `calls.ended` (cause, duration, turns) is written. `calls.end` records the
/// outcome later without writing either again.
pub(crate) async fn settle(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    session: &mut CallSession,
) -> Result<(), AppError> {
    if matches!(session.end_cause, Some(EndCause::Refused(_))) {
        return Ok(());
    }
    if !matches!(session.end_cause, Some(EndCause::Failed(_)))
        && let Some(journey) = call_journey(deps, ctx, r, session).await?
    {
        let connected = session.answered_at.is_some();
        call_made(
            deps,
            ctx,
            r,
            session,
            &journey,
            connected,
            event_source(ctx),
        )
        .await?;
    }
    charge(deps, ctx, r, session).await?;
    ledger(
        r,
        ctx,
        "calls.ended",
        session.id,
        json!({
            "call_id": session.id,
            "cause": session.end_cause.as_ref().map(EndCause::key),
            "duration_s": session.duration_s,
            "turns": session.metrics.turns,
        }),
    )
    .await
}

/// What a call of `duration_s` costs on `item_unit`: started minutes times the tariff for a
/// currency item, the started minutes for a minutes item, one for a count item.
fn cost(duration_s: u32, unit: &Unit, per_minute: i64) -> i64 {
    let minutes = i64::from(duration_s.div_ceil(60).max(1));
    match unit {
        Unit::Currency(_) => minutes.saturating_mul(per_minute),
        Unit::Minutes => minutes,
        Unit::Count(_) => 1,
    }
}

/// Records the call's spend on the capability's first live budget item, once its duration is
/// known: the full cost the first time, and later (a call record correcting the duration) only
/// what it adds. Nothing without a linked item, a duration, or a positive cost.
pub(crate) async fn charge(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    session: &mut CallSession,
) -> Result<(), AppError> {
    let Some(duration) = session.duration_s.filter(|d| *d > 0) else {
        return Ok(());
    };
    let Some(capability) = r.capabilities().find(session.capability_id).await? else {
        return Ok(());
    };
    let policy = r.calls().policy().await?;
    for item_id in &capability.budget_item_ids {
        let Some((item, _)) = super::budget::left_in_period(r, *item_id, ctx.now).await? else {
            continue;
        };
        let total = cost(duration, &item.unit, policy.estimated_minor_per_minute);
        let already = session.cost_minor.unwrap_or(0);
        let add = total - already;
        if total > 0 && add > 0 {
            super::budget::spend_in(
                deps,
                ctx,
                r,
                item.id,
                add,
                Some(format!("call:{}", session.id)),
            )
            .await?;
            session.cost_minor = Some(total);
        }
        return Ok(());
    }
    Ok(())
}
