//! Tenant isolation and the storage fence for externally claimed material analysis.
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, materials::*},
};
use jt_pg::PgUnitOfWork;
use jt_tenancy::AgentConnectionId;
use jt_testkit::{
    TestDb,
    fakes::FIXED_NOW,
    studio_contract::{ready, seed_material},
};
use time::Duration;

#[tokio::test]
async fn analysis_metadata_round_trips_is_tenant_scoped_and_cannot_attach_to_erased_material() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let a = ready(&uow).await;
    let b = ready(&uow).await;
    let material = seed_material(&uow, a.ws).await;
    let mut row = MaterialAnalysisRecord::pending(material.id, FIXED_NOW, DateSource::Exif);
    row.intelligence.description = "Private workspace description".into();
    row.intelligence.manual_fields.insert("description".into());
    row.intelligence.status = AnalysisStatus::Running;
    row.lease = Some(MaterialAnalysisLease {
        token_hash: "a".repeat(64),
        owner: AgentConnectionId::new_v7(),
        material_revision: material.revision,
        expires_at: FIXED_NOW + Duration::minutes(10),
    });
    let mut tx = uow.tenant(a.ws).await.unwrap();
    tx.studio_control().lock_control().await.unwrap();
    tx.studio_materials()
        .save_intelligence(row.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(a.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials()
            .get_intelligence(material.id)
            .await
            .unwrap(),
        Some(row)
    );
    drop(tx);
    let mut tx = uow.tenant(b.ws).await.unwrap();
    assert!(
        tx.studio_materials()
            .get_intelligence(material.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tx.studio_materials()
            .list_intelligence()
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        tx.studio_materials()
            .save_intelligence(MaterialAnalysisRecord::pending(
                material.id,
                FIXED_NOW,
                DateSource::Unknown
            ))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(tx);
    let mut tx = uow.tenant(a.ws).await.unwrap();
    tx.studio_control().lock_control().await.unwrap();
    tx.studio_materials()
        .delete_intelligence(material.id)
        .await
        .unwrap();
    tx.studio_materials()
        .update_material(material.redacted(FIXED_NOW), material.revision)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(a.ws).await.unwrap();
    assert!(
        tx.studio_materials()
            .get_intelligence(material.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        tx.studio_materials()
            .save_intelligence(MaterialAnalysisRecord::pending(
                material.id,
                FIXED_NOW,
                DateSource::Unknown
            ))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn control_fence_serializes_competing_analysis_claim_decisions() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let mut first = uow.tenant(f.ws).await.unwrap();
    first.studio_control().lock_control().await.unwrap();
    let mut row = MaterialAnalysisRecord::pending(material.id, FIXED_NOW, DateSource::Unknown);
    assert!(row.claimable(FIXED_NOW));
    row.intelligence.status = AnalysisStatus::Running;
    row.lease = Some(MaterialAnalysisLease {
        token_hash: "b".repeat(64),
        owner: AgentConnectionId::new_v7(),
        material_revision: material.revision,
        expires_at: FIXED_NOW + Duration::minutes(10),
    });
    first
        .studio_materials()
        .save_intelligence(row)
        .await
        .unwrap();
    let pool = db.pool.clone();
    let ws = f.ws;
    let id = material.id;
    let (started, wait) = tokio::sync::oneshot::channel();
    let second = tokio::spawn(async move {
        let uow = PgUnitOfWork::new(pool);
        let mut tx = uow.tenant(ws).await.unwrap();
        started.send(()).unwrap();
        tx.studio_control().lock_control().await.unwrap();
        let row = tx
            .studio_materials()
            .get_intelligence(id)
            .await
            .unwrap()
            .unwrap();
        (
            row.claimable(FIXED_NOW),
            row.claimable(FIXED_NOW + Duration::minutes(11)),
        )
    });
    wait.await.unwrap();
    assert!(!second.is_finished());
    first.commit().await.unwrap();
    assert_eq!(second.await.unwrap(), (false, true));
}

#[tokio::test]
async fn intelligence_migration_repeats_up_down_up_and_refuses_data_loss() {
    let db = TestDb::new().await;
    let up = include_str!("../../../../migrations/0029_material_intelligence.up.sql");
    let down = include_str!("../../../../migrations/0029_material_intelligence.down.sql");
    for sql in [up, down, down, up, up] {
        let mut tx = db.pool.begin().await.unwrap();
        sqlx::query("select set_config('app.platform', 'on', true)")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    let forced: bool = sqlx::query_scalar("select relrowsecurity and relforcerowsecurity from pg_class where relname = 'studio_material_intelligence'").fetch_one(&db.pool).await.unwrap();
    assert!(forced);
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_materials()
        .save_intelligence(MaterialAnalysisRecord::pending(
            material.id,
            FIXED_NOW,
            DateSource::Unknown,
        ))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut rollback = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *rollback)
        .await
        .unwrap();
    assert!(
        sqlx::raw_sql(down)
            .execute(&mut *rollback)
            .await
            .unwrap_err()
            .to_string()
            .contains("refusing lossy rollback")
    );
    rollback.rollback().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio_materials()
            .get_intelligence(material.id)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn production_migration_is_repeatable_and_preserves_nonempty_lineage() {
    let db = TestDb::new().await;
    let up = include_str!("../../../../migrations/0030_material_productions.up.sql");
    let down = include_str!("../../../../migrations/0030_material_productions.down.sql");
    for sql in [up, down, down, up, up] {
        let mut tx = db.pool.begin().await.unwrap();
        sqlx::query("select set_config('app.platform', 'on', true)")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    let (ws, _) = db.seed_workspace("production-rollback").await;
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "insert into studio_material_productions(workspace_id,id,revision,data) values($1,$2,1,$3)",
    )
    .bind(ws.0)
    .bind(uuid::Uuid::from_u128(0x3000))
    .bind(serde_json::json!({"production":{"status":"completed"}}))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::raw_sql(down).execute(&mut *tx).await.unwrap_err();
    assert!(error.to_string().contains("refusing lossy rollback"));
    tx.rollback().await.unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.platform', 'on', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "select count(*) from studio_material_productions where workspace_id=$1",
    )
    .bind(ws.0)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
