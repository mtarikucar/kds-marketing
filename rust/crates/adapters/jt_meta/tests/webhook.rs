//! Webhook bodies: one fixture per payload family, routing keys, dedupe ids, and the signature
//! check that comes before any parsing.

mod support;

use hmac::{Hmac, KeyInit, Mac};
use jt_connector::EventKind;
use jt_meta::webhook::{KIND_HINT_INSTAGRAM, KIND_HINT_PAGE, KIND_HINT_WHATSAPP};
use jt_meta::{
    Origin, ParseError, ParsedEvent, WebhookError, parse, scoped_body, verify_and_parse,
};
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::BTreeSet;
use support::fixture_text;
use time::OffsetDateTime;

fn parsed(name: &str) -> Vec<ParsedEvent> {
    parse(fixture_text(name).as_bytes()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// `(account, hint, external_id, kind)` of each event.
fn keys(events: &[ParsedEvent]) -> Vec<(String, &'static str, String, EventKind)> {
    events
        .iter()
        .map(|e| {
            (
                e.external_account_id.clone(),
                e.kind_hint,
                e.event.external_id.clone(),
                e.event.kind.clone(),
            )
        })
        .collect()
}

fn at(seconds: i64) -> Option<OffsetDateTime> {
    Some(OffsetDateTime::from_unix_timestamp(seconds).unwrap())
}

fn signature(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let hex: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256={hex}")
}

#[test]
fn whatsapp_messages_route_by_number_and_keep_the_wamid() {
    let events = parsed("whatsapp_messages.json");
    let w = |account: &str, id: &str| {
        (
            account.to_owned(),
            KIND_HINT_WHATSAPP,
            id.to_owned(),
            EventKind::Message,
        )
    };
    // Text, button, interactive and a click-to-WhatsApp referral; one entry batching two
    // numbers; the message without an id and the template change are left out.
    assert_eq!(
        keys(&events),
        vec![
            w("5555555555", "wamid.TEST-TEXT-1"),
            w("5555555555", "wamid.TEST-BUTTON-1"),
            w("5555555555", "wamid.TEST-INTERACTIVE-1"),
            w("5555555555", "wamid.TEST-REFERRAL-1"),
            w("5555555556", "wamid.TEST-OTHER-NUMBER-1"),
        ]
    );
    let text = &events[0].event;
    assert_eq!(
        text.payload["message"]["text"]["body"],
        "Merhaba, açık mısınız?"
    );
    assert_eq!(text.payload["contact"]["profile"]["name"], "Test Kişi");
    assert_eq!(text.occurred_at, at(1_790_000_000));
    // Each message carries its own sender's contact.
    assert_eq!(
        events[1].event.payload["contact"]["profile"]["name"],
        "Test Başka"
    );
    assert_eq!(
        events[1].event.payload["message"]["button"]["payload"],
        "EVET"
    );
    assert_eq!(
        events[2].event.payload["message"]["interactive"]["button_reply"]["id"],
        "menu-1"
    );
    assert_eq!(
        events[3].event.payload["message"]["referral"]["ctwa_clid"],
        "TESTCLID"
    );
}

#[test]
fn whatsapp_statuses_are_one_event_per_state() {
    let events = parsed("whatsapp_statuses.json");
    let s = |id: &str| {
        (
            "5555555555".to_owned(),
            KIND_HINT_WHATSAPP,
            id.to_owned(),
            EventKind::Status,
        )
    };
    assert_eq!(
        keys(&events),
        vec![
            s("wamid.TEST-SENT-1:sent"),
            s("wamid.TEST-SENT-1:delivered"),
            s("wamid.TEST-SENT-1:read"),
            s("wamid.TEST-SENT-2:failed"),
        ]
    );
    assert_eq!(
        events[3].event.payload["status"]["errors"][0]["code"],
        131_026
    );
    assert_eq!(events[1].event.occurred_at, at(1_790_000_011));
}

#[test]
fn messenger_messages_echoes_postbacks_and_deliveries() {
    let events = parsed("messenger_messaging.json");
    let p =
        |id: &str, kind: EventKind| ("1234567890".to_owned(), KIND_HINT_PAGE, id.to_owned(), kind);
    // Read watermarks and reactions are left out.
    assert_eq!(
        keys(&events),
        vec![
            p("m_TEST-MESSAGE-1", EventKind::Message),
            p("m_TEST-ECHO-1", EventKind::MessageEcho),
            p("m_TEST-POSTBACK-1", EventKind::Message),
            p(
                "postback:2000000000000002:1790000022500",
                EventKind::Message
            ),
            p("m_TEST-ECHO-1:delivered", EventKind::Status),
            p("m_TEST-ECHO-0:delivered", EventKind::Status),
        ]
    );
    let first = &events[0].event;
    assert_eq!(first.payload["messaging"]["message"]["text"], "Merhaba");
    assert_eq!(
        first.payload["messaging"]["sender"]["id"],
        "2000000000000001"
    );
    assert_eq!(
        first.occurred_at,
        Some(OffsetDateTime::from_unix_timestamp_nanos(1_790_000_020_123_000_000).unwrap())
    );
    // A delivery is one small event per message, not a copy of the whole item per mid.
    assert_eq!(
        events[4].event.payload,
        json!({
            "mid": "m_TEST-ECHO-1",
            "watermark": 1_790_000_022_900_i64,
            "sender": { "id": "2000000000000001" },
            "recipient": { "id": "1234567890" },
        })
    );
    assert_eq!(events[5].event.payload["mid"], "m_TEST-ECHO-0");
}

#[test]
fn instagram_messages_route_by_the_instagram_account() {
    let events = parsed("instagram_messaging.json");
    assert_eq!(
        keys(&events),
        vec![
            (
                "17841400000000001".to_owned(),
                KIND_HINT_INSTAGRAM,
                "aWdfZAG1faXRlbTpURVNULUlHLTE=".to_owned(),
                EventKind::Message,
            ),
            (
                "17841400000000001".to_owned(),
                KIND_HINT_INSTAGRAM,
                "aWdfZAG1faXRlbTpURVNULUlHLTI=".to_owned(),
                EventKind::MessageEcho,
            ),
        ]
    );
}

#[test]
fn leadgen_changes_name_the_submission() {
    let events = parsed("page_leadgen.json");
    assert_eq!(
        keys(&events),
        vec![(
            "1234567890".to_owned(),
            KIND_HINT_PAGE,
            "leadgen:6666666666".to_owned(),
            EventKind::LeadGen,
        )]
    );
    let lead = &events[0].event;
    assert_eq!(lead.payload["leadgen"]["leadgen_id"], "6666666666");
    assert_eq!(lead.payload["leadgen"]["form_id"], "7777777777");
    assert_eq!(lead.occurred_at, at(1_790_000_040));
}

#[test]
fn bodies_that_are_not_webhooks_are_refused() {
    assert_eq!(parse(b"<html>").unwrap_err(), ParseError::NotJson);
    assert_eq!(parse(b"{}").unwrap_err(), ParseError::NoObject);
    assert_eq!(
        parse(br#"{"object":"page"}"#).unwrap_err(),
        ParseError::NoEntries
    );
    let long = "u".repeat(500);
    match parse(
        json!({ "object": long, "entry": [] })
            .to_string()
            .as_bytes(),
    ) {
        Err(ParseError::UnknownObject(name)) => assert_eq!(name.len(), 64),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        parse(br#"{"object":"user","entry":[]}"#).unwrap_err(),
        ParseError::UnknownObject("user".into())
    );
    // A known object with nothing in it is no event.
    assert!(
        parse(br#"{"object":"page","entry":[{"id":"1"}]}"#)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn webhook_signature_mismatch_is_rejected() {
    let body = fixture_text("messenger_messaging.json");
    let raw = body.as_bytes();
    let good = signature("app-secret", raw);
    assert_eq!(
        verify_and_parse(b"app-secret", raw, &good).unwrap().len(),
        6
    );

    // Another secret, a changed body, a malformed header, an empty secret: refused before
    // parsing (even a body that does not parse is refused for its signature).
    assert_eq!(
        verify_and_parse(b"other-secret", raw, &good).unwrap_err(),
        WebhookError::BadSignature
    );
    let mut tampered = raw.to_vec();
    tampered[10] ^= 1;
    assert_eq!(
        verify_and_parse(b"app-secret", &tampered, &good).unwrap_err(),
        WebhookError::BadSignature
    );
    for header in ["", "sha256=", "sha1=abc", &good.to_uppercase(), &good[7..]] {
        assert_eq!(
            verify_and_parse(b"app-secret", raw, header).unwrap_err(),
            WebhookError::BadSignature,
            "{header}"
        );
    }
    assert_eq!(
        verify_and_parse(b"", raw, &signature("", raw)).unwrap_err(),
        WebhookError::BadSignature
    );
    let junk = b"not json";
    assert_eq!(
        verify_and_parse(b"app-secret", junk, &signature("app-secret", junk)).unwrap_err(),
        WebhookError::Parse(ParseError::NotJson)
    );
}

/// The kinds a hint routes to: the capabilities that may hold its account, all Meta kinds; an
/// unknown hint names none.
#[test]
fn each_hint_names_the_kinds_that_may_hold_its_account() {
    use jt_connector::{Provider, provider_for_kind};
    use jt_meta::webhook::kinds_of_hint;

    assert_eq!(kinds_of_hint(KIND_HINT_WHATSAPP), ["whatsapp_cloud"]);
    assert_eq!(
        kinds_of_hint(KIND_HINT_PAGE),
        ["facebook_page", "messenger"]
    );
    assert_eq!(
        kinds_of_hint(KIND_HINT_INSTAGRAM),
        ["instagram", "instagram_dm"]
    );
    assert!(kinds_of_hint("ads").is_empty());
    for hint in [KIND_HINT_WHATSAPP, KIND_HINT_PAGE, KIND_HINT_INSTAGRAM] {
        for kind in kinds_of_hint(hint) {
            assert_eq!(provider_for_kind(kind), Some(Provider::Meta), "{kind}");
        }
    }
    // Every event of every fixture names a hint that routes somewhere.
    for name in [
        "whatsapp_messages.json",
        "whatsapp_statuses.json",
        "messenger_messaging.json",
        "instagram_messaging.json",
        "page_leadgen.json",
    ] {
        for event in parsed(name) {
            assert!(!kinds_of_hint(event.kind_hint).is_empty(), "{name}");
        }
    }
}

/// Each event names where in the body it came from: its entry, and for WhatsApp its change.
/// What one workspace keeps is cut along these: its entries whole, of a WhatsApp entry only its
/// changes; the body as received only when that is all of it; nothing when it names nothing.
#[test]
fn a_scoped_body_keeps_only_the_items_its_events_came_from() {
    let change = |number: &str, wamid: &str, from: &str| {
        json!({
            "field": "messages",
            "value": {
                "messaging_product": "whatsapp",
                "metadata": { "phone_number_id": number },
                "messages": [{ "from": from, "id": wamid, "timestamp": "1790000000",
                               "type": "text", "text": { "body": "selam" } }],
            },
        })
    };
    let a = change("NUMBER-A", "wamid.A", "905551111111");
    let b = change("NUMBER-B", "wamid.B", "905552222222");
    let other = json!({ "field": "account_update", "value": { "event": "VERIFIED" } });
    let body = json!({
        "object": "whatsapp_business_account",
        "entry": [{ "id": "WABA-1", "changes": [a.clone(), b.clone(), other] }],
    });
    let raw = serde_json::to_vec(&body).unwrap();
    let events = parse(&raw).unwrap();
    let origins: Vec<Origin> = events.iter().map(|e| e.origin).collect();
    assert_eq!(
        origins,
        [
            Origin {
                entry: 0,
                change: Some(0)
            },
            Origin {
                entry: 0,
                change: Some(1)
            }
        ]
    );
    let of = |account: &str| -> BTreeSet<Origin> {
        events
            .iter()
            .filter(|e| e.external_account_id == account)
            .map(|e| e.origin)
            .collect()
    };
    // One number's part: its change only, in its entry.
    let kept: Value = serde_json::from_slice(&scoped_body(&raw, &of("NUMBER-A")).unwrap()).unwrap();
    assert_eq!(
        kept,
        json!({
            "object": "whatsapp_business_account",
            "entry": [{ "id": "WABA-1", "changes": [a.clone()] }],
        })
    );
    let text = kept.to_string();
    for theirs in ["NUMBER-B", "wamid.B", "905552222222", "VERIFIED"] {
        assert!(!text.contains(theirs), "keeps {theirs}: {text}");
    }
    // Both numbers: still not all of it (the account update made no event).
    let both: BTreeSet<Origin> = origins.iter().copied().collect();
    let kept: Value = serde_json::from_slice(&scoped_body(&raw, &both).unwrap()).unwrap();
    assert_eq!(kept["entry"][0]["changes"], json!([a, b]));
    // All of it: as received, byte for byte.
    let all = BTreeSet::from([
        Origin {
            entry: 0,
            change: Some(0),
        },
        Origin {
            entry: 0,
            change: Some(1),
        },
        Origin {
            entry: 0,
            change: Some(2),
        },
    ]);
    assert_eq!(scoped_body(&raw, &all), Some(raw.clone()));
    let page = fixture_text("messenger_messaging.json").into_bytes();
    let whole: BTreeSet<Origin> = parse(&page).unwrap().iter().map(|e| e.origin).collect();
    assert_eq!(scoped_body(&page, &whole), Some(page.clone()));
    // Nothing named, or not a webhook body: nothing kept.
    assert_eq!(scoped_body(&raw, &BTreeSet::new()), None);
    assert_eq!(
        scoped_body(
            &raw,
            &BTreeSet::from([Origin {
                entry: 7,
                change: None
            }])
        ),
        None
    );
    assert_eq!(scoped_body(b"not json", &all), None);
}
