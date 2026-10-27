//! Real, non-bypass-RLS Studio persistence contracts.
use jt_app::ports::UnitOfWork;
use jt_pg::PgUnitOfWork;
use jt_testkit::TestDb;

#[tokio::test]
async fn studio_schema_exact_table_delta() {
    let db = TestDb::new().await;
    let tables: Vec<String> = sqlx::query_scalar("select tablename from pg_tables where schemaname='public' and tablename like 'studio_%' order by tablename").fetch_all(&db.pool).await.unwrap();
    assert_eq!(
        tables,
        [
            "studio_adset_bindings",
            "studio_arms",
            "studio_budget_moves",
            "studio_control",
            "studio_files",
            "studio_learning_applications",
            "studio_measurements",
            "studio_pieces",
            "studio_publications",
            "studio_publish_attempts",
            "studio_request_keys",
            "studio_slots",
            "studio_spend_reservations",
            "studio_trends"
        ]
    );
    let count: i64 = sqlx::query_scalar("select count(*) from pg_tables where schemaname='public' and tablename <> '_sqlx_migrations'").fetch_one(&db.pool).await.unwrap();
    assert_eq!(count, 48 + 14 + 5);
}

#[tokio::test]
async fn control_is_durable_and_tenant_scoped() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("studio-control").await;
    let (other, _) = db.seed_workspace("studio-other").await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let mut tx = uow.tenant(ws).await.unwrap();
    let control = tx.studio_control().lock_control().await.unwrap();
    assert!(!control.brake_engaged);
    tx.studio_control()
        .set_brake(control.revision, None, true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(ws).await.unwrap();
    assert!(
        tx.studio_control()
            .lock_control()
            .await
            .unwrap()
            .brake_engaged
    );
    drop(tx);
    let mut tx = uow.tenant(other).await.unwrap();
    assert!(
        !tx.studio_control()
            .lock_control()
            .await
            .unwrap()
            .brake_engaged
    );
}

#[tokio::test]
async fn request_key_payload_mismatch_conflicts() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::request_key_payload_mismatch_conflicts(&uow).await;
}

#[tokio::test]
async fn studio_transaction_rollback_preserves_unstarted_claim() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::studio_transaction_rollback_preserves_unstarted_claim(&uow).await;
}

#[tokio::test]
async fn arm_identity_survives_version_change() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::arm_identity_survives_version_change(&uow).await;
}

#[tokio::test]
async fn concurrent_claim_has_one_owner() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::concurrent_claim_has_one_owner(&uow).await;
}

#[tokio::test]
async fn measurement_and_learning_dedupe() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::measurement_and_learning_dedupe(&uow).await;
}

#[tokio::test]
async fn files_trends_moves_and_retirement_round_trip() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::files_trends_moves_and_retirement_round_trip(&uow).await;
}

#[tokio::test]
async fn accepted_publish_response_lost_never_blindly_retries() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::accepted_publish_response_lost_never_blindly_retries(&uow).await;
}

const UP: &str = include_str!("../../../../migrations/0009_studio.up.sql");
const DOWN: &str = include_str!("../../../../migrations/0009_studio.down.sql");
#[tokio::test]
async fn studio_rls_and_composite_fks_reject_cross_tenant() {
    use jt_pg::TenantTx;
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let a = jt_testkit::studio_contract::ready(&uow).await;
    let b = jt_testkit::studio_contract::ready(&uow).await;
    let tables: Vec<String> = sqlx::query_scalar(
        "select tablename from pg_tables where schemaname='public' and tablename like 'studio_%'",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(tables.len(), 14);
    for table in tables {
        let forced: bool = sqlx::query_scalar(
            "select relrowsecurity and relforcerowsecurity from pg_class where relname=$1",
        )
        .bind(&table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(forced, "{table}");
        let count: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "unscoped {table}");
        let mut tx = TenantTx::begin(&db.pool, b.ws).await.unwrap();
        let count: i64 = sqlx::query_scalar(&format!(
            "select count(*) from {table} where workspace_id=$1"
        ))
        .bind(a.ws.0)
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert_eq!(count, 0, "cross tenant {table}");
    }
    let mut tx = TenantTx::begin(&db.pool, a.ws).await.unwrap();
    let err = sqlx::query("insert into studio_control(workspace_id,data) values($1,'{}')")
        .bind(jt_tenancy::WorkspaceId::new_v7().0)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    drop(tx);
    for (born, hyp, arm, cap) in [
        (
            a.slot.chain.born_version_id,
            a.slot.chain.hypothesis_id,
            a.arm.id,
            b.slot.capability_id,
        ),
        (
            b.slot.chain.born_version_id,
            b.slot.chain.hypothesis_id,
            a.arm.id,
            a.slot.capability_id,
        ),
        (
            a.slot.chain.born_version_id,
            a.slot.chain.hypothesis_id,
            b.arm.id,
            a.slot.capability_id,
        ),
    ] {
        let mut tx = TenantTx::begin(&db.pool, a.ws).await.unwrap();
        let err=sqlx::query("insert into studio_slots(workspace_id,id,data,born_version_id,hypothesis_id,arm_id,capability_id,scheduled_at,state,revision,run_key,ordinal) values($1,$2,'{}',$3,$4,$5,$6,now(),'planned',0,'cross',0)")
            .bind(a.ws.0).bind(uuid::Uuid::now_v7()).bind(born.0).bind(hyp.0).bind(arm.0).bind(cap.0).execute(tx.conn()).await.unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
}
async fn roles(pool: &sqlx::PgPool, ws: jt_tenancy::WorkspaceId) -> Vec<(String, Vec<String>)> {
    let mut tx = jt_pg::PlatformTx::begin(pool).await.unwrap();
    let mut rows: Vec<(String, Vec<String>)> = sqlx::query_as(
        "select key,permissions from roles where workspace_id=$1 and is_system order by key",
    )
    .bind(ws.0)
    .fetch_all(tx.conn())
    .await
    .unwrap();
    for (_, p) in &mut rows {
        p.sort();
    }
    rows
}
#[tokio::test]
async fn studio_role_backfill_new_workspace_parity() {
    let db = TestDb::new().await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (old, _) = db.seed_workspace("old-studio").await;
    let mut tx = jt_pg::PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("update roles set permissions=array_remove(array_remove(permissions,'studio.work'),'studio.manage') where workspace_id=$1").bind(old.0).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    let (new, _) = db.seed_workspace("new-studio").await;
    assert_eq!(roles(&db.pool, old).await, roles(&db.pool, new).await);
    for (key, perms) in roles(&db.pool, old).await {
        for permission in ["studio.work", "studio.manage"] {
            assert_eq!(perms.iter().any(|p| p == permission), key != "rep");
        }
    }
}
#[tokio::test]
async fn studio_backfill_down_preserves_existing_grants() {
    let db = TestDb::new().await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (ws, _) = db.seed_workspace("grants").await;
    let mut tx = jt_pg::PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("update roles set permissions=array_remove(permissions,'studio.manage') where workspace_id=$1 and key='manager'").bind(ws.0).execute(tx.conn()).await.unwrap();
    sqlx::query("update roles set permissions=array_remove(array_remove(permissions,'studio.work'),'studio.manage') where workspace_id=$1 and key='owner'").bind(ws.0).execute(tx.conn()).await.unwrap();
    let sentinel = uuid::Uuid::now_v7();
    sqlx::query("insert into people(id,workspace_id,display_name,first_touch,created_at,updated_at) values($1,$2,'sentinel','{}',now(),now())").bind(sentinel).bind(ws.0).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let before = roles(&db.pool, ws).await;
    for sql in [UP, UP, DOWN, DOWN] {
        sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
    }
    assert_eq!(roles(&db.pool, ws).await, before);
    let mut tx = jt_pg::TenantTx::begin(&db.pool, ws).await.unwrap();
    let name: String =
        sqlx::query_scalar("select display_name from people where workspace_id=$1 and id=$2")
            .bind(ws.0)
            .bind(sentinel)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(name, "sentinel");
    drop(tx);
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    for (key, p) in roles(&db.pool, ws).await {
        if key != "rep" {
            assert!(p.contains(&"studio.work".into()) && p.contains(&"studio.manage".into()));
        }
    }
}

#[tokio::test]
async fn budget_price_and_hypothesis_fields_round_trip() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::budget_price_and_hypothesis_fields_round_trip(&uow).await;
}

#[tokio::test]
async fn preopened_claim_uses_current_strategy() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::preopened_claim_uses_current_strategy(&uow).await;
}

#[tokio::test]
async fn reservations_are_atomic_and_settlement_is_idempotent() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::reservations_are_atomic_and_settlement_is_idempotent(&uow).await;
}

#[tokio::test]
async fn preopened_reservation_reads_current_cap() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::preopened_reservation_reads_current_cap(&uow).await;
}

#[tokio::test]
async fn agent_inherits_issuer_scope_rep_has_no_studio_grants() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::agent_inherits_issuer_scope_rep_has_no_studio_grants(
        std::sync::Arc::new(uow),
    )
    .await;
}

#[tokio::test]
async fn reservation_replay_after_archive() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::reservation_replay_after_archive(&uow).await;
}

#[tokio::test]
async fn outcome_categories_survive_redaction() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::outcome_categories_survive_redaction(&uow).await;
}

#[tokio::test]
async fn failure_reason_is_kept_beside_the_category() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::failure_reason_is_kept_beside_the_category(&uow).await;
}

#[tokio::test]
async fn completion_time_differs_from_claim_time() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    let ws = jt_testkit::studio_contract::completion_time_differs_from_claim_time(&uow).await;
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("select set_config('app.workspace_id',$1,true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let data: serde_json::Value =
        sqlx::query_scalar("select data from studio_publications where external_id='delayed'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let p: jt_app::ports::studio::Publication = serde_json::from_value(data).unwrap();
    assert_eq!(
        p.published_at,
        jt_testkit::fakes::FIXED_NOW + time::Duration::hours(2)
    );
}

#[tokio::test]
async fn liability_uses_each_item_period() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::liability_uses_each_item_period(&uow).await;
}

#[tokio::test]
async fn binding_refresh_invalidates_old_intents() {
    let db = jt_testkit::TestDb::new().await;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    jt_testkit::studio_contract::binding_refresh_invalidates_old_intents(&uow).await;
}
