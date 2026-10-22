//! The binary's configuration: `JEETA_*` environment variables, read once at start after
//! `rust/.env` (or `./.env`) is loaded when present.
//!
//! Every error names the variable it is about and never repeats a secret's value. Optional
//! variables that are set but empty count as unset, so `.env.example` can list them blank.

use std::collections::HashMap;
use std::env::VarError;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use axum::http::uri::Authority;
use tracing_subscriber::EnvFilter;

/// The application's PostgreSQL URL (required).
pub const DATABASE_URL: &str = "JEETA_DATABASE_URL";
/// The HTTP listen address, `ip:port` (default [`DEFAULT_BIND`]).
pub const BIND: &str = "JEETA_BIND";
/// The built panel's directory (optional).
pub const PANEL_DIR: &str = "JEETA_PANEL_DIR";
/// Whether the session cookies carry `Secure` (default `true`).
pub const COOKIE_SECURE: &str = "JEETA_COOKIE_SECURE";
/// 64 hex characters (32 bytes), required; the sealing key from M1 on.
pub const SECRET_KEY: &str = "JEETA_SECRET_KEY";
/// Public `host[:port]` values the MCP endpoint accepts in `Host`, comma-separated.
pub const ALLOWED_HOSTS: &str = "JEETA_ALLOWED_HOSTS";
/// The first platform operator's email; set together with [`BOOTSTRAP_PASSWORD`].
pub const BOOTSTRAP_EMAIL: &str = "JEETA_PLATFORM_BOOTSTRAP_EMAIL";
/// The first platform operator's password; set together with [`BOOTSTRAP_EMAIL`].
pub const BOOTSTRAP_PASSWORD: &str = "JEETA_PLATFORM_BOOTSTRAP_PASSWORD";
/// The API key `jeeta mcp-stdio` acts as.
pub const STDIO_API_KEY: &str = "JEETA_STDIO_API_KEY";
/// The tracing filter (default [`DEFAULT_LOG`]).
pub const LOG: &str = "JEETA_LOG";
/// `compact` (default) or `json`.
pub const LOG_FORMAT: &str = "JEETA_LOG_FORMAT";
/// Whether the database role may be a superuser or have `BYPASSRLS` (default `false`; local
/// development only).
pub const ALLOW_SUPERUSER: &str = "JEETA_ALLOW_SUPERUSER";

/// Every variable the binary reads.
const VARS: &[&str] = &[
    DATABASE_URL,
    BIND,
    PANEL_DIR,
    COOKIE_SECURE,
    SECRET_KEY,
    ALLOWED_HOSTS,
    BOOTSTRAP_EMAIL,
    BOOTSTRAP_PASSWORD,
    STDIO_API_KEY,
    LOG,
    LOG_FORMAT,
    ALLOW_SUPERUSER,
];

pub const DEFAULT_BIND: &str = "127.0.0.1:8080";
/// `info`, with rmcp held to warnings: rmcp logs every new MCP session id at `info`, and a
/// session id must not reach the logs.
pub const DEFAULT_LOG: &str = "info,rmcp=warn";

/// The env files tried in order; the first that exists is loaded (from the repository root, or
/// from `rust/` itself).
const DOTENV_FILES: &[&str] = &["rust/.env", ".env"];

/// A variable that is missing or unusable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    /// The variable's name.
    pub var: &'static str,
    /// What is wrong with it, without its value when it is a secret.
    pub problem: String,
}

impl ConfigError {
    fn new(var: &'static str, problem: impl Into<String>) -> ConfigError {
        ConfigError {
            var,
            problem: problem.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.var, self.problem)
    }
}

impl std::error::Error for ConfigError {}

/// The 32-byte key of [`SECRET_KEY`]. `Debug` masks it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretKey([u8; 32]);

impl SecretKey {
    /// The key's bytes.
    #[allow(dead_code, reason = "M1 seals connector secrets with it")]
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey(***)")
    }
}

/// The first platform operator, created at start when none exists yet. `Debug` masks the
/// password.
#[derive(Clone, PartialEq, Eq)]
pub struct Bootstrap {
    pub email: String,
    pub password: String,
}

impl fmt::Debug for Bootstrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Bootstrap")
            .field("email", &self.email)
            .field("password", &"***")
            .finish()
    }
}

/// How log lines are written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LogFormat {
    /// One compact human-readable line per event.
    #[default]
    Compact,
    /// One JSON object per event.
    Json,
}

/// The validated configuration. `Debug` masks the database URL and every secret.
#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub panel_dir: Option<PathBuf>,
    pub cookie_secure: bool,
    /// Validated at start; unused until M1 seals connector secrets with it.
    #[allow(dead_code, reason = "M1 seals connector secrets with it")]
    pub secret_key: SecretKey,
    /// Public `host[:port]` values for the MCP endpoint, on top of the loopback names.
    pub allowed_hosts: Vec<String>,
    pub bootstrap: Option<Bootstrap>,
    pub stdio_api_key: Option<String>,
    pub log_filter: String,
    pub log_format: LogFormat,
    /// Start even when the database role bypasses row-level security (a superuser or
    /// `BYPASSRLS`), with a warning; for local development only.
    pub allow_superuser: bool,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"***")
            .field("bind", &self.bind)
            .field("panel_dir", &self.panel_dir)
            .field("cookie_secure", &self.cookie_secure)
            .field("secret_key", &self.secret_key)
            .field("allowed_hosts", &self.allowed_hosts)
            .field("bootstrap", &self.bootstrap)
            .field("stdio_api_key", &self.stdio_api_key.as_ref().map(|_| "***"))
            .field("log_filter", &self.log_filter)
            .field("log_format", &self.log_format)
            .field("allow_superuser", &self.allow_superuser)
            .finish()
    }
}

impl Config {
    /// The configuration from the process environment (see [`load_dotenv`] for the env file).
    pub fn from_env() -> Result<Config, ConfigError> {
        let mut vars = HashMap::new();
        for &name in VARS {
            match std::env::var(name) {
                Ok(value) => {
                    vars.insert(name.to_owned(), value);
                }
                Err(VarError::NotPresent) => {}
                Err(VarError::NotUnicode(_)) => {
                    return Err(ConfigError::new(name, "is not valid UTF-8"));
                }
            }
        }
        Config::from_map(&vars)
    }

    /// The configuration from `vars` (variable name to value), with defaults applied.
    pub fn from_map(vars: &HashMap<String, String>) -> Result<Config, ConfigError> {
        // A set but blank variable counts as unset.
        let get = |name: &str| {
            vars.get(name)
                .map(String::as_str)
                .filter(|v| !v.trim().is_empty())
        };

        let database_url = get(DATABASE_URL)
            .map(str::trim)
            .ok_or_else(|| {
                ConfigError::new(
                    DATABASE_URL,
                    "must be set to the application's PostgreSQL URL \
                     (postgres://user:password@host:port/database)",
                )
            })?
            .to_owned();
        if !(database_url.starts_with("postgres://") || database_url.starts_with("postgresql://")) {
            return Err(ConfigError::new(
                DATABASE_URL,
                "must be a postgres:// or postgresql:// URL",
            ));
        }

        let secret_key = parse_secret_key(get(SECRET_KEY))?;

        let bind_text = get(BIND).map_or(DEFAULT_BIND, str::trim);
        let bind = SocketAddr::from_str(bind_text).map_err(|_| {
            ConfigError::new(
                BIND,
                format!("must be an IP address with a port, such as {DEFAULT_BIND}"),
            )
        })?;

        let panel_dir = get(PANEL_DIR).map(|dir| PathBuf::from(dir.trim()));

        let cookie_secure = parse_bool(COOKIE_SECURE, get(COOKIE_SECURE), true)?;
        let allow_superuser = parse_bool(ALLOW_SUPERUSER, get(ALLOW_SUPERUSER), false)?;

        let allowed_hosts = parse_allowed_hosts(get(ALLOWED_HOSTS))?;
        if !bind.ip().is_loopback() && allowed_hosts.is_empty() {
            return Err(ConfigError::new(
                ALLOWED_HOSTS,
                format!(
                    "must name the public host or hosts (host or host:port, comma-separated) \
                     because {BIND} ({bind}) is not a loopback address; the MCP endpoint refuses \
                     every other Host header"
                ),
            ));
        }

        let bootstrap = match (get(BOOTSTRAP_EMAIL), get(BOOTSTRAP_PASSWORD)) {
            (None, None) => None,
            (Some(email), Some(password)) => Some(Bootstrap {
                email: email.trim().to_owned(),
                password: password.to_owned(),
            }),
            (Some(_), None) => {
                return Err(ConfigError::new(
                    BOOTSTRAP_PASSWORD,
                    format!("must be set together with {BOOTSTRAP_EMAIL}"),
                ));
            }
            (None, Some(_)) => {
                return Err(ConfigError::new(
                    BOOTSTRAP_EMAIL,
                    format!("must be set together with {BOOTSTRAP_PASSWORD}"),
                ));
            }
        };

        let stdio_api_key = get(STDIO_API_KEY).map(|key| key.trim().to_owned());

        let log_filter = get(LOG).map_or(DEFAULT_LOG, str::trim).to_owned();
        EnvFilter::try_new(&log_filter)
            .map_err(|e| ConfigError::new(LOG, format!("is not a valid tracing filter: {e}")))?;

        let log_format = match get(LOG_FORMAT).map(str::trim) {
            None => LogFormat::Compact,
            Some(v) if v.eq_ignore_ascii_case("compact") => LogFormat::Compact,
            Some(v) if v.eq_ignore_ascii_case("json") => LogFormat::Json,
            Some(_) => return Err(ConfigError::new(LOG_FORMAT, "must be compact or json")),
        };

        Ok(Config {
            database_url,
            bind,
            panel_dir,
            cookie_secure,
            secret_key,
            allowed_hosts,
            bootstrap,
            stdio_api_key,
            log_filter,
            log_format,
            allow_superuser,
        })
    }
}

/// `true` or `false` in any case, `default` when unset.
fn parse_bool(var: &'static str, raw: Option<&str>, default: bool) -> Result<bool, ConfigError> {
    match raw.map(str::trim) {
        None => Ok(default),
        Some(v) if v.eq_ignore_ascii_case("true") => Ok(true),
        Some(v) if v.eq_ignore_ascii_case("false") => Ok(false),
        Some(_) => Err(ConfigError::new(var, "must be true or false")),
    }
}

/// The key of [`SECRET_KEY`]: exactly 64 hex characters.
fn parse_secret_key(raw: Option<&str>) -> Result<SecretKey, ConfigError> {
    const PROBLEM: &str =
        "must be 64 hexadecimal characters (32 bytes); generate one with `openssl rand -hex 32`";
    let raw = raw
        .map(str::trim)
        .ok_or_else(|| ConfigError::new(SECRET_KEY, PROBLEM))?;
    let mut key = [0u8; 32];
    if raw.len() != 64 || hex::decode_to_slice(raw, &mut key).is_err() {
        return Err(ConfigError::new(SECRET_KEY, PROBLEM));
    }
    Ok(SecretKey(key))
}

/// The entries of [`ALLOWED_HOSTS`]: comma-separated `host` or `host:port` values, blanks
/// skipped.
fn parse_allowed_hosts(raw: Option<&str>) -> Result<Vec<String>, ConfigError> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let valid = !entry.contains('@')
                && Authority::from_str(entry).is_ok_and(|a| {
                    // A port, when given, must be a number.
                    !a.host().is_empty()
                        && (a.as_str().len() == a.host().len() || a.port_u16().is_some())
                });
            if valid {
                Ok(entry.to_owned())
            } else {
                Err(ConfigError::new(
                    ALLOWED_HOSTS,
                    format!("`{entry}` is not a host or host:port (no scheme, path or user)"),
                ))
            }
        })
        .collect()
}

/// Loads the first of `rust/.env` and `./.env` that exists into the process environment,
/// leaving variables that are already set alone, and returns its path. Must run before any other
/// thread starts. A line that cannot be parsed is reported by position only, since it may hold a
/// secret.
pub fn load_dotenv() -> Result<Option<&'static str>, String> {
    for &path in DOTENV_FILES {
        if !Path::new(path).is_file() {
            continue;
        }
        return match dotenvy::from_path(path) {
            Ok(()) => Ok(Some(path)),
            Err(dotenvy::Error::LineParse(_, at)) => Err(format!(
                "{path}: a line cannot be parsed (at character {at}); its text is not shown"
            )),
            Err(e) => Err(format!("{path}: {e}")),
        };
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    /// The smallest valid set of variables, plus `extra` (which may override them).
    fn with(extra: &[(&str, &str)]) -> HashMap<String, String> {
        let mut all = vars(&[
            (DATABASE_URL, "postgres://jeeta:pw@localhost:5432/jeeta"),
            (SECRET_KEY, KEY),
        ]);
        all.extend(vars(extra));
        all
    }

    fn error(vars: &HashMap<String, String>) -> ConfigError {
        Config::from_map(vars).expect_err("the configuration must be refused")
    }

    #[test]
    fn config_requires_database_url_and_valid_secret_key() {
        let missing_url = error(&vars(&[(SECRET_KEY, KEY)]));
        assert_eq!(missing_url.var, DATABASE_URL);
        assert!(missing_url.to_string().contains(DATABASE_URL));
        let blank_url = error(&with(&[(DATABASE_URL, "  ")]));
        assert_eq!(blank_url.var, DATABASE_URL);
        let not_postgres = error(&with(&[(DATABASE_URL, "mysql://x@localhost/db")]));
        assert_eq!(not_postgres.var, DATABASE_URL);

        let missing_key = error(&vars(&[(DATABASE_URL, "postgres://localhost/jeeta")]));
        assert_eq!(missing_key.var, SECRET_KEY);
        for bad in [
            &KEY[..62],
            &format!("{KEY}00")[..],
            "replace-with-64-hex-characters",
            &KEY.replace('a', "g")[..],
        ] {
            let err = error(&with(&[(SECRET_KEY, bad)]));
            assert_eq!(err.var, SECRET_KEY, "{bad:?}");
            assert!(err.to_string().contains(SECRET_KEY));
            assert!(!err.to_string().contains(bad), "the error repeats the key");
        }

        let config = Config::from_map(&with(&[])).unwrap();
        assert_eq!(
            config.database_url,
            "postgres://jeeta:pw@localhost:5432/jeeta"
        );
        assert_eq!(config.secret_key.bytes()[..4], [0x00, 0x11, 0x22, 0x33]);
        assert_eq!(config.secret_key.bytes()[31], 0xff);
        assert_eq!(config.bind, DEFAULT_BIND.parse::<SocketAddr>().unwrap());
        assert_eq!(config.panel_dir, None);
        assert!(config.cookie_secure);
        assert!(config.allowed_hosts.is_empty());
        assert_eq!(config.bootstrap, None);
        assert_eq!(config.stdio_api_key, None);
        assert_eq!(config.log_filter, DEFAULT_LOG);
        assert_eq!(config.log_filter, "info,rmcp=warn");
        assert_eq!(config.log_format, LogFormat::Compact);
        assert!(!config.allow_superuser, "off unless asked for");
    }

    #[test]
    fn optional_variables_are_parsed_and_blank_ones_are_unset() {
        let config = Config::from_map(&with(&[
            (BIND, "127.0.0.1:9090"),
            (PANEL_DIR, "panel/dist"),
            (COOKIE_SECURE, "false"),
            (STDIO_API_KEY, " jt_live_abc "),
            (LOG, "jeeta=debug,info"),
            (LOG_FORMAT, "json"),
            (ALLOW_SUPERUSER, "TRUE"),
        ]))
        .unwrap();
        assert!(config.allow_superuser);
        assert_eq!(config.bind, "127.0.0.1:9090".parse::<SocketAddr>().unwrap());
        assert_eq!(config.panel_dir, Some(PathBuf::from("panel/dist")));
        assert!(!config.cookie_secure);
        assert_eq!(config.stdio_api_key.as_deref(), Some("jt_live_abc"));
        assert_eq!(config.log_filter, "jeeta=debug,info");
        assert_eq!(config.log_format, LogFormat::Json);

        let blank = Config::from_map(&with(&[
            (BIND, ""),
            (PANEL_DIR, ""),
            (COOKIE_SECURE, ""),
            (ALLOWED_HOSTS, ""),
            (BOOTSTRAP_EMAIL, ""),
            (BOOTSTRAP_PASSWORD, ""),
            (STDIO_API_KEY, ""),
            (LOG, ""),
            (LOG_FORMAT, ""),
            (ALLOW_SUPERUSER, ""),
        ]))
        .unwrap();
        assert_eq!(blank, Config::from_map(&with(&[])).unwrap());

        for (var, bad) in [
            (BIND, "localhost"),
            (BIND, "127.0.0.1"),
            (COOKIE_SECURE, "yes"),
            (ALLOW_SUPERUSER, "1"),
            (LOG_FORMAT, "pretty"),
            (LOG, "jeeta=loud"),
        ] {
            assert_eq!(error(&with(&[(var, bad)])).var, var, "{var}={bad}");
        }
    }

    #[test]
    fn allowed_hosts_required_for_non_loopback_bind() {
        for bind in ["0.0.0.0:8080", "192.168.1.10:8080", "[::]:8080"] {
            let err = error(&with(&[(BIND, bind)]));
            assert_eq!(err.var, ALLOWED_HOSTS, "{bind}");
            assert!(err.to_string().contains(BIND), "{err}");
        }

        let config = Config::from_map(&with(&[
            (BIND, "0.0.0.0:8080"),
            (
                ALLOWED_HOSTS,
                " jeeta.example.com, jeeta.example.com:8443 ,",
            ),
        ]))
        .unwrap();
        assert_eq!(
            config.allowed_hosts,
            ["jeeta.example.com", "jeeta.example.com:8443"]
        );

        // Loopback binds need none, and accept public names (a reverse proxy on loopback).
        for bind in ["127.0.0.1:8080", "[::1]:8080"] {
            assert!(Config::from_map(&with(&[(BIND, bind)])).is_ok(), "{bind}");
        }
        let proxied = Config::from_map(&with(&[(ALLOWED_HOSTS, "jeeta.example.com")])).unwrap();
        assert_eq!(proxied.allowed_hosts, ["jeeta.example.com"]);

        for bad in [
            "https://jeeta.example.com",
            "jeeta.example.com/mcp",
            "user@jeeta.example.com",
            "jeeta.example.com:port",
        ] {
            let err = error(&with(&[(BIND, "0.0.0.0:8080"), (ALLOWED_HOSTS, bad)]));
            assert_eq!(err.var, ALLOWED_HOSTS, "{bad}");
        }
    }

    #[test]
    fn bootstrap_requires_both_variables() {
        let email = (BOOTSTRAP_EMAIL, "op@example.test");
        let password = (BOOTSTRAP_PASSWORD, "a long operator password");

        let config = Config::from_map(&with(&[email, password])).unwrap();
        assert_eq!(
            config.bootstrap,
            Some(Bootstrap {
                email: "op@example.test".into(),
                password: "a long operator password".into(),
            })
        );

        let only_email = error(&with(&[email]));
        assert_eq!(only_email.var, BOOTSTRAP_PASSWORD);
        assert!(only_email.to_string().contains(BOOTSTRAP_EMAIL));
        let only_password = error(&with(&[password]));
        assert_eq!(only_password.var, BOOTSTRAP_EMAIL);
        assert!(!only_password.to_string().contains(password.1));
    }

    #[test]
    fn debug_output_masks_every_secret() {
        let config = Config::from_map(&with(&[
            (BOOTSTRAP_EMAIL, "op@example.test"),
            (BOOTSTRAP_PASSWORD, "a long operator password"),
            (STDIO_API_KEY, "jt_live_secretkey"),
        ]))
        .unwrap();
        let shown = format!("{config:?}");
        for secret in [
            "pw@localhost",
            "00112233",
            "a long operator password",
            "jt_live_secretkey",
        ] {
            assert!(!shown.contains(secret), "{secret} in {shown}");
        }
        assert!(shown.contains("op@example.test"), "{shown}");
    }
}
