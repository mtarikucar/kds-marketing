use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, body_json, workspace_of};
use serde_json::json;

#[tokio::test]
async fn report_actor_and_workspace_are_server_derived() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@billing.test", "Billing").await;
    let (other, other_me) = p.register_pending("other@billing.test", "Other").await;
    let response = p.get("/api/billing", &cookie).await;
    assert_eq!(response.status(), StatusCode::OK);
    let status = body_json(response).await;
    let mut input = json!({"reference": status["payment_reference"], "amount_minor": 17, "paid_at":"2026-01-01T00:00:00Z", "request_key":"one"});
    for field in [
        "workspace_id",
        "reported_by",
        "code",
        "currency",
        "bank_instructions",
    ] {
        input[field] = json!("CANARY-secret");
        assert_eq!(
            p.send(
                Method::POST,
                "/api/billing/payments",
                Some(&cookie),
                Some(input.clone())
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        input.as_object_mut().unwrap().remove(field);
    }
    assert_eq!(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&other),
            Some(input.clone())
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let response = p
        .send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payment = body_json(response).await;
    let mut r = p.deps.uow.tenant(workspace_of(&me)).await.unwrap();
    let id = serde_json::from_value(payment["id"].clone()).unwrap();
    let row = r.billing().get_payment(id).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(row.reported_by).unwrap(),
        me["user_id"]
    );
    drop(r);
    let mut r = p.deps.uow.tenant(workspace_of(&other_me)).await.unwrap();
    assert!(r.billing().get_payment(id).await.unwrap().is_none());
    assert_eq!(
        r.billing().payment_confirmed(id).await.unwrap_err().code,
        jt_app::error::ErrorCode::NotFound
    );
}

#[tokio::test]
async fn payment_status_persists_across_restart() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@billing.test", "Billing").await;
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let input = json!({"reference":status["payment_reference"],"amount_minor":17,"paid_at":"2026-01-01T03:00:00+03:00","request_key":"restart"});
    let response = p
        .send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payment = body_json(response).await;
    let mut deps = p.deps.clone();
    deps.uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(p.db.pool.clone()));
    let principal =
        jt_app::usecases::auth::resolve_session(&deps, cookie.strip_prefix("jt_session=").unwrap())
            .await
            .unwrap();
    let ctx =
        jt_app::usecases::auth::ctx_for(&principal, workspace_of(&me), deps.clock.now()).unwrap();
    let read = jt_app::usecases::billing::status(&deps, &ctx)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(read.payment.unwrap()).unwrap(),
        payment
    );
    assert_eq!(read.payment_reference, status["payment_reference"]);
    assert_eq!(
        serde_json::to_value(
            jt_app::usecases::billing::report_payment(
                &deps,
                &ctx,
                serde_json::from_value(input).unwrap()
            )
            .await
            .unwrap()
        )
        .unwrap(),
        payment
    );
}

#[tokio::test]
async fn report_ledger_failure_rolls_back() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@billing.test", "Billing").await;
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    sqlx::raw_sql("create function reject_billing_ledger() returns trigger language plpgsql as $$ begin if NEW.action = 'billing.payment_reported' then raise exception 'synthetic ledger failure'; end if; return NEW; end $$; create trigger reject_billing_ledger before insert on ledger_entries for each row execute function reject_billing_ledger();").execute(&p.db.pool).await.unwrap();
    let response = p.send(Method::POST, "/api/billing/payments", Some(&cookie), Some(json!({"reference":status["payment_reference"],"amount_minor":17,"paid_at":"2026-01-01T00:00:00Z","request_key":"rollback"}))).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let mut r = p.deps.uow.tenant(workspace_of(&me)).await.unwrap();
    assert!(
        r.billing()
            .find_request("rollback")
            .await
            .unwrap()
            .is_none()
    );
    assert!(r.billing().entitlement().await.unwrap().is_none());
    assert_eq!(
        r.workspace().get().await.unwrap().status,
        jt_tenancy::WorkspaceStatus::PendingPayment
    );
}

#[tokio::test]
async fn confirmed_means_historical_paid_grant_not_active_access() {
    use jt_app::ports::{OperatorRow, billing::*};
    use jt_tenancy::{Email, OperatorId};
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@billing.test", "Billing").await;
    let ws = workspace_of(&me);
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let input = json!({"reference":status["payment_reference"],"amount_minor":17,"paid_at":"2026-01-01T00:00:00.123456Z","request_key":"history"});
    let response = p
        .send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payment = body_json(response).await;
    assert_eq!(payment["confirmed"], false);
    let now = p.deps.clock.now();
    let op = OperatorId::new_v7();
    let grant = WorkspaceEntitlement {
        id: EntitlementId::new_v7(),
        workspace_id: ws,
        source: EntitlementSource::Paid,
        payment_id: Some(serde_json::from_value(payment["id"].clone()).unwrap()),
        confirmed_by: Some(op),
        confirmed_at: now,
        activated_at: None,
        redeemed_by: None,
        revoked_at: None,
        reason: None,
    };
    let mut r = p.deps.uow.platform().await.unwrap();
    r.operators()
        .insert(OperatorRow {
            id: op,
            email: Email::parse("op@billing.test").unwrap(),
            password_hash: "synthetic".into(),
            created_at: now,
        })
        .await
        .unwrap();
    r.workspace_lock(ws).await.unwrap();
    r.entitlement_insert(grant.clone()).await.unwrap();
    r.entitlement_revoke(ws, grant.id, now, "synthetic revocation")
        .await
        .unwrap();
    r.commit().await.unwrap();
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    assert_eq!(status["workspace_status"], "pending_payment");
    assert_eq!(status["entitlement"]["id"], json!(grant.id));
    assert!(status["entitlement"]["revoked_at"].is_string());
    assert_eq!(status["payment"]["confirmed"], true);
    assert!(status["entitlement"].get("confirmed_by").is_none());
    assert!(status["payment"].get("reference_sealed").is_none());
    let mut r = p.deps.uow.tenant(ws).await.unwrap();
    assert!(r.billing().entitlement().await.unwrap().is_none());
    drop(r);
    let retry = body_json(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input),
        )
        .await,
    )
    .await;
    assert_eq!(retry["id"], payment["id"]);
    assert_eq!(retry["paid_at"], payment["paid_at"]);
    assert_eq!(retry["confirmed"], true);
}

#[tokio::test]
async fn concurrent_reports_create_one_payment_and_one_event() {
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("owner@billing.test", "Billing").await;
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let input = json!({"reference":status["payment_reference"],"amount_minor":17,"paid_at":"2026-01-01T00:00:00Z","request_key":"concurrent"});
    let (a, b) = tokio::join!(
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input.clone())
        ),
        p.send(
            Method::POST,
            "/api/billing/payments",
            Some(&cookie),
            Some(input)
        )
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(body_json(a).await, body_json(b).await);
    let mut r = p.deps.uow.tenant(workspace_of(&me)).await.unwrap();
    let entries = r
        .ledger()
        .list(jt_app::ports::LedgerFilter {
            action_prefix: Some("billing.payment_reported".into()),
            actor_kind: None,
            agent_connection_id: None,
            limit: 100,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
}

#[tokio::test]
async fn activation_requires_human_session_and_mutation_header() {
    let p = Panel::new().await;
    let (cookie, _) = p
        .register_pending("activate@billing.test", "Activate")
        .await;
    let response = p
        .send(
            Method::POST,
            "/api/billing/activate",
            Some(&cookie),
            Some(json!({"code":"BAD"})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let error = body_json(response).await;
    assert!(!error.to_string().contains("BAD"));
}

#[tokio::test]
async fn panel_activation_consumes_once_and_never_caches_or_echoes_codes() {
    use jt_app::usecases::{auth::LoginInput, platform};
    use jt_testkit::{
        flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD},
        panel::request,
    };
    let p = Panel::new().await;
    let (cookie, me) = p.register_pending("redeem@billing.test", "Redeem").await;
    let ws = workspace_of(&me);
    let status = body_json(p.get("/api/billing", &cookie).await).await;
    let payment=body_json(p.send(Method::POST,"/api/billing/payments",Some(&cookie),Some(json!({"reference":status["payment_reference"],"amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"redeem"}))).await).await;
    platform::bootstrap(&p.deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
        .await
        .unwrap();
    let session = platform::login(
        &p.deps,
        LoginInput {
            email: OPERATOR_EMAIL.into(),
            password: OPERATOR_PASSWORD.into(),
        },
    )
    .await
    .unwrap();
    let ctx = platform::resolve(&p.deps, &session.token).await.unwrap();
    let code = jt_app::usecases::platform_payments::confirm(
        &p.deps,
        &ctx,
        ws,
        serde_json::from_value(payment["id"].clone()).unwrap(),
    )
    .await
    .unwrap()
    .activation
    .unwrap()
    .code;
    let path = "/api/billing/activate";
    let missing_header = p
        .call(request(
            Method::POST,
            path,
            Some(&cookie),
            false,
            Some(json!({"code":code})),
        ))
        .await;
    assert_eq!(missing_header.status(), StatusCode::FORBIDDEN);
    let no_session = p
        .send(Method::POST, path, None, Some(json!({"code":code})))
        .await;
    assert_eq!(no_session.status(), StatusCode::UNAUTHORIZED);
    // Unknown field names can contain secrets; never forward serde's diagnostics.
    let invalid = p
        .send(
            Method::POST,
            path,
            Some(&cookie),
            Some(json!({"code":code,code.clone():"secret"})),
        )
        .await;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(invalid.headers()["cache-control"], "no-store");
    assert!(!body_json(invalid).await.to_string().contains(&code));
    let response = p
        .send(
            Method::POST,
            path,
            Some(&cookie),
            Some(json!({"code":code})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let out = body_json(response).await;
    assert_eq!(out["workspace_status"], "active");
    assert!(!out.to_string().contains(&code));
    let replay = p
        .send(
            Method::POST,
            path,
            Some(&cookie),
            Some(json!({"code":code})),
        )
        .await;
    assert_eq!(replay.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(replay.headers()["cache-control"], "no-store");
    assert_eq!(body_json(p.get("/api/billing", &cookie).await).await, out);
}
