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
/// device commands and device files of `0017_device_bridge`, the public items, their subjects and
/// the poll cursors of `0019_inbox_public`, the five pool tables of `0020_prospects`, the
/// materials library's seven of `0021_studio_materials`, the planned posts, package requests and
/// posting policy of `0022_studio_posts`, the templates, campaigns, enrollments and sends of
/// `0026_outreach`, the rep profiles, rules and assignment log of `0027_distribution`, and the
/// mail files of `0028_mail_files` and the material intelligence and production tables of
/// `0029` and `0030`, plus production projects of `0031`.
const TABLES_AFTER_ALL: i64 = 103;

/// The tables before `0028_mail_files` adds `mail_files`.
const TABLES_BEFORE_MAIL_FILES: i64 = TABLES_AFTER_ALL - 3;

/// The tables before `0026_outreach` adds its four (and `0028_mail_files` its one).
const TABLES_BEFORE_OUTREACH: i64 = TABLES_BEFORE_MAIL_FILES - 4;

/// Migrations `0001_foundation` through `0031_production_projects`.
const MIGRATIONS: i64 = 31;

/// The migration versions.
fn versions() -> Vec<i64> {
    (1..=31).collect()
}

/// The tables of `0019_inbox_public`, each with its one row-level policy.
const INBOX_PUBLIC_TABLES: [(&str, &str); 3] = [
    ("public_subjects", "public_subjects_ws"),
    ("public_items", "public_items_ws"),
    ("public_cursors", "public_cursors_ws"),
];

/// The indexes of `public_items` (`0019_inbox_public`).
const INBOX_PUBLIC_INDEXES: [&str; 6] = [
    "public_items_owed",
    "public_items_deadline",
    "public_items_thread",
    "public_items_reconcile",
    "public_items_conversation",
    "public_items_message",
];

/// The key `0019_inbox_public` adds to `conversations` for its items' composite foreign key.
const CONVERSATION_CAPABILITY_KEY: &str = "conversations_id_capability_key";

/// Whether a constraint named `name` exists.
async fn constraint_exists(pool: &PgPool, name: &str) -> bool {
    sqlx::query_scalar("select exists(select 1 from pg_constraint where conname = $1)")
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
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
const PROSPECTS_INDEXES: [&str; 11] = [
    "research_tasks_one_standing",
    "research_tasks_list",
    "prospects_list",
    "prospects_task",
    "prospects_purge_rejected",
    "prospects_purge_unpromoted",
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
        "0031_production_projects",
        "0030_material_productions",
        "0029_material_intelligence",
        "0028_mail_files",
        "0027_distribution",
        "0026_outreach",
        "0025_inbox_public_erasure",
        "0024_whatsapp_erasure",
        "0023_oauth_flow",
        "0022_studio_posts",
        "0021_studio_materials",
        "0020_prospects",
        "0019_inbox_public",
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

/// `0023_oauth_flow` keeps a flow's sign-in variant: its up and its down are repeatable, the check
/// takes only a known variant (or none), and its down forgets the flows that ran a variant (each
/// would otherwise be completed as the app's own sign-in) and keeps the others.
#[tokio::test]
async fn oauth_flow_migration_is_repeatable_and_its_down_drops_the_variant_flows() {
    let db = TestDb::new().await; // already migrated up, 0023 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0023_oauth_flow.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0023_oauth_flow.down.sql")).unwrap();
    let run = |sql: &str| {
        let pool = db.pool.clone();
        let sql = sql.to_owned();
        async move { sqlx::raw_sql(&sql).execute(&pool).await.unwrap() }
    };
    let (ws, owner) = db.seed_workspace("oauth-flow").await;
    let insert = |flow: Option<&'static str>| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let result = sqlx::query(
                "insert into oauth_pending(id,workspace_id,provider,kind_key,app,flow,state_hash,\
                 started_by,assets_public,expires_at,created_at) \
                 values($1,$2,'meta','whatsapp_cloud','meta',$3,$4,$5,'[]',now(),now())",
            )
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(flow)
            .bind(Uuid::now_v7().to_string())
            .bind(owner.as_uuid())
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
    let flows = || {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let n: i64 = sqlx::query_scalar("select count(*) from oauth_pending")
                .fetch_one(tx.conn())
                .await
                .unwrap();
            tx.rollback().await.unwrap();
            n
        }
    };

    for _ in 0..2 {
        run(&up).await;
    }
    assert!(column_exists(&db.pool, ("oauth_pending", "flow")).await);
    assert_eq!(insert(None).await, None);
    assert_eq!(insert(Some("whatsapp_business_app")).await, None);
    assert_eq!(insert(Some("another")).await.as_deref(), Some("23514"));
    assert_eq!(flows().await, 2);

    for _ in 0..2 {
        run(&down).await;
        assert!(!column_exists(&db.pool, ("oauth_pending", "flow")).await);
    }
    // The variant's flow went with the column; the app's own sign-in stays.
    assert_eq!(flows().await, 1);
    run(&up).await;
    assert!(column_exists(&db.pool, ("oauth_pending", "flow")).await);
}

/// `0023_oauth_flow` is the WhatsApp Business app coexistence's migration, and the code before it
/// cannot read what the feature leaves: once a message the business wrote from the app, or a
/// capability's sharing of the app's data, is stored, its down is refused and changes nothing.
#[tokio::test]
async fn oauth_flow_down_is_refused_once_the_business_app_left_data() {
    use jt_app::ports::UnitOfWork;
    let down = std::fs::read_to_string(migrations_dir().join("0023_oauth_flow.down.sql")).unwrap();
    for case in ["message", "capability"] {
        let db = TestDb::new().await;
        let uow = std::sync::Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
        let f = jt_testkit::inbox_contract::Fixture::new(uow.clone()).await;
        let cap = f.capability().await;
        let person = f.insert_person("App").await;
        let mut t = uow.tenant(f.ws).await.unwrap();
        if case == "message" {
            let c = t
                .conversations()
                .upsert_on_inbound(f.conversation(person.id, cap))
                .await
                .unwrap();
            let mut m = f.message(c.id);
            m.direction = jt_inbox::Direction::Outbound;
            m.author = jt_inbox::Author::BusinessApp;
            t.messages().insert_if_new(m).await.unwrap();
        } else {
            let mut c = t.capabilities().find(cap).await.unwrap().unwrap();
            c.connector_public =
                serde_json::json!({ "business_app": { "contacts": { "state": "due" } } });
            t.capabilities().update(c).await.unwrap();
        }
        t.commit().await.unwrap();
        let refused = sqlx::raw_sql(&down)
            .execute(&db.pool)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("oauth flow rollback refused"),
            "{case}: {refused}"
        );
        assert!(
            column_exists(&db.pool, ("oauth_pending", "flow")).await,
            "{case}"
        );
    }
}

/// `0024_whatsapp_erasure` lets erasure find a person in the WhatsApp Business app's events:
/// its up and its down are repeatable, and its down is refused, changing nothing, once such an
/// event is stored (events are never deleted, and the older functions could not find the person
/// in it).
#[tokio::test]
async fn whatsapp_erasure_migration_is_repeatable_and_its_down_refuses_stored_app_events() {
    let db = TestDb::new().await; // already migrated up, 0024 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0024_whatsapp_erasure.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0024_whatsapp_erasure.down.sql")).unwrap();
    let run = |sql: &str| {
        let pool = db.pool.clone();
        let sql = sql.to_owned();
        async move { sqlx::raw_sql(&sql).execute(&pool).await }
    };
    // Whether the erasure functions are this migration's: the mask takes a thread.
    let current = || {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, serde_json::Value>(
                "select inbox_mask_personal('{\"thread\":\"905321234567\"}')",
            )
            .fetch_one(&pool)
            .await
            .unwrap()
                == serde_json::json!({ "thread": "" })
        }
    };
    let (ws, _) = db.seed_workspace("whatsapp-erasure").await;
    let insert = |kind: &'static str, payload: serde_json::Value| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            sqlx::query(
                "insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at)                  values($1,$2,'meta',$3,$4,$5,now())",
            )
            .bind(Uuid::now_v7())
            .bind(ws.as_uuid())
            .bind(Uuid::now_v7().to_string())
            .bind(kind)
            .bind(payload)
            .execute(tx.conn())
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }
    };

    assert!(current().await);
    // A Messenger echo is not the app's: the down still runs, twice over, and the up again.
    insert(
        "message_echo",
        serde_json::json!({ "messaging": { "mid": "m" } }),
    )
    .await;
    for _ in 0..2 {
        run(&down).await.unwrap();
        assert!(!current().await);
    }
    for _ in 0..2 {
        run(&up).await.unwrap();
        assert!(current().await);
    }
    // Each of the app's events refuses the down, which then changes nothing.
    for (kind, payload) in [
        ("history", serde_json::json!({ "thread": "905321234567" })),
        ("contact_sync", serde_json::json!({ "state_sync": {} })),
        (
            "message_echo",
            serde_json::json!({ "echo": { "to": "905321234567" } }),
        ),
    ] {
        let fresh = TestDb::new().await;
        let (ws, _) = fresh.seed_workspace("app-event").await;
        let mut tx = TenantTx::begin(&fresh.pool, ws).await.unwrap();
        sqlx::query(
            "insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at)              values($1,$2,'meta','app-event',$3,$4,now())",
        )
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(kind)
        .bind(payload)
        .execute(tx.conn())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let refused = sqlx::raw_sql(&down)
            .execute(&fresh.pool)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("whatsapp erasure rollback refused"),
            "{kind}: {refused}"
        );
        let still: serde_json::Value =
            sqlx::query_scalar("select inbox_mask_personal('{\"thread\":\"x\"}')")
                .fetch_one(&fresh.pool)
                .await
                .unwrap();
        assert_eq!(still, serde_json::json!({ "thread": "" }), "{kind}");
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
    // Newest first: the mail files and the leads tables reference the inbox tables, the planned
    // posts the materials library and the Studio tables, the materials library the Studio tables,
    // the public items and the call tables the inbox tables.
    project_tables_down(&db.pool).await;
    material_tables_down(&db.pool).await;
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0028_mail_files.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0027_distribution.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0026_outreach.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0022_studio_posts.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0021_studio_materials.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0020_prospects.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0019_inbox_public.down.sql"
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
    // Newest first: the mail files and the leads tables reference the inbox tables, the planned
    // posts the materials library and the Studio tables, the materials library the Studio tables.
    project_tables_down(&db.pool).await;
    material_tables_down(&db.pool).await;
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0028_mail_files.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0027_distribution.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0026_outreach.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0022_studio_posts.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0021_studio_materials.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0020_prospects.down.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/0019_inbox_public.down.sql"
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
    // The materials library references the Studio tables, the planned posts both, public
    // subjects Studio publications: reverted first, newest first, and applied again last.
    let materials_up = include_str!("../../../../migrations/0021_studio_materials.up.sql");
    let materials_down = include_str!("../../../../migrations/0021_studio_materials.down.sql");
    let posts_up = include_str!("../../../../migrations/0022_studio_posts.up.sql");
    let posts_down = include_str!("../../../../migrations/0022_studio_posts.down.sql");
    let public_up = include_str!("../../../../migrations/0019_inbox_public.up.sql");
    let public_down = include_str!("../../../../migrations/0019_inbox_public.down.sql");
    let id = Uuid::now_v7();
    let h = Uuid::now_v7();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("insert into strategy_versions(id,workspace_id,number,status,sections,created_by_component,created_at) values($1,$2,1,'draft','{}','test','2026-10-24T00:00:00Z')").bind(id).bind(ws.as_uuid()).execute(tx.conn()).await.unwrap();
    sqlx::query("insert into strategy_hypotheses(version_id,workspace_id,hypothesis_id,title,segment_key,angle,channel,metric,prior_confidence,state,position) values($1,$2,$3,'keep','all','help','any','reply',0.7,'added',0)").bind(id).bind(ws.as_uuid()).bind(h).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    project_tables_down(&db.pool).await;
    material_tables_down(&db.pool).await;
    for sql in [
        posts_down,
        materials_down,
        up,
        public_down,
        down,
        down,
        up,
        up,
        public_up,
        materials_up,
        posts_up,
        include_str!("../../../../migrations/0029_material_intelligence.up.sql"),
        include_str!("../../../../migrations/0030_material_productions.up.sql"),
        include_str!("../../../../migrations/0031_production_projects.up.sql"),
    ] {
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

/// Reverts `0028_mail_files` (its rows reference `messages`, `people` and `capabilities`) and
/// `0026_outreach`, whose enrollments reference the pool's prospects: every test that runs an
/// older down runs this one first.
async fn outreach_down(pool: &PgPool) {
    mail_files_down(pool).await;
    let down = std::fs::read_to_string(migrations_dir().join("0026_outreach.down.sql")).unwrap();
    try_run(pool, &down).await.unwrap();
    assert_eq!(table_count(pool).await, TABLES_BEFORE_OUTREACH);
}

/// Revert the project trigger extension before dropping the canonical posts table.
/// Historical full rollbacks remove this independent project table as well; narrower
/// library-side-table checks intentionally retain it in TABLES_AFTER_ALL-based counts.
async fn project_tables_down(pool: &PgPool) {
    let down = include_str!("../../../../migrations/0031_production_projects.down.sql");
    try_run(pool, down).await.unwrap();
}

/// Reverts the material side tables before their older library dependencies.
async fn material_tables_down(pool: &PgPool) {
    for name in ["0030_material_productions", "0029_material_intelligence"] {
        let down =
            std::fs::read_to_string(migrations_dir().join(format!("{name}.down.sql"))).unwrap();
        try_run(pool, &down).await.unwrap();
    }
}

/// Reverts `0028_mail_files` after removing newer material side tables.
async fn mail_files_down(pool: &PgPool) {
    material_tables_down(pool).await;
    let down = std::fs::read_to_string(migrations_dir().join("0028_mail_files.down.sql")).unwrap();
    try_run(pool, &down).await.unwrap();
    assert_eq!(table_count(pool).await, TABLES_BEFORE_MAIL_FILES);
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
    insert_blocklisted_kind(pool, ws, "phone", reason, expires).await
}

/// [`insert_blocklisted`] of a key of `kind`.
async fn insert_blocklisted_kind(
    pool: &PgPool,
    ws: Uuid,
    kind: &str,
    reason: &str,
    expires: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = PlatformTx::begin(pool).await.unwrap();
    sqlx::query(
        "insert into prospect_blocklist (workspace_id, kind, key_hash, reason, created_at, expires_at, \
         key_fingerprint) values ($1, $2, $3, $4, now(), case when $5 then now() + interval '1 day' end, \
         '0123456789abcdef')",
    )
    .bind(ws)
    .bind(kind)
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
    outreach_down(&db.pool).await;
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
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH);
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
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH - 5);
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
    assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH);
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
    outreach_down(&db.pool).await;
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
            TABLES_BEFORE_OUTREACH,
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
    assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH - 5);
}

#[tokio::test]
async fn prospects_down_keeps_a_leads_policy_a_workspace_set() {
    let db = TestDb::new().await;
    outreach_down(&db.pool).await;
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
async fn blocklist_holds_hard_keys_only() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("prospect-blocklist-hard").await;
    let ws = ws.as_uuid();
    for kind in ["phone", "email", "instagram", "tiktok"] {
        insert_blocklisted_kind(&db.pool, ws, kind, "do_not_contact", false)
            .await
            .unwrap();
    }
    for soft in ["domain", "name_city"] {
        let err = insert_blocklisted_kind(&db.pool, ws, soft, "do_not_contact", false)
            .await
            .unwrap_err();
        assert!(
            err.as_database_error()
                .is_some_and(|e| e.constraint() == Some("prospect_blocklist_kind_check")),
            "{soft}: {err}"
        );
    }
}

#[tokio::test]
async fn a_prospect_is_decided_exactly_when_rejected_or_do_not_contact() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("prospect-decided").await;
    let insert = |status: &'static str, decided: bool| {
        let pool = db.pool.clone();
        let ws = ws.as_uuid();
        async move {
            let mut tx = PlatformTx::begin(&pool).await.unwrap();
            let done = sqlx::query(
                "insert into prospects (workspace_id, id, status, business_name, entity_kind, \
                 data, decided_at, created_at, updated_at) values ($1, $2, $3, 'Örnek Kafe', \
                 'legal_entity', '{}', case when $4 then now() end, now(), now())",
            )
            .bind(ws)
            .bind(Uuid::now_v7())
            .bind(status)
            .bind(decided)
            .execute(tx.conn())
            .await;
            tx.commit().await.unwrap();
            done.map(drop)
        }
    };
    for (status, decided) in [("new", false), ("qualified", false), ("rejected", true)] {
        insert(status, decided).await.unwrap();
    }
    for (status, decided) in [
        ("new", true),
        ("rejected", false),
        ("do_not_contact", false),
    ] {
        let err = insert(status, decided).await.unwrap_err();
        assert!(
            err.as_database_error()
                .is_some_and(|e| e.constraint() == Some("prospects_decided_check")),
            "{status}: {err}"
        );
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

/// The tables of `0027_distribution`, each with its one row-level policy.
const DISTRIBUTION_TABLES: [(&str, &str); 3] = [
    ("rep_profiles", "rep_profiles_ws"),
    ("distribution_rules", "distribution_rules_ws"),
    ("journey_assignments", "journey_assignments_ws"),
];

/// The indexes of `0027_distribution` beyond its primary keys and unique constraints.
const DISTRIBUTION_INDEXES: [&str; 4] = [
    "journey_assignments_live",
    "journey_assignments_sla",
    "journey_assignments_journey",
    "journey_assignments_log",
];

#[tokio::test]
async fn distribution_up_and_down_are_repeatable() {
    let db = TestDb::new().await; // already migrated up, 0021 included
    outreach_down(&db.pool).await;
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0027_distribution.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0027_distribution.down.sql")).unwrap();
    for _ in 0..2 {
        try_run(&db.pool, &up).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH);
    }
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH - 3);
        for index in DISTRIBUTION_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
        assert!(!function_exists(&db.pool, "journey_assignments_guard").await);
        assert!(!column_exists(&db.pool, ("people", "recipient_kind")).await);
    }
    try_run(&db.pool, &up).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH);
    assert!(column_exists(&db.pool, ("people", "recipient_kind")).await);
    assert!(function_exists(&db.pool, "journey_assignments_guard").await);
    for index in DISTRIBUTION_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    for (table, policy) in DISTRIBUTION_TABLES {
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
async fn distribution_down_keeps_a_recipient_kind_a_person_holds() {
    let db = TestDb::new().await;
    outreach_down(&db.pool).await;
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0027_distribution.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0027_distribution.down.sql")).unwrap();
    let (ws, _) = db.seed_workspace("distribution-kind-kept").await;
    let person = Uuid::now_v7();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query(
        "insert into people (workspace_id, id, display_name, company, first_touch, created_at, \
         updated_at, recipient_kind) values ($1, $2, 'Ornek', 'Ornek Kafe', \
         '{\"source\": \"form\", \"at\": \"2026-11-03T00:00:00Z\"}', now(), now(), 'business')",
    )
    .bind(ws.as_uuid())
    .bind(person)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_OUTREACH - 3);
        assert!(column_exists(&db.pool, ("people", "recipient_kind")).await);
    }
    try_run(&db.pool, &up).await.unwrap();
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    let kept: String =
        sqlx::query_scalar("select recipient_kind from people where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(person)
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(kept, "business");
}

/// The tables of `0026_outreach`, each with its one row-level policy.
const OUTREACH_TABLES: [(&str, &str); 4] = [
    ("outreach_templates", "outreach_templates_ws"),
    ("outreach_campaigns", "outreach_campaigns_ws"),
    ("outreach_enrollments", "outreach_enrollments_ws"),
    ("outreach_sends", "outreach_sends_ws"),
];

/// The indexes of `0026_outreach` beyond its primary keys and unique constraints.
const OUTREACH_INDEXES: [&str; 9] = [
    "outreach_templates_list",
    "outreach_campaigns_running",
    "outreach_campaigns_list",
    "outreach_enrollments_one_active",
    "outreach_enrollments_due",
    "outreach_sends_mailbox_day",
    "outreach_sends_campaign",
    "outreach_sends_domain",
    "outreach_sends_enrollment",
];

#[tokio::test]
async fn outreach_migration_is_repeatable_and_grants_only_the_system_owner_and_manager() {
    let db = TestDb::new().await; // already migrated up, 0022 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0026_outreach.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0026_outreach.down.sql")).unwrap();
    let as_strings =
        |keys: &[&str]| -> Vec<String> { keys.iter().map(|k| (*k).to_owned()).collect() };
    let keys = ["outreach.work", "outreach.manage"];
    let base = ["workspace.read", "prospects.work"];

    let (ws, other_ws) = (Uuid::now_v7(), Uuid::now_v7());
    let (owner, manager, rep, custom, custom_manager) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    for (id, name) in [(ws, "outreach"), (other_ws, "other")] {
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
            [&base[..], &["outreach.work"]].concat(),
        ),
        (rep, ws, "rep", true, vec!["workspace.read"]),
        (custom, ws, "outreach_lead", false, vec!["workspace.read"]),
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
    }

    // Down, twice: the four tables go, and the two keys leave the system owner and manager only
    // (the mail files, which name none of them, stay).
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 4);
        for index in OUTREACH_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
        for role in [owner, manager] {
            assert_eq!(role_permissions(&db.pool, role).await, as_strings(&base));
        }
        assert_eq!(role_permissions(&db.pool, rep).await, ["workspace.read"]);
    }

    // Up again: the tables are back, with their indexes, forced row-level security and exactly
    // one policy each.
    try_run(&db.pool, &up).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL);
    for index in OUTREACH_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }
    for (table, policy) in OUTREACH_TABLES {
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

/// An enrollment's checks: a stopped or skipped one names its reason, an active one its next
/// send, and a person is active in one campaign at most.
#[tokio::test]
async fn outreach_enrollment_checks_hold() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("outreach-checks").await;
    let ws = ws.as_uuid();
    let (mailbox, version, campaign, other_campaign, person) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let system = serde_json::json!({"system": {"component": "test"}});
    let mut tx = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query(
        "insert into capabilities (id, workspace_id, kind_key, name, reach, status, created_at, \
         updated_at) values ($1, $2, 'mailbox', 'Satis', 'connector', 'declared', now(), now())",
    )
    .bind(mailbox)
    .bind(ws)
    .execute(tx.conn())
    .await
    .unwrap();
    sqlx::query(
        "insert into strategy_versions (id, workspace_id, number, status, created_at, \
         created_by_component) values ($1, $2, 1, 'approved', now(), 'test')",
    )
    .bind(version)
    .bind(ws)
    .execute(tx.conn())
    .await
    .unwrap();
    for id in [campaign, other_campaign] {
        sqlx::query(
            "insert into outreach_campaigns (workspace_id, id, name, mailbox_id, status, \
             definition, revision, strategy_version_id, created_by, created_at, updated_at, \
             launched_at) values ($1, $2, 'Ekim', $3, 'running', '{}', 1, $4, $5, now(), now(), \
             now())",
        )
        .bind(ws)
        .bind(id)
        .bind(mailbox)
        .bind(version)
        .bind(&system)
        .execute(tx.conn())
        .await
        .unwrap();
    }
    sqlx::query(
        "insert into people (workspace_id, id, display_name, company, first_touch, created_at, \
         updated_at) values ($1, $2, 'Ornek', 'Ornek Kafe', \
         '{\"source\": \"form\", \"at\": \"2026-11-03T00:00:00Z\"}', now(), now())",
    )
    .bind(ws)
    .bind(person)
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let insert =
        |campaign: Uuid, status: &'static str, reason: Option<&'static str>, next: bool| {
            let pool = db.pool.clone();
            async move {
                let mut tx = PlatformTx::begin(&pool).await.unwrap();
                let result = sqlx::query(
                    "insert into outreach_enrollments (workspace_id, id, campaign_id, person_id, \
                 status, reason, next_send_at, enrolled_at) values ($1, $2, $3, $4, $5, $6, \
                 case when $7 then now() end, now())",
                )
                .bind(ws)
                .bind(Uuid::now_v7())
                .bind(campaign)
                .bind(person)
                .bind(status)
                .bind(reason)
                .bind(next)
                .execute(tx.conn())
                .await;
                if result.is_ok() {
                    tx.commit().await.unwrap();
                }
                result.map(|_| ()).map_err(|e| e.to_string())
            }
        };
    // Breaking a check: a stop without its reason, a reason on an active row, an active row
    // without its next send.
    for (status, reason, next) in [
        ("stopped", None, false),
        ("active", Some("replied"), true),
        ("active", None, false),
    ] {
        let err = insert(campaign, status, reason, next).await.unwrap_err();
        assert!(err.contains("outreach_enrollments"), "{err}");
    }
    insert(campaign, "active", None, true).await.unwrap();
    // A second active enrollment of the person, in another campaign, is refused; a skipped one
    // is kept.
    let err = insert(other_campaign, "active", None, true)
        .await
        .unwrap_err();
    assert!(err.contains("outreach_enrollments_one_active"), "{err}");
    insert(other_campaign, "skipped", Some("active_elsewhere"), false)
        .await
        .unwrap();
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
        assert!(constraint_exists(&db.pool, CONVERSATION_CAPABILITY_KEY).await);
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
        assert!(!constraint_exists(&db.pool, CONVERSATION_CAPABILITY_KEY).await);
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

/// `0025_inbox_public_erasure` puts the erasure additions of `0019_inbox_public` and
/// `0024_whatsapp_erasure` in one definition: once migrated up, the mask blanks a public item's
/// author and the provider's copy of it as well as a WhatsApp Business app thread; its down puts
/// back 0024's mask (the app's keys only), and both repeat.
#[tokio::test]
async fn inbox_public_erasure_joins_both_additions_and_repeats() {
    let db = TestDb::new().await; // already migrated up, 0025 included
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0025_inbox_public_erasure.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0025_inbox_public_erasure.down.sql")).unwrap();
    let mask = || {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, serde_json::Value>("select inbox_mask_personal($1)")
                .bind(serde_json::json!({
                    "thread": "905321234567",
                    "public": {"author": {"id": "5150"}, "text": "Fiyat?"},
                    "provider_item": {"id": "c-1"}
                }))
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let joined = serde_json::json!({
        "thread": "", "public": {"author": "", "text": ""}, "provider_item": ""
    });
    let whatsapp_only = serde_json::json!({
        "thread": "", "public": {"author": {"id": "5150"}, "text": ""},
        "provider_item": {"id": "c-1"}
    });
    assert_eq!(mask().await, joined);
    for _ in 0..2 {
        sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
        assert_eq!(mask().await, whatsapp_only);
    }
    for _ in 0..2 {
        sqlx::raw_sql(&up).execute(&db.pool).await.unwrap();
        assert_eq!(mask().await, joined);
    }
}

/// `0025_inbox_public_erasure`'s down is refused, changing nothing, once a comment or a question
/// is stored: the older functions it would put back could not find its author.
#[tokio::test]
async fn inbox_public_erasure_down_refuses_stored_public_items() {
    for kind in ["comment", "question"] {
        let db = TestDb::new().await;
        let down =
            std::fs::read_to_string(migrations_dir().join("0025_inbox_public_erasure.down.sql"))
                .unwrap();
        let (ws, _) = db.seed_workspace("public-event").await;
        let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
        sqlx::query(
            "insert into inbound_events(id,workspace_id,provider,external_id,kind,payload,received_at)              values($1,$2,'meta','public-event',$3,$4,now())",
        )
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(kind)
        .bind(serde_json::json!({"public": {"kind": kind, "author": {"id": "5150"}}}))
        .execute(tx.conn())
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let refused = sqlx::raw_sql(&down)
            .execute(&db.pool)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("inbox public erasure rollback refused"),
            "{refused}"
        );
        // Nothing changed: the joined mask still blanks a public item's author.
        let masked: serde_json::Value =
            sqlx::query_scalar("select inbox_mask_personal('{\"author\":{\"id\":\"5150\"}}')")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(masked, serde_json::json!({"author": ""}), "{kind}");
    }
}

/// The indexes of `0028_mail_files` beyond its primary key.
const MAIL_FILES_INDEXES: [&str; 3] = [
    "mail_files_message",
    "mail_files_expiry",
    "mail_files_event",
];

/// `0028_mail_files` applies again and reverts again, each twice; the table forces row-level
/// security under its one policy. Its down is refused, before anything changes, while an outbox
/// entry waiting to be sent (queued or held) names mail files in its email; one that was sent, or
/// that names none, does not hold it back.
#[tokio::test]
async fn mail_files_migration_is_repeatable_and_its_down_refuses_waiting_attachments() {
    let db = TestDb::new().await; // already migrated up
    material_tables_down(&db.pool).await;
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0028_mail_files.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0028_mail_files.down.sql")).unwrap();
    for _ in 0..2 {
        try_run(&db.pool, &up).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 2);
    }
    let forced: bool = sqlx::query_scalar(
        "select relrowsecurity and relforcerowsecurity from pg_class where relname = 'mail_files'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(forced);
    let policies: Vec<String> = sqlx::query_scalar(
        "select policyname::text from pg_policies where schemaname = current_schema() \
         and tablename = 'mail_files'",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(policies, ["mail_files_ws"]);
    for index in MAIL_FILES_INDEXES {
        assert!(index_exists(&db.pool, index).await, "{index}");
    }

    let (ws, cap, conversation, message) = inbox_rows(&db).await;
    let outbox = |state: &'static str, files: serde_json::Value| {
        let pool = db.pool.clone();
        async move {
            let id = Uuid::now_v7();
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            sqlx::query(
                "insert into outbox (workspace_id,id,conversation_id,message_id,capability_id,intent,\
                 expected_generation,state,created_at,updated_at) \
                 values ($1,$2,$3,$4,$5,$6,0,$7,now(),now())",
            )
            .bind(ws.as_uuid())
            .bind(id)
            .bind(conversation)
            .bind(message)
            .bind(cap)
            .bind(serde_json::json!({"mail": {"attachment_files": files}}))
            .bind(state)
            .execute(tx.conn())
            .await
            .unwrap();
            tx.commit().await.unwrap();
            id
        }
    };
    let set_state = |id: Uuid, state: &'static str| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            sqlx::query("update outbox set state = $3 where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(id)
                .bind(state)
                .execute(tx.conn())
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }
    };
    // Sent, or naming no file: nothing waits.
    outbox("sent", serde_json::json!([Uuid::now_v7()])).await;
    outbox("queued", serde_json::json!([])).await;
    for state in ["queued", "held"] {
        let waiting = outbox(state, serde_json::json!([Uuid::now_v7()])).await;
        let refused = try_run(&db.pool, &down).await.unwrap_err().to_string();
        assert!(refused.contains("mail files rollback refused"), "{refused}");
        assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 2);
        set_state(waiting, "refused").await;
    }
    for _ in 0..2 {
        try_run(&db.pool, &down).await.unwrap();
        assert_eq!(table_count(&db.pool).await, TABLES_BEFORE_MAIL_FILES);
        for index in MAIL_FILES_INDEXES {
            assert!(!index_exists(&db.pool, index).await, "{index}");
        }
    }
    try_run(&db.pool, &up).await.unwrap();
    assert_eq!(table_count(&db.pool).await, TABLES_AFTER_ALL - 2);
}
