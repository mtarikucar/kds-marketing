use jt_tenancy::Permission;
#[test]
fn inbox_tools_publish_strict_schemas_and_permissions() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|s| s.name.starts_with("jeeta.inbox."))
        .collect();
    assert_eq!(tools.len(), 11);
    for tool in tools {
        assert_eq!(tool.input_schema.as_value()["additionalProperties"], false);
        let manage = matches!(
            tool.use_case,
            "inbox.journeys.assign_owner" | "inbox.lost_reasons.set" | "inbox.status_labels.set"
        );
        assert_eq!(
            tool.permission,
            if manage {
                Permission::InboxManage
            } else {
                Permission::InboxWork
            }
        );
    }
}
