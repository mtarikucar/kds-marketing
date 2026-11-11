//! The module registry uses authenticated tenant context and accepts descriptions, not code.
use axum::http::{Method, StatusCode};
use jt_app::ports::UnitOfWork;
use jt_tenancy::WorkspaceStatus;
use jt_testkit::panel::{Panel, expect_error, ok_json, workspace_of};
use serde_json::json;

#[tokio::test]
async fn module_routes_enforce_auth_tenant_permissions_core_and_strict_manifests() {
    let p = Panel::new().await;
    let (a, _) = p.register("modules-a@example.test", "A").await;
    let (b, _) = p.register("modules-b@example.test", "B").await;
    expect_error(
        p.send(Method::GET, "/api/workspace/modules", None, None)
            .await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHENTICATED",
    )
    .await;
    let before = ok_json(p.get("/api/workspace/modules", &a).await).await;
    assert_eq!(
        before["modules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["installed"] == true)
            .count(),
        // A new workspace has the strategy and nothing else.
        1,
    );
    let blueprint = json!({
        "id":"quality-review", "name":"Quality review", "version":"1.0",
        "description":"Review supplied work", "requirements":["workshop.sensor"],
        "workflow":["Inspect evidence", "Record a decision"]
    });
    let path = "/api/workspace/modules/quality-review";
    let mut unsafe_blueprint = blueprint.clone();
    unsafe_blueprint["execute"] = json!("arbitrary shell command");
    expect_error(
        p.send(
            Method::PUT,
            path,
            Some(&a),
            Some(json!({"blueprint":unsafe_blueprint})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    ok_json(
        p.send(
            Method::PUT,
            path,
            Some(&a),
            Some(json!({"blueprint":blueprint})),
        )
        .await,
    )
    .await;
    let other = ok_json(p.get("/api/workspace/modules", &b).await).await;
    assert!(
        !other["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["blueprint"]["id"] == "quality-review")
    );
    let config =
        json!({"brief":"Review the requested evidence", "agent_ids":[], "capability_ids":[]});
    ok_json(
        p.send(
            Method::PATCH,
            path,
            Some(&a),
            Some(json!({"config":config,"revision":1})),
        )
        .await,
    )
    .await;
    expect_error(
        p.send(
            Method::PATCH,
            path,
            Some(&a),
            Some(json!({"config":config,"revision":1})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    // The strategy is the one module that cannot be removed; the inbox is an ordinary module.
    expect_error(
        p.send(
            Method::DELETE,
            "/api/workspace/modules/strategy",
            Some(&a),
            None,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let installed = |list: &serde_json::Value, id: &str| {
        list["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["blueprint"]["id"] == id && m["installed"] == true)
    };
    let with_inbox = ok_json(
        p.send(
            Method::PUT,
            "/api/workspace/modules/inbox",
            Some(&a),
            Some(json!({})),
        )
        .await,
    )
    .await;
    assert!(installed(&with_inbox, "inbox"));
    let without = ok_json(
        p.send(
            Method::DELETE,
            "/api/workspace/modules/inbox",
            Some(&a),
            None,
        )
        .await,
    )
    .await;
    assert!(!installed(&without, "inbox"));
    let (rep, _) = p.join(&a, "modules-rep@example.test", "rep").await;
    ok_json(p.get("/api/workspace/modules", &rep).await).await;
    expect_error(
        p.send(Method::DELETE, path, Some(&rep), None).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let removed = ok_json(p.send(Method::DELETE, path, Some(&a), None).await).await;
    let record = removed["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["blueprint"]["id"] == "quality-review")
        .unwrap();
    assert_eq!(record["installed"], false);
    assert_eq!(record["config"], config);
}

#[tokio::test]
async fn inactive_workspace_can_read_navigation_but_cannot_install_modules() {
    let p = Panel::new().await;
    let (cookie, me) = p
        .register_pending("modules-pending@example.test", "Pending")
        .await;
    for status in [WorkspaceStatus::PendingPayment, WorkspaceStatus::Suspended] {
        let mut platform = p.uow.platform().await.unwrap();
        platform
            .workspace_set_status(
                workspace_of(&me),
                status,
                "module gate test",
                &jt_ledger::Actor::System {
                    component: "test".into(),
                },
            )
            .await
            .unwrap();
        platform.commit().await.unwrap();
        ok_json(p.get("/api/workspace/modules", &cookie).await).await;
        expect_error(
            p.send(
                Method::PUT,
                "/api/workspace/modules/calls",
                Some(&cookie),
                Some(json!({})),
            )
            .await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
    }
}
