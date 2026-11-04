//! Deployment contracts exercise real children and disposable, ordinary-role databases.
//! Build the package-scoped release candidate first; this test never invokes Cargo recursively.
use jt_app::{
    ctx::Ctx,
    ports::{JobGuard, JobLock},
    usecases::api_keys::{self, CreateKey},
};
use jt_testkit::{
    TestDb,
    fakes::{FakeJobLock, InMemoryUow, deps},
};
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

// Exercise the production scheduler with controlled ports, retaining its existing unit tests.
#[allow(dead_code)]
#[path = "../src/config.rs"]
mod config;
#[allow(dead_code)]
#[path = "../src/scheduler.rs"]
mod scheduler;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("t066-{}", jt_tenancy::WorkspaceId::new_v7()));
        std::fs::create_dir(&p).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn command(binary: &Path, db: &str, dir: &Temp, mode: &str) -> Command {
    let mut c = Command::new(binary);
    c.current_dir(&dir.0)
        .env_clear()
        .env("JEETA_DATABASE_URL", db)
        .env("JEETA_SECRET_KEY", "ab".repeat(32))
        .env("JEETA_PRICE_MINOR", "123")
        .env("JEETA_PRICE_CURRENCY", "TRY")
        .env("JEETA_BANK_INSTRUCTIONS", "synthetic")
        .env("JEETA_METRICS_TOKEN", "synthetic")
        .env("JEETA_FILES_DIR", &dir.0)
        .env("JEETA_PUBLIC_BASE_URL", "https://panel.example.test")
        .env("JEETA_BIND", "127.0.0.1:0")
        .env("JEETA_JOBS_ENABLED", "false")
        .env("JEETA_LOG_FORMAT", "json")
        .arg(mode)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}
fn debug_command(db: &TestDb, dir: &Temp, mode: &str) -> Command {
    let mut c = command(
        Path::new(env!("CARGO_BIN_EXE_jeeta")),
        db.connect_options().to_url_lossy().as_str(),
        dir,
        mode,
    );
    c.env("JEETA_ALLOW_TEST_LOOPBACK", "1");
    c
}
async fn failed(mut c: Command) -> String {
    let out = tokio::time::timeout(Duration::from_secs(20), c.output())
        .await
        .expect("child hung")
        .unwrap();
    assert!(!out.status.success());
    String::from_utf8(out.stderr).unwrap()
}
async fn empty(db: &TestDb) {
    // Only this TestDb's disposable schema, never the administrator's database.
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        .execute(&db.pool)
        .await
        .unwrap();
}
async fn migrations(db: &TestDb) -> Vec<(i64, Vec<u8>)> {
    sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations WHERE success ORDER BY version")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}
async fn no_migrations(db: &TestDb) {
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    );
}
struct Server {
    child: Child,
    log: tokio::task::JoinHandle<String>,
}
impl Server {
    async fn start(mut c: Command) -> Self {
        let mut child = c.spawn().unwrap();
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        let mut prefix = String::new();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .unwrap_or_else(|| panic!("boot failed: {prefix}"));
                prefix.push_str(&line);
                prefix.push('\n');
                if line.contains("jeeta is listening") {
                    break;
                }
            }
        })
        .await
        .expect("boot timed out");
        let log = tokio::spawn(async move {
            while let Some(line) = lines.next_line().await.unwrap() {
                prefix.push_str(&line);
                prefix.push('\n');
            }
            prefix
        });
        Self { child, log }
    }
    /// SIGTERM as soon as the child says it listens: from that line on it must drain and exit 0.
    /// A failure shows the child's status (`signal: 15` is SIGTERM's default action: no handler
    /// yet) and its log.
    async fn stop(mut self) -> String {
        let pid = self.child.id().unwrap();
        assert!(
            std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        );
        let status = tokio::time::timeout(Duration::from_secs(45), self.child.wait()).await;
        if status.is_err() {
            self.child.kill().await.unwrap();
        }
        let log = self.log.await.unwrap();
        let status = status
            .unwrap_or_else(|_| panic!("shutdown exceeded HTTP + job grace:\n{log}"))
            .unwrap();
        assert!(status.success(), "{status}:\n{log}");
        log
    }
}

#[tokio::test]
async fn boot_role_check_precedes_migrations() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    empty(&db).await;
    let admin = std::env::var("JEETA_TEST_DATABASE_URL").unwrap();
    let opts: sqlx::postgres::PgConnectOptions = admin.parse().unwrap();
    for bypass in [false, true] {
        let mut c = debug_command(&db, &dir, "serve");
        if bypass {
            let mut conn = sqlx::PgConnection::connect(&admin).await.unwrap();
            sqlx::query(&format!("ALTER ROLE {} BYPASSRLS", db.name()))
                .execute(&mut conn)
                .await
                .unwrap();
        } else {
            c.env(
                "JEETA_DATABASE_URL",
                opts.clone().database(db.name()).to_url_lossy().as_str(),
            );
        }
        let log = failed(c).await;
        assert!(log.contains("startup failed"), "{log}");
        assert!(!log.contains("jeeta is listening"));
        assert!(!log.contains("scheduled jobs started"));
        no_migrations(&db).await;
    }
}

#[tokio::test]
async fn migration_failure_never_starts_listener_or_jobs() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    empty(&db).await;
    // A conflicting relation makes the first up migration fail, inside its transaction.
    sqlx::query("CREATE VIEW workspaces AS SELECT 1 AS incompatible")
        .execute(&db.pool)
        .await
        .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut c = debug_command(&db, &dir, "serve");
    c.env("JEETA_BIND", port.to_string())
        .env("JEETA_JOBS_ENABLED", "true");
    let log = failed(c).await;
    assert!(log.contains("startup failed"), "{log}");
    assert!(!log.contains("rebuilt the tenant egress tier"));
    assert!(!log.contains("jeeta is listening"));
    assert!(!log.contains("scheduled jobs started"));
    assert!(std::net::TcpListener::bind(port).is_ok());
    assert!(migrations(&db).await.is_empty());
}

#[tokio::test]
async fn boot_applies_pending_migrations_once() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    empty(&db).await;
    // Hold the very lock sqlx uses: no child may create the migration table
    // before it owns that lock. This deterministically covers the catalog race.
    use sqlx::migrate::Migrate;
    let mut migration_lock = db.pool.acquire().await.unwrap().detach();
    migration_lock.lock().await.unwrap();
    let a = tokio::spawn(Server::start(debug_command(&db, &dir, "serve")));
    let b = tokio::spawn(Server::start(debug_command(&db, &dir, "serve")));
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiters: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'")
                .fetch_one(&db.pool).await.unwrap();
            if waiters > 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("children never reached the migration lock");
    no_migrations(&db).await;
    migration_lock.unlock().await.unwrap();
    let (a, b) = (a.await.unwrap(), b.await.unwrap());
    let expected: Vec<_> = jt_pg::migrator()
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .map(|m| (m.version, m.checksum.to_vec()))
        .collect();
    assert_eq!(migrations(&db).await, expected);
    let before: Vec<(i64, String)> =
        sqlx::query_as("SELECT version, installed_on::text FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    a.stop().await;
    b.stop().await;
    let log = Server::start(debug_command(&db, &dir, "serve"))
        .await
        .stop()
        .await;
    assert!(
        log.lines()
            .any(|l| l.contains("migrations are up to date") && l.contains("\"applied\":0")),
        "{log}"
    );
    let after: Vec<(i64, String)> =
        sqlx::query_as("SELECT version, installed_on::text FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
}

async fn key(db: &TestDb) -> String {
    let (ws, user) = db.seed_workspace("deployment").await;
    use jt_app::ports::UnitOfWork;
    let uow = jt_pg::PgUnitOfWork::new(db.pool.clone());
    let mut r = uow.tenant(ws).await.unwrap();
    let now = time::OffsetDateTime::now_utc();
    r.strategy()
        .insert(jt_strategy::StrategyVersion {
            id: jt_strategy::StrategyVersionId::new_v7(),
            workspace_id: ws,
            number: 1,
            status: jt_strategy::VersionStatus::Approved,
            sections: Default::default(),
            created_at: now,
            created_by: jt_ledger::Actor::Human { user_id: user },
            submitted_at: Some(now),
            approved_at: Some(now),
            approved_by: Some(user),
            archived_at: None,
        })
        .await
        .unwrap();
    // A compromised stored capability must not admit loopback into the release tenant tier.
    let cap = jt_capability::Capability::new(
        jt_capability::CapabilityId::new_v7(),
        ws,
        jt_capability::NewCapability {
            kind_key: "x".into(),
            key_detail: None,
            name: "synthetic".into(),
            description: String::new(),
            external_id: Some("synthetic".into()),
            connector_public: json!({"hosts":["127.0.0.1"]}),
            policy: Default::default(),
        },
        now,
    )
    .unwrap();
    r.capabilities().insert(cap, None).await.unwrap();
    r.commit().await.unwrap();

    let mut d = deps(Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone())));
    d.tokens = Arc::new(jt_app::std_impls::RandTokenGen);
    d.clock = Arc::new(jt_app::std_impls::SystemClock);
    api_keys::create(
        &d,
        &Ctx {
            workspace_id: ws,
            actor: jt_ledger::Actor::Human { user_id: user },
            permissions: jt_tenancy::SystemRole::Owner.permissions(),
            role_key: Some("owner".into()),
            now: time::OffsetDateTime::now_utc(),
            agent_connection_id: None,
        },
        CreateKey {
            name: "deployment".into(),
            scopes: vec![],
        },
    )
    .await
    .unwrap()
    .plaintext
}
async fn rpc(
    input: &mut tokio::process::ChildStdin,
    output: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    request: Value,
) -> Value {
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let line = tokio::time::timeout(Duration::from_secs(10), output.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(&line).unwrap()
}
async fn stdio_session(mut c: Command, media: Option<String>) -> String {
    let mut child = c.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let stderr = child.stderr.take().unwrap();
    let logs = tokio::spawn(async move {
        let mut log = String::new();
        BufReader::new(stderr)
            .read_to_string(&mut log)
            .await
            .unwrap();
        log
    });
    let init = rpc(&mut input, &mut output, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"deployment-test","version":"1"}}})).await;
    assert!(init.get("result").is_some(), "{init}");
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let list = rpc(
        &mut input,
        &mut output,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await;
    assert!(
        list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "jeeta.studio.file_upload")
    );
    if let Some(url) = media {
        let result = rpc(&mut input, &mut output, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"jeeta.studio.file_upload","arguments":{"request_key":"loopback-refusal","filename":"synthetic.png","mime":"image/png","content":{"kind":"source_url","url":url}}}})).await;
        assert_eq!(result["result"]["isError"], true, "{result}");
        assert!(result.to_string().contains("invalid media"), "{result}");
    }
    drop(input);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    logs.await.unwrap()
}
#[tokio::test]
async fn stdio_never_migrates_or_runs_jobs() {
    let db = TestDb::new().await;
    let dir = Temp::new();
    let token = key(&db).await;
    let before = migrations(&db).await;
    let mut c = debug_command(&db, &dir, "mcp-stdio");
    c.env("JEETA_STDIO_API_KEY", token)
        .env("JEETA_JOBS_ENABLED", "true");
    let log = stdio_session(c, None).await;
    assert!(log.contains("serving MCP over stdio"));
    assert!(!log.contains("scheduled jobs"));
    assert!(!log.contains("jeeta is listening"));
    assert_eq!(migrations(&db).await, before);
    empty(&db).await;
    let mut c = debug_command(&db, &dir, "mcp-stdio");
    c.env("JEETA_STDIO_API_KEY", "jt_live_synthetic")
        .env("JEETA_JOBS_ENABLED", "true");
    let log = failed(c).await;
    assert!(log.contains("startup failed"), "{log}");
    assert!(!log.contains("scheduled jobs"));
    no_migrations(&db).await;
}

#[tokio::test]
async fn provider_apps_require_public_url_and_complete_credentials() {
    let dir = Temp::new();
    for group in [
        vec![
            "JEETA_META_APP_ID",
            "JEETA_META_APP_SECRET",
            "JEETA_META_VERIFY_TOKEN",
        ],
        vec!["JEETA_INSTAGRAM_APP_ID", "JEETA_INSTAGRAM_APP_SECRET"],
        vec!["JEETA_X_CLIENT_ID", "JEETA_X_CLIENT_SECRET"],
        vec!["JEETA_TIKTOK_CLIENT_KEY", "JEETA_TIKTOK_CLIENT_SECRET"],
        vec!["JEETA_LINKEDIN_CLIENT_ID", "JEETA_LINKEDIN_CLIENT_SECRET"],
    ] {
        for missing in 0..=group.len() {
            let mut c = command(
                Path::new(env!("CARGO_BIN_EXE_jeeta")),
                "postgres://synthetic@127.0.0.1:1/unused",
                &dir,
                "serve",
            );
            for (i, name) in group.iter().enumerate() {
                if i != missing {
                    c.env(name, "synthetic");
                }
            }
            if missing == group.len() {
                c.env_remove("JEETA_PUBLIC_BASE_URL");
            }
            let log = failed(c).await;
            let expected = if missing == group.len() {
                "JEETA_PUBLIC_BASE_URL"
            } else {
                group[missing]
            };
            assert!(log.contains(expected), "{log}");
            assert!(!log.contains("cannot connect to the database"));
        }
    }
}

async fn http_get(address: std::net::SocketAddr, route: &str) -> (u16, Vec<u8>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(
                format!("GET {route} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        let boundary = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let headers = std::str::from_utf8(&response[..boundary]).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, response[boundary + 4..].to_vec())
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn production_build_refuses_test_loopback() {
    let release = std::env::var_os("JEETA_RELEASE_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/release/jeeta")
        });
    assert!(
        release.is_file(),
        "build once with cargo build --release --locked -p jeeta; set JEETA_RELEASE_BINARY if using a custom target directory"
    );
    let db = TestDb::new().await;
    let dir = Temp::new();
    // Starting WITHOUT the escape hatch proves this binary was not feature-unified.
    let panel = std::env::var_os("JEETA_RELEASE_PANEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../panel/dist"));
    let index = std::fs::read(panel.join("index.html")).expect("build the matching panel first");
    let address = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let mut c = command(
        &release,
        db.connect_options().to_url_lossy().as_str(),
        &dir,
        "serve",
    );
    c.env("JEETA_BIND", address.to_string())
        .env("JEETA_PANEL_DIR", &panel);
    let server = Server::start(c).await;
    let (status, body) = http_get(address, "/").await;
    assert_eq!(status, 200);
    assert_eq!(body, index);
    // Every built asset is served from the same candidate, byte for byte.
    for entry in std::fs::read_dir(panel.join("assets")).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let route = format!("/assets/{}", path.file_name().unwrap().to_str().unwrap());
            let (status, body) = http_get(address, &route).await;
            assert_eq!(status, 200);
            assert_eq!(body, std::fs::read(path).unwrap());
        }
    }
    assert_eq!(http_get(address, "/readyz").await.0, 200);
    assert_eq!(http_get(address, "/api/auth/me").await.0, 401);
    assert_eq!(http_get(address, "/mcp").await.0, 401);
    let log = server.stop().await;
    assert!(!log.contains("test-loopback"), "{log}");
    let token = key(&db).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut c = command(
        &release,
        db.connect_options().to_url_lossy().as_str(),
        &dir,
        "mcp-stdio",
    );
    // The runtime override cannot enable a compile-time feature in the release binary.
    c.env("JEETA_ALLOW_TEST_LOOPBACK", "1")
        .env("JEETA_STDIO_API_KEY", token);
    stdio_session(
        c,
        Some(format!(
            "http://{}/image.png",
            listener.local_addr().unwrap()
        )),
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    if jt_outbound::TEST_LOOPBACK_ENABLED {
        let database_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let c = command(
            Path::new(env!("CARGO_BIN_EXE_jeeta")),
            &format!(
                "postgres://synthetic@{}/unused",
                database_listener.local_addr().unwrap()
            ),
            &dir,
            "serve",
        );
        assert!(failed(c).await.contains("startup failed"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), database_listener.accept())
                .await
                .is_err(),
            "a contaminated binary must refuse before connecting"
        );
    }
}

struct SlowLock {
    calls: AtomicUsize,
    released: Arc<AtomicUsize>,
    proceed: tokio::sync::Semaphore,
}
struct Guard(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl JobGuard for Guard {
    async fn release(self: Box<Self>) -> Result<(), jt_app::error::AppError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait::async_trait]
impl JobLock for SlowLock {
    async fn try_acquire(
        &self,
        _: &str,
    ) -> Result<Option<Box<dyn JobGuard>>, jt_app::error::AppError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.proceed.acquire().await.unwrap().forget();
        Ok(Some(Box::new(Guard(self.released.clone()))))
    }
}
#[tokio::test]
async fn shutdown_stops_new_jobs_then_drains_existing() {
    let lock = Arc::new(SlowLock {
        calls: AtomicUsize::new(0),
        released: Arc::new(AtomicUsize::new(0)),
        proceed: tokio::sync::Semaphore::new(0),
    });
    let mut d = deps(Arc::new(InMemoryUow::new()));
    d.job_lock = lock.clone();
    let jobs = scheduler::spawn(
        Arc::new(d),
        scheduler::Intervals {
            refresh_tokens: Duration::from_millis(1),
            first_run_jitter: Duration::ZERO,
            ..Default::default()
        },
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        while lock.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    jobs.stopper()();
    let started = lock.calls.load(Ordering::SeqCst);
    assert_eq!(lock.released.load(Ordering::SeqCst), 0);
    // Companion scheduler tests below cover a counted in-flight Run and forced abortion.
    lock.proceed.add_permits(started);
    assert_eq!(scheduler::SHUTDOWN_GRACE, Duration::from_secs(30));
    tokio::time::timeout(
        Duration::from_secs(3),
        jobs.shutdown(scheduler::SHUTDOWN_GRACE),
    )
    .await
    .unwrap();
    assert_eq!(lock.calls.load(Ordering::SeqCst), started);
    assert_eq!(lock.released.load(Ordering::SeqCst), started);
}
#[tokio::test]
async fn jobs_disabled_has_no_background_provider_calls() {
    let vars: HashMap<String, String> = [
        (
            "JEETA_DATABASE_URL",
            "postgres://synthetic@localhost/unused".into(),
        ),
        ("JEETA_SECRET_KEY", "ab".repeat(32)),
        ("JEETA_PRICE_MINOR", "123".into()),
        ("JEETA_PRICE_CURRENCY", "TRY".into()),
        ("JEETA_BANK_INSTRUCTIONS", "synthetic".into()),
        ("JEETA_JOBS_ENABLED", "false".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    let lock = FakeJobLock::new();
    let mut d = deps(Arc::new(InMemoryUow::new()));
    d.job_lock = Arc::new(lock.clone());
    let jobs = scheduler::start(&config::Config::from_map(&vars).unwrap(), Arc::new(d));
    assert_eq!(jobs.job_count(), 0);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // All provider jobs require a lock before dispatch; none can reach a provider.
    assert!(lock.granted().is_empty());
    jobs.shutdown(scheduler::SHUTDOWN_GRACE).await;
    let db = TestDb::new().await;
    let dir = Temp::new();
    let log = Server::start(debug_command(&db, &dir, "serve"))
        .await
        .stop()
        .await;
    assert!(log.contains("scheduled jobs are disabled"));
    assert!(!log.contains("scheduled jobs started"));
}
