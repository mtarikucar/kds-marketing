//! Workspace module durability, ordinary-role isolation and reversible migration boundaries.

use std::sync::Arc;

use jt_app::{
    ctx::Ctx,
    ports::UnitOfWork,
    usecases::modules::{self, Blueprint, InstallInput},
};
use jt_ledger::Actor;
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_tenancy::SystemRole;
use jt_testkit::{TestDb, fakes};
use serde_json::{Value, json};

const UP: &str = include_str!("../../../../migrations/0032_workspace_modules.up.sql");
const DOWN: &str = include_str!("../../../../migrations/0032_workspace_modules.down.sql");

async fn registry(uow: &PgUnitOfWork, ws: jt_tenancy::WorkspaceId) -> Option<Value> {
    uow.tenant(ws)
        .await
        .unwrap()
        .workspace()
        .module_registry()
        .await
        .unwrap()
}

#[tokio::test]
async fn registries_are_durable_tenant_scoped_and_rollback_uncommitted_changes() {
    let db = TestDb::new().await;
    // As registration leaves them: no registry row yet.
    let (a, _) = db.seed_new_workspace("modules-a").await;
    let (b, _) = db.seed_new_workspace("modules-b").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    assert_eq!(registry(&uow, a).await, None);
    assert_eq!(registry(&uow, b).await, None);
    let original = json!({"legacy":false,"modules":[{"private":"workspace A brief"}]});
    let mut tx = uow.tenant(a).await.unwrap();
    tx.workspace().lock().await.unwrap();
    tx.workspace()
        .save_module_registry(original.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(registry(&uow, a).await, Some(original.clone()));
    assert_eq!(registry(&uow, b).await, None);

    let mut tx = uow.tenant(a).await.unwrap();
    tx.workspace().lock().await.unwrap();
    tx.workspace()
        .save_module_registry(json!({"private":"uncommitted"}))
        .await
        .unwrap();
    drop(tx);
    assert_eq!(registry(&uow, a).await, Some(original));

    let (forced, bypass): (bool, bool) = sqlx::query_as(
        "select c.relrowsecurity and c.relforcerowsecurity, r.rolsuper or r.rolbypassrls \
         from pg_class c cross join pg_roles r \
         where c.relname='workspace_modules' and r.rolname=current_user",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(forced);
    assert!(!bypass);
    let unscoped: i64 = sqlx::query_scalar("select count(*) from workspace_modules")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(unscoped, 0);

    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    let foreign: Option<Value> =
        sqlx::query_scalar("select data from workspace_modules where workspace_id=$1")
            .bind(a.as_uuid())
            .fetch_optional(tx.conn())
            .await
            .unwrap();
    assert_eq!(foreign, None);
    let refused = sqlx::query("insert into workspace_modules(workspace_id,data) values($1,'{}')")
        .bind(a.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        refused.as_database_error().unwrap().code().as_deref(),
        Some("42501"),
    );
}

#[tokio::test]
async fn migration_seeds_all_existing_tenants_and_preserves_customized_registries() {
    let db = TestDb::new().await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (a, _) = db.seed_workspace("modules-legacy-a").await;
    let (b, _) = db.seed_workspace("modules-legacy-b").await;
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    let uow = PgUnitOfWork::new(db.pool.clone());
    let legacy = json!({"legacy":true,"modules":[]});
    assert_eq!(registry(&uow, a).await, Some(legacy.clone()));
    assert_eq!(registry(&uow, b).await, Some(legacy.clone()));
    let customized = json!({"legacy":false,"modules":[],"private_note":"keep"});
    let mut tx = uow.tenant(a).await.unwrap();
    tx.workspace().lock().await.unwrap();
    tx.workspace()
        .save_module_registry(customized.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    assert_eq!(registry(&uow, a).await, Some(customized.clone()));
    assert_eq!(registry(&uow, b).await, Some(legacy));
    let (new_ws, _) = db.seed_new_workspace("modules-new").await;
    assert_eq!(registry(&uow, new_ws).await, None);
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    assert_eq!(registry(&uow, new_ws).await, None);

    let err = sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap_err();
    assert!(
        err.to_string()
            .contains("workspace module configurations are stored")
    );
    assert_eq!(registry(&uow, a).await, Some(customized));
    let platform: Option<String> =
        sqlx::query_scalar("select current_setting('app.platform',true)")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_ne!(platform.as_deref(), Some("on"));
}

#[tokio::test]
async fn pristine_legacy_seed_roundtrips_without_elevating_the_connection() {
    let db = TestDb::new().await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (ws, _) = db.seed_workspace("modules-pristine").await;
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    }
    for _ in 0..2 {
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    }
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    let uow = PgUnitOfWork::new(db.pool.clone());
    assert_eq!(
        registry(&uow, ws).await,
        Some(json!({"legacy":true,"modules":[]}))
    );
    let platform: Option<String> =
        sqlx::query_scalar("select current_setting('app.platform',true)")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_ne!(platform.as_deref(), Some("on"));
}

fn custom(id: &str) -> InstallInput {
    InstallInput {
        blueprint: Some(Blueprint {
            id: id.into(),
            name: id.into(),
            description: "Portable work definition".into(),
            version: "1.0".into(),
            requirements: vec![],
            workflow: vec!["Review the brief".into()],
            builtin: false,
        }),
    }
}

#[tokio::test]
async fn simultaneous_first_installs_keep_every_blueprint_and_only_core_defaults() {
    let db = TestDb::new().await;
    let (ws, user) = db.seed_new_workspace("modules-concurrent").await;
    let deps = fakes::deps(Arc::new(PgUnitOfWork::new(db.pool.clone())));
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: fakes::FIXED_NOW,
        agent_connection_id: None,
    };
    let before = modules::list(&deps, &ctx).await.unwrap();
    // A new workspace has the strategy and nothing else.
    assert_eq!(before.modules.iter().filter(|m| m.installed).count(), 1);
    let (a, b, c) = tokio::join!(
        modules::install(&deps, &ctx, "review-alpha", custom("review-alpha")),
        modules::install(&deps, &ctx, "review-beta", custom("review-beta")),
        modules::install(&deps, &ctx, "review-gamma", custom("review-gamma")),
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    let after = modules::list(&deps, &ctx).await.unwrap();
    assert_eq!(after.modules.iter().filter(|m| m.installed).count(), 4);
    for id in ["review-alpha", "review-beta", "review-gamma"] {
        assert!(
            after
                .modules
                .iter()
                .any(|m| m.blueprint.id == id && m.installed)
        );
    }
}
