//! Migrations are reversible pairs, and the whole set round-trips up → down → up.

use std::path::{Path, PathBuf};

use jt_testkit::TestDb;
use sqlx::PgPool;

/// Tables in `public`, sqlx's own bookkeeping table excluded.
async fn table_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_tables where schemaname = 'public' and tablename <> '_sqlx_migrations'",
    )
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
    assert_eq!(table_count(&db.pool).await, 10);

    jt_pg::migrate_down_all(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 0);

    jt_pg::migrate_down_all(&db.pool).await.unwrap(); // down twice is a no-op
    assert_eq!(table_count(&db.pool).await, 0);

    jt_pg::migrate_up(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 10);
}

#[tokio::test]
async fn up_and_down_scripts_are_idempotent_on_their_own() {
    let db = TestDb::new().await; // already migrated up
    let dir = migrations_dir();
    let up = std::fs::read_to_string(dir.join("0001_foundation.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0001_foundation.down.sql")).unwrap();

    // Re-running `up` over an applied schema changes nothing.
    sqlx::raw_sql(&up).execute(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 10);

    // `down` twice: the second run is a no-op, and the trigger function is gone too.
    sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
    sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
    assert_eq!(table_count(&db.pool).await, 0);
    let functions: i64 = sqlx::query_scalar(
        "select count(*) from pg_proc where proname = 'ledger_entries_immutable'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(functions, 0);
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
    assert!(!ups.is_empty(), "no *.up.sql files in {}", dir.display());

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
