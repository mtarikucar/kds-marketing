//! Inbox migration constraints, backfills and tenant isolation against real PostgreSQL.

use jt_pg::{PlatformTx, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use uuid::Uuid;

const UP: &str = include_str!("../../../../migrations/0006_inbox.up.sql");
const DOWN: &str = include_str!("../../../../migrations/0006_inbox.down.sql");
const TABLES: &[&str] = &[
    "people",
    "identities",
    "conversations",
    "messages",
    "journeys",
    "journey_events",
    "tasks",
    "notes",
    "merges",
    "lost_reasons",
    "event_consumption",
    "outbox",
    "request_keys",
];

async fn person(db: &TestDb, ws: WorkspaceId) -> Uuid {
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into people (id, workspace_id, first_touch, created_at, updated_at) values ($1, $2, '{\"source\":\"import\"}', now(), now())")
        .bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    id
}

async fn journey(db: &TestDb, ws: WorkspaceId, person: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into journeys (id, workspace_id, person_id, opened_at, source, updated_at) values ($1, $2, $3, now(), '\"import\"', now())")
        .bind(id).bind(ws.as_uuid()).bind(person).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    id
}

#[tokio::test]
async fn identity_unique_among_active_rows() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("identity").await;
    let p = person(&db, ws).await;
    let insert = "insert into identities (id, workspace_id, person_id, channel, value_normalized, active, first_seen_at) values ($1, $2, $3, 'phone', '+905550000000', $4, now())";
    // Inactive tombstones do not block a live key; only two active copies conflict.
    for active in [false, false, true] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        sqlx::query(insert)
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(p)
            .bind(active)
            .execute(tx.conn())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(p)
        .bind(true)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn one_open_journey_per_person_index() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("journey").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query("insert into journeys (id, workspace_id, person_id, opened_at, source, updated_at) values ($1, $2, $3, now(), '\"repeat\"', now())")
        .bind(Uuid::now_v7()).bind(ws.as_uuid()).bind(p).execute(tx.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "update journeys set closed_at = now(), status = 'won' where workspace_id = $1 and id = $2",
    )
    .bind(ws.as_uuid())
    .bind(j)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_ne!(journey(&db, ws, p).await, j);
}

#[tokio::test]
async fn journey_events_append_only() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("events").await;
    let p = person(&db, ws).await;
    let j = journey(&db, ws, p).await;
    let insert = "insert into journey_events (id, workspace_id, journey_id, source, idempotency_key, payload, at, from_status, to_status) values ($1, $2, $3, '\"system\"', 'key', '\"message_received\"', now(), 'new', 'new')";
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(j)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for sql in [
        "update journey_events set payload = '{}'",
        "delete from journey_events",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let err = sqlx::query(sql).execute(tx.conn()).await.unwrap_err();
        assert!(err.to_string().contains("append-only"));
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let err = sqlx::query(insert)
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(j)
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn inbox_force_rls_and_composite_foreign_keys() {
    let db = TestDb::new().await;
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let p = person(&db, a).await;
    for table in TABLES {
        let flags: (bool, bool) = sqlx::query_as(
            "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(flags, (true, true), "{table}");
        let count: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{table} visible without scope");
    }
    let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
    let count: i64 = sqlx::query_scalar("select count(*) from people")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
    // Platform scope bypasses RLS, so only the composite FK can reject this reference.
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query("insert into identities (id, workspace_id, person_id, channel, value_normalized, first_seen_at) values ($1,$2,$3,'phone','+905550000000',now())")
        .bind(Uuid::now_v7()).bind(b.as_uuid()).bind(p).execute(tx.conn()).await.unwrap_err();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn schema_down_drops_lost_reasons() {
    let db = TestDb::new().await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let (ws, _) = db.seed_workspace("existing").await;
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let keys: Vec<String> =
        sqlx::query_scalar("select key from lost_reasons where active and seeded order by key")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    assert_eq!(
        keys,
        ["diger", "fiyat", "ilgisiz", "rakip", "ulasilamadi", "zaman"]
    );
    sqlx::query("update lost_reasons set label = 'Edited', active = false where key = 'fiyat'")
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let row: (String, bool) =
        sqlx::query_as("select label, active from lost_reasons where key = 'fiyat'")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(row, ("Edited".into(), false));
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    }
    let exists: bool = sqlx::query_scalar("select to_regclass('lost_reasons') is not null")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn role_backfill_is_idempotent_reversible_and_preserves_custom_grants() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("roles").await;
    sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into roles (id, workspace_id, key, name, permissions, is_system) values ($1,$2,'custom','Custom',array['inbox.work','inbox.manage'],false)")
        .bind(Uuid::now_v7()).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let roles: Vec<(String, Vec<String>)> =
        sqlx::query_as("select key, permissions from roles order by key")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    for (key, permissions) in roles {
        assert_eq!(
            permissions.iter().filter(|p| *p == "inbox.work").count(),
            1,
            "{key}"
        );
        assert_eq!(
            permissions.iter().filter(|p| *p == "inbox.manage").count(),
            usize::from(key != "rep"),
            "{key}"
        );
    }
    tx.commit().await.unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let roles: Vec<(bool, Vec<String>)> =
        sqlx::query_as("select is_system, permissions from roles")
            .fetch_all(tx.conn())
            .await
            .unwrap();
    for (system, permissions) in roles {
        assert_eq!(permissions.contains(&"inbox.work".into()), !system);
        assert_eq!(permissions.contains(&"inbox.manage".into()), !system);
    }
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn call_lookup_index_round_trip_is_idempotent() {
    let db = TestDb::new().await;
    let exists = "select to_regclass('inbound_events_call_lookup') is not null";
    assert!(
        sqlx::query_scalar::<_, bool>(exists)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    );
    for _ in 0..2 {
        sqlx::raw_sql(DOWN).execute(&db.pool).await.unwrap();
        assert!(
            !sqlx::query_scalar::<_, bool>(exists)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
    }
    for _ in 0..2 {
        sqlx::raw_sql(UP).execute(&db.pool).await.unwrap();
        assert!(
            sqlx::query_scalar::<_, bool>(exists)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        );
    }
}
