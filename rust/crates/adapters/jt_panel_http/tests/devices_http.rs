//! The phones' routes for a person in the panel (`/api/devices`, D1-T6) end to end through
//! Postgres: they take the session cookie alone (never a bearer key, the bridge's included), a
//! `POST` needs the request header as every mutating call does, `devices.work` is needed (a rep is
//! refused), and the use cases' refusals keep their status: `409` for a phone that cannot take a
//! command now, `422` for a command its bridge cannot run, `404` for an unknown phone.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use jt_app::usecases::api_keys;
use jt_app::usecases::devices::bridge::{self, RegisterIn};
use jt_testkit::panel::{Panel, REQUESTED_WITH, body_json, expect_error, ok_json};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

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

/// The bridge of key `plaintext` registers phone `serial`, whose bridge runs `features`, at
/// `at`; the phone's capability id.
async fn register(
    p: &Panel,
    plaintext: &str,
    serial: &str,
    features: &[&str],
    at: OffsetDateTime,
) -> String {
    let principal = api_keys::authenticate(&p.deps, plaintext).await.unwrap();
    let body: RegisterIn = serde_json::from_value(json!({
        "bridge_id": format!("PC-{serial}"),
        "version": "0.1.0",
        "protocol": 1,
        "phones": [{
            "platform": "android",
            "serial": serial,
            "model": "Redmi 10C",
            "os_version": "13",
            "features": features,
        }],
    }))
    .unwrap();
    let out = bridge::register(&p.deps, &bridge::ctx_for_bridge(&principal, at), body)
        .await
        .unwrap();
    out.phones[0].capability_id.to_string()
}

/// `method path` with the session `cookie` and/or the bearer `key`, the request header when
/// `requested_with`, and an optional JSON body.
fn request(
    method: Method,
    path: &str,
    cookie: Option<&str>,
    key: Option<&str>,
    requested_with: bool,
    body: Option<Value>,
) -> Request<Body> {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    if let Some(key) = key {
        req = req.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    if requested_with {
        req = req.header(REQUESTED_WITH.0, REQUESTED_WITH.1);
    }
    let body = match body {
        Some(body) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    req.body(body).unwrap()
}

/// An owner with one live phone, `SER1`, whose bridge runs observe, tap and text (ASCII only):
/// the panel, the owner's cookie, the bridge's key and the phone's id.
async fn rig(email: &str, name: &str) -> (Panel, String, String, String) {
    let p = Panel::new().await;
    let (owner, _) = p.register(email, name).await;
    let bridge_key = key(&p, &owner, "phones", &["devices.bridge"]).await;
    let phone = register(
        &p,
        &bridge_key,
        "SER1",
        &["observe", "tap", "text"],
        OffsetDateTime::now_utc(),
    )
    .await;
    (p, owner, bridge_key, phone)
}

#[tokio::test]
async fn the_routes_answer_a_session_with_devices_work() {
    let (p, owner, _, phone) = rig("owner@devices.example", "Devices").await;
    let phones = ok_json(p.get("/api/devices", &owner).await).await;
    assert_eq!(phones[0]["capability_id"], phone.as_str());
    assert_eq!(phones[0]["online"], true);

    let act = format!("/api/devices/{phone}/act");
    let queued = ok_json(
        p.send(
            Method::POST,
            &act,
            Some(&owner),
            Some(json!({ "command": { "kind": "tap", "x": 1, "y": 2 }, "wait_s": 0 })),
        )
        .await,
    )
    .await;
    assert_eq!(queued["status"], "queued");
    assert_eq!(queued["command"], json!({ "kind": "tap", "x": 1, "y": 2 }));
    let id = queued["command_id"].as_str().unwrap().to_owned();
    let one = ok_json(
        p.get(&format!("/api/devices/commands/{id}?wait_s=0"), &owner)
            .await,
    )
    .await;
    assert_eq!(one["command_id"], id.as_str());
    let observed = ok_json(
        p.send(
            Method::POST,
            &format!("/api/devices/{phone}/observe"),
            Some(&owner),
            Some(json!({ "screenshot": false, "wait_s": 0 })),
        )
        .await,
    )
    .await;
    assert_eq!(observed["kind"], "observe");
    let log = ok_json(
        p.get(&format!("/api/devices/{phone}/commands?limit=5"), &owner)
            .await,
    )
    .await;
    let log = log.as_array().unwrap();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|c| c.get("result").is_none()), "{log:?}");
}

#[tokio::test]
async fn refusals_keep_their_status() {
    let (p, owner, _, phone) = rig("owner@refusals.example", "Refusals").await;
    let act = format!("/api/devices/{phone}/act");
    let post = |body: Value| p.send(Method::POST, &act, Some(&owner), Some(body));
    // A kind its bridge does not run, Unicode text without ADBKeyBoard, a bound broken: 422.
    let body = expect_error(
        post(json!({ "command": { "kind": "shell", "argv": ["id"] } })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["reason"], "unsupported_by_bridge");
    assert_eq!(body["details"]["kind"], "shell");
    let body = expect_error(
        post(json!({ "command": { "kind": "text", "value": "Ayşe" } })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["reason"], "unicode_unsupported");
    let body = expect_error(
        post(json!({ "command": { "kind": "text", "value": "" } })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["field"], "value");
    // A body that is no command: 422 too.
    expect_error(
        post(json!({ "command": { "kind": "teleport" } })).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    // A phone whose bridge last registered it two minutes ago: offline, 409.
    let old_bridge = key(&p, &owner, "old phones", &["devices.bridge"]).await;
    let stale = register(
        &p,
        &old_bridge,
        "SER2",
        &["tap"],
        OffsetDateTime::now_utc() - Duration::minutes(2),
    )
    .await;
    let body = expect_error(
        p.send(
            Method::POST,
            &format!("/api/devices/{stale}/act"),
            Some(&owner),
            Some(json!({ "command": { "kind": "tap", "x": 1, "y": 1 } })),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    assert_eq!(body["details"]["reason"], "device_offline");

    // An unknown phone, or command: 404.
    let unknown = "01890000-0000-7000-8000-000000000001";
    expect_error(
        p.send(
            Method::POST,
            &format!("/api/devices/{unknown}/act"),
            Some(&owner),
            Some(json!({ "command": { "kind": "tap", "x": 1, "y": 1 } })),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    expect_error(
        p.get(&format!("/api/devices/commands/{unknown}?wait_s=0"), &owner)
            .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    expect_error(
        p.get(&format!("/api/devices/{unknown}/commands"), &owner)
            .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
}

#[tokio::test]
async fn a_post_needs_the_request_header() {
    let (p, owner, _, phone) = rig("owner@csrf.example", "Csrf").await;
    for (path, body) in [
        (
            format!("/api/devices/{phone}/act"),
            json!({ "command": { "kind": "tap", "x": 1, "y": 1 }, "wait_s": 0 }),
        ),
        (
            format!("/api/devices/{phone}/observe"),
            json!({ "wait_s": 0 }),
        ),
    ] {
        let without = request(
            Method::POST,
            &path,
            Some(&owner),
            None,
            false,
            Some(body.clone()),
        );
        let refused = expect_error(p.call(without).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(refused["message"], "missing request header", "{path}");
        let with = request(Method::POST, &path, Some(&owner), None, true, Some(body));
        assert_eq!(p.call(with).await.status(), StatusCode::OK, "{path}");
    }
}

#[tokio::test]
async fn the_routes_take_a_session_only_and_need_devices_work() {
    let (p, owner, bridge_key, phone) = rig("owner@session.example", "Session").await;
    let agent = key(&p, &owner, "agent", &[]).await;
    let paths = [
        (Method::GET, "/api/devices".to_owned(), None),
        (
            Method::POST,
            format!("/api/devices/{phone}/act"),
            Some(json!({ "command": { "kind": "tap", "x": 1, "y": 1 }, "wait_s": 0 })),
        ),
        (
            Method::POST,
            format!("/api/devices/{phone}/observe"),
            Some(json!({ "wait_s": 0 })),
        ),
        (
            Method::GET,
            "/api/devices/commands/01890000-0000-7000-8000-000000000001".to_owned(),
            None,
        ),
        (Method::GET, format!("/api/devices/{phone}/commands"), None),
    ];
    for (method, path, body) in &paths {
        // No session, or a bearer key in its place (an agent's holding every permission, the
        // bridge's own): unauthenticated. Agents reach these through the MCP tools.
        for bearer in [None, Some(agent.as_str()), Some(bridge_key.as_str())] {
            let req = request(method.clone(), path, None, bearer, true, body.clone());
            expect_error(
                p.call(req).await,
                StatusCode::UNAUTHORIZED,
                "UNAUTHENTICATED",
            )
            .await;
        }
    }
    // A rep's session holds no devices.work.
    let (rep, _) = p.join(&owner, "rep@session.example", "rep").await;
    for (method, path, body) in &paths {
        let req = request(method.clone(), path, Some(&rep), None, true, body.clone());
        let refused = expect_error(p.call(req).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(refused["details"]["permission"], "devices.work", "{path}");
    }
}
