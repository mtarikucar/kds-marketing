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
const TABLES_AFTER_ALL: i64 = 20;

/// The migrations there are: `0001_foundation` to `0004_role_permissions_backfill`.
const MIGRATIONS: i64 = 4;

/// The index `0004_role_permissions_backfill` adds for the check-in lookup.
const CHECKIN_INDEX: &str = "ledger_entries_agent_connection_idx";

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

    jt_pg::migrate_down_all(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 0);
    assert_eq!(applied_count(&db.pool).await, 0);

    jt_pg::migrate_down_all(&db.pool).await.unwrap(); // down twice is a no-op
    assert_eq!(table_count(&db.pool).await, 0);

    jt_pg::migrate_up(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert_eq!(applied_count(&db.pool).await, MIGRATIONS);
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);
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

    // Re-running each `up` over an applied schema changes nothing.
    run(foundation_up.clone()).await;
    run(strategy_up.clone()).await;
    run(capabilities_up.clone()).await;
    run(backfill_up.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert!(index_exists(&db.pool, CHECKIN_INDEX).await);

    // Newest first, each `down` twice: the second run is a no-op. 0004 drops its index; 0003 its
    // tables and trigger function.
    run(backfill_down.clone()).await;
    run(backfill_down.clone()).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
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
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
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
