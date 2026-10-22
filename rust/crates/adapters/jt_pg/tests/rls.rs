//! Row-level security: a tenant transaction sees and writes only its own workspace's rows.

use jt_pg::{PlatformTx, TenantTx};
use jt_testkit::TestDb;
use uuid::Uuid;

#[tokio::test]
async fn the_app_role_is_not_a_superuser_and_cannot_bypass_rls() {
    let db = TestDb::new().await;
    let bypass: bool = sqlx::query_scalar(
        "select rolsuper or rolbypassrls from pg_roles where rolname = current_user",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(!bypass, "RLS tests must run as a role that RLS binds");
}

#[tokio::test]
async fn tenant_tx_sees_only_its_workspace() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from roles")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 3); // only a's three system roles
    let n: i64 = sqlx::query_scalar("select count(*) from workspaces")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 1);
    let seen: Uuid = sqlx::query_scalar("select id from workspaces")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(seen, a.as_uuid());
    let n: i64 = sqlx::query_scalar("select count(*) from memberships")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 1);
    tx.rollback().await.unwrap();

    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from roles")
        .fetch_one(p.conn())
        .await
        .unwrap();
    assert_eq!(n, 6);
    let n: i64 = sqlx::query_scalar("select count(*) from workspaces where id = $1")
        .bind(b.as_uuid())
        .fetch_one(p.conn())
        .await
        .unwrap();
    assert_eq!(n, 1);
    p.rollback().await.unwrap();
}

#[tokio::test]
async fn tenant_tx_cannot_insert_for_another_workspace() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let insert_role = "insert into roles (id, workspace_id, key, name, permissions) \
                       values ($1, $2, $3, 'Custom', array['workspace.read'])";

    // Control: its own workspace is accepted.
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    sqlx::query(insert_role)
        .bind(Uuid::now_v7())
        .bind(a.as_uuid())
        .bind("custom_a")
        .execute(tx.conn())
        .await
        .unwrap();

    let err = sqlx::query(insert_role)
        .bind(Uuid::now_v7())
        .bind(b.as_uuid())
        .bind("custom_b")
        .execute(tx.conn())
        .await
        .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("42501"), "{db_err}");
    assert!(db_err.message().contains("row-level security"), "{db_err}");
    tx.rollback().await.unwrap();

    // Nor can it move one of its rows into another workspace.
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let err = sqlx::query("update roles set workspace_id = $1 where key = 'rep'")
        .bind(b.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("row-level security"), "{err}");
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn without_setting_no_rows_are_visible() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;

    // A tenant transaction on the pool leaves `app.workspace_id` reset to '' on its connection.
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from roles")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 3);
    tx.commit().await.unwrap();

    for table in [
        "roles",
        "memberships",
        "api_keys",
        "agent_connections",
        "ledger_entries",
        "workspaces",
    ] {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is visible without a workspace in scope");
    }
}

#[tokio::test]
async fn ledger_is_append_only() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;

    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query(
        "insert into ledger_entries (workspace_id, at, actor_kind, actor_component, action) \
         values ($1, now(), 'system', 'test', 'test.append')",
    )
    .bind(a.as_uuid())
    .execute(p.conn())
    .await
    .unwrap();
    p.commit().await.unwrap();

    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query("update ledger_entries set action = 'test.changed'")
        .execute(p.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");
    p.rollback().await.unwrap();

    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query("delete from ledger_entries")
        .execute(p.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"), "{err}");
    p.rollback().await.unwrap();

    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let action: String = sqlx::query_scalar("select action from ledger_entries")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(action, "test.append");
    tx.rollback().await.unwrap();
}
