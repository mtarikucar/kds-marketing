use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error};
#[tokio::test]
async fn ads_routes_require_authentication() {
    let p = Panel::new().await;
    let id = "00000000-0000-0000-0000-000000000001";
    let body = || Some(serde_json::json!({}));
    for (method, path, body) in [
        (Method::GET, "/api/ads/campaigns".to_owned(), None),
        (Method::POST, "/api/ads/campaigns".to_owned(), body()),
        (Method::GET, format!("/api/ads/campaigns/{id}"), None),
        (Method::PATCH, format!("/api/ads/campaigns/{id}"), body()),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/approve"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/decline"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/claim"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/release"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/plan"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/moves"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/pause"),
            body(),
        ),
        (
            Method::POST,
            format!("/api/ads/campaigns/{id}/resume"),
            body(),
        ),
        (Method::POST, format!("/api/ads/campaigns/{id}/end"), body()),
        (
            Method::GET,
            format!("/api/ads/campaigns/{id}/ads/0/preview?placement=facebook_feed"),
            None,
        ),
        (Method::GET, "/api/budget/breakdown".to_owned(), None),
        (Method::POST, "/api/budget/stop".to_owned(), body()),
    ] {
        expect_error(
            p.send(method, &path, None, body).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}
