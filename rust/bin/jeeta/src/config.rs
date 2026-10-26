//! The binary's configuration: `JEETA_*` environment variables, read once at start after
//! `rust/.env` (or `./.env`) is loaded when present.
//!
//! Every error names the variable it is about and never repeats a secret's value. Optional
//! variables that are set but empty count as unset, so `.env.example` can list them blank.
//!
//! **Provider apps.** The platform's own OAuth apps (Meta, Instagram, X) and its public address
//! are platform configuration ([`EnvPlatformApps`]), never per tenant. Each app is optional, but
//! an app is configured only as a whole: its id and its secret together (the Meta app also needs
//! its webhook verify token), and a half-configured app stops the start, naming the variable that
//! is missing. Whenever any app is configured, the public address ([`PUBLIC_BASE_URL`]) is
//! required: OAuth redirect URIs and webhook URLs are built from it.

use std::collections::HashMap;
use std::env::VarError;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use axum::http::uri::Authority;
use jt_app::ports::connectors::{InstagramApp, MetaApp, PlatformAppConfig, Url, XApp};
use tracing_subscriber::EnvFilter;

/// The application's PostgreSQL URL (required).
pub const PRICE_MINOR: &str = "JEETA_PRICE_MINOR";
pub const PRICE_CURRENCY: &str = "JEETA_PRICE_CURRENCY";
pub const BANK_INSTRUCTIONS: &str = "JEETA_BANK_INSTRUCTIONS";
pub const METRICS_TOKEN: &str = "JEETA_METRICS_TOKEN";
pub const RECOVERY_STATUS_DIR: &str = "JEETA_RECOVERY_STATUS_DIR";
pub const DATABASE_URL: &str = "JEETA_DATABASE_URL";
/// The HTTP listen address, `ip:port` (default [`DEFAULT_BIND`]).
pub const BIND: &str = "JEETA_BIND";
/// The built panel's directory (optional).
pub const FILES_DIR: &str = "JEETA_FILES_DIR";
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
/// Whether a binary built with `jt_outbound`'s `test-loopback` feature may start (`1` or `true`;
/// default off; local testing only).
pub const ALLOW_TEST_LOOPBACK: &str = "JEETA_ALLOW_TEST_LOOPBACK";
/// Whether `jeeta serve` runs the scheduled jobs (default `true`).
pub const JOBS_ENABLED: &str = "JEETA_JOBS_ENABLED";
/// The platform's Meta app id (Facebook Login, the Graph API, the Meta webhooks).
pub const META_APP_ID: &str = "JEETA_META_APP_ID";
/// The Meta app's secret; set together with [`META_APP_ID`].
pub const META_APP_SECRET: &str = "JEETA_META_APP_SECRET";
/// The token Meta echoes when it verifies the webhook URL; required with the Meta app.
pub const META_VERIFY_TOKEN: &str = "JEETA_META_VERIFY_TOKEN";
/// The Facebook Login for Business configuration id (optional; scopes are asked otherwise).
pub const META_LOGIN_CONFIG_ID: &str = "JEETA_META_LOGIN_CONFIG_ID";
/// The WhatsApp embedded signup configuration id (optional).
pub const META_WHATSAPP_CONFIG_ID: &str = "JEETA_META_WHATSAPP_CONFIG_ID";
/// The Graph API version, `v` and two numbers (default [`jt_meta::DEFAULT_GRAPH_VERSION`]).
pub const META_GRAPH_VERSION: &str = "JEETA_META_GRAPH_VERSION";
/// The platform's Instagram app id (Instagram Login).
pub const INSTAGRAM_APP_ID: &str = "JEETA_INSTAGRAM_APP_ID";
/// The Instagram app's secret; set together with [`INSTAGRAM_APP_ID`].
pub const INSTAGRAM_APP_SECRET: &str = "JEETA_INSTAGRAM_APP_SECRET";
/// The platform's X app (OAuth 2.0 confidential client) id.
pub const X_CLIENT_ID: &str = "JEETA_X_CLIENT_ID";
/// The X app's client secret; set together with [`X_CLIENT_ID`].
pub const X_CLIENT_SECRET: &str = "JEETA_X_CLIENT_SECRET";
/// Where the panel is reached from outside (`https://host[:port]`), for OAuth redirect URIs and
/// webhook URLs; required whenever a provider app is configured.
pub const PUBLIC_BASE_URL: &str = "JEETA_PUBLIC_BASE_URL";

/// Every variable the binary reads.
const VARS: &[&str] = &[
    PRICE_MINOR,
    PRICE_CURRENCY,
    BANK_INSTRUCTIONS,
    METRICS_TOKEN,
    RECOVERY_STATUS_DIR,
    DATABASE_URL,
    BIND,
    PANEL_DIR,
    FILES_DIR,
    COOKIE_SECURE,
    SECRET_KEY,
    ALLOWED_HOSTS,
    BOOTSTRAP_EMAIL,
    BOOTSTRAP_PASSWORD,
    STDIO_API_KEY,
    LOG,
    LOG_FORMAT,
    ALLOW_SUPERUSER,
    ALLOW_TEST_LOOPBACK,
    JOBS_ENABLED,
    META_APP_ID,
    META_APP_SECRET,
    META_VERIFY_TOKEN,
    META_LOGIN_CONFIG_ID,
    META_WHATSAPP_CONFIG_ID,
    META_GRAPH_VERSION,
    INSTAGRAM_APP_ID,
    INSTAGRAM_APP_SECRET,
    X_CLIENT_ID,
    X_CLIENT_SECRET,
    PUBLIC_BASE_URL,
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

/// The 32-byte key of [`SECRET_KEY`]: the master key from which the secret box derives each
/// workspace's sealing key. `Debug` masks it.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretKey([u8; 32]);

impl SecretKey {
    /// The key's bytes.
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

/// The platform's provider apps and its public address, read from the environment once at start
/// ([`Config::from_map`]); what the use cases see through [`PlatformAppConfig`]. An app that is
/// not configured is `None`, and the kinds it serves cannot be connected by OAuth. `Debug` masks
/// every secret (the apps' own `Debug` does).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct EnvPlatformApps {
    meta: Option<MetaApp>,
    instagram: Option<InstagramApp>,
    x: Option<XApp>,
    public_base_url: Option<Url>,
}

impl EnvPlatformApps {
    /// The keys of the configured apps, for the start log: `meta`, `instagram`, `x`.
    pub fn configured(&self) -> Vec<&'static str> {
        [
            ("meta", self.meta.is_some()),
            ("instagram", self.instagram.is_some()),
            ("x", self.x.is_some()),
        ]
        .into_iter()
        .filter_map(|(name, on)| on.then_some(name))
        .collect()
    }
}

impl fmt::Debug for EnvPlatformApps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvPlatformApps")
            .field("meta", &self.meta)
            .field("instagram", &self.instagram)
            .field("x", &self.x)
            .field(
                "public_base_url",
                &self.public_base_url.as_ref().map(Url::as_str),
            )
            .finish()
    }
}

impl PlatformAppConfig for EnvPlatformApps {
    fn meta_app(&self) -> Option<MetaApp> {
        self.meta.clone()
    }

    fn instagram_app(&self) -> Option<InstagramApp> {
        self.instagram.clone()
    }

    fn x_app(&self) -> Option<XApp> {
        self.x.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        self.public_base_url.clone()
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
    pub metrics_token: Option<String>,
    pub recovery_status_dir: Option<PathBuf>,
    pub billing: jt_app::usecases::billing::BillingConfig,
    pub database_url: String,
    pub bind: SocketAddr,
    pub panel_dir: Option<PathBuf>,
    pub files_dir: Option<PathBuf>,
    pub cookie_secure: bool,
    /// The master key of the secret box (`jt_seal`), which seals connector secrets.
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
    /// Start even when `jt_outbound` was built with its `test-loopback` feature, with a warning;
    /// for local testing only.
    pub allow_test_loopback: bool,
    /// Run the scheduled jobs (token renewal, probes, NetGSM polls, purges) in `jeeta serve`.
    pub jobs_enabled: bool,
    /// The platform's provider apps and public address.
    pub apps: EnvPlatformApps,
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
            .field("log_filter", &"configured")
            .field("log_format", &self.log_format)
            .field("allow_superuser", &self.allow_superuser)
            .field("allow_test_loopback", &self.allow_test_loopback)
            .field("jobs_enabled", &self.jobs_enabled)
            .field("apps", &self.apps)
            .finish()
    }
}

impl Config {
    pub fn require_metrics_token(&self) -> Result<(), ConfigError> {
        if self
            .metrics_token
            .as_ref()
            .is_none_or(|s| s.trim().is_empty())
        {
            Err(ConfigError::new(
                METRICS_TOKEN,
                "must be nonempty for serve",
            ))
        } else {
            Ok(())
        }
    }

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
        let allow_test_loopback = parse_flag(ALLOW_TEST_LOOPBACK, get(ALLOW_TEST_LOOPBACK))?;
        let jobs_enabled = parse_bool(JOBS_ENABLED, get(JOBS_ENABLED), true)?;

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
            .map_err(|_| ConfigError::new(LOG, "is not a valid tracing filter"))?;

        let log_format = match get(LOG_FORMAT).map(str::trim) {
            None => LogFormat::Compact,
            Some(v) if v.eq_ignore_ascii_case("compact") => LogFormat::Compact,
            Some(v) if v.eq_ignore_ascii_case("json") => LogFormat::Json,
            Some(_) => return Err(ConfigError::new(LOG_FORMAT, "must be compact or json")),
        };

        let apps = parse_apps(&get)?;

        let price_minor = get(PRICE_MINOR)
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .ok_or_else(|| ConfigError::new(PRICE_MINOR, "must be a positive integer"))?;
        let price_currency = get(PRICE_CURRENCY)
            .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase()))
            .ok_or_else(|| {
                ConfigError::new(PRICE_CURRENCY, "must be three uppercase ASCII letters")
            })?
            .to_owned();
        let bank_instructions = get(BANK_INSTRUCTIONS)
            .filter(|s| s.len() <= 4096)
            .ok_or_else(|| ConfigError::new(BANK_INSTRUCTIONS, "must contain 1 to 4096 bytes"))?
            .to_owned();
        let recovery_status_dir = get(RECOVERY_STATUS_DIR).map(PathBuf::from);
        if recovery_status_dir
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        {
            return Err(ConfigError::new(
                RECOVERY_STATUS_DIR,
                "must be an absolute directory",
            ));
        }
        Ok(Config {
            metrics_token: get(METRICS_TOKEN).map(str::to_owned),
            recovery_status_dir,
            billing: jt_app::usecases::billing::BillingConfig {
                price_minor,
                price_currency,
                bank_instructions,
            },
            database_url,
            bind,
            panel_dir,
            files_dir: get(FILES_DIR).map(PathBuf::from),
            cookie_secure,
            secret_key,
            allowed_hosts,
            bootstrap,
            stdio_api_key,
            log_filter,
            log_format,
            allow_superuser,
            allow_test_loopback,
            jobs_enabled,
            apps,
        })
    }
}

/// The provider apps and the public address (see the module docs). `get` reads a variable,
/// blank as unset.
fn parse_apps<'a>(get: &impl Fn(&str) -> Option<&'a str>) -> Result<EnvPlatformApps, ConfigError> {
    let value = |name: &str| get(name).map(|v| v.trim().to_owned());

    let meta = match pair(&get, META_APP_ID, META_APP_SECRET)? {
        Some((app_id, app_secret)) => {
            let verify_token = value(META_VERIFY_TOKEN).ok_or_else(|| {
                ConfigError::new(
                    META_VERIFY_TOKEN,
                    format!(
                        "must be set when {META_APP_ID} is: Meta sends it back when it verifies \
                         the webhook URL"
                    ),
                )
            })?;
            let graph_version = value(META_GRAPH_VERSION)
                .unwrap_or_else(|| jt_meta::DEFAULT_GRAPH_VERSION.to_owned());
            if !is_graph_version(&graph_version) {
                return Err(ConfigError::new(
                    META_GRAPH_VERSION,
                    "must be a Graph API version such as v19.0",
                ));
            }
            Some(MetaApp {
                app_id,
                app_secret,
                verify_token,
                login_config_id: value(META_LOGIN_CONFIG_ID),
                whatsapp_config_id: value(META_WHATSAPP_CONFIG_ID),
                graph_version: Some(graph_version),
            })
        }
        None => {
            // The Meta app's other settings mean nothing without it: half a configuration.
            for setting in [
                META_VERIFY_TOKEN,
                META_LOGIN_CONFIG_ID,
                META_WHATSAPP_CONFIG_ID,
                META_GRAPH_VERSION,
            ] {
                if get(setting).is_some() {
                    return Err(ConfigError::new(
                        META_APP_ID,
                        format!(
                            "must be set (with {META_APP_SECRET}) because {setting} is: the Meta \
                             app is configured as a whole or not at all"
                        ),
                    ));
                }
            }
            None
        }
    };
    let instagram = pair(&get, INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET)?
        .map(|(app_id, app_secret)| InstagramApp { app_id, app_secret });
    let x = pair(&get, X_CLIENT_ID, X_CLIENT_SECRET)?.map(|(client_id, client_secret)| XApp {
        client_id,
        client_secret,
    });

    let public_base_url = get(PUBLIC_BASE_URL)
        .map(|raw| parse_public_base_url(raw.trim()))
        .transpose()?;
    let any_app = meta.is_some() || instagram.is_some() || x.is_some();
    if any_app && public_base_url.is_none() {
        return Err(ConfigError::new(
            PUBLIC_BASE_URL,
            "must be set to the server's public address (https://host[:port]) because a provider \
             app is configured: OAuth redirect URIs and webhook URLs are built from it",
        ));
    }
    Ok(EnvPlatformApps {
        meta,
        instagram,
        x,
        public_base_url,
    })
}

/// An app's id and secret: both or neither. One without the other is an error naming the one
/// that is missing (never a value).
fn pair<'a>(
    get: &impl Fn(&str) -> Option<&'a str>,
    id: &'static str,
    secret: &'static str,
) -> Result<Option<(String, String)>, ConfigError> {
    match (get(id), get(secret)) {
        (None, None) => Ok(None),
        (Some(i), Some(s)) => Ok(Some((i.trim().to_owned(), s.trim().to_owned()))),
        (Some(_), None) => Err(ConfigError::new(
            secret,
            format!(
                "must be set together with {id}: an app is configured as a whole or not at all"
            ),
        )),
        (None, Some(_)) => Err(ConfigError::new(
            id,
            format!(
                "must be set together with {secret}: an app is configured as a whole or not at all"
            ),
        )),
    }
}

/// Whether `version` is a Graph API version: `v`, then one to three digits, a dot and one to three
/// digits (`v19.0`), as the Meta adapter takes it.
fn is_graph_version(version: &str) -> bool {
    version.strip_prefix('v').is_some_and(|rest| {
        let mut parts = rest.split('.');
        let numeric = |p: Option<&str>| {
            p.is_some_and(|p| {
                !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit())
            })
        };
        numeric(parts.next()) && numeric(parts.next()) && parts.next().is_none()
    })
}

/// The public address of [`PUBLIC_BASE_URL`]: an `https://` URL of a host (and port) alone, with
/// no path, query, fragment or user; plain `http://` only for a loopback host (`localhost`,
/// `127.0.0.1`, `[::1]`), for local development. The error never repeats the value.
fn parse_public_base_url(raw: &str) -> Result<Url, ConfigError> {
    const PROBLEM: &str = "must be the server's public address, https://host or https://host:port, \
                           with no path, query or fragment (http:// only for localhost)";
    let url = Url::parse(raw).map_err(|_| ConfigError::new(PUBLIC_BASE_URL, PROBLEM))?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    let bare = !host.is_empty()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && !raw.ends_with('?')
        && !raw.ends_with('#');
    if scheme_ok && bare {
        Ok(url)
    } else {
        Err(ConfigError::new(PUBLIC_BASE_URL, PROBLEM))
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

/// `1` or `true` (any case) is on, `0` or `false` off, unset off.
fn parse_flag(var: &'static str, raw: Option<&str>) -> Result<bool, ConfigError> {
    match raw.map(str::trim) {
        None => Ok(false),
        Some(v) if v == "1" || v.eq_ignore_ascii_case("true") => Ok(true),
        Some(v) if v == "0" || v.eq_ignore_ascii_case("false") => Ok(false),
        Some(_) => Err(ConfigError::new(var, "must be 1 (or true) or 0 (or false)")),
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
                    "must contain hosts or host:port values (no scheme, path or user)",
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
            Err(_) => Err(format!("{path}: cannot read environment file")),
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
            (PRICE_MINOR, "123"),
            (PRICE_CURRENCY, "TRY"),
            (BANK_INSTRUCTIONS, "Synthetic bank instructions"),
        ]);
        all.extend(vars(extra));
        all
    }

    fn error(vars: &HashMap<String, String>) -> ConfigError {
        Config::from_map(vars).expect_err("the configuration must be refused")
    }

    #[test]
    fn billing_config_rejects_missing_or_invalid_values() {
        for var in [PRICE_MINOR, PRICE_CURRENCY, BANK_INSTRUCTIONS] {
            let mut values = with(&[]);
            values.remove(var);
            assert_eq!(error(&values).var, var);
        }
        for (var, value) in [
            (PRICE_MINOR, "0"),
            (PRICE_MINOR, "-1"),
            (PRICE_MINOR, "1.2"),
            (PRICE_MINOR, "9223372036854775808"),
            (PRICE_CURRENCY, "try"),
            (PRICE_CURRENCY, "TR"),
            (PRICE_CURRENCY, "TÜR"),
            (BANK_INSTRUCTIONS, " "),
        ] {
            assert_eq!(error(&with(&[(var, value)])).var, var);
        }
        assert_eq!(
            error(&with(&[(BANK_INSTRUCTIONS, &"x".repeat(4097))])).var,
            BANK_INSTRUCTIONS
        );
        assert_eq!(
            Config::from_map(&with(&[(BANK_INSTRUCTIONS, &"x".repeat(4096))]))
                .unwrap()
                .billing
                .bank_instructions
                .len(),
            4096
        );
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
        assert!(!config.allow_test_loopback, "off unless asked for");
        assert!(config.jobs_enabled, "on unless turned off");
    }

    #[test]
    fn the_test_loopback_override_takes_one_or_true() {
        for (raw, allowed) in [
            ("1", true),
            ("true", true),
            (" TRUE ", true),
            ("0", false),
            ("false", false),
            ("", false),
        ] {
            let config = Config::from_map(&with(&[(ALLOW_TEST_LOOPBACK, raw)])).unwrap();
            assert_eq!(config.allow_test_loopback, allowed, "{raw:?}");
        }
        for bad in ["yes", "2", "on"] {
            let err = error(&with(&[(ALLOW_TEST_LOOPBACK, bad)]));
            assert_eq!(err.var, ALLOW_TEST_LOOPBACK, "{bad}");
        }
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
            (JOBS_ENABLED, " false "),
        ]))
        .unwrap();
        assert!(config.allow_superuser);
        assert!(!config.jobs_enabled);
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
            (ALLOW_TEST_LOOPBACK, ""),
            (JOBS_ENABLED, ""),
        ]))
        .unwrap();
        assert_eq!(blank, Config::from_map(&with(&[])).unwrap());

        for (var, bad) in [
            (BIND, "localhost"),
            (BIND, "127.0.0.1"),
            (COOKIE_SECURE, "yes"),
            (ALLOW_SUPERUSER, "1"),
            (JOBS_ENABLED, "no"),
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

    /// Every provider app, configured, and the public address.
    const ALL_APPS: &[(&str, &str)] = &[
        (META_APP_ID, "meta-id-1"),
        (META_APP_SECRET, "META-SECRET-SENTINEL"),
        (META_VERIFY_TOKEN, "VERIFY-TOKEN-SENTINEL"),
        (INSTAGRAM_APP_ID, "ig-id-1"),
        (INSTAGRAM_APP_SECRET, "IG-SECRET-SENTINEL"),
        (X_CLIENT_ID, "x-id-1"),
        (X_CLIENT_SECRET, "X-SECRET-SENTINEL"),
        (PUBLIC_BASE_URL, "https://jeeta.example"),
    ];

    /// The secrets of [`ALL_APPS`].
    const APP_SECRETS: &[&str] = &[
        "META-SECRET-SENTINEL",
        "VERIFY-TOKEN-SENTINEL",
        "IG-SECRET-SENTINEL",
        "X-SECRET-SENTINEL",
    ];

    #[test]
    fn env_apps_requires_both_id_and_secret() {
        // Nothing configured: no app, no public address, and the server starts.
        let none = Config::from_map(&with(&[])).unwrap();
        assert_eq!(none.apps, EnvPlatformApps::default());
        assert!(none.apps.configured().is_empty());

        // Every app, configured as a whole.
        let all = Config::from_map(&with(ALL_APPS)).unwrap();
        assert_eq!(all.apps.configured(), ["meta", "instagram", "x"]);
        let meta = all.apps.meta_app().unwrap();
        assert_eq!(meta.app_id, "meta-id-1");
        assert_eq!(meta.app_secret, "META-SECRET-SENTINEL");
        assert_eq!(meta.verify_token, "VERIFY-TOKEN-SENTINEL");
        assert_eq!(meta.login_config_id, None);
        assert_eq!(meta.whatsapp_config_id, None);
        assert_eq!(
            meta.graph_version.as_deref(),
            Some(jt_meta::DEFAULT_GRAPH_VERSION),
            "the adapter's default when unset"
        );
        let instagram = all.apps.instagram_app().unwrap();
        assert_eq!(
            (instagram.app_id.as_str(), instagram.app_secret.as_str()),
            ("ig-id-1", "IG-SECRET-SENTINEL")
        );
        let x = all.apps.x_app().unwrap();
        assert_eq!(
            (x.client_id.as_str(), x.client_secret.as_str()),
            ("x-id-1", "X-SECRET-SENTINEL")
        );
        assert_eq!(
            all.apps.public_base_url().unwrap().as_str(),
            "https://jeeta.example/"
        );

        // The Meta app's optional settings.
        let tuned = Config::from_map(&with(&[
            (META_APP_ID, "meta-id-1"),
            (META_APP_SECRET, "s"),
            (META_VERIFY_TOKEN, "v"),
            (META_LOGIN_CONFIG_ID, " 123 "),
            (META_WHATSAPP_CONFIG_ID, "456"),
            (META_GRAPH_VERSION, "v21.0"),
            (PUBLIC_BASE_URL, "https://jeeta.example"),
        ]))
        .unwrap();
        let meta = tuned.apps.meta_app().unwrap();
        assert_eq!(meta.login_config_id.as_deref(), Some("123"));
        assert_eq!(meta.whatsapp_config_id.as_deref(), Some("456"));
        assert_eq!(meta.graph_version.as_deref(), Some("v21.0"));
        assert_eq!(tuned.apps.configured(), ["meta"]);

        // One half of an app names the other half, never a value.
        let base = (PUBLIC_BASE_URL, "https://jeeta.example");
        for (given, missing) in [
            ((META_APP_ID, "meta-id-1"), META_APP_SECRET),
            ((META_APP_SECRET, "HALF-SENTINEL"), META_APP_ID),
            ((INSTAGRAM_APP_ID, "ig-id-1"), INSTAGRAM_APP_SECRET),
            ((INSTAGRAM_APP_SECRET, "HALF-SENTINEL"), INSTAGRAM_APP_ID),
            ((X_CLIENT_ID, "x-id-1"), X_CLIENT_SECRET),
            ((X_CLIENT_SECRET, "HALF-SENTINEL"), X_CLIENT_ID),
        ] {
            let err = error(&with(&[given, base, (META_VERIFY_TOKEN, "")]));
            assert_eq!(err.var, missing, "{given:?}");
            assert!(err.to_string().contains(given.0), "{err}");
            assert!(!err.to_string().contains(given.1), "{err}");
        }
        // The Meta app needs its verify token.
        let err = error(&with(&[
            (META_APP_ID, "meta-id-1"),
            (META_APP_SECRET, "HALF-SENTINEL"),
            base,
        ]));
        assert_eq!(err.var, META_VERIFY_TOKEN);
        assert!(!err.to_string().contains("HALF-SENTINEL"), "{err}");
        // A Meta setting without the Meta app is half a configuration too.
        for setting in [
            META_VERIFY_TOKEN,
            META_LOGIN_CONFIG_ID,
            META_WHATSAPP_CONFIG_ID,
            META_GRAPH_VERSION,
        ] {
            let err = error(&with(&[(setting, "HALF-SENTINEL"), base]));
            assert_eq!(err.var, META_APP_ID, "{setting}");
            assert!(err.to_string().contains(setting), "{err}");
            assert!(!err.to_string().contains("HALF-SENTINEL"), "{err}");
        }
        // A Graph version is v and two numbers.
        for bad in ["19.0", "v19", "v19.0.1", "latest", "v1x.0"] {
            let mut vars = with(ALL_APPS);
            vars.insert(META_GRAPH_VERSION.to_owned(), bad.to_owned());
            assert_eq!(error(&vars).var, META_GRAPH_VERSION, "{bad}");
        }
        // Blank values are unset: an app listed blank in the env file is not configured.
        let blank = Config::from_map(&with(&[
            (META_APP_ID, ""),
            (META_APP_SECRET, " "),
            (META_VERIFY_TOKEN, ""),
            (INSTAGRAM_APP_ID, ""),
            (INSTAGRAM_APP_SECRET, ""),
            (X_CLIENT_ID, ""),
            (X_CLIENT_SECRET, ""),
            (PUBLIC_BASE_URL, ""),
        ]))
        .unwrap();
        assert_eq!(blank.apps, EnvPlatformApps::default());
    }

    #[test]
    fn public_base_url_required_when_any_app_is_configured() {
        // Any one app needs the public address.
        for app in [
            &[
                (META_APP_ID, "m"),
                (META_APP_SECRET, "s"),
                (META_VERIFY_TOKEN, "v"),
            ][..],
            &[(INSTAGRAM_APP_ID, "i"), (INSTAGRAM_APP_SECRET, "s")][..],
            &[(X_CLIENT_ID, "x"), (X_CLIENT_SECRET, "s")][..],
        ] {
            let err = error(&with(app));
            assert_eq!(err.var, PUBLIC_BASE_URL, "{app:?}");
            let mut configured = app.to_vec();
            configured.push((PUBLIC_BASE_URL, "https://jeeta.example:8443"));
            let config = Config::from_map(&with(&configured)).unwrap();
            assert_eq!(
                config.apps.public_base_url().unwrap().as_str(),
                "https://jeeta.example:8443/"
            );
        }
        // Without an app it is optional, and checked when given.
        let alone =
            Config::from_map(&with(&[(PUBLIC_BASE_URL, "https://jeeta.example/")])).unwrap();
        assert_eq!(
            alone.apps.public_base_url().unwrap().as_str(),
            "https://jeeta.example/"
        );
        // https with a host alone; plain http only for a loopback host (local development).
        for good in [
            "https://jeeta.example",
            "https://jeeta.example/",
            "https://203.0.113.7:8443",
            "http://localhost:8080",
            "http://127.0.0.1:8080/",
            "http://[::1]:8080",
        ] {
            let config = Config::from_map(&with(&[(PUBLIC_BASE_URL, good)]));
            assert!(config.is_ok(), "{good}: {config:?}");
        }
        for bad in [
            "jeeta.example",
            "http://jeeta.example",
            "http://192.168.1.10",
            "https://jeeta.example/panel",
            "https://jeeta.example/?a=b",
            "https://jeeta.example/?",
            "https://jeeta.example/#top",
            "https://user:pw@jeeta.example",
            "ftp://jeeta.example",
            "https://:8443",
        ] {
            let err = error(&with(&[(PUBLIC_BASE_URL, bad)]));
            assert_eq!(err.var, PUBLIC_BASE_URL, "{bad}");
            assert!(
                !err.to_string().contains(bad),
                "the error repeats the value: {err}"
            );
        }
    }

    #[test]
    fn config_debug_never_prints_secrets() {
        let config = Config::from_map(&with(ALL_APPS)).unwrap();
        for shown in [format!("{config:?}"), format!("{:?}", config.apps)] {
            for secret in APP_SECRETS {
                assert!(!shown.contains(secret), "{secret} in {shown}");
            }
            // The ids and the public address are not secrets.
            for public in ["meta-id-1", "ig-id-1", "x-id-1", "https://jeeta.example/"] {
                assert!(shown.contains(public), "{public} missing from {shown}");
            }
        }
        // Nor does any refusal of a provider variable.
        for (var, _) in ALL_APPS {
            let mut vars = with(ALL_APPS);
            vars.remove(*var);
            if let Err(err) = Config::from_map(&vars) {
                for secret in APP_SECRETS {
                    assert!(!err.to_string().contains(secret), "{var}: {err}");
                    assert!(!format!("{err:?}").contains(secret), "{var}: {err:?}");
                }
            }
        }
    }

    /// `rust/.env.example` lists every variable the binary reads (and the tests' database URL),
    /// the provider apps and the public address blank: placeholders only.
    #[test]
    fn the_env_example_lists_every_variable() {
        let text = include_str!("../../../.env.example");
        let listed: HashMap<&str, &str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.split_once('=').expect("NAME=value"))
            .collect();
        let mut expected: Vec<&str> = VARS.to_vec();
        expected.push("JEETA_TEST_DATABASE_URL");
        expected.sort_unstable();
        let mut names: Vec<&str> = listed.keys().copied().collect();
        names.sort_unstable();
        assert_eq!(names, expected);
        for var in [
            META_APP_ID,
            META_APP_SECRET,
            META_VERIFY_TOKEN,
            META_LOGIN_CONFIG_ID,
            META_WHATSAPP_CONFIG_ID,
            META_GRAPH_VERSION,
            INSTAGRAM_APP_ID,
            INSTAGRAM_APP_SECRET,
            X_CLIENT_ID,
            X_CLIENT_SECRET,
            PUBLIC_BASE_URL,
        ] {
            assert_eq!(listed[var], "", "{var} is a placeholder in .env.example");
        }
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
