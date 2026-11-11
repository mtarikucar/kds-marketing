//! The `jeeta` binary.
//!
//! - `jeeta serve`: the HTTP server (panel, its API, the MCP endpoint at `/mcp` and the
//!   providers' webhooks at `/hooks/*`) and the scheduled jobs ([`scheduler`]).
//! - `jeeta mcp-stdio`: the MCP tools over stdin/stdout, as the key in `JEETA_STDIO_API_KEY`.
//!
//! Configuration comes from `JEETA_*` environment variables ([`config`]). A configuration,
//! database or migration failure prints one readable line and exits with code 1; an unknown
//! command prints the usage and exits with code 2.

mod config;
mod connectors;
mod net;
mod ops;
mod recovery;
mod scheduler;
mod serve;
mod stdio;
mod v1_import;

use std::ffi::OsString;
use std::process::ExitCode;
use std::time::Duration;

use crate::config::{Config, LogFormat};

const USAGE: &str = "\
Usage: jeeta <command>

Commands:
  serve       Run the HTTP server: the panel, its API, the MCP endpoint at /mcp and the
              providers' webhooks at /hooks
  mcp-stdio   Serve MCP over stdin/stdout as the API key in JEETA_STDIO_API_KEY
  import-v1-leads --workspace <uuid> --input <file.jsonl> [--dry-run | --rollback]
                        Import only allowlisted v1 leads, without serving
  recovery-verify       Verify restored schema, RLS and sealed canary without serving
  recovery-canary-up    Provision a retired canary in JEETA_RECOVERY_WORKSPACE_ID
  recovery-canary-down  Remove that reserved canary (idempotent rollback)
  --help      Show this help

Configuration comes from JEETA_* environment variables; rust/.env (or ./.env) is loaded first
when it exists. See rust/.env.example for every variable.
";

/// How long blocking work (an Argon2 hash) may hold up the exit.
const RUNTIME_SHUTDOWN: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Serve,
    McpStdio,
    Help,
    RecoveryVerify,
    RecoveryCanaryUp,
    RecoveryCanaryDown,
}

/// The command named by the arguments after the program name; `None` for anything else.
fn parse(args: &[OsString]) -> Option<Command> {
    let [arg] = args else {
        return None;
    };
    match arg.to_str()? {
        "recovery-verify" => Some(Command::RecoveryVerify),
        "recovery-canary-up" => Some(Command::RecoveryCanaryUp),
        "recovery-canary-down" => Some(Command::RecoveryCanaryDown),
        "serve" => Some(Command::Serve),
        "mcp-stdio" => Some(Command::McpStdio),
        "--help" | "-h" | "help" => Some(Command::Help),
        _ => None,
    }
}

fn main() -> ExitCode {
    let _ = crate::ops::process_started_at();
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "import-v1-leads") {
        return v1_import::run(&args[1..]);
    }
    let Some(command) = parse(&args) else {
        match args.first() {
            None => eprintln!("jeeta: no command given\n"),
            Some(arg) => eprintln!("jeeta: unknown command `{}`\n", arg.to_string_lossy()),
        }
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    match command {
        Command::Help => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Command::RecoveryVerify => recovery::run("recovery-verify"),
        Command::RecoveryCanaryUp => recovery::run("recovery-canary-up"),
        Command::RecoveryCanaryDown => recovery::run("recovery-canary-down"),
        Command::Serve => start(serve::run, true),
        Command::McpStdio => start(stdio::run, false),
    }
}

/// Loads the configuration, starts logging and runs `command` on a Tokio runtime.
fn start<F, Fut>(command: F, serving: bool) -> ExitCode
where
    F: FnOnce(Config) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    // Loaded while this is the only thread: it sets environment variables.
    let env_file = match config::load_dotenv() {
        Ok(file) => file,
        Err(e) => return fail(None, &format!("configuration: {e}")),
    };
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => return fail(None, &format!("configuration: {e}")),
    };
    if serving && let Err(e) = config.require_metrics_token() {
        return fail(None, &format!("configuration: {e}"));
    }
    let format = config.log_format;
    init_tracing(&config);
    if let Some(file) = env_file {
        tracing::info!(file, "loaded the env file");
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => return fail(Some(format), &format!("cannot start the runtime: {e}")),
    };
    let result = runtime.block_on(command(config));
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN);
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => fail(
            Some(format),
            "startup failed (database, migrations or runtime dependency)",
        ),
    }
}

/// Logs to stderr (stdout is the MCP stream in `mcp-stdio`), compact or as JSON.
fn init_tracing(config: &Config) {
    crate::ops::install_tracing(
        &config.log_filter,
        matches!(config.log_format, LogFormat::Json),
    );
}

/// Reports a fatal error once and returns exit code 1: as a JSON log event when logs are JSON,
/// else as one plain line on stderr.
fn fail(format: Option<LogFormat>, message: &str) -> ExitCode {
    match format {
        Some(LogFormat::Json) => tracing::error!(error = message, "jeeta stopped"),
        None if std::env::var(config::LOG_FORMAT).is_ok_and(|s| s.eq_ignore_ascii_case("json")) => {
            eprintln!("{}", serde_json::json!({"level":"ERROR","message":message}))
        }
        _ => eprintln!("jeeta: {message}"),
    }
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn commands_are_parsed_and_anything_else_is_refused() {
        assert_eq!(parse(&args(&["serve"])), Some(Command::Serve));
        assert_eq!(parse(&args(&["mcp-stdio"])), Some(Command::McpStdio));
        assert_eq!(parse(&args(&["--help"])), Some(Command::Help));
        for bad in [&[][..], &["serv"], &["serve", "extra"], &["--serve"]] {
            assert_eq!(parse(&args(bad)), None, "{bad:?}");
        }
    }
}
