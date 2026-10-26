use jt_testkit::TestDb;
use sqlx::ConnectOptions;
use std::process::Command;

fn binary(db: &TestDb, command: &str) -> Command {
    let mut child = Command::new(env!("CARGO_BIN_EXE_jeeta"));
    child
        .current_dir(std::env::temp_dir())
        .env_clear()
        .env(
            "JEETA_DATABASE_URL",
            db.connect_options().to_url_lossy().as_str(),
        )
        .env("JEETA_SECRET_KEY", "01".repeat(32))
        .env("JEETA_METRICS_TOKEN", "test-token")
        .env("JEETA_PRICE_MINOR", "123")
        .env("JEETA_PRICE_CURRENCY", "TRY")
        .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
        .env("JEETA_ALLOW_TEST_LOOPBACK", "1")
        .arg(command);
    child
}

#[tokio::test]
async fn binary_refuses_newer_schema_before_listener_and_does_not_migrate_restore() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("restore").await;
    jt_pg::recovery::seed_canary(&db.pool, ws, &jt_seal::AesSecretBox::new([1; 32]))
        .await
        .unwrap();
    let good = binary(&db, "recovery-verify").output().unwrap();
    assert!(
        good.status.success(),
        "{}",
        String::from_utf8_lossy(&good.stderr)
    );
    assert_eq!(good.stdout, b"recovery: passed\n");
    assert!(good.stderr.is_empty());
    let wrong = binary(&db, "recovery-verify")
        .env("JEETA_SECRET_KEY", "02".repeat(32))
        .output()
        .unwrap();
    assert!(!wrong.status.success());
    assert_eq!(wrong.stdout, b"recovery: canary_failed\n");
    sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(999999,'future',true,'',0)").execute(&db.pool).await.unwrap();
    let newer = binary(&db, "recovery-verify").output().unwrap();
    assert!(!newer.status.success());
    assert_eq!(newer.stdout, b"recovery: schema_failed\n");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut serving = binary(&db, "serve");
    let files = std::env::temp_dir().join(format!("jeeta-restore-files-{}", db.name()));
    std::fs::create_dir(&files).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&files, std::fs::Permissions::from_mode(0o700)).unwrap();
    serving
        .env("JEETA_FILES_DIR", &files)
        .env("JEETA_PUBLIC_BASE_URL", "https://example.test")
        .env("JEETA_BIND", address.to_string())
        .env("JEETA_JOBS_ENABLED", "false");
    let mut child = serving
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        assert!(
            std::net::TcpStream::connect(address).is_err(),
            "newer schema opened listener"
        );
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("serve did not refuse schema");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let out = child.wait_with_output().unwrap();
    assert!(!String::from_utf8_lossy(&out.stderr).contains("listening"));
    std::fs::remove_dir(files).unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=999999 OR version=(SELECT max(version) FROM _sqlx_migrations WHERE version<>999999)").execute(&db.pool).await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let older = binary(&db, "recovery-verify").output().unwrap();
    assert!(!older.status.success());
    assert_eq!(older.stdout, b"recovery: schema_failed\n");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(before, after, "verification must not migrate");
}
