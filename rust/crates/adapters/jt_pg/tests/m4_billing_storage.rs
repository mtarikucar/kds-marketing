//! Durable billing storage, ordinary-role RLS and rollback contracts.
use jt_testkit::TestDb;

#[tokio::test]
async fn billing_tables_force_rls() {
    let db = TestDb::new().await;
    let rows: Vec<(String, bool, bool)> = sqlx::query_as("select relname::text, relrowsecurity, relforcerowsecurity from pg_class where relname in ('payment_notifications','workspace_entitlements','workspace_billing','activation_codes') order by relname")
        .fetch_all(&db.pool).await.unwrap();
    assert_eq!(
        rows,
        [
            "activation_codes",
            "payment_notifications",
            "workspace_billing",
            "workspace_entitlements"
        ]
        .map(|s| (s.to_owned(), true, true))
    );
}
#[tokio::test]
async fn request_key_unique_per_workspace() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::request_key_unique_per_workspace(&jt_pg::PgUnitOfWork::new(
        db.pool.clone(),
    ))
    .await;
}
#[tokio::test]
async fn paid_and_grandfathered_provenance_constraints() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::paid_and_grandfathered_provenance_constraints(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
#[tokio::test]
async fn one_open_grant_preserves_closed_history() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::one_open_grant_preserves_closed_history(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
#[tokio::test]
async fn workspace_status_reason_actor_is_atomic() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::workspace_status_reason_actor_is_atomic(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
#[tokio::test]
async fn activation_challenge_attempts_replay_and_reissue() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::activation_challenge_attempts_replay_and_reissue(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
#[tokio::test]
async fn stable_reference_and_masked_debug() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::stable_reference_and_masked_debug(&jt_pg::PgUnitOfWork::new(
        db.pool.clone(),
    ))
    .await;
}

use jt_app::ports::UnitOfWork;
use jt_pg::{PgUnitOfWork, PlatformTx, TenantTx};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::billing_contract::{code, fixture, grant, seed};
use uuid::Uuid;

const BILLING_UP: &str = include_str!("../../../../migrations/0010_m4_billing.up.sql");
const BILLING_DOWN: &str = include_str!("../../../../migrations/0010_m4_billing.down.sql");
const CODES_UP: &str = include_str!("../../../../migrations/0011_m4_activation_codes.up.sql");
const CODES_DOWN: &str = include_str!("../../../../migrations/0011_m4_activation_codes.down.sql");
const BACKFILL_UP: &str =
    include_str!("../../../../migrations/0012_m4_grandfathered_backfill.up.sql");
const BACKFILL_DOWN: &str =
    include_str!("../../../../migrations/0012_m4_grandfathered_backfill.down.sql");
async fn run(db: &TestDb, sql: &str) {
    sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
}
async fn count(db: &TestDb, table: &str) -> i64 {
    let mut t = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query_scalar(&format!("select count(*) from {table}"))
        .fetch_one(t.conn())
        .await
        .unwrap()
}
async fn schema(db: &TestDb) -> Vec<(String, String, String)> {
    sqlx::query_as("select table_name,column_name,data_type from information_schema.columns where table_schema='public' order by table_name,ordinal_position").fetch_all(&db.pool).await.unwrap()
}
#[tokio::test]
async fn billing_rls_and_composite_fk_reject_other_workspace() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let a = fixture(&uow).await;
    let b = fixture(&uow).await;
    let (p, e) = seed(&uow, &a).await;
    let mut t = uow.tenant(a.ws).await.unwrap();
    t.billing().reference_get_or_create().await.unwrap();
    t.activation_codes().insert(code(&a, &e)).await.unwrap();
    t.commit().await.unwrap();
    let bypass: bool = sqlx::query_scalar(
        "select rolsuper or rolbypassrls from pg_roles where rolname=current_user",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!bypass);
    for table in [
        "payment_notifications",
        "workspace_entitlements",
        "workspace_billing",
        "activation_codes",
    ] {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "unscoped {table}");
        let mut t = TenantTx::begin(&db.pool, b.ws).await.unwrap();
        let n: i64 = sqlx::query_scalar(&format!(
            "select count(*) from {table} where workspace_id=$1"
        ))
        .bind(a.ws.0)
        .fetch_one(t.conn())
        .await
        .unwrap();
        assert_eq!(n, 0, "cross read {table}");
        drop(t);
        let mut t = TenantTx::begin(&db.pool, a.ws).await.unwrap();
        let err = sqlx::query(&format!(
            "update {table} set workspace_id=$1 where workspace_id=$2"
        ))
        .bind(b.ws.0)
        .bind(a.ws.0)
        .execute(t.conn())
        .await
        .unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "cross write {table}"
        );
    }
    let mut t = TenantTx::begin(&db.pool, b.ws).await.unwrap();
    let err=sqlx::query("insert into workspace_entitlements(id,workspace_id,source,payment_id,confirmed_by,confirmed_at) values($1,$2,'paid',$3,$4,now())").bind(Uuid::now_v7()).bind(b.ws.0).bind(p.id.0).bind(b.operator.0).execute(t.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    drop(t);
    let mut t = TenantTx::begin(&db.pool, b.ws).await.unwrap();
    let err=sqlx::query("insert into activation_codes(id,workspace_id,entitlement_id,action,digest,issued_by,created_at,expires_at) values($1,$2,$3,'billing.activate',$4,$5,now(),now()+interval '72 hours')").bind(Uuid::now_v7()).bind(b.ws.0).bind(e.id.0).bind(vec![0u8;32]).bind(b.operator.0).execute(t.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
}
#[tokio::test]
async fn billing_migration_up_down_up_and_repeated_down() {
    let db = TestDb::new().await;
    let original = schema(&db).await;
    for sql in [
        BACKFILL_DOWN,
        BACKFILL_DOWN,
        CODES_DOWN,
        CODES_DOWN,
        BILLING_DOWN,
        BILLING_DOWN,
        BILLING_UP,
        BILLING_UP,
        CODES_UP,
        CODES_UP,
        BACKFILL_UP,
        BACKFILL_UP,
    ] {
        run(&db, sql).await;
    }
    assert_eq!(schema(&db).await, original);
    assert_eq!(count(&db, "workspace_entitlements").await, 0);
}
#[tokio::test]
async fn billing_down_refuses_live_rows_without_changes() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = fixture(&uow).await;
    let (_, e) = seed(&uow, &f).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.billing().reference_get_or_create().await.unwrap();
    t.activation_codes().insert(code(&f, &e)).await.unwrap();
    t.commit().await.unwrap();
    let before = schema(&db).await;
    for sql in [CODES_DOWN, BILLING_DOWN] {
        let err = sqlx::raw_sql(sql).execute(&db.pool).await.unwrap_err();
        assert!(
            err.as_database_error()
                .unwrap()
                .message()
                .contains("billing rollback refused")
        );
        assert_eq!(schema(&db).await, before);
    }
    for table in [
        "workspace_entitlements",
        "payment_notifications",
        "workspace_billing",
        "activation_codes",
    ] {
        assert_eq!(count(&db, table).await, 1);
    }
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.billing().entitlement().await.unwrap(), Some(e));
}
#[tokio::test]
async fn grandfathered_backfill_up_down_up() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let active = fixture(&uow).await;
    let pending = fixture(&uow).await;
    let suspended = fixture(&uow).await;
    let existing = fixture(&uow).await;
    let (_, preexisting) = seed(&uow, &existing).await;
    let by = jt_ledger::Actor::System {
        component: "fixture".into(),
    };
    let mut t = uow.platform().await.unwrap();
    for f in [&active, &existing] {
        t.workspace_set_status(f.ws, WorkspaceStatus::Active, "fixture activation", &by)
            .await
            .unwrap();
    }
    t.workspace_set_status(
        suspended.ws,
        WorkspaceStatus::Suspended,
        "fixture hold",
        &by,
    )
    .await
    .unwrap();
    t.commit().await.unwrap();
    let mut fixed = None;
    for _ in 0..2 {
        run(&db, BACKFILL_UP).await;
        run(&db, BACKFILL_UP).await;
        assert_eq!(count(&db, "m4_grandfathered_manifest").await, 1);
        let mut t = uow.platform().await.unwrap();
        let row = t.entitlement_get(active.ws).await.unwrap().unwrap();
        assert_eq!(
            row.source,
            jt_app::ports::billing::EntitlementSource::Grandfathered
        );
        assert!(row.activated_at.is_some());
        assert!(row.payment_id.is_none());
        assert!(row.confirmed_by.is_none());
        assert!(row.redeemed_by.is_none());
        if let Some(id) = fixed {
            assert_eq!(row.id, id);
        } else {
            fixed = Some(row.id);
        }
        assert!(t.entitlement_get(pending.ws).await.unwrap().is_none());
        assert!(t.entitlement_get(suspended.ws).await.unwrap().is_none());
        assert_eq!(
            t.entitlement_get(existing.ws).await.unwrap(),
            Some(preexisting.clone())
        );
        drop(t);
        run(&db, BACKFILL_DOWN).await;
        run(&db, BACKFILL_DOWN).await;
        assert_eq!(count(&db, "m4_grandfathered_manifest").await, 0);
        assert_eq!(count(&db, "workspace_entitlements").await, 1);
        let mut t = uow.platform().await.unwrap();
        assert_eq!(
            t.workspace_get(active.ws).await.unwrap().unwrap().status,
            WorkspaceStatus::Active
        );
        assert_eq!(
            t.entitlement_get(existing.ws).await.unwrap(),
            Some(preexisting.clone())
        );
    }
}
#[tokio::test]
async fn grandfathered_down_preserves_edited_revoked_and_runtime_rows() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let edited = fixture(&uow).await;
    let revoked = fixture(&uow).await;
    let history = fixture(&uow).await;
    let challenge = fixture(&uow).await;
    let untouched = fixture(&uow).await;
    let by = jt_ledger::Actor::System {
        component: "fixture".into(),
    };
    for f in [&edited, &revoked, &history, &challenge, &untouched] {
        let mut t = uow.platform().await.unwrap();
        t.workspace_set_status(f.ws, WorkspaceStatus::Active, "fixture", &by)
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    run(&db, BACKFILL_UP).await;
    let mut t = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("update workspace_entitlements set activated_at=activated_at+interval '1 second' where workspace_id=$1").bind(edited.ws.0).execute(t.conn()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.platform().await.unwrap();
    let old = t.entitlement_get(revoked.ws).await.unwrap().unwrap();
    t.entitlement_revoke(
        revoked.ws,
        old.id,
        jt_testkit::fakes::FIXED_NOW,
        "revoke synthetic",
    )
    .await
    .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.platform().await.unwrap();
    t.workspace_set_status(
        history.ws,
        WorkspaceStatus::Suspended,
        "operator review",
        &by,
    )
    .await
    .unwrap();
    t.commit().await.unwrap();
    let mut t = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into activation_codes(id,workspace_id,entitlement_id,action,digest,issued_by,created_at,expires_at,consumed_at,redeemed_by) select $1,workspace_id,id,'billing.activate',$2,$3,now(),now()+interval '72 hours',now(),$4 from workspace_entitlements where workspace_id=$5").bind(Uuid::now_v7()).bind(vec![1u8;32]).bind(challenge.operator.0).bind(challenge.user.0).bind(challenge.ws.0).execute(t.conn()).await.unwrap();
    t.commit().await.unwrap();
    run(&db, BACKFILL_DOWN).await;
    run(&db, BACKFILL_DOWN).await;
    assert_eq!(count(&db, "workspace_entitlements").await, 4);
    assert_eq!(count(&db, "m4_grandfathered_manifest").await, 4);
    assert_eq!(count(&db, "activation_codes").await, 1);
    let mut t = uow.platform().await.unwrap();
    assert!(t.entitlement_get(untouched.ws).await.unwrap().is_none());
    assert_eq!(
        t.workspace_get(history.ws).await.unwrap().unwrap().status,
        WorkspaceStatus::Suspended
    );
    drop(t);
    let before = schema(&db).await;
    assert!(sqlx::raw_sql(BILLING_DOWN).execute(&db.pool).await.is_err());
    assert_eq!(schema(&db).await, before);
}
#[tokio::test]
async fn closed_grant_and_payment_remain_durable() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = fixture(&uow).await;
    let (p, e) = seed(&uow, &f).await;
    let mut t = uow.platform().await.unwrap();
    t.entitlement_revoke(
        f.ws,
        e.id,
        jt_testkit::fakes::FIXED_NOW,
        "refund out of band",
    )
    .await
    .unwrap();
    t.entitlement_insert(grant(&f, &p)).await.unwrap();
    t.commit().await.unwrap();
    assert_eq!(count(&db, "workspace_entitlements").await, 2);
    assert_eq!(count(&db, "payment_notifications").await, 1);
    let mut t = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let row: (Option<time::OffsetDateTime>, String) = sqlx::query_as(
        "select revoked_at,reason from workspace_entitlements where workspace_id=$1 and id=$2",
    )
    .bind(f.ws.0)
    .bind(e.id.0)
    .fetch_one(t.conn())
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            Some(jt_testkit::fakes::FIXED_NOW),
            "refund out of band".into()
        )
    );
}
#[tokio::test]
async fn workspace_lock_serializes_grants_and_references() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::workspace_lock_serializes_grants_and_references(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
#[tokio::test]
async fn challenge_expiry_and_tenant_references_are_enforced() {
    let db = TestDb::new().await;
    jt_testkit::billing_contract::challenge_expiry_and_tenant_references_are_enforced(
        &jt_pg::PgUnitOfWork::new(db.pool.clone()),
    )
    .await;
}
