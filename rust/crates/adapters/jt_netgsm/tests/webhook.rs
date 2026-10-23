//! NetGSM's callback bodies, parsed into inbound events, from fixtures per family: incoming SMS
//! (an object, an array, `{messages}`, `{data}`, a form), Netsantral call events, İYS consent
//! changes, voice and auto-call reports, and malformed input (never a panic).

mod support;

use jt_connector::{EventKind, NetgsmPurpose};
use jt_netgsm::webhook::{MAX_ITEMS, MAX_MO_ROWS, ParseError, parse};
use serde_json::{Value, json};
use support::fixture_text;
use time::macros::datetime;

fn hook(name: &str) -> Vec<u8> {
    fixture_text(&format!("hooks/{name}")).into_bytes()
}

fn ids(purpose: NetgsmPurpose, name: &str) -> Vec<String> {
    parse(purpose, &hook(name))
        .unwrap()
        .into_iter()
        .map(|d| d.external_id)
        .collect()
}

#[test]
fn an_incoming_sms_object_is_one_message() {
    let drafts = parse(NetgsmPurpose::Mo, &hook("mo_object.json")).unwrap();
    assert_eq!(drafts.len(), 1);
    let mo = &drafts[0];
    assert_eq!(mo.external_id, "netgsm-mo:990000001");
    assert_eq!(mo.kind, EventKind::Message);
    assert_eq!(mo.payload["from"], "+905000000031");
    assert_eq!(mo.payload["text"], "Merhaba, randevu almak istiyorum");
    assert_eq!(mo.payload["row"]["aboneno"], "8500000001");
    // 10:15 in Türkiye is 07:15 UTC.
    assert_eq!(mo.occurred_at, Some(datetime!(2026-10-23 07:15 UTC)));
}

#[test]
fn incoming_sms_arrive_as_arrays_and_wrapped_lists() {
    let drafts = parse(NetgsmPurpose::Mo, &hook("mo_array.json")).unwrap();
    // The row without a sender is left out.
    assert_eq!(
        drafts
            .iter()
            .map(|d| d.external_id.as_str())
            .collect::<Vec<_>>(),
        ["netgsm-mo:990000002", "netgsm-mo:990000003"]
    );
    assert_eq!(drafts[0].occurred_at, Some(datetime!(2026-10-23 07:16 UTC)));
    assert_eq!(drafts[1].payload["from"], "+905000000033");
    assert_eq!(drafts[1].payload["text"], "İkinci");
    assert_eq!(
        ids(NetgsmPurpose::Mo, "mo_messages.json"),
        ["netgsm-mo:990000006"]
    );
    assert_eq!(
        ids(NetgsmPurpose::Mo, "mo_data.json"),
        ["netgsm-mo:990000007"]
    );
}

#[test]
fn an_incoming_sms_may_be_a_form() {
    let drafts = parse(NetgsmPurpose::Mo, &hook("mo_form.txt")).unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].external_id, "netgsm-mo:990000004");
    assert_eq!(drafts[0].payload["text"], "Selam dünya");
    assert_eq!(drafts[0].payload["from"], "+905000000034");
    assert_eq!(drafts[0].occurred_at, Some(datetime!(2026-10-23 07:30 UTC)));
}

#[test]
fn a_long_numeric_id_keeps_every_digit() {
    assert_eq!(
        ids(NetgsmPurpose::Mo, "mo_long_gorevid.txt"),
        ["netgsm-mo:123456789012345678901234567"]
    );
}

#[test]
fn incoming_sms_are_capped_at_a_hundred_per_body() {
    let rows: Vec<Value> = (0..150)
        .map(|i| json!({ "mesaj": "x", "ceptel": "905000000099", "gorevid": format!("g{i}") }))
        .collect();
    let body = serde_json::to_vec(&rows).unwrap();
    let drafts = parse(NetgsmPurpose::Mo, &body).unwrap();
    assert_eq!(drafts.len(), MAX_MO_ROWS);
    assert_eq!(MAX_MO_ROWS, 100);
    assert_eq!(drafts[99].external_id, "netgsm-mo:g99");
}

#[test]
fn every_family_but_consent_is_capped_per_body() {
    let events: Vec<Value> = (0..MAX_ITEMS + 5)
        .map(|i| json!({ "scenario": "Hangup", "unique_id": format!("1700000000.{i}") }))
        .collect();
    let drafts = parse(NetgsmPurpose::Events, &serde_json::to_vec(&events).unwrap()).unwrap();
    assert_eq!(drafts.len(), MAX_ITEMS);
    let reports: Vec<Value> = (0..MAX_ITEMS + 5)
        .map(|i| json!({ "relationid": format!("rel-{i}"), "durum": "1" }))
        .collect();
    let body = serde_json::to_vec(&reports).unwrap();
    assert_eq!(
        parse(NetgsmPurpose::VoiceReport, &body).unwrap().len(),
        MAX_ITEMS
    );
    // A consent change is never dropped.
    let changes: Vec<Value> = (0..MAX_ITEMS + 5)
        .map(|i| {
            json!({ "transactionid": format!("tx-{i}"), "recipient": "+905000000061",
                    "type": "MESAJ", "status": "RET" })
        })
        .collect();
    let body = serde_json::to_vec(&changes).unwrap();
    assert_eq!(
        parse(NetgsmPurpose::Iys, &body).unwrap().len(),
        MAX_ITEMS + 5
    );
}

#[test]
fn a_message_without_an_id_gets_a_stable_digest() {
    let body = br#"{"mesaj":"Kimliksiz","ceptel":"905000000038","tarih":"23.10.2026 11:00"}"#;
    let first = parse(NetgsmPurpose::Mo, body).unwrap();
    let again = parse(NetgsmPurpose::Mo, body).unwrap();
    assert_eq!(first, again);
    let id = &first[0].external_id;
    assert!(id.starts_with("netgsm-mo-digest:"), "{id}");
    assert_eq!(id.len(), "netgsm-mo-digest:".len() + 64, "{id}");
}

#[test]
fn call_events_are_one_per_call_and_scenario() {
    let drafts = parse(NetgsmPurpose::Events, &hook("events.json")).unwrap();
    // The unknown scenario is left out; the `sip<n>-` prefix of a unique id is dropped.
    assert_eq!(
        drafts
            .iter()
            .map(|d| d.external_id.as_str())
            .collect::<Vec<_>>(),
        [
            "netgsm-call:1700000000.201:inbound_call",
            "netgsm-call:1700000000.201:answer",
            "netgsm-call:1700000000.201:hangup",
            "netgsm-call:1700000000.201:cdr",
        ]
    );
    assert!(drafts.iter().all(|d| d.kind == EventKind::CallEvent));
    assert_eq!(drafts[0].payload["scenario"], "inbound_call");
    assert_eq!(drafts[0].payload["unique_id"], "1700000000.201");
    assert_eq!(drafts[0].payload["customer_num"], "905000000051");
    assert_eq!(drafts[0].payload["internal_num"], "101");
    assert_eq!(drafts[0].payload["direction"], "inbound");
    assert_eq!(drafts[2].payload["crm_id"], "crm-synthetic-1");
    assert_eq!(drafts[2].payload["status"], "ANSWER");
    assert_eq!(drafts[2].payload["duration_sec"], 37);
    assert_eq!(drafts[3].payload["duration_sec"], 37);
    assert_eq!(drafts[3].payload["direction"], "outbound");
    assert_eq!(drafts[3].payload["raw"]["durum"], "cdr");
    // Recording links lose the provider's token (query, fragment, user and password), in the
    // normalised field and in the raw copy alike; their path stays.
    let link = "https://dosya.example.invalid/kayit/1700000000.201.wav";
    assert_eq!(drafts[2].payload["recording"], link);
    assert_eq!(drafts[2].payload["raw"]["seskaydi"], link);
    assert_eq!(
        drafts[2].payload["raw"]["caller_record"],
        "https://dosya.example.invalid/caller.wav"
    );
    assert_eq!(drafts[3].payload["raw"]["recording_url"], link);
    for draft in &drafts {
        let text = draft.payload.to_string();
        assert!(!text.contains("SECRET"), "{text}");
    }
    // A lone object is one event.
    let one = br#"{"scenario":"Hangup","unique_id":"1700000000.300"}"#;
    assert_eq!(
        parse(NetgsmPurpose::Events, one).unwrap()[0].external_id,
        "netgsm-call:1700000000.300:hangup"
    );
}

#[test]
fn consent_changes_are_strict_about_status_and_channel() {
    let drafts = parse(NetgsmPurpose::Iys, &hook("iys.json")).unwrap();
    // `BELKI`, `FAKS`, and `onay` / `mesaj` in the wrong case are never read as consent.
    assert_eq!(drafts.len(), 3, "{drafts:#?}");
    assert!(drafts.iter().all(|d| d.kind == EventKind::Consent));
    assert_eq!(drafts[0].external_id, "netgsm-iys:tx-1");
    assert_eq!(drafts[0].payload["recipient"], "+905000000061");
    assert_eq!(drafts[0].payload["channel"], "MESAJ");
    assert_eq!(drafts[0].payload["granted"], true);
    assert_eq!(drafts[0].payload["source"], "HS_WEB");
    assert_eq!(drafts[0].occurred_at, Some(datetime!(2026-10-23 07:00 UTC)));
    assert_eq!(drafts[1].external_id, "netgsm-iys:sub-2");
    assert_eq!(drafts[1].payload["channel"], "ARAMA");
    assert_eq!(drafts[1].payload["granted"], false);
    assert!(
        drafts[2].external_id.starts_with("netgsm-iys:digest-"),
        "{}",
        drafts[2].external_id
    );
    assert_eq!(drafts[2].payload["channel"], "EPOSTA");
}

#[test]
fn voice_and_autocall_reports_are_statuses() {
    let voice = parse(NetgsmPurpose::VoiceReport, &hook("voice_report.json")).unwrap();
    // The report without a relation id is left out.
    assert_eq!(voice.len(), 1);
    assert_eq!(voice[0].external_id, "netgsm-voice:rel-1:1");
    assert_eq!(voice[0].kind, EventKind::Status);
    assert_eq!(voice[0].payload["relation_id"], "rel-1");
    assert_eq!(voice[0].payload["duration_sec"], 12);
    assert_eq!(
        voice[0].payload["record_link"],
        "https://sesdosya.example.invalid/rapor/rel-1.mp3"
    );
    assert!(!voice[0].payload.to_string().contains("SECRET"));
    assert_eq!(voice[0].payload["push_button"], "1");
    let autocall = parse(NetgsmPurpose::AutocallReport, &hook("autocall_report.json")).unwrap();
    assert_eq!(autocall.len(), 1);
    assert_eq!(
        autocall[0].external_id,
        "netgsm-autocall:770001:1700000000.55"
    );
    assert_eq!(autocall[0].kind, EventKind::Status);
    assert_eq!(autocall[0].payload["called"], "905000000041");
    assert_eq!(autocall[0].payload["status"], "ANSWERED");
}

#[test]
fn malformed_bodies_never_panic() {
    let deep = format!("{}{}", "[".repeat(5_000), "]".repeat(5_000));
    let bodies: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"   ".to_vec(),
        b"not json at all".to_vec(),
        b"{".to_vec(),
        b"[1, \"x\", null, true]".to_vec(),
        b"42".to_vec(),
        b"\"text\"".to_vec(),
        b"null".to_vec(),
        b"{\"mesaj\": {\"nested\": [1,2]}, \"ceptel\": [\"x\"]}".to_vec(),
        b"=&==&".to_vec(),
        vec![0xff, 0xfe, 0x00, 0x7b],
        deep.into_bytes(),
        b"{\"gorevid\": 1e400, \"ceptel\": \"905000000001\"}".to_vec(),
        b"[{\"scenario\": 7, \"unique_id\": {}}]".to_vec(),
        b"[{\"status\": [], \"type\": null}]".to_vec(),
        b"{\"relationid\": -1, \"durum\": 1.5}".to_vec(),
    ];
    for purpose in NetgsmPurpose::all() {
        for body in &bodies {
            // Any answer is fine, as long as it is an answer.
            let _ = parse(*purpose, body);
        }
    }
    assert_eq!(parse(NetgsmPurpose::Mo, b""), Err(ParseError::Unreadable));
    assert_eq!(
        parse(NetgsmPurpose::Mo, b"not json at all"),
        Err(ParseError::Unreadable)
    );
    assert_eq!(
        parse(NetgsmPurpose::Events, b"42"),
        Err(ParseError::NotRows)
    );
    assert_eq!(
        parse(NetgsmPurpose::Iys, b"[1, \"x\", null, true]"),
        Ok(vec![])
    );
}
