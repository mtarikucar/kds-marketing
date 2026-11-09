//! Ordinary-role RLS, compare-and-swap and non-destructive migration guards.
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, production_projects::ProductionProject},
};
use jt_pg::PgUnitOfWork;
use jt_testkit::{TestDb, fakes::FIXED_NOW};
use uuid::Uuid;
fn project(ws: jt_tenancy::WorkspaceId) -> ProductionProject {
    ProductionProject {
        id: Uuid::now_v7(),
        workspace_id: ws,
        title: "Private project".into(),
        brief: "Private brief".into(),
        revision: 1,
        archived: false,
        sources: vec![],
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    }
}
#[tokio::test]
async fn project_repository_is_tenant_scoped_revision_guarded_and_forces_rls() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("projects-a").await;
    let (b, _) = db.seed_workspace("projects-b").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let p = project(a);
    let mut r = uow.tenant(a).await.unwrap();
    r.studio_projects()
        .save_project(p.clone(), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(b).await.unwrap();
    assert!(
        r.studio_projects()
            .get_project(p.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        r.studio_projects()
            .list_projects(false, None)
            .await
            .unwrap()
            .is_empty()
    );
    drop(r);
    let mut r = uow.tenant(a).await.unwrap();
    let mut updated = p.clone();
    updated.revision = 2;
    updated.brief = "Updated".into();
    r.studio_projects()
        .save_project(updated.clone(), Some(1))
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(a).await.unwrap();
    assert_eq!(
        r.studio_projects().get_project(p.id).await.unwrap(),
        Some(updated)
    );
    let mut stale = p;
    stale.revision = 2;
    assert_eq!(
        r.studio_projects()
            .save_project(stale, Some(1))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(r);
    let unscoped: i64 = sqlx::query_scalar("select count(*) from studio_production_projects")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(unscoped, 0);
    let forced:bool=sqlx::query_scalar("select relrowsecurity and relforcerowsecurity from pg_class where relname='studio_production_projects'").fetch_one(&db.pool).await.unwrap();
    assert!(forced);
}
#[tokio::test]
async fn migration_guard_sees_populated_projects_without_tenant_or_platform_context() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("project-down").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(project(ws), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let superuser: bool = sqlx::query_scalar(
        "select rolsuper or rolbypassrls from pg_roles where rolname=current_user",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!superuser);
    let count: i64 = sqlx::query_scalar("select count(*) from studio_production_projects")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let down = include_str!("../../../../migrations/0031_production_projects.down.sql");
    let e = sqlx::raw_sql(down).execute(&db.pool).await.unwrap_err();
    assert!(
        e.to_string()
            .contains("down refused: production projects are stored")
    );
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.studio_projects()
            .list_projects(false, None)
            .await
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn empty_project_migration_roundtrips_and_restores_platform_scope() {
    let db = TestDb::new().await;
    let up = include_str!("../../../../migrations/0031_production_projects.up.sql");
    let down = include_str!("../../../../migrations/0031_production_projects.down.sql");
    for _ in 0..2 {
        sqlx::raw_sql(up).execute(&db.pool).await.unwrap();
    }
    for _ in 0..2 {
        sqlx::raw_sql(down).execute(&db.pool).await.unwrap();
    }
    sqlx::raw_sql(up).execute(&db.pool).await.unwrap();
    let platform: Option<String> =
        sqlx::query_scalar("select current_setting('app.platform',true)")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_ne!(platform.as_deref(), Some("on"));
}
