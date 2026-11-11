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
    // A new workspace has the strategy and nothing else.
    assert_eq!(o.modules.iter().filter(|m| m.installed).count(), 1);
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
        10
    );
    assert_eq!(
        modules::list(&d, &b)
            .await
            .unwrap()
            .modules
            .iter()
            .filter(|m| m.installed)
            .count(),
        1
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
    assert_eq!(
        modules::remove(&d, &a, "strategy").await.unwrap_err().code,
        ErrorCode::Validation
    );
    // The inbox is an ordinary module: it installs and is removed like any other.
    let installed = |o: &modules::ModulesOut| {
        o.modules
            .iter()
            .any(|m| m.installed && m.blueprint.id == "inbox")
    };
    let o = modules::install(&d, &a, "inbox", InstallInput::default())
        .await
        .unwrap();
    assert!(installed(&o));
    let o = modules::remove(&d, &a, "inbox").await.unwrap();
    assert!(!installed(&o));
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
        modules::install(&d, &no, "social", InstallInput::default())
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
                "strategy",
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
    let o = modules::list(&d, &a).await.unwrap();
    let strategy = o
        .modules
        .iter()
        .find(|m| m.blueprint.id == "strategy")
        .unwrap();
    assert_eq!(strategy.revision, 1);
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
        .find(|b| b.id == "social")
        .unwrap();
    b.builtin = false;
    let out = modules::install(
        &d,
        &a,
        "social",
        InstallInput {
            blueprint: Some(b.clone()),
        },
    )
    .await
    .unwrap();
    assert!(
        out.modules
            .iter()
            .find(|m| m.blueprint.id == "social")
            .unwrap()
            .blueprint
            .builtin
    );
    b.name = "Spoofed".into();
    assert_eq!(
        modules::install(&d, &a, "social", InstallInput { blueprint: Some(b) })
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
        "strategy",
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
            "strategy",
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

/// A capability of `kind` in `status`, written straight into the workspace of `ctx`.
async fn capability(uow: &InMemoryUow, ctx: &Ctx, kind: &str, status: jt_capability::StoredStatus) {
    let mut cap = jt_capability::Capability::new(
        CapabilityId::new_v7(),
        ctx.workspace_id,
        jt_capability::NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} hesabı"),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = status;
    let mut t = uow.tenant(ctx.workspace_id).await.unwrap();
    t.capabilities().insert(cap, None).await.unwrap();
    t.commit().await.unwrap();
}

#[tokio::test]
async fn a_module_is_ready_only_once_a_capability_it_needs_is_connected() {
    use jt_capability::StoredStatus;
    let (uow, d, a, b) = world().await;
    let o = modules::list(&d, &a).await.unwrap();
    let inbox = &o.availability["inbox"];
    assert!(!inbox.ready);
    assert_eq!(inbox.missing, vec!["messaging".to_owned()]);
    assert!(
        o.availability["strategy"].ready,
        "strategy never waits for a capability"
    );
    assert!(o.availability["people"].ready);
    assert_eq!(
        o.availability["outreach"].missing,
        vec!["mailbox|sms_line|whatsapp_cloud".to_owned()]
    );
    assert_eq!(
        o.availability["calls"].missing,
        vec!["telephony".to_owned()]
    );

    // Declared (never connected) does not count; an Instagram DM is messaging but cannot send a
    // campaign; a verified mailbox can.
    capability(&uow, &a, "mailbox", StoredStatus::Declared).await;
    assert!(!modules::list(&d, &a).await.unwrap().availability["inbox"].ready);
    capability(&uow, &a, "instagram_dm", StoredStatus::Verified).await;
    let o = modules::list(&d, &a).await.unwrap();
    assert!(o.availability["inbox"].ready);
    assert!(!o.availability["outreach"].ready);
    capability(&uow, &a, "sms_line", StoredStatus::Unreachable).await;
    let o = modules::list(&d, &a).await.unwrap();
    assert!(
        o.availability["outreach"].ready,
        "a temporary outage keeps a connected module open"
    );
    assert_eq!(
        modules::missing_for(&mut *uow.tenant(a.workspace_id).await.unwrap(), "inbox")
            .await
            .unwrap(),
        Vec::<String>::new()
    );

    // Another workspace's capabilities never open this one's modules.
    assert!(!modules::list(&d, &b).await.unwrap().availability["inbox"].ready);
}

#[tokio::test]
async fn builtin_catalog_has_four_studio_modules_and_only_strategy_is_required() {
    let (_, d, a, _) = world().await;
    let o = modules::list(&d, &a).await.unwrap();
    let ids: Vec<&str> = o.modules.iter().map(|m| m.blueprint.id.as_str()).collect();
    for id in [
        modules::CONTENT,
        modules::SOCIAL,
        modules::ADS,
        modules::MATERIALS,
    ] {
        assert!(ids.contains(&id), "{id}");
    }
    assert!(!ids.contains(&"growth-studio"));
    let required: Vec<&str> = o
        .modules
        .iter()
        .filter(|m| m.required)
        .map(|m| m.blueprint.id.as_str())
        .collect();
    assert_eq!(required, ["strategy"]);
    let needs = |id: &str| {
        o.modules
            .iter()
            .find(|m| m.blueprint.id == id)
            .unwrap()
            .blueprint
            .requirements
            .clone()
    };
    assert!(needs(modules::CONTENT).is_empty());
    assert_eq!(needs(modules::SOCIAL), ["social_account"]);
    assert_eq!(needs(modules::ADS), ["ads"]);
    assert!(needs(modules::MATERIALS).is_empty());
    // The agent's guide for a production area: the fourteen steps it reports by number.
    let steps = &o
        .modules
        .iter()
        .find(|m| m.blueprint.id == modules::CONTENT)
        .unwrap()
        .blueprint
        .workflow;
    assert_eq!(steps.len(), 14);
    assert!(steps[0].starts_with("Amacı belirle:"));
    assert!(steps[8].starts_with("Materyali üret ya da topla:"));
    assert!(steps[13].starts_with("Paketle:"));
    assert!(steps.iter().all(|s| s.chars().count() <= 500));
}

#[tokio::test]
async fn the_materials_library_comes_with_its_dependants_and_stays_while_one_is_installed() {
    let (_, d, a, _) = world().await;
    let installed = |o: &modules::ModulesOut, id: &str| {
        o.modules
            .iter()
            .any(|m| m.installed && m.blueprint.id == id)
    };
    // The library installs and is removed on its own.
    let o = modules::install(&d, &a, modules::MATERIALS, InstallInput::default())
        .await
        .unwrap();
    assert!(installed(&o, modules::MATERIALS));
    let o = modules::remove(&d, &a, modules::MATERIALS).await.unwrap();
    assert!(!installed(&o, modules::MATERIALS));
    // Each module that needs it brings it, and keeps it while it is installed.
    for id in [modules::CONTENT, modules::SOCIAL, modules::ADS] {
        let o = modules::install(&d, &a, id, InstallInput::default())
            .await
            .unwrap();
        assert!(installed(&o, id), "{id}");
        assert!(installed(&o, modules::MATERIALS), "{id}");
        let err = modules::remove(&d, &a, modules::MATERIALS)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation, "{id}");
        assert_eq!(err.details["field"], "module", "{id}");
        modules::remove(&d, &a, id).await.unwrap();
        let o = modules::remove(&d, &a, modules::MATERIALS).await.unwrap();
        assert!(!installed(&o, modules::MATERIALS), "{id}");
    }
}

#[test]
fn stored_registries_resolve_by_catalog_legacy_flag_and_dependency() {
    use jt_strategy::LaneKind;
    use serde_json::json;
    let installed =
        |data: Option<&serde_json::Value>, id: &str| modules::installed_in(data, id).unwrap();
    let entry = |id: &str, installed: bool| {
        json!({
            "blueprint": {"id": id, "name": id, "description": "", "version": "1.0",
                          "requirements": [], "workflow": [], "builtin": true},
            "installed": installed, "required": false,
            "config": {"brief": "", "agent_ids": [], "capability_ids": []}, "revision": 2
        })
    };
    // No row: the strategy and nothing else.
    assert!(installed(None, "strategy"));
    for id in [
        "inbox",
        modules::CONTENT,
        modules::SOCIAL,
        modules::ADS,
        modules::MATERIALS,
        "people",
    ] {
        assert!(!installed(None, id), "{id}");
    }
    // A legacy row with no entries: every builtin module.
    let legacy = json!({"legacy": true, "modules": []});
    for id in [
        "inbox",
        "strategy",
        modules::CONTENT,
        modules::SOCIAL,
        modules::ADS,
        modules::MATERIALS,
        "people",
        "prospects",
        "outreach",
        "calls",
    ] {
        assert!(installed(Some(&legacy), id), "{id}");
    }
    // An explicit removal wins over the legacy flag.
    let removed = json!({"legacy": true, "modules": [entry(modules::ADS, false)]});
    assert!(!installed(Some(&removed), modules::ADS));
    assert!(installed(Some(&removed), modules::SOCIAL));
    // The library is installed whenever a module that needs it is, whatever was stored.
    let broken = json!({"legacy": false, "modules": [
        entry(modules::SOCIAL, true), entry(modules::MATERIALS, false)]});
    assert!(installed(Some(&broken), modules::MATERIALS));
    // A builtin entry the catalog no longer has is dropped.
    let stale = json!({"legacy": false, "modules": [entry("growth-studio", true)]});
    assert!(!installed(Some(&stale), "growth-studio"));
    // The lanes a module that is not installed stops.
    assert_eq!(
        modules::removed_lanes(None).unwrap(),
        [LaneKind::Organic, LaneKind::Paid].into()
    );
    assert!(modules::removed_lanes(Some(&legacy)).unwrap().is_empty());
    assert_eq!(
        modules::removed_lanes(Some(&removed)).unwrap(),
        [LaneKind::Paid].into()
    );
}
