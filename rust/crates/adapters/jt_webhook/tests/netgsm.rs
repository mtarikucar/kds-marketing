//! NetGSM's callbacks through the gate, over the in-memory fakes: the URL's workspace, token and
//! purpose checked before the body is read (every refusal a bare `404`, nothing stored), events
//! stored once with their raw body and the purpose's capability, `202` for a body NetGSM will not
//! improve by retrying, and `503` when storing fails so NetGSM redelivers.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use jt_app::usecases::Deps;
use jt_capability::StoredStatus;
use jt_connector::{EventKind, NetgsmPurpose, Provider};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use jt_webhook::{NETGSM_BODY_LIMIT, counters};
use support::*;

/// The MO callback of `ws` with its own token.
fn mo(w: &World, ws: WorkspaceId, body: &[u8]) -> axum::http::Request<axum::body::Body> {
    netgsm_post(&ws.to_string(), &w.token(ws, NetgsmPurpose::Mo), "mo", body)
}

#[tokio::test]
async fn an_incoming_sms_with_the_workspace_token_is_202_and_stored() {
    let w = World::new().await;
    let line = w.connected(w.ws, "sms_line", "ACME").await;
    let body = fixture("netgsm/mo_object.json");
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &body)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let events = w.events_of(w.ws);
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.provider, Provider::Netgsm);
    assert_eq!(e.kind, EventKind::Message);
    assert_eq!(e.external_id, "netgsm-mo:990000001");
    assert_eq!(e.capability_id, Some(line));
    assert_eq!(e.payload["from"], "+905000000031");
    assert_eq!(e.payload["text"], "Merhaba, randevu almak istiyorum");
    assert_eq!(w.stored()[0].raw.as_deref(), Some(&body[..]));

    // A redelivery is accepted and stores nothing new.
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &body)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(w.stored().len(), 1);

    // A form body is read too.
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &fixture("netgsm/mo_form.txt"))).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(w.stored().len(), 2);
}

#[tokio::test]
async fn call_events_and_consent_changes_take_their_own_urls() {
    let w = World::new().await;
    let pbx = w.connected(w.ws, "netgsm_pbx", "santral").await;
    let ws = w.ws.to_string();
    let events = netgsm_post(
        &ws,
        &w.token(w.ws, NetgsmPurpose::Events),
        "events",
        &fixture("netgsm/events.json"),
    );
    let (status, _) = answer(&w.app(), events).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let calls: Vec<_> = w
        .events_of(w.ws)
        .into_iter()
        .filter(|e| e.kind == EventKind::CallEvent)
        .collect();
    assert!(!calls.is_empty());
    assert!(calls.iter().all(|e| e.capability_id == Some(pbx)));
    // Recording links lost their tokens at parse time; the raw body keeps what NetGSM sent.
    for e in &calls {
        assert!(
            !e.payload.to_string().contains("SECRET-HOOK"),
            "{}",
            e.payload
        );
    }

    let iys = netgsm_post(
        &ws,
        &w.token(w.ws, NetgsmPurpose::Iys),
        "iys",
        &fixture("netgsm/iys.json"),
    );
    let (status, _) = answer(&w.app(), iys).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let consents: Vec<_> = w
        .events_of(w.ws)
        .into_iter()
        .filter(|e| e.kind == EventKind::Consent)
        .collect();
    assert!(!consents.is_empty());
    // No SMS line: attached to no capability.
    assert!(consents.iter().all(|e| e.capability_id.is_none()));
}

/// A token of another purpose or workspace, a changed one, or none of the workspace's: `404`,
/// and nothing is stored.
#[tokio::test]
async fn netgsm_mo_with_a_bad_token_is_404_and_stores_nothing() {
    let w = World::new().await;
    let beta = w.other_workspace().await;
    let body = fixture("netgsm/mo_object.json");
    let ws = w.ws.to_string();
    let mine = w.token(w.ws, NetgsmPurpose::Mo);
    let mut changed = mine.clone();
    changed.replace_range(..1, if mine.starts_with('0') { "1" } else { "0" });
    for token in [
        w.token(w.ws, NetgsmPurpose::Iys),
        w.token(beta, NetgsmPurpose::Mo),
        changed,
        mine.to_uppercase(),
        "0".repeat(64),
        "x".into(),
    ] {
        let (status, text) = answer(&w.app(), netgsm_post(&ws, &token, "mo", &body)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{token}");
        assert!(text.is_empty(), "{text}");
    }
    assert!(w.stored().is_empty());
}

#[tokio::test]
async fn netgsm_unknown_purpose_is_404() {
    let w = World::new().await;
    let ws = w.ws.to_string();
    let token = w.token(w.ws, NetgsmPurpose::Mo);
    for purpose in ["dlr", "MO", "voice_report", "mo.json", ""] {
        let path_purpose = if purpose.is_empty() { "%20" } else { purpose };
        let (status, _) = answer(
            &w.app(),
            netgsm_post(&ws, &token, path_purpose, &fixture("netgsm/mo_object.json")),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{purpose}");
    }
    assert!(w.stored().is_empty());
}

/// A workspace that is suspended or awaits payment, an unknown one and a malformed id all read
/// alike: `404`, never saying which.
#[tokio::test]
async fn netgsm_suspended_workspace_is_404() {
    let w = World::new().await;
    let body = fixture("netgsm/mo_object.json");
    for status in [WorkspaceStatus::Suspended, WorkspaceStatus::PendingPayment] {
        w.set_status(w.ws, status).await;
        let (answered, _) = answer(&w.app(), mo(&w, w.ws, &body)).await;
        assert_eq!(answered, StatusCode::NOT_FOUND, "{status:?}");
    }
    let stranger = WorkspaceId::new_v7();
    let (answered, _) = answer(&w.app(), mo(&w, stranger, &body)).await;
    assert_eq!(answered, StatusCode::NOT_FOUND);
    let (answered, _) = answer(
        &w.app(),
        netgsm_post("not-a-workspace", &"0".repeat(64), "mo", &body),
    )
    .await;
    assert_eq!(answered, StatusCode::NOT_FOUND);
    assert!(w.stored().is_empty());

    w.set_status(w.ws, WorkspaceStatus::Active).await;
    let (answered, _) = answer(&w.app(), mo(&w, w.ws, &body)).await;
    assert_eq!(answered, StatusCode::ACCEPTED);
}

/// NetGSM would keep retrying a refused body it cannot improve: an unreadable one is accepted,
/// counted and logged (never its content), and nothing is stored.
#[tokio::test]
async fn netgsm_unparseable_body_is_202_and_stores_nothing() {
    let w = World::new().await;
    let before = counters().unparseable_netgsm;
    let logs = Logs::capture();
    for body in [&b""[..], b"just words", b"42", b"\"SECRET-BODY\""] {
        let (status, _) = answer(&w.app(), mo(&w, w.ws, body)).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    assert!(w.stored().is_empty());
    assert!(counters().unparseable_netgsm >= before + 4);
    let logs = logs.text();
    assert!(logs.contains("purpose=\"mo\""), "{logs}");
    assert!(!logs.contains("SECRET-BODY"), "{logs}");
    assert!(!logs.contains(&w.token(w.ws, NetgsmPurpose::Mo)), "{logs}");
}

#[tokio::test]
async fn netgsm_body_over_256_kilobytes_is_413() {
    let w = World::new().await;
    assert_eq!(NETGSM_BODY_LIMIT, 256 * 1024);
    let big = vec![b' '; NETGSM_BODY_LIMIT + 1];
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &big)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(w.stored().is_empty());
}

/// NetGSM redelivers on `503`: a failed insert loses nothing.
#[tokio::test]
async fn netgsm_insert_failure_returns_503() {
    let w = World::new().await;
    let deps = Deps {
        uow: Arc::new(FailingInserts(w.uow.clone())),
        ..w.deps.clone()
    };
    let body = fixture("netgsm/mo_object.json");
    let (status, _) = answer(&w.app_with(deps), mo(&w, w.ws, &body)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(w.stored().is_empty());
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &body)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(w.stored().len(), 1);
}

/// Two live SMS lines: which one an incoming SMS came through is unknown, so it names none; a
/// retired line does not count.
#[tokio::test]
async fn an_event_names_the_purpose_capability_only_when_there_is_exactly_one() {
    let w = World::new().await;
    w.capability(w.ws, "sms_line", "OLD", StoredStatus::Retired, true)
        .await;
    w.connected(w.ws, "sms_line", "ONE").await;
    w.connected(w.ws, "sms_line", "TWO").await;
    let (status, _) = answer(&w.app(), mo(&w, w.ws, &fixture("netgsm/mo_object.json"))).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(w.events_of(w.ws)[0].capability_id, None);
}
