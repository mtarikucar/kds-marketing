//! Module tool discovery is strict and does not grant underlying operation permissions.
use jt_tenancy::Permission;

#[test]
fn module_tools_are_discoverable_with_strict_schemas_and_explicit_permissions() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|tool| tool.name.starts_with("jeeta.modules."))
        .collect();
    assert_eq!(tools.len(), 4);
    for tool in tools {
        assert_eq!(
            tool.permission,
            if tool.name == "jeeta.modules.list" {
                Permission::WorkspaceRead
            } else {
                Permission::CapabilitiesManage
            },
        );
        assert_eq!(tool.input_schema.as_value()["additionalProperties"], false);
    }
}
