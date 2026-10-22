//! Telling an ordinary role from one that row-level security does not bind.

use std::str::FromStr;

use jt_testkit::TestDb;
use jt_testkit::db::TEST_DATABASE_URL_VAR;
use sqlx::postgres::PgConnectOptions;

#[tokio::test]
async fn a_test_databases_own_role_is_bound_by_rls() {
    let db = TestDb::new().await;
    // `TestDb` connects as its own `NOSUPERUSER NOBYPASSRLS` role, as the application must.
    assert!(!jt_pg::role_bypasses_rls(&db.pool).await.unwrap());
    assert_eq!(jt_pg::current_role(&db.pool).await.unwrap(), db.name());
}

#[tokio::test]
async fn the_admin_connection_bypasses_rls() {
    // The administrator URL the tests run with is a superuser's (see rust/README.md).
    let url = std::env::var(TEST_DATABASE_URL_VAR).expect("the admin URL is set");
    let admin = PgConnectOptions::from_str(&url).unwrap();
    let pool = jt_pg::connect_with(admin.clone()).await.unwrap();
    assert!(jt_pg::role_bypasses_rls(&pool).await.unwrap());
    assert_eq!(
        jt_pg::current_role(&pool).await.unwrap(),
        admin.get_username()
    );
    pool.close().await;
}
