use jt_tenancy::Permission;
#[test]
fn inbox_tools_publish_strict_schemas_and_permissions() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|s| s.name.starts_with("jeeta.inbox."))
        .collect();
    assert_eq!(tools.len(), 35);
    for tool in tools {
        assert_eq!(tool.input_schema.as_value()["additionalProperties"], false);
        let manage = matches!(
            tool.use_case,
            "inbox.suppressions.add"
                | "inbox.suppressions.remove"
                | "inbox.journeys.assign_owner"
                | "inbox.lost_reasons.set"
                | "inbox.status_labels.set"
                | "inbox.merges.list"
                | "inbox.merges.apply"
                | "inbox.merges.undo"
                | "inbox.merges.refuse"
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

#[test]
fn merge_task_and_note_schemas_share_panel_inputs_with_path_ids() {
    use jt_app::usecases::inbox::schema;
    for (action, path_id) in [
        ("pending", None),
        ("context", Some("conversation_id")),
        ("conversations.list", None),
        ("conversations.get", Some("conversation_id")),
        ("messages.list", Some("conversation_id")),
        ("take_over", Some("conversation_id")),
        ("hand_to_agent", Some("conversation_id")),
        ("snooze", Some("conversation_id")),
        ("unsnooze", Some("conversation_id")),
        ("close", Some("conversation_id")),
        ("reply", Some("conversation_id")),
        ("consent.record", Some("person_id")),
        ("consent.list", Some("person_id")),
        ("suppressions.add", Some("person_id")),
        ("suppressions.remove", Some("person_id")),
        ("send", Some("person_id")),
        ("merges.list", None),
        ("merges.apply", Some("merge_id")),
        ("merges.undo", Some("merge_id")),
        ("merges.refuse", Some("merge_id")),
        ("tasks.create", Some("journey_id")),
        ("tasks.complete", Some("task_id")),
        ("tasks.list", None),
        ("notes.add", Some("journey_id")),
    ] {
        let name = format!("jeeta.inbox.{}", action.replace('.', "_"));
        let tool = jt_mcp::registry()
            .into_iter()
            .find(|s| s.name == name)
            .unwrap();
        let mut input = tool.input_schema.as_value().clone();
        if let Some(id) = path_id {
            assert_eq!(input["properties"][id]["format"], "uuid");
            input["properties"].as_object_mut().unwrap().remove(id);
            let required = input["required"].as_array_mut().unwrap();
            assert!(required.iter().any(|value| value == id));
            required.retain(|value| value != id);
        }
        assert_eq!(input, schema::input(action), "{action}");
    }
    let list = schema::input("tasks.list");
    assert_eq!(list["properties"]["queue"]["default"], "due_24h");
    assert_eq!(
        list["properties"]["queue"]["enum"],
        serde_json::json!(["due_24h", "overdue", "all"])
    );
}
