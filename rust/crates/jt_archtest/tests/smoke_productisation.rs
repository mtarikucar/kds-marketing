//! M4 lifecycle on disposable Pg plus the existing M2/M3 recording-provider scenarios.
#[path = "../../jt_app/tests/smoke_inbox.rs"]
mod inbox;
#[path = "support/productisation_mcp.rs"]
mod mcp;
#[path = "../../jt_app/tests/smoke_studio.rs"]
mod studio;

use axum::http::{Method, StatusCode};
use jt_testkit::{
    flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD},
    panel::{Panel, cookie_pair, expect_error, ok_json, set_cookie, workspace_of},
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn post(p: &Panel, cookie: &str, path: &str, body: Option<Value>) -> Value {
    ok_json(p.send(Method::POST, path, Some(cookie), body).await).await
}

#[tokio::test]
async fn full_productisation_smoke() {
    let mut p = Panel::new().await;
    let (owner, me) = p
        .register_pending("owner@productisation.test", "Synthetic productisation")
        .await;
    let ws = workspace_of(&me);
    let (foreign, foreign_me) = p
        .register_pending("foreign@productisation.test", "Foreign")
        .await;
    assert_ne!(ws, workspace_of(&foreign_me));
    assert_eq!(
        post(&p, &owner, "/api/strategy/consultation", None).await["status"],
        "draft"
    );
    for path in ["/api/team", "/api/api-keys", "/api/capabilities"] {
        expect_error(
            p.get(path, &owner).await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
    }
    let status = ok_json(p.get("/api/billing", &owner).await).await;
    let evidence = json!({"reference":status["payment_reference"], "amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"synthetic-transfer"});
    expect_error(
        p.send(
            Method::POST,
            "/api/billing/payments",
            None,
            Some(evidence.clone()),
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    expect_error(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&foreign),
            Some(evidence.clone()),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let payment = post(&p, &owner, "/api/billing/payments", Some(evidence.clone())).await;
    assert_eq!(
        post(&p, &owner, "/api/billing/payments", Some(evidence)).await,
        payment
    );
    assert_eq!(payment["confirmed"], false);
    jt_app::usecases::platform::bootstrap(&p.deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
        .await
        .unwrap();
    let response = p
        .send(
            Method::POST,
            "/api/platform/login",
            None,
            Some(json!({"email":OPERATOR_EMAIL,"password":OPERATOR_PASSWORD})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let operator = cookie_pair(&set_cookie(&response));
    let confirm = format!(
        "/api/platform/workspaces/{ws}/payments/{}/confirm",
        payment["id"].as_str().unwrap()
    );
    expect_error(
        p.send(Method::POST, &confirm, Some(&owner), None).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    let issued = post(&p, &operator, &confirm, None).await;
    let code = issued["activation"]["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 8);
    let waiting = ok_json(p.get("/api/billing", &owner).await).await;
    assert_eq!(waiting["workspace_status"], "pending_payment");
    assert!(waiting["entitlement"]["activated_at"].is_null());
    assert!(!waiting.to_string().contains(&code));
    expect_error(
        p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&foreign),
            Some(json!({"code":code})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let active = post(
        &p,
        &owner,
        "/api/billing/activate",
        Some(json!({"code":code})),
    )
    .await;
    assert_eq!(active["workspace_status"], "active");
    assert!(!active["entitlement"]["activated_at"].is_null());
    assert!(
        !p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&owner),
            Some(json!({"code":code}))
        )
        .await
        .status()
        .is_success()
    );
    // Reconstruct adapters and router over persisted state; no activation fixture is used.
    p.deps.uow = Arc::new(jt_pg::PgUnitOfWork::new(p.db.pool.clone()));
    let gate = Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone()));
    p.app = jt_panel_http::router(jt_panel_http::AppState {
        deps: p.deps.clone(),
        gate: gate.clone(),
        cookie_secure: false,
        panel_dir: None,
    })
    .merge(jt_mcp::http_service(jt_mcp::McpState::new(
        p.deps.clone(),
        gate,
    )));
    assert_eq!(ok_json(p.get("/api/billing", &owner).await).await, active);
    expect_error(
        p.get("/api/studio/overview", &owner).await,
        StatusCode::CONFLICT,
        "STRATEGY_REQUIRED",
    )
    .await;
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert!(pending["agent"]["last_seen_at"].is_null());
    assert_eq!(
        ok_json(p.get("/api/capabilities", &owner).await).await,
        json!([])
    );
    p.invite(&owner, "teammate@productisation.test", "rep")
        .await;
    let key = post(&p,&owner,"/api/api-keys",Some(json!({"name":"Synthetic scoped agent","scopes":["workspace.read","capabilities.manage"]}))).await;
    let key = key["plaintext"].as_str().unwrap();
    let session = mcp::mcp_session(&p.app, key).await;
    let info = mcp::call_tool(&p.app, key, &session, "jeeta.workspace.info", json!({})).await;
    assert_eq!(info["id"], json!(ws));
    let forbidden = mcp::tool_result(
        &p.app,
        key,
        &session,
        "jeeta.team.invite",
        json!({"email":"escalation@productisation.test","role_key":"owner"}),
    )
    .await;
    assert_eq!(forbidden["isError"], true);
    assert_eq!(
        p.call(mcp::mcp(
            "invalid-synthetic-key",
            None,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize"})
        ))
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let cap = mcp::call_tool(
        &p.app,
        key,
        &session,
        "jeeta.capability.declare",
        json!({"kind_key":"phone","name":"Synthetic agent phone"}),
    )
    .await;
    let cap_id = cap["capability"]["id"].as_str().unwrap();
    let verified = mcp::call_tool(&p.app,key,&session,"jeeta.capability.verify",json!({"capability_id":cap_id,"evidence":{"text":"Synthetic recording evidence","refs":[]}})).await;
    assert_eq!(verified["capability"]["status"], "verified");
    expect_error(
        p.get(&format!("/api/capabilities/{cap_id}"), &foreign)
            .await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;
    let mut foreign_rows = p.deps.uow.tenant(workspace_of(&foreign_me)).await.unwrap();
    assert!(
        foreign_rows
            .capabilities()
            .find(serde_json::from_value(json!(cap_id)).unwrap())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        foreign_rows
            .billing()
            .get_payment(serde_json::from_value(payment["id"].clone()).unwrap())
            .await
            .unwrap()
            .is_none()
    );
    drop(foreign_rows);
    post(
        &p,
        &operator,
        &format!("/api/platform/workspaces/{ws}/suspend"),
        Some(json!({"reason":"synthetic review"})),
    )
    .await;
    expect_error(
        p.get("/api/strategy", &owner).await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;
    let suspended =
        mcp::tool_result(&p.app, key, &session, "jeeta.capability.list", json!({})).await;
    assert_eq!(suspended["isError"], true);
    post(
        &p,
        &operator,
        &format!("/api/platform/workspaces/{ws}/resume"),
        None,
    )
    .await;
    assert_eq!(
        ok_json(p.get("/api/billing", &owner).await).await["entitlement"],
        active["entitlement"]
    );
    post(
        &p,
        &operator,
        &format!("/api/platform/workspaces/{ws}/revoke-activation"),
        Some(json!({"reason":"synthetic revoke"})),
    )
    .await;
    let revoked = ok_json(p.get("/api/billing", &owner).await).await;
    assert_eq!(revoked["workspace_status"], "pending_payment");
    assert!(!revoked["entitlement"]["revoked_at"].is_null());
    let reissued = post(&p, &operator, &confirm, None).await;
    let next_code = reissued["activation"]["code"].as_str().unwrap();
    assert_ne!(code, next_code);
    assert!(
        !p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&owner),
            Some(json!({"code":code}))
        )
        .await
        .status()
        .is_success()
    );
    let reactivated = post(
        &p,
        &owner,
        "/api/billing/activate",
        Some(json!({"code":next_code})),
    )
    .await;
    assert_eq!(reactivated["workspace_status"], "active");
    assert_ne!(
        reactivated["entitlement"]["id"],
        active["entitlement"]["id"]
    );
    assert_eq!(reactivated["entitlement"]["payment_id"], payment["id"]);
    let health = ok_json(p.get("/api/platform/health", &operator).await).await;
    assert_eq!(health["history"], "unknown_before_process_start");
    assert_eq!(health["backup"]["backup_state"], "unknown");
    assert!(health["backup"]["last_backup_at"].is_null());
    expect_error(
        p.get("/api/platform/health", &owner).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    let ledger = ok_json(p.get("/api/ledger", &owner).await)
        .await
        .to_string();
    for secret in [
        &code,
        next_code,
        key,
        status["payment_reference"].as_str().unwrap(),
        OPERATOR_PASSWORD,
    ] {
        assert!(!ledger.contains(secret));
        assert!(!health.to_string().contains(secret));
    }
    jt_pg::recovery::check_schema(&p.db.pool, true)
        .await
        .unwrap();
    // Existing integrated M2/M3 scenarios; provider adapters are recording fakes.
    inbox::run_acceptance().await;
    studio::run_acceptance().await;
    jt_testkit::studio_attribution_contract::paid_smoke(p.deps.uow.clone()).await;
    // The smoke script also runs T9's m4_restore target, which copies/restores actual Pg rows,
    // and T5's subprocess log canaries; neither is replaced by a marker here.
}
