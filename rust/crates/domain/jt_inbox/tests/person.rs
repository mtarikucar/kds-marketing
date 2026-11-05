use jt_inbox::*;
use jt_tenancy::WorkspaceId;
use serde_json::json;
use time::OffsetDateTime;

#[test]
fn source_prospect_round_trips_and_v1_import_still_reads() {
    let prospect_id = uuid::Uuid::now_v7();
    let source = Source::Prospect {
        prospect_id,
        origin: "research_task".into(),
    };
    let value = serde_json::to_value(&source).unwrap();
    assert_eq!(
        value,
        json!({"prospect": {"prospect_id": prospect_id, "origin": "research_task"}})
    );
    assert_eq!(serde_json::from_value::<Source>(value).unwrap(), source);
    assert_eq!(source_kind(&source), SourceKind::Prospect);

    let v1 = json!({
        "kind": "import", "system": "v1", "v1_lead_id": "L-1",
        "v1_source": "web", "v1_status": "NEW"
    });
    let read: Source = serde_json::from_value(v1.clone()).unwrap();
    assert!(matches!(read, Source::V1Import { ref v1_lead_id, .. } if v1_lead_id == "L-1"));
    assert_eq!(serde_json::to_value(&read).unwrap(), v1);
    assert_eq!(source_kind(&read), SourceKind::Import);
    for (source, kind) in [
        (Source::Channel(Channel::WhatsApp), SourceKind::Channel),
        (Source::MetaAds, SourceKind::MetaAds),
        (Source::Import, SourceKind::Import),
        (Source::Form, SourceKind::Form),
        (Source::Repeat, SourceKind::Repeat),
    ] {
        assert_eq!(source_kind(&source), kind);
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            json!(kind.key()),
            "{kind:?}"
        );
    }
}

#[test]
fn recipient_kind_defaults_to_unknown() {
    let person = Person {
        id: PersonId::new_v7(),
        workspace_id: WorkspaceId::new_v7(),
        display_name: "Ayşe".into(),
        company: "Ayşe Kuaför".into(),
        recipient_kind: RecipientKind::Business,
        first_touch: FirstTouch {
            source: Source::Form,
            capability_id: None,
            at: OffsetDateTime::UNIX_EPOCH,
        },
        merged_into: None,
        erased_at: None,
        created_at: OffsetDateTime::UNIX_EPOCH,
        updated_at: OffsetDateTime::UNIX_EPOCH,
    };
    let mut value = serde_json::to_value(&person).unwrap();
    assert_eq!(value["recipient_kind"], json!("business"));
    assert_eq!(
        serde_json::from_value::<Person>(value.clone()).unwrap(),
        person
    );
    value.as_object_mut().unwrap().remove("recipient_kind");
    let old: Person = serde_json::from_value(value).unwrap();
    assert_eq!(old.recipient_kind, RecipientKind::Unknown);
    assert_eq!(RecipientKind::default(), RecipientKind::Unknown);
    for kind in RecipientKind::ALL {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.key()));
        assert_eq!(RecipientKind::parse(kind.key()), Some(*kind));
    }
    assert_eq!(RecipientKind::parse("company"), None);
}
