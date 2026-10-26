use axum::http::{Method, StatusCode, header};
use jt_testkit::{
    flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD},
    panel::{Panel, body_json, cookie_pair, ok_json, request, set_cookie, workspace_of},
};
use serde_json::json;

async fn operator(p: &Panel) -> String {
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
    cookie_pair(&set_cookie(&response))
}

#[tokio::test]
async fn legacy_status_route_is_removed() {
    let p = Panel::new().await;
    let op = operator(&p).await;
    let (_, me) = p.register_pending("owner@legacy.test", "Legacy").await;
    let ws = workspace_of(&me);
    assert_eq!(
        p.send(
            Method::PATCH,
            &format!("/api/platform/workspaces/{ws}/status"),
            Some(&op),
            Some(json!({"status":"active"}))
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn operator_payment_routes_deliver_once_and_never_cache() {
    let p = Panel::new().await;
    let op = operator(&p).await;
    let (tenant, me) = p
        .register_pending("owner@confirmation.test", "Confirmation")
        .await;
    let ws = workspace_of(&me);
    let status = ok_json(p.get("/api/billing", &tenant).await).await;
    let payment=ok_json(p.send(Method::POST,"/api/billing/payments",Some(&tenant),Some(json!({"reference":status["payment_reference"],"amount_minor":123,"paid_at":"2026-01-01T00:00:00Z","request_key":"one"}))).await).await;
    let id = payment["id"].as_str().unwrap();
    let base = format!("/api/platform/workspaces/{ws}");
    let listed = p.get("/api/platform/payments", &op).await;
    assert_eq!(listed.headers()[header::CACHE_CONTROL], "no-store");
    let listed = ok_json(listed).await;
    assert_eq!(listed[0]["reference"], status["payment_reference"]);
    assert_eq!(listed[0]["amount_minor"], 123);
    assert!(listed[0]["entitlement"].is_null());
    let path = format!("{base}/payments/{id}/confirm");
    let first = p.send(Method::POST, &path, Some(&op), None).await;
    assert_eq!(first.headers()[header::CACHE_CONTROL], "no-store");
    let first = ok_json(first).await;
    assert_eq!(first["workspace"]["status"], "pending_payment");
    let code = first["activation"]["code"].as_str().unwrap();
    assert_eq!(code.len(), 8);
    let retry = ok_json(p.send(Method::POST, &path, Some(&op), None).await).await;
    assert!(retry["activation"].is_null());
    assert_eq!(retry["entitlement"], first["entitlement"]);
    let response = p
        .send(
            Method::POST,
            &format!("{base}/payments/{id}/reissue"),
            Some(&op),
            None,
        )
        .await;
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let reissued = ok_json(response).await;
    assert_ne!(first["activation"]["code"], reissued["activation"]["code"]);
    let revoked = ok_json(
        p.send(
            Method::POST,
            &format!("{base}/revoke-activation"),
            Some(&op),
            Some(json!({"reason":"cancel confirmation"})),
        )
        .await,
    )
    .await;
    assert_eq!(revoked["status"], "pending_payment");
    // Tenant ledger browsing remains gated while pending; inspect durable effects via the repository.
    let mut r = p.deps.uow.tenant(ws).await.unwrap();
    let entries = r
        .ledger()
        .list(jt_app::ports::LedgerFilter {
            action_prefix: Some("billing.".into()),
            actor_kind: None,
            agent_connection_id: None,
            limit: 100,
            before_id: None,
        })
        .await
        .unwrap();
    drop(r);
    let ledger = serde_json::to_value(entries).unwrap();
    assert_eq!(ledger.as_array().unwrap().len(), 4);
    assert!(!ledger.to_string().contains(code));
    assert!(
        !ledger
            .to_string()
            .contains(status["payment_reference"].as_str().unwrap())
    );
    let tenant_view = ok_json(p.get("/api/billing", &tenant).await).await;
    assert!(!tenant_view.to_string().contains(code));
}

#[tokio::test]
async fn operator_routes_require_separate_session_and_csrf_header() {
    let p = Panel::new().await;
    let op = operator(&p).await;
    let (tenant, me) = p
        .register_pending("owner@boundaries.test", "Boundaries")
        .await;
    let ws = workspace_of(&me);
    let payment = jt_app::ports::billing::PaymentId::new_v7();
    let base = format!("/api/platform/workspaces/{ws}");
    let routes = [
        format!("{base}/payments/{payment}/confirm"),
        format!("{base}/payments/{payment}/reissue"),
        format!("{base}/revoke-activation"),
        format!("{base}/suspend"),
        format!("{base}/resume"),
    ];
    let forged = format!(
        "jt_platform={}",
        tenant.strip_prefix("jt_session=").unwrap()
    );
    for cookie in ["", tenant.as_str(), forged.as_str()] {
        assert_eq!(
            p.get("/api/platform/payments", cookie).await.status(),
            StatusCode::UNAUTHORIZED
        );
        for route in &routes {
            assert_eq!(
                p.send(
                    Method::POST,
                    route,
                    Some(cookie),
                    Some(json!({"reason":"hold"}))
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    for route in &routes {
        assert_eq!(
            p.call(request(
                Method::POST,
                route,
                Some(&op),
                false,
                Some(json!({"reason":"hold"}))
            ))
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    for action in ["suspend", "revoke-activation"] {
        for body in [
            json!({}),
            json!({"reason":"  "}),
            json!({"reason":"ü".repeat(501)}),
            json!({"reason":"hold","status":"active"}),
        ] {
            let response = p
                .send(
                    Method::POST,
                    &format!("{base}/{action}"),
                    Some(&op),
                    Some(body),
                )
                .await;
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(body_json(response).await["code"], "VALIDATION");
        }
    }
    assert_eq!(
        p.send(Method::POST, &format!("{base}/resume"), Some(&op), None)
            .await
            .status(),
        StatusCode::CONFLICT
    );
}
