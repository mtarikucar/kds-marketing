//! The program itself (`CARGO_BIN_EXE_jeeta-device-bridge`): how it exits, and that it registers.
//!
//! On Unix a running bridge is stopped with `SIGTERM` and must exit cleanly. On Windows its stop
//! events (Ctrl+Break and the like) can only be sent through `GenerateConsoleCtrlEvent`, an
//! `unsafe` call the workspace forbids (`unsafe_code = "forbid"`), so there the running bridge is
//! only shown to register, then killed.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::json;
use uuid::Uuid;

const KEY: &str = "jdb_PROGRAM-K3Y-never-printed";
const PROGRAM: &str = env!("CARGO_BIN_EXE_jeeta-device-bridge");

/// A configuration file in the temp directory, removed when dropped.
struct ConfigFile(PathBuf);

impl ConfigFile {
    fn new(text: &str) -> ConfigFile {
        let path = std::env::temp_dir().join(format!("jdb-program-{}.toml", Uuid::now_v7()));
        std::fs::write(&path, text).unwrap();
        ConfigFile(path)
    }
}

impl Drop for ConfigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn program(config: &ConfigFile) -> Command {
    let mut command = Command::new(PROGRAM);
    command
        .arg(&config.0)
        .env_remove("JEETA_DEVICE_BRIDGE_KEY")
        .env("JEETA_DEVICE_BRIDGE_LOG", "debug");
    command
}

#[test]
fn a_configuration_that_cannot_be_used_exits_2_without_the_key() {
    // Plain http to another computer would send the key in the clear: refused.
    let config = ConfigFile::new(&format!(
        "base_url = \"http://jeeta.example\"\nkey = \"{KEY}\"\n"
    ));
    let out = program(&config).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(printed.contains("base_url"), "{printed}");
    assert!(!printed.contains(KEY), "{printed}");

    // A file that is not there.
    let gone = ConfigFile(std::env::temp_dir().join(format!("jdb-none-{}.toml", Uuid::now_v7())));
    let out = program(&gone).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

/// The registers a minimal Jeeta was sent, each with whether it carried the key and the
/// request header.
type Registers = Arc<Mutex<Vec<bool>>>;

async fn register(State(seen): State<Registers>, headers: HeaderMap) -> Response {
    let carried = |name: &str, value: &str| {
        headers
            .get(name)
            .is_some_and(|v| v.as_bytes() == value.as_bytes())
    };
    let proper = carried("authorization", &format!("Bearer {KEY}"))
        && carried("x-requested-with", "jeeta-panel");
    seen.lock().unwrap().push(proper);
    if !proper {
        return StatusCode::FORBIDDEN.into_response();
    }
    axum::Json(json!({
        "phones": [], "refused": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 1,
    }))
    .into_response()
}

#[tokio::test]
async fn the_program_registers_and_stops_cleanly() {
    let seen = Registers::default();
    let app = Router::new()
        .route("/api/devices/bridge/register", post(register))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config = ConfigFile::new(&format!(
        "base_url = \"http://{addr}\"\nkey = \"{KEY}\"\nbridge_id = \"program-test\"\n"
    ));
    let mut child = program(&config)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    while seen.lock().unwrap().is_empty() {
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("the program never registered");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        seen.lock().unwrap()[0],
        "with the key and the request header"
    );

    #[cfg(unix)]
    {
        let sent = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap();
        assert!(sent.success());
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "the program did not stop on SIGTERM"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(status.success(), "{status:?}");
    }
    #[cfg(not(unix))]
    {
        child.kill().unwrap();
        let _ = child.wait();
    }
}
