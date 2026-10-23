//! The inbound-event tools and the hook addresses over MCP, end to end through Postgres: an agent
//! sees what is pending (`jeeta.work.pending` lists the events), reads the events oldest first
//! (`jeeta.events.pending`) and acknowledges what it handled (`jeeta.events.ack`), and reads the
//! history (`jeeta.events.list`) and the NetGSM callback URLs to hand to the owner
//! (`jeeta.connector.hooks`). A key with `workspace.read` alone reads but neither acknowledges
//! nor sees the hook tokens.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use jt_app::ctx::Ctx;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_ledger::Actor;
use jt_mcp::{McpState, http_service};
use jt_pg::{PgStrategyGate, PgUnitOfWork};
use jt_tenancy::{SystemRole, UserId, WorkspaceId};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, PlainHasher, PlainSecretBox, RecordingTenantHosts, ScriptedRegistry,
};
use serde_json::{Value, json};
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

/// A fresh database with one seeded, active workspace and its MCP endpoint in process.
struct World {
    _db: TestDb,
    deps: Deps,
    app: Router,
    ws: WorkspaceId,
    owner: UserId,
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
            channels: Arc::new(NoChannelsYet),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
            apps: Arc::new(FakeAppConfig::default()),
            connectors: Arc::new(ScriptedRegistry::new()),
            job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
        };
        let (ws, owner) = db.seed_workspace("alpha").await;
        let state = McpState::new(deps.clone(), Arc::new(PgStrategyGate::new(db.pool.clone())));
        World {
            _db: db,
            app: http_service(state),
            deps,
            ws,
            owner,
        }
    }

    fn owner_ctx(&self) -> Ctx {
        Ctx {
            workspace_id: self.ws,
            actor: Actor::Human {
                user_id: self.owner,
            },
            permissions: SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: OffsetDateTime::now_utc(),
            agent_connection_id: None,
        }
    }

    /// A key of the owner with these scopes (none: every permission); its plaintext.
    async fn key(&self, scopes: &[&str]) -> String {
        api_keys::create(
            &self.deps,
            &self.owner_ctx(),
            CreateKey {
                name: "events agent".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap()
        .plaintext
    }

    /// Stores `n` NetGSM messages, a minute apart.
    async fn store(&self, n: usize) -> Vec<InboundEventId> {
        let t0 = datetime!(2026-10-22 09:00 UTC);
        let mut t = self.deps.uow.tenant(self.ws).await.unwrap();
        let mut ids = Vec::new();
        for i in 0..n {
            let id = InboundEventId::new_v7();
            t.inbound_events()
                .insert_if_new(
                    InboundEvent {
                        id,
                        workspace_id: self.ws,
                        provider: Provider::Netgsm,
                        capability_id: None,
                        external_id: format!("netgsm-mo:{i}"),
                        kind: EventKind::Message,
                        payload: json!({ "from": "+905000000001", "text": "Merhaba" }),
                        received_at: t0 + Duration::minutes(i as i64),
                        processed_at: None,
                    },
                    Some(b"RAW-BODY".to_vec()),
                )
                .await
                .unwrap();
            ids.push(id);
        }
        t.commit().await.unwrap();
        ids
    }

    async fn send(&self, req: Request<Body>) -> Response {
        self.app.clone().oneshot(req).await.unwrap()
    }

    /// Opens an MCP session with `key`; returns its id.
    async fn session(&self, key: &str) -> String {
        let initialize = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "events-agent", "version": "1.0" },
            },
        });
        let resp = self.send(mcp(key, None, &initialize)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let session = resp.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(sse_message(resp, 1).await["result"].is_object());
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let resp = self.send(mcp(key, Some(&session), &initialized)).await;
        assert!(resp.status().is_success(), "{}", resp.status());
        session
    }

    async fn rpc(&self, key: &str, session: &str, method: &str, params: Value) -> Value {
        static NEXT_ID: AtomicI64 = AtomicI64::new(2);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let call = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp = self.send(mcp(key, Some(session), &call)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        sse_message(resp, id).await["result"].clone()
    }

    async fn tool(&self, key: &str, session: &str, name: &str, arguments: Value) -> Value {
        self.rpc(
            key,
            session,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    async fn ok(&self, key: &str, session: &str, name: &str, arguments: Value) -> Value {
        let result = self.tool(key, session, name, arguments).await;
        assert_ne!(result["isError"], json!(true), "{result}");
        result["structuredContent"].clone()
    }

    async fn tools(&self, key: &str, session: &str) -> Vec<String> {
        let listed = self.rpc(key, session, "tools/list", json!({})).await;
        listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }
}

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

fn ids(page: &Value) -> Vec<String> {
    page["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn an_agent_reads_and_acknowledges_the_inbound_events() {
    let w = World::new().await;
    let stored = w.store(3).await;
    let id = |i: usize| stored[i].to_string();
    let key = w.key(&[]).await;
    let session = w.session(&key).await;

    // What is pending says so.
    let pending = w.ok(&key, &session, "jeeta.work.pending", json!({})).await;
    let item = pending["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "inbound_events")
        .expect("the inbound events item");
    assert_eq!(item["count"], 3);
    assert_eq!(item["priority"], 2);

    // Oldest first, a page at a time.
    let page = w
        .ok(
            &key,
            &session,
            "jeeta.events.pending",
            json!({ "limit": 2 }),
        )
        .await;
    assert_eq!(ids(&page), [id(0), id(1)]);
    assert_eq!(page["next"]["after_id"], json!(id(1)));
    let page = w
        .ok(
            &key,
            &session,
            "jeeta.events.pending",
            json!({ "limit": 2, "after_at": page["next"]["after_at"], "after_id": id(1) }),
        )
        .await;
    assert_eq!(ids(&page), [id(2)]);
    assert_eq!(page["next"], Value::Null);

    let acked = w
        .ok(
            &key,
            &session,
            "jeeta.events.ack",
            json!({ "ids": [id(0), id(1)] }),
        )
        .await;
    assert_eq!(acked, json!({ "acked": 2 }));
    let left = w
        .ok(&key, &session, "jeeta.events.pending", json!({}))
        .await;
    assert_eq!(ids(&left), [id(2)]);
    let history = w
        .ok(
            &key,
            &session,
            "jeeta.events.list",
            json!({ "provider": "netgsm", "kind": "message" }),
        )
        .await;
    assert_eq!(ids(&history), [id(2), id(1), id(0)]);
    assert!(!history.to_string().contains("RAW-BODY"));

    // Arguments are read strictly.
    let refused = w
        .tool(
            &key,
            &session,
            "jeeta.events.ack",
            json!({ "ids": [], "all": true }),
        )
        .await;
    assert_eq!(refused["isError"], json!(true));
    assert_eq!(refused["structuredContent"]["code"], "VALIDATION");
    let refused = w
        .tool(&key, &session, "jeeta.events.ack", json!({ "ids": [] }))
        .await;
    assert_eq!(refused["structuredContent"]["code"], "VALIDATION");
    assert_eq!(refused["structuredContent"]["details"]["field"], "ids");
}

#[tokio::test]
async fn a_read_only_key_reads_events_but_neither_acknowledges_nor_sees_hook_tokens() {
    let w = World::new().await;
    let stored = w.store(1).await;
    let key = w.key(&["workspace.read"]).await;
    let session = w.session(&key).await;
    let tools = w.tools(&key, &session).await;
    for name in ["jeeta.events.pending", "jeeta.events.list"] {
        assert!(tools.iter().any(|t| t == name), "{name} in {tools:?}");
    }
    for name in ["jeeta.events.ack", "jeeta.connector.hooks"] {
        assert!(!tools.iter().any(|t| t == name), "{name} in {tools:?}");
    }
    let page = w
        .ok(&key, &session, "jeeta.events.pending", json!({}))
        .await;
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    let refused = w
        .tool(
            &key,
            &session,
            "jeeta.events.ack",
            json!({ "ids": [stored[0]] }),
        )
        .await;
    assert_eq!(refused["isError"], json!(true));
    assert_eq!(refused["structuredContent"]["code"], "FORBIDDEN");
}

#[tokio::test]
async fn an_agent_reads_the_hook_addresses_to_hand_to_the_owner() {
    let w = World::new().await;
    let key = w.key(&[]).await;
    let session = w.session(&key).await;
    let hooks = w
        .ok(&key, &session, "jeeta.connector.hooks", json!({}))
        .await;
    assert_eq!(hooks["meta"], Value::Null);
    let netgsm = hooks["netgsm"].as_array().unwrap();
    assert_eq!(netgsm.len(), 5);
    assert_eq!(netgsm[0]["purpose"], "mo");
    assert!(
        netgsm[0]["url"]
            .as_str()
            .unwrap()
            .starts_with(&format!("https://panel.test/hooks/netgsm/{}/", w.ws))
    );
}
