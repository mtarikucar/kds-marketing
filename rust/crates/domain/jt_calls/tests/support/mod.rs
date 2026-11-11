//! Shared builders of the jt_calls tests.
#![allow(dead_code)]

use jt_calls::{
    CallDirection, CallId, CallMetrics, CallMode, CallPlan, CallPolicy, CallPurpose, CallSession,
    CallState, RecordingState, TurnClock,
};
use jt_capability::CapabilityId;
use jt_inbox::{
    Channel, Consent, ConsentId, ConsentKind, ConsentSource, PersonId, Suppression,
    SuppressionReason, SyncState,
};
use jt_ledger::Actor;
use jt_tenancy::{UserId, WorkspaceId};
use time::OffsetDateTime;
use time::macros::datetime;

pub const T0: OffsetDateTime = datetime!(2026-10-27 10:00 UTC);

pub fn plan() -> CallPlan {
    CallPlan {
        opening: "Merhaba, ben Kahve'nin dijital asistanıyım. Randevunuzu teyit için arıyorum."
            .into(),
        goal: "Randevuyu teyit et".into(),
        holding: vec![
            "Bir saniye, kontrol ediyorum.".into(),
            "Hemen bakıyorum.".into(),
        ],
        fallback: vec![
            "Bağlantıda bir gecikme var, lütfen bekleyin.".into(),
            "Sizi en kısa sürede geri arayacağız.".into(),
        ],
        closing: "Teşekkürler, iyi günler.".into(),
        max_duration_s: 300,
        language: "tr".into(),
        disclose_assistant: true,
        hotwords: Vec::new(),
    }
}

pub fn policy() -> CallPolicy {
    CallPolicy {
        recording_announcement: "Bu görüşme kalite amacıyla kaydedilmektedir.".into(),
        disclosure_sentence: "dijital asistanıyım".into(),
        holding_default: vec!["Bir dakika lütfen.".into()],
        ..CallPolicy::default()
    }
}

pub fn session(mode: CallMode, plan: Option<CallPlan>) -> CallSession {
    CallSession {
        id: CallId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        capability_id: CapabilityId::new_v7(),
        direction: CallDirection::Outbound,
        purpose: CallPurpose::Service,
        person_id: Some(PersonId::new_v7()),
        journey_id: None,
        mode,
        state: CallState::Dialing,
        plan,
        counterpart_e164: "+905321234567".into(),
        bridge_call_id: None,
        pbx_unique_id: None,
        crm_id: None,
        agent_connection_id: None,
        placed_by: Actor::Human {
            user_id: UserId::new_v7(),
        },
        started_at: T0,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording: RecordingState::Off,
        metrics: CallMetrics::default(),
        clock: TurnClock::default(),
        phrases: Default::default(),
    }
}

pub fn agent_session() -> CallSession {
    session(CallMode::Agent, Some(plan()))
}

pub fn human_session() -> CallSession {
    session(
        CallMode::Human {
            rep_extension: "101".into(),
        },
        None,
    )
}

pub fn consent(person: PersonId, channel: Channel, kind: ConsentKind) -> Consent {
    Consent {
        id: ConsentId::new_v7(),
        person_id: person,
        channel,
        kind,
        source: ConsentSource::IysSync,
        at: T0 - time::Duration::days(3),
        sync_state: SyncState::Sent,
        attempts: 1,
    }
}

pub fn suppression(person: PersonId, channel: Channel) -> Suppression {
    Suppression {
        person_id: person,
        channel,
        reason: SuppressionReason::Manual,
    }
}
