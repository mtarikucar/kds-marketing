//! The connection tools over MCP, end to end through Postgres, with scripted provider adapters:
//! an agent starts an OAuth flow and gets the URL to hand to the owner, but no tool completes the
//! flow (only the owner's browser does, on the panel); it enters NetGSM credentials the owner
//! gave it (the ledger notes that an agent did), probes the line and reads the health.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use jt_app::ctx::Ctx;
use jt_app::ports::LedgerFilter;
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_connector::{ProbeResult, Provider};
use jt_ledger::Actor;
use jt_mcp::{McpState, http_service};
use jt_pg::{PgStrategyGate, PgUnitOfWork};
use jt_tenancy::{SystemRole, UserId, WorkspaceId};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, PlainHasher, PlainSecretBox, RecordingTenantHosts, ScriptedConnector,
    ScriptedOAuth, ScriptedRegistry,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tower::ServiceExt;

/// A fresh database with one seeded, active workspace, its MCP endpoint in process, every
/// provider app configured and scripted Meta and NetGSM adapters.
struct World {
    _db: TestDb,
    deps: Deps,
    app: Router,
    ws: WorkspaceId,
    owner: UserId,
    netgsm: Arc<ScriptedConnector>,
    meta_oauth: Arc<ScriptedOAuth>,
}

impl World {
    async fn new() -> World {
        let db = TestDb::new().await;
        let netgsm =
            Arc::new(ScriptedConnector::new(Provider::Netgsm).with_hosts(&["api.netgsm.com.tr"]));
        let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
        let meta_oauth = Arc::new(ScriptedOAuth::new(Provider::Meta));
        let registry = ScriptedRegistry::new()
            .with_connector(netgsm.clone())
            .with_connector(meta)
            .with_oauth(meta_oauth.clone());
        let deps = Deps {
            uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
            clock: Arc::new(SystemClock),
            ids: Arc::new(UuidV7Gen),
            tokens: Arc::new(RandTokenGen),
            hasher: Arc::new(PlainHasher),
            seal: Arc::new(PlainSecretBox),
            channels: Arc::new(NoChannelsYet),
            file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
            media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
            files: Arc::new(jt_app::ports::files::UnavailableFileStore),
            transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
            archived_hook: Arc::new(NoopArchivedHook),
            hosts: Arc::new(RecordingTenantHosts::new()),
            apps: Arc::new(FakeAppConfig::with_all_apps()),
            connectors: Arc::new(registry),
            ops: std::sync::Arc::new(jt_app::ports::ops::UnknownOps),
            ops_signals: std::sync::Arc::new(jt_app::ports::ops::OpsSignals::default()),
            billing: jt_app::usecases::billing::BillingConfig {
                price_minor: 123,
                price_currency: "TRY".into(),
                bank_instructions: "Synthetic bank instructions".into(),
            },
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
            netgsm,
            meta_oauth,
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
                name: "connector agent".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap()
        .plaintext
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
                "clientInfo": { "name": "connector-agent", "version": "1.0" },
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

    /// The `result` of a JSON-RPC `method` with `params`.
    async fn rpc(&self, key: &str, session: &str, method: &str, params: Value) -> Value {
        static NEXT_ID: AtomicI64 = AtomicI64::new(2);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let call = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let resp = self.send(mcp(key, Some(session), &call)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        sse_message(resp, id).await["result"].clone()
    }

    /// The result of tool `name` with `arguments`, failed or not.
    async fn tool(&self, key: &str, session: &str, name: &str, arguments: Value) -> Value {
        self.rpc(
            key,
            session,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    /// The structured output of tool `name`, which must succeed.
    async fn ok(&self, key: &str, session: &str, name: &str, arguments: Value) -> Value {
        let result = self.tool(key, session, name, arguments).await;
        assert_ne!(result["isError"], json!(true), "{result}");
        result["structuredContent"].clone()
    }

    /// The structured error of tool `name`, which must fail with `code`.
    async fn refused(
        &self,
        key: &str,
        session: &str,
        name: &str,
        arguments: Value,
        code: &str,
    ) -> Value {
        let result = self.tool(key, session, name, arguments).await;
        assert_eq!(result["isError"], json!(true), "{result}");
        assert_eq!(result["structuredContent"]["code"], code, "{result}");
        result["structuredContent"].clone()
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
async fn agent_gets_an_authorize_url_but_cannot_complete() {
    let w = World::new().await;
    let key = w.key(&[]).await;
    let session = w.session(&key).await;

    // The agent sees seven connection tools, none of which completes a flow.
    let listed = w.rpc(&key, &session, "tools/list", json!({})).await;
    let names: Vec<&str> = listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .filter(|n| n.starts_with("jeeta.connector."))
        .collect();
    assert_eq!(
        names,
        [
            "jeeta.connector.start_oauth",
            "jeeta.connector.confirm_assets",
            "jeeta.connector.set_credentials",
            "jeeta.connector.probe",
            "jeeta.connector.health",
            "jeeta.connector.reconnect",
            "jeeta.connector.hooks",
        ]
    );

    // It starts a flow: the URL to hand to the owner, who signs in at the provider in their own
    // browser and comes back to the panel's page; the answer tells it so, in both languages.
    let started = w
        .ok(
            &key,
            &session,
            "jeeta.connector.start_oauth",
            json!({ "kind_key": "facebook_page" }),
        )
        .await;
    let url = started["authorize_url"].as_str().unwrap();
    assert!(url.contains("redirect_uri=https%3A%2F%2Fpanel.test%2Foauth%2Fcallback%2Fmeta"));
    assert!(started["pending_id"].is_string());
    assert!(started["expires_at"].is_string());
    let handoff = &started["handoff"];
    assert!(
        handoff["en"].as_str().unwrap().contains("owner"),
        "{handoff}"
    );
    assert!(
        handoff["tr"].as_str().unwrap().contains("sahib"),
        "{handoff}"
    );
    // The link and the connection are named apart, in both languages.
    let tr = handoff["tr"].as_str().unwrap();
    assert!(
        tr.contains("bağlantı adresini") && tr.contains("hesap bağlantısını"),
        "{tr}"
    );
    let en = handoff["en"].as_str().unwrap();
    assert!(
        en.contains("sign-in link") && en.contains("account connection"),
        "{en}"
    );
    let state = jt_app::ports::connectors::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .unwrap();

    // No tool completes it, whatever the agent knows of the state.
    let refused = w
        .refused(
            &key,
            &session,
            "jeeta.connector.complete_oauth",
            json!({ "state": state, "code": "code-1" }),
            "NOT_FOUND",
        )
        .await;
    assert_eq!(refused["message"], "no such tool");
    // Nor can it confirm the flow's assets before the owner's browser has come back, nor a flow
    // that does not exist.
    let refused = w
        .refused(
            &key,
            &session,
            "jeeta.connector.confirm_assets",
            json!({ "pending_id": started["pending_id"], "selected": ["page-1"] }),
            "CONFLICT",
        )
        .await;
    assert_eq!(refused["message"], "the provider has not called back yet");
    w.refused(
        &key,
        &session,
        "jeeta.connector.confirm_assets",
        json!({ "pending_id": "0192f0c4-0000-7000-8000-000000000000", "selected": ["page-1"] }),
        "NOT_FOUND",
    )
    .await;
    // The provider was asked for the URL only: no code was exchanged.
    assert_eq!(w.meta_oauth.calls().len(), 1);
    // Arguments are read strictly.
    w.refused(
        &key,
        &session,
        "jeeta.connector.start_oauth",
        json!({ "kind_key": "facebook_page", "redirect_uri": "https://evil.example" }),
        "VALIDATION",
    )
    .await;
}

#[tokio::test]
async fn agent_enters_credentials_the_owner_gave_it_and_the_ledger_notes_it() {
    let w = World::new().await;
    let key = w.key(&[]).await;
    let session = w.session(&key).await;

    w.netgsm.push_probe(ProbeResult::success(
        12,
        json!({ "account_id": "8508001234" }),
    ));
    let result = w
        .tool(
            &key,
            &session,
            "jeeta.connector.set_credentials",
            json!({
                "kind_key": "sms_line",
                "name": "SMS hattı",
                "credential": {
                    "kind": "netgsm_sms",
                    "usercode": "8508001234",
                    "password": "netgsm-pass-1",
                    "msgheader": "ALFA",
                },
            }),
        )
        .await;
    assert_ne!(result["isError"], json!(true), "{result}");
    assert!(!result.to_string().contains("netgsm-pass-1"), "{result}");
    let created = &result["structuredContent"];
    assert_eq!(created["capability"]["status"], "verified");
    let id = created["capability"]["id"].as_str().unwrap().to_owned();

    // The ledger: the agent entered them, and no secret is written.
    let mut repos = w.deps.uow.tenant(w.ws).await.unwrap();
    let entries = repos
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("connector.credentials_set".into()),
            actor_kind: None,
            agent_connection_id: None,
            limit: 500,
            before_id: None,
        })
        .await
        .unwrap();
    drop(repos);
    assert_eq!(entries.len(), 1);
    let entry = &entries[0].entry;
    assert_eq!(
        entry.payload,
        json!({ "kind_key": "sms_line", "by_agent": true })
    );
    assert!(matches!(entry.actor, Actor::Agent { .. }));
    assert!(
        !serde_json::to_string(&entries)
            .unwrap()
            .contains("netgsm-pass-1")
    );

    // It probes the line and reads the health.
    w.netgsm.push_probe(ProbeResult::success(
        9,
        json!({ "account_id": "8508001234" }),
    ));
    let probed = w
        .ok(
            &key,
            &session,
            "jeeta.connector.probe",
            json!({ "capability_id": id }),
        )
        .await;
    assert_eq!(probed["status"], "verified");
    assert_eq!(probed["result"]["ok"], true);
    let health = w
        .ok(&key, &session, "jeeta.connector.health", json!({}))
        .await;
    assert_eq!(health["connectors"].as_array().unwrap().len(), 1);
    assert_eq!(health["connectors"][0]["capability_id"], json!(id));
    assert_eq!(health["connectors"][0]["ok"], true);

    // A key that only reads probes and reads the health, but changes nothing.
    let reader = w.key(&["workspace.read"]).await;
    let reader_session = w.session(&reader).await;
    let refused = w
        .refused(
            &reader,
            &reader_session,
            "jeeta.connector.start_oauth",
            json!({ "kind_key": "facebook_page" }),
            "FORBIDDEN",
        )
        .await;
    assert_eq!(
        refused["details"],
        json!({ "permission": "capabilities.manage" })
    );
    w.ok(
        &reader,
        &reader_session,
        "jeeta.connector.health",
        json!({}),
    )
    .await;
}

#[tokio::test]
async fn set_credentials_arguments_are_strict_and_never_echoed() {
    let w = World::new().await;
    let key = w.key(&[]).await;
    let session = w.session(&key).await;
    let credential = |extra: Value| {
        let mut c = json!({
            "kind": "netgsm_sms",
            "usercode": "8508001234",
            "password": "netgsm-pass-1",
            "msgheader": "ALFA",
        });
        for (k, v) in extra.as_object().unwrap() {
            c[k] = v.clone();
        }
        c
    };
    // The panel's refused bodies, as tool arguments: an unknown field beside the credential or in
    // it, a missing field, a field of the wrong type, a credential that is not an object, an
    // unknown shape, no credential at all. Each is VALIDATION and repeats no value.
    for arguments in [
        json!({ "kind_key": "sms_line", "name": "H", "password": "netgsm-pass-1", "credential": credential(json!({})) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "token": "netgsm-pass-1" })) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm_sms", "usercode": "u", "msgheader": "K" } }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "password": 98_765_432 })) }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": "netgsm-pass-1" }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": { "kind": "netgsm-pass-1", "password": "x" } }),
        json!({ "kind_key": "sms_line", "name": "H" }),
        json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({ "usercode": "netgsm-pass-1\u{7}x" })) }),
    ] {
        let result = w
            .tool(
                &key,
                &session,
                "jeeta.connector.set_credentials",
                arguments.clone(),
            )
            .await;
        assert_eq!(result["isError"], json!(true), "{arguments}");
        assert_eq!(
            result["structuredContent"]["code"], "VALIDATION",
            "{result}"
        );
        let text = result.to_string();
        assert!(!text.contains("netgsm-pass-1"), "{text}");
        assert!(!text.contains("98765432"), "{text}");
    }
    // Nothing was asked of the provider, nothing written.
    assert!(w.netgsm.calls().is_empty());

    // Well formed, the answer holds no secret either.
    w.netgsm.push_probe(ProbeResult::success(
        12,
        json!({ "account_id": "8508001234" }),
    ));
    let result = w
        .tool(
            &key,
            &session,
            "jeeta.connector.set_credentials",
            json!({ "kind_key": "sms_line", "name": "H", "credential": credential(json!({})) }),
        )
        .await;
    assert_ne!(result["isError"], json!(true), "{result}");
    assert!(!result.to_string().contains("netgsm-pass-1"), "{result}");
}

#[tokio::test]
async fn agent_provisions_iys_on_existing_sms_line() {
    let w = World::new().await;
    let key = w.key(&[]).await;
    let session = w.session(&key).await;
    w.netgsm
        .push_probe(ProbeResult::success(12, json!({"account_id":"8508001234"})));
    let sms=w.ok(&key,&session,"jeeta.connector.set_credentials",json!({"kind_key":"sms_line","name":"SMS","credential":{"kind":"netgsm_sms","usercode":"8508001234","password":"sms-secret","msgheader":"ALFA"}})).await;
    let out=w.ok(&key,&session,"jeeta.connector.set_credentials",json!({"capability_id":sms["capability"]["id"],"credential":{"kind":"netgsm_iys","usercode":"8508001234","password":"iys-private","brand_code":"brand-42"}})).await;
    assert_eq!(out["capability"]["id"], sms["capability"]["id"]);
    assert_eq!(
        out["capability"]["connector_public"]["iys"]["brand_code"],
        "brand-42"
    );
    assert!(!out.to_string().contains("iys-private"));
    let error=w.refused(&key,&session,"jeeta.connector.set_credentials",json!({"capability_id":sms["capability"]["id"],"credential":{"kind":"netgsm_iys","usercode":"wrong","password":"iys-private","brand_code":"brand-42"}}),"VALIDATION").await;
    assert_eq!(error["details"]["reason"], "iys_usercode_mismatch");
    assert!(!error.to_string().contains("iys-private"));
}
