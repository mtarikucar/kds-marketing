use axum::http::StatusCode;
use jt_testkit::panel::Panel;
#[tokio::test]
async fn health_requires_operator_session() {
    let p = Panel::new().await;
    let (cookie, _) = p.register_pending("ops@synthetic.test", "Ops").await;
    assert_eq!(
        p.get("/api/platform/health", &cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn operator_receives_only_the_snapshot_and_process_paths_never_serve_spa() {
    use axum::http::Method;
    use jt_testkit::{
        flows::{OPERATOR_EMAIL, OPERATOR_PASSWORD},
        panel::{body_json, cookie_pair, set_cookie},
    };
    let p = Panel::new().await;
    jt_app::usecases::platform::bootstrap(&p.deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
        .await
        .unwrap();
    let response = p
        .send(
            Method::POST,
            "/api/platform/login",
            None,
            Some(serde_json::json!({"email":OPERATOR_EMAIL,"password":OPERATOR_PASSWORD})),
        )
        .await;
    let cookie = cookie_pair(&set_cookie(&response));
    let response = p.get("/api/platform/health", &cookie).await;
    assert_eq!(response.status(), StatusCode::OK);
    let health = body_json(response).await;
    assert_eq!(health["history"], "unknown_before_process_start");
    assert_eq!(health["database"], "unknown");
    for path in ["/readyz", "/metrics", "/readyz/extra", "/metrics/extra"] {
        assert!(jt_panel_http::static_files::is_reserved(path));
    }
}
