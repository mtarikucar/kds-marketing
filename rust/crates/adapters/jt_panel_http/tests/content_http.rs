use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error};
#[tokio::test]
async fn content_routes_require_authentication_including_redo() {
    let p = Panel::new().await;
    for suffix in [
        "claim",
        "progress",
        "release",
        "delivery",
        "redo",
        "delivery/accept",
    ] {
        expect_error(
            p.send(
                Method::POST,
                &format!("/api/content/areas/00000000-0000-0000-0000-000000000001/{suffix}"),
                None,
                Some(serde_json::json!({})),
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}
