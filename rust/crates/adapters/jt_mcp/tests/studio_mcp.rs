#[test]
fn studio_tools_publish_shared_strict_schemas_and_manage_permission() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .collect();
    assert_eq!(tools.len(), 15);
    for tool in tools {
        let action = tool.name.strip_prefix("jeeta.studio.").unwrap();
        assert_eq!(
            tool.permission,
            if matches!(action, "brake" | "policy_set" | "approve" | "budget_move") {
                jt_tenancy::Permission::StudioManage
            } else {
                jt_tenancy::Permission::StudioWork
            }
        );
        assert_eq!(
            *tool.input_schema.as_value(),
            jt_app::usecases::studio::schema::input(action)
        );
    }
}
