//! Webhook bodies: one fixture per payload family, routing keys, dedupe ids, and the signature
//! check that comes before any parsing.

mod support;

use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, PublicEnvelope, PublicKind, SubjectKind,
};
use jt_connector::EventKind;
use jt_meta::webhook::{
    KIND_HINT_INSTAGRAM, KIND_HINT_PAGE, KIND_HINT_WHATSAPP, KIND_HINT_WHATSAPP_ACCOUNT,
    comment_event_id,
};
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
        "whatsapp_business_app.json",
        "whatsapp_account_update.json",
    ] {
        for event in parsed(name) {
            assert!(!kinds_of_hint(event.kind_hint).is_empty(), "{name}");
        }
    }
    // A WhatsApp Business Account's own events name the account, not a number: they route by
    // the account a `whatsapp_cloud` capability's asset names (see the crate docs).
    assert_eq!(
        kinds_of_hint(KIND_HINT_WHATSAPP_ACCOUNT),
        ["whatsapp_cloud"]
    );
}

/// A number onboarded beside the WhatsApp Business app: what the business sends from the app
/// (`smb_message_echoes`), the history it shares (`history`: each message, each chunk's
/// progress, a refusal) and its contacts (`smb_app_state_sync`), each routed by its number. A
/// history message is keyed apart from a live message of the same `wamid`; a media item sent
/// after its placeholder, an item without its id and a non-contact state are left out.
#[test]
fn business_app_echoes_history_and_contacts_route_by_number() {
    let events = parsed("whatsapp_business_app.json");
    let w = |account: &str, id: &str, kind: EventKind| {
        (account.to_owned(), KIND_HINT_WHATSAPP, id.to_owned(), kind)
    };
    assert_eq!(
        keys(&events),
        vec![
            w("5555555555", "wamid.TEST-ECHO-1", EventKind::MessageEcho),
            w(
                "5555555555",
                "history:wamid.TEST-HIST-1",
                EventKind::History
            ),
            w(
                "5555555555",
                "history:wamid.TEST-HIST-2",
                EventKind::History
            ),
            w(
                "5555555555",
                "history:wamid.TEST-HIST-3",
                EventKind::History
            ),
            w(
                "5555555555",
                "history-chunk:5555555555:0:1",
                EventKind::History
            ),
            w(
                "5555555555",
                "contact-sync:5555555555:905553333333:add:1790000200",
                EventKind::ContactSync
            ),
            w(
                "5555555555",
                "contact-sync:5555555555:905554444444:remove:1790000201",
                EventKind::ContactSync
            ),
            w(
                "5555555556",
                "history-error:5555555556:2593109",
                EventKind::History
            ),
        ]
    );
    let echo = &events[0].event;
    assert_eq!(echo.payload["echo"]["to"], "905551111111");
    assert_eq!(
        echo.payload["echo"]["text"]["body"],
        "Siparişiniz yarın kargoda."
    );
    assert_eq!(echo.occurred_at, at(1_790_000_100));

    let inbound = &events[1].event;
    assert_eq!(inbound.payload["history_message"]["from"], "905551111111");
    assert_eq!(inbound.payload["thread"], "905551111111");
    assert_eq!(inbound.payload["business_number"], "905550000000");
    assert_eq!(inbound.occurred_at, at(1_789_900_000));
    let sent = &events[2].event;
    assert_eq!(
        sent.payload["history_message"]["text"]["body"],
        "Evet, 450 TL."
    );
    assert_eq!(sent.payload["thread"], "905551111111");
    let placeholder = &events[3].event;
    assert_eq!(
        placeholder.payload["history_message"]["type"],
        "media_placeholder"
    );
    assert_eq!(placeholder.payload["thread"], "905552222222");

    let chunk = &events[4].event;
    assert_eq!(
        chunk.payload["history_chunk"],
        json!({ "phase": 0, "chunk_order": 1, "progress": 55 })
    );
    assert_eq!(chunk.payload["messages"], 3);
    assert_eq!(chunk.occurred_at, None);

    let added = &events[5].event;
    assert_eq!(
        added.payload["state_sync"]["contact"]["full_name"],
        "Ayşe Yılmaz"
    );
    assert_eq!(added.occurred_at, at(1_790_000_200));
    assert_eq!(events[6].event.payload["state_sync"]["action"], "remove");

    let declined = &events[7].event;
    assert_eq!(declined.payload["history_error"]["code"], 2_593_109);
    // Every event of one change shares its origin; the media item made none.
    assert_eq!(
        events[0].origin,
        Origin {
            entry: 0,
            change: Some(0)
        }
    );
    assert!(events[1..5].iter().all(|e| e.origin
        == Origin {
            entry: 0,
            change: Some(1)
        }));
    assert!(events[5..7].iter().all(|e| e.origin
        == Origin {
            entry: 0,
            change: Some(3)
        }));
    assert_eq!(
        events[7].origin,
        Origin {
            entry: 1,
            change: Some(0)
        }
    );
}

/// `account_update` names the WhatsApp Business Account (`waba_info.waba_id`, else the entry's
/// id), never a number; each event is keyed by the account, the event and the entry's time. A
/// change naming no event is left out.
#[test]
fn account_updates_route_by_the_business_account() {
    let events = parsed("whatsapp_account_update.json");
    let a = |account: &str, id: &str| {
        (
            account.to_owned(),
            KIND_HINT_WHATSAPP_ACCOUNT,
            id.to_owned(),
            EventKind::AccountUpdate,
        )
    };
    assert_eq!(
        keys(&events),
        vec![
            a(
                "4444444444",
                "account-update:4444444444:PARTNER_REMOVED:1790000300"
            ),
            a(
                "4444444446",
                "account-update:4444444446:ACCOUNT_OFFBOARDED:1790000301"
            ),
            a(
                "4444444446",
                "account-update:4444444446:ACCOUNT_RECONNECTED:1790000301"
            ),
        ]
    );
    let removed = &events[0].event;
    assert_eq!(
        removed.payload["account_update"]["disconnection_info"]["reason"],
        "ACCOUNT_DISCONNECTED"
    );
    assert_eq!(removed.occurred_at, at(1_790_000_300));
    assert_eq!(
        events[1].origin,
        Origin {
            entry: 1,
            change: Some(0)
        }
    );
    assert_eq!(
        events[2].origin,
        Origin {
            entry: 1,
            change: Some(1)
        }
    );
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
    let other = json!({
        "field": "message_template_status_update",
        "value": { "event": "VERIFIED" },
    });
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

// ---------------------------------------------------------------------------------------------
// Comments (plan 2026-10-30-inbox-comments-marketplace-plan.md, task M1; spec §8.1)
// ---------------------------------------------------------------------------------------------

/// The envelope of event `external_id` of `events`.
fn envelope(events: &[ParsedEvent], external_id: &str) -> PublicEnvelope {
    let event = events
        .iter()
        .find(|e| e.event.external_id == external_id)
        .unwrap_or_else(|| panic!("no event {external_id} in {:?}", keys(events)));
    assert_eq!(event.event.kind, EventKind::Comment);
    PublicEnvelope::from_payload(&event.event.payload).expect("a public envelope")
}

#[test]
fn feed_comment_add_is_a_comment_event() {
    let events = parsed("comments/page_feed_comments.json");
    let first = events
        .iter()
        .find(|e| e.event.external_id == "comment:111_901:open")
        .unwrap();
    assert_eq!(first.external_account_id, "1234567890");
    assert_eq!(first.kind_hint, KIND_HINT_PAGE);
    // Entry-level, as a lead: the whole entry is the Page's.
    assert_eq!(
        first.origin,
        Origin {
            entry: 0,
            change: None
        }
    );
    assert_eq!(first.event.occurred_at, at(1_790_000_100));
    // The provider's item rides along as sent.
    assert_eq!(
        first.event.payload["provider_item"]["comment_id"],
        "111_901"
    );
    let env = envelope(&events, "comment:111_901:open");
    assert_eq!(env.kind, PublicKind::Comment);
    assert_eq!(env.account_id, "1234567890");
    assert_eq!(env.external_id, "111_901");
    assert_eq!(env.parent_external_id, None);
    assert_eq!(env.root_external_id, "111_901");
    assert_eq!(env.status, EnvelopeStatus::Open);
    assert_eq!(env.author.id.as_deref(), Some("5550001"));
    assert_eq!(env.author.name.as_deref(), Some("Örnek Müşteri"));
    assert!(!env.author.is_self);
    assert_eq!(env.text, "Fiyatı nedir?");
    assert_eq!(env.created_at, at(1_790_000_100).unwrap());
    assert!(!env.live);
    let subject = env.subject.unwrap();
    assert_eq!(subject.kind, SubjectKind::Post);
    assert_eq!(subject.external_id, "1234567890_111");
    assert_eq!(
        subject.url.as_deref(),
        Some("https://www.facebook.example/1234567890/posts/111")
    );
}

#[test]
fn feed_comment_edit_and_remove() {
    let events = parsed("comments/page_feed_comments.json");
    // An edit is keyed by the entry's time: each revision is an event of its own.
    let edited = envelope(&events, "comment:111_901:edited:1790000300");
    assert_eq!(edited.status, EnvelopeStatus::Edited);
    assert_eq!(edited.text, "Fiyatı ve kargosu nedir?");
    assert_eq!(edited.created_at, at(1_790_000_100).unwrap());
    let removed = envelope(&events, "comment:111_903:removed");
    assert_eq!(removed.status, EnvelopeStatus::Removed);
    assert_eq!(removed.text, "");
}

#[test]
fn feed_reply_has_parent_and_root() {
    let events = parsed("comments/page_feed_comments.json");
    let reply = envelope(&events, "comment:111_902:open");
    assert_eq!(reply.parent_external_id.as_deref(), Some("111_901"));
    assert_eq!(reply.root_external_id, "111_901");
}

#[test]
fn own_comment_is_self() {
    let page = parsed("comments/page_feed_comments.json");
    assert!(envelope(&page, "comment:111_902:open").author.is_self);
    let ig = parsed("comments/instagram_comments.json");
    assert!(
        envelope(&ig, "comment:18000000000000002:open")
            .author
            .is_self
    );
    assert!(
        !envelope(&ig, "comment:18000000000000001:open")
            .author
            .is_self
    );
}

#[test]
fn feed_comment_without_from_has_no_author_id() {
    let events = parsed("comments/page_feed_comments.json");
    let env = envelope(&events, "comment:111_904:open");
    assert_eq!(env.author, EnvelopeAuthor::default());
    assert_eq!(env.text, "Merhaba");
}

#[test]
fn feed_posts_reactions_and_visitor_posts_are_left_out() {
    // A post, a visitor's post, a reaction, a share, a hidden comment, a comment without its id.
    assert_eq!(keys(&parsed("comments/page_feed_other.json")), vec![]);
    // A lead beside a status update: only the lead.
    assert_eq!(parsed("page_leadgen.json").len(), 1);
}

#[test]
fn ig_comment_and_reply() {
    let events = parsed("comments/instagram_comments.json");
    let w = |id: &str| {
        (
            "17841400000000001".to_owned(),
            KIND_HINT_INSTAGRAM,
            format!("comment:{id}:open"),
            EventKind::Comment,
        )
    };
    // `mentions` is not a comment on the account's own media: left out.
    assert_eq!(
        keys(&events),
        vec![
            w("18000000000000001"),
            w("18000000000000002"),
            w("18000000000000003"),
        ]
    );
    let top = envelope(&events, "comment:18000000000000001:open");
    assert_eq!(top.account_id, "17841400000000001");
    assert_eq!(top.parent_external_id, None);
    assert_eq!(top.root_external_id, "18000000000000001");
    assert_eq!(top.author.id.as_deref(), Some("9990001"));
    assert_eq!(top.author.name.as_deref(), Some("a.customer"));
    assert_eq!(top.text, "Bu set kaç parça?");
    // An Instagram comment carries no time of its own: the entry's.
    assert_eq!(top.created_at, at(1_790_000_500).unwrap());
    assert_eq!(events[0].event.occurred_at, at(1_790_000_500));
    let subject = top.subject.unwrap();
    assert_eq!(subject.kind, SubjectKind::Post);
    assert_eq!(subject.external_id, "17900000000000001");
    assert_eq!(subject.facts["media_product_type"], "FEED");
    let reply = envelope(&events, "comment:18000000000000002:open");
    assert_eq!(
        reply.parent_external_id.as_deref(),
        Some("18000000000000001")
    );
    assert_eq!(reply.root_external_id, "18000000000000001");
}

#[test]
fn ig_live_comment_is_flagged_live() {
    let events = parsed("comments/instagram_comments.json");
    assert!(envelope(&events, "comment:18000000000000003:open").live);
    assert!(!envelope(&events, "comment:18000000000000001:open").live);
}

#[test]
fn comment_external_ids_are_stable_per_state() {
    let once = keys(&parsed("comments/page_feed_comments.json"));
    let again = keys(&parsed("comments/page_feed_comments.json"));
    assert_eq!(once, again);
    let ids: Vec<&str> = once.iter().map(|(_, _, id, _)| id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "comment:111_901:open",
            "comment:111_902:open",
            "comment:111_901:edited:1790000300",
            "comment:111_903:removed",
            "comment:111_904:open",
        ]
    );
    // A poller keys a comment it finds as the webhook does.
    assert_eq!(
        comment_event_id("111_901", EnvelopeStatus::Open, None),
        "comment:111_901:open"
    );
}

#[test]
fn scoped_body_keeps_a_comment_entry() {
    let raw = fixture_text("comments/page_feed_comments.json");
    let events = parse(raw.as_bytes()).unwrap();
    let keep: BTreeSet<Origin> = events.iter().map(|e| e.origin).collect();
    // Every event is of the one entry: the body is kept byte for byte.
    assert_eq!(
        scoped_body(raw.as_bytes(), &keep).unwrap(),
        raw.as_bytes().to_vec()
    );
}

#[test]
fn unknown_fields_ignored() {
    // The first comment's value carries a field Meta might add later.
    let events = parsed("comments/page_feed_comments.json");
    assert_eq!(
        envelope(&events, "comment:111_901:open").text,
        "Fiyatı nedir?"
    );
    let event = events
        .iter()
        .find(|e| e.event.external_id == "comment:111_901:open")
        .unwrap();
    assert_eq!(
        event.event.payload["provider_item"]["unexpected"]["added"],
        "later by Meta"
    );
}
