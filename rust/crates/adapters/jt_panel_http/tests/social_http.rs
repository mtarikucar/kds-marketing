use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error};
#[tokio::test]
async fn social_routes_require_authentication_including_pause() {
    let p = Panel::new().await;
    let account = "00000000-0000-0000-0000-000000000001";
    for (method, path, body) in [
        (
            Method::POST,
            "/api/social/versions/schedule".to_owned(),
            Some(serde_json::json!({})),
        ),
        (Method::GET, "/api/social/packages".to_owned(), None),
        (Method::GET, "/api/social/accounts".to_owned(), None),
        (Method::GET, format!("/api/social/accounts/{account}"), None),
        (
            Method::POST,
            format!("/api/social/accounts/{account}/pause"),
            Some(serde_json::json!({})),
        ),
    ] {
        expect_error(
            p.send(method, &path, None, body).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}
