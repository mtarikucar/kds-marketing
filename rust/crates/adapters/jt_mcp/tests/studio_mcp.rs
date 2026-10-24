#[test]
fn studio_tools_publish_shared_strict_schemas_and_manage_permission() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .collect();
    assert_eq!(tools.len(), 3);
    for tool in tools {
        let action = tool.name.strip_prefix("jeeta.studio.").unwrap();
        assert_eq!(tool.permission, jt_tenancy::Permission::StudioManage);
        assert_eq!(
            *tool.input_schema.as_value(),
            jt_app::usecases::studio::schema::input(action)
        );
    }
}
