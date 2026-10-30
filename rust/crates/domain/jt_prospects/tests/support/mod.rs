//! Shared builders of the jt_prospects tests. Every value is invented: `example.invalid`
//! addresses, numbers made of zeros, made-up business names.
#![allow(dead_code)]

use jt_prospects::*;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use time::OffsetDateTime;
use time::macros::datetime;
use uuid::Uuid;

pub const NOW: OffsetDateTime = datetime!(2026-10-30 12:00 UTC);

pub fn agent() -> Recorder {
    Recorder::Agent {
        connection_id: AgentConnectionId(Uuid::from_u128(1)),
        user_id: UserId(Uuid::from_u128(2)),
    }
}

pub fn human() -> Recorder {
    Recorder::Human {
        user_id: UserId(Uuid::from_u128(3)),
    }
}

pub fn url(u: &str) -> SourceRefInput {
    SourceRefInput::Url {
        url: u.to_owned(),
        note: None,
    }
}

pub fn field<T>(value: T) -> FieldInput<T> {
    FieldInput {
        value,
        sources: vec![url("https://ornek-kafe.example.invalid/iletisim")],
        captured_at: NOW - time::Duration::days(1),
    }
}

/// A minimal valid create input: a name, a kind and a phone with its source.
pub fn input() -> CreateInput {
    CreateInput {
        business_name: "Örnek Kafe Ltd. Şti.".into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: Some("Kadıköy".into()),
        language: Some("tr".into()),
        segment_key: Some("kafeler".into()),
        country: None,
        labels: vec![],
        phone: Some(field("0500 000 00 00".into())),
        email: None,
        website: None,
        instagram: None,
        tiktok: None,
        address: None,
        contact_person: None,
        size: None,
        signals: vec![],
        notes: String::new(),
        research_task_id: None,
        discovered_at: vec![],
        distinct_from: vec![],
        request_key: None,
    }
}

pub fn ws() -> WorkspaceId {
    WorkspaceId(Uuid::from_u128(10))
}

pub fn pid(n: u128) -> ProspectId {
    ProspectId(Uuid::from_u128(100 + n))
}

/// The prospect `input()` builds, recorded by an agent.
pub fn prospect(input: CreateInput) -> Prospect {
    validate_create(&input, NOW, &agent()).expect("a valid input");
    build(input, pid(1), ws(), NOW, agent())
}
