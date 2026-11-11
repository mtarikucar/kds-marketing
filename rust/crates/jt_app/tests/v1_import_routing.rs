//! The v1 import's routing between the inbox and the pool, and the records it builds (spec
//! 2026-10-30-leads-pool-outreach-design.md §10, D23; plan L7-T1). Pure: the database paths
//! (dry run, duplicates, rollback) are `jt_pg/tests/m4_v1_import.rs`'s. Every value is
//! synthetic: `example.invalid` addresses, `+90500…` numbers, invented names.

#![recursion_limit = "256"]

use std::collections::HashMap;

use jt_app::usecases::v1_import::{
    INBOUND_SOURCES, Lead, Owner, Report, Route, entity_id, owner_of, pool_record, route,
};
use jt_prospects::{
    EntityKind, Key, KeyKind, OriginVia, ProspectStatus, Recorder, SourceRef, derive_keys,
};
use jt_tenancy::{UserId, WorkspaceId};
use serde_json::{Value, json};
use time::macros::datetime;

const NOW: time::OffsetDateTime = datetime!(2026-11-11 09:00 UTC);

/// A format-2 research lead nobody contacted: the pool's case.
fn v2(id: &str) -> Value {
    json!({
        "format": 2, "id": id, "businessName": "Örnek Kafe Sentetik", "contactPerson": "Deneme Kişi",
        "phone": "+905000000001", "whatsapp": null, "email": "kafe@example.invalid",
        "address": "Örnek Sokak 1", "city": "İzmir", "region": "Konak", "businessType": "CAFE",
        "tableCount": 12, "branchCount": 2, "currentSystem": "Kağıt adisyon", "source": "AI_RESEARCH",
        "status": "NEW", "lostReason": null, "notes": "sentetik not", "nextFollowUp": null,
        "priority": "MEDIUM", "customFields": {"kaynak": "deneme"}, "emailOptOut": false,
        "smsOptOut": false, "waOptOut": false, "emailBouncedAt": null,
        "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2026-03-01T00:00:00Z",
        "deletedAt": null, "mergedIntoId": null,
        "contact": {"conversationsOutbound": 0, "conversationsInbound": 0, "campaignSent": 0,
                    "mailSent": 0, "activitiesOutbound": 0, "offers": 0, "lastContactAt": null},
        "activities": [], "offers": [], "tags": ["sıcak", "sıcak", "izmir"],
        "attribution": null,
        "research": {"evidence": "Menüsü yalnızca kâğıt", "painPoint": "Sipariş karışıyor",
                     "pitch": "QR menü", "stage": "GROWING", "website": "https://ornek-kafe.example.invalid/",
                     "instagram": "ornek.kafe", "score": 81.5, "createdAt": "2026-02-01T00:00:00Z"},
        "aiScore": 72, "aiScoreReason": "sentetik gerekçe", "scoredAt": "2026-02-02T00:00:00Z",
        "ownerEmail": "Rep@Example.Invalid", "emailVerifiedStatus": "UNKNOWN"
    })
}

fn lead(v: Value) -> Lead {
    let lead: Lead = serde_json::from_value(v).expect("synthetic lead parses");
    lead.validate().expect("synthetic lead is valid");
    lead
}

fn with(mut v: Value, path: &[&str], value: Value) -> Value {
    let mut at = &mut v;
    for p in &path[..path.len() - 1] {
        at = &mut at[*p];
    }
    at[path[path.len() - 1]] = value;
    v
}

#[test]
fn route_table() {
    // Spec §10, in order: deleted or merged are skipped; past NEW, any contact evidence or an
    // inbound source is the inbox; anything else (never contacted research) is the pool.
    let base = v2("route");
    assert_eq!(route(&lead(base.clone())), Route::Pool);
    assert_eq!(
        route(&lead(with(
            base.clone(),
            &["deletedAt"],
            json!("2026-01-01T00:00:00Z")
        ))),
        Route::SkipDeleted
    );
    assert_eq!(
        route(&lead(with(base.clone(), &["mergedIntoId"], json!("other")))),
        Route::SkipMerged
    );
    // Deleted wins over merged.
    let both = with(
        with(base.clone(), &["mergedIntoId"], json!("other")),
        &["deletedAt"],
        json!("2026-01-01T00:00:00Z"),
    );
    assert_eq!(route(&lead(both)), Route::SkipDeleted);
    for status in [
        "CONTACTED",
        "NOT_REACHABLE",
        "DEMO_SCHEDULED",
        "MEETING_DONE",
        "OFFER_SENT",
        "WAITING",
        "WON",
        "LOST",
    ] {
        assert_eq!(
            route(&lead(with(base.clone(), &["status"], json!(status)))),
            Route::Inbox,
            "{status}"
        );
    }
    for source in INBOUND_SOURCES {
        assert_eq!(
            route(&lead(with(base.clone(), &["source"], json!(source)))),
            Route::Inbox,
            "{source}"
        );
    }
    for source in ["AI_RESEARCH", "IMPORT", "OTHER"] {
        assert_eq!(
            route(&lead(with(base.clone(), &["source"], json!(source)))),
            Route::Pool,
            "{source}"
        );
    }
    // A format-2 lead without contact counts cannot prove it was never contacted.
    assert_eq!(
        route(&lead(with(base, &["contact"], Value::Null))),
        Route::Inbox
    );
}

#[test]
fn contacted_new_lead_goes_to_inbox() {
    for field in [
        "conversationsOutbound",
        "conversationsInbound",
        "campaignSent",
        "mailSent",
        "activitiesOutbound",
        "offers",
    ] {
        let v = with(v2("contacted"), &["contact", field], json!(1));
        assert_eq!(route(&lead(v)), Route::Inbox, "{field}");
    }
    let v = with(
        v2("contacted"),
        &["contact", "lastContactAt"],
        json!("2026-01-05T10:00:00Z"),
    );
    assert_eq!(route(&lead(v)), Route::Inbox);
}

#[test]
fn inbound_source_new_lead_goes_to_inbox() {
    assert_eq!(
        INBOUND_SOURCES,
        &[
            "INSTAGRAM",
            "WEBSITE",
            "PHONE",
            "EMAIL",
            "ADS",
            "REFERRAL",
            "HARDWARE_QUOTE",
            "FIELD_VISIT"
        ]
    );
    let v = with(v2("inbound"), &["source"], json!("WEBSITE"));
    assert_eq!(route(&lead(v)), Route::Inbox);
}

#[test]
fn research_lead_never_contacted_goes_to_pool() {
    assert_eq!(route(&lead(v2("research"))), Route::Pool);
    let ws = WorkspaceId::new_v7();
    let record = pool_record(ws, &lead(v2("research")), NOW).expect("a pool record");
    let p = &record.prospect;
    assert_eq!(p.status, ProspectStatus::New);
    assert_eq!(p.entity_kind, EntityKind::UnknownBusiness);
    assert_eq!(p.business_name, "Örnek Kafe Sentetik");
    assert_eq!(p.sector.as_deref(), Some("cafe"));
    assert_eq!(p.city.as_deref(), Some("İzmir"));
    assert_eq!(p.district.as_deref(), Some("Konak"));
    assert_eq!(p.labels, vec!["sıcak".to_owned(), "izmir".to_owned()]);
    assert_eq!(
        p.contact.phone.as_ref().map(|f| f.value.as_str()),
        Some("+905000000001")
    );
    assert_eq!(
        p.contact.email.as_ref().map(|f| f.value.as_str()),
        Some("kafe@example.invalid")
    );
    assert_eq!(
        p.contact.instagram.as_ref().map(|f| f.value.as_str()),
        Some("ornek.kafe")
    );
    assert!(p.contact.website.is_some());
    let person = p.contact.contact_person.as_ref().unwrap();
    assert_eq!(
        (person.value.name.as_str(), person.value.role.as_str()),
        ("Deneme Kişi", "")
    );
    let size = p.size.as_ref().unwrap();
    assert_eq!(size.value.branches, Some(2));
    assert!(size.value.note.as_deref().unwrap().contains("12"));
    let texts: Vec<&str> = p.signals.iter().map(|s| s.text.as_str()).collect();
    assert!(texts.iter().any(|t| t.contains("Kağıt adisyon")));
    assert!(texts.contains(&"Sipariş karışıyor"));
    assert!(texts.contains(&"Menüsü yalnızca kâğıt"));
    assert!(p.notes.contains("sentetik not"));
    assert!(p.notes.contains("kaynak: deneme"));
    // Retention starts at the import, not at v1's createdAt.
    assert_eq!((p.created_at, p.updated_at), (NOW, NOW));
    assert_eq!(p.revision, 1);
    assert_eq!(p.id.as_uuid(), entity_id(ws, "research", "prospect"));
    assert_eq!(record.keys, derive_keys(p));
    let score = record.score.as_ref().expect("the v1 score");
    assert_eq!(
        (score.score, score.rubric_digest.as_str()),
        (72, "v1-legacy")
    );
    assert!(score.strategy_version_id.is_none());
    assert_eq!(score.prospect_id, p.id);
}

#[test]
fn pool_prospect_carries_import_provenance() {
    let record = pool_record(WorkspaceId::new_v7(), &lead(v2("prov")), NOW).unwrap();
    let p = record.prospect;
    let import = Recorder::Import {
        system: "v1".into(),
        record: "prov".into(),
    };
    let source = SourceRef::Import {
        system: "v1".into(),
        record: "prov".into(),
    };
    assert_eq!(p.origin.via, OriginVia::V1Import);
    assert_eq!(p.origin.recorder, import);
    assert!(p.origin.discovered_at.iter().any(
        |s| matches!(s, SourceRef::Url { url, .. } if url.contains("ornek-kafe.example.invalid"))
    ));
    let c = &p.contact;
    let evidences = [
        &c.phone.as_ref().unwrap().evidence,
        &c.email.as_ref().unwrap().evidence,
        &c.website.as_ref().unwrap().evidence,
        &c.instagram.as_ref().unwrap().evidence,
        &c.address.as_ref().unwrap().evidence,
        &c.contact_person.as_ref().unwrap().evidence,
        &p.size.as_ref().unwrap().evidence,
    ];
    for e in evidences {
        assert_eq!(e.recorder, import);
        assert!(e.sources.contains(&source));
        assert!(e.captured_at <= NOW);
    }
    assert!(p.signals.iter().all(|s| s.source == source));
    assert_eq!(record.score.unwrap().recorder, import);
}

#[test]
fn pool_duplicates_and_in_inbox_are_counted() {
    // The counters exist and start at zero; the database paths that move them are
    // jt_pg's `pool_duplicates_and_in_inbox_are_counted`.
    let report = serde_json::to_value(Report::default()).unwrap();
    for key in [
        "to_inbox",
        "to_pool",
        "pooled",
        "skipped_deleted",
        "skipped_merged",
        "pool_duplicates",
        "pool_in_inbox",
        "pool_dnc",
        "pool_blocked",
        "pool_invalid",
    ] {
        assert_eq!(report[key], json!(0), "{key}");
    }
    // Two leads of one business share their hard keys: the second is a duplicate.
    let ws = WorkspaceId::new_v7();
    let one = pool_record(ws, &lead(v2("one")), NOW).unwrap();
    let two = pool_record(ws, &lead(v2("two")), NOW).unwrap();
    let hard =
        |keys: &[Key]| -> Vec<Key> { keys.iter().filter(|k| k.kind.hard()).cloned().collect() };
    assert!(!hard(&one.keys).is_empty());
    assert_eq!(hard(&one.keys), hard(&two.keys));
    assert_ne!(one.prospect.id, two.prospect.id);
}

#[test]
fn opt_outs_become_dnc_hashes() {
    let none = lead(v2("dnc"));
    assert!(none.dnc_keys().is_empty());
    let v = with(
        with(
            with(v2("dnc"), &["emailOptOut"], json!(true)),
            &["waOptOut"],
            json!(true),
        ),
        &["whatsapp"],
        json!("0500 000 00 02"),
    );
    let keys = lead(v).dnc_keys();
    assert!(keys.contains(&Key {
        kind: KeyKind::Email,
        value: "kafe@example.invalid".into()
    }));
    // A phone opt-out lists every number the lead holds.
    assert!(keys.contains(&Key {
        kind: KeyKind::Phone,
        value: "+905000000001".into()
    }));
    assert!(keys.contains(&Key {
        kind: KeyKind::Phone,
        value: "+905000000002".into()
    }));
    assert!(keys.iter().all(|k| k.kind.hard()));
    let sms_only = lead(with(v2("dnc"), &["smsOptOut"], json!(true))).dnc_keys();
    assert_eq!(
        sms_only,
        vec![Key {
            kind: KeyKind::Phone,
            value: "+905000000001".into()
        }]
    );
}

#[test]
fn bounced_email_is_undeliverable() {
    let ws = WorkspaceId::new_v7();
    let fine = pool_record(ws, &lead(v2("mail")), NOW).unwrap();
    assert!(fine.prospect.contact.email.unwrap().deliverable);
    let v = with(
        v2("mail"),
        &["emailBouncedAt"],
        json!("2026-01-01T00:00:00Z"),
    );
    let bounced = pool_record(ws, &lead(v), NOW).unwrap();
    let email = bounced.prospect.contact.email.unwrap();
    assert!(!email.deliverable);
    assert_eq!(email.value, "kafe@example.invalid");
}

#[test]
fn activities_become_notes_except_status_change() {
    let v = with(
        v2("act"),
        &["activities"],
        json!([
            {"id": "a1", "type": "CALL", "title": "İlk arama", "description": "Sentetik açıklama",
             "outcome": "NO_ANSWER", "createdAt": "2026-01-02T08:00:00Z"},
            {"id": "a2", "type": "STATUS_CHANGE", "title": "NEW → CONTACTED", "description": null,
             "outcome": null, "createdAt": "2026-01-02T08:01:00Z"},
            {"id": "a3", "type": "NOTE", "title": "Not", "description": null,
             "outcome": null, "createdAt": "2026-01-03T08:00:00Z"}
        ]),
    );
    let notes = lead(v).activity_notes().unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0].activity_id, "a1");
    assert_eq!(
        notes[0].text,
        "v1 CALL · NO_ANSWER · İlk arama\nSentetik açıklama"
    );
    assert_eq!(notes[0].at, datetime!(2026-01-02 08:00 UTC));
    assert_eq!(notes[1].activity_id, "a3");
    assert_eq!(notes[1].text, "v1 NOTE · Not");
}

#[test]
fn offers_become_one_note_without_quotes() {
    assert!(lead(v2("offer")).offers_note().is_none());
    let v = with(
        v2("offer"),
        &["offers"],
        json!([
            {"id": "o1", "status": "SENT", "planName": "Başlangıç", "price": 1500, "currency": "TRY",
             "validUntil": "2026-02-01T00:00:00Z", "createdAt": "2026-01-10T00:00:00Z"},
            {"id": "o2", "status": "REJECTED", "planName": null, "price": 999.5, "currency": "TRY",
             "validUntil": null, "createdAt": "2026-01-20T00:00:00Z"}
        ]),
    );
    let text = lead(v).offers_note().unwrap();
    assert!(text.starts_with("v1 teklifleri\n"));
    assert_eq!(text.lines().count(), 3);
    assert!(text.contains("SENT · Başlangıç · 1500 TRY"));
    assert!(text.contains("REJECTED · 999.5 TRY"));
}

#[test]
fn owner_mapped_by_email_or_left_for_backfill() {
    let rep = UserId::new_v7();
    let members = HashMap::from([("rep@example.invalid".to_owned(), rep)]);
    assert_eq!(owner_of(&lead(v2("own")), &members), Owner::Mapped(rep));
    let gone = with(v2("own"), &["ownerEmail"], json!("left@example.invalid"));
    assert_eq!(owner_of(&lead(gone), &members), Owner::Unmapped);
    let none = with(v2("own"), &["ownerEmail"], Value::Null);
    assert_eq!(owner_of(&lead(none), &members), Owner::None);
}

#[test]
fn old_export_without_new_fields_still_imports_to_inbox() {
    // Format 1 (today's `scripts/v1-export-leads.sql`): no format, contact or research fields.
    // Without contact evidence nothing proves the lead was never contacted: the inbox.
    let mut v = v2("old");
    for key in [
        "format",
        "deletedAt",
        "mergedIntoId",
        "contact",
        "activities",
        "offers",
        "tags",
        "attribution",
        "research",
        "aiScore",
        "aiScoreReason",
        "scoredAt",
        "ownerEmail",
        "emailVerifiedStatus",
    ] {
        v.as_object_mut().unwrap().remove(key);
    }
    let old = lead(v);
    assert_eq!(route(&old), Route::Inbox);
    assert!(old.activity_notes().unwrap().is_empty());
    assert!(old.offers_note().is_none());
    // An unknown format is refused before any write.
    let future: Lead = serde_json::from_value(with(v2("new"), &["format"], json!(3))).unwrap();
    assert!(future.validate().is_err());
    // The allowlist still refuses unknown fields, nested ones too.
    assert!(serde_json::from_value::<Lead>(with(v2("x"), &["accessToken"], json!("t"))).is_err());
    assert!(
        serde_json::from_value::<Lead>(with(v2("x"), &["contact", "secret"], json!(1))).is_err()
    );
}

#[test]
fn imported_values_out_of_bounds_are_refused_before_the_write() {
    let ws = WorkspaceId::new_v7();
    // A business name the pool cannot hold: no record (counted `pool_invalid`).
    let long = with(v2("long"), &["businessName"], json!("x".repeat(201)));
    assert!(pool_record(ws, &lead(long), NOW).is_none());
    let empty = with(v2("empty"), &["businessName"], json!("  "));
    assert!(pool_record(ws, &lead(empty), NOW).is_none());
    // A name and city key over 400 characters (`prospect_keys.value`) is refused, not cut.
    let wide = with(
        with(v2("wide"), &["businessName"], json!("ğ".repeat(200))),
        &["city"],
        json!("ş".repeat(80)),
    );
    let keyed = pool_record(ws, &lead(wide), NOW);
    assert!(
        keyed
            .as_ref()
            .is_none_or(|r| r.keys.iter().all(|k| k.value.chars().count() <= 400))
    );
    // A malformed phone or email is left out; the record stays.
    let bad = with(
        with(v2("bad"), &["phone"], json!("abc")),
        &["email"],
        json!("no-at"),
    );
    let record = pool_record(ws, &lead(bad), NOW).unwrap();
    assert!(record.prospect.contact.phone.is_none());
    assert!(record.prospect.contact.email.is_none());
    // A v1 score outside 0..=100 is no score.
    let odd = with(v2("odd"), &["aiScore"], json!(130));
    assert!(pool_record(ws, &lead(odd), NOW).unwrap().score.is_none());
}

#[test]
fn report_holds_counts_only() {
    let report = Report {
        total: 3,
        to_pool: 1,
        ..Report::default()
    };
    let v = serde_json::to_value(report).unwrap();
    let fields = v.as_object().unwrap();
    assert!(fields.len() >= 25);
    assert!(fields.values().all(Value::is_u64));
}

#[test]
fn dry_run_writes_nothing_and_reports_counts() {
    // The dry run's database behaviour is jt_pg's test of the same name; here: a dry run's
    // report is the same shape as an import's (counts only, every counter of spec §10).
    let v = serde_json::to_value(Report::default()).unwrap();
    for key in [
        "to_inbox",
        "to_pool",
        "skipped_deleted",
        "skipped_merged",
        "pool_duplicates",
        "pool_in_inbox",
        "pool_dnc",
        "owners_mapped",
        "owners_unmapped",
        "activities_as_notes",
        "offers_as_notes",
        "prospects_rolled_back",
        "prospects_kept",
    ] {
        assert!(v.get(key).is_some_and(Value::is_u64), "{key}");
    }
}
