//! First-run refusals use the production router, fresh PostgreSQL, and real payment redemption.
use axum::http::{Method, StatusCode, header};
use jt_app::usecases::{auth, billing, platform};
use jt_testkit::{
    flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD, activate_workspace},
    panel::{
        Panel, body_json, cookie_pair, expect_error, ok_json, request, set_cookie, workspace_of,
    },
};
use serde_json::{Value, json};

async fn operator(p: &Panel) -> String {
    platform::bootstrap(&p.deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
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
    cookie_pair(&set_cookie(&response))
}

async fn report(p: &Panel, owner: &str) -> Value {
    let status = ok_json(p.get("/api/billing", owner).await).await;
    ok_json(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(owner),
            Some(json!({
                "reference":status["payment_reference"],"amount_minor":status["price_minor"],
                "paid_at":"2026-01-01T00:00:00Z","request_key":"first-run"
            })),
        )
        .await,
    )
    .await
}

async fn confirm(p: &Panel, owner: &str, op: &str, me: &Value) -> String {
    let payment = report(p, owner).await;
    let path = format!(
        "/api/platform/workspaces/{}/payments/{}/confirm",
        workspace_of(me),
        payment["id"].as_str().unwrap()
    );
    let confirmed = ok_json(p.send(Method::POST, &path, Some(op), None).await).await;
    confirmed["activation"]["code"].as_str().unwrap().into()
}

async fn redeem(p: &Panel, owner: &str, code: &str) -> Value {
    let response = p
        .send(
            Method::POST,
            "/api/billing/activate",
            Some(owner),
            Some(json!({"code":code})),
        )
        .await;
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    ok_json(response).await
}

async fn locked_actions(p: &Panel, owner: &str) {
    for (path, body) in [
        (
            "/api/team/invites",
            json!({"email":"member@journey.test","role_key":"rep"}),
        ),
        (
            "/api/api-keys",
            json!({"name":"Scoped agent","scopes":["workspace.read"]}),
        ),
    ] {
        expect_error(
            p.send(Method::POST, path, Some(owner), Some(body)).await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
    }
}

#[tokio::test]
async fn pending_owner_can_prepare_strategy_and_report_but_not_invite_or_create_key() {
    let p = Panel::new().await;
    let (owner, _) = p.register_pending("owner@journey.test", "Journey").await;
    let draft = ok_json(
        p.send(
            Method::POST,
            "/api/strategy/consultation",
            Some(&owner),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(draft["status"], "draft");
    let evidence = report(&p, &owner).await;
    assert_eq!(evidence["confirmed"], false);
    locked_actions(&p, &owner).await;
    let status = ok_json(p.get("/api/billing", &owner).await).await;
    assert_eq!(status["workspace_status"], "pending_payment");
    assert!(status["entitlement"].is_null());
}

#[tokio::test]
async fn confirmation_waits_for_code_activation() {
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("owner@journey.test", "Journey").await;
    let op = operator(&p).await;
    let code = confirm(&p, &owner, &op, &me).await;
    let status = ok_json(p.get("/api/billing", &owner).await).await;
    assert_eq!(status["payment"]["confirmed"], true);
    assert_eq!(status["workspace_status"], "pending_payment");
    assert!(status["entitlement"]["activated_at"].is_null());
    assert!(!status.to_string().contains(&code));
    locked_actions(&p, &owner).await;
    expect_error(
        p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&owner),
            Some(json!({"code":"BAD"})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    locked_actions(&p, &owner).await;
}

#[tokio::test]
async fn activation_unlocks_workspace_but_not_strategy_or_agent() {
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("owner@journey.test", "Journey").await;
    let op = operator(&p).await;
    let code = confirm(&p, &owner, &op, &me).await;
    assert_eq!(
        redeem(&p, &owner, &code).await["workspace_status"],
        "active"
    );
    assert_eq!(
        ok_json(p.get("/api/workspace", &owner).await).await["status"],
        "active"
    );
    let pending = ok_json(p.get("/api/work/pending", &owner).await).await;
    assert_eq!(pending["strategy"], "missing");
    assert!(pending["agent"]["last_seen_at"].is_null());
    assert_eq!(pending["agent"]["overdue"], true);
    assert_eq!(
        ok_json(p.get("/api/capabilities", &owner).await).await,
        json!([])
    );
    assert_eq!(ok_json(p.get("/api/agents", &owner).await).await, json!([]));
    p.invite(&owner, "member@journey.test", "rep").await;
    let key = p
        .send(
            Method::POST,
            "/api/api-keys",
            Some(&owner),
            Some(json!({"name":"Agent","scopes":["workspace.read"]})),
        )
        .await;
    assert_eq!(key.status(), StatusCode::CREATED);
    // An actual strategy-dependent route still refuses work after activation.
    expect_error(
        p.get("/api/studio/overview", &owner).await,
        StatusCode::CONFLICT,
        "STRATEGY_REQUIRED",
    )
    .await;
}

#[tokio::test]
async fn owner_redemption_after_transfer_of_ownership() {
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("owner@journey.test", "Journey").await;
    let ws = workspace_of(&me);
    activate_workspace(&p.deps, ws).await;
    let (next, next_membership) = p.join(&owner, "next@journey.test", "owner").await;
    let op = operator(&p).await;
    ok_json(
        p.send(
            Method::POST,
            &format!("/api/platform/workspaces/{ws}/revoke-activation"),
            Some(&op),
            Some(json!({"reason":"new paid entitlement"})),
        )
        .await,
    )
    .await;
    let code = confirm(&p, &owner, &op, &me).await;
    // Membership transition fixture: team writes are deliberately unavailable while pending.
    // Redeem must reread current ownership rather than bind the issued code to the old owner.
    let mut repos = p.deps.uow.tenant(ws).await.unwrap();
    let manager = repos.roles().find_by_key("manager").await.unwrap().unwrap();
    let old = serde_json::from_value(me["memberships"][0]["membership_id"].clone()).unwrap();
    repos.memberships().set_role(old, manager.id).await.unwrap();
    repos.commit().await.unwrap();
    expect_error(
        p.send(
            Method::POST,
            "/api/billing/activate",
            Some(&owner),
            Some(json!({"code":code})),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(redeem(&p, &next, &code).await["workspace_status"], "active");
    let team = ok_json(p.get("/api/team", &next).await).await;
    assert!(
        team.as_array()
            .unwrap()
            .iter()
            .any(|m| m["membership_id"] == next_membership && m["role_key"] == "owner")
    );
    let current = ok_json(p.get("/api/auth/me", &next).await).await;
    let mut repos = p.deps.uow.tenant(ws).await.unwrap();
    let grant = repos.billing().entitlement().await.unwrap().unwrap();
    assert_eq!(json!(grant.redeemed_by), current["user_id"]);
}

#[tokio::test]
async fn suspended_reload_preserves_entitlement_and_resume_restores_access() {
    let p = Panel::new().await;
    let (owner, me) = p.register_pending("owner@journey.test", "Journey").await;
    let ws = workspace_of(&me);
    let op = operator(&p).await;
    let code = confirm(&p, &owner, &op, &me).await;
    let active = redeem(&p, &owner, &code).await;
    ok_json(
        p.send(
            Method::POST,
            &format!("/api/platform/workspaces/{ws}/suspend"),
            Some(&op),
            Some(json!({"reason":"review"})),
        )
        .await,
    )
    .await;
    // A freshly constructed router/UoW over the same database represents a reload/restart.
    let mut deps = p.deps.clone();
    deps.uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(p.db.pool.clone()));
    let app = jt_panel_http::router(jt_panel_http::AppState {
        deps,
        gate: std::sync::Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone())),
        cookie_secure: false,
        panel_dir: None,
    });
    use tower::ServiceExt;
    let reloaded = ok_json(
        app.oneshot(request(
            Method::GET,
            "/api/billing",
            Some(&owner),
            false,
            None,
        ))
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(reloaded["workspace_status"], "suspended");
    assert_eq!(reloaded["entitlement"], active["entitlement"]);
    locked_actions(&p, &owner).await;
    expect_error(
        p.send(
            Method::POST,
            "/api/strategy/consultation",
            Some(&owner),
            None,
        )
        .await,
        StatusCode::LOCKED,
        "WORKSPACE_INACTIVE",
    )
    .await;
    expect_error(p.send(Method::POST,"/api/billing/payments",Some(&owner),Some(json!({"reference":active["payment_reference"],"amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"suspended"}))).await,StatusCode::LOCKED,"WORKSPACE_INACTIVE").await;
    ok_json(
        p.send(
            Method::POST,
            &format!("/api/platform/workspaces/{ws}/resume"),
            Some(&op),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        ok_json(p.get("/api/billing", &owner).await).await["entitlement"],
        active["entitlement"]
    );
    assert_eq!(
        p.get("/api/api-keys", &owner).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn narrow_scopes_do_not_gain_owner_actions() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@journey.test", "Journey").await;
    let key = ok_json(
        p.send(
            Method::POST,
            "/api/api-keys",
            Some(&owner),
            Some(json!({"name":"Read only","scopes":["workspace.read"]})),
        )
        .await,
    )
    .await;
    let principal =
        jt_app::usecases::api_keys::authenticate(&p.deps, key["plaintext"].as_str().unwrap())
            .await
            .unwrap();
    let human = auth::resolve_session(&p.deps, owner.strip_prefix("jt_session=").unwrap())
        .await
        .unwrap();
    let mut ctx = auth::ctx_for(&human, workspace_of(&me), p.deps.clock.now()).unwrap();
    ctx.permissions = principal.permissions;
    assert_eq!(
        jt_app::usecases::api_keys::create(
            &p.deps,
            &ctx,
            serde_json::from_value(json!({"name":"Escalate","scopes":["team.manage"]})).unwrap()
        )
        .await
        .unwrap_err()
        .code,
        jt_app::error::ErrorCode::Forbidden
    );
    assert_eq!(
        jt_app::usecases::team::invite(
            &p.deps,
            &ctx,
            serde_json::from_value(json!({"email":"escalate@journey.test","role_key":"owner"}))
                .unwrap()
        )
        .await
        .unwrap_err()
        .code,
        jt_app::error::ErrorCode::Forbidden
    );

    let status = billing::status(&p.deps, &ctx).await.unwrap();
    assert_eq!(
        billing::report_payment(
            &p.deps,
            &ctx,
            billing::ReportPaymentInput {
                reference: status.payment_reference,
                amount_minor: 123,
                paid_at: p.deps.clock.now(),
                request_key: "narrow".into(),
            }
        )
        .await
        .unwrap_err()
        .code,
        jt_app::error::ErrorCode::Forbidden
    );
    assert_eq!(
        billing::activate(&p.deps, &ctx, billing::ActivateInput { code: "BAD".into() })
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::Forbidden
    );
    let (rep, _) = p.join(&owner, "rep@journey.test", "rep").await;
    for (path, body) in [
        (
            "/api/team/invites",
            json!({"email":"no@journey.test","role_key":"owner"}),
        ),
        (
            "/api/api-keys",
            json!({"name":"Escalate","scopes":["team.manage"]}),
        ),
        ("/api/billing/activate", json!({"code":"BAD"})),
        (
            "/api/billing/payments",
            json!({"reference":"BAD","amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"rep"}),
        ),
    ] {
        expect_error(
            p.send(Method::POST, path, Some(&rep), Some(body.clone()))
                .await,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
        let mut req = request(Method::POST, path, None, true, Some(body));
        req.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {}", key["plaintext"].as_str().unwrap())
                .parse()
                .unwrap(),
        );
        expect_error(
            p.call(req).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
    assert_eq!(
        body_json(p.get("/api/api-keys", &owner).await)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
