use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use jt_app::ports::LedgerFilter;
use jt_testkit::panel::{Panel, body_json, workspace_of};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

async fn send(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
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
async fn http_mcp_payment_effect_parity_without_code() {
    let mut p = Panel::new().await;
    let (cookie, me) = p.register("owner@billing.test", "Billing").await;
    let ws = workspace_of(&me);
    let response = p
        .send(
            Method::POST,
            "/api/api-keys",
            Some(&cookie),
            Some(json!({"name":"report","scopes":["team.manage"]})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let key = body_json(response).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned();
    let response = p
        .send(
            Method::POST,
            "/api/api-keys",
            Some(&cookie),
            Some(json!({"name":"read","scopes":["workspace.read"]})),
        )
        .await;
    let read_key = body_json(response).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned();
    // These keys were issued while active. Returning to pending never issues unpaid keys.
    let mut r = p.deps.uow.platform().await.unwrap();
    let grant = r.entitlement_get(ws).await.unwrap().unwrap();
    r.entitlement_revoke(ws, grant.id, p.deps.clock.now(), "test revocation")
        .await
        .unwrap();
    r.workspace_set_status(
        ws,
        jt_tenancy::WorkspaceStatus::PendingPayment,
        "test revocation",
        &jt_ledger::Actor::System {
            component: "billing-test".into(),
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    p.app = p
        .app
        .clone()
        .merge(jt_mcp::http_service(jt_mcp::McpState::new(
            p.deps.clone(),
            Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone())),
        )));
    let session = mcp_session(&p.app, &key).await;
    let read_session = mcp_session(&p.app, &read_key).await;
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let mut input = json!({"reference":status["payment_reference"],"amount_minor":17,"paid_at":"2026-01-01T00:00:00Z","request_key":"agent-first"});
    let name = "jeeta.billing.report_payment";
    let denied = tool_result(&p.app, &read_key, &read_session, name, input.clone()).await;
    assert_eq!(denied["isError"], true);
    assert!(denied.to_string().contains("FORBIDDEN"));
    for field in ["code", "workspace_id", "reported_by", "currency"] {
        input[field] = json!("CANARY");
        let refused = tool_result(&p.app, &key, &session, name, input.clone()).await;
        assert_eq!(refused["isError"], true);
        assert!(refused.to_string().contains("VALIDATION"));
        input.as_object_mut().unwrap().remove(field);
    }
    let agent = call_tool(&p.app, &key, &session, name, input.clone()).await;
    let response = p
        .send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await, agent);
    input["request_key"] = json!("human-first");
    let human = body_json(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(call_tool(&p.app, &key, &session, name, input).await, human);
    let mut r = p.deps.uow.tenant(ws).await.unwrap();
    let entries = r
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("billing.payment_reported".into()),
            limit: 100,
            actor_kind: None,
            agent_connection_id: None,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert_eq!(entry.entry.payload.as_object().unwrap().len(), 1);
        assert!(entry.entry.payload["payment_id"].is_string());
    }
    assert!(
        entries
            .iter()
            .any(|e| matches!(e.entry.actor, jt_ledger::Actor::Agent { .. }))
    );
    assert!(
        entries
            .iter()
            .any(|e| matches!(e.entry.actor, jt_ledger::Actor::Human { .. }))
    );
    assert!(r.billing().entitlement().await.unwrap().is_none());
    assert_eq!(
        r.workspace().get().await.unwrap().status,
        jt_tenancy::WorkspaceStatus::PendingPayment
    );
    drop(r);
    let mut r = p.deps.uow.platform().await.unwrap();
    r.workspace_set_status(
        ws,
        jt_tenancy::WorkspaceStatus::Suspended,
        "test suspension",
        &jt_ledger::Actor::System {
            component: "billing-test".into(),
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    let denied = tool_result(&p.app, &key, &session, name, json!({})).await;
    assert!(denied.to_string().contains("WORKSPACE_INACTIVE"));
}

#[test]
fn billing_surface_schema_and_exact_exemptions() {
    use jt_app::catalog::{CATALOG, StatusExemption, status_exemption};
    let rows: Vec<_> = CATALOG
        .iter()
        .filter(|r| r.id.starts_with("billing."))
        .collect();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        [
            "billing.status",
            "billing.activate",
            "billing.report_payment"
        ]
    );
    assert!(rows[0].panel_only);
    assert!(rows[0].mcp_tool.is_none());
    assert_eq!(rows[0].status_exemption, StatusExemption::Always);
    assert_eq!(rows[1].status_exemption, StatusExemption::PendingPayment);
    for id in [
        "billing.activate.extra",
        "billing.other",
        "billing.status.extra",
        "billing.report_payment.extra",
    ] {
        assert_eq!(status_exemption(id), StatusExemption::Never);
    }
    let tools = jt_mcp::registry();
    let tool = tools
        .iter()
        .find(|t| t.name == "jeeta.billing.report_payment")
        .unwrap();
    assert_eq!(tool.permission, jt_tenancy::Permission::TeamManage);
    let schema = tool.input_schema.as_value();
    assert_eq!(schema["additionalProperties"], false);
    let keys: Vec<_> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["amount_minor", "paid_at", "reference", "request_key"]
    );
}

#[tokio::test]
async fn code_never_returned_to_agent() {
    use jt_app::usecases::{auth::LoginInput, platform, platform_payments};
    use jt_testkit::flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD};
    let mut p = Panel::new().await;
    let (cookie, me) = p.register("secrets@billing.test", "Secrets").await;
    let ws = workspace_of(&me);
    let response=p.send(Method::POST,"/api/api-keys",Some(&cookie),Some(json!({"name":"owner","scopes":jt_tenancy::SystemRole::Owner.permissions().into_iter().map(|p| p.key()).collect::<Vec<_>>()}))).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let key = body_json(response).await["plaintext"]
        .as_str()
        .unwrap()
        .to_owned();
    let operator = platform::login(
        &p.deps,
        LoginInput {
            email: OPERATOR_EMAIL.into(),
            password: OPERATOR_PASSWORD.into(),
        },
    )
    .await
    .unwrap();
    let opctx = platform::resolve(&p.deps, &operator.token).await.unwrap();
    platform_payments::revoke_activation(&p.deps, &opctx, ws, "new payment")
        .await
        .unwrap();
    p.app = p
        .app
        .clone()
        .merge(jt_mcp::http_service(jt_mcp::McpState::new(
            p.deps.clone(),
            Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone())),
        )));
    let session = mcp_session(&p.app, &key).await;
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let input = json!({"reference":status["payment_reference"],"amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"agent-secret"});
    let payment = call_tool(
        &p.app,
        &key,
        &session,
        "jeeta.billing.report_payment",
        input.clone(),
    )
    .await;
    let delivered = platform_payments::confirm(
        &p.deps,
        &opctx,
        ws,
        serde_json::from_value(payment["id"].clone()).unwrap(),
    )
    .await
    .unwrap()
    .activation
    .unwrap();
    let listing = json!({"jsonrpc":"2.0","id":900,"method":"tools/list","params":{}});
    let listed = sse_message(send(&p.app, mcp(&key, Some(&session), &listing)).await, 900).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 132);
    assert!(!listed.to_string().contains("jeeta.billing.activate"));
    assert!(!listed.to_string().contains(&delivered.code));
    let call = json!({"jsonrpc":"2.0","id":901,"method":"tools/call","params":{"name":"jeeta.billing.activate","arguments":{"code":delivered.code}}});
    let refused = sse_message(send(&p.app, mcp(&key, Some(&session), &call)).await, 901).await;
    assert!(refused["error"].is_object() || refused["result"]["isError"] == true);
    assert!(!refused.to_string().contains(&delivered.code));
    let report = call_tool(
        &p.app,
        &key,
        &session,
        "jeeta.billing.report_payment",
        input,
    )
    .await;
    assert_eq!(report["confirmed"], true);
    assert!(!report.to_string().contains(&delivered.code));
    let bearer = Request::post("/api/billing/activate")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-requested-with", "jeeta-panel")
        .body(Body::from(json!({"code":delivered.code}).to_string()))
        .unwrap();
    assert_eq!(
        send(&p.app, bearer).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let mut r = p.deps.uow.tenant(ws).await.unwrap();
    let current = r
        .activation_codes()
        .lock_current_by_workspace()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.attempts, 0);
    assert!(current.consumed_at.is_none());
    drop(r);
    assert_eq!(
        p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&cookie),
            Some(json!({"code":delivered.code}))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let ledger = call_tool(&p.app, &key, &session, "jeeta.ledger.list", json!({})).await;
    assert!(!ledger.to_string().contains(&delivered.code));
    assert!(
        !ledger
            .to_string()
            .contains(status["payment_reference"].as_str().unwrap())
    );
}
