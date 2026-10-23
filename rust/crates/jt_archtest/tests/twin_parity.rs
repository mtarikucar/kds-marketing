//! The twin rule, behavioural half: one use case behind two surfaces gives one answer, through
//! the one router the binary serves.
//!
//! - `agents.whoami`: the same seeded user asks `GET /api/whoami` with their panel session and
//!   `jeeta.agent.whoami` with an API key they issued. Workspace, role and permissions are
//!   identical; only the actor differs, by design: the human in the panel, the agent on the
//!   human's authority over MCP.
//! - `strategy.get`: after an approval, `GET /api/strategy` and `jeeta.strategy.get` answer the
//!   same JSON, field for field.
//! - `strategy.archive`: archiving the version in force answers `{version_id, archived: true}` on
//!   both surfaces (each archives a version of its own: one can be archived only once), and the
//!   same error once nothing is left to archive.
//! - `strategy.approve`: approving a draft submitted again since it was read answers the same
//!   `CONFLICT` on both surfaces, naming the draft as it now stands.
//! - `capability.list`: after declarations, `GET /api/capabilities` answers the very list
//!   `jeeta.capability.list` answers under `capabilities`.
//! - `capability.unlink_budget`, `capability.groups.remove_member`, `capability.groups.delete`:
//!   the panel's `DELETE` routes answer the JSON their MCP tools answer for the same ids (the
//!   capability, the group, the deletion confirmed), and the same error once the group is gone.
//! - `capability.update`, `budget.items.update`, `budget.items.retire`: an edit on either gate
//!   answers what the other gate then reads (with `verification_reset` for a capability, a
//!   connector's changed account resetting it on both), and both gates give the same refusals:
//!   an edit naming nothing, a taken account, a retired item, a missing confirmation, and a body
//!   naming a field an edit does not take.
//! - `connector.health`, `connector.probe`: a NetGSM line connected on the panel (credentials
//!   entered by hand, a scripted adapter answering the probes) reads the same health on both
//!   gates, a probe answers the same outcome and status on both, failed or not, and both refuse
//!   an unknown capability alike.
//! - `events.pending`, `events.ack`, `events.list`: pages of inbound events (and the page after
//!   a cursor) read the same on both gates, an acknowledgement on either answers alike and shows
//!   on the other, and a half cursor is refused alike.
//! - `connector.hooks`: the webhook addresses (the Meta webhook and the workspace's NetGSM
//!   callback URLs with their tokens) read the same on both gates.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::ports::connectors::ConnectorRegistry;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::capabilities::UowChannelCatalog;
use jt_app::usecases::strategy::NoopArchivedHook;
use jt_connector::{ConnectorError, ProbeResult, Provider};
use jt_mcp::McpState;
use jt_panel_http::AppState;
use jt_pg::{PgStrategyGate, PgUnitOfWork};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, PlainHasher, PlainSecretBox, RecordingTenantHosts, ScriptedConnector,
    ScriptedRegistry,
};
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
/// builds it, with a plain-text hasher and secret box, and no provider adapter.
fn deps(db: &TestDb) -> Deps {
    deps_with(db, Arc::new(ScriptedRegistry::new()))
}

/// [`deps`] with these provider adapters.
fn deps_with(db: &TestDb, connectors: Arc<dyn ConnectorRegistry>) -> Deps {
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
        apps: Arc::new(FakeAppConfig::default()),
        connectors,
        job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
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

/// The `result` of tool `name` called with `arguments` in `session`, failed or not. Each call
/// has a JSON-RPC id of its own.
async fn tool_result(
    app: &Router,
    key: &str,
    session: &str,
    name: &str,
    arguments: Value,
) -> Value {
    static NEXT_ID: AtomicI64 = AtomicI64::new(2);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let call = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    let resp = send(app, mcp(key, Some(session), &call)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    sse_message(resp, id).await["result"].clone()
}

/// The structured output of tool `name` called with `arguments` in `session`, which must succeed.
async fn call_tool(app: &Router, key: &str, session: &str, name: &str, arguments: Value) -> Value {
    let result = tool_result(app, key, session, name, arguments).await;
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
            "budget.manage",
            "inbox.work",
            "inbox.manage"
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
async fn strategy_get_and_archive_answer_the_same_over_the_panel_and_mcp() {
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
    let as_read = |draft: &Value| {
        Some(json!({ "version_id": draft["id"], "submitted_at": draft["submitted_at"] }))
    };
    let submitted = ok(post("/api/strategy/draft/submit", None).await).await;
    ok(post("/api/strategy/draft/approve", as_read(&submitted)).await).await;
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

    // Archiving: the agent archives version 1; the owner approves the open draft as version 2
    // and archives it on the panel. Both answer the same confirmation for their own version.
    let first = human["approved"]["id"].clone();
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.strategy.archive",
        json!({ "version_id": first, "confirm": true }),
    )
    .await;
    assert_eq!(agent, json!({ "version_id": first, "archived": true }));
    let read = ok(post("/api/strategy/draft/submit", None).await).await;

    // Approving a draft that changed since it was read: the same refusal on both surfaces.
    let submitted = ok(post("/api/strategy/draft/submit", None).await).await;
    let resp = post("/api/strategy/draft/approve", as_read(&read)).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let human = json_body(resp).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.strategy.approve",
        as_read(&read).unwrap(),
    )
    .await;
    assert_eq!(agent["isError"], json!(true));
    assert_eq!(human, agent["structuredContent"]);
    assert_eq!(human["message"], "the draft changed since you read it");
    assert_eq!(
        human["details"],
        json!({ "version_id": submitted["id"], "submitted_at": submitted["submitted_at"] })
    );

    let second =
        ok(post("/api/strategy/draft/approve", as_read(&submitted)).await).await["id"].clone();
    let resp = post(
        "/api/strategy/archive",
        Some(json!({ "version_id": second, "confirm": true })),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let human = json_body(resp).await;
    assert_eq!(human, json!({ "version_id": second, "archived": true }));

    // Nothing is left to archive: the same refusal on both surfaces.
    let resp = post(
        "/api/strategy/archive",
        Some(json!({ "version_id": second, "confirm": true })),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let human = json_body(resp).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.strategy.archive",
        json!({ "version_id": second, "confirm": true }),
    )
    .await;
    assert_eq!(agent["isError"], json!(true));
    assert_eq!(human, agent["structuredContent"]);
    assert_eq!(human["code"], "CONFLICT");
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

#[tokio::test]
async fn capability_mutations_answer_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;

    let ok = |resp: Response| async move {
        let status = resp.status();
        let body = json_body(resp).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    };
    let post = |path: String, body: Value| {
        send(&app, panel(Method::POST, &path, Some(&cookie), Some(body)))
    };
    let delete = |path: String| send(&app, panel(Method::DELETE, &path, Some(&cookie), None));

    // A phone in two groups, spending from a cash item.
    let phone = ok(post(
        "/api/capabilities".into(),
        json!({ "kind_key": "phone", "name": "Saha telefonu" }),
    )
    .await)
    .await;
    let phone_id = phone["capability"]["id"].as_str().unwrap().to_owned();
    let mut group_ids = Vec::new();
    for name in ["Saha", "Kampanya"] {
        let group = ok(post("/api/capability-groups".into(), json!({ "name": name })).await).await;
        let group_id = group["group"]["id"].as_str().unwrap().to_owned();
        ok(post(
            format!("/api/capability-groups/{group_id}/members"),
            json!({ "capability_id": phone_id }),
        )
        .await)
        .await;
        group_ids.push(group_id);
    }
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
    let item_id = item["item"]["id"].as_str().unwrap().to_owned();
    let link = || {
        post(
            format!("/api/capabilities/{phone_id}/budget-links"),
            json!({ "budget_item_id": item_id }),
        )
    };
    ok(link().await).await;

    // Unlinking: the panel, then (linked again) the agent, for the same pair.
    let human = ok(delete(format!(
        "/api/capabilities/{phone_id}/budget-links/{item_id}"
    ))
    .await)
    .await;
    ok(link().await).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.unlink_budget",
        json!({ "capability_id": phone_id, "budget_item_id": item_id }),
    )
    .await;
    assert_eq!(human, agent);
    assert_eq!(human["capability"]["budget_item_ids"], json!([]));

    // Removing a member: the same group and capability on both gates.
    let group_id = &group_ids[0];
    let member = json!({ "capability_id": phone_id });
    let human = ok(delete(format!(
        "/api/capability-groups/{group_id}/members/{phone_id}"
    ))
    .await)
    .await;
    ok(post(format!("/api/capability-groups/{group_id}/members"), member).await).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.groups_remove_member",
        json!({ "group_id": group_id, "capability_id": phone_id }),
    )
    .await;
    assert_eq!(human, agent);
    assert_eq!(human["group"]["id"], json!(group_id));
    assert_eq!(human["members"], json!([]));

    // Deleting: each gate confirms its own group the same way, and the same group once gone is
    // the same error on both.
    let human = ok(delete(format!("/api/capability-groups/{group_id}")).await).await;
    assert_eq!(human, json!({ "group_id": group_id, "deleted": true }));
    let other = &group_ids[1];
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.groups_delete",
        json!({ "group_id": other }),
    )
    .await;
    assert_eq!(agent, json!({ "group_id": other, "deleted": true }));
    let resp = delete(format!("/api/capability-groups/{group_id}")).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let human = json_body(resp).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.capability.groups_delete",
        json!({ "group_id": group_id }),
    )
    .await;
    assert_eq!(agent["isError"], json!(true));
    assert_eq!(human, agent["structuredContent"]);
    assert_eq!(human["code"], "NOT_FOUND");
}

/// `read` (a capability as `capability.get` answers it) with `verification_reset`, as
/// `capability.update` answers it.
fn with_reset(read: &Value, reset: bool) -> Value {
    let mut out = read.clone();
    out["verification_reset"] = json!(reset);
    out
}

/// The entry of budget item `id` in a list of budget items.
fn entry(items: &Value, id: &str) -> Value {
    items
        .as_array()
        .unwrap_or_else(|| panic!("not a list: {items}"))
        .iter()
        .find(|e| e["item"]["id"] == id)
        .unwrap_or_else(|| panic!("no item {id} in {items}"))
        .clone()
}

#[tokio::test]
async fn capability_update_answers_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;

    let ok = |resp: Response| async move {
        let status = resp.status();
        let body = json_body(resp).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    };
    let post = |path: String, body: Value| {
        send(&app, panel(Method::POST, &path, Some(&cookie), Some(body)))
    };
    let patch = |path: String, body: Value| {
        send(&app, panel(Method::PATCH, &path, Some(&cookie), Some(body)))
    };
    let get = |path: String| send(&app, panel(Method::GET, &path, Some(&cookie), None));
    let declare = |body: Value| async {
        let out = ok(post("/api/capabilities".into(), body).await).await;
        out["capability"]["id"].as_str().unwrap().to_owned()
    };

    // A device: the panel renames it and answers what the agent then reads; the agent edits its
    // description and answers what the panel then reads.
    let phone =
        declare(json!({ "kind_key": "phone", "name": "Telefon", "external_id": "SN-1" })).await;
    let human = ok(patch(
        format!("/api/capabilities/{phone}"),
        json!({ "name": "Saha telefonu" }),
    )
    .await)
    .await;
    let read = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.get",
        json!({ "capability_id": phone }),
    )
    .await;
    assert_eq!(human, with_reset(&read, false));
    assert_eq!(human["capability"]["name"], "Saha telefonu");
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.update",
        json!({ "capability_id": phone, "description": "Kampanya telefonu" }),
    )
    .await;
    let read = ok(get(format!("/api/capabilities/{phone}")).await).await;
    assert_eq!(agent, with_reset(&read, false));
    assert_eq!(agent["capability"]["description"], "Kampanya telefonu");

    // A connector's account changes the same way on both: its verification is reset.
    let inbox = declare(json!({
        "kind_key": "mailbox",
        "name": "Destek",
        "external_id": "destek@alpha.example",
    }))
    .await;
    let human = ok(patch(
        format!("/api/capabilities/{inbox}"),
        json!({ "external_id": "yardim@alpha.example" }),
    )
    .await)
    .await;
    let read = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.get",
        json!({ "capability_id": inbox }),
    )
    .await;
    assert_eq!(human, with_reset(&read, true));
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.update",
        json!({ "capability_id": inbox, "external_id": "info@alpha.example" }),
    )
    .await;
    let read = ok(get(format!("/api/capabilities/{inbox}")).await).await;
    assert_eq!(agent, with_reset(&read, true));
    assert_eq!(agent["capability"]["status"], "declared");

    // The same refusals on both gates: an edit naming nothing, an account another phone holds.
    let other =
        declare(json!({ "kind_key": "phone", "name": "Yedek", "external_id": "SN-2" })).await;
    for (body, code) in [
        (json!({}), "VALIDATION"),
        (json!({ "external_id": "SN-1" }), "CONFLICT"),
    ] {
        let resp = patch(format!("/api/capabilities/{other}"), body.clone()).await;
        let status = resp.status();
        let human = json_body(resp).await;
        let mut args = body.clone();
        args["capability_id"] = json!(other);
        let agent = tool_result(&app, &key, &session, "jeeta.capability.update", args).await;
        assert_eq!(agent["isError"], json!(true), "{body}");
        assert_eq!(human, agent["structuredContent"], "{body}");
        assert_eq!(human["code"], code, "{status} {body}");
    }
    // A body naming the public fields (a key only connectors write among them), or any other
    // field an edit does not take, is VALIDATION on both before the use case runs.
    for body in [
        json!({ "connector_public": { "health": { "ok": true } } }),
        json!({ "name": "x", "kind_key": "printer" }),
    ] {
        let resp = patch(format!("/api/capabilities/{other}"), body.clone()).await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        let human = json_body(resp).await;
        let mut args = body.clone();
        args["capability_id"] = json!(other);
        let agent = tool_result(&app, &key, &session, "jeeta.capability.update", args).await;
        assert_eq!(human["code"], "VALIDATION", "{body}");
        assert_eq!(agent["structuredContent"]["code"], "VALIDATION", "{body}");
    }
    let read = ok(get(format!("/api/capabilities/{other}")).await).await;
    assert_eq!(read["capability"]["name"], "Yedek");
    assert_eq!(read["capability"]["external_id"], "SN-2");
}

#[tokio::test]
async fn budget_item_edits_answer_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;

    let ok = |resp: Response| async move {
        let status = resp.status();
        let body = json_body(resp).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    };
    let post = |path: String, body: Value| {
        send(&app, panel(Method::POST, &path, Some(&cookie), Some(body)))
    };
    let patch = |path: String, body: Value| {
        send(&app, panel(Method::PATCH, &path, Some(&cookie), Some(body)))
    };
    let list = || {
        send(
            &app,
            panel(Method::GET, "/api/budget/items", Some(&cookie), None),
        )
    };
    let create = |name: &'static str| async move {
        let body = json!({
            "name": name,
            "kind": "cash",
            "unit": { "kind": "currency", "value": "TRY" },
            "cap": 100000,
            "period": "monthly",
        });
        let out = ok(post("/api/budget/items".into(), body).await).await;
        out["item"]["id"].as_str().unwrap().to_owned()
    };
    let first = create("Nakit A").await;
    let second = create("Nakit B").await;
    let third = create("Nakit C").await;
    // The first item is spent from by a phone, so retiring it removes a link.
    let phone = ok(post(
        "/api/capabilities".into(),
        json!({ "kind_key": "phone", "name": "Telefon" }),
    )
    .await)
    .await;
    let phone_id = phone["capability"]["id"].as_str().unwrap().to_owned();
    ok(post(
        format!("/api/capabilities/{phone_id}/budget-links"),
        json!({ "budget_item_id": first }),
    )
    .await)
    .await;

    // Editing: each gate's answer is the item as the other gate then lists it.
    let human = ok(patch(
        format!("/api/budget/items/{first}"),
        json!({ "cap": 5000, "period": "weekly" }),
    )
    .await)
    .await;
    let listed = call_tool(&app, &key, &session, "jeeta.budget.items_list", json!({})).await;
    assert_eq!(human, entry(&listed["items"], &first));
    assert_eq!(
        (
            human["item"]["cap"].clone(),
            human["item"]["period"].clone()
        ),
        (json!(5000), json!("weekly"))
    );
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.budget.items_update",
        json!({ "budget_item_id": second, "cap": 5000, "period": "weekly" }),
    )
    .await;
    let listed = ok(list().await).await;
    assert_eq!(agent, entry(&listed, &second));

    // Retiring: the same, with its retirement time; the phone's link goes.
    let human = ok(post(
        format!("/api/budget/items/{first}/retire"),
        json!({ "confirm": true }),
    )
    .await)
    .await;
    assert!(human["item"]["retired_at"].is_string(), "{human}");
    let listed = call_tool(&app, &key, &session, "jeeta.budget.items_list", json!({})).await;
    assert_eq!(human, entry(&listed["items"], &first));
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.budget.items_retire",
        json!({ "budget_item_id": second, "confirm": true }),
    )
    .await;
    let listed = ok(list().await).await;
    assert_eq!(agent, entry(&listed, &second));
    let phone = call_tool(
        &app,
        &key,
        &session,
        "jeeta.capability.get",
        json!({ "capability_id": phone_id }),
    )
    .await;
    assert_eq!(phone["capability"]["budget_item_ids"], json!([]));

    // The same refusals on both gates: retiring again, editing or spending from a retired item,
    // retiring without the confirmation, an edit naming nothing.
    let refusals: Vec<(Method, String, Value, &str, Value, &str)> = vec![
        (
            Method::POST,
            format!("/api/budget/items/{first}/retire"),
            json!({ "confirm": true }),
            "jeeta.budget.items_retire",
            json!({ "budget_item_id": first, "confirm": true }),
            "CONFLICT",
        ),
        (
            Method::PATCH,
            format!("/api/budget/items/{first}"),
            json!({ "cap": 1 }),
            "jeeta.budget.items_update",
            json!({ "budget_item_id": first, "cap": 1 }),
            "CONFLICT",
        ),
        (
            Method::POST,
            format!("/api/budget/items/{first}/spend"),
            json!({ "amount": 1 }),
            "jeeta.budget.spend_record",
            json!({ "budget_item_id": first, "amount": 1 }),
            "CONFLICT",
        ),
        (
            Method::POST,
            format!("/api/budget/items/{third}/retire"),
            json!({}),
            "jeeta.budget.items_retire",
            json!({ "budget_item_id": third }),
            "VALIDATION",
        ),
        (
            Method::PATCH,
            format!("/api/budget/items/{third}"),
            json!({}),
            "jeeta.budget.items_update",
            json!({ "budget_item_id": third }),
            "VALIDATION",
        ),
    ];
    for (method, path, body, tool, args, code) in refusals {
        let resp = send(&app, panel(method, &path, Some(&cookie), Some(body))).await;
        let human = json_body(resp).await;
        let agent = tool_result(&app, &key, &session, tool, args).await;
        assert_eq!(agent["isError"], json!(true), "{tool}");
        assert_eq!(human, agent["structuredContent"], "{tool}");
        assert_eq!(human["code"], code, "{tool}: {human}");
    }
    // A body naming the kind or the unit is VALIDATION on both before the use case runs.
    for body in [
        json!({ "kind": "ad_budget" }),
        json!({ "unit": { "kind": "minutes" } }),
    ] {
        let resp = patch(format!("/api/budget/items/{third}"), body.clone()).await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        let mut args = body.clone();
        args["budget_item_id"] = json!(third);
        let agent = tool_result(&app, &key, &session, "jeeta.budget.items_update", args).await;
        assert_eq!(agent["structuredContent"]["code"], "VALIDATION", "{body}");
    }
    let listed = ok(list().await).await;
    let untouched = entry(&listed, &third);
    assert_eq!(untouched["item"]["kind"], "cash");
    assert_eq!(untouched["item"]["retired_at"], Value::Null);
}

#[tokio::test]
async fn connector_health_and_probe_answer_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("alpha").await;
    let netgsm =
        Arc::new(ScriptedConnector::new(Provider::Netgsm).with_hosts(&["api.netgsm.com.tr"]));
    let deps = deps_with(
        &db,
        Arc::new(ScriptedRegistry::new().with_connector(netgsm.clone())),
    );
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let ok = |account: &str| ProbeResult::success(42, json!({ "account_id": account }));

    // The owner connects a NetGSM line on the panel; its first probe verifies it.
    netgsm.push_probe(ok("8508001234"));
    let body = json!({
        "kind_key": "sms_line",
        "name": "SMS hattı",
        "credential": {
            "kind": "netgsm_sms",
            "usercode": "8508001234",
            "password": "netgsm-pass-1",
            "msgheader": "ALFA",
        },
    });
    let resp = send(
        &app,
        panel(
            Method::POST,
            "/api/connectors/credentials",
            Some(&cookie),
            Some(body),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let id = json_body(resp).await["capability"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let health = |cookie: String| {
        let app = app.clone();
        async move {
            let resp = send(
                &app,
                panel(Method::GET, "/api/connectors/health", Some(&cookie), None),
            )
            .await;
            assert_eq!(resp.status(), StatusCode::OK);
            json_body(resp).await
        }
    };
    let human = health(cookie.clone()).await;
    let agent = call_tool(&app, &key, &session, "jeeta.connector.health", json!({})).await;
    assert_eq!(human, agent["connectors"]);
    assert_eq!(human.as_array().unwrap().len(), 1);
    assert_eq!(human[0]["ok"], true);

    // A probe that succeeds, then one that fails with Auth: each answers the same on both gates.
    let probe_path = format!("/api/connectors/{id}/probe");
    for result in [
        ok("8508001234"),
        ProbeResult::failure(30, ConnectorError::auth("bad credentials")),
    ] {
        netgsm.push_probe(result.clone());
        netgsm.push_probe(result);
        let resp = send(&app, panel(Method::POST, &probe_path, Some(&cookie), None)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let human = json_body(resp).await;
        let agent = call_tool(
            &app,
            &key,
            &session,
            "jeeta.connector.probe",
            json!({ "capability_id": id }),
        )
        .await;
        assert_eq!(human, agent);
    }
    let human = health(cookie.clone()).await;
    let agent = call_tool(&app, &key, &session, "jeeta.connector.health", json!({})).await;
    assert_eq!(human, agent["connectors"]);
    assert_eq!(human[0]["status"], "unreachable");
    assert_eq!(human[0]["error_kind"], "auth");
    assert_eq!(human[0]["reconnect_required"], true);

    // An unknown capability: the same refusal on both gates.
    let unknown = "0192f0c4-0000-7000-8000-000000000000";
    let resp = send(
        &app,
        panel(
            Method::POST,
            &format!("/api/connectors/{unknown}/probe"),
            Some(&cookie),
            None,
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let human = json_body(resp).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.connector.probe",
        json!({ "capability_id": unknown }),
    )
    .await;
    assert_eq!(agent["isError"], json!(true));
    assert_eq!(human, agent["structuredContent"]);
}

#[tokio::test]
async fn events_pending_and_ack_answer_the_same_over_the_panel_and_mcp() {
    use jt_connector::{EventKind, InboundEvent, InboundEventId};
    use jt_testkit::fakes::FIXED_NOW;

    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("alpha").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;

    // Four events came in, a minute apart.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let mut ids = Vec::new();
    for i in 0..4 {
        let id = InboundEventId::new_v7();
        t.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: ws,
                    provider: Provider::Meta,
                    capability_id: None,
                    external_id: format!("wamid.{i}"),
                    kind: EventKind::Message,
                    payload: json!({ "message": { "n": i } }),
                    received_at: FIXED_NOW + std::time::Duration::from_secs(60 * i),
                    processed_at: None,
                },
                Some(b"raw".to_vec()),
            )
            .await
            .unwrap();
        ids.push(id.to_string());
    }
    t.commit().await.unwrap();

    let get = |path: String| {
        let app = app.clone();
        let cookie = cookie.clone();
        async move {
            let resp = send(&app, panel(Method::GET, &path, Some(&cookie), None)).await;
            assert_eq!(resp.status(), StatusCode::OK);
            json_body(resp).await
        }
    };
    // One page, then the next from its cursor: the same JSON on both gates.
    let human = get("/api/events/pending?limit=3".into()).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.events.pending",
        json!({ "limit": 3 }),
    )
    .await;
    assert_eq!(human, agent);
    assert_eq!(human["events"].as_array().unwrap().len(), 3);
    let next = &human["next"];
    let human = get(format!(
        "/api/events/pending?after_at={}&after_id={}",
        next["after_at"].as_str().unwrap(),
        next["after_id"].as_str().unwrap()
    ))
    .await;
    let agent = call_tool(&app, &key, &session, "jeeta.events.pending", next.clone()).await;
    assert_eq!(human, agent);
    assert_eq!(human["events"][0]["id"], json!(ids[3]));

    // Acknowledging on either gate answers alike, and the other gate then reads the result.
    let resp = send(
        &app,
        panel(
            Method::POST,
            "/api/events/ack",
            Some(&cookie),
            Some(json!({ "ids": [ids[0]] })),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let human = json_body(resp).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.events.ack",
        json!({ "ids": [ids[1]] }),
    )
    .await;
    assert_eq!(human, json!({ "acked": 1 }));
    assert_eq!(human, agent);
    let human = get("/api/events/pending".into()).await;
    let agent = call_tool(&app, &key, &session, "jeeta.events.pending", json!({})).await;
    assert_eq!(human, agent);
    assert_eq!(human["events"].as_array().unwrap().len(), 2);
    let human = get("/api/events?include_processed=true".into()).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.events.list",
        json!({ "include_processed": true }),
    )
    .await;
    assert_eq!(human, agent);

    // The same refusal for a half cursor.
    let resp = send(
        &app,
        panel(
            Method::GET,
            "/api/events/pending?after_id=0192f0c4-0000-7000-8000-000000000000",
            Some(&cookie),
            None,
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let human = json_body(resp).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.events.pending",
        json!({ "after_id": "0192f0c4-0000-7000-8000-000000000000" }),
    )
    .await;
    assert_eq!(agent["isError"], json!(true));
    assert_eq!(human, agent["structuredContent"]);
}

#[tokio::test]
async fn connector_hooks_answer_the_same_over_the_panel_and_mcp() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("alpha").await;
    let mut deps = deps(&db);
    deps.apps = Arc::new(FakeAppConfig::with_all_apps());
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;

    let resp = send(
        &app,
        panel(Method::GET, "/api/connectors/hooks", Some(&cookie), None),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let human = json_body(resp).await;
    let agent = call_tool(&app, &key, &session, "jeeta.connector.hooks", json!({})).await;
    assert_eq!(human, agent);
    assert_eq!(human["meta"]["url"], "https://panel.test/hooks/meta");
    assert_eq!(
        human["meta"]["verify_token_hint"],
        "set in the Meta app dashboard"
    );
    assert_eq!(human["netgsm"].as_array().unwrap().len(), 5);
    assert!(
        human["netgsm"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with(&format!("https://panel.test/hooks/netgsm/{ws}/"))
    );
    assert!(!human.to_string().contains("meta-verify-token"));
}

async fn approve_inbox_strategy(app: &Router, cookie: &str) {
    async fn ok(response: Response) -> Value {
        let status = response.status();
        let body = json_body(response).await;
        assert!(status.is_success(), "{status}: {body}");
        body
    }
    ok(send(
        app,
        panel(
            Method::POST,
            "/api/strategy/consultation",
            Some(cookie),
            None,
        ),
    )
    .await)
    .await;
    for (key, value) in [
        ("identity", json!({"product":"Service"})),
        (
            "audience",
            json!([{"key":"all","name":"Everyone","description":"Local"}]),
        ),
        (
            "channels",
            json!([{"channel":"any","rationale":"Available"}]),
        ),
        ("cadence", json!({"per_week":3})),
    ] {
        ok(send(
            app,
            panel(
                Method::PUT,
                &format!("/api/strategy/draft/sections/{key}"),
                Some(cookie),
                Some(value),
            ),
        )
        .await)
        .await;
    }
    ok(send(app,panel(Method::PUT,"/api/strategy/draft/hypotheses",Some(cookie),Some(json!([{"title":"Contact","segment_key":"all","angle":"Help","channel":"any","metric":"dm","confidence":0.6}])))).await).await;
    let draft = ok(send(
        app,
        panel(
            Method::POST,
            "/api/strategy/draft/submit",
            Some(cookie),
            None,
        ),
    )
    .await)
    .await;
    ok(send(
        app,
        panel(
            Method::POST,
            "/api/strategy/draft/approve",
            Some(cookie),
            Some(json!({"version_id":draft["id"],"submitted_at":draft["submitted_at"]})),
        ),
    )
    .await)
    .await;
}

#[tokio::test]
async fn inbox_people_get_and_events_report_have_http_mcp_parity() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("inbox-parity").await;
    let mut deps = deps(&db);
    deps.clock = Arc::new(jt_testkit::fakes::FixedClock(deps.clock.now()));
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let resp = send(
        &app,
        panel(Method::GET, "/api/inbox/people", Some(&cookie), None),
    )
    .await;
    assert_eq!(json_body(resp).await["code"], "STRATEGY_REQUIRED");
    approve_inbox_strategy(&app, &cookie).await;
    let resp=send(&app,panel(Method::POST,"/api/inbox/people",Some(&cookie),Some(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})))).await;
    let status = resp.status();
    let created = json_body(resp).await;
    assert!(status.is_success(), "{status}: {created}");
    let person = created["person"]["id"].as_str().unwrap();
    let path = format!("/api/inbox/people/{person}");
    let human = json_body(send(&app, panel(Method::GET, &path, Some(&cookie), None)).await).await;
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.inbox.people_get",
        json!({"person_id":person}),
    )
    .await;
    assert_eq!(human, agent);
    let journey = human["open_journey"]["id"].as_str().unwrap();
    let path = format!("/api/inbox/journeys/{journey}/events");
    let reason = send(
        &app,
        panel(
            Method::PUT,
            "/api/inbox/lost-reasons",
            Some(&cookie),
            Some(json!({"key":"fiyat","label":"Fiyat","active":true})),
        ),
    )
    .await;
    assert_eq!(reason.status(), StatusCode::OK);
    let input =
        json!({"kind":"lost","idempotency_key":"parity-loss","payload":{"reason_key":"fiyat"}});
    let first = json_body(
        send(
            &app,
            panel(Method::POST, &path, Some(&cookie), Some(input.clone())),
        )
        .await,
    )
    .await;
    assert_eq!(first["transition"]["patch"]["status"], "lost", "{first}");
    assert_eq!(
        first["effects"],
        json!(["close_conversations", "cancel_open_tasks"])
    );
    let second = call_tool(&app, &key, &session, "jeeta.inbox.people_create", json!({"display_name":"Grace","identities":[{"channel":"phone","value":"05321234568"}],"source":"form"})).await;
    let second = call_tool(
        &app,
        &key,
        &session,
        "jeeta.inbox.people_get",
        json!({"person_id":second["person"]["id"]}),
    )
    .await;
    let second = call_tool(&app, &key, &session, "jeeta.inbox.events_report", json!({"journey_id":second["open_journey"]["id"],"kind":"lost","idempotency_key":"parity-loss-second","payload":{"reason_key":"fiyat"}})).await;
    assert_eq!(
        first, second,
        "successful transition and effects are identical across surfaces"
    );
    let repeat = json_body(
        send(
            &app,
            panel(Method::POST, &path, Some(&cookie), Some(input.clone())),
        )
        .await,
    )
    .await;
    let mut args = input;
    args["journey_id"] = json!(journey);
    let agent = call_tool(&app, &key, &session, "jeeta.inbox.events_report", args).await;
    assert_eq!(repeat, agent);
    assert_eq!(
        agent,
        json!({"transition":null,"effects":[],"duplicate":true})
    );
    for input in [
        json!({"kind":"meeting_held","payload":{}}),
        json!({"kind":"replied","idempotency_key":"system","payload":{}}),
        json!({"kind":"lost","idempotency_key":"invalid","payload":{"reason_key":"fiyat","reason_label":"forged"}}),
    ] {
        let human = json_body(
            send(
                &app,
                panel(Method::POST, &path, Some(&cookie), Some(input.clone())),
            )
            .await,
        )
        .await;
        let mut args = input;
        args["journey_id"] = json!(journey);
        let agent = tool_result(&app, &key, &session, "jeeta.inbox.events_report", args).await;
        assert_eq!(human["code"], "VALIDATION", "{human}");
        assert_eq!(human["code"], agent["structuredContent"]["code"]);
    }
}

#[tokio::test]
async fn inbox_status_labels_have_http_mcp_parity_and_persist() {
    use jt_app::ports::UnitOfWork;
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("labels-parity").await;
    let deps = deps(&db);
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    approve_inbox_strategy(&app, &cookie).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    let input = json!({"labels":{"new":"Yeni","won":"Kazanıldı"}});
    let response = send(
        &app,
        panel(
            Method::PUT,
            "/api/inbox/status-labels",
            Some(&cookie),
            Some(input.clone()),
        ),
    )
    .await;
    let status = response.status();
    let human = json_body(response).await;
    assert_eq!(status, StatusCode::OK, "{human}");
    let agent = call_tool(
        &app,
        &key,
        &session,
        "jeeta.inbox.status_labels_set",
        input.clone(),
    )
    .await;
    assert_eq!(human, agent);
    assert_eq!(human, input);
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut repos = uow.tenant(ws).await.unwrap();
    let stored = serde_json::to_value(repos.workspace_policy().get().await.unwrap()).unwrap();
    assert_eq!(stored["inbox_status_labels"], input["labels"]);
    drop(repos);
    for invalid in [
        json!({"labels":{"custom_stage":"Custom"}}),
        json!({"labels":{"new":" "}}),
        json!({"labels":{"new":"New"},"status":"won"}),
    ] {
        let response = send(
            &app,
            panel(
                Method::PUT,
                "/api/inbox/status-labels",
                Some(&cookie),
                Some(invalid.clone()),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let human = json_body(response).await;
        let agent = tool_result(
            &app,
            &key,
            &session,
            "jeeta.inbox.status_labels_set",
            invalid,
        )
        .await;
        assert_eq!(human["code"], "VALIDATION");
        assert_eq!(agent["structuredContent"]["code"], human["code"]);
    }
    let mut repos = uow.tenant(ws).await.unwrap();
    let after = serde_json::to_value(repos.workspace_policy().get().await.unwrap()).unwrap();
    assert_eq!(after, stored);
}

#[tokio::test]
async fn inbox_merges_apply_and_tasks_list_have_http_mcp_parity() {
    let db = TestDb::new().await;
    let (_, user) = db.seed_workspace("merge-task-parity").await;
    let mut deps = deps(&db);
    let now = jt_testkit::fakes::FIXED_NOW;
    deps.clock = Arc::new(jt_testkit::fakes::FixedClock(now));
    let app = app(&db, &deps);
    let cookie = sign_in(&app, user).await;
    let key = issue_key(&app, &cookie).await;
    let session = mcp_session(&app, &key).await;
    // Both surfaces enforce the strategy gate for the new operations.
    let response = send(
        &app,
        panel(Method::GET, "/api/inbox/tasks", Some(&cookie), None),
    )
    .await;
    let human = json_body(response).await;
    let agent = tool_result(&app, &key, &session, "jeeta.inbox.tasks_list", json!({})).await;
    assert_eq!(human["code"], "STRATEGY_REQUIRED");
    assert_eq!(human["code"], agent["structuredContent"]["code"]);
    approve_inbox_strategy(&app, &cookie).await;
    call_tool(
        &app,
        &key,
        &session,
        "jeeta.inbox.lost_reasons_set",
        json!({"key":"parity","label":"Parity","active":true}),
    )
    .await;

    for (index, via_mcp) in [(0, false), (1, true)] {
        let keeper = call_tool(&app, &key, &session, "jeeta.inbox.people_create", json!({
            "display_name":"Keeper", "identities":[{"channel":"email","value":format!("keeper{index}@example.test")}], "source":"form"
        })).await;
        let donor_email = format!("donor{index}@example.test");
        let donor = call_tool(&app, &key, &session, "jeeta.inbox.people_create", json!({
            "display_name":"Donor", "identities":[{"channel":"email","value":donor_email}], "source":"form"
        })).await;
        let keep = &keeper["person"]["id"];
        let suggestion = call_tool(
            &app,
            &key,
            &session,
            "jeeta.inbox.identities_add",
            json!({
                "person_id":keep, "channel":"email", "value":donor_email
            }),
        )
        .await;
        let merge_id = &suggestion["merge_suggestion"]["id"];
        let path = format!("/api/inbox/merges/{}/apply", merge_id.as_str().unwrap());
        let response = send(
            &app,
            panel(
                Method::POST,
                &path,
                Some(&cookie),
                Some(json!({"keep":keep})),
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let human = json_body(response).await;
        let agent = tool_result(
            &app,
            &key,
            &session,
            "jeeta.inbox.merges_apply",
            json!({"merge_id":merge_id,"keep":keep}),
        )
        .await;
        assert_eq!(human, agent["structuredContent"]);
        assert_eq!(human["details"]["reason"], "two_open_journeys");

        let donor = call_tool(
            &app,
            &key,
            &session,
            "jeeta.inbox.people_get",
            json!({"person_id":donor["person"]["id"]}),
        )
        .await;
        call_tool(&app, &key, &session, "jeeta.inbox.events_report", json!({
            "journey_id":donor["open_journey"]["id"],"kind":"lost", "idempotency_key":format!("close-donor-{index}"),"payload":{"reason_key":"parity"}
        })).await;
        let applied = if via_mcp {
            call_tool(
                &app,
                &key,
                &session,
                "jeeta.inbox.merges_apply",
                json!({"merge_id":merge_id,"keep":keep}),
            )
            .await
        } else {
            let response = send(
                &app,
                panel(
                    Method::POST,
                    &path,
                    Some(&cookie),
                    Some(json!({"keep":keep})),
                ),
            )
            .await;
            let status = response.status();
            let body = json_body(response).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        };
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["target_id"], *keep);
        let observed = if via_mcp {
            let response = send(
                &app,
                panel(Method::GET, "/api/inbox/merges", Some(&cookie), None),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            json_body(response).await
        } else {
            call_tool(&app, &key, &session, "jeeta.inbox.merges_list", json!({})).await
        };
        assert_eq!(
            observed
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == *merge_id),
            Some(&applied)
        );
        // Undo's confirmation refusal is identical across the transports.
        let undo_path = format!("/api/inbox/merges/{}/undo", merge_id.as_str().unwrap());
        let response = send(
            &app,
            panel(Method::POST, &undo_path, Some(&cookie), Some(json!({}))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let human = json_body(response).await;
        let agent = tool_result(
            &app,
            &key,
            &session,
            "jeeta.inbox.merges_undo",
            json!({"merge_id":merge_id}),
        )
        .await;
        assert_eq!(human, agent["structuredContent"]);

        if index == 0 {
            let keeper = call_tool(
                &app,
                &key,
                &session,
                "jeeta.inbox.people_get",
                json!({"person_id":keep}),
            )
            .await;
            let journey = &keeper["open_journey"]["id"];
            for (title, due_at, assignee) in [
                ("Overdue", "2026-10-22T08:59:59Z", Some(user)),
                ("Due now", "2026-10-22T09:00:00Z", None),
                ("Due tomorrow", "2026-10-23T09:00:00Z", Some(user)),
                ("Later", "2026-10-23T09:00:01Z", None),
            ] {
                let input = json!({"title":title,"due_at":due_at,"assignee":assignee});
                let response = send(
                    &app,
                    panel(
                        Method::POST,
                        &format!("/api/inbox/journeys/{}/tasks", journey.as_str().unwrap()),
                        Some(&cookie),
                        Some(input),
                    ),
                )
                .await;
                let status = response.status();
                let body = json_body(response).await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            for (query, args, count) in [
                (String::new(), json!({}), 2),
                ("?queue=due_24h".into(), json!({"queue":"due_24h"}), 2),
                ("?queue=overdue".into(), json!({"queue":"overdue"}), 1),
                ("?queue=all".into(), json!({"queue":"all"}), 4),
                (
                    format!("?queue=all&assignee={user}"),
                    json!({"queue":"all","assignee":user}),
                    2,
                ),
            ] {
                let response = send(
                    &app,
                    panel(
                        Method::GET,
                        &format!("/api/inbox/tasks{query}"),
                        Some(&cookie),
                        None,
                    ),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK);
                let human = json_body(response).await;
                let agent = call_tool(&app, &key, &session, "jeeta.inbox.tasks_list", args).await;
                assert_eq!(human, agent);
                assert_eq!(human.as_array().unwrap().len(), count, "{query}");
            }
        }
    }
    let response = send(
        &app,
        panel(
            Method::GET,
            "/api/inbox/tasks?queue=invalid",
            Some(&cookie),
            None,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let human = json_body(response).await;
    let agent = tool_result(
        &app,
        &key,
        &session,
        "jeeta.inbox.tasks_list",
        json!({"queue":"invalid"}),
    )
    .await;
    assert_eq!(human["code"], "VALIDATION");
    assert_eq!(human["code"], agent["structuredContent"]["code"]);
}
