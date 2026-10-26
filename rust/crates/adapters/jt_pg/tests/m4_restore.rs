use jt_testkit::TestDb;

#[tokio::test]
async fn restore_checks_schema_before_serve() {
    let db = TestDb::new().await;
    jt_pg::recovery::check_schema(&db.pool, true).await.unwrap();
    sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (999999,'future',true,'',0)")
        .execute(&db.pool).await.unwrap();
    assert!(jt_pg::recovery::check_schema(&db.pool, true).await.is_err());
    assert!(jt_pg::migrate_up(&db.pool).await.is_err());
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=999999")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum='' WHERE version=1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(check_schema(&db.pool, true).await, Err(Refused::Schema));
}

use jt_app::{ports::UnitOfWork, usecases::jobs::Job};
use jt_pg::{PgUnitOfWork, PlatformTx, TenantTx, recovery::*};
use jt_seal::AesSecretBox;
use jt_testkit::fakes::FIXED_NOW;
use std::{collections::BTreeMap, sync::Arc};

#[tokio::test]
async fn restore_requires_matching_key_and_files() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("canary").await;
    let key = AesSecretBox::new([1; 32]);
    assert_eq!(verify(&db.pool, &key).await, Err(Refused::Canary));
    seed_canary(&db.pool, ws, &key).await.unwrap();
    verify(&db.pool, &key).await.unwrap();
    assert_eq!(
        verify(&db.pool, &AesSecretBox::new([2; 32])).await,
        Err(Refused::Canary)
    );
    assert_eq!(seed_canary(&db.pool, ws, &key).await, Err(Refused::Canary));
    remove_canary(&db.pool, ws).await.unwrap();
    remove_canary(&db.pool, ws).await.unwrap();
    assert_eq!(verify(&db.pool, &key).await, Err(Refused::Canary));
    seed_canary(&db.pool, ws, &key).await.unwrap();
    verify(&db.pool, &key).await.unwrap();
    sqlx::query("ALTER TABLE payment_notifications NO FORCE ROW LEVEL SECURITY")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(verify(&db.pool, &key).await, Err(Refused::Rls));
}

/// SQL-only logical row copy into a separately migrated ordinary-role database.
/// Preserve every public row, in FK order, including sealed bytes and uncertainty.
async fn copy_public(source: &TestDb, target: &TestDb) {
    check_schema(&source.pool, true).await.unwrap();
    check_schema(&target.pool, true).await.unwrap();
    let mut src = PlatformTx::begin(&source.pool).await.unwrap();
    let mut dst = PlatformTx::begin(&target.pool).await.unwrap();
    let tables: Vec<String> = sqlx::query_scalar("SELECT tablename::text FROM pg_tables WHERE schemaname='public' AND tablename <> '_sqlx_migrations'").fetch_all(src.conn()).await.unwrap();
    let edges: Vec<(String,String)> = sqlx::query_as("SELECT a.relname::text,b.relname::text FROM pg_constraint c JOIN pg_class a ON a.oid=c.conrelid JOIN pg_class b ON b.oid=c.confrelid WHERE c.contype='f' AND c.conrelid<>c.confrelid").fetch_all(src.conn()).await.unwrap();
    let mut pending = BTreeMap::new();
    for table in tables {
        let rows: serde_json::Value = sqlx::query_scalar(&format!(
            "SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM \"{table}\" t"
        ))
        .fetch_one(src.conn())
        .await
        .unwrap();
        if rows != serde_json::json!([]) {
            pending.insert(table, rows);
        }
    }
    while !pending.is_empty() {
        let table = pending
            .keys()
            .find(|table| {
                !edges
                    .iter()
                    .any(|(child, parent)| child == *table && pending.contains_key(parent))
            })
            .expect("acyclic populated FK graph")
            .clone();
        let rows = pending.remove(&table).unwrap();
        sqlx::query(&format!("INSERT INTO \"{table}\" OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::\"{table}\", $1)")).bind(rows).execute(dst.conn()).await.unwrap();
    }
    dst.commit().await.unwrap();
}

#[tokio::test]
async fn logical_restore_preserves_rls_payment_and_ledger() {
    let source = TestDb::new().await;
    let target = TestDb::new().await;
    let mut tx = PlatformTx::begin(&source.pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../scripts/tests/fixtures/recovery/synthetic.up.sql"
    ))
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    copy_public(&source, &target).await;
    check_rls(&target.pool).await.unwrap();
    let no_scope: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_notifications")
        .fetch_one(&target.pool)
        .await
        .unwrap();
    assert_eq!(no_scope, 0);
    for (id, count) in [(1, 1), (2, 0)] {
        let ws = format!("00000000-0000-0000-0000-{id:012}").parse().unwrap();
        let mut tx = TenantTx::begin(&target.pool, ws).await.unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_notifications p JOIN workspace_entitlements e ON e.payment_id=p.id JOIN ledger_entries l ON l.workspace_id=p.workspace_id WHERE e.activated_at IS NOT NULL AND l.action='recovery.synthetic'").fetch_one(tx.conn()).await.unwrap();
        assert_eq!(rows, count);
    }
}

#[tokio::test]
async fn restored_unknown_send_is_not_retried() {
    let source = TestDb::new().await;
    let original = PgUnitOfWork::new(source.pool.clone());
    let f = jt_testkit::studio_contract::ready(&original).await;
    let mut repos = original.tenant(f.ws).await.unwrap();
    let attempt = repos
        .studio()
        .claim_publication_for(f.slot.id, FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    repos
        .studio()
        .finish_publication(
            attempt.id(),
            jt_app::ports::studio::PublishOutcome::Unknown(jt_app::error::AppError::internal(
                "uncertain send",
            )),
            FIXED_NOW,
        )
        .await
        .unwrap();
    repos.commit().await.unwrap();
    let restored = TestDb::new().await;
    copy_public(&source, &restored).await;
    let uow = Arc::new(PgUnitOfWork::new(restored.pool.clone()));
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let provider = Arc::new(jt_testkit::fakes::ScriptedConnector::new(
        jt_connector::Provider::X,
    ));
    deps.connectors =
        Arc::new(jt_testkit::fakes::ScriptedRegistry::new().with_connector(provider.clone()));
    for job in [
        Job::StudioPublishRecover,
        Job::StudioPublish,
        Job::OutboxRecover,
    ] {
        let report = job.run(&deps, FIXED_NOW).await;
        assert_eq!(report.failed, 0, "{job:?}");
        assert_eq!(report.changed, 0, "{job:?}");
    }
    assert!(
        provider.calls().is_empty(),
        "restored uncertainty must not call the provider"
    );
    let mut repos = uow.tenant(f.ws).await.unwrap();
    assert!(
        repos
            .studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .is_none()
    );
    let evidence = repos.studio().slot_evidence(f.slot.id).await.unwrap().0;
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].id(), attempt.id());
    assert_eq!(evidence[0].state(), jt_studio::PublishState::Unknown);
}

#[tokio::test]
async fn wal_probe_publishes_only_confirmed_archive_success() {
    use jt_pg::wal::{ArchiverState, publish};
    let root = std::env::temp_dir().join(format!("jeeta-wal-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir(&root).unwrap();
    let segment = "000000010000000000000001";
    let mut state = ArchiverState {
        last_archived_wal: Some(segment.into()),
        last_archived_time: Some(FIXED_NOW),
        last_failed_time: None,
    };
    assert!(publish(&state, &root, &root, FIXED_NOW).await.is_err());
    assert!(!root.join("wal-status.json").exists());
    std::fs::write(root.join(segment), b"synthetic WAL segment").unwrap();
    publish(&state, &root, &root, FIXED_NOW).await.unwrap();
    let before = std::fs::read(root.join("wal-status.json")).unwrap();
    state.last_failed_time = Some(FIXED_NOW + time::Duration::seconds(1));
    assert!(
        publish(&state, &root, &root, FIXED_NOW + time::Duration::seconds(2))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(root.join("wal-status.json")).unwrap(), before);
    state.last_failed_time = None;
    std::fs::remove_file(root.join(segment)).unwrap();
    assert!(publish(&state, &root, &root, FIXED_NOW).await.is_err());
    assert_eq!(std::fs::read(root.join("wal-status.json")).unwrap(), before);
    state.last_archived_wal = Some("../wal-status.json".into());
    assert!(publish(&state, &root, &root, FIXED_NOW).await.is_err());
    state.last_archived_wal = Some(segment.into());
    std::fs::write(root.join(segment), b"WAL").unwrap();
    state.last_archived_time = Some(FIXED_NOW + time::Duration::seconds(1));
    assert!(publish(&state, &root, &root, FIXED_NOW).await.is_err());
    std::fs::remove_dir_all(root).unwrap();
}
