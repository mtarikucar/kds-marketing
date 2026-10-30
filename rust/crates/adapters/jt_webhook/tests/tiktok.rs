//! TikTok's webhooks through the gate (`POST /hooks/tiktok`), over the in-memory fakes: the
//! signature (`TikTok-Signature: t=..,s=..`, HMAC-SHA256 under the client secret over
//! `"{t}.{body}"`) checked before anything is read, a stale one refused as a replay; one event
//! stored once in the workspace holding its account connected and taking its effect there
//! (`authorization.removed` asks for a reconnection); an unknown event stored and acknowledged;
//! what cannot be routed acknowledged and stored nowhere; and no secret, signature, account id or
//! body in any log line.

mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::UnitOfWork;
use jt_app::usecases::Deps;
use jt_capability::StoredStatus;
use jt_connector::{EventKind, Provider};
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig};
use jt_webhook::{TIKTOK_BODY_LIMIT, counters};
use serde_json::json;
use sha2::Sha256;
use std::sync::Arc;
use support::*;
use time::Duration;

/// The TikTok app's client key and secret of [`FakeAppConfig::with_all_apps`].
const CLIENT_KEY: &str = "tiktok-client-key";
const CLIENT_SECRET: &str = "tiktok-client-secret";

/// The connected account's open id.
const OPEN_ID: &str = "open-id-test-0001";

/// A webhook body as TikTok sends it: `content` a serialized JSON string.
fn body(event: &str, content: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "client_key": CLIENT_KEY,
        "event": event,
        "create_time": FIXED_NOW.unix_timestamp() - 5,
        "user_openid": OPEN_ID,
        "content": content.to_string(),
    }))
    .unwrap()
}

/// The `TikTok-Signature` value of `body` under `secret`, signed at `at`.
fn signature_at(secret: &str, body: &[u8], at: time::OffsetDateTime) -> String {
    let t = at.unix_timestamp().to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(t.as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("t={t},s={}", hex::encode(mac.finalize().into_bytes()))
}

/// `POST /hooks/tiktok` with `body` and, when given, the signature header (spelled as TikTok's
/// own example spells it: header names are case-insensitive).
fn tiktok_post(body: &[u8], signature: Option<&str>) -> Request<Body> {
    let mut req = Request::post("/hooks/tiktok").header(header::CONTENT_TYPE, "application/json");
    if let Some(signature) = signature {
        req = req.header("Tiktok-Signature", signature);
    }
    req.body(Body::from(body.to_vec())).unwrap()
}

/// `POST /hooks/tiktok` with `body` signed by the platform's client secret a minute ago.
fn signed(body: &[u8]) -> Request<Body> {
    let at = FIXED_NOW - Duration::minutes(1);
    tiktok_post(body, Some(&signature_at(CLIENT_SECRET, body, at)))
}

async fn tiktok_world() -> (World, jt_capability::CapabilityId) {
    let w = World::new().await;
    let cap = w.connected(w.ws, "tiktok", OPEN_ID).await;
    (w, cap)
}

async fn capability(w: &World, id: jt_capability::CapabilityId) -> jt_capability::Capability {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.capabilities().find(id).await.unwrap().unwrap()
}

#[tokio::test]
async fn an_unsigned_wrongly_signed_or_stale_delivery_is_refused_with_nothing_stored() {
    let (w, cap) = tiktok_world().await;
    let before = counters().rejected_tiktok;
    let raw = body("authorization.removed", json!({ "reason": 1 }));
    let recent = FIXED_NOW - Duration::minutes(1);
    let mut tampered = raw.clone();
    tampered[30] ^= 1;
    for req in [
        tiktok_post(&raw, None),
        tiktok_post(&raw, Some("")),
        tiktok_post(&raw, Some(&signature_at("another-secret", &raw, recent))),
        tiktok_post(&tampered, Some(&signature_at(CLIENT_SECRET, &raw, recent))),
        // Valid, but signed too long ago (a replay), or too far ahead.
        tiktok_post(
            &raw,
            Some(&signature_at(
                CLIENT_SECRET,
                &raw,
                FIXED_NOW - Duration::minutes(6),
            )),
        ),
        tiktok_post(
            &raw,
            Some(&signature_at(
                CLIENT_SECRET,
                &raw,
                FIXED_NOW + Duration::minutes(6),
            )),
        ),
        tiktok_post(
            &raw,
            Some(&signature_at(CLIENT_SECRET, &raw, recent).replace("s=", "sha256=")),
        ),
    ] {
        assert_eq!(send(&w.app(), req).await.status(), StatusCode::UNAUTHORIZED);
    }
    // Without a TikTok app nothing can be checked.
    let bare = w.with_apps(FakeAppConfig::default());
    assert_eq!(
        send(&bare.app(), signed(&raw)).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(w.stored().is_empty());
    assert_eq!(capability(&w, cap).await.status, StoredStatus::Verified);
    // Each refusal is counted (and warned of at most once a minute, naming only why).
    assert!(counters().rejected_tiktok >= before + 8);

    // A body over the limit is refused before it is read whole.
    let big = vec![b' '; TIKTOK_BODY_LIMIT + 1];
    assert_eq!(
        send(&w.app(), signed(&big)).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn authorization_removed_is_stored_once_and_asks_for_a_reconnection() {
    let (w, cap) = tiktok_world().await;
    let raw = body("authorization.removed", json!({ "reason": 1 }));
    let resp = send(&w.app(), signed(&raw)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let events = w.events_of(w.ws);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.provider, Provider::Tiktok);
    assert_eq!(event.kind, EventKind::parse("authorization.removed"));
    assert_eq!(event.capability_id, Some(cap));
    assert!(event.processed_at.is_some());
    assert_eq!(event.payload["tiktok"]["content"], json!({ "reason": 1 }));
    assert_eq!(w.stored()[0].raw.as_deref(), Some(raw.as_slice()));
    let c = capability(&w, cap).await;
    assert_eq!(c.status, StoredStatus::Unreachable);
    assert_eq!(c.connector_public["reconnect_required"], json!(true));

    // TikTok redelivers it (signed anew): stored once, written once.
    let ledger = w.uow.snapshot().ledger.len();
    let again = tiktok_post(&raw, Some(&signature_at(CLIENT_SECRET, &raw, FIXED_NOW)));
    assert_eq!(send(&w.app(), again).await.status(), StatusCode::OK);
    assert_eq!(w.stored().len(), 1);
    assert_eq!(w.uow.snapshot().ledger.len(), ledger);
}

#[tokio::test]
async fn an_unknown_or_informational_event_is_stored_for_the_agent_and_acknowledged() {
    let (w, cap) = tiktok_world().await;
    for (event, content) in [
        (
            "post.publish.no_longer_publicaly_available",
            json!({ "publish_id": "v_pub_file~v2-1.7", "post_id": "7300000000000000001" }),
        ),
        ("something.new", json!({ "anything": true })),
    ] {
        let resp = send(&w.app(), signed(&body(event, content))).await;
        assert_eq!(resp.status(), StatusCode::OK, "{event}");
    }
    let events = w.events_of(w.ws);
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.processed_at.is_none()));
    assert_eq!(capability(&w, cap).await.status, StoredStatus::Verified);
}

#[tokio::test]
async fn a_post_event_is_stored_processed_and_answered_at_once() {
    let (w, cap) = tiktok_world().await;
    let raw = body(
        "post.publish.complete",
        json!({ "publish_id": "v_pub_file~v2-1.7", "publish_type": "DIRECT_PUBLISH" }),
    );
    let resp = send(&w.app(), signed(&raw)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let events = w.events_of(w.ws);
    assert_eq!(events.len(), 1);
    assert!(events[0].processed_at.is_some());
    assert_eq!(capability(&w, cap).await.status, StoredStatus::Verified);
}

#[tokio::test]
async fn what_cannot_be_routed_is_acknowledged_and_stored_nowhere() {
    let w = World::new().await;
    let before = counters();
    // A signed body that is no webhook the parser knows.
    for raw in [
        b"not json".to_vec(),
        br#"{"client_key":"tiktok-client-key"}"#.to_vec(),
    ] {
        assert_eq!(send(&w.app(), signed(&raw)).await.status(), StatusCode::OK);
    }
    // For another app, for an account nobody holds, for no account at all.
    let mut other_app: serde_json::Value =
        serde_json::from_slice(&body("authorization.removed", json!({ "reason": 1 }))).unwrap();
    other_app["client_key"] = json!("another-client-key");
    let mut anonymous = other_app.clone();
    anonymous["client_key"] = json!(CLIENT_KEY);
    anonymous["user_openid"] = json!("");
    for raw in [
        serde_json::to_vec(&other_app).unwrap(),
        body("authorization.removed", json!({ "reason": 1 })),
        serde_json::to_vec(&anonymous).unwrap(),
    ] {
        assert_eq!(send(&w.app(), signed(&raw)).await.status(), StatusCode::OK);
    }
    assert!(w.stored().is_empty());
    let after = counters();
    assert!(after.unparseable_tiktok >= before.unparseable_tiktok + 2);
    assert!(after.unrouted_tiktok >= before.unrouted_tiktok + 3);
}

/// A database that cannot store the event is `500`: TikTok redelivers.
#[tokio::test]
async fn a_storage_failure_is_a_server_error_for_tiktok_to_redeliver() {
    let (w, _) = tiktok_world().await;
    let deps = Deps {
        uow: Arc::new(FailingInserts(w.uow.clone())),
        ..w.deps.clone()
    };
    let raw = body("authorization.removed", json!({ "reason": 1 }));
    assert_eq!(
        send(&w.app_with(deps), signed(&raw)).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(w.stored().is_empty());
}

/// No log line names the client secret, a signature, the account's open id, a publish id or
/// anything else the body said.
#[tokio::test]
async fn no_secret_signature_account_or_body_reaches_the_logs() {
    let (w, _) = tiktok_world().await;
    let other = World::new().await;
    let logs = Logs::capture();
    let removed = body("authorization.removed", json!({ "reason": 4 }));
    let complete = body(
        "post.publish.failed",
        json!({ "publish_id": "v_pub_file~v2-1.7", "reason": "spam_risk_text" }),
    );
    let stale = signature_at(CLIENT_SECRET, &removed, FIXED_NOW - Duration::hours(1));
    for (app, req) in [
        (w.app(), signed(&removed)),
        (w.app(), signed(&complete)),
        (w.app(), tiktok_post(&removed, Some(&stale))),
        (w.app(), signed(b"{\"secret\":\"zz-private-zz\"}")),
        // Unrouted: the warning names the reason and TikTok's event name only.
        (other.app(), signed(&complete)),
    ] {
        send(&app, req).await;
    }
    // Let the read-back the gate started after answering run (and log).
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    let text = logs.text();
    assert!(text.contains("provider=\"tiktok\""), "{text}");
    assert!(text.contains("reason=\"unrouted\""), "{text}");
    for private in [
        CLIENT_SECRET,
        CLIENT_KEY,
        OPEN_ID,
        "v_pub_file",
        "spam_risk_text",
        "zz-private-zz",
        &stale,
        &stale[stale.find("s=").unwrap() + 2..],
    ] {
        assert!(!text.contains(private), "the log names {private}: {text}");
    }
}
