use jt_tenancy::Permission;
#[test]
fn content_tools_are_exact_strict_and_agent_work_scoped() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.content."))
        .collect();
    let mut names: Vec<_> = tools.iter().map(|t| t.name).collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "jeeta.content.area_claim",
            "jeeta.content.area_deliver",
            "jeeta.content.area_progress",
            "jeeta.content.area_release",
            "jeeta.content.olay_view",
        ]
    );
    for t in tools {
        assert_eq!(t.input_schema.as_value()["additionalProperties"], false);
        if t.name == "jeeta.content.olay_view" {
            // The page's olay reads with the library's or the content's permission.
            assert_eq!(
                t.permissions,
                &[
                    Permission::MaterialsWork,
                    Permission::ContentWork,
                    Permission::ContentManage
                ]
            );
            assert_eq!(
                t.input_schema.as_value()["required"],
                serde_json::json!(["olay_id"])
            );
            continue;
        }
        assert_eq!(t.permissions, &[Permission::ContentWork]);
        assert!(
            t.input_schema.as_value()["properties"]
                .get("project_id")
                .is_some()
        );
    }
    // The progress report's two new fields are optional: an old caller's report still fits.
    let progress = jt_mcp::registry()
        .into_iter()
        .find(|t| t.name == "jeeta.content.area_progress")
        .unwrap();
    let schema = progress.input_schema.as_value();
    assert_eq!(
        schema["required"],
        serde_json::json!(["project_id", "claim_token", "step", "note"])
    );
    assert_eq!(schema["properties"]["output"]["maxLength"], 240);
    assert!(schema["properties"]["material_ids"].is_object());
    // The page's tree, queue and production line are the panel's.
    for id in ["content.tree", "content.analysis_queue", "content.areas"] {
        assert!(jt_app::catalog::find(id).unwrap().panel_only, "{id}");
    }
    // A person's decisions have no tool: "Olmamış" and the release of a held delivery.
    for id in ["content.area_redo", "content.delivery_accept"] {
        assert!(jt_app::catalog::find(id).unwrap().panel_only, "{id}");
    }
}

/// A person drops a file with no olay; the agent analyses it and files it into a new olay, which
/// the owner's rule confirms; it opens an area under that olay, reports a step with its output,
/// and reads the olay as the page does, all through the tools.
#[tokio::test]
async fn an_agent_files_a_persons_drop_and_reads_the_olay_through_the_tools() {
    use jt_app::ctx::Ctx;
    use jt_ledger::Actor;
    use jt_tenancy::SystemRole;
    use jt_testkit::fakes::files::MemoryFiles;
    use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.files = Arc::new(MemoryFiles::default());
    let out = jt_app::usecases::auth::register(
        &deps,
        jt_app::usecases::auth::RegisterInput {
            email: "owner@content.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Content".into(),
        },
    )
    .await
    .unwrap();
    let (ws, owner) = (out.me.current_workspace.unwrap(), out.me.user_id);
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let person = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: owner },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let connection_id = jt_tenancy::AgentConnectionId::new_v7();
    let agent = Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id: owner,
        },
        agent_connection_id: Some(connection_id),
        ..person.clone()
    };
    let file = jt_app::usecases::studio::files::file_upload(
        &deps,
        &person,
        serde_json::from_value(
            json!({"request_key":"drop","filename":"a.png","mime":"image/png",
            "content":{"kind":"bytes_base64","data":"iVBORw0KGgpkcm9w"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let dropped = jt_app::usecases::studio::library::material_add(
        &deps,
        &person,
        serde_json::from_value(
            json!({"request_key":"drop","file_id":file.id,"origin":{"kind":"real"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap()
    .material;
    let tools: BTreeMap<&str, jt_mcp::ToolSpec> = jt_mcp::registry()
        .into_iter()
        .map(|t| (t.name, t))
        .collect();
    let run = |name: &str, args: Value| {
        let tool = &tools[name];
        (tool.run)(&deps, &agent, args)
    };
    // (The check-in's `unfiled` flag is pinned in jt_app's content_olay_root tests.)
    let claim = run(
        "jeeta.studio.material_analysis_claim",
        json!({"material_id":dropped.id,"expected_revision":dropped.revision}),
    )
    .await
    .unwrap();
    let done = run(
        "jeeta.studio.material_analysis_complete",
        json!({"material_id":dropped.id,"expected_revision":claim["expected_revision"],
            "claim_token":claim["claim_token"],"description":"Workshop table","labels":["atölye"],
            "date_source":"unknown","filing":{"new_olay":{"kind":"workshop","title":"Kasım atölyesi",
            "starts_on":"2026-11-16","ends_on":"2026-11-16"}}}),
    )
    .await
    .unwrap();
    assert_eq!(done["olay"]["status"], "confirmed");
    let olay_id = done["olay"]["id"].clone();
    assert_eq!(
        done["material"]["binding"],
        json!({"kind":"olay","olay_id":olay_id})
    );
    let area = run(
        "jeeta.studio.project_create",
        json!({"request_key":"area","brief":"Atölyeden bir gün","olay_id":olay_id}),
    )
    .await
    .unwrap();
    let claimed = run(
        "jeeta.content.area_claim",
        json!({"project_id":area["id"],"expected_revision":area["revision"]}),
    )
    .await
    .unwrap();
    run(
        "jeeta.content.area_progress",
        json!({"project_id":area["id"],"claim_token":claimed["claim_token"],"step":3,
            "note":"Biçimi seçtim","output":"Instagram · Reels"}),
    )
    .await
    .unwrap();
    let view = run("jeeta.content.olay_view", json!({"olay_id":olay_id}))
        .await
        .unwrap();
    assert_eq!(view["olay"]["id"], olay_id);
    assert_eq!(view["files"][0]["material"]["id"], json!(dropped.id));
    let stage = &view["contents"][0]["pipeline"]["stages"][0];
    assert_eq!(stage["key"], "hazirlik");
    assert_eq!(stage["state"], "current");
    assert_eq!(stage["steps"][0]["output"], "Instagram · Reels");
    let listed = run("jeeta.studio.project_list", json!({"olay_id":"genel"}))
        .await
        .unwrap();
    assert!(listed["projects"].as_array().unwrap().is_empty());
}
