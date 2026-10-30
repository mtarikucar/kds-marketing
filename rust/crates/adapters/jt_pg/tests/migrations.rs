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
/// device commands and device files of `0017_device_bridge`, and the five pool tables of
/// `0020_prospects`.
const TABLES_AFTER_ALL: i64 = 79;

/// Migrations `0001_foundation` through `0018_tiktok_webhooks`, and `0020_prospects`.
const MIGRATIONS: i64 = 19;

/// The migration versions. `0019` (inbox comments and marketplace) belongs to a parallel branch:
/// when it merges it adds its version here.
fn versions() -> Vec<i64> {
    (1..=18).chain([20]).collect()
}

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

/// The tables of `0020_prospects`, each with its one row-level policy.
const PROSPECTS_TABLES: [(&str, &str); 5] = [
    ("research_tasks", "research_tasks_ws"),
    ("prospects", "prospects_ws"),
    ("prospect_keys", "prospect_keys_ws"),
    ("prospect_scores", "prospect_scores_ws"),
    ("prospect_blocklist", "prospect_blocklist_ws"),
];

/// The indexes of `0020_prospects` beyond its primary keys and unique constraints.
const PROSPECTS_INDEXES: [&str; 10] = [
    "research_tasks_one_standing",
    "research_tasks_list",
    "prospects_list",
    "prospects_task",
    "prospects_purge",
    "prospects_person",
    "prospect_keys_hard",
    "prospect_keys_soft",
    "prospect_scores_by_prospect",
    "prospect_blocklist_expiry",
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
        "0020_prospects",
        "0018_tiktok_webhooks",
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
    assert_eq!(versions, self::versions());
    assert_eq!(versions.len() as i64, MIGRATIONS);
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

/// `0018_tiktok_webhooks` lets inbound events be TikTok's; its up and its down are repeatable,
/// and its down is refused, changing nothing, once a TikTok event is stored (events are never
/// deleted, so the narrower check could not hold it).
#[tokio::test]
async fn tiktok_webhooks_migration_is_repeatable_and_its_down_refuses_stored_events() {
    let db = TestDb::new().await; // already migrated up, 0018 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0018_tiktok_webhooks.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0018_tiktok_webhooks.down.sql")).unwrap();
    let run = |sql: &str| {
        let pool = db.pool.clone();
        let sql = sql.to_owned();
        async move { sqlx::raw_sql(&sql).execute(&pool).await }
    };
    let check = || {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "select pg_get_constraintdef(oid) from pg_constraint \
                 where conname = 'inbound_events_provider_check'",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let (ws, _) = db.seed_workspace("tiktok-hooks").await;
    let insert = |provider: &'static str| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let result = sqlx::query(
                "insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at) \
                 values($1,$2,$3,$4,'authorization.removed','{}',now())",
            )
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(provider)
            .bind(Uuid::now_v7().to_string())
            .execute(tx.conn())
            .await;
            match result {
                Ok(_) => {
                    tx.commit().await.unwrap();
                    None
                }
                Err(e) => {
                    tx.rollback().await.unwrap();
                    e.as_database_error()
                        .and_then(|d| d.code())
                        .map(|c| c.into_owned())
                }
            }
        }
    };

    // Without TikTok events the down narrows the check, twice over; the up widens it again.
    assert!(check().await.contains("'tiktok'"));
    for _ in 0..2 {
        run(&down).await.unwrap();
        let narrowed = check().await;
        assert!(!narrowed.contains("tiktok"), "{narrowed}");
        assert!(narrowed.contains("'mail'"), "{narrowed}");
        assert_eq!(insert("tiktok").await.as_deref(), Some("23514"));
    }
    for _ in 0..2 {
        run(&up).await.unwrap();
        assert!(check().await.contains("'tiktok'"));
    }
    assert_eq!(insert("tiktok").await, None);
    assert_eq!(insert("unknown").await.as_deref(), Some("23514"));

    // With one stored, the down is refused and leaves the check and the event as they were.
    let refused = run(&down).await.unwrap_err().to_string();
    assert!(
        refused.contains("tiktok webhooks rollback refused"),
        "{refused}"
    );
    assert!(check().await.contains("'tiktok'"));
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    let kept: i64 =
        sqlx::query_scalar("select count(*) from inbound_events where provider = 'tiktok'")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(kept, 1);
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
    // Newest first: the pool and the call tables reference the inbox tables.
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0020_prospects.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0018_tiktok_webhooks.down.sql"
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
        "../../../../migrations/0020_prospects.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0018_tiktok_webhooks.down.sql"
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
    let id = Uuid::now_v7();
    let h = Uuid::now_v7();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into strategy_versions(id,workspace_id,number,status,sections,created_by_component,created_at) values($1,$2,1,'draft','{}','test','2026-10-24T00:00:00Z')").bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    sqlx::query("insert into strategy_hypotheses(version_id,workspace_id,hypothesis_id,title,segment_key,angle,channel,metric,prior_confidence,state,position) values($1,$2,$3,'keep','all','help','any','reply',0.7,'added',0)").bind(id).bind(ws.as_uuid()).bind(h).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    for sql in [up, down, down, up, up] {
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

/// Runs `sql` as one simple query (a transaction of its own), answering the server's error.
async fn try_run(pool: &PgPool, sql: &str) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(sql).execute(pool).await.map(drop)
}

/// A pool row `0020_prospects` keeps: a prospect of `ws` with one key.
async fn insert_prospect(
    pool: &PgPool,
    ws: Uuid,
    kind: &str,
    value: &str,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::now_v7();
    let mut tx = PlatformTx::begin(pool).await.unwrap();
    sqlx::query(
        "insert into prospects (workspace_id, id, status, business_name, entity_kind, data, \
         created_at, updated_at) values ($1, $2, 'new', 'Örnek Kafe', 'legal_entity', '{}', now(), now())",
    )
    .bind(ws)
    .bind(id)
    .execute(tx.conn())
    .await?;
    sqlx::query(
        "insert into prospect_keys (workspace_id, prospect_id, kind, value) values ($1, $2, $3, $4)",
    )
    .bind(ws)
    .bind(id)
    .bind(kind)
    .bind(value)
    .execute(tx.conn())
    .await?;
    tx.commit().await.unwrap();
    Ok(id)
}

/// A blocklist entry of `ws` with `reason`, expiring in a day when `expires`.
async fn insert_blocklisted(
    pool: &PgPool,
    ws: Uuid,
    reason: &str,
    expires: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = PlatformTx::begin(pool).await.unwrap();
    sqlx::query(
        "insert into prospect_blocklist (workspace_id, kind, key_hash, reason, created_at, expires_at) \
         values ($1, 'phone', $2, $3, now(), case when $4 then now() + interval '1 day' end)",
    )
    .bind(ws)
    .bind(format!("{:064x}", Uuid::now_v7().as_u128()))
    .bind(reason)
    .bind(expires)
    .execute(tx.conn())
    .await?;
    tx.commit().await.unwrap();
    Ok(())
}

#[tokio::test]
async fn prospects_migration_is_repeatable_and_grants_only_the_system_owner_and_manager() {
    let db = TestDb::new().await; // already migrated up, 0020 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0020_prospects.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0020_prospects.down.sql")).unwrap();
    let as_strings =
        |keys: &[&str]| -> Vec<String> { keys.iter().map(|k| (*k).to_owned()).collect() };
    let keys = ["prospects.work", "prospects.manage"];
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
    for (id, name) in [(ws, "prospects"), (other_ws, "other")] {
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
        // Already granted one of the two: it is not granted twice.
        (
            manager,
            ws,
            "manager",
            true,
            [&base[..], &["prospects.work"]].concat(),
        ),
        (rep, ws, "rep", true, vec!["workspace.read"]),
        (custom, ws, "analyst", false, vec!["workspace.read"]),
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
        try_run(&db.pool, &up).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
        for role in [owner, manager] {
            assert_eq!(
                role_permissions(&db.pool, role).await,
                as_strings(&[&base[..], &keys[..]].concat())
            );
        }
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
        assert_eq!(role_permissions(&db.pool, custom).await, ["workspace.read"]);
        assert_eq!(
            role_permissions(&db.pool, custom_manager).await,
            ["workspace.read"]
        );
        assert!(column_exists(&db.pool, ("workspace_policies", "leads_policy")).await);
    }

    // Down, twice: the five tables and the policy column go, and the two keys leave the system
    // owner and manager only.
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 5);
        for index in PROSPECTS_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
        assert!(!column_exists(&db.pool, ("workspace_policies", "leads_policy")).await);
        for role in [owner, manager] {
            assert_eq!(role_permissions(&db.pool, role).await, as_strings(&base));
        }
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
    }

    // Up again: the tables are back, with their indexes, forced row-level security and exactly
    // one policy each.
    try_run(&db.pool, &up).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    for index in PROSPECTS_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    for (table, policy) in PROSPECTS_TABLES {
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
}

#[tokio::test]
async fn prospects_down_refuses_while_the_blocklist_holds_an_objection() {
    let db = TestDb::new().await;
    let down = std::fs::read_to_string(migrations_dir().join("0020_prospects.down.sql")).unwrap();
    let (ws, _) = db.seed_workspace("prospects-down-refusal").await;
    let ws = ws.as_uuid();
    // Rejection memory expires anyway: it does not hold a rollback up.
    insert_blocklisted(&db.pool, ws, "rejected", true)
        .await
        .unwrap();
    for reason in ["do_not_contact", "erased"] {
        insert_blocklisted(&db.pool, ws, reason, false)
            .await
            .unwrap();
        let refused = try_run(&db.pool, &down).await.unwrap_err();
        assert!(
            refused.to_string().contains("0020_prospects down refused"),
            "{refused}"
        );
        assert_eq!(
            table_count(&db.pool).await,
            TABLES_AFTER_ALL,
            "nothing dropped"
        );
        let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
        sqlx::query("delete from prospect_blocklist where reason = $1")
            .bind(reason)
            .execute(tx.conn())
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    try_run(&db.pool, &down).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 5);
}

#[tokio::test]
async fn prospects_down_keeps_a_leads_policy_a_workspace_set() {
    let db = TestDb::new().await;
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0020_prospects.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0020_prospects.down.sql")).unwrap();
    let (ws, _) = db.seed_workspace("prospects-policy-kept").await;
    let stored = serde_json::json!({"prospects": {"rejected_retention_days": 7}});
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query(
        "insert into workspace_policies (workspace_id, agent_checkin_interval_minutes, updated_at, \
         leads_policy) values ($1, 60, now(), $2)",
    )
    .bind(ws.as_uuid())
    .bind(&stored)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert!(column_exists(&db.pool, ("workspace_policies", "leads_policy")).await);
    }
    try_run(&db.pool, &up).await.unwrap();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let kept: serde_json::Value =
        sqlx::query_scalar("select leads_policy from workspace_policies where workspace_id = $1")
            .bind(ws.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(kept, stored);
    // A policy back to `{}` lets the column go.
    sqlx::query("update workspace_policies set leads_policy = '{}' where workspace_id = $1")
        .bind(ws.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    try_run(&db.pool, &down).await.unwrap();
    assert!(!column_exists(&db.pool, ("workspace_policies", "leads_policy")).await);
}

#[tokio::test]
async fn prospect_keys_hard_index_refuses_a_second_phone() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("prospect-keys").await;
    let (other, _) = db.seed_workspace("prospect-keys-other").await;
    let ws = ws.as_uuid();
    insert_prospect(&db.pool, ws, "phone", "+905000000000")
        .await
        .unwrap();
    let err = insert_prospect(&db.pool, ws, "phone", "+905000000000")
        .await
        .unwrap_err();
    assert!(
        err.as_database_error()
            .is_some_and(|e| e.constraint() == Some("prospect_keys_hard")),
        "{err}"
    );
    // Another workspace may hold the same number; soft keys never conflict.
    insert_prospect(&db.pool, other.as_uuid(), "phone", "+905000000000")
        .await
        .unwrap();
    for _ in 0..2 {
        insert_prospect(&db.pool, ws, "domain", "ornek.example.invalid")
            .await
            .unwrap();
        insert_prospect(&db.pool, ws, "name_city", "ornek kafe|istanbul")
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn blocklist_reason_and_expiry_agree() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("prospect-blocklist").await;
    let ws = ws.as_uuid();
    insert_blocklisted(&db.pool, ws, "rejected", true)
        .await
        .unwrap();
    insert_blocklisted(&db.pool, ws, "do_not_contact", false)
        .await
        .unwrap();
    insert_blocklisted(&db.pool, ws, "erased", false)
        .await
        .unwrap();
    for (reason, expires) in [
        ("rejected", false),
        ("do_not_contact", true),
        ("erased", true),
    ] {
        let err = insert_blocklisted(&db.pool, ws, reason, expires)
            .await
            .unwrap_err();
        assert!(
            err.as_database_error()
                .is_some_and(|e| e.constraint() == Some("prospect_blocklist_expiry_check")),
            "{reason}: {err}"
        );
    }
}
