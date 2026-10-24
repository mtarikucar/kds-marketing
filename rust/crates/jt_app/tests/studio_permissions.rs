use jt_app::{
    catalog::{CATALOG, GateMode, StatusExemption},
    error::ErrorCode,
    gate::{NoStrategyYet, check_gate},
};
use jt_tenancy::{Permission, SystemRole, WorkspaceId, WorkspaceStatus};

#[test]
fn studio_permissions_and_public_rows_are_explicit() {
    for role in [SystemRole::Owner, SystemRole::Manager] {
        assert!(role.permissions().contains(&Permission::StudioWork));
        assert!(role.permissions().contains(&Permission::StudioManage));
    }
    assert!(
        !SystemRole::Rep
            .permissions()
            .contains(&Permission::StudioWork)
    );
    assert!(
        !SystemRole::Rep
            .permissions()
            .contains(&Permission::StudioManage)
    );
    for (id, method, path, gate) in [
        (
            "studio.brake",
            "POST",
            "/api/studio/brake",
            GateMode::Exempt,
        ),
        (
            "studio.policy_set",
            "PUT",
            "/api/studio/policy",
            GateMode::Gated,
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
    agent.permissions.remove(&Permission::StudioManage);
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
    assert_eq!(
        policy_set(
            &w.d,
            &w.ctx,
            StudioPolicyInput {
                lane: jt_strategy::LaneKind::Organic,
                requires_human_approval: true,
                expected_revision: 0
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::StrategyRequired
    );
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
    assert!(
        serde_json::from_value::<StudioPolicyInput>(
            json!({"lane":"paid","requires_human_approval":true,"expected_revision":0,"oops":true})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<ApprovalInput>(json!({"target":{"slot":uuid::Uuid::new_v4(),"budget_move":uuid::Uuid::new_v4()},"expected_revision":1})).is_err());
    for action in ["brake", "policy_set", "approve"] {
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
