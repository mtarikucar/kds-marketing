//! The gates every placed call passes (spec §8), in order, the first refusal winning. The use
//! case gathers the facts inside the tenant transaction (and again right before dialing); this
//! decides.

use jt_inbox::{Channel, Consent, JourneyStatus, Suppression, commercial_allowed};

use crate::session::{CallPurpose, RefusalReason};

/// What makes a non-commercial call legitimate (spec §8.4): an existing customer relationship
/// for a service call, a recent inbound call for a callback.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RelationshipEvidence {
    /// A journey of the person reached `Won`.
    pub won: bool,
    /// An appointment was booked or a quote sent in the last 180 days.
    pub recent_appointment_or_quote: bool,
    /// An appointment is still open.
    pub open_appointment: bool,
    /// The person called in (or asked to be called back) in the last 7 days.
    pub inbound_call_within_7d: bool,
}

/// The facts the fence decides on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenceInput<'a> {
    pub purpose: CallPurpose,
    pub workspace_active: bool,
    pub strategy_approved: bool,
    /// The telephony capability is verified: the `voice_bridge` for an agent call (heartbeat
    /// fresh), the `netgsm_pbx` for a rep's call.
    pub bridge_online: bool,
    /// The bridge reports its line limit reached, or the caller's agent connection already has
    /// a live call.
    pub bridge_busy: bool,
    pub person_erased: bool,
    pub person_merged: bool,
    pub has_phone_identity: bool,
    /// The person's consent history (every channel; only the phone's counts).
    pub consents: &'a [Consent],
    /// The person's suppressions (every channel; only the phone's counts).
    pub suppressions: &'a [Suppression],
    pub latest_journey_status: Option<JourneyStatus>,
    pub relationship: RelationshipEvidence,
    /// The capability's working hours allow a call now.
    pub hours_ok: bool,
    /// Calls placed today (workspace time zone) through the capability.
    pub calls_today: u32,
    /// The capability's daily operation cap, if any.
    pub daily_cap: Option<u32>,
    /// What the linked budget item has left this period, in minor units; `None` without a link.
    pub budget_remaining_minor: Option<i64>,
    /// The policy's tariff estimate per started minute; 0 when unknown.
    pub per_minute_minor: i64,
    /// The opening carries the disclosure the policy asks for (always true for a rep's call).
    pub disclosure_present: bool,
}

/// `Ok` when the call may be placed, else the first refusal (see the module docs):
///
/// 1. the workspace is active and its strategy approved;
/// 2. the telephony capability is online;
/// 3. the person is neither erased nor merged away and has a phone identity;
/// 4. the phone channel is not suppressed; a commercial or service call is refused on a lost
///    journey; a commercial call needs effective İYS consent on the phone channel (explicit or
///    implied by contract, `Channel::Phone`, never SMS), a service call an existing relationship,
///    a callback a recent inbound call;
/// 5. the working hours allow it and the daily cap is not reached;
/// 6. with a known tariff, the budget has at least one minute left (and a budget is linked);
/// 7. the line is free;
/// 8. the opening discloses the assistant when the policy asks.
pub fn fence_call(input: &FenceInput<'_>) -> Result<(), RefusalReason> {
    use RefusalReason as R;
    let refuse = |cond: bool, reason: RefusalReason| if cond { Err(reason) } else { Ok(()) };
    refuse(!input.workspace_active, R::WorkspaceInactive)?;
    refuse(!input.strategy_approved, R::StrategyRequired)?;
    refuse(!input.bridge_online, R::BridgeOffline)?;
    refuse(input.person_erased, R::PersonErased)?;
    refuse(input.person_merged, R::PersonMerged)?;
    refuse(!input.has_phone_identity, R::NoPhoneIdentity)?;
    refuse(
        input
            .suppressions
            .iter()
            .any(|s| s.channel == Channel::Phone),
        R::Suppressed,
    )?;
    let lost = input.latest_journey_status == Some(JourneyStatus::Lost);
    match input.purpose {
        CallPurpose::Commercial => {
            refuse(lost, R::JourneyLost)?;
            commercial_allowed(input.consents, input.suppressions, Channel::Phone)
                .map_err(|_| R::ConsentMissing)?;
        }
        CallPurpose::Service => {
            refuse(lost, R::JourneyLost)?;
            let r = input.relationship;
            refuse(
                !(r.won || r.recent_appointment_or_quote || r.open_appointment),
                R::NoRelationship,
            )?;
        }
        CallPurpose::Callback => {
            refuse(
                !input.relationship.inbound_call_within_7d,
                R::NoRecentInbound,
            )?;
        }
    }
    refuse(!input.hours_ok, R::OutsideWorkHours)?;
    refuse(
        input.daily_cap.is_some_and(|cap| input.calls_today >= cap),
        R::DailyOpsCap,
    )?;
    let minute = input.per_minute_minor.max(0);
    refuse(
        minute > 0
            && input
                .budget_remaining_minor
                .is_none_or(|left| left < minute),
        R::BudgetExhausted,
    )?;
    refuse(input.bridge_busy, R::BridgeBusy)?;
    refuse(!input.disclosure_present, R::DisclosureMissing)?;
    Ok(())
}
