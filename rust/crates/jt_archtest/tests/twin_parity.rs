//! The twin rule, behavioural half: one use case behind two surfaces gives one answer, through
//! the one router the binary serves.
//!
//! - `agents.whoami`: the same seeded user asks `GET /api/whoami` with their panel session and
//!   `jeeta.agent.whoami` with an API key they issued. Workspace, role and permissions are
//!   identical; only the actor differs, by design: the human in the panel, the agent on the
//!   human's authority over MCP.
//! - `strategy.get`: after an approval, `GET /api/strategy` and `jeeta.strategy.get` answer the
//!   same JSON, field for field.
//! - `capability.list`: after declarations, `GET /api/capabilities` answers the very list
//!   `jeeta.capability.list` answers under `capabilities`.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::capabilities::UowChannelCatalog;
use jt_app::usecases::strategy::NoopArchivedHook;
use jt_mcp::McpState;
use jt_panel_http::AppState;
use jt_pg::{PgStrategyGate, PgUnitOfWork};
use jt_testkit::TestDb;
use jt_testkit::fakes::{PlainHasher, PlainSecretBox, RecordingTenantHosts};
use serde_json::{Value, json};
use tower::ServiceExt;

/// The panel's router merged with the MCP endpoint's over `db`, as `jeeta serve` builds them:
/// the strategy gate answered from the database.
fn app(db: &TestDb, deps: &Deps) -> Router {
    let gate = Arc::new(PgStrategyGate::new(db.pool.clone()));
    let panel = AppState {
        deps: deps.clone(),
        gate: gate.clone(),
        cookie_secure: false,
        panel_dir: None,
    };
    let mcp = McpState::new(deps.clone(), gate);
    jt_panel_http::router(panel).merge(jt_mcp::http_service(mcp))
}

/// The ports over `db`'s pool, the channel catalog over the capability registry as the binary
/// builds it, with a plain-text hasher and secret box.
fn deps(db: &TestDb) -> Deps {
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    Deps {
        uow: uow.clone(),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(PlainHasher),
        seal: Arc::new(PlainSecretBox),
        channels: Arc::new(UowChannelCatalog::new(uow)),
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(RecordingTenantHosts::new()),
    }
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

/// The seeded owner `user` signs in to the panel (`fakes::PlainHasher` stored "test"); returns
/// the `jt_session=…` pair.
async fn sign_in(app: &Router, user: impl std::fmt::Display) -> String {
    let login = json!({ "email": format!("owner+{user}@test.local"), "password": "test" });
    let resp = send(
        app,
        panel(Method::POST, "/api/auth/login", None, Some(login)),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    resp.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

/// A key the signed-in user issues on the panel (no scopes: all of their permissions).
async fn issue_key(app: &Router, cookie: &str) -> String {
    let body = json!({ "name": "parity" });
    let resp = send(
        app,
        panel(Method::POST, "/api/api-keys", Some(cookie), Some(body)),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    json_body(resp).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Opens an MCP session with `key` (initialize, then initialized); returns its id.
async fn mcp_session(app: &Router, key: &str) -> String {
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "parity-agent", "version": "1.0" },
        },
    });
    let resp = send(app, mcp(key, None, &initialize)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let session = resp.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(sse_message(resp, 1).await["result"].is_object());
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = send(app, mcp(key, Some(&session), &initialized)).await;
    assert!(resp.status().is_success(), "{}", resp.status());
    session
}

/// The structured output of tool `name` called with `arguments` in `session`, which must succeed.
async fn call_tool(app: &Router, key: &str, session: &str, name: &str, arguments: Value) -> Value {
    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    let resp = send(app, mcp(key, Some(session), &call)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let result = sse_message(resp, 2).await["result"].clone();
    assert_ne!(result["isError"], json!(true), "{result}");
    result["structuredContent"].clone()
}

#[tokio::test]
async fn whoami_answers_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;

    // The panel surface.
    let resp = send(&app, panel(Method::GET, "/api/whoami", Some(&cookie), None)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let human = json_body(resp).await;

    // The same user issues a key and asks the MCP surface.
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let agent = call_tool(&app, &key, &session, "jeeta.agent.whoami", json!({})).await;

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
            "ledger.read",
            "capabilities.manage",
            "budget.manage"
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

#[tokio::test]
async fn strategy_get_answers_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;

    // The owner works out a strategy on the panel and approves it, then opens the next draft so
    // both halves of the answer are filled.
    let ok = |resp: Response| async move {
        let status = resp.status();
        let body = json_body(resp).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    };
    let post = |path: &str, body: Option<Value>| {
        send(&app, panel(Method::POST, path, Some(&cookie), body))
    };
    let put = |path: String, body: Value| {
        send(&app, panel(Method::PUT, &path, Some(&cookie), Some(body)))
    };
    ok(post("/api/strategy/consultation", None).await).await;
    for (key, value) in [
        ("identity", json!({ "product": "Kahve" })),
        (
            "audience",
            json!([{ "key": "students", "name": "Öğrenciler", "description": "kampüs" }]),
        ),
        (
            "channels",
            json!([{ "channel": "any", "rationale": "her yerde" }]),
        ),
        ("cadence", json!({ "per_week": 3 })),
    ] {
        ok(put(format!("/api/strategy/draft/sections/{key}"), value).await).await;
    }
    let hypotheses = json!([{
        "title": "Sınav haftası",
        "segment_key": "students",
        "angle": "gece açık",
        "channel": "any",
        "metric": "dm",
        "confidence": 0.6,
    }]);
    ok(put("/api/strategy/draft/hypotheses".to_owned(), hypotheses).await).await;
    ok(post("/api/strategy/draft/submit", None).await).await;
    ok(post("/api/strategy/draft/approve", None).await).await;
    ok(post("/api/strategy/consultation", None).await).await;
    ok(put(
        "/api/strategy/draft/sections/prohibitions".to_owned(),
        json!(["rakip adı"]),
    )
    .await)
    .await;

    // The panel surface, then the MCP surface with a key the same owner issued.
    let resp = send(
        &app,
        panel(Method::GET, "/api/strategy", Some(&cookie), None),
    )
    .await;
    let human = ok(resp).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let agent = call_tool(&app, &key, &session, "jeeta.strategy.get", json!({})).await;

    assert_eq!(human, agent);
    assert_eq!(human["approved"]["status"], "approved");
    assert_eq!(human["approved"]["number"], 1);
    assert_eq!(
        human["approved"]["approved_by_email"],
        json!(format!("owner+{user}@test.local"))
    );
    assert_eq!(human["draft"]["number"], 2);
    assert_eq!(
        human["draft"]["sections"]["prohibitions"],
        json!(["rakip adı"])
    );
    assert_eq!(
        human["draft"]["hypotheses"][0]["id"], human["approved"]["hypotheses"][0]["id"],
        "a hypothesis keeps its identity across versions"
    );
    assert_eq!(human["draft"]["hypotheses"][0]["state"], "kept");
    assert!(human["approved"]["id"].is_string());
}

#[tokio::test]
async fn capability_list_answers_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;

    // The owner declares a phone and a mailbox, groups the phone and links it to a cash item,
    // so that every field of the answer is filled somewhere.
    let ok = |resp: Response| async move {
        let status = resp.status();
        let body = json_body(resp).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    };
    let post = |path: String, body: Value| {
        send(&app, panel(Method::POST, &path, Some(&cookie), Some(body)))
    };
    let phone = ok(post(
        "/api/capabilities".into(),
        json!({
            "kind_key": "phone",
            "name": "Saha telefonu",
            "policy": { "daily_ops_cap": 40, "requires_human_approval": true },
        }),
    )
    .await)
    .await;
    let phone_id = phone["capability"]["id"].as_str().unwrap().to_owned();
    ok(post(
        "/api/capabilities".into(),
        json!({
            "kind_key": "mailbox",
            "name": "Destek kutusu",
            "external_id": "destek@alpha.example",
            "connector_public": { "hosts": ["imap.alpha.example"] },
        }),
    )
    .await)
    .await;
    let group = ok(post("/api/capability-groups".into(), json!({ "name": "Saha" })).await).await;
    let group_id = group["group"]["id"].as_str().unwrap().to_owned();
    ok(post(
        format!("/api/capability-groups/{group_id}/members"),
        json!({ "capability_id": phone_id }),
    )
    .await)
    .await;
    let item = ok(post(
        "/api/budget/items".into(),
        json!({
            "name": "Nakit",
            "kind": "cash",
            "unit": { "kind": "currency", "value": "TRY" },
            "cap": 100000,
            "period": "monthly",
        }),
    )
    .await)
    .await;
    ok(post(
        format!("/api/capabilities/{phone_id}/budget-links"),
        json!({ "budget_item_id": item["item"]["id"] }),
    )
    .await)
    .await;

    // The panel surface, then the MCP surface with a key the same owner issued.
    let human = ok(send(
        &app,
        panel(Method::GET, "/api/capabilities", Some(&cookie), None),
    )
    .await)
    .await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let agent = call_tool(&app, &key, &session, "jeeta.capability.list", json!({})).await;

    assert_eq!(agent, json!({ "capabilities": human }));
    assert_eq!(human.as_array().unwrap().len(), 2);
    assert_eq!(human[0]["capability"]["id"], json!(phone_id));
    assert_eq!(human[0]["capability"]["policy"]["daily_ops_cap"], 40);
    assert_eq!(
        human[0]["capability"]["budget_item_ids"],
        json!([item["item"]["id"]])
    );
    assert_eq!(human[1]["capability"]["reach"], "connector");

    // Filtered the same way on both gates, the answers still agree.
    let human = ok(send(
        &app,
        panel(
            Method::GET,
            &format!("/api/capabilities?group_id={group_id}"),
            Some(&cookie),
            None,
        ),
    )
    .await)
    .await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.list",
        json!({ "group_id": group_id }),
    )
    .await;
    assert_eq!(agent, json!({ "capabilities": human }));
    assert_eq!(human.as_array().unwrap().len(), 1);
}
