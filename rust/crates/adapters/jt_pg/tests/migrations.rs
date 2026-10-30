//! Migrations are reversible pairs, and the whole set round-trips up → down → up.

use std::path::{Path, PathBuf};

use jt_pg::{PlatformTx, TenantTx};
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
/// Tables after M4 Task 1: 62 M3 tables plus four billing tables and one manifest; then the four
/// call tables of `0015_voice_calls`, the bridge's event notes of `0016_voice_bridge`, the
/// device commands and device files of `0017_device_bridge`, and the public items, their
/// subjects and the poll cursors of `0019_inbox_public`.
const TABLES_AFTER_ALL: i64 = 77;

/// Migrations `0001_foundation` through `0019_inbox_public`, `0018` aside: that number is the
/// TikTok webhooks' (`0018_tiktok_webhooks`, another branch). Whichever of the two lands second
/// renumbers, and this count and [`migration_versions`] close the gap then.
const MIGRATIONS: i64 = 18;

/// The versions of the migrations there are (see [`MIGRATIONS`]).
fn migration_versions() -> Vec<i64> {
    (1..=17).chain([19]).collect()
}

/// The tables of `0019_inbox_public`, each with its one row-level policy.
const INBOX_PUBLIC_TABLES: [(&str, &str); 3] = [
    ("public_subjects", "public_subjects_ws"),
    ("public_items", "public_items_ws"),
    ("public_cursors", "public_cursors_ws"),
];

/// The indexes of `public_items` (`0019_inbox_public`).
const INBOX_PUBLIC_INDEXES: [&str; 5] = [
    "public_items_owed",
    "public_items_deadline",
    "public_items_thread",
    "public_items_reconcile",
    "public_items_conversation",
];

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

/// The indexes of `device_commands` and `device_files` (`0017_device_bridge`): the queue a bridge
/// reads, the expiry sweep, a phone's command log, and the files' retention sweep.
const DEVICE_BRIDGE_INDEXES: [&str; 4] = [
    "device_commands_queue",
    "device_commands_due",
    "device_commands_log",
    "device_files_expiry",
];

/// The tables of `0017_device_bridge`, each with its one row-level policy.
const DEVICE_BRIDGE_TABLES: [(&str, &str); 2] = [
    ("device_commands", "device_commands_ws"),
    ("device_files", "device_files_ws"),
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
    for name in [
        "0019_inbox_public",
        "0017_device_bridge",
        "0016_voice_bridge",
        "0015_voice_calls",
        "0014_social_providers",
        "0013_probe_reason",
        "0012_m4_grandfathered_backfill",
        "0011_m4_activation_codes",
        "0010_m4_billing",
    ] {
        run(read(&format!("{name}.down.sql"))).await;
        run(read(&format!("{name}.down.sql"))).await;
    }
    run(read("0009_studio.down.sql")).await;
    run(read("0008_inbox_compliance.down.sql")).await;
    run(read("0008_inbox_compliance.down.sql")).await;
    run(read("0007_inbox_policy.down.sql")).await;
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

    let mut versions: Vec<i64> = names
        .iter()
        .filter(|n| n.ends_with(".up.sql"))
        .map(|n| n.split('_').next().unwrap().parse().unwrap())
        .collect();
    versions.sort();
    assert_eq!(versions, migration_versions());
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
async fn device_bridge_migration_is_repeatable_and_grants_only_the_system_owner_and_manager() {
    let db = TestDb::new().await; // already migrated up, 0017 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0017_device_bridge.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0017_device_bridge.down.sql")).unwrap();
    let run = |sql: &str| {
        let pool = db.pool.clone();
        let sql = sql.to_owned();
        async move { sqlx::raw_sql(&sql).execute(&pool).await.unwrap() }
    };
    let as_strings =
        |keys: &[&str]| -> Vec<String> { keys.iter().map(|k| (*k).to_owned()).collect() };
    let keys = ["devices.work", "devices.bridge"];
    let base = ["workspace.read", "team.manage"];

    // A second workspace holds a custom role keyed like a system one: only `is_system` tells
    // them apart.
    let (ws, other_ws) = (Uuid::now_v7(), Uuid::now_v7());
    let (owner, manager, rep, custom, custom_manager) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    for (id, name) in [(ws, "devices"), (other_ws, "other")] {
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
    let roles: [(Uuid, Uuid, &str, bool, Vec<&str>); 5] = [
        (owner, ws, "owner", true, base.to_vec()),
        // Already granted one of the two (say, by hand): it is not granted twice.
        (
            manager,
            ws,
            "manager",
            true,
            [&base[..], &["devices.work"]].concat(),
        ),
        (rep, ws, "rep", true, vec!["workspace.read"]),
        (
            custom,
            ws,
            "analyst",
            false,
            [&base[..], &["devices.work"]].concat(),
        ),
        (
            custom_manager,
            other_ws,
            "manager",
            false,
            vec!["workspace.read"],
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

    // Up, twice: the system owner and manager gain exactly the missing keys, once, in order.
    for _ in 0..2 {
        run(&up).await;
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
        for role in [owner, manager] {
            assert_eq!(
                role_permissions(&db.pool, role).await,
                as_strings(&[&base[..], &keys[..]].concat())
            );
        }
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
        assert_eq!(
            role_permissions(&db.pool, custom).await,
            as_strings(&[&base[..], &["devices.work"]].concat())
        );
        assert_eq!(
            role_permissions(&db.pool, custom_manager).await,
            ["workspace.read"]
        );
    }

    // Down, twice: the two tables go, and the two keys leave the system owner and manager only.
    for _ in 0..2 {
        run(&down).await;
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 2);
        for index in DEVICE_BRIDGE_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
        for role in [owner, manager] {
            assert_eq!(role_permissions(&db.pool, role).await, as_strings(&base));
        }
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
        assert_eq!(
            role_permissions(&db.pool, custom).await,
            as_strings(&[&base[..], &["devices.work"]].concat())
        );
        assert_eq!(
            role_permissions(&db.pool, custom_manager).await,
            ["workspace.read"]
        );
    }

    // Up again: the tables are back, with their indexes, forced row-level security and one policy
    // each.
    run(&up).await;
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    for index in DEVICE_BRIDGE_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    for (table, policy) in DEVICE_BRIDGE_TABLES {
        let forced: bool = sqlx::query_scalar(
            "select relrowsecurity and relforcerowsecurity from pg_class where relname = $1",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(forced, "{table}");
        let policies: i64 = sqlx::query_scalar(
            "select count(*) from pg_policies where schemaname = current_schema() \
             and tablename = $1 and policyname = $2",
        )
        .bind(table)
        .bind(policy)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(policies, 1, "{table}");
    }
}

#[tokio::test]
async fn migration_round_trip_23_36_23_36() {
    let db = TestDb::new().await;
    // Newest first: the public items and the call tables reference the inbox tables.
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0019_inbox_public.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0017_device_bridge.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0016_voice_bridge.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0015_voice_calls.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../../../../migrations/0009_studio.down.sql"))
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0008_inbox_compliance.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(table_count(&db.pool).await, 41);
    assert!(index_exists(&db.pool, "messages_external_lookup").await);
    assert!(index_exists(&db.pool, "messages_echo_candidates").await);
    assert!(index_exists(&db.pool, "outbox_message_lookup").await);
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
        assert_eq!(table_count(&db.pool).await, 28);
        assert!(!index_exists(&db.pool, "messages_external_lookup").await);
        assert!(!index_exists(&db.pool, "messages_echo_candidates").await);
        assert!(!index_exists(&db.pool, "outbox_message_lookup").await);
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
        assert_eq!(table_count(&db.pool).await, 41);
        assert!(index_exists(&db.pool, "messages_external_lookup").await);
        assert!(index_exists(&db.pool, "messages_echo_candidates").await);
        assert!(index_exists(&db.pool, "outbox_message_lookup").await);
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

#[tokio::test]
async fn inbox_policy_round_trip_preserves_existing_labels() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("policy-round-trip").await;
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into workspace_policies(workspace_id,agent_checkin_interval_minutes,updated_at,inbox_status_labels,inbox_policy) values ($1,60,now(),$2,$3)")
        .bind(ws.as_uuid()).bind(serde_json::json!({"new":"Yeni"})).bind(serde_json::json!({"unreachable_threshold":5})).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let up = include_str!("../../../../migrations/0007_inbox_policy.up.sql");
    let down = include_str!("../../../../migrations/0007_inbox_policy.down.sql");
    for sql in [down, down, up, up] {
        sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
    }
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let labels: serde_json::Value = sqlx::query_scalar(
        "select inbox_status_labels from workspace_policies where workspace_id=$1",
    )
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .unwrap();
    assert_eq!(labels, serde_json::json!({"new":"Yeni"}));
    assert!(column_exists(&db.pool, ("workspace_policies", "inbox_policy")).await);
}

#[tokio::test]
async fn migration_round_trip_36_48_36_48() {
    compliance_round_trip_preserving_people().await;
}

// Historical plan name; the unreleased compliance migration is actually 0008.
#[tokio::test]
async fn attribution_0007_up_down_up_preserves_unrelated_rows() {
    compliance_round_trip_preserving_people().await;
}

async fn compliance_round_trip_preserving_people() {
    let db = TestDb::new().await;
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0019_inbox_public.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0017_device_bridge.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0016_voice_bridge.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0015_voice_calls.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../../../../migrations/0009_studio.down.sql"))
        .execute(&db.pool)
        .await
        .unwrap();
    let (ws, _) = db.seed_workspace("compliance-roundtrip").await;
    let person = Uuid::now_v7();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into people(id,workspace_id,display_name,first_touch,created_at,updated_at) values($1,$2,'Keep me','{}',now(),now())")
        .bind(person).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    let up = include_str!("../../../../migrations/0008_inbox_compliance.up.sql");
    let down = include_str!("../../../../migrations/0008_inbox_compliance.down.sql");
    assert_eq!(table_count(&db.pool).await, 53);
    for sql in [down, down] {
        sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, 41);
        assert!(!sqlx::query_scalar::<_,bool>("select exists(select 1 from information_schema.columns where table_name='capabilities' and column_name='iys_sealed')").fetch_one(&db.pool).await.unwrap());
        assert!(!function_exists(&db.pool, "inbox_erasure_matches").await);
        assert!(!function_exists(&db.pool, "journey_attribution_immutable").await);
        assert!(!index_exists(&db.pool, "journey_attribution_ad_idx").await);
    }
    for sql in [up, up] {
        sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
        assert_eq!(table_count(&db.pool).await, 53);
        let slot:(String,String)=sqlx::query_as("select data_type,is_nullable from information_schema.columns where table_name='capabilities' and column_name='iys_sealed'").fetch_one(&db.pool).await.unwrap();
        assert_eq!(slot, ("bytea".into(), "YES".into()));
        assert!(index_exists(&db.pool, "journey_attribution_ad_idx").await);
    }
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let name: String = sqlx::query_scalar("select display_name from people where id=$1")
        .bind(person)
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(name, "Keep me");
}

#[tokio::test]
async fn studio_migration_up_down_up() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("studio-roundtrip").await;
    let up = include_str!("../../../../migrations/0009_studio.up.sql");
    let down = include_str!("../../../../migrations/0009_studio.down.sql");
    // Public subjects reference Studio publications: 0019 goes first and comes back last.
    let public_up = include_str!("../../../../migrations/0019_inbox_public.up.sql");
    let public_down = include_str!("../../../../migrations/0019_inbox_public.down.sql");
    let id = Uuid::now_v7();
    let h = Uuid::now_v7();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into strategy_versions(id,workspace_id,number,status,sections,created_by_component,created_at) values($1,$2,1,'draft','{}','test','2026-10-24T00:00:00Z')").bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    sqlx::query("insert into strategy_hypotheses(version_id,workspace_id,hypothesis_id,title,segment_key,angle,channel,metric,prior_confidence,state,position) values($1,$2,$3,'keep','all','help','any','reply',0.7,'added',0)").bind(id).bind(ws.as_uuid()).bind(h).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for sql in [up, public_down, down, down, up, up, public_up] {
        sqlx::raw_sql(sql).execute(&db.pool).await.unwrap();
    }
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let saved: (String,f32,serde_json::Value) = sqlx::query_as("select title,prior_confidence,cadence from strategy_hypotheses where workspace_id = $1 and hypothesis_id = $2").bind(ws.as_uuid()).bind(h).fetch_one(tx.conn()).await.unwrap();
    assert_eq!(saved, ("keep".into(), 0.7, serde_json::json!({})));
    let bypass: bool = sqlx::query_scalar(
        "select rolsuper or rolbypassrls from pg_roles where rolname=current_user",
    )
    .fetch_one(tx.conn())
    .await
    .unwrap();
    assert!(!bypass);
    let forced: bool = sqlx::query_scalar("select relrowsecurity and relforcerowsecurity from pg_class where relname='studio_learning_applications'").fetch_one(tx.conn()).await.unwrap();
    assert!(forced);
}

/// Runs `sql` on `pool`, answering the error's text when it fails.
async fn try_sql(pool: &PgPool, sql: &str) -> Result<(), String> {
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The definition of the check constraint `name`.
async fn check_definition(pool: &PgPool, name: &str) -> String {
    sqlx::query_scalar("select pg_get_constraintdef(oid) from pg_constraint where conname = $1")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A person, an `instagram` capability, a conversation and an inbound message in a new workspace
/// (`ids` = workspace, capability, conversation, message), through the repos.
async fn inbox_rows(db: &TestDb) -> (jt_tenancy::WorkspaceId, Uuid, Uuid, Uuid) {
    let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = jt_testkit::inbox_contract::Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    let m = f.comment_message(c.id, "c1", 0).await;
    (f.ws, cap.as_uuid(), c.id.as_uuid(), m.as_uuid())
}

/// The three tables of `0019_inbox_public` force row-level security, each under its one policy;
/// the indexes of `public_items` exist.
#[tokio::test]
async fn public_tables_force_rls_with_one_policy() {
    let db = TestDb::new().await;
    for (table, policy) in INBOX_PUBLIC_TABLES {
        let forced: bool = sqlx::query_scalar(
            "select relrowsecurity and relforcerowsecurity from pg_class where relname = $1",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(forced, "{table}");
        let policies: Vec<String> = sqlx::query_scalar(
            "select policyname::text from pg_policies where schemaname = current_schema() \
             and tablename = $1",
        )
        .bind(table)
        .fetch_all(&db.pool)
        .await
        .unwrap();
        assert_eq!(policies, [policy], "{table}");
    }
    for index in INBOX_PUBLIC_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    // A tenant sees only its own items.
    let (ws, cap, conversation, message) = inbox_rows(&db).await;
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into public_items (workspace_id,id,capability_id,conversation_id,message_id,kind,\
         external_id,root_external_id,created_at,answer,updated_at) \
         values ($1,$2,$3,$4,$5,'comment','c1','c1',now(),'{\"state\":\"awaiting\"}',now())",
    )
    .bind(ws.as_uuid())
    .bind(Uuid::now_v7())
    .bind(cap)
    .bind(conversation)
    .bind(message)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let (other, _) = db.seed_workspace("other-public").await;
    let mut tx = TenantTx::begin(&db.pool, other).await.unwrap();
    let seen: i64 = sqlx::query_scalar("select count(*) from public_items")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(seen, 0);
    tx.rollback().await.unwrap();
}

/// `answer_state` is derived from the stored answer's `state` tag and cannot be written.
#[tokio::test]
async fn answer_state_is_generated() {
    let db = TestDb::new().await;
    let (ws, cap, conversation, message) = inbox_rows(&db).await;
    let id = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into public_items (workspace_id,id,capability_id,conversation_id,message_id,kind,\
         external_id,root_external_id,created_at,answer,updated_at) \
         values ($1,$2,$3,$4,$5,'question','q1','q1',now(),$6,now())",
    )
    .bind(ws.as_uuid())
    .bind(id)
    .bind(cap)
    .bind(conversation)
    .bind(message)
    .bind(serde_json::json!({"state": "pending", "message_id": message}))
    .execute(tx.conn())
    .await
    .unwrap();
    let state: String = sqlx::query_scalar("select answer_state from public_items where id = $1")
        .bind(id)
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(state, "pending");
    tx.commit().await.unwrap();
    for refused in [
        "update public_items set answer_state = 'answered' where id = $1",
        "update public_items set answer = '{\"state\":\"lost\"}' where id = $1",
        "update public_items set answer = '{\"by\":\"us\"}' where id = $1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        let e = sqlx::query(refused).bind(id).execute(tx.conn()).await;
        assert!(e.is_err(), "{refused}");
        tx.rollback().await.unwrap();
    }
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("update public_items set answer = '{\"state\":\"expired\",\"at\":\"2026-10-30T10:00:00Z\"}' where id = $1")
        .bind(id)
        .execute(tx.conn())
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("select answer_state from public_items where id = $1")
        .bind(id)
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(state, "expired");
    tx.rollback().await.unwrap();
}

/// A reply held for approval is an outbox row of its own state.
#[tokio::test]
async fn outbox_accepts_held() {
    let db = TestDb::new().await;
    let (ws, cap, conversation, message) = inbox_rows(&db).await;
    let insert = |state: &'static str| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let done = sqlx::query(
                "insert into outbox (workspace_id,id,conversation_id,message_id,capability_id,intent,\
                 expected_generation,state,created_at,updated_at) \
                 values ($1,$2,$3,$4,$5,'{}',0,$6,now(),now())",
            )
            .bind(ws.as_uuid())
            .bind(Uuid::now_v7())
            .bind(conversation)
            .bind(message)
            .bind(cap)
            .bind(state)
            .execute(tx.conn())
            .await;
            match done {
                Ok(_) => tx.commit().await.map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            }
        }
    };
    insert("held").await.unwrap();
    assert!(insert("waiting").await.is_err());
}

/// `0019_inbox_public` repeats, and its down refuses, changing nothing, while a row needs the wider
/// checks: a marketplace inbound event (events are never deleted) or a reply held for approval.
/// Without such rows it narrows both checks back and drops the three tables.
#[tokio::test]
async fn inbox_public_down_refuses_while_rows_need_the_wider_checks() {
    let db = TestDb::new().await; // already migrated up, 0019 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0019_inbox_public.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0019_inbox_public.down.sql")).unwrap();
    // The marketplaces' providers are allowed or not; TikTok's stays either way (0018 owns it).
    let wide = |definition: String| {
        ["'mail'", "'tiktok'", "'trendyol'", "'hepsiburada'"]
            .iter()
            .all(|p| definition.contains(p))
    };
    let narrow = |definition: String| {
        definition.contains("'mail'")
            && definition.contains("'tiktok'")
            && !definition.contains("'trendyol'")
            && !definition.contains("'hepsiburada'")
    };
    let has_held = |definition: &str| definition.contains("'held'");

    // Up again, twice: nothing changes.
    for _ in 0..2 {
        try_sql(&db.pool, &up).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
        assert!(wide(
            check_definition(&db.pool, "inbound_events_provider_check").await
        ));
        assert!(has_held(
            &check_definition(&db.pool, "outbox_state_check").await
        ));
    }
    // Down twice, without rows that need the wider checks: they narrow and the tables go.
    for _ in 0..2 {
        try_sql(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 3);
        assert!(narrow(
            check_definition(&db.pool, "inbound_events_provider_check").await
        ));
        assert!(!has_held(
            &check_definition(&db.pool, "outbox_state_check").await
        ));
        for index in INBOX_PUBLIC_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
    }
    for _ in 0..2 {
        try_sql(&db.pool, &up).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    }

    // A held reply refuses the down.
    let (ws, cap, conversation, message) = inbox_rows(&db).await;
    let held = Uuid::now_v7();
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into outbox (workspace_id,id,conversation_id,message_id,capability_id,intent,\
         expected_generation,state,created_at,updated_at) \
         values ($1,$2,$3,$4,$5,'{}',0,'held',now(),now())",
    )
    .bind(ws.as_uuid())
    .bind(held)
    .bind(conversation)
    .bind(message)
    .bind(cap)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let e = try_sql(&db.pool, &down).await.unwrap_err();
    assert!(e.contains("held for approval"), "{e}");
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    assert!(has_held(
        &check_definition(&db.pool, "outbox_state_check").await
    ));
    // Once it is approved or discarded, the down goes through; up brings everything back.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("update outbox set state = 'refused' where workspace_id = $1 and id = $2")
        .bind(ws.as_uuid())
        .bind(held)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    try_sql(&db.pool, &down).await.unwrap();
    try_sql(&db.pool, &up).await.unwrap();

    // A marketplace event refuses it for good: events are never deleted.
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query(
        "insert into inbound_events (id,workspace_id,provider,external_id,kind,payload,received_at) \
         values ($1,$2,'trendyol','q:1:open:','question','{}',now())",
    )
    .bind(Uuid::now_v7())
    .bind(ws.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        let e = try_sql(&db.pool, &down).await.unwrap_err();
        assert!(e.contains("marketplace events"), "{e}");
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
        assert!(wide(
            check_definition(&db.pool, "inbound_events_provider_check").await
        ));
    }
}
