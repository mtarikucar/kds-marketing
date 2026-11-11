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
        start_at: None,
        opened_by: Default::default(),
        hints: Default::default(),
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
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

#[tokio::test]
async fn production_area_repository_contract() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("area-contract").await;
    jt_testkit::production_areas_contract::exercise(&PgUnitOfWork::new(db.pool.clone()), ws).await;
}

/// Runs `sql` as the tenant `ws` in its own transaction.
async fn as_tenant(
    db: &TestDb,
    ws: jt_tenancy::WorkspaceId,
) -> sqlx::Transaction<'_, sqlx::Postgres> {
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.workspace_id',$1,true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

#[tokio::test]
async fn area_migration_backfills_legacy_json_roundtrips_and_refuses_runtime_data() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("area-migration").await;
    let up = include_str!("../../../../migrations/0036_production_areas.up.sql");
    let down = include_str!("../../../../migrations/0036_production_areas.down.sql");
    // Down twice: the second finds nothing to revert.
    sqlx::raw_sql(down).execute(&db.pool).await.unwrap();
    sqlx::raw_sql(down).execute(&db.pool).await.unwrap();
    // An area as it was stored before: none of the new fields, no mirrored column.
    let p = project(ws);
    let mut data = serde_json::to_value(&p).unwrap();
    for k in [
        "start_at",
        "opened_by",
        "hints",
        "claim",
        "progress",
        "packages",
        "redo",
        "refused",
        "state",
    ] {
        data.as_object_mut().unwrap().remove(k);
    }
    let mut tx = as_tenant(&db, ws).await;
    sqlx::query("insert into studio_production_projects(workspace_id,id,revision,archived,data) values($1,$2,1,false,$3)")
        .bind(ws.0)
        .bind(p.id)
        .bind(data)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(up).execute(&db.pool).await.unwrap();
    }
    let mut tx = as_tenant(&db, ws).await;
    let times: (time::OffsetDateTime, Option<time::OffsetDateTime>) =
        sqlx::query_as("select start_at,done_at from studio_production_projects where id=$1")
            .bind(p.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(times, (FIXED_NOW, None));
    tx.commit().await.unwrap();
    // The area reads, lists as open and saves through the repository after the migration.
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let mut stored = r
        .studio_projects()
        .get_project(p.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((stored.start_at, stored.starts_at()), (None, FIXED_NOW));
    assert_eq!(
        r.studio_projects().list_areas(false, None).await.unwrap(),
        [stored.clone()]
    );
    stored.revision = 2;
    stored.title = "Renamed".into();
    r.studio_projects()
        .save_project(stored, Some(1))
        .await
        .unwrap();
    drop(r);
    // The round trip, then what the rollback refuses to lose.
    sqlx::raw_sql(down).execute(&db.pool).await.unwrap();
    sqlx::raw_sql(up).execute(&db.pool).await.unwrap();
    for (field, value) in [
        (
            "packages",
            serde_json::json!([{"delivered_at":"2026-01-01T00:00:00Z"}]),
        ),
        ("claim", serde_json::json!({"test":true})),
        ("redo", serde_json::json!({"test":true})),
        ("refusal", serde_json::json!({"test":true})),
    ] {
        let mut tx = as_tenant(&db, ws).await;
        // A redo suppresses done_at; this isolates the destructive rollback guard.
        sqlx::query("update studio_production_projects set data=jsonb_set(data,'{redo}','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb) where id=$1")
            .bind(p.id)
            .bind(field)
            .bind(value)
            .execute(&mut *tx)
            .await
            .unwrap();
        let err = sqlx::raw_sql(down).execute(&mut *tx).await.unwrap_err();
        assert!(err.to_string().contains("down refused: production areas"));
        tx.rollback().await.unwrap();
    }
    // A workspace's own choice is not dropped either: on by default, refused once turned off.
    let mut tx = as_tenant(&db, ws).await;
    sqlx::query("insert into studio_material_policy(workspace_id,lead_days,reuse_days,recap_days) values($1,21,14,30)")
        .bind(ws.0)
        .execute(&mut *tx)
        .await
        .unwrap();
    let on: bool = sqlx::query_scalar(
        "select ai_standalone from studio_material_policy where workspace_id=$1",
    )
    .bind(ws.0)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(on);
    sqlx::query("update studio_material_policy set ai_standalone=false where workspace_id=$1")
        .bind(ws.0)
        .execute(&mut *tx)
        .await
        .unwrap();
    let err = sqlx::raw_sql(down).execute(&mut *tx).await.unwrap_err();
    assert!(err.to_string().contains("down refused: a workspace turned"));
    tx.rollback().await.unwrap();
    let platform: Option<String> =
        sqlx::query_scalar("select current_setting('app.platform',true)")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_ne!(platform.as_deref(), Some("on"));
}

/// The mirrored columns follow the document through the repository: an awaited material and a
/// standing redo keep an area unfinished, and a start time finer than the database keeps is
/// stored without breaking the row's checks.
#[tokio::test]
async fn mirrored_area_columns_follow_the_stored_document() {
    use jt_app::ports::production_projects::*;
    let db = TestDb::new().await;
    let (ws, user) = db.seed_workspace("area-columns").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut p = project(ws);
    // 123456789 ns: the text rounds to ...457 microseconds, a bound value would truncate to ...456.
    p.start_at = Some(FIXED_NOW + time::Duration::nanoseconds(123_456_789));
    p.packages.push(ContentPackage {
        revision: 1,
        delivered_at: FIXED_NOW + time::Duration::hours(1),
        by: jt_tenancy::AgentConnectionId::new_v7(),
        summary: "Ready".into(),
        versions: vec![],
        released: None,
    });
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(p.clone(), None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let columns = |db: &TestDb| {
        let pool = db.pool.clone();
        let id = p.id;
        async move {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("select set_config('app.workspace_id',$1,true)")
                .bind(ws.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let row: (time::OffsetDateTime, Option<time::OffsetDateTime>) = sqlx::query_as(
                "select start_at,done_at from studio_production_projects where id=$1",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            row
        }
    };
    let (start, done) = columns(&db).await;
    assert_eq!(start, FIXED_NOW + time::Duration::microseconds(123_457));
    assert_eq!(done, Some(FIXED_NOW + time::Duration::hours(1)));
    let done_list = |uow: &PgUnitOfWork| {
        let uow = uow.clone();
        async move {
            let mut r = uow.tenant(ws).await.unwrap();
            r.studio_projects()
                .list_areas(true, None)
                .await
                .unwrap()
                .len()
        }
    };
    assert_eq!(done_list(&uow).await, 1);
    // A requested material is awaited: not finished.
    p.revision = 2;
    p.requests.push(ProjectMaterialRequest {
        id: uuid::Uuid::now_v7(),
        text: "A photo of the kiln".into(),
        status: RequestStatus::Open,
        material_ids: vec![],
        created_at: FIXED_NOW,
        resolved_at: None,
    });
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(p.clone(), Some(1))
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(columns(&db).await.1, None);
    assert_eq!(done_list(&uow).await, 0);
    // Supplied: finished again. A redo: unfinished until a delivery answers it.
    p.revision = 3;
    p.requests[0].status = RequestStatus::Dismissed;
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(p.clone(), Some(2))
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        columns(&db).await.1,
        Some(FIXED_NOW + time::Duration::hours(1))
    );
    p.revision = 4;
    p.redo = Some(RedoRequest {
        note: "Closer".into(),
        by: user,
        at: FIXED_NOW,
    });
    let mut r = uow.tenant(ws).await.unwrap();
    r.studio_projects()
        .save_project(p.clone(), Some(3))
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(columns(&db).await.1, None);
    // The answer's projection is never stored.
    let mut r = uow.tenant(ws).await.unwrap();
    let mut shown = r
        .studio_projects()
        .get_project(p.id)
        .await
        .unwrap()
        .unwrap();
    shown.revision = 5;
    let shown = shown.present(FIXED_NOW);
    assert!(shown.state.is_some());
    r.studio_projects()
        .save_project(shown, Some(4))
        .await
        .unwrap();
    assert!(
        r.studio_projects()
            .get_project(p.id)
            .await
            .unwrap()
            .unwrap()
            .state
            .is_none()
    );
}

/// The ad campaign store (`0040_ads_campaigns`): the shared contract, and the table's own rules.
#[tokio::test]
async fn ad_campaign_repository_contract() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("ads-contract").await;
    let (other, _) = db.seed_workspace("ads-other").await;
    jt_testkit::ads_contract::exercise(&PgUnitOfWork::new(db.pool.clone()), ws, other).await;
    // Forced row-level security with one tenant policy; unscoped, nothing is seen.
    let forced: bool = sqlx::query_scalar(
        "select relrowsecurity and relforcerowsecurity from pg_class where relname='ads_campaigns'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(forced);
    let unscoped: i64 = sqlx::query_scalar("select count(*) from ads_campaigns")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(unscoped, 0);
}
