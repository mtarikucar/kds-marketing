use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error, ok_json};
use serde_json::json;
#[tokio::test]
async fn projects_prepare_before_strategy_and_enforce_path_revision_and_tenant_boundaries() {
    let p = Panel::new().await;
    let (a, _) = p.register("projects-a@example.test", "A").await;
    let (b, _) = p.register("projects-b@example.test", "B").await;
    let created = ok_json(
        p.send(
            Method::POST,
            "/api/studio/projects",
            Some(&a),
            Some(json!({"request_key":"one","title":"Launch","brief":"Plan a real launch"})),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let path = format!("/api/studio/projects/{id}");
    let detail = ok_json(p.get(&path, &a).await).await;
    assert_eq!(detail["project"]["title"], "Launch");
    expect_error(p.get(&path, &b).await, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    expect_error(
        p.send(
            Method::PATCH,
            &path,
            Some(&a),
            Some(json!({"project_id":id,"expected_revision":1,"title":"No"})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let updated = ok_json(
        p.send(
            Method::PATCH,
            &path,
            Some(&a),
            Some(json!({"expected_revision":1,"brief":"Updated"})),
        )
        .await,
    )
    .await;
    assert_eq!(updated["revision"], 2);
    expect_error(
        p.send(
            Method::PATCH,
            &path,
            Some(&a),
            Some(json!({"expected_revision":1,"brief":"Stale"})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    let list = ok_json(p.get("/api/studio/projects", &a).await).await;
    assert_eq!(list["projects"].as_array().unwrap().len(), 1);
    assert!(list["next_cursor"].is_null());
}
