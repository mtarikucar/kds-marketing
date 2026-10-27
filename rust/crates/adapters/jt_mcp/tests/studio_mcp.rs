#[test]
fn studio_tools_publish_shared_strict_schemas_and_manage_permission() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .collect();
    assert_eq!(tools.len(), 18);
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

#[tokio::test]
async fn slot_get_scheduled_at_is_rfc3339() {
    use std::sync::Arc;
    use time::format_description::well_known::Rfc3339;
    let uow = Arc::new(jt_testkit::fakes::InMemoryUow::new());
    let f = jt_testkit::studio_contract::seed(uow.as_ref()).await;
    let deps = jt_testkit::fakes::deps(uow.clone());
    let ctx = jt_app::ctx::Ctx {
        workspace_id: f.ws,
        actor: jt_ledger::Actor::Human {
            user_id: jt_tenancy::UserId::new_v7(),
        },
        permissions: jt_tenancy::SystemRole::Owner.permissions(),
        role_key: None,
        now: jt_testkit::fakes::FIXED_NOW,
        agent_connection_id: None,
    };
    let tool = jt_mcp::registry()
        .into_iter()
        .find(|t| t.name == "jeeta.studio.slot_get")
        .unwrap();
    let out = (tool.run)(&deps, &ctx, serde_json::json!({ "slot_id": f.slot.id }))
        .await
        .unwrap();
    assert_eq!(
        out["slot"]["scheduled_at"],
        f.slot.scheduled_at.format(&Rfc3339).unwrap()
    );
}
