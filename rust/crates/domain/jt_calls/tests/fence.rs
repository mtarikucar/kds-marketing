//! The call fence (spec §8): every refusal is reached, in order, and only the phone channel's
//! consent and suppressions count.
mod support;

use std::collections::BTreeSet;

use jt_calls::{CallPurpose, FenceInput, RefusalReason, RelationshipEvidence, fence_call};
use jt_inbox::{Channel, ConsentKind, JourneyStatus, PersonId};
use support::*;

/// Facts under which a commercial call to a consenting person passes.
fn passing<'a>(
    consents: &'a [jt_inbox::Consent],
    suppressions: &'a [jt_inbox::Suppression],
) -> FenceInput<'a> {
    FenceInput {
        purpose: CallPurpose::Commercial,
        workspace_active: true,
        strategy_approved: true,
        bridge_online: true,
        bridge_busy: false,
        person_erased: false,
        person_merged: false,
        has_phone_identity: true,
        consents,
        suppressions,
        latest_journey_status: Some(JourneyStatus::Contacted),
        relationship: RelationshipEvidence::default(),
        hours_ok: true,
        calls_today: 0,
        daily_cap: Some(20),
        budget_remaining_minor: Some(1_000),
        per_minute_minor: 150,
        disclosure_present: true,
    }
}

#[test]
fn every_refusal_reason_is_reached_once_and_in_order() {
    let person = PersonId::new_v7();
    let arama = [consent(person, Channel::Phone, ConsentKind::Explicit)];
    let none: [jt_inbox::Suppression; 0] = [];
    let phone_off = [suppression(person, Channel::Phone)];
    let base = passing(&arama, &none);
    assert_eq!(fence_call(&base), Ok(()));

    type Edit = fn(&mut FenceInput<'_>);
    let cases: [(RefusalReason, Edit); 15] = [
        (RefusalReason::WorkspaceInactive, |i| {
            i.workspace_active = false
        }),
        (RefusalReason::StrategyRequired, |i| {
            i.strategy_approved = false
        }),
        (RefusalReason::BridgeOffline, |i| i.bridge_online = false),
        (RefusalReason::PersonErased, |i| i.person_erased = true),
        (RefusalReason::PersonMerged, |i| i.person_merged = true),
        (RefusalReason::NoPhoneIdentity, |i| {
            i.has_phone_identity = false
        }),
        (RefusalReason::JourneyLost, |i| {
            i.latest_journey_status = Some(JourneyStatus::Lost)
        }),
        (RefusalReason::ConsentMissing, |i| i.consents = &[]),
        (RefusalReason::NoRelationship, |i| {
            i.purpose = CallPurpose::Service
        }),
        (RefusalReason::NoRecentInbound, |i| {
            i.purpose = CallPurpose::Callback
        }),
        (RefusalReason::OutsideWorkHours, |i| i.hours_ok = false),
        (RefusalReason::DailyOpsCap, |i| i.calls_today = 20),
        (RefusalReason::BudgetExhausted, |i| {
            i.budget_remaining_minor = Some(149)
        }),
        (RefusalReason::BridgeBusy, |i| i.bridge_busy = true),
        (RefusalReason::DisclosureMissing, |i| {
            i.disclosure_present = false
        }),
    ];
    let mut reached = BTreeSet::new();
    for (reason, edit) in cases {
        let mut input = base.clone();
        edit(&mut input);
        assert_eq!(fence_call(&input), Err(reason), "{reason:?}");
        reached.insert(reason.key());
    }
    // Suppression on the phone channel, the sixteenth.
    let suppressed = FenceInput {
        suppressions: &phone_off,
        ..base.clone()
    };
    assert_eq!(fence_call(&suppressed), Err(RefusalReason::Suppressed));
    reached.insert(RefusalReason::Suppressed.key());
    assert_eq!(
        reached,
        RefusalReason::ALL
            .iter()
            .map(|r| r.key())
            .collect::<BTreeSet<_>>()
    );

    // First refusal wins: an inactive workspace outranks everything else that is wrong.
    let mut everything = base.clone();
    for (_, edit) in cases {
        edit(&mut everything);
    }
    assert_eq!(
        fence_call(&everything),
        Err(RefusalReason::WorkspaceInactive)
    );
}

#[test]
fn consent_is_by_purpose_and_only_the_phone_channel_counts() {
    let person = PersonId::new_v7();
    let none: [jt_inbox::Suppression; 0] = [];
    // SMS consent is not phone consent; an implied-by-contract phone consent is; a withdrawal is
    // not; a suppression on SMS does not stop a call.
    for (consents, ok) in [
        (
            vec![consent(person, Channel::Sms, ConsentKind::Explicit)],
            false,
        ),
        (
            vec![consent(
                person,
                Channel::Phone,
                ConsentKind::ImpliedByContract,
            )],
            true,
        ),
        (
            vec![consent(person, Channel::Phone, ConsentKind::Withdrawn)],
            false,
        ),
    ] {
        let input = passing(&consents, &none);
        assert_eq!(fence_call(&input).is_ok(), ok, "{consents:?}");
    }
    let arama = [consent(person, Channel::Phone, ConsentKind::Explicit)];
    let sms_off = [suppression(person, Channel::Sms)];
    // `commercial_allowed` refuses any suppression of the person, so an SMS-only suppression
    // still blocks a commercial call; it does not block a service call.
    let service = FenceInput {
        purpose: CallPurpose::Service,
        relationship: RelationshipEvidence {
            open_appointment: true,
            ..RelationshipEvidence::default()
        },
        ..passing(&arama, &sms_off)
    };
    assert_eq!(fence_call(&service), Ok(()));

    // Service: any of the three relationship facts; no consent needed, but a lost journey
    // refuses it.
    for relationship in [
        RelationshipEvidence {
            won: true,
            ..RelationshipEvidence::default()
        },
        RelationshipEvidence {
            recent_appointment_or_quote: true,
            ..RelationshipEvidence::default()
        },
        RelationshipEvidence {
            open_appointment: true,
            ..RelationshipEvidence::default()
        },
    ] {
        let input = FenceInput {
            purpose: CallPurpose::Service,
            relationship,
            ..passing(&[], &none)
        };
        assert_eq!(fence_call(&input), Ok(()));
        let lost = FenceInput {
            latest_journey_status: Some(JourneyStatus::Lost),
            ..input
        };
        assert_eq!(fence_call(&lost), Err(RefusalReason::JourneyLost));
    }
    // A callback needs a recent inbound call, and may follow up a lost journey.
    let callback = FenceInput {
        purpose: CallPurpose::Callback,
        latest_journey_status: Some(JourneyStatus::Lost),
        relationship: RelationshipEvidence {
            inbound_call_within_7d: true,
            ..RelationshipEvidence::default()
        },
        ..passing(&[], &none)
    };
    assert_eq!(fence_call(&callback), Ok(()));
}

#[test]
fn budget_and_cap_edges() {
    let person = PersonId::new_v7();
    let arama = [consent(person, Channel::Phone, ConsentKind::Explicit)];
    let none: [jt_inbox::Suppression; 0] = [];
    let base = passing(&arama, &none);
    // Exactly one minute left passes; no budget link with a known tariff fails closed; an
    // unknown tariff needs no budget; no cap means no cap.
    for (remaining, per_minute, ok) in [
        (Some(150), 150, true),
        (None, 150, false),
        (None, 0, true),
        (Some(0), 0, true),
    ] {
        let input = FenceInput {
            budget_remaining_minor: remaining,
            per_minute_minor: per_minute,
            ..base.clone()
        };
        assert_eq!(fence_call(&input).is_ok(), ok, "{remaining:?} {per_minute}");
    }
    let uncapped = FenceInput {
        daily_cap: None,
        calls_today: 10_000,
        ..base.clone()
    };
    assert_eq!(fence_call(&uncapped), Ok(()));
    let under = FenceInput {
        calls_today: 19,
        ..base
    };
    assert_eq!(fence_call(&under), Ok(()));
}
