//! The device bridge's routes end to end through Postgres: they take the bridge's bearer key alone
//! (`devices.bridge`, nothing else), never a session cookie or another key; every `POST` needs the
//! request header the bridge sends, as every mutating API call does; a refused body names its
//! field; and a file upload is the file's own bytes.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_panel_http::AppState;
use jt_testkit::fakes::files::MemoryFiles;
use jt_testkit::panel::{Panel, REQUESTED_WITH, body_json, expect_error, ok_json};
use serde_json::{Value, json};
use tower::ServiceExt;

/// A screenshot as the bridge uploads it: the PNG signature, then anything.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nscreen";

/// What the bridge reports every 15 seconds, with one phone.
fn register_body() -> Value {
    json!({
        "bridge_id": "PC-1",
        "version": "0.1.0",
        "protocol": 1,
        "phones": [{
            "platform": "android",
            "serial": "SER1",
            "model": "Redmi 10C",
            "os_version": "13",
            "screen": { "w": 720, "h": 1650, "rotation": 0 },
            "features": ["observe", "tap", "screenshot"],
        }],
    })
}

/// A results batch with one result for a command nobody queued.
fn results_body() -> Value {
    json!({ "results": [{
        "command_id": "01890000-0000-7000-8000-000000000001",
        "outcome": { "status": "done", "result": { "kind": "done" } },
        "duration_ms": 5,
    }] })
}

/// `method path` with the bearer `key` and/or the session `cookie`, the request header when
/// `requested_with`, and an optional body of a content type.
fn request(
    method: Method,
    path: &str,
    key: Option<&str>,
    cookie: Option<&str>,
    requested_with: bool,
    body: Option<(&str, Vec<u8>)>,
) -> Request<Body> {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(key) = key {
        req = req.header(header::AUTHORIZATION, format!("Bearer {key}"));
    }
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    if requested_with {
        req = req.header(REQUESTED_WITH.0, REQUESTED_WITH.1);
    }
    let body = match body {
        Some((content_type, bytes)) => {
            req = req.header(header::CONTENT_TYPE, content_type);
            Body::from(bytes)
        }
        None => Body::empty(),
    };
    req.body(body).unwrap()
}

/// A request body and its content type.
type Payload = Option<(&'static str, Vec<u8>)>;

fn json_body(value: &Value) -> Payload {
    Some(("application/json", value.to_string().into_bytes()))
}

/// The panel's router over `p`'s database with an in-memory file store, so uploads are kept.
fn with_files(p: &Panel) -> Router {
    let mut deps = p.deps.clone();
    deps.files = Arc::new(MemoryFiles::default());
    jt_panel_http::router(AppState {
        deps,
        gate: Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone())),
        cookie_secure: false,
        panel_dir: None,
    })
}

async fn call(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
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

/// Each of the bridge's routes as `key` calls it, with the request header and a valid body.
fn every_route(key: Option<&str>, cookie: Option<&str>) -> Vec<Request<Body>> {
    vec![
        request(
            Method::POST,
            "/api/devices/bridge/register",
            key,
            cookie,
            true,
            json_body(&register_body()),
        ),
        request(
            Method::GET,
            "/api/devices/bridge/commands?wait_s=0&limit=20",
            key,
            cookie,
            false,
            None,
        ),
        request(
            Method::POST,
            "/api/devices/bridge/results",
            key,
            cookie,
            true,
            json_body(&results_body()),
        ),
        request(
            Method::POST,
            "/api/devices/bridge/files",
            key,
            cookie,
            true,
            Some(("image/png", PNG.to_vec())),
        ),
    ]
}

#[tokio::test]
async fn session_cookie_refused() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    // A session cookie is refused, the owner's own included: the routes read no cookie.
    for req in every_route(None, Some(&owner)) {
        expect_error(
            p.call(req).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
    // So is an unknown key.
    for req in every_route(Some("jt_live_nope"), None) {
        expect_error(
            p.call(req).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}

#[tokio::test]
async fn wrong_permission_key_refused() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@beta.example", "Beta").await;
    let app = with_files(&p);
    let agent = key(&p, &owner, "agent", &[]).await;
    let voice = key(&p, &owner, "voice bridge", &["calls.bridge"]).await;
    let bridge = key(&p, &owner, "device bridge", &["devices.bridge"]).await;

    // A key with every permission, devices.bridge among them, is not the bridge's.
    for req in every_route(Some(&agent), None) {
        let body = expect_error(call(&app, req).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(body["details"]["reason"], "bridge_key_only");
    }
    // Nor is another bridge's key.
    for req in every_route(Some(&voice), None) {
        let body = expect_error(call(&app, req).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(body["details"]["permission"], "devices.bridge");
    }

    // The bridge's own key registers, polls, reports and uploads.
    let [register, commands, results, files] = every_route(Some(&bridge), None).try_into().unwrap();
    let registered = ok_json(call(&app, register).await).await;
    assert_eq!(registered["phones"][0]["serial"], "SER1");
    assert!(registered["phones"][0]["capability_id"].is_string());
    assert_eq!(registered["refused"], json!([]));
    assert_eq!(
        (
            &registered["heartbeat_s"],
            &registered["max_wait_s"],
            &registered["protocol"]
        ),
        (&json!(15), &json!(25), &json!(1))
    );
    assert_eq!(
        ok_json(call(&app, commands).await).await,
        json!({ "commands": [] })
    );
    // A result for a command nobody queued is counted, never refused.
    assert_eq!(
        ok_json(call(&app, results).await).await,
        json!({ "applied": 0, "duplicates": 0, "unknown": 1 })
    );
    assert!(ok_json(call(&app, files).await).await["file_id"].is_string());

    // The phone shows on the owner's capabilities, verified by the heartbeat.
    let listed = ok_json(p.get("/api/capabilities?kind=phone", &owner).await).await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed[0]["effective_status"], "verified");
    assert_eq!(
        listed[0]["capability"]["connector_public"]["device"]["model"],
        "Redmi 10C"
    );

    // The bridge's key opens no other route: the panel's read the session cookie only.
    for path in ["/api/capabilities", "/api/work/pending", "/api/auth/me"] {
        let req = request(Method::GET, path, Some(&bridge), None, false, None);
        expect_error(
            p.call(req).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}

#[tokio::test]
async fn post_without_requested_with_is_403() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@gamma.example", "Gamma").await;
    let app = with_files(&p);
    let bridge = key(&p, &owner, "device bridge", &["devices.bridge"]).await;
    let posts: [(&str, Payload); 3] = [
        ("/api/devices/bridge/register", json_body(&register_body())),
        ("/api/devices/bridge/results", json_body(&results_body())),
        (
            "/api/devices/bridge/files",
            Some(("application/octet-stream", b"pulled".to_vec())),
        ),
    ];
    for (path, body) in posts {
        // Without the header: refused before the key is read.
        let req = request(Method::POST, path, Some(&bridge), None, false, body.clone());
        let refused = expect_error(call(&app, req).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
        assert_eq!(refused["message"], "missing request header", "{path}");
        // With it, the route answers.
        let req = request(Method::POST, path, Some(&bridge), None, true, body);
        let resp = call(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK, "{path}");
    }
    // The poll is a `GET`: it carries the key only.
    let req = request(
        Method::GET,
        "/api/devices/bridge/commands?wait_s=0&limit=1",
        Some(&bridge),
        None,
        false,
        None,
    );
    assert_eq!(call(&app, req).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn files_take_a_raw_body() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@delta.example", "Delta").await;
    let app = with_files(&p);
    let bridge = key(&p, &owner, "device bridge", &["devices.bridge"]).await;
    let upload = |content_type: &str, bytes: Vec<u8>| {
        request(
            Method::POST,
            "/api/devices/bridge/files",
            Some(&bridge),
            None,
            true,
            Some((content_type, bytes)),
        )
    };

    // The body is the file itself: a screenshot, or a pulled file of any bytes. Each upload is a
    // new file, the same bytes again included.
    let shot = ok_json(call(&app, upload("image/png", PNG.to_vec())).await).await;
    let fields: Vec<&String> = shot.as_object().unwrap().keys().collect();
    assert_eq!(fields, ["file_id"]);
    let pulled = ok_json(
        call(
            &app,
            upload("application/octet-stream", b"\x00\x01any bytes".to_vec()),
        )
        .await,
    )
    .await;
    let again = ok_json(call(&app, upload("image/png", PNG.to_vec())).await).await;
    assert_ne!(shot["file_id"], pulled["file_id"]);
    assert_ne!(shot["file_id"], again["file_id"]);

    // A JSON envelope or a multipart form is not a device file; nor is a PNG that is not one.
    let envelope = json!({ "content": "iVBORw0KGgo=" })
        .to_string()
        .into_bytes();
    for (content_type, bytes, field) in [
        ("application/json", envelope, "content_type"),
        (
            "multipart/form-data; boundary=x",
            b"--x--".to_vec(),
            "content_type",
        ),
        ("image/png", b"not a png".to_vec(), "body"),
    ] {
        let body = expect_error(
            call(&app, upload(content_type, bytes)).await,
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION",
        )
        .await;
        assert_eq!(body["details"]["field"], field, "{content_type}");
    }
}

#[tokio::test]
async fn invalid_results_body_is_422_naming_its_field() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@epsilon.example", "Epsilon").await;
    let bridge = key(&p, &owner, "device bridge", &["devices.bridge"]).await;
    // A batch that breaks a limit is a 422 whose `details.field` is the field
    // `ProtocolError::field` names: the one thing of a refusal the bridge logs.
    let req = request(
        Method::POST,
        "/api/devices/bridge/results",
        Some(&bridge),
        None,
        true,
        json_body(&json!({ "results": [] })),
    );
    let body = expect_error(
        p.call(req).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"], json!({ "field": "results" }));
    assert_eq!(body["message"], "results: must have at least one result");
    // So is a register body that breaks one.
    let mut old = register_body();
    old["protocol"] = json!(0);
    let req = request(
        Method::POST,
        "/api/devices/bridge/register",
        Some(&bridge),
        None,
        true,
        json_body(&old),
    );
    let body = expect_error(
        p.call(req).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["field"], "protocol");
}
