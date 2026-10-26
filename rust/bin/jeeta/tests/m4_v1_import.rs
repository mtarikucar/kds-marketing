use jt_testkit::TestDb;
use sqlx::ConnectOptions;
use std::{fs, os::unix::fs::symlink, process::Command};
const FIXTURE: &str = include_str!("../../../scripts/tests/fixtures/v1-import/lead.jsonl");

struct Input(std::path::PathBuf);
impl Input {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "v1-import-test-{}-{}",
            std::process::id(),
            jt_tenancy::WorkspaceId::new_v7()
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn command(input: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_jeeta"));
    c.args([
        "import-v1-leads",
        "--workspace",
        "00000000-0000-0000-0000-000000000001",
        "--input",
    ])
    .arg(input)
    .env_remove("JEETA_DATABASE_URL")
    .env_remove("JEETA_SECRET_KEY");
    c
}
fn output(c: &mut Command, success: bool, category: &str) {
    let out = c.output().unwrap();
    assert_eq!(
        out.status.success(),
        success,
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(text.contains(category), "{text}");
    for forbidden in [
        "PII_CANARY_ONLY_SYNTHETIC_73",
        "synthetic@example.test",
        "05321234567",
        "Synthetic Contact",
    ] {
        assert!(!text.contains(forbidden));
    }
}
#[test]
fn refuses_symlink_directory_fifo_and_invalid_input_without_echoing_values() {
    let dir = Input::new();
    let file = dir.0.join("leads.jsonl");
    fs::write(&file, FIXTURE).unwrap();
    let link = dir.0.join("link");
    symlink(&file, &link).unwrap();
    output(&mut command(&link), false, "input_refused");
    output(&mut command(&dir.0), false, "input_refused");
    let fifo = dir.0.join("fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    output(&mut command(&fifo), false, "input_refused");
    fs::write(&file, "PII_CANARY_ONLY_SYNTHETIC_73").unwrap();
    output(&mut command(&file), false, "input_invalid");
    output(
        command(&file).arg("PII_CANARY_ONLY_SYNTHETIC_73"),
        false,
        "arguments_invalid",
    );
}
#[tokio::test]
async fn binary_checks_schema_and_emits_counts_only() {
    let db = TestDb::new().await;
    let (ws, _) = db.seed_workspace("cli import").await;
    let dir = Input::new();
    let file = dir.0.join("leads.jsonl");
    fs::write(&file, FIXTURE).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_jeeta"));
    command
        .args(["import-v1-leads", "--workspace", &ws.to_string(), "--input"])
        .arg(&file)
        .env(
            "JEETA_DATABASE_URL",
            db.connect_options().to_url_lossy().as_str(),
        )
        .env("JEETA_SECRET_KEY", "11".repeat(32));
    let guard = jt_app::ports::v1_import::ImportStore::lock_run(
        &jt_pg::v1_import::PgImportStore(db.pool.clone()),
        ws,
    )
    .await
    .unwrap();
    output(&mut command, false, "already_running");
    guard.release().await.unwrap();
    output(&mut command, true, "\"imported\":1");
    output(&mut command, true, "\"already_present\":1");
    sqlx::query("update _sqlx_migrations set checksum='' where version=1")
        .execute(&db.pool)
        .await
        .unwrap();
    output(&mut command, false, "schema_failed");
    let mut tx = jt_pg::TenantTx::begin(&db.pool, ws).await.unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from people where workspace_id=$1")
        .bind(ws.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(n, 1);
}
