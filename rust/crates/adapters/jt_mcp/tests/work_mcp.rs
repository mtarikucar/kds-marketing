//! The work tools over MCP, end to end through Postgres (B11): an agent asks what is pending
//! (`jeeta.work.pending`), checks in (`jeeta.work.checkin`, an agent's call only, ledgered at
//! most once an hour per connection) and sets the check-in interval
//! (`jeeta.work.set_checkin_interval`).

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::ports::LedgerFilter;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::agents::ClientInfo;
use jt_app::usecases::api_keys::{self, CreateKey, KeyOut};
use jt_app::usecases::capabilities::UowChannelCatalog;
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_app::usecases::{Deps, agents, work};
use jt_ledger::{Actor, LedgerEntry};
use jt_mcp::{McpState, http_service};
use jt_pg::{MAX_CONNECTIONS, PgStrategyGate, PgUnitOfWork};
use jt_tenancy::{SystemRole, UserId, WorkspaceId};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, PlainHasher, PlainSecretBox, RecordingTenantHosts, ScriptedRegistry,
};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation,
    ProtocolVersion,
};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::time::{Duration, timeout};

type Client = RunningService<RoleClient, ClientConfig>;

/// A fresh database with one seeded, active workspace, served over MCP as the binary serves it.
struct World {
    /// Kept for the database's lifetime.
    _db: TestDb,
    deps: Deps,
    ws: WorkspaceId,
    owner: UserId,
    url: String,
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
            files: Arc::new(jt_app::ports::files::UnavailableFileStore),
            transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
            apps: Arc::new(FakeAppConfig::default()),
            connectors: Arc::new(ScriptedRegistry::new()),
            job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
        };
        let (ws, owner) = db.seed_workspace("alpha").await;
        let state = McpState::new(deps.clone(), Arc::new(PgStrategyGate::new(db.pool.clone())));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, http_service(state)).await.unwrap();
        });
        World {
            _db: db,
            deps,
            ws,
            owner,
            url: format!("http://{addr}/mcp"),
        }
    }

    /// The owner acting in the panel.
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

    /// A key of the owner with these scopes (none: every permission).
    async fn key(&self, scopes: &[&str]) -> KeyOut {
        api_keys::create(
            &self.deps,
            &self.owner_ctx(),
            CreateKey {
                name: "Test key".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap()
    }

    /// An MCP client named `name` that initialises with `key`.
    async fn connect(&self, key: &KeyOut, name: &str) -> Client {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new(name, "1.0.0"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_06_18)
        .serve(StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(self.url.as_str())
                .auth_header(&key.plaintext),
        ))
        .await
        .expect("the client initialises")
    }

    /// Every ledger entry with this action, newest first.
    async fn entries(&self, action: &str) -> Vec<LedgerEntry> {
        let mut t = self.deps.uow.tenant(self.ws).await.unwrap();
        t.ledger()
            .list(LedgerFilter {
                action_prefix: Some(action.into()),
                actor_kind: None,
                agent_connection_id: None,
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
}

async fn call(client: &Client, tool: &str, args: Value) -> CallToolResult {
    let mut params = CallToolRequestParams::new(tool.to_owned());
    if let Value::Object(map) = args {
        params = params.with_arguments(map);
    }
    client.call_tool(params).await.expect("tools/call answers")
}

/// The structured content of a successful call.
fn ok(result: &CallToolResult) -> Value {
    assert_ne!(result.is_error, Some(true), "{result:?}");
    result
        .structured_content
        .clone()
        .expect("structured content")
}

/// The structured error of a failed call.
fn err(result: &CallToolResult) -> Value {
    assert_eq!(result.is_error, Some(true), "{result:?}");
    result
        .structured_content
        .clone()
        .expect("structured content")
}

/// The kinds of the pending items, in order.
fn kinds(pending: &Value) -> Vec<&str> {
    pending["items"]
        .as_array()
        .unwrap_or_else(|| panic!("no items in {pending}"))
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn checkin_is_agent_only_and_returns_pending() {
    let w = World::new().await;
    let key = w.key(&["workspace.read"]).await;
    let client = w.connect(&key, "acme-agent").await;

    // What is pending, asked plainly: the agent connected a moment ago, so it is in time.
    let pending = ok(&call(&client, "jeeta.work.pending", json!({})).await);
    assert_eq!(pending["strategy"], "missing");
    assert_eq!(
        kinds(&pending),
        ["consult_strategy", "declare_first_capability"]
    );
    assert_eq!(pending["agent"]["overdue"], false);
    assert!(pending["agent"]["last_seen_at"].is_string());

    // The check-in answers the same pending work.
    let checkin = ok(&call(&client, "jeeta.work.checkin", json!({})).await);
    assert_eq!(checkin["strategy"], pending["strategy"]);
    assert_eq!(checkin["items"], pending["items"]);
    assert_eq!(checkin["agent"]["overdue"], false);
    assert_eq!(checkin["agent"]["interval_minutes"], 1440);

    // It is ledgered as the agent's, about its connection, once within the hour.
    let connection = agents::list(&w.deps, &w.owner_ctx()).await.unwrap()[0].id;
    let entries = w.entries("work.checkin").await;
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].actor,
        Actor::Agent {
            connection_id: connection,
            user_id: w.owner,
        }
    );
    ok(&call(&client, "jeeta.work.checkin", json!({})).await);
    assert_eq!(w.entries("work.checkin").await.len(), 1);

    // Arguments are refused, as for every tool.
    let refused = err(&call(&client, "jeeta.work.checkin", json!({ "now": "later" })).await);
    assert_eq!(refused["code"], "VALIDATION");

    // A person cannot check in: the use case refuses any actor but an agent.
    let e = work::checkin(&w.deps, &w.owner_ctx()).await.unwrap_err();
    assert_eq!(e.details, json!({ "reason": "agents_only" }));

    // A key that cannot read the workspace cannot check in either.
    let blind = w.key(&["ledger.read"]).await;
    let client = w.connect(&blind, "blind-agent").await;
    let refused = err(&call(&client, "jeeta.work.checkin", json!({})).await);
    assert_eq!(refused["code"], "FORBIDDEN");
    assert_eq!(
        refused["details"],
        json!({ "permission": "workspace.read" })
    );
    assert_eq!(w.entries("work.checkin").await.len(), 1);
}

#[tokio::test]
async fn an_owner_key_sets_the_checkin_interval() {
    let w = World::new().await;
    let reader = w.key(&["workspace.read"]).await;
    let client = w.connect(&reader, "reader-agent").await;
    let refused = err(&call(
        &client,
        "jeeta.work.set_checkin_interval",
        json!({ "minutes": 60 }),
    )
    .await);
    assert_eq!(refused["details"], json!({ "permission": "team.manage" }));

    let full = w.key(&[]).await;
    let client = w.connect(&full, "owner-agent").await;
    let state = ok(&call(
        &client,
        "jeeta.work.set_checkin_interval",
        json!({ "minutes": 60 }),
    )
    .await);
    assert_eq!(state["interval_minutes"], 60);
    assert_eq!(state["overdue"], false);
    let refused = err(&call(
        &client,
        "jeeta.work.set_checkin_interval",
        json!({ "minutes": 5 }),
    )
    .await);
    assert_eq!(refused["code"], "VALIDATION");
    assert_eq!(refused["details"]["field"], "minutes");

    let entries = w.entries("work.set_checkin_interval").await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload, json!({ "minutes": 60 }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_concurrent_checkins_do_not_exhaust_the_pool() {
    let w = World::new().await;
    // As the binary serves them: the channel catalog reads the capability registry in a bundle
    // of its own.
    let mut deps = w.deps.clone();
    deps.channels = Arc::new(UowChannelCatalog::new(deps.uow.clone()));
    let key = w.key(&["workspace.read"]).await;
    let principal = api_keys::authenticate(&deps, &key.plaintext).await.unwrap();
    let connection = agents::register_initialize(
        &deps,
        &principal,
        ClientInfo {
            name: "burst-agent".into(),
            version: "1.0".into(),
            protocol_version: "2025-06-18".into(),
        },
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    let ctx = api_keys::ctx_for_agent(&principal, connection, OffsetDateTime::now_utc());

    // The first check-in is ledgered; every later one within the hour is debounced, the path
    // that once held its bundle while reading what is pending.
    work::checkin(&deps, &ctx).await.unwrap();
    let burst = 2 * MAX_CONNECTIONS as usize;
    let calls: Vec<_> = (0..burst)
        .map(|_| {
            let (deps, ctx) = (deps.clone(), ctx.clone());
            tokio::spawn(async move { work::checkin(&deps, &ctx).await })
        })
        .collect();
    let answered = timeout(Duration::from_secs(10), async {
        let mut answers = Vec::with_capacity(calls.len());
        for call in calls {
            answers.push(call.await.expect("the check-in task completes"));
        }
        answers
    })
    .await
    .expect("every check-in answers within 10 s");
    for answer in answered {
        assert!(!answer.unwrap().agent.overdue);
    }
    assert_eq!(w.entries("work.checkin").await.len(), 1);
}
