//! Migrations are reversible pairs, and the whole set round-trips up → down → up.

use std::path::{Path, PathBuf};

use jt_pg::PlatformTx;
use jt_testkit::TestDb;
use sqlx::PgPool;
use uuid::Uuid;

/// Tables in `public`, sqlx's own bookkeeping table excluded.
async fn table_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_tables where schemaname = 'public' and tablename <> '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Tables after `0001_foundation`.
const TABLES_AFTER_FOUNDATION: i64 = 10;
/// Tables after `0002_strategy`, which adds `strategy_versions`, `strategy_hypotheses` and
/// `consultation_entries`.
const TABLES_AFTER_STRATEGY: i64 = 13;
/// Tables after `0003_capabilities`, which adds `capabilities`, `capability_groups`,
/// `capability_group_members`, `budget_items`, `capability_budget_links`,
/// `budget_spend_entries` and `workspace_policies`; `0004_role_permissions_backfill` adds none.
const TABLES_AFTER_CAPABILITIES: i64 = 20;
/// Tables after `0005_connectors`, which adds `inbound_events`, `oauth_pending` and
/// `probe_runs`.
const TABLES_AFTER_CONNECTORS: i64 = 23;
/// Tables after `0006_inbox`, including outbox and request keys.
const TABLES_AFTER_ALL: i64 = 36;

/// The migrations there are: `0001_foundation` to `0006_inbox`.
const MIGRATIONS: i64 = 6;

/// The index `0004_role_permissions_backfill` adds for the check-in lookup.
const CHECKIN_INDEX: &str = "ledger_entries_agent_connection_idx";

/// The trigger functions `0005_connectors` adds.
const CONNECTOR_FUNCTIONS: [&str; 2] = ["inbound_events_guard", "probe_runs_immutable"];

/// The indexes `0005_connectors` adds on tables of earlier migrations or beside its tables' own:
/// the connected-account lookup on `capabilities`, and the raw-body purge and the newest-first
/// history on `inbound_events`.
const CONNECTOR_INDEXES: [&str; 3] = [
    "capabilities_connected_account_idx",
    "inbound_events_raw_received_idx",
    "inbound_events_history_idx",
];

/// The column `0005_connectors` adds to a table of an earlier migration: a budget item's
/// retirement time.
const RETIRED_AT: (&str, &str) = ("budget_items", "retired_at");

/// Whether `table` has a column named `column`.
async fn column_exists(pool: &PgPool, (table, column): (&str, &str)) -> bool {
    sqlx::query_scalar(
        "select exists(select 1 from information_schema.columns \
         where table_schema = 'public' and table_name = $1 and column_name = $2)",
    )
    .bind(table)
    .bind(column)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Migrations recorded as applied.
async fn applied_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Whether an index named `name` exists.
async fn index_exists(pool: &PgPool, name: &str) -> bool {
    sqlx::query_scalar("select exists(select 1 from pg_indexes where indexname = $1)")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn migrations_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../migrations")
}

#[tokio::test]
async fn up_down_up_round_trip() {
    let db = TestDb::new().await; // already migrated up
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert_eq!(applied_count(&db.pool).await, MIGRATIONS);
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);
    for index in CONNECTOR_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    assert!(column_exists(&db.pool, RETIRED_AT).await);

    jt_pg::migrate_down_all(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 0);
    assert_eq!(applied_count(&db.pool).await, 0);

    jt_pg::migrate_down_all(&db.pool).await.unwrap(); // down twice is a no-op
    assert_eq!(table_count(&db.pool).await, 0);

    jt_pg::migrate_up(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert_eq!(applied_count(&db.pool).await, MIGRATIONS);
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);
    for index in CONNECTOR_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    assert!(column_exists(&db.pool, RETIRED_AT).await);
}

/// Whether a function named `name` exists.
async fn function_exists(pool: &PgPool, name: &str) -> bool {
    sqlx::query_scalar("select exists(select 1 from pg_proc where proname = $1)")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn up_and_down_scripts_are_idempotent_on_their_own() {
    let db = TestDb::new().await; // already migrated up
    let dir = migrations_dir();
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap();
    let run = |sql: String| {
        let pool = db.pool.clone();
        async move { sqlx::raw_sql(&sql).execute(&pool).await.unwrap() }
    };
    let (foundation_up, foundation_down) = (
        read("0001_foundation.up.sql"),
        read("0001_foundation.down.sql"),
    );
    let (strategy_up, strategy_down) =
        (read("0002_strategy.up.sql"), read("0002_strategy.down.sql"));
    let (capabilities_up, capabilities_down) = (
        read("0003_capabilities.up.sql"),
        read("0003_capabilities.down.sql"),
    );
    let (backfill_up, backfill_down) = (
        read("0004_role_permissions_backfill.up.sql"),
        read("0004_role_permissions_backfill.down.sql"),
    );
    let (connectors_up, connectors_down) = (
        read("0005_connectors.up.sql"),
        read("0005_connectors.down.sql"),
    );

    // Re-running each `up` over an applied schema changes nothing.
    run(foundation_up.clone()).await;
    run(strategy_up.clone()).await;
    run(capabilities_up.clone()).await;
    run(backfill_up.clone()).await;
    run(connectors_up.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);
    for function in CONNECTOR_FUNCTIONS {
        assert!(function_exists(&db.pool, function).await, "{function}");
    }
    for index in CONNECTOR_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    assert!(column_exists(&db.pool, RETIRED_AT).await);

    // Newest first, each `down` twice: the second run is a no-op. 0005 drops its tables, trigger
    // functions and the column it added; 0004 its index; 0003 its tables and trigger function.
    run(read("0006_inbox.down.sql")).await;
    run(read("0006_inbox.down.sql")).await;
    run(connectors_down.clone()).await;
    run(connectors_down.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_CAPABILITIES);
    for function in CONNECTOR_FUNCTIONS {
        assert!(!function_exists(&db.pool, function).await, "{function}");
    }
    // Including the index it put on `capabilities` and the column it put on `budget_items`,
    // which stay.
    for index in CONNECTOR_INDEXES {
        assert!(!index_exists(&db.pool, index).await, "{index}");
    }
    assert!(!column_exists(&db.pool, RETIRED_AT).await);
    // 0005 applies again on its own, and reverts again.
    run(connectors_up.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_CONNECTORS);
    assert!(column_exists(&db.pool, RETIRED_AT).await);
    run(connectors_down).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_CAPABILITIES);
    assert!(!column_exists(&db.pool, RETIRED_AT).await);

    run(backfill_down.clone()).await;
    run(backfill_down.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_CAPABILITIES);
    assert!(!index_exists(&db.pool, CHECKIN_INDEX).await);
    run(backfill_up).await;
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);
    run(backfill_down).await;
    assert!(!index_exists(&db.pool, CHECKIN_INDEX).await);

    run(capabilities_down.clone()).await;
    run(capabilities_down.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_STRATEGY);
    assert!(!function_exists(&db.pool, "budget_spend_entries_immutable").await);

    // 0003 applies again on its own, and reverts again.
    run(capabilities_up).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_CAPABILITIES);
    assert!(function_exists(&db.pool, "budget_spend_entries_immutable").await);
    run(capabilities_down).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_STRATEGY);

    run(strategy_down.clone()).await;
    run(strategy_down.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_FOUNDATION);
    assert!(!function_exists(&db.pool, "consultation_entries_immutable").await);

    // 0002 applies again on its own, and reverts again.
    run(strategy_up).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_STRATEGY);
    assert!(function_exists(&db.pool, "consultation_entries_immutable").await);
    run(strategy_down).await;

    run(foundation_down.clone()).await;
    run(foundation_down).await;
    assert_eq!(table_count(&db.pool).await, 0);
    assert!(!function_exists(&db.pool, "ledger_entries_immutable").await);
}

#[tokio::test]
async fn every_migration_has_a_down_file() {
    let dir = migrations_dir();
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".sql"))
        .collect();

    let ups: Vec<&String> = names.iter().filter(|n| n.ends_with(".up.sql")).collect();
    assert_eq!(
        ups.len() as i64,
        MIGRATIONS,
        "*.up.sql files in {}: {ups:?}",
        dir.display()
    );

    for name in &names {
        assert!(
            name.ends_with(".up.sql") || name.ends_with(".down.sql"),
            "{name} is not a reversible migration (*.up.sql / *.down.sql)"
        );
    }
    for up in ups {
        let down = up.replace(".up.sql", ".down.sql");
        assert!(names.contains(&down), "{up} has no {down}");
    }
    for down in names.iter().filter(|n| n.ends_with(".down.sql")) {
        let up = down.replace(".down.sql", ".up.sql");
        assert!(names.contains(&up), "{down} has no {up}");
    }
}

/// The permission keys of role `id`, in their stored order.
async fn role_permissions(pool: &PgPool, id: Uuid) -> Vec<String> {
    let mut tx = PlatformTx::begin(pool).await.unwrap();
    let permissions: Vec<String> =
        sqlx::query_scalar("select permissions from roles where id = $1")
            .bind(id)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    tx.commit().await.unwrap();
    permissions
}

#[tokio::test]
async fn backfill_adds_the_new_permissions_to_old_system_roles_only() {
    let db = TestDb::new().await; // already migrated up, 0004 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0004_role_permissions_backfill.up.sql")).unwrap();
    let down =
        std::fs::read_to_string(dir.join("0004_role_permissions_backfill.down.sql")).unwrap();
    let run = |sql: &str| {
        let pool = db.pool.clone();
        let sql = sql.to_owned();
        async move { sqlx::raw_sql(&sql).execute(&pool).await.unwrap() }
    };

    // A workspace registered before M1a: its roles carry the permission lists of then.
    let old = [
        "workspace.read",
        "team.manage",
        "api_keys.manage",
        "ledger.read",
    ];
    // A second workspace holds a custom role keyed like a system one: only `is_system` tells
    // them apart.
    let (ws, other_ws) = (Uuid::now_v7(), Uuid::now_v7());
    let (owner, manager, rep, custom, custom_with_keys, custom_manager) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    for (id, name) in [(ws, "old"), (other_ws, "other")] {
        sqlx::query(
            "insert into workspaces (id, name, slug, status) values ($1, $2, $3, 'active')",
        )
        .bind(id)
        .bind(name)
        .bind(format!("{name}-{}", id.simple()))
        .execute(tx.conn())
        .await
        .unwrap();
    }
    let roles: [(Uuid, Uuid, &str, bool, Vec<&str>); 6] = [
        (owner, ws, "owner", true, old.to_vec()),
        // Already granted one of the two (say, by hand): it is not granted twice.
        (
            manager,
            ws,
            "manager",
            true,
            [&old[..], &["budget.manage"]].concat(),
        ),
        (rep, ws, "rep", true, vec!["workspace.read"]),
        (custom, ws, "analyst", false, old.to_vec()),
        (
            custom_with_keys,
            ws,
            "buyer",
            false,
            vec!["workspace.read", "capabilities.manage", "budget.manage"],
        ),
        (
            custom_manager,
            other_ws,
            "manager",
            false,
            vec!["workspace.read", "capabilities.manage"],
        ),
    ];
    for (id, workspace, key, is_system, permissions) in &roles {
        sqlx::query(
            "insert into roles (id, workspace_id, key, name, permissions, is_system) \
             values ($1, $2, $3, $3, $4, $5)",
        )
        .bind(id)
        .bind(workspace)
        .bind(key)
        .bind(permissions)
        .bind(is_system)
        .execute(tx.conn())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let with_new = |base: &[&str]| -> Vec<String> {
        base.iter()
            .copied()
            .chain(["capabilities.manage", "budget.manage"])
            .map(str::to_owned)
            .collect()
    };
    let as_strings =
        |keys: &[&str]| -> Vec<String> { keys.iter().map(|k| (*k).to_owned()).collect() };

    // Up, twice: the system owner and manager gain exactly the missing keys, once.
    for _ in 0..2 {
        run(&up).await;
        assert_eq!(role_permissions(&db.pool, owner).await, with_new(&old));
        assert_eq!(
            role_permissions(&db.pool, manager).await,
            as_strings(&[&old[..], &["budget.manage", "capabilities.manage"]].concat())
        );
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
        assert_eq!(role_permissions(&db.pool, custom).await, as_strings(&old));
        assert_eq!(
            role_permissions(&db.pool, custom_with_keys).await,
            ["workspace.read", "capabilities.manage", "budget.manage"]
        );
        assert_eq!(
            role_permissions(&db.pool, custom_manager).await,
            ["workspace.read", "capabilities.manage"]
        );
    }

    // Down, twice: the two keys leave the system owner and manager, and no custom role.
    for _ in 0..2 {
        run(&down).await;
        assert_eq!(role_permissions(&db.pool, owner).await, as_strings(&old));
        assert_eq!(role_permissions(&db.pool, manager).await, as_strings(&old));
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
        assert_eq!(role_permissions(&db.pool, custom).await, as_strings(&old));
        assert_eq!(
            role_permissions(&db.pool, custom_with_keys).await,
            ["workspace.read", "capabilities.manage", "budget.manage"]
        );
        assert_eq!(
            role_permissions(&db.pool, custom_manager).await,
            ["workspace.read", "capabilities.manage"]
        );
    }
}

#[tokio::test]
async fn migration_round_trip_23_36_23_36() {
    let db = TestDb::new().await;
    assert_eq!(table_count(&db.pool).await, 36);
    assert!(column_exists(&db.pool, ("conversations", "created_at")).await);
    assert!(column_exists(&db.pool, ("conversations", "updated_at")).await);
    assert!(column_exists(&db.pool, ("conversations", "activity_revision")).await);
    assert!(column_exists(&db.pool, ("conversations", "last_inbound_identity_id")).await);
    assert!(column_exists(&db.pool, ("messages", "sender_identity_id")).await);
    assert!(column_exists(&db.pool, ("journeys", "reducer_revision")).await);
    assert!(column_exists(&db.pool, ("workspace_policies", "inbox_status_labels")).await);
    let (ws, _) = db.seed_workspace("inbox-policy-roundtrip").await;
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into workspace_policies (workspace_id,agent_checkin_interval_minutes,updated_at,inbox_status_labels) values ($1,60,now(),$2)")
        .bind(ws.as_uuid()).bind(serde_json::json!({"new":"Yeni"})).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let dir = migrations_dir();
    let down = std::fs::read_to_string(dir.join("0006_inbox.down.sql")).unwrap();
    let up = std::fs::read_to_string(dir.join("0006_inbox.up.sql")).unwrap();
    for _ in 0..2 {
        sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, 23);
        assert!(!column_exists(&db.pool, ("conversations", "created_at")).await);
        assert!(!column_exists(&db.pool, ("conversations", "updated_at")).await);
        assert!(!column_exists(&db.pool, ("conversations", "activity_revision")).await);
        assert!(!column_exists(&db.pool, ("conversations", "last_inbound_identity_id")).await);
        assert!(!column_exists(&db.pool, ("messages", "sender_identity_id")).await);
        assert!(!column_exists(&db.pool, ("journeys", "reducer_revision")).await);
        assert!(!column_exists(&db.pool, ("workspace_policies", "inbox_status_labels")).await);
        assert!(!column_exists(&db.pool, ("lost_reasons", "key")).await);
        let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
        let interval: i32 = sqlx::query_scalar(
            "select agent_checkin_interval_minutes from workspace_policies where workspace_id=$1",
        )
        .bind(ws.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert_eq!(interval, 60);
    }
    for _ in 0..2 {
        sqlx::raw_sql(&up).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, 36);
        assert!(column_exists(&db.pool, ("conversations", "created_at")).await);
        assert!(column_exists(&db.pool, ("conversations", "updated_at")).await);
        assert!(column_exists(&db.pool, ("conversations", "activity_revision")).await);
        assert!(column_exists(&db.pool, ("conversations", "last_inbound_identity_id")).await);
        assert!(column_exists(&db.pool, ("messages", "sender_identity_id")).await);
        assert!(column_exists(&db.pool, ("journeys", "reducer_revision")).await);
        assert!(column_exists(&db.pool, ("workspace_policies", "inbox_status_labels")).await);
        let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
        let labels: serde_json::Value = sqlx::query_scalar(
            "select inbox_status_labels from workspace_policies where workspace_id=$1",
        )
        .bind(ws.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert_eq!(labels, serde_json::json!({}));
    }
}
