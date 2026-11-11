#[test]
fn studio_tools_publish_shared_strict_schemas_and_manage_permission() {
    let tools: Vec<_> = jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.studio."))
        .collect();
    assert_eq!(tools.len(), 54);
    for tool in tools {
        let action = tool.name.strip_prefix("jeeta.studio.").unwrap();
        assert_eq!(
            tool.permissions,
            match action {
                "file_upload" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_add" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_get" => &[jt_tenancy::Permission::MaterialsWork][..],
                "materials_list" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_preview" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_tag" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_bind" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_free" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_permission" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_delete" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_intelligence_get" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_intelligence_list" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_intelligence_update" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_analysis_claim" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_analysis_complete" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_analysis_fail" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_analysis_retry" => &[jt_tenancy::Permission::MaterialsWork][..],
                "olay_create" => &[jt_tenancy::Permission::MaterialsWork][..],
                "olay_update" => &[jt_tenancy::Permission::MaterialsWork][..],
                "olay_get" => &[jt_tenancy::Permission::MaterialsWork][..],
                "olays_list" => &[jt_tenancy::Permission::MaterialsWork][..],
                "olay_confirm" => &[jt_tenancy::Permission::MaterialsWork][..],
                "shoot_list" => &[jt_tenancy::Permission::MaterialsWork][..],
                "shoot_request" => &[jt_tenancy::Permission::MaterialsWork][..],
                "shoot_resolve" => &[jt_tenancy::Permission::MaterialsWork][..],
                "piece_submit" => &[jt_tenancy::Permission::MaterialsWork][..],
                "slot_materials" => &[jt_tenancy::Permission::MaterialsWork][..],
                "material_check_release" => &[jt_tenancy::Permission::MaterialsWork][..],
                "project_create" => &[jt_tenancy::Permission::ContentManage][..],
                "project_get" => &[jt_tenancy::Permission::ContentWork][..],
                "project_list" => &[jt_tenancy::Permission::ContentWork][..],
                "project_update" => &[jt_tenancy::Permission::ContentManage][..],
                "project_materials" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::ContentManage,
                ][..],
                "project_request" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::ContentManage,
                ][..],
                "project_request_update" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::ContentManage,
                ][..],
                "project_production" => &[jt_tenancy::Permission::ContentManage][..],
                "material_production_request" => &[jt_tenancy::Permission::ContentWork][..],
                "material_production_list" => &[jt_tenancy::Permission::ContentWork][..],
                "material_production_claim" => &[jt_tenancy::Permission::ContentWork][..],
                "material_production_complete" => &[jt_tenancy::Permission::ContentWork][..],
                "material_production_fail" => &[jt_tenancy::Permission::ContentWork][..],
                "calendar_list" => &[jt_tenancy::Permission::ContentWork][..],
                "calendar_set" => &[jt_tenancy::Permission::ContentWork][..],
                "material_policy_set" => &[jt_tenancy::Permission::ContentWork][..],
                "project_publication" => &[jt_tenancy::Permission::SocialWork][..],
                "post_requests" => &[jt_tenancy::Permission::SocialWork][..],
                "posts_propose" => &[jt_tenancy::Permission::SocialWork][..],
                "posts_list" => &[jt_tenancy::Permission::SocialWork][..],
                "posting_policy_set" => &[jt_tenancy::Permission::SocialWork][..],
                "weekly_summary" => &[jt_tenancy::Permission::SocialWork][..],
                "slot_get" => &[jt_tenancy::Permission::SocialWork][..],
                "slot_cancel" => &[jt_tenancy::Permission::SocialWork][..],
                "tiktok_metrics" => &[jt_tenancy::Permission::SocialWork][..],
                "project_schedule" => &[jt_tenancy::Permission::SocialManage][..],
                "tiktok_posting" => &[jt_tenancy::Permission::SocialManage][..],
                "tiktok_post" => &[jt_tenancy::Permission::SocialManage][..],
                "adsets_list" => &[jt_tenancy::Permission::AdsWork][..],
                "adset_bind" => &[jt_tenancy::Permission::AdsWork][..],
                "budget_move" => &[jt_tenancy::Permission::AdsManage][..],
                "overview" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork,
                    jt_tenancy::Permission::MaterialsWork,
                    jt_tenancy::Permission::SocialManage,
                    jt_tenancy::Permission::AdsManage,
                    jt_tenancy::Permission::BudgetManage
                ][..],
                "pending" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork,
                    jt_tenancy::Permission::MaterialsWork,
                    jt_tenancy::Permission::SocialManage,
                    jt_tenancy::Permission::AdsManage,
                    jt_tenancy::Permission::BudgetManage
                ][..],
                "learned" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork,
                    jt_tenancy::Permission::MaterialsWork
                ][..],
                "ledger" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork,
                    jt_tenancy::Permission::MaterialsWork
                ][..],
                "ledger_export" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork,
                    jt_tenancy::Permission::MaterialsWork
                ][..],
                "judgment_record" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork
                ][..],
                "trend_record" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork
                ][..],
                "hypothesis_propose" => &[
                    jt_tenancy::Permission::ContentWork,
                    jt_tenancy::Permission::SocialWork,
                    jt_tenancy::Permission::AdsWork
                ][..],
                "brake" => &[
                    jt_tenancy::Permission::SocialManage,
                    jt_tenancy::Permission::AdsManage,
                    jt_tenancy::Permission::BudgetManage
                ][..],
                "approve" => &[
                    jt_tenancy::Permission::SocialManage,
                    jt_tenancy::Permission::AdsManage
                ][..],
                _ => panic!("unexpected Studio tool {action}"),
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

#[tokio::test]
async fn module_scoped_keys_list_and_call_only_matching_tools() {
    use jt_app::{ctx::Ctx, gate::NoStrategyYet, usecases::api_keys};
    use jt_tenancy::{Permission, SystemRole};
    use rmcp::{
        ServiceExt,
        model::{CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation},
        transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        },
    };
    use serde_json::json;
    use std::{collections::BTreeSet, sync::Arc};
    let db = jt_testkit::TestDb::new().await;
    let (ws, owner) = db.seed_workspace("module-scopes").await;
    let deps = jt_testkit::fakes::deps(Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())));
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let ctx = Ctx {
        workspace_id: ws,
        actor: jt_ledger::Actor::Human { user_id: owner },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: jt_testkit::fakes::FIXED_NOW,
        agent_connection_id: None,
    };
    let state = jt_mcp::McpState::new(deps.clone(), Arc::new(NoStrategyYet));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, jt_mcp::http_service(state))
            .await
            .unwrap();
    });
    for permission in [
        Permission::ContentWork,
        Permission::SocialWork,
        Permission::AdsWork,
        Permission::MaterialsWork,
        Permission::SocialManage,
        Permission::AdsManage,
        Permission::BudgetManage,
    ] {
        let key = api_keys::create(
            &deps,
            &ctx,
            api_keys::CreateKey {
                name: "module only".into(),
                scopes: vec![permission.key().into()],
            },
        )
        .await
        .unwrap();
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.as_str()).auth_header(&key.plaintext),
        );
        let client = ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("module-test", "1"),
        )
        .serve(transport)
        .await
        .unwrap();
        let listed: BTreeSet<_> = client
            .list_all_tools()
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.name.into_owned())
            .collect();
        let expected: BTreeSet<_> = jt_mcp::registry()
            .into_iter()
            .filter(|t| t.permissions.contains(&permission))
            .map(|t| t.name.to_owned())
            .collect();
        assert_eq!(listed, expected, "{permission:?}");
        assert!(listed.contains("jeeta.studio.overview"));
        if permission == Permission::ContentWork {
            let result = client
                .call_tool(
                    CallToolRequestParams::new("jeeta.studio.project_list")
                        .with_arguments(json!({}).as_object().unwrap().clone()),
                )
                .await
                .unwrap();
            assert_eq!(result.is_error, Some(false), "{result:?}");
            let result = client
                .call_tool(
                    CallToolRequestParams::new("jeeta.studio.materials_list")
                        .with_arguments(json!({}).as_object().unwrap().clone()),
                )
                .await
                .unwrap();
            assert_eq!(result.is_error, Some(true));
            assert!(
                serde_json::to_string(&result)
                    .unwrap()
                    .contains("FORBIDDEN"),
                "{result:?}"
            );
        }
        client.cancel().await.unwrap();
    }
    server.abort();
}
