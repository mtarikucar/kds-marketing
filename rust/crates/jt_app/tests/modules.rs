//! Declarative module lifecycle, isolation and configuration invariants.
use jt_app::ports::UnitOfWork;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    usecases::{
        Deps,
        auth::{self, RegisterInput},
        modules::{self, Blueprint, InstallInput, ModuleConfig, UpdateInput},
    },
};
use jt_capability::CapabilityId;
use jt_tenancy::{AgentConnectionId, Permission};
use jt_testkit::fakes::{FIXED_NOW, FixedTokenGen, InMemoryUow, deps};
use std::sync::Arc;

async fn world() -> (InMemoryUow, Deps, Ctx, Ctx) {
    let uow = InMemoryUow::new();
    let d = Deps {
        tokens: Arc::new(FixedTokenGen::new(["aaaa", "a1", "bbbb", "b1"])),
        ..deps(Arc::new(uow.clone()))
    };
    let mut contexts = Vec::new();
    for (email, name, token) in [
        ("a@example.test", "Alpha", "a1"),
        ("b@example.test", "Beta", "b1"),
    ] {
        let r = auth::register(
            &d,
            RegisterInput {
                email: email.into(),
                password: "correct horse battery".into(),
                display_name: "Owner".into(),
                workspace_name: name.into(),
            },
        )
        .await
        .unwrap();
        let p = auth::resolve_session(&d, token).await.unwrap();
        contexts.push(auth::ctx_for(&p, r.me.current_workspace.unwrap(), FIXED_NOW).unwrap());
    }
    (uow, d, contexts.remove(0), contexts.remove(0))
}
fn blueprint() -> Blueprint {
    Blueprint {
        id: "workshop-cad".into(),
        name: "Atölye".into(),
        description: "Özel üretim süreci".into(),
        version: "1".into(),
        requirements: vec!["workshop-cad".into()],
        workflow: vec!["Çizimi incele".into()],
        builtin: false,
    }
}
#[tokio::test]
async fn new_workspaces_have_only_core_existing_seed_keeps_optional_and_tenants_isolate() {
    let (uow, d, a, b) = world().await;
    let o = modules::list(&d, &a).await.unwrap();
    assert_eq!(o.modules.iter().filter(|m| m.installed).count(), 2);
    let mut t = uow.tenant(a.workspace_id).await.unwrap();
    t.workspace().lock().await.unwrap();
    t.workspace()
        .save_module_registry(serde_json::json!({"legacy":true,"modules":[]}))
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(
        modules::list(&d, &a)
            .await
            .unwrap()
            .modules
            .iter()
            .filter(|m| m.installed)
            .count(),
        7
    );
    assert_eq!(
        modules::list(&d, &b)
            .await
            .unwrap()
            .modules
            .iter()
            .filter(|m| m.installed)
            .count(),
        2
    );
}
#[tokio::test]
async fn custom_lifecycle_persists_brief_rejects_stale_and_preserves_data_on_remove() {
    let (_, d, a, b) = world().await;
    let o = modules::install(
        &d,
        &a,
        "workshop-cad",
        InstallInput {
            blueprint: Some(blueprint()),
        },
    )
    .await
    .unwrap();
    assert_eq!(o.modules.last().unwrap().revision, 1);
    assert!(
        !modules::list(&d, &b)
            .await
            .unwrap()
            .modules
            .iter()
            .any(|m| m.blueprint.id == "workshop-cad")
    );
    let config = ModuleConfig {
        brief: "Test brief".into(),
        ..Default::default()
    };
    let o = modules::update(
        &d,
        &a,
        "workshop-cad",
        UpdateInput {
            config: config.clone(),
            revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(o.modules.last().unwrap().revision, 2);
    assert_eq!(
        modules::update(
            &d,
            &a,
            "workshop-cad",
            UpdateInput {
                config: config.clone(),
                revision: 1
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Conflict
    );
    let o = modules::remove(&d, &a, "workshop-cad").await.unwrap();
    assert!(!o.modules.last().unwrap().installed);
    assert_eq!(o.modules.last().unwrap().config, config);
    let o = modules::install(&d, &a, "workshop-cad", InstallInput::default())
        .await
        .unwrap();
    assert!(o.modules.last().unwrap().installed);
    assert_eq!(o.modules.last().unwrap().config, config);
    assert_eq!(
        modules::list(&d, &a)
            .await
            .unwrap()
            .modules
            .last()
            .unwrap()
            .revision,
        4
    );
}
#[tokio::test]
async fn required_and_builtin_identities_immutable_permission_and_manifest_bounds_enforced() {
    let (_, d, a, _) = world().await;
    for id in ["inbox", "strategy"] {
        assert_eq!(
            modules::remove(&d, &a, id).await.unwrap_err().code,
            ErrorCode::Validation
        );
    }
    let mut b = blueprint();
    b.id = "inbox".into();
    assert_eq!(
        modules::install(&d, &a, "inbox", InstallInput { blueprint: Some(b) })
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let mut b = blueprint();
    b.name = "x".repeat(121);
    assert_eq!(
        modules::install(&d, &a, "workshop-cad", InstallInput { blueprint: Some(b) })
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let mut no = a.clone();
    no.permissions.remove(&Permission::CapabilitiesManage);
    assert_eq!(
        modules::install(&d, &no, "growth-studio", InstallInput::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert!(serde_json::from_value::<InstallInput>(serde_json::json!({"blueprint":{"id":"xx","name":"X","description":"","version":"1","requirements":[],"workflow":[],"route":"https://example.test"}})).is_err());
}
#[tokio::test]
async fn assignments_reject_unknown_tenant_agent_and_capability_without_granting_scopes() {
    let (_, d, a, _) = world().await;
    for config in [
        ModuleConfig {
            agent_ids: vec![AgentConnectionId::new_v7()],
            ..Default::default()
        },
        ModuleConfig {
            capability_ids: vec![CapabilityId::new_v7()],
            ..Default::default()
        },
    ] {
        assert_eq!(
            modules::update(
                &d,
                &a,
                "inbox",
                UpdateInput {
                    config,
                    revision: 1
                }
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::Validation
        );
    }
    assert_eq!(modules::list(&d, &a).await.unwrap().modules[0].revision, 1);
}
#[tokio::test]
async fn concurrent_custom_installs_do_not_overwrite_each_other() {
    let (_, d, a, _) = world().await;
    let mut other = blueprint();
    other.id = "legal-review".into();
    let (x, y) = tokio::join!(
        modules::install(
            &d,
            &a,
            "workshop-cad",
            InstallInput {
                blueprint: Some(blueprint())
            }
        ),
        modules::install(
            &d,
            &a,
            "legal-review",
            InstallInput {
                blueprint: Some(other)
            }
        )
    );
    x.unwrap();
    y.unwrap();
    let o = modules::list(&d, &a).await.unwrap();
    assert_eq!(o.modules.iter().filter(|m| !m.blueprint.builtin).count(), 2);
}

#[tokio::test]
async fn builtin_portable_roundtrip_restores_authoritative_marker_only() {
    let (_, d, a, _) = world().await;
    let mut b = modules::catalog()
        .into_iter()
        .find(|b| b.id == "growth-studio")
        .unwrap();
    b.builtin = false;
    let out = modules::install(
        &d,
        &a,
        "growth-studio",
        InstallInput {
            blueprint: Some(b.clone()),
        },
    )
    .await
    .unwrap();
    assert!(
        out.modules
            .iter()
            .find(|m| m.blueprint.id == "growth-studio")
            .unwrap()
            .blueprint
            .builtin
    );
    b.name = "Spoofed".into();
    assert_eq!(
        modules::install(&d, &a, "growth-studio", InstallInput { blueprint: Some(b) })
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn binding_accepts_active_issuer_and_rejects_revoked_agent_without_granting_scopes() {
    use jt_app::ports::{AgentConnectionRow, ApiKeyRow, ApiKeyStatus};
    use jt_ledger::Actor;
    use jt_tenancy::ApiKeyId;
    let (uow, d, a, _) = world().await;
    let user = match a.actor {
        Actor::Human { user_id } => user_id,
        _ => panic!("human fixture"),
    };
    let key = ApiKeyId::new_v7();
    let agent = AgentConnectionId::new_v7();
    let mut t = uow.tenant(a.workspace_id).await.unwrap();
    t.api_keys()
        .insert(ApiKeyRow {
            id: key,
            workspace_id: a.workspace_id,
            name: "Test agent".into(),
            prefix: "test".into(),
            key_hash: "fixture-hash".into(),
            scopes: [Permission::WorkspaceRead].into(),
            issued_by: user,
            status: ApiKeyStatus::Active,
            created_at: FIXED_NOW,
            last_used_at: None,
            revoked_at: None,
        })
        .await
        .unwrap();
    t.agent_connections()
        .upsert_on_initialize(AgentConnectionRow {
            id: agent,
            workspace_id: a.workspace_id,
            api_key_id: key,
            client_name: "test".into(),
            client_version: "1".into(),
            protocol_version: "1".into(),
            first_seen_at: FIXED_NOW,
            last_seen_at: FIXED_NOW,
            tool_calls: 0,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let config = ModuleConfig {
        agent_ids: vec![agent],
        ..Default::default()
    };
    modules::update(
        &d,
        &a,
        "inbox",
        UpdateInput {
            config: config.clone(),
            revision: 1,
        },
    )
    .await
    .unwrap();
    let mut t = uow.tenant(a.workspace_id).await.unwrap();
    assert_eq!(
        t.api_keys().list().await.unwrap()[0].scopes,
        [Permission::WorkspaceRead].into()
    );
    t.api_keys().revoke(key, FIXED_NOW).await.unwrap();
    t.commit().await.unwrap();
    assert_eq!(
        modules::update(
            &d,
            &a,
            "inbox",
            UpdateInput {
                config,
                revision: 2
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Validation
    );
}
