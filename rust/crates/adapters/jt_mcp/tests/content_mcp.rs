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
        ]
    );
    for t in tools {
        assert_eq!(t.permissions, &[Permission::ContentWork]);
        assert_eq!(t.input_schema.as_value()["additionalProperties"], false);
        assert!(
            t.input_schema.as_value()["properties"]
                .get("project_id")
                .is_some()
        );
    }
    // A person's decisions have no tool: "Olmamış" and the release of a held delivery.
    for id in ["content.area_redo", "content.delivery_accept"] {
        assert!(jt_app::catalog::find(id).unwrap().panel_only, "{id}");
    }
}
