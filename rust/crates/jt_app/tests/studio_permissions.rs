use jt_app::{
    catalog::{CATALOG, GateMode, StatusExemption},
    error::ErrorCode,
    gate::{NoStrategyYet, check_gate},
};
use jt_tenancy::{Permission, SystemRole, WorkspaceId, WorkspaceStatus};

#[test]
fn studio_permissions_and_public_rows_are_explicit() {
    for role in [SystemRole::Owner, SystemRole::Manager] {
        assert!(role.permissions().contains(&Permission::MaterialsWork));
        assert!(role.permissions().contains(&Permission::SocialManage));
    }
    assert!(
        !SystemRole::Rep
            .permissions()
            .contains(&Permission::MaterialsWork)
    );
    assert!(
        !SystemRole::Rep
            .permissions()
            .contains(&Permission::SocialManage)
    );
    for (id, method, path, gate) in [
        (
            "studio.brake",
            "POST",
            "/api/studio/brake",
            GateMode::Exempt,
        ),
        (
            "studio.approve",
            "POST",
            "/api/studio/approvals",
            GateMode::Gated,
        ),
    ] {
        let row = CATALOG.iter().find(|r| r.id == id).expect("Studio row");
        assert_eq!(row.panel_route, Some((method, path)));
        assert_eq!(row.mcp_tool, Some(format!("jeeta.{id}").as_str()));
        assert_eq!(row.gate, gate);
        assert_eq!(row.status_exemption, StatusExemption::Never);
    }
}

#[tokio::test]
async fn studio_strategy_exemptions_do_not_bypass_workspace_status() {
    let row = CATALOG
        .iter()
        .find(|r| r.id == "studio.brake")
        .expect("brake row");
    for status in [WorkspaceStatus::Suspended, WorkspaceStatus::PendingPayment] {
        assert_eq!(
            check_gate(row, status, &NoStrategyYet, WorkspaceId::new_v7())
                .await
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceInactive
        );
    }
    check_gate(
        row,
        WorkspaceStatus::Active,
        &NoStrategyYet,
        WorkspaceId::new_v7(),
    )
    .await
    .unwrap();
}

#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ports::{UnitOfWork, studio::ApprovalTarget},
    usecases::studio::control::*,
};
use jt_ledger::Actor;
use jt_tenancy::AgentConnectionId;
use serde_json::json;

#[tokio::test]
async fn agents_inherit_manage_but_cannot_supply_human_consent() {
    let w = support::world().await;
    let mut agent = w.ctx.clone();
    let Actor::Human { user_id } = agent.actor else {
        panic!()
    };
    agent.actor = Actor::Agent {
        user_id,
        connection_id: AgentConnectionId::new_v7(),
    };
    agent.agent_connection_id = Some(AgentConnectionId::new_v7());
    brake(
        &w.d,
        &agent,
        BrakeInput {
            engaged: true,
            lane: None,
            expected_revision: 0,
        },
    )
    .await
    .unwrap();
    let err = approve(
        &w.d,
        &agent,
        ApprovalInput {
            target: ApprovalTarget::Slot(w.f.slot.id),
            expected_revision: 1,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details["reason"], "owner_or_manager_human");
    for p in [
        Permission::SocialManage,
        Permission::AdsManage,
        Permission::BudgetManage,
    ] {
        agent.permissions.remove(&p);
    }
    assert_eq!(
        brake(
            &w.d,
            &agent,
            BrakeInput {
                engaged: false,
                lane: None,
                expected_revision: 1
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
}
#[tokio::test]
async fn direct_controls_preserve_workspace_and_strategy_gates() {
    let w = support::world().await;
    w.archive().await;
    w.brake(true, None, 0).await;
    let mut r = w.uow.platform().await.unwrap();
    r.workspace_set_status(
        w.f.ws,
        WorkspaceStatus::Suspended,
        "test status transition",
        &jt_ledger::Actor::System {
            component: "test".into(),
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        brake(
            &w.d,
            &w.ctx,
            BrakeInput {
                engaged: false,
                lane: None,
                expected_revision: 1
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::WorkspaceInactive
    );
}
#[test]
fn studio_inputs_are_strict_and_share_schema() {
    assert!(
        serde_json::from_value::<BrakeInput>(
            json!({"engaged":true,"expected_revision":0,"oops":true})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<ApprovalInput>(json!({"target":{"slot":uuid::Uuid::new_v4(),"budget_move":uuid::Uuid::new_v4()},"expected_revision":1})).is_err());
    for action in ["brake", "approve"] {
        assert_eq!(
            jt_app::usecases::studio::schema::input(action)["additionalProperties"],
            false
        );
    }
}

#[path = "support/mod.rs"]
mod register_support;
#[tokio::test]
async fn page_and_linked_instagram_keep_trusted_oauth_scope_evidence() {
    use jt_app::{
        ports::connectors::{Asset, OAuthCallback},
        usecases::{auth, connector},
    };
    use jt_connector::{Credential, ProbeResult, Provider};
    use jt_testkit::fakes::{FakeAppConfig, ScriptedConnector, ScriptedOAuth, ScriptedRegistry};
    use std::sync::Arc;
    let mut w = register_support::world().await;
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
    let oauth = Arc::new(ScriptedOAuth::new(Provider::Meta));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(meta.clone())
            .with_oauth(oauth.clone()),
    );
    w.deps.apps = Arc::new(FakeAppConfig::with_all_apps());
    let scope_keys = vec![
        "pages_manage_posts".to_owned(),
        "pages_read_engagement".to_owned(),
        "instagram_content_publish".to_owned(),
        "instagram_manage_insights".to_owned(),
    ];
    let started = connector::start_oauth(
        &w.deps,
        &w.owner_ctx,
        connector::StartOAuth {
            kind_key: "facebook_page".into(),
            flow: None,
        },
    )
    .await
    .unwrap();
    let state = url::Url::parse(&started.authorize_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    oauth.push_exchange(Ok(Credential::OAuth {
        access_token: "user".into(),
        refresh_token: None,
        expires_at: None,
        scopes: scope_keys.clone(),
    }));
    oauth.push_assets(Ok([("facebook_page", "page"), ("instagram", "ig")]
        .into_iter()
        .map(|(kind, id)| Asset {
            kind_key: kind.into(),
            external_id: id.into(),
            name: kind.into(),
            credential: Credential::PageToken {
                page_id: "page".into(),
                token: "page-token".into(),
            },
            public: json!({}),
        })
        .collect()));
    let session = auth::login(
        &w.deps,
        auth::LoginInput {
            email: "owner@acme.example".into(),
            password: "correct horse battery".into(),
        },
    )
    .await
    .unwrap();
    let principal = auth::resolve_session(&w.deps, &session.token)
        .await
        .unwrap();
    let pending = connector::complete_oauth(
        &w.deps,
        connector::CompleteOAuth {
            callback: OAuthCallback::Meta,
            state,
            code: "code".into(),
            principal: &principal,
        },
    )
    .await
    .unwrap();
    for id in ["page", "ig"] {
        meta.push_on_connected(Ok(json!({})));
        meta.push_probe(ProbeResult::success(1, json!({"account_id":id})));
    }
    connector::confirm_assets(
        &w.deps,
        &w.owner_ctx,
        connector::ConfirmAssets {
            pending_id: pending.pending_id,
            selected: vec!["page".into(), "ig".into()],
        },
    )
    .await
    .unwrap();
    let snapshot = w.uow.snapshot();
    assert_eq!(snapshot.capabilities.len(), 2);
    for c in snapshot.capabilities {
        assert_eq!(
            c.capability.connector_public["access"]["scopes"],
            json!(scope_keys)
        );
    }
}

#[test]
fn module_permission_keys_replace_the_shared_pair() {
    for key in [
        "content.work",
        "content.manage",
        "social.work",
        "social.manage",
        "ads.work",
        "ads.manage",
        "materials.work",
    ] {
        let permission = Permission::parse(key).expect("module permission exists");
        assert_eq!(permission.key(), key);
        assert_eq!(serde_json::to_value(permission).unwrap(), key);
        assert!(Permission::all().contains(&permission));
        assert!(SystemRole::Owner.permissions().contains(&permission));
        assert!(SystemRole::Manager.permissions().contains(&permission));
        assert!(!SystemRole::Rep.permissions().contains(&permission));
    }
}

// This expectation is deliberately written independently of the production mapping.
fn expected_permissions(action: &str) -> &'static [Permission] {
    use Permission::*;
    match action {
        "file_upload" => &[MaterialsWork],
        "material_add" => &[MaterialsWork],
        "material_get" => &[MaterialsWork],
        "materials_list" => &[MaterialsWork],
        "material_preview" => &[MaterialsWork],
        "material_tag" => &[MaterialsWork],
        "material_bind" => &[MaterialsWork],
        "material_free" => &[MaterialsWork],
        "material_permission" => &[MaterialsWork],
        "material_delete" => &[MaterialsWork],
        "material_intelligence_get" => &[MaterialsWork],
        "material_intelligence_list" => &[MaterialsWork],
        "material_intelligence_update" => &[MaterialsWork],
        "material_analysis_claim" => &[MaterialsWork],
        "material_analysis_complete" => &[MaterialsWork],
        "material_analysis_fail" => &[MaterialsWork],
        "material_analysis_retry" => &[MaterialsWork],
        "olay_create" => &[MaterialsWork],
        "olay_update" => &[MaterialsWork],
        "olay_get" => &[MaterialsWork],
        "olays_list" => &[MaterialsWork],
        "olay_confirm" => &[MaterialsWork],
        "shoot_list" => &[MaterialsWork],
        "shoot_request" => &[MaterialsWork],
        "shoot_resolve" => &[MaterialsWork],
        "piece_submit" => &[MaterialsWork],
        "slot_materials" => &[MaterialsWork],
        "material_check_release" => &[MaterialsWork],
        "project_create" => &[ContentManage],
        "project_get" => &[ContentWork],
        "project_list" => &[ContentWork],
        "project_update" => &[ContentManage],
        "project_materials" => &[ContentWork, ContentManage],
        "project_request" => &[ContentWork, ContentManage],
        "project_request_update" => &[ContentWork, ContentManage],
        "project_production" => &[ContentManage],
        "material_production_request" => &[ContentWork],
        "material_production_list" => &[ContentWork],
        "material_production_claim" => &[ContentWork],
        "material_production_complete" => &[ContentWork],
        "material_production_fail" => &[ContentWork],
        "calendar_list" => &[ContentWork],
        "calendar_set" => &[ContentWork],
        "material_policy_set" => &[ContentWork],
        "project_publication" => &[SocialWork],
        "post_requests" => &[SocialWork],
        "posts_propose" => &[SocialWork],
        "posts_list" => &[SocialWork],
        "posting_policy_set" => &[SocialWork],
        "weekly_summary" => &[SocialWork],
        "slot_get" => &[SocialWork],
        "slot_cancel" => &[SocialWork],
        "tiktok_metrics" => &[SocialWork],
        "project_schedule" => &[SocialManage],
        "tiktok_posting" => &[SocialManage],
        "tiktok_post" => &[SocialManage],
        "adsets_list" => &[AdsWork],
        "adset_bind" => &[AdsWork],
        "budget_move" => &[AdsManage],
        "overview" => &[
            ContentWork,
            SocialWork,
            AdsWork,
            MaterialsWork,
            SocialManage,
            AdsManage,
            BudgetManage,
        ],
        "pending" => &[
            ContentWork,
            SocialWork,
            AdsWork,
            MaterialsWork,
            SocialManage,
            AdsManage,
            BudgetManage,
        ],
        "learned" => &[ContentWork, SocialWork, AdsWork, MaterialsWork],
        "ledger" => &[ContentWork, SocialWork, AdsWork, MaterialsWork],
        "ledger_export" => &[ContentWork, SocialWork, AdsWork, MaterialsWork],
        "judgment_record" => &[ContentWork, SocialWork, AdsWork],
        "trend_record" => &[ContentWork, SocialWork, AdsWork],
        "hypothesis_propose" => &[ContentWork, SocialWork, AdsWork],
        "brake" => &[SocialManage, AdsManage, BudgetManage],
        "approve" => &[SocialManage, AdsManage],
        _ => panic!("unlisted Studio action {action}"),
    }
}

// A typed input sufficient to reach the application boundary. Business-invalid values are
// intentional: missing permission must win over input validation as well as storage access.
fn schema_input(s: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    if let Some(v) = s.get("const") {
        return v.clone();
    }
    if let Some(v) = s.get("enum") {
        return v[0].clone();
    }
    if let Some(v) = s.get("oneOf").or_else(|| s.get("anyOf")) {
        return schema_input(&v[0]);
    }
    let typ = s["type"].as_str().or_else(|| s["type"][0].as_str());
    match typ {
        Some("object") => {
            let mut out = serde_json::Map::new();
            if let Some(required) = s["required"].as_array() {
                for key in required {
                    let k = key.as_str().unwrap();
                    out.insert(k.into(), schema_input(&s["properties"][k]));
                }
            }
            Value::Object(out)
        }
        Some("array") => json!([]),
        Some("integer" | "number") => s.get("minimum").cloned().unwrap_or(json!(0)),
        Some("boolean") => json!(false),
        Some("string") => json!(match s["format"].as_str() {
            Some("uuid") => "00000000-0000-4000-8000-000000000001",
            Some("date-time") => "2026-11-01T00:00:00Z",
            Some("date") => "2026-11-01",
            Some("uri") => "https://example.com/test",
            _ => "test",
        }),
        _ => Value::Null,
    }
}

async fn call_studio(
    action: &str,
    d: &jt_app::usecases::Deps,
    ctx: &jt_app::ctx::Ctx,
    v: serde_json::Value,
) -> Result<(), jt_app::error::AppError> {
    use jt_app::usecases::studio;
    match action {
        "post_requests" => studio::posts::post_requests(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "posts_propose" => studio::posts::posts_propose(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "posts_list" => studio::posts::posts_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "weekly_summary" => studio::posts::weekly_summary(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "posting_policy_set" => studio::posts::posting_policy_set(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_schedule" => studio::project_schedule::project_schedule(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "file_upload" => studio::files::file_upload(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "pending" => studio::work::pending(d, ctx).await.map(|_| ()),
        "slot_get" => studio::work::slot_get(
            d,
            ctx,
            serde_json::from_value(v["slot_id"].clone()).unwrap(),
        )
        .await
        .map(|_| ()),
        "slot_cancel" => studio::work::slot_cancel(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "adsets_list" => studio::ads::adsets_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "adset_bind" => studio::ads::adset_bind(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "budget_move" => studio::ads::budget_move(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "brake" => studio::control::brake(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "approve" => studio::control::approve(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_check_release" => studio::materials::material_check_release(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_list" => studio::projects::project_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_get" => studio::projects::project_get(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_create" => studio::projects::project_create(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_update" => studio::projects::project_update(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_materials" => studio::projects::project_materials(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_request" => studio::projects::project_request(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_request_update" => studio::projects::project_request_update(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_production" => studio::projects::project_production(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "project_publication" => studio::projects::project_publication(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "overview" => studio::views::overview(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "ledger" => studio::views::ledger(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "ledger_export" => studio::views::ledger_export(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "learned" => studio::learning::learned(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "judgment_record" => studio::learning::judgment_record(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "tiktok_posting" => studio::tiktok::tiktok_posting(
            d,
            ctx,
            serde_json::from_value(v["slot_id"].clone()).unwrap(),
        )
        .await
        .map(|_| ()),
        "tiktok_metrics" => studio::tiktok::tiktok_metrics(
            d,
            ctx,
            serde_json::from_value(v["slot_id"].clone()).unwrap(),
        )
        .await
        .map(|_| ()),
        "tiktok_post" => studio::tiktok::tiktok_post(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "piece_submit" => studio::pieces::piece_submit(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "trend_record" => studio::trends::trend_record(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "hypothesis_propose" => studio::trends::hypothesis_propose(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "olays_list" => studio::library::olays_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "olay_get" => studio::library::olay_get(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "olay_create" => studio::library::olay_create(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "olay_update" => studio::library::olay_update(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "olay_confirm" => studio::library::olay_confirm(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_production_list" => studio::library::material_production_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_production_request" => studio::library::material_production_request(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_production_claim" => studio::library::material_production_claim(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_production_complete" => studio::library::material_production_complete(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_production_fail" => studio::library::material_production_fail(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "materials_list" => studio::library::materials_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_get" => studio::library::material_get(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_add" => studio::library::material_add(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_tag" => studio::library::material_tag(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_permission" => studio::library::material_permission(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_free" => studio::library::material_free(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_bind" => studio::library::material_bind(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_delete" => studio::library::material_delete(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "slot_materials" => studio::library::slot_materials(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_intelligence_get" => studio::library::material_intelligence_get(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_preview" => studio::library::material_preview(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_analysis_claim" => studio::library::material_analysis_claim(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_analysis_complete" => studio::library::material_analysis_complete(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_analysis_fail" => studio::library::material_analysis_fail(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_analysis_retry" => studio::library::material_analysis_retry(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_intelligence_update" => studio::library::material_intelligence_update(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_intelligence_list" => studio::library::material_intelligence_list(d, ctx)
            .await
            .map(|_| ()),
        "shoot_list" => studio::library::shoot_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "shoot_request" => studio::library::shoot_request(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "shoot_resolve" => studio::library::shoot_resolve(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "calendar_list" => studio::library::calendar_list(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "calendar_set" => studio::library::calendar_set(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        "material_policy_set" => studio::library::material_policy_set(
            d,
            ctx,
            serde_json::from_value(v).unwrap_or_else(|e| panic!("{action}: {e}")),
        )
        .await
        .map(|_| ()),
        _ => panic!("unlisted Studio action {action}"),
    }
}

#[tokio::test]
async fn every_studio_use_case_asks_its_module_permission() {
    let w = support::world().await;
    for row in CATALOG.iter().filter(|r| r.id.starts_with("studio.")) {
        let action = row.id.strip_prefix("studio.").unwrap();
        let expected = expected_permissions(action);
        let id = "00000000-0000-4000-8000-000000000001";
        let input = match action {
            "tiktok_posting" | "tiktok_metrics" => json!({"slot_id":id}),
            "tiktok_post" => {
                json!({"slot_id":id,"expected_revision":0,"post":{"title":"test","privacy_level":"SELF_ONLY","allow_comment":false,"allow_duet":false,"allow_stitch":false,"disclose_commercial":false,"your_brand":false,"branded_content":false}})
            }
            "material_check_release" => json!({"slot_id":id,"expected_revision":0,"digest":"test"}),
            "material_permission" => {
                json!({"material_id":id,"expected_revision":0,"permission":"shareable"})
            }
            "material_free" => json!({"material_id":id,"expected_revision":0,"free":true}),
            "material_bind" => {
                json!({"material_id":id,"expected_revision":0,"binding":{"kind":"genel"}})
            }
            "material_delete" | "material_intelligence_update" => {
                json!({"material_id":id,"expected_revision":0})
            }
            "olay_confirm" => json!({"olay_id":id,"expected_revision":0}),
            "calendar_set" => {
                json!({"key":"test","year":2026,"name":"test","kind":"season","enabled":false})
            }
            "material_policy_set" => {
                serde_json::to_value(jt_studio::MaterialPolicy::default()).unwrap()
            }
            "posting_policy_set" => json!({}),
            "project_production" => {
                json!({"project_id":id,"expected_revision":0,"request_key":"test","kind":"crop","instructions":"test","material_ids":[]})
            }
            _ => schema_input(&jt_app::usecases::studio::schema::input(action)),
        };
        let mut denied = w.ctx.clone();
        denied.permissions = Permission::all()
            .iter()
            .copied()
            .filter(|p| !expected.contains(p))
            .collect();
        let err = call_studio(action, &w.d, &denied, input.clone())
            .await
            .expect_err(row.id);
        assert_eq!(err.code, ErrorCode::Forbidden, "{}: {err:?}", row.id);
        assert!(
            err.details.get("permissions").is_some() || err.details.get("permission").is_some(),
            "{}: {err:?}",
            row.id
        );
        for &permission in expected {
            let mut allowed = w.ctx.clone();
            allowed.permissions = [permission].into_iter().collect();
            // This operation has an independent strategy-edit permission, retained by design.
            if action == "hypothesis_propose" {
                allowed.permissions.insert(Permission::TeamManage);
            }
            let mut input = input.clone();
            if action == "approve" {
                input["target"] = if permission == Permission::AdsManage {
                    json!({"budget_move":"00000000-0000-4000-8000-000000000001"})
                } else {
                    json!({"slot":"00000000-0000-4000-8000-000000000001"})
                };
            }
            if let Err(err) = call_studio(action, &w.d, &allowed, input).await {
                assert!(
                    !(err.code == ErrorCode::Forbidden
                        && (err.details.get("permissions").is_some()
                            || err.details.get("permission").is_some())),
                    "{} with {permission:?}: {err:?}",
                    row.id
                );
            }
        }
    }
}

#[tokio::test]
async fn require_any_is_any_of_and_empty_never_grants_access() {
    let w = support::world().await;
    let mut ctx = w.ctx.clone();
    ctx.permissions = [Permission::ContentWork].into_iter().collect();
    assert!(
        ctx.require_any(&[Permission::SocialWork, Permission::ContentWork])
            .is_ok()
    );
    let err = ctx
        .require_any(&[Permission::SocialManage, Permission::AdsManage])
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(
        err.details,
        json!({"permissions":["social.manage","ads.manage"]})
    );
    assert_eq!(ctx.require_any(&[]).unwrap_err().code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn pending_and_checkin_filter_each_module_for_members_and_agents() {
    use jt_app::usecases::work::{self, WorkKind};
    let (w, budget_id) = module_work_world().await;
    for (grants, expected) in [
        (vec![Permission::ContentWork], vec!["production", "project"]),
        (vec![Permission::MaterialsWork], vec!["analysis", "shoot"]),
        (vec![Permission::SocialWork], vec!["slot"]),
        (
            vec![Permission::AdsWork, Permission::AdsManage],
            vec!["approval", "budget"],
        ),
    ] {
        for agent in [false, true] {
            let mut ctx = w.ctx.clone();
            // Both work endpoints retain their baseline workspace.read permission.
            ctx.permissions = grants
                .iter()
                .copied()
                .chain([Permission::WorkspaceRead])
                .collect();
            if agent {
                let Actor::Human { user_id } = ctx.actor else {
                    panic!()
                };
                let connection_id = AgentConnectionId::new_v7();
                ctx.actor = Actor::Agent {
                    user_id,
                    connection_id,
                };
                ctx.agent_connection_id = Some(connection_id);
            }
            let mut outputs = vec![work::pending(&w.d, &ctx).await.unwrap()];
            if agent {
                outputs.push(work::checkin(&w.d, &ctx).await.unwrap());
            }
            for output in outputs {
                let actual: std::collections::BTreeSet<_> = output
                    .items
                    .iter()
                    .filter_map(|i| match i.kind {
                        WorkKind::ContentArea { .. } => Some("project"),
                        WorkKind::StudioMaterialProduction { .. } => Some("production"),
                        WorkKind::StudioMaterialAnalysis { .. } => Some("analysis"),
                        WorkKind::StudioShootRequest { .. } => Some("shoot"),
                        WorkKind::StudioSlot { .. } => Some("slot"),
                        WorkKind::StudioBudgetMove { .. } => Some("budget"),
                        WorkKind::StudioApproval { target } => {
                            assert_eq!(target, ApprovalTarget::BudgetMove(budget_id));
                            Some("approval")
                        }
                        WorkKind::StudioPostRequest { .. } => Some("post"),
                        _ => None,
                    })
                    .collect();
                assert_eq!(
                    actual,
                    expected
                        .iter()
                        .copied()
                        .filter(|kind| agent || *kind != "project")
                        .collect(),
                    "{grants:?}, agent={agent}"
                );
            }
        }
    }
}

#[tokio::test]
async fn controls_require_the_target_lane_permission() {
    let w = support::world().await;
    for (grant, wrong_target) in [
        (
            Permission::SocialManage,
            ApprovalTarget::BudgetMove(jt_studio::BudgetMoveId::new_v7()),
        ),
        (
            Permission::AdsManage,
            ApprovalTarget::Slot(jt_studio::SlotId::new_v7()),
        ),
    ] {
        let mut ctx = w.ctx.clone();
        ctx.permissions = [grant].into_iter().collect();
        let err = approve(
            &w.d,
            &ctx,
            ApprovalInput {
                target: wrong_target,
                expected_revision: 0,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
    }
}

#[tokio::test]
async fn overview_with_valid_window_accepts_each_control_permission() {
    use jt_app::usecases::studio::views;
    let w = support::world().await;
    for grant in [
        Permission::SocialManage,
        Permission::AdsManage,
        Permission::BudgetManage,
    ] {
        let mut ctx = w.ctx.clone();
        ctx.permissions = [grant].into_iter().collect();
        let q = serde_json::from_value(
            json!({"from":"2026-10-01T00:00:00Z","until":"2026-12-01T00:00:00Z"}),
        )
        .unwrap();
        let result = views::overview(&w.d, &ctx, q).await;
        assert!(result.is_ok(), "{grant:?}: {result:?}");
    }
}

async fn module_work_world() -> (support::World, jt_studio::BudgetMoveId) {
    use jt_app::{
        ports::material_productions::*,
        usecases::studio::{library, projects},
    };
    use jt_testkit::fakes::FIXED_NOW;
    let w = support::world().await;
    let (binding, budget_move) = w.paid().await;
    // The ad account's own flag: its budget moves wait for a person's approval.
    w.approval_of(binding.capability_id, true).await;
    projects::project_create(
        &w.d,
        &w.ctx,
        serde_json::from_value(
            json!({"request_key":"module-work","title":"Module work","brief":"Prepare content"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    library::shoot_request(
        &w.d,
        &w.ctx,
        library::ShootRequestInput {
            request_key: "module-shoot".into(),
            text: "Photograph the product".into(),
            week_start: None,
        },
    )
    .await
    .unwrap();
    let source = jt_testkit::studio_contract::seed_material(&w.uow, w.f.ws).await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_productions()
        .save_production(
            ProductionRecord {
                production: MaterialProduction {
                    id: uuid::Uuid::new_v4(),
                    workspace_id: w.f.ws,
                    kind: ProductionKind::Crop,
                    instructions: "Crop".into(),
                    sources: vec![ProductionSource {
                        material_id: source.id,
                        expected_revision: source.revision,
                    }],
                    status: ProductionStatus::Pending,
                    output_material_id: None,
                    last_error_code: None,
                    revision: 1,
                    created_at: FIXED_NOW,
                    updated_at: FIXED_NOW,
                },
                lease: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    (w, budget_move.id)
}

fn module_agent(w: &support::World) -> jt_app::ctx::Ctx {
    let mut c = w.ctx.clone();
    let Actor::Human { user_id } = c.actor else {
        panic!()
    };
    let connection_id = AgentConnectionId::new_v7();
    c.actor = Actor::Agent {
        user_id,
        connection_id,
    };
    c.agent_connection_id = Some(connection_id);
    c
}
async fn configure_module_work(
    w: &support::World,
    assigned: Option<AgentConnectionId>,
    installed: bool,
) {
    let mut modules = jt_app::usecases::modules::list(&w.d, &w.ctx)
        .await
        .unwrap()
        .modules;
    for m in &mut modules {
        if ["content", "social", "ads", "materials"].contains(&m.blueprint.id.as_str()) {
            m.installed = installed;
            m.config.agent_ids = assigned.into_iter().collect();
        }
    }
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.workspace()
        .save_module_registry(json!({"legacy":false,"modules":modules}))
        .await
        .unwrap();
    r.commit().await.unwrap();
}
async fn module_work_kinds(
    w: &support::World,
    c: &jt_app::ctx::Ctx,
) -> std::collections::BTreeSet<String> {
    jt_app::usecases::work::pending(&w.d, c)
        .await
        .unwrap()
        .items
        .iter()
        .map(|i| {
            serde_json::to_value(&i.kind).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .filter(|k| k.starts_with("studio_") || k.starts_with("content_"))
        .collect()
}
#[tokio::test]
async fn assigned_agent_gets_the_module_work_and_others_do_not() {
    let (w, _) = module_work_world().await;
    let a = module_agent(&w);
    let b = module_agent(&w);
    let before = module_work_kinds(&w, &a).await;
    assert_eq!(before.len(), 7);
    let human = module_work_kinds(&w, &w.ctx).await;
    configure_module_work(&w, a.agent_connection_id, true).await;
    assert_eq!(module_work_kinds(&w, &a).await, before);
    assert!(module_work_kinds(&w, &b).await.is_empty());
    assert_eq!(module_work_kinds(&w, &w.ctx).await, human);
}
#[tokio::test]
async fn unassigned_module_serves_any_agent_with_permission() {
    let (w, _) = module_work_world().await;
    configure_module_work(&w, None, true).await;
    let a = module_agent(&w);
    let b = module_agent(&w);
    let kinds = module_work_kinds(&w, &a).await;
    assert_eq!(kinds.len(), 7);
    assert_eq!(module_work_kinds(&w, &b).await, kinds);
    let mut none = b;
    none.permissions = [Permission::WorkspaceRead].into_iter().collect();
    assert!(module_work_kinds(&w, &none).await.is_empty());
}
#[tokio::test]
async fn removed_module_work_is_not_listed() {
    let (w, _) = module_work_world().await;
    let a = module_agent(&w);
    assert_eq!(module_work_kinds(&w, &a).await.len(), 7);
    configure_module_work(&w, None, false).await;
    assert!(module_work_kinds(&w, &a).await.is_empty());
    assert!(module_work_kinds(&w, &w.ctx).await.is_empty());
}
