//! The MCP gate end to end: an rmcp client over streamable HTTP against the router on an
//! ephemeral port, backed by a fresh Postgres database. Bearer-key authentication, the
//! connection an `initialize` records, tool listing by permission, workspace isolation, the
//! ledger entry of every call, the strategy gate and the workspace-status gate.

use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use jt_app::catalog::{GateMode, Risk, UseCase};
use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::gate::{NoStrategyYet, StrategyGate};
use jt_app::ports::LedgerFilter;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::api_keys::{self, CreateKey, KeyOut};
use jt_app::usecases::auth::LoginInput;
use jt_app::usecases::team::{self, InviteInput};
use jt_app::usecases::{Deps, agents, platform};
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_mcp::{McpState, ToolFuture, ToolSpec, http_service, registry, risk_tag};
use jt_pg::PgUnitOfWork;
use jt_tenancy::{SystemRole, UserId, WorkspaceId, WorkspaceStatus};
use jt_testkit::TestDb;
use jt_testkit::fakes::{PlainHasher, PlainSecretBox};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
    ProtocolVersion,
};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, StreamableHttpClientTransportConfig,
};
use rmcp::{
    ClientLifecycleMode, RoleClient, ServiceError, ServiceExt, serve_client_with_lifecycle,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use tower::ServiceExt as _;

/// A gated use case that is not in the catalog (M0 has none), exposed as a test-only tool.
static GATED: UseCase = UseCase {
    id: "demo.gated",
    gate: GateMode::Gated,
    mcp_tool: Some("jeeta.demo.gated"),
    panel_route: None,
    panel_only: false,
    status_exempt: false,
    risk: Risk::Read,
};

fn run_gated<'a>(_deps: &'a Deps, _ctx: &'a Ctx, _args: Value) -> ToolFuture<'a> {
    Box::pin(async { Ok(json!({ "ran": true })) })
}

fn gated_spec() -> ToolSpec {
    let whoami = registry()
        .into_iter()
        .find(|t| t.name == "jeeta.agent.whoami")
        .unwrap();
    ToolSpec {
        name: "jeeta.demo.gated",
        use_case: "demo.gated",
        description: "A gated demonstration tool used by the tests. [risk: READ]",
        run: run_gated,
        ..whoami
    }
}

/// A gate under which every workspace has an approved strategy.
struct Approved;

#[async_trait]
impl StrategyGate for Approved {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(true)
    }
}

/// A fresh database with two seeded, active workspaces.
struct World {
    _db: TestDb,
    deps: Deps,
    a: WorkspaceId,
    a_owner: UserId,
    b: WorkspaceId,
    b_owner: UserId,
}

impl World {
    async fn new() -> World {
        let db = TestDb::new().await;
        let deps = Deps {
            uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7Gen),
            tokens: Arc::new(RandTokenGen),
            hasher: Arc::new(PlainHasher),
            seal: Arc::new(PlainSecretBox),
        };
        let (a, a_owner) = db.seed_workspace("alpha").await;
        let (b, b_owner) = db.seed_workspace("beta").await;
        World {
            _db: db,
            deps,
            a,
            a_owner,
            b,
            b_owner,
        }
    }

    fn state(&self) -> McpState {
        McpState::new(self.deps.clone(), Arc::new(NoStrategyYet))
    }

    /// The owner of `ws` acting in the panel.
    fn owner_ctx(&self, ws: WorkspaceId) -> Ctx {
        let user_id = if ws == self.a {
            self.a_owner
        } else {
            self.b_owner
        };
        Ctx {
            workspace_id: ws,
            actor: Actor::Human { user_id },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: OffsetDateTime::now_utc(),
            agent_connection_id: None,
        }
    }

    /// A key of `ws`'s owner with these scopes (none: every permission).
    async fn key(&self, ws: WorkspaceId, scopes: &[&str]) -> KeyOut {
        api_keys::create(
            &self.deps,
            &self.owner_ctx(ws),
            CreateKey {
                name: "Test key".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap()
    }

    async fn invite(&self, ws: WorkspaceId, email: &str) {
        team::invite(
            &self.deps,
            &self.owner_ctx(ws),
            InviteInput {
                email: email.into(),
                role_key: "rep".into(),
            },
        )
        .await
        .unwrap();
    }

    /// Every ledger entry of `ws` with this action, newest first.
    async fn entries(&self, ws: WorkspaceId, action: &str) -> Vec<LedgerEntry> {
        let mut t = self.deps.uow.tenant(ws).await.unwrap();
        t.ledger()
            .list(LedgerFilter {
                action_prefix: Some(action.into()),
                actor_kind: None,
                limit: 500,
                before_id: None,
            })
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.entry)
            .filter(|e| e.action.as_str() == action)
            .collect()
    }

    async fn set_status(&self, ws: WorkspaceId, status: WorkspaceStatus) {
        let mut p = self.deps.uow.platform().await.unwrap();
        p.workspace_set_status(ws, status).await.unwrap();
        p.commit().await.unwrap();
    }
}

/// Serves the MCP router on an ephemeral port; returns its `/mcp` URL.
async fn serve(state: McpState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = http_service(state);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/mcp")
}

type Client = RunningService<RoleClient, ClientConfig>;

fn client_config(name: &str) -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new(name, "1.4.2"),
    )
    .with_protocol_version(ProtocolVersion::V_2025_06_18)
}

/// The transport settings for `url` with `key` as the bearer.
fn transport(url: &str, key: &str) -> StreamableHttpClientTransportConfig {
    StreamableHttpClientTransportConfig::with_uri(url).auth_header(key)
}

/// An MCP client named `name` that initialises with `key`.
async fn connect(url: &str, key: &str, name: &str) -> Client {
    client_config(name)
        .serve(StreamableHttpClientTransport::from_config(transport(
            url, key,
        )))
        .await
        .expect("the client initialises")
}

async fn call(client: &Client, tool: &str, args: Value) -> CallToolResult {
    let mut params = CallToolRequestParams::new(tool.to_owned());
    if let Value::Object(map) = args {
        params = params.with_arguments(map);
    }
    client.call_tool(params).await.expect("tools/call answers")
}

/// The structured content of a successful call, checked against its text content.
fn ok(result: &CallToolResult) -> Value {
    assert_ne!(result.is_error, Some(true), "{result:?}");
    structured(result)
}

/// The structured error of a failed call, checked against its text content.
fn err(result: &CallToolResult) -> Value {
    assert_eq!(result.is_error, Some(true), "{result:?}");
    let value = structured(result);
    let keys: BTreeSet<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, BTreeSet::from(["code", "message", "details"]));
    value
}

fn structured(result: &CallToolResult) -> Value {
    let value = result
        .structured_content
        .clone()
        .expect("structured content");
    let text = result.content[0]
        .as_text()
        .expect("text content")
        .text
        .clone();
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), value);
    value
}

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn missing_bearer_is_401_structured() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "acme-agent", "version": "1.0" },
        },
    });
    let revoked = w.key(w.a, &[]).await;
    api_keys::revoke(&w.deps, &w.owner_ctx(w.a), revoked.id)
        .await
        .unwrap();
    let wrong = [
        None,
        Some("Basic dXNlcjpwYXNz".to_owned()),
        Some("Bearer".to_owned()),
        Some("Bearer jt_live_unknown".to_owned()),
        Some(key.plaintext.clone()),
        Some(format!("Bearer {}", revoked.plaintext)),
    ];
    for authorization in wrong {
        let mut req = Request::post("/mcp")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(header::HOST, "127.0.0.1");
        if let Some(value) = &authorization {
            req = req.header(header::AUTHORIZATION, value);
        }
        let resp = http_service(w.state())
            .oneshot(req.body(Body::from(initialize.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{authorization:?}");
        assert_eq!(resp.headers()[header::WWW_AUTHENTICATE], "Bearer");
        assert_eq!(
            resp.headers()[header::CONTENT_TYPE],
            "application/json",
            "{authorization:?}"
        );
        let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "code": "UNAUTHENTICATED", "message": "invalid api key", "details": {} })
        );
    }
    // Nothing reached the MCP layer: no connection was recorded.
    let mut t = w.deps.uow.tenant(w.a).await.unwrap();
    assert!(t.agent_connections().list().await.unwrap().is_empty());

    // The scheme is case-insensitive, and a valid key passes on to the MCP service.
    let resp = http_service(w.state())
        .oneshot(
            Request::post("/mcp")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header(header::HOST, "127.0.0.1")
                .header(header::AUTHORIZATION, format!("bearer {}", key.plaintext))
                .body(Body::from(initialize.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_revoked_key_is_refused_on_its_next_request() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;
    ok(&call(&client, "jeeta.agent.whoami", json!({})).await);

    api_keys::revoke(&w.deps, &w.owner_ctx(w.a), key.id)
        .await
        .unwrap();
    let params = CallToolRequestParams::new("jeeta.agent.whoami");
    let refused = client.call_tool(params).await.unwrap_err();
    let ServiceError::TransportSend(transport) = &refused else {
        panic!("expected a transport error, got {refused:?}");
    };
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(transport.error.as_ref());
    let mut challenge = None;
    while let Some(current) = source {
        if let Some(auth) = current.downcast_ref::<AuthRequiredError>() {
            challenge = Some(auth.www_authenticate_header.clone());
        }
        source = current.source();
    }
    assert_eq!(
        challenge.as_deref(),
        Some("Bearer"),
        "the server asks for authorization again: {refused:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

const SESSION_HEADER: &str = "mcp-session-id";

/// A raw MCP request to `app` with `key` as the bearer and, optionally, a session id.
async fn raw(
    app: &axum::Router,
    method: Method,
    key: &str,
    session: Option<&str>,
    body: Option<Value>,
) -> axum::response::Response {
    let accept = if method == Method::GET {
        "text/event-stream"
    } else {
        "application/json, text/event-stream"
    };
    let mut req = Request::builder()
        .method(method)
        .uri("/mcp")
        .header(header::HOST, "127.0.0.1")
        .header(header::ACCEPT, accept)
        .header(header::AUTHORIZATION, format!("Bearer {key}"));
    if let Some(session) = session {
        req = req.header(SESSION_HEADER, session);
    }
    let body = match body {
        Some(body) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    app.clone().oneshot(req.body(body).unwrap()).await.unwrap()
}

/// The JSON-RPC message with this id in an SSE response body.
async fn sse_message(resp: axum::response::Response, id: i64) -> Value {
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        to_bytes(resp.into_body(), usize::MAX),
    )
    .await
    .expect("the response stream ends")
    .unwrap();
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|message| message["id"] == id)
        .expect("the response message")
}

fn initialize_request(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "acme-agent", "version": "1.0" },
        },
    })
}

/// Initialises a session on `app` with `key` and completes the handshake; returns the session id.
async fn open_session(app: &axum::Router, key: &str) -> String {
    let resp = raw(app, Method::POST, key, None, Some(initialize_request(1))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let session = resp.headers()[SESSION_HEADER].to_str().unwrap().to_owned();
    assert!(sse_message(resp, 1).await["result"].is_object());
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = raw(app, Method::POST, key, Some(&session), Some(initialized)).await;
    assert!(resp.status().is_success(), "{}", resp.status());
    session
}

async fn assert_unknown_session(resp: axum::response::Response) {
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "code": "NOT_FOUND", "message": "unknown session", "details": {} })
    );
}

#[tokio::test]
async fn session_bound_to_other_key_is_unknown() {
    let w = World::new().await;
    let a = w.key(w.a, &[]).await.plaintext;
    let b = w.key(w.b, &[]).await.plaintext;
    let state = w.state();
    let app = http_service(state.clone());

    // Key A initialises and gets a session.
    let session = open_session(&app, &a).await;

    // Key B, valid in its own workspace, cannot reach it in any way.
    let list = |id: i64| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" });
    assert_unknown_session(raw(&app, Method::POST, &b, Some(&session), Some(list(2))).await).await;
    assert_unknown_session(raw(&app, Method::GET, &b, Some(&session), None).await).await;
    assert_unknown_session(raw(&app, Method::DELETE, &b, Some(&session), None).await).await;

    // Key A still uses its session.
    let resp = raw(&app, Method::POST, &a, Some(&session), Some(list(3))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let tools = sse_message(resp, 3).await;
    assert_eq!(
        tools["result"]["tools"].as_array().unwrap().len(),
        registry().len()
    );

    // Only A's client was ever recorded, and only in A's workspace.
    let a_connections = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(a_connections.len(), 1);
    assert_eq!(a_connections[0].client_name, "acme-agent");
    assert!(
        agents::list(&w.deps, &w.owner_ctx(w.b))
            .await
            .unwrap()
            .is_empty()
    );

    // Once A ends the session its binding is gone too, so it is unknown for everyone, A
    // included, before rmcp is even asked.
    let resp = raw(&app, Method::DELETE, &a, Some(&session), None).await;
    assert!(resp.status().is_success(), "{}", resp.status());
    assert!(state.sessions().is_empty());
    assert_unknown_session(raw(&app, Method::POST, &a, Some(&session), Some(list(4))).await).await;
    assert_unknown_session(raw(&app, Method::POST, &b, Some(&session), Some(list(5))).await).await;
}

#[tokio::test]
async fn evicted_or_unknown_session_id_is_refused() {
    let w = World::new().await;
    let a = w.key(w.a, &[]).await.plaintext;
    let b = w.key(w.b, &[]).await.plaintext;
    // Room for a single binding, so one new session evicts the previous one.
    let state = w.state().with_session_capacity(1);
    let app = http_service(state.clone());
    let list = |id: i64| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" });

    // A session id never created here is refused, structured, for any key and any method.
    for key in [&a, &b] {
        let made_up = "0193c7a2-made-up-session";
        assert_unknown_session(raw(&app, Method::POST, key, Some(made_up), Some(list(2))).await)
            .await;
        assert_unknown_session(raw(&app, Method::GET, key, Some(made_up), None).await).await;
        assert_unknown_session(raw(&app, Method::DELETE, key, Some(made_up), None).await).await;
    }

    // A's session works while it is bound.
    let victim = open_session(&app, &a).await;
    let resp = raw(&app, Method::POST, &a, Some(&victim), Some(list(3))).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(sse_message(resp, 3).await["result"]["tools"].is_array());

    // B opens a session of its own, which evicts A's binding (rmcp still holds A's session and
    // its completed stream for replay).
    let attacker = open_session(&app, &b).await;
    assert_eq!(state.sessions().len(), 1);
    assert_eq!(state.sessions().owner(&victim), None);

    // The evicted id is refused for B, whatever it asks: a request, a stream resumption with
    // `Last-Event-ID`, or ending it.
    assert_unknown_session(raw(&app, Method::POST, &b, Some(&victim), Some(list(4))).await).await;
    let resume = Request::get("/mcp")
        .header(header::HOST, "127.0.0.1")
        .header(header::ACCEPT, "text/event-stream")
        .header(header::AUTHORIZATION, format!("Bearer {b}"))
        .header(SESSION_HEADER, &victim)
        .header("last-event-id", "0")
        .body(Body::empty())
        .unwrap();
    assert_unknown_session(app.clone().oneshot(resume).await.unwrap()).await;
    assert_unknown_session(raw(&app, Method::DELETE, &b, Some(&victim), None).await).await;

    // And for A itself: an unbound session is closed to everyone, so A initialises again.
    assert_unknown_session(raw(&app, Method::POST, &a, Some(&victim), Some(list(5))).await).await;
    let again = open_session(&app, &a).await;
    let resp = raw(&app, Method::POST, &a, Some(&again), Some(list(6))).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // B's own session was evicted in turn by A's new one: it too is refused now.
    assert_unknown_session(raw(&app, Method::POST, &b, Some(&attacker), Some(list(7))).await).await;
}

// ---------------------------------------------------------------------------------------------
// Initialize and tools/list
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn initialize_records_agent_connection_with_client_name() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let listed = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(listed.len(), 1);
    let connection = &listed[0];
    assert_eq!(connection.api_key_id, key.id);
    assert_eq!(connection.client_name, "acme-agent");
    assert_eq!(connection.client_version, "1.4.2");
    assert_eq!(connection.protocol_version, "2025-06-18");
    assert_eq!(connection.tool_calls, 0);

    let connected = w.entries(w.a, "agent.connected").await;
    assert_eq!(connected.len(), 1);
    assert_eq!(
        connected[0].actor,
        Actor::Agent {
            connection_id: connection.id,
            user_id: w.a_owner,
        }
    );
    assert_eq!(connected[0].payload["client_name"], "acme-agent");

    // The session's calls run through that connection.
    let me = ok(&call(&client, "jeeta.agent.whoami", json!({})).await);
    assert_eq!(
        me["actor"]["connection_id"],
        json!(connection.id.to_string())
    );
    assert_eq!(me["workspace_id"], json!(w.a.to_string()));
    let listed = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(listed.len(), 1, "no second connection for the same session");
    assert_eq!(listed[0].tool_calls, 1);
}

#[tokio::test]
async fn a_stateless_client_is_registered_on_its_first_call() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = serve_client_with_lifecycle(
        client_config("beta-agent"),
        StreamableHttpClientTransport::from_config(transport(&url, &key.plaintext)),
        ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        },
    )
    .await
    .expect("the client discovers the server");
    assert!(
        agents::list(&w.deps, &w.owner_ctx(w.a))
            .await
            .unwrap()
            .is_empty()
    );

    for _ in 0..2 {
        ok(&call(&client, "jeeta.workspace.info", json!({})).await);
    }
    let listed = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].client_name, "beta-agent");
    assert_eq!(listed[0].client_version, "1.4.2");
    assert_eq!(listed[0].protocol_version, "2026-07-28");
    assert_eq!(listed[0].tool_calls, 2);
}

#[tokio::test]
async fn tools_list_hides_tools_the_key_cannot_use() {
    let w = World::new().await;
    let reader = w.key(w.a, &["workspace.read"]).await;
    let full = w.key(w.a, &[]).await;
    let url = serve(w.state().with_test_tool(gated_spec(), &GATED)).await;

    let client = connect(&url, &reader.plaintext, "acme-agent").await;
    let tools = client.list_all_tools().await.unwrap();
    let names: BTreeSet<String> = tools.iter().map(|t| t.name.to_string()).collect();
    let expected: BTreeSet<String> = [
        "jeeta.agent.whoami",
        "jeeta.workspace.info",
        "jeeta.team.list",
        "jeeta.roles.list",
        "jeeta.agents.list",
        "jeeta.demo.gated",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(names, expected);

    let client = connect(&url, &full.plaintext, "acme-agent").await;
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), registry().len() + 1);
    for tool in &tools {
        let spec = registry().into_iter().find(|s| s.name == tool.name);
        let risk = spec.map_or(Risk::Read, |s| s.risk);
        let description = tool.description.as_deref().unwrap();
        assert!(description.ends_with(risk_tag(risk)), "{description}");
        assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(risk == Risk::Read));
        assert_eq!(
            annotations.destructive_hint,
            Some(risk == Risk::Destructive)
        );
    }

    // A hidden tool is still refused when called by name.
    let client = connect(&url, &reader.plaintext, "acme-agent").await;
    let refused = err(&call(
        &client,
        "jeeta.team.invite",
        json!({ "email": "x@alpha.example", "role_key": "rep" }),
    )
    .await);
    assert_eq!(refused["code"], "FORBIDDEN");
    assert_eq!(refused["details"], json!({ "permission": "team.manage" }));
}

// ---------------------------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn call_team_list_returns_only_own_workspace_members() {
    let w = World::new().await;
    w.invite(w.a, "rep@alpha.example").await;
    w.invite(w.b, "rep@beta.example").await;
    w.invite(w.b, "other@beta.example").await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let out = ok(&call(&client, "jeeta.team.list", json!({})).await);
    let members = out["members"].as_array().unwrap();
    let emails: BTreeSet<&str> = members
        .iter()
        .map(|m| m["email"].as_str().unwrap())
        .collect();
    let owner_email = format!("owner+{}@test.local", w.a_owner);
    assert_eq!(
        emails,
        BTreeSet::from([owner_email.as_str(), "rep@alpha.example"])
    );
    let b_ids: BTreeSet<String> = team::list(&w.deps, &w.owner_ctx(w.b))
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.membership_id.to_string())
        .collect();
    assert!(
        members
            .iter()
            .all(|m| !b_ids.contains(m["membership_id"].as_str().unwrap()))
    );
}

#[tokio::test]
async fn call_writes_ledger_mcp_tool_call_entry() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;
    let connection = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap()[0].id;

    ok(&call(&client, "jeeta.team.list", json!({})).await);
    let refused = err(&call(
        &client,
        "jeeta.team.invite",
        json!({ "email": "not an email", "role_key": "rep" }),
    )
    .await);
    assert_eq!(refused["code"], "VALIDATION");
    let unknown = err(&call(&client, "jeeta.nothing.here", json!({})).await);
    assert_eq!(unknown["code"], "NOT_FOUND");
    assert_eq!(unknown["details"], json!({ "tool": "jeeta.nothing.here" }));
    let bad_args = err(&call(&client, "jeeta.team.remove", json!({ "membership_id": 7 })).await);
    assert_eq!(bad_args["code"], "VALIDATION");

    let calls = w.entries(w.a, "mcp.tool_call").await;
    assert_eq!(calls.len(), 4);
    for entry in &calls {
        assert_eq!(
            entry.actor,
            Actor::Agent {
                connection_id: connection,
                user_id: w.a_owner,
            }
        );
        assert!(entry.payload["duration_ms"].is_u64(), "{}", entry.payload);
    }
    // Newest first.
    let payload = |i: usize| {
        let mut p = calls[i].payload.clone();
        p.as_object_mut().unwrap().remove("duration_ms");
        p
    };
    assert_eq!(
        payload(3),
        json!({ "tool": "jeeta.team.list", "risk": "read", "ok": true })
    );
    assert_eq!(
        payload(2),
        json!({
            "tool": "jeeta.team.invite",
            "risk": "write",
            "ok": false,
            "error_code": "VALIDATION",
        })
    );
    assert_eq!(
        payload(1),
        json!({
            "tool": "jeeta.nothing.here",
            "risk": null,
            "ok": false,
            "error_code": "NOT_FOUND",
        })
    );
    assert_eq!(payload(0)["error_code"], "VALIDATION");
    assert!(w.entries(w.b, "mcp.tool_call").await.is_empty());

    let listed = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(listed[0].tool_calls, 4);
}

#[tokio::test]
async fn call_of_gated_tool_returns_strategy_required() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state().with_test_tool(gated_spec(), &GATED)).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let refused = err(&call(&client, "jeeta.demo.gated", json!({})).await);
    assert_eq!(refused["code"], "STRATEGY_REQUIRED");
    assert_eq!(refused["details"], json!({}));
    let calls = w.entries(w.a, "mcp.tool_call").await;
    assert_eq!(calls[0].payload["error_code"], "STRATEGY_REQUIRED");

    // With an approved strategy the same tool runs.
    let approved =
        McpState::new(w.deps.clone(), Arc::new(Approved)).with_test_tool(gated_spec(), &GATED);
    let url = serve(approved).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;
    assert_eq!(
        ok(&call(&client, "jeeta.demo.gated", json!({})).await),
        json!({ "ran": true })
    );
}

#[tokio::test]
async fn call_on_pending_payment_workspace_returns_workspace_inactive() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    w.set_status(w.a, WorkspaceStatus::PendingPayment).await;
    let approved =
        McpState::new(w.deps.clone(), Arc::new(Approved)).with_test_tool(gated_spec(), &GATED);
    let url = serve(approved).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let refused = err(&call(&client, "jeeta.demo.gated", json!({})).await);
    assert_eq!(refused["code"], "WORKSPACE_INACTIVE");
    assert_eq!(refused["details"], json!({ "status": "pending_payment" }));

    // Status-exempt tools keep working while the workspace is inactive; every other tool,
    // exempt from the strategy gate or not, meets the status check.
    let info = ok(&call(&client, "jeeta.workspace.info", json!({})).await);
    assert_eq!(info["status"], "pending_payment");
    for tool in [
        "jeeta.team.list",
        "jeeta.api_keys.list",
        "jeeta.ledger.list",
    ] {
        let refused = err(&call(&client, tool, json!({})).await);
        assert_eq!(refused["code"], "WORKSPACE_INACTIVE", "{tool}");
        assert_eq!(refused["details"], json!({ "status": "pending_payment" }));
    }
}

#[tokio::test]
async fn gated_tool_passes_after_operator_activates_and_gate_stub_says_strategy_exists() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    // A workspace awaiting payment.
    w.set_status(w.a, WorkspaceStatus::PendingPayment).await;
    let approved =
        McpState::new(w.deps.clone(), Arc::new(Approved)).with_test_tool(gated_spec(), &GATED);
    let url = serve(approved).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;
    let refused = err(&call(&client, "jeeta.demo.gated", json!({})).await);
    assert_eq!(refused["code"], "WORKSPACE_INACTIVE");
    assert_eq!(refused["details"], json!({ "status": "pending_payment" }));

    // The platform operator signs in and activates the workspace, which its ledger records.
    assert!(
        platform::bootstrap(&w.deps, "ops@jeeta.test", "operator passphrase")
            .await
            .unwrap()
    );
    let session = platform::login(
        &w.deps,
        LoginInput {
            email: "ops@jeeta.test".into(),
            password: "operator passphrase".into(),
        },
    )
    .await
    .unwrap();
    let pctx = platform::resolve(&w.deps, &session.token).await.unwrap();
    let out = platform::set_status(&w.deps, &pctx, w.a, WorkspaceStatus::Active)
        .await
        .unwrap();
    assert_eq!(out.status, WorkspaceStatus::Active);
    let operator = Actor::System {
        component: format!("platform_operator:{}", pctx.operator_id),
    };
    let changes = w.entries(w.a, "platform.workspace_status").await;
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].actor, operator);
    assert_eq!(
        changes[0].payload,
        json!({ "from": "pending_payment", "to": "active" })
    );
    assert!(w.entries(w.b, "platform.workspace_status").await.is_empty());

    // The same session's next call passes: the gate reads the status afresh, and the stub says
    // a strategy is approved.
    assert_eq!(
        ok(&call(&client, "jeeta.demo.gated", json!({})).await),
        json!({ "ran": true })
    );

    // Without an approved strategy, the now active workspace meets the strategy check instead.
    let url = serve(w.state().with_test_tool(gated_spec(), &GATED)).await;
    let no_strategy = connect(&url, &key.plaintext, "acme-agent").await;
    let refused = err(&call(&no_strategy, "jeeta.demo.gated", json!({})).await);
    assert_eq!(refused["code"], "STRATEGY_REQUIRED");

    // Suspension closes the gate again; the key itself still works for exempt tools.
    platform::set_status(&w.deps, &pctx, w.a, WorkspaceStatus::Suspended)
        .await
        .unwrap();
    let refused = err(&call(&client, "jeeta.demo.gated", json!({})).await);
    assert_eq!(refused["code"], "WORKSPACE_INACTIVE");
    assert_eq!(refused["details"], json!({ "status": "suspended" }));
    let info = ok(&call(&client, "jeeta.workspace.info", json!({})).await);
    assert_eq!(info["status"], "suspended");
    assert_eq!(w.entries(w.a, "platform.workspace_status").await.len(), 2);
}

#[tokio::test]
async fn call_ledger_list_returns_redacted_entries() {
    let w = World::new().await;
    {
        let mut t = w.deps.uow.tenant(w.a).await.unwrap();
        t.ledger()
            .append(LedgerEntry::new(
                w.a,
                Actor::System {
                    component: "test".into(),
                },
                Action::new("test.secret").unwrap(),
                json!({ "name": "CI", "token": "s3cret", "nested": { "Authorization": "x" } }),
                OffsetDateTime::now_utc(),
            ))
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let key = w.key(w.a, &["ledger.read"]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let out = ok(&call(
        &client,
        "jeeta.ledger.list",
        json!({ "action_prefix": "test.", "limit": 10 }),
    )
    .await);
    let entries = out["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]["entry"]["payload"],
        json!({ "name": "CI", "token": "***", "nested": { "Authorization": "***" } })
    );
    assert!(entries[0]["id"].is_i64());
    assert!(!out.to_string().contains("s3cret"));

    let refused = err(&call(
        &client,
        "jeeta.ledger.list",
        json!({ "actor_kind": "robot" }),
    )
    .await);
    assert_eq!(refused["code"], "VALIDATION");
}

#[tokio::test]
async fn write_tools_act_in_the_keys_workspace() {
    let w = World::new().await;
    let key = w.key(w.a, &[]).await;
    let url = serve(w.state()).await;
    let client = connect(&url, &key.plaintext, "acme-agent").await;

    let invite = ok(&call(
        &client,
        "jeeta.team.invite",
        json!({ "email": "new@alpha.example", "role_key": "rep" }),
    )
    .await);
    assert!(invite["invite_token"].is_string());
    let membership_id = invite["membership_id"].as_str().unwrap().to_owned();

    let role = ok(&call(
        &client,
        "jeeta.roles.create",
        json!({ "key": "auditor", "name": "Auditor", "permissions": ["ledger.read"] }),
    )
    .await);
    assert_eq!(role["key"], "auditor");
    let role_id = role["id"].as_str().unwrap().to_owned();
    let updated = ok(&call(
        &client,
        "jeeta.roles.update",
        json!({ "role_id": role_id, "permissions": ["ledger.read", "workspace.read"] }),
    )
    .await);
    assert_eq!(
        updated["permissions"],
        json!(["workspace.read", "ledger.read"])
    );
    let deleted = ok(&call(&client, "jeeta.roles.delete", json!({ "role_id": role_id })).await);
    assert_eq!(deleted, json!({ "role_id": role_id, "deleted": true }));
    let roles = ok(&call(&client, "jeeta.roles.list", json!({})).await);
    assert_eq!(roles["roles"].as_array().unwrap().len(), 3);

    let removed = ok(&call(
        &client,
        "jeeta.team.remove",
        json!({ "membership_id": membership_id }),
    )
    .await);
    assert_eq!(
        removed,
        json!({ "membership_id": membership_id, "removed": true })
    );

    let created = ok(&call(
        &client,
        "jeeta.api_keys.create",
        json!({ "name": "Child", "scopes": ["workspace.read"] }),
    )
    .await);
    assert!(
        created["plaintext"]
            .as_str()
            .unwrap()
            .starts_with("jt_live_")
    );
    let keys = ok(&call(&client, "jeeta.api_keys.list", json!({})).await);
    assert_eq!(keys["keys"].as_array().unwrap().len(), 2);
    assert!(!keys.to_string().contains("key_hash"));
    let revoked = ok(&call(
        &client,
        "jeeta.api_keys.revoke",
        json!({ "key_id": created["id"] }),
    )
    .await);
    assert_eq!(revoked, json!({ "key_id": created["id"], "revoked": true }));
    let connections = ok(&call(&client, "jeeta.agents.list", json!({})).await);
    assert_eq!(connections["connections"].as_array().unwrap().len(), 1);

    // Unknown argument fields are refused.
    let refused = err(&call(&client, "jeeta.team.list", json!({ "workspace_id": w.b })).await);
    assert_eq!(refused["code"], "VALIDATION");

    // Nothing of this reached the other workspace.
    assert!(w.entries(w.b, "team.invite").await.is_empty());
    assert_eq!(w.entries(w.a, "team.invite").await.len(), 1);
}

#[tokio::test]
async fn stdio_transport_serves_the_same_handler_for_a_fixed_principal() {
    let w = World::new().await;
    let key = w.key(w.a, &["workspace.read"]).await;
    let principal = api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap();
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let state = w.state();
    let server = tokio::spawn(async move {
        let (read, write) = tokio::io::split(server_io);
        jt_mcp::run_io(state, principal, (read, write)).await
    });
    let (read, write) = tokio::io::split(client_io);
    let client = client_config("acme-agent")
        .serve((read, write))
        .await
        .expect("the client initialises over the pipe");

    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 5, "only the workspace.read tools");
    let me = ok(&call(&client, "jeeta.agent.whoami", json!({})).await);
    assert_eq!(me["permissions"], json!(["workspace.read"]));
    let listed = agents::list(&w.deps, &w.owner_ctx(w.a)).await.unwrap();
    assert_eq!(listed[0].client_name, "acme-agent");
    assert_eq!(listed[0].tool_calls, 1);
    let mut map = Map::new();
    map.insert("x".into(), json!(1));
    let refused = err(&call(&client, "jeeta.agent.whoami", Value::Object(map)).await);
    assert_eq!(refused["code"], "VALIDATION");

    client.cancel().await.unwrap();
    server.await.unwrap().unwrap();
}
