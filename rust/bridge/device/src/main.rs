//! `jeeta-device-bridge [CONFIG]`: connects the phones plugged into this computer to Jeeta.
//!
//! `CONFIG` is the configuration file; by default `jeeta-device-bridge.toml` next to the program.
//! The log goes to the console; `JEETA_DEVICE_BRIDGE_LOG` sets its filter (default `info`, e.g.
//! `debug`). Ctrl+C stops the bridge.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use async_trait::async_trait;
use jeeta_device_bridge::config::FILE_NAME;
use jeeta_device_bridge::{AttachedPhone, Config, DriverError, PhoneRegistry, Timing, run};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

/// The environment variable that sets the log filter.
const LOG_ENV: &str = "JEETA_DEVICE_BRIDGE_LOG";

/// A registry that sees no phone: the bridge registers with none and never polls.
///
/// TODO(D2-T2): replace with the Android registry (`adb devices -l` through `Config::adb`, one
/// `AndroidAdbDriver` per serial).
struct NoPhonesYet;

#[async_trait]
impl PhoneRegistry for NoPhonesYet {
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError> {
        Ok(Vec::new())
    }
}

/// The configuration file: the first argument, else [`FILE_NAME`] next to the program, else in
/// the current directory.
fn config_path() -> PathBuf {
    if let Some(path) = std::env::args_os().nth(1) {
        return PathBuf::from(path);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(FILE_NAME)))
        .unwrap_or_else(|| PathBuf::from(FILE_NAME))
}

#[tokio::main]
async fn main() -> ExitCode {
    let filter = EnvFilter::try_from_env(LOG_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let path = config_path();
    let config = match Config::load(&path) {
        Ok(config) => config,
        Err(error) => {
            error!(path = %path.display(), %error, "the configuration cannot be used");
            return ExitCode::from(2);
        }
    };
    info!(
        version = env!("CARGO_PKG_VERSION"),
        bridge_id = %config.bridge_id,
        server = %config.base_url,
        adb = %config.adb.display(),
        "jeeta-device-bridge starting"
    );
    let stop = async {
        // Without a Ctrl+C handler, run until the process is ended.
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    match run(&config, Arc::new(NoPhonesYet), Timing::default(), stop).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(%error, "the bridge could not start");
            ExitCode::FAILURE
        }
    }
}
