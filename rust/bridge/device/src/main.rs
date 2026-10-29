//! `jeeta-device-bridge [CONFIG]`: connects the phones plugged into this computer to Jeeta.
//!
//! `CONFIG` is the configuration file; by default `jeeta-device-bridge.toml` next to the program.
//! The phones are the Android phones `adb devices -l` lists ready (`adb` from the configuration),
//! only the configured `serials` when it names some. The log goes to the console;
//! `JEETA_DEVICE_BRIDGE_LOG` sets its filter (default `info`, e.g. `debug`). A panic is logged by
//! where it happened, never by its message.
//!
//! The bridge stops on Ctrl+C and Ctrl+Break, and on `SIGTERM` (Unix), within its shutdown
//! grace. On Windows it also stops when its console window is closed, the user logs off or the
//! system shuts down; Windows ends the process soon after those, so the bridge then takes
//! [`HURRIED_GRACE`] at most. It exits with status 2 when its configuration cannot be used, and
//! with a failure status when one of its tasks ended on its own.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use jeeta_device_bridge::config::FILE_NAME;
use jeeta_device_bridge::{
    AndroidRegistry, Config, Stop, SystemAdb, Timing, install_panic_hook, run,
};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

/// The environment variable that sets the log filter.
const LOG_ENV: &str = "JEETA_DEVICE_BRIDGE_LOG";
/// How long the bridge takes to stop when the system ends the process soon (Windows: the
/// console closing, a log-off, a shutdown). Used on Windows only; defined everywhere for the
/// documentation's link.
#[cfg_attr(not(windows), allow(dead_code))]
const HURRIED_GRACE: Duration = Duration::from_secs(2);

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

/// Completes when a signal not to wait for has none.
async fn never() {
    std::future::pending::<()>().await;
}

/// Sets up a listener for each signal to stop, now: one that arrives while the bridge starts,
/// before the returned future is first polled, is not missed. The future completes on the first
/// signal and says how to stop. A signal whose listener cannot be set up is never waited for.
#[cfg(windows)]
fn stop_signal() -> impl Future<Output = Stop> {
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};

    let interrupt = ctrl_c();
    let brk = ctrl_break();
    let close = ctrl_close();
    let logoff = ctrl_logoff();
    let shutdown = ctrl_shutdown();
    macro_rules! event {
        ($listener:expr) => {
            async move {
                match $listener {
                    Ok(mut signal) => {
                        signal.recv().await;
                    }
                    Err(_) => never().await,
                }
            }
        };
    }
    async move {
        tokio::select! {
            () = event!(interrupt) => {
                info!("Ctrl+C: the bridge stops");
                Stop::Graceful
            }
            () = event!(brk) => {
                info!("Ctrl+Break: the bridge stops");
                Stop::Graceful
            }
            () = event!(close) => {
                info!("the console is closing: the bridge stops");
                Stop::Within(HURRIED_GRACE)
            }
            () = event!(logoff) => {
                info!("the user is logging off: the bridge stops");
                Stop::Within(HURRIED_GRACE)
            }
            () = event!(shutdown) => {
                info!("the system is shutting down: the bridge stops");
                Stop::Within(HURRIED_GRACE)
            }
        }
    }
}

/// Sets up a listener for each signal to stop, now: one that arrives while the bridge starts,
/// before the returned future is first polled, is not missed. The future completes on the first
/// signal and says how to stop. A signal whose listener cannot be set up is never waited for.
#[cfg(unix)]
fn stop_signal() -> impl Future<Output = Stop> {
    use tokio::signal::unix::{Signal, SignalKind, signal};

    let interrupt = signal(SignalKind::interrupt());
    let terminate = signal(SignalKind::terminate());
    let event = |listener: std::io::Result<Signal>| async move {
        match listener {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => never().await,
        }
    };
    async move {
        tokio::select! {
            () = event(interrupt) => info!("interrupted: the bridge stops"),
            () = event(terminate) => info!("SIGTERM: the bridge stops"),
        }
        Stop::Graceful
    }
}

/// Completes on Ctrl+C. This platform's listener is set up when the future is first polled.
#[cfg(not(any(windows, unix)))]
fn stop_signal() -> impl Future<Output = Stop> {
    async {
        if tokio::signal::ctrl_c().await.is_err() {
            never().await;
        }
        Stop::Graceful
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let filter = EnvFilter::try_from_env(LOG_ENV).unwrap_or_else(|_| EnvFilter::new("info"));
    // Installed as the subscriber only, not with `init()`, which would also take in the `log`
    // records of the HTTP client (at debug level it names each connection it opens): this
    // program logs only what its logging rule allows.
    let subscriber = tracing_subscriber::fmt().with_env_filter(filter).finish();
    if tracing::subscriber::set_global_default(subscriber).is_err() {
        eprintln!("jeeta-device-bridge: the log could not be set up");
    }
    install_panic_hook();

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
        bridge_id = %config.bridge_id(),
        server = %config.base_url(),
        adb = %config.adb().display(),
        "jeeta-device-bridge starting"
    );
    // Before the bridge runs: from here on, a signal to stop is heard.
    let stop = stop_signal();
    let registry = AndroidRegistry::new(
        Arc::new(SystemAdb::new(config.adb())),
        config.serials().map(<[String]>::to_vec),
    );
    match run(&config, Arc::new(registry), Timing::default(), stop).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(%error, "the bridge stopped on a failure");
            ExitCode::FAILURE
        }
    }
}
