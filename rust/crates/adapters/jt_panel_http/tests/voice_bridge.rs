//! The voice bridge's routes end to end through Postgres: they take the bridge's bearer key alone
//! (`calls.bridge`, nothing else), never a session cookie or another key, and that key opens no
//! other route.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_testkit::panel::{Panel, REQUESTED_WITH, body_json, expect_error, ok_json};
use serde_json::{Value, json};

/// What the bridge reports of itself.
fn facts() -> Value {
    json!({
        "extension": "101",
        "codecs": ["PCMA", "PCMU"],
        "max_calls": 1,
        "stt": { "engine": "vosk", "model": "vosk-model-small-tr-0.3" },
        "tts": { "engine": "piper", "voice": "tr_TR-fahrettin-medium" },
        "version": "0.1.0",
    })
}

/// `method path` with the bearer `key` and/or the session `cookie`, the request header on a
/// mutating method, and an optional JSON body.
async fn send(
    p: &Panel,
    method: Method,
    path: &str,
    key: Option<&str>,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Response {
    let mut req = Request::builder().method(method.clone()).uri(path);
    if let Some(key) = key {
        req = req.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    if !method.is_safe() {
        req = req.header(REQUESTED_WITH.0, REQUESTED_WITH.1);
    }
    let body = match body {
        Some(body) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    p.call(req.body(body).unwrap()).await
}

/// `POST /api/voice/bridge/register` with the bridge's facts.
async fn register(p: &Panel, key: Option<&str>, cookie: Option<&str>) -> Response {
    send(
        p,
        Method::POST,
        "/api/voice/bridge/register",
        key,
        cookie,
        Some(facts()),
    )
    .await
}

/// A key the owner of `cookie` issues with `scopes` (none: every permission they hold).
async fn key(p: &Panel, cookie: &str, name: &str, scopes: &[&str]) -> String {
    let resp = p
        .send(
            Method::POST,
            "/api/api-keys",
            Some(cookie),
            Some(json!({ "name": name, "scopes": scopes })),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    body_json(resp).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn the_bridge_routes_take_the_bridge_key_alone() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let bridge = key(&p, &owner, "voice bridge", &["calls.bridge"]).await;
    let agent = key(&p, &owner, "agent", &[]).await;

    // A session cookie is refused, the owner's own included: the route reads no cookie.
    expect_error(
        register(&p, None, Some(&owner)).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    // So is an unknown key.
    expect_error(
        register(&p, Some("jt_live_nope"), None).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    // A key with every permission, calls.bridge among them, is not the bridge's.
    let body = expect_error(
        register(&p, Some(&agent), None).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(body["details"]["reason"], "bridge_key_only");
    let resp = send(
        &p,
        Method::GET,
        "/api/voice/bridge/commands?wait_s=0",
        Some(&agent),
        None,
        None,
    )
    .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;

    // The bridge's key registers, polls and reports.
    let registered = ok_json(register(&p, Some(&bridge), None).await).await;
    assert_eq!(registered["status"], "verified");
    assert_eq!(registered["heartbeat_s"], 15);
    assert!(registered["capability_id"].is_string());
    let polled = ok_json(
        send(
            &p,
            Method::GET,
            "/api/voice/bridge/commands?wait_s=0",
            Some(&bridge),
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(polled, json!({ "commands": [], "timed_out": true }));
    let reported = ok_json(
        send(
            &p,
            Method::POST,
            "/api/voice/bridge/events",
            Some(&bridge),
            None,
            Some(json!({ "events": [
                { "bridge_call_id": "b-1", "bridge_seq": 1, "at": "2026-10-28T09:00:00Z", "kind": "ringing" },
            ] })),
        )
        .await,
    )
    .await;
    assert_eq!(
        reported,
        json!({ "accepted": 0, "duplicates": 0, "unmatched": 1 })
    );
    // A malformed batch is a structured refusal.
    let resp = send(
        &p,
        Method::POST,
        "/api/voice/bridge/events",
        Some(&bridge),
        None,
        Some(json!({ "events": [{ "bridge_call_id": "b-1", "kind": "ringing" }] })),
    )
    .await;
    expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;

    // The capability shows the bridge to the owner, verified by its heartbeat.
    let listed = ok_json(p.get("/api/capabilities?kind=voice_bridge", &owner).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed[0]["effective_status"], "verified");
    assert_eq!(
        listed[0]["capability"]["connector_public"]["bridge"]["extension"],
        "101"
    );
}

#[tokio::test]
async fn the_bridge_key_opens_no_other_route() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@beta.example", "Beta").await;
    let bridge = key(&p, &owner, "voice bridge", &["calls.bridge"]).await;
    // The panel's routes read the session cookie, never a bearer key.
    for (method, path) in [
        (Method::GET, "/api/work/pending"),
        (Method::GET, "/api/capabilities"),
        (Method::GET, "/api/calls"),
        (Method::GET, "/api/auth/me"),
    ] {
        let resp = send(&p, method, path, Some(&bridge), None, None).await;
        expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    }
    let resp = send(
        &p,
        Method::POST,
        "/api/calls",
        Some(&bridge),
        None,
        Some(json!({ "phone": "+905321234567", "purpose": "service", "mode": "human", "rep_extension": "101" })),
    )
    .await;
    expect_error(resp, StatusCode::UNAUTHORIZED, "UNAUTHENTICATED").await;
    // And a mutating bridge request without the request header is refused before the key is
    // read.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/voice/bridge/register")
        .header(header::AUTHORIZATION, format!("Bearer {bridge}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(facts().to_string()))
        .unwrap();
    expect_error(p.call(req).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
}
