//! Meta's webhooks through the gate, over the in-memory fakes: the verification handshake
//! (`GET /hooks/meta`), the signature checked before anything is read (`POST /hooks/meta`), one
//! event per item stored in the workspace that holds its account connected, a replay stored once
//! (Review Focus 2), an event for an account no workspace holds connected dropped with a warning
//! and nothing written anywhere (Review Focus 1), and the answers Meta redelivers on.

mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use jt_app::usecases::Deps;
use jt_capability::StoredStatus;
use jt_connector::{EventKind, Provider};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::FakeAppConfig;
use jt_webhook::{META_BODY_LIMIT, counters};
use serde_json::json;
use std::sync::Arc;
use support::*;

const WHATSAPP_NUMBER: &str = "5555555555";

fn verify(query: &str) -> Request<Body> {
    Request::get(format!("/hooks/meta?{query}"))
        .body(Body::empty())
        .unwrap()
}

// ---------------------------------------------------------------------------------------------
// The verification handshake
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn meta_get_echoes_the_challenge_for_the_verify_token() {
    let w = World::new().await;
    let resp = send(
        &w.app(),
        verify("hub.mode=subscribe&hub.verify_token=meta-verify-token&hub.challenge=1158201444"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()[header::CONTENT_TYPE],
        "text/plain; charset=utf-8"
    );
    let (_, body) = answer(
        &w.app(),
        verify("hub.mode=subscribe&hub.verify_token=meta-verify-token&hub.challenge=1158201444"),
    )
    .await;
    assert_eq!(body, "1158201444");
}

#[tokio::test]
async fn meta_get_with_another_token_or_mode_is_403() {
    let w = World::new().await;
    for query in [
        "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1",
        "hub.mode=subscribe&hub.verify_token=META-VERIFY-TOKEN&hub.challenge=1",
        "hub.mode=unsubscribe&hub.verify_token=meta-verify-token&hub.challenge=1",
        "hub.verify_token=meta-verify-token&hub.challenge=1",
        "hub.mode=subscribe&hub.challenge=1",
        "",
    ] {
        let (status, body) = answer(&w.app(), verify(query)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{query}");
        assert!(!body.contains('1'), "{query}: {body}");
    }
}

#[tokio::test]
async fn meta_get_without_app_is_404() {
    let w = World::new().await.without_apps();
    let (status, _) = answer(
        &w.app(),
        verify("hub.mode=subscribe&hub.verify_token=meta-verify-token&hub.challenge=1"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------------------------
// Signed deliveries
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn meta_post_without_app_is_401() {
    let w = World::new().await;
    w.connected(w.ws, "whatsapp_cloud", WHATSAPP_NUMBER).await;
    let w = w.without_apps();
    let body = fixture("meta/whatsapp_messages.json");
    let (status, _) = answer(&w.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(w.stored().is_empty());
}

#[tokio::test]
async fn meta_post_with_a_bad_or_missing_signature_is_401_and_stores_nothing() {
    let w = World::new().await;
    w.connected(w.ws, "whatsapp_cloud", WHATSAPP_NUMBER).await;
    let body = fixture("meta/whatsapp_messages.json");
    let mut tampered = body.clone();
    tampered.extend_from_slice(b" ");
    for req in [
        meta_post(&body, None),
        meta_post(&body, Some("")),
        meta_post(&body, Some("sha256=00")),
        meta_post(&body, Some(&signature("another-secret", &body))),
        meta_post(&tampered, Some(&signature(APP_SECRET, &body))),
        meta_post(
            &body,
            Some(&signature(APP_SECRET, &body).replace("sha256=", "sha1=")),
        ),
    ] {
        let (status, _) = answer(&w.app(), req).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert!(w.stored().is_empty());
}

/// WhatsApp Cloud API payloads reach 3 MB: that much is read, more is `413`.
#[tokio::test]
async fn meta_post_over_three_megabytes_is_413() {
    let w = World::new().await;
    assert_eq!(META_BODY_LIMIT, 3 * 1024 * 1024);
    let big = vec![b' '; META_BODY_LIMIT + 1];
    let (status, _) = answer(&w.app(), signed(&big)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    // Exactly the limit is read (and, not being a webhook body, stored as nothing).
    let at_limit = vec![b' '; META_BODY_LIMIT];
    let (status, _) = answer(&w.app(), signed(&at_limit)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(w.stored().is_empty());
}

#[tokio::test]
async fn a_whatsapp_delivery_stores_one_event_per_message_and_a_replay_none() {
    let w = World::new().await;
    let number = w.connected(w.ws, "whatsapp_cloud", WHATSAPP_NUMBER).await;
    let body = fixture("meta/whatsapp_messages.json");

    let (status, text) = answer(&w.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text, "EVENT_RECEIVED");
    // Written in the order of their ids.
    let events = w.events_of(w.ws);
    let ids: Vec<&str> = events.iter().map(|e| e.external_id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "wamid.TEST-BUTTON-1",
            "wamid.TEST-INTERACTIVE-1",
            "wamid.TEST-REFERRAL-1",
            "wamid.TEST-TEXT-1"
        ]
    );
    let first = events
        .iter()
        .find(|e| e.external_id == "wamid.TEST-TEXT-1")
        .unwrap();
    assert_eq!(first.provider, Provider::Meta);
    assert_eq!(first.kind, EventKind::Message);
    assert_eq!(first.capability_id, Some(number));
    assert_eq!(
        first.payload["message"]["text"]["body"],
        "Merhaba, açık mısınız?"
    );
    assert_eq!(first.payload["contact"]["profile"]["name"], "Test Kişi");
    assert_eq!(first.payload["occurred_at"], "2026-09-21T14:13:20Z");
    // A body is kept once, beside the first event stored: the workspace's own part of it. The
    // second number (held by no workspace) and the template update (no event) are left out.
    let raws: Vec<Option<Vec<u8>>> = w.stored().into_iter().map(|s| s.raw).collect();
    assert!(matches!(raws[..], [Some(_), None, None, None]), "{raws:?}");
    let kept: serde_json::Value = serde_json::from_slice(raws[0].as_deref().unwrap()).unwrap();
    let mut whole: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let first_change = whole["entry"][0]["changes"][0].take();
    whole["entry"][0]["changes"] = json!([first_change]);
    assert_eq!(kept, whole);
    let kept = String::from_utf8(raws[0].clone().unwrap()).unwrap();
    for elsewhere in [
        "5555555556",
        "TEST-OTHER-NUMBER",
        "905553333333",
        "APPROVED",
    ] {
        assert!(!kept.contains(elsewhere), "keeps {elsewhere}: {kept}");
    }

    // Meta redelivers: acknowledged, nothing new (Review Focus 2).
    let (status, text) = answer(&w.app(), signed(&body)).await;
    assert_eq!((status, text.as_str()), (StatusCode::OK, "EVENT_RECEIVED"));
    assert_eq!(w.stored().len(), 4);
}

/// Review Focus 1: the second number of the delivery is held by no workspace; a page held
/// connected elsewhere does not take WhatsApp events; a number another workspace holds only
/// declared, or retired, takes nothing either. Nothing is written for them, anywhere, and the
/// warning names the provider and the kind of account only.
#[tokio::test]
async fn an_event_for_an_account_no_workspace_holds_connected_is_dropped_with_a_warning() {
    let w = World::new().await;
    let beta = w.other_workspace().await;
    w.capability(
        beta,
        "whatsapp_cloud",
        "5555555556",
        StoredStatus::Declared,
        false,
    )
    .await;
    w.capability(
        beta,
        "whatsapp_cloud",
        WHATSAPP_NUMBER,
        StoredStatus::Retired,
        true,
    )
    .await;
    w.connected(beta, "facebook_page", WHATSAPP_NUMBER).await;
    let body = fixture("meta/whatsapp_messages.json");
    let before = counters().unrouted_meta;

    let logs = Logs::capture();
    let (status, text) = answer(&w.app(), signed(&body)).await;
    assert_eq!((status, text.as_str()), (StatusCode::OK, "EVENT_RECEIVED"));
    assert!(w.stored().is_empty());
    // Five messages, none routed.
    assert!(counters().unrouted_meta >= before + 5);
    let logs = logs.text();
    assert!(logs.contains("WARN"), "{logs}");
    assert!(logs.contains("provider=\"meta\""), "{logs}");
    assert!(logs.contains("kind_hint=\"whatsapp_cloud\""), "{logs}");
    for private in [
        WHATSAPP_NUMBER,
        "5555555556",
        "wamid",
        "Merhaba",
        "905551111111",
    ] {
        assert!(!logs.contains(private), "the log names {private}: {logs}");
    }
}

/// A delivery is stored while the workspace holding the account is active or awaits payment;
/// while it is suspended the events are dropped (answered `200` all the same: Meta would only
/// redeliver), counted as unrouted and logged with the reason `inactive`, nothing private.
#[tokio::test]
async fn meta_deliveries_follow_the_workspace_status() {
    let body = fixture("meta/whatsapp_messages.json");
    for (status, stored) in [
        (WorkspaceStatus::PendingPayment, 4),
        (WorkspaceStatus::Active, 4),
        (WorkspaceStatus::Suspended, 0),
    ] {
        let w = World::new().await;
        w.set_status(w.ws, status).await;
        w.connected(w.ws, "whatsapp_cloud", WHATSAPP_NUMBER).await;
        let before = counters().unrouted_meta;
        let logs = Logs::capture();
        let (answered, text) = answer(&w.app(), signed(&body)).await;
        assert_eq!(
            (answered, text.as_str()),
            (StatusCode::OK, "EVENT_RECEIVED"),
            "{status:?}"
        );
        assert_eq!(w.events_of(w.ws).len(), stored, "{status:?}");
        assert_eq!(
            w.stored().len(),
            stored,
            "{status:?}: nothing anywhere else"
        );
        let logs = logs.text();
        if stored == 0 {
            // The four messages of the suspended workspace's number (and the fixture's fifth,
            // for a number no workspace holds).
            assert!(counters().unrouted_meta >= before + 5, "{status:?}");
            assert!(logs.contains("WARN"), "{logs}");
            assert!(logs.contains("reason=\"inactive\""), "{logs}");
            assert!(logs.contains("kind_hint=\"whatsapp_cloud\""), "{logs}");
            for private in [WHATSAPP_NUMBER, "wamid", "Merhaba", "905551111111"] {
                assert!(!logs.contains(private), "the log names {private}: {logs}");
            }
        } else {
            assert!(!logs.contains("reason=\"inactive\""), "{status:?}: {logs}");
        }
    }
}

/// Instagram Login webhooks are signed with the Instagram app's secret: a body that either
/// platform secret signs passes; with no Instagram app configured, only the Meta secret does.
#[tokio::test]
async fn an_instagram_delivery_signed_with_the_instagram_app_secret_is_accepted() {
    let w = World::new().await;
    let account = w.connected(w.ws, "instagram_dm", "17841400000000001").await;
    let body = fixture("meta/instagram_messaging.json");
    let by_instagram = meta_post(&body, Some(&signature(INSTAGRAM_SECRET, &body)));

    let meta_only = w.with_apps(FakeAppConfig {
        instagram: None,
        ..FakeAppConfig::with_all_apps()
    });
    let (status, _) = answer(
        &meta_only.app(),
        meta_post(&body, Some(&signature(INSTAGRAM_SECRET, &body))),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(w.stored().is_empty());

    let (status, text) = answer(&w.app(), by_instagram).await;
    assert_eq!((status, text.as_str()), (StatusCode::OK, "EVENT_RECEIVED"));
    let events = w.events_of(w.ws);
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.capability_id == Some(account)));
    // The Meta secret still signs too.
    let (status, _) = answer(&meta_only.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::OK);
}

/// One body batching two workspaces' pages (and a page no workspace holds): each workspace keeps
/// only its own entries, re-serialised from the body, so neither keeps the other's page, sender,
/// message or text, and the unrouted page is kept nowhere. A body that is all one workspace's is
/// kept as received, byte for byte.
#[tokio::test]
async fn a_body_batching_two_workspaces_keeps_each_ones_own_entries() {
    let w = World::new().await;
    let beta = w.other_workspace().await;
    w.connected(w.ws, "facebook_page", "PAGE-A").await;
    w.connected(beta, "messenger", "PAGE-B").await;
    let entry = |page: &str, sender: &str, mid: &str, text: &str| {
        json!({
            "id": page,
            "time": 1_790_000_000_000_u64,
            "messaging": [{
                "sender": { "id": sender },
                "recipient": { "id": page },
                "timestamp": 1_790_000_000_000_u64,
                "message": { "mid": mid, "text": text },
            }],
        })
    };
    let a1 = entry("PAGE-A", "PSID-A1", "m_A1", "Alfa'nın müşterisi");
    let b = entry("PAGE-B", "PSID-B", "m_B", "Beta'nın müşterisi");
    let nobody = entry("PAGE-X", "PSID-X", "m_X", "kimsenin değil");
    let a2 = entry("PAGE-A", "PSID-A2", "m_A2", "Alfa yine");
    let body = serde_json::to_vec(&json!({
        "object": "page",
        "entry": [a1.clone(), b.clone(), nobody, a2.clone()],
    }))
    .unwrap();
    let (status, _) = answer(&w.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::OK);

    let kept = |ws| -> Vec<Vec<u8>> {
        w.stored()
            .into_iter()
            .filter(|s| s.event.workspace_id == ws)
            .filter_map(|s| s.raw)
            .collect()
    };
    let alpha = kept(w.ws);
    let beta_kept = kept(beta);
    assert_eq!((alpha.len(), beta_kept.len()), (1, 1));
    let parsed = |raw: &[u8]| -> serde_json::Value { serde_json::from_slice(raw).unwrap() };
    assert_eq!(
        parsed(&alpha[0]),
        json!({ "object": "page", "entry": [a1, a2] })
    );
    assert_eq!(
        parsed(&beta_kept[0]),
        json!({ "object": "page", "entry": [b] })
    );
    let text = |raw: &[u8]| String::from_utf8(raw.to_vec()).unwrap();
    for theirs in [
        "PAGE-B",
        "PSID-B",
        "m_B",
        "Beta'nın",
        "PAGE-X",
        "PSID-X",
        "m_X",
        "kimsenin",
    ] {
        assert!(!text(&alpha[0]).contains(theirs), "alpha keeps {theirs}");
    }
    for theirs in [
        "PAGE-A", "PSID-A", "m_A", "Alfa", "PAGE-X", "PSID-X", "m_X", "kimsenin",
    ] {
        assert!(!text(&beta_kept[0]).contains(theirs), "beta keeps {theirs}");
    }

    // All of a body one workspace's: kept as received.
    let own = serde_json::to_vec(&json!({
        "object": "page",
        "entry": [entry("PAGE-A", "PSID-A3", "m_A3", "tek alan")],
    }))
    .unwrap();
    let (status, _) = answer(&w.app(), signed(&own)).await;
    assert_eq!(status, StatusCode::OK);
    let third = w
        .stored()
        .into_iter()
        .find(|s| s.event.external_id == "m_A3")
        .unwrap();
    assert_eq!(third.raw.as_deref(), Some(&own[..]));
}

#[tokio::test]
async fn messenger_events_go_to_the_workspace_holding_the_page() {
    let w = World::new().await;
    let beta = w.other_workspace().await;
    let page = w.connected(beta, "messenger", "1234567890").await;
    let body = fixture("meta/messenger_messaging.json");
    let (status, _) = answer(&w.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(w.events_of(w.ws).is_empty());
    let events = w.events_of(beta);
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e.capability_id == Some(page)));
    assert!(
        events
            .iter()
            .any(|e| e.external_id == "m_TEST-ECHO-1" && e.kind == EventKind::MessageEcho)
    );
}

#[tokio::test]
async fn a_signed_body_that_is_not_a_known_webhook_is_acknowledged_and_stores_nothing() {
    let w = World::new().await;
    for body in [
        b"not json".to_vec(),
        json!({ "object": "permissions", "entry": [] })
            .to_string()
            .into_bytes(),
        json!({ "entry": [] }).to_string().into_bytes(),
    ] {
        let (status, text) = answer(&w.app(), signed(&body)).await;
        assert_eq!((status, text.as_str()), (StatusCode::OK, "EVENT_RECEIVED"));
    }
    assert!(w.stored().is_empty());
}

/// Meta redelivers whatever is not answered `200`: a database failure is `500`, so nothing is
/// lost.
#[tokio::test]
async fn a_database_failure_is_500_so_meta_redelivers() {
    let w = World::new().await;
    w.connected(w.ws, "whatsapp_cloud", WHATSAPP_NUMBER).await;
    let deps = Deps {
        uow: Arc::new(FailingInserts(w.uow.clone())),
        ..w.deps.clone()
    };
    let body = fixture("meta/whatsapp_messages.json");
    let (status, text) = answer(&w.app_with(deps), signed(&body)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(text, "EVENT_RECEIVED");
    assert!(w.stored().is_empty());
    // Once the database is back, the redelivery stores everything.
    let (status, _) = answer(&w.app(), signed(&body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(w.stored().len(), 4);
}
