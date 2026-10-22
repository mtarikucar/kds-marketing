//! The twin rule, behavioural half for `agents.whoami`: one use case behind two surfaces gives
//! one answer. The same seeded user asks `GET /api/whoami` with their panel session and
//! `jeeta.agent.whoami` with an API key they issued, through the one router the binary serves.
//! Workspace, role and permissions are identical; only the actor differs, by design: the human
//! in the panel, the agent on the human's authority over MCP.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::gate::NoStrategyYet;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_mcp::McpState;
use jt_panel_http::AppState;
use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;
use jt_testkit::fakes::PlainHasher;
use serde_json::{Value, json};
use tower::ServiceExt;

/// The panel's router merged with the MCP endpoint's, as `jeeta serve` builds them.
fn app(deps: &Deps) -> Router {
    let panel = AppState {
        deps: deps.clone(),
        gate: Arc::new(NoStrategyYet),
        cookie_secure: false,
        panel_dir: None,
    };
    let mcp = McpState::new(deps.clone(), Arc::new(NoStrategyYet));
    jt_panel_http::router(panel).merge(jt_mcp::http_service(mcp))
}

async fn send(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
}

async fn json_body(resp: Response) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// A panel request with the session `cookie`, and a JSON `body` when given.
fn panel(method: Method, path: &str, cookie: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("x-requested-with", "jeeta-panel");
    if let Some(cookie) = cookie {
        req = req.header(header::COOKIE, cookie);
    }
    match body {
        Some(body) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    }
}

/// An MCP request with `key` as the bearer, in `session` when given.
fn mcp(key: &str, session: Option<&str>, body: &Value) -> Request<Body> {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "127.0.0.1")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream");
    if let Some(session) = session {
        req = req.header("mcp-session-id", session);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

/// The JSON-RPC message with this id in an SSE response body.
async fn sse_message(resp: Response, id: i64) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|message| message["id"] == id)
        .expect("the response message")
}

#[tokio::test]
async fn whoami_answers_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("alpha").await;
    let deps = Deps {
        uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(PlainHasher),
    };
    let app = app(&deps);

    // The seeded owner signs in to the panel (`fakes::PlainHasher` stored "test").
    let login = json!({ "email": format!("owner+{user}@test.local"), "password": "test" });
    let resp = send(
        &app,
        panel(Method::POST, "/api/auth/login", None, Some(login)),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let cookie = resp.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    // The panel surface.
    let resp = send(&app, panel(Method::GET, "/api/whoami", Some(&cookie), None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let human = json_body(resp).await;

    // The same user issues a key (no scopes: all of their permissions) ...
    let body = json!({ "name": "parity" });
    let resp = send(
        &app,
        panel(Method::POST, "/api/api-keys", Some(&cookie), Some(body)),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let key = json_body(resp).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned();

    // ... and asks the MCP surface.
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "parity-agent", "version": "1.0" },
        },
    });
    let resp = send(&app, mcp(&key, None, &initialize)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let session = resp.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(sse_message(resp, 1).await["result"].is_object());
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = send(&app, mcp(&key, Some(&session), &initialized)).await;
    assert!(resp.status().is_success(), "{}", resp.status());
    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "jeeta.agent.whoami", "arguments": {} },
    });
    let resp = send(&app, mcp(&key, Some(&session), &call)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let result = sse_message(resp, 2).await["result"].clone();
    assert_ne!(result["isError"], json!(true), "{result}");
    let agent = result["structuredContent"].clone();

    // One answer: the same fields, the same workspace, role and permissions.
    let fields = |v: &Value| {
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(fields(&human), fields(&agent));
    assert_eq!(
        fields(&human),
        ["actor", "permissions", "role_key", "workspace_id"]
    );
    for field in ["workspace_id", "role_key", "permissions"] {
        assert_eq!(human[field], agent[field], "{field}");
    }
    assert_eq!(human["workspace_id"], json!(ws.to_string()));
    assert_eq!(human["role_key"], "owner");
    assert_eq!(
        human["permissions"],
        json!([
            "workspace.read",
            "team.manage",
            "api_keys.manage",
            "ledger.read"
        ])
    );

    // The actor differs by design: the human, then the agent on that human's authority.
    assert_eq!(
        human["actor"],
        json!({ "kind": "human", "user_id": user.to_string() })
    );
    assert_eq!(agent["actor"]["kind"], "agent");
    assert_eq!(agent["actor"]["user_id"], json!(user.to_string()));
    assert!(agent["actor"]["connection_id"].is_string());
}
