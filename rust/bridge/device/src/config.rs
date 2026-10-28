//! The bridge's configuration: a TOML file, [`FILE_NAME`] by default, and one environment
//! variable for the key.
//!
//! ```toml
//! base_url = "https://jeetagrowth.com"   # the Jeeta server
//! key = "…"                              # the bridge key; or JEETA_DEVICE_BRIDGE_KEY
//! adb = 'C:\platform-tools\adb.exe'      # optional
//! serials = ["18cf9fbb"]                 # optional: only these phones
//! bridge_id = "atolye-pc"                # optional: this computer's name
//! ```
//!
//! - `key` is a `devices.bridge` API key. [`KEY_ENV`] wins over the file when it is set, so the
//!   file can be kept without the key.
//! - `adb` defaults to `adb` found on `PATH`, else the Android SDK's
//!   `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`, else plain `adb`.
//! - `bridge_id` defaults to this computer's name (`COMPUTERNAME`, `HOSTNAME`).
//! - An unknown setting is refused, so a misspelt one is not silently ignored.
//!
//! An error names the setting it is about and never repeats the key, not even when the file does
//! not parse: only the line and the parser's message are kept, never the text of the line.

use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use jt_device_protocol::MAX_ID_CHARS;
use reqwest::Url;
use serde::Deserialize;

/// The configuration file's name; by default it is read next to the program.
pub const FILE_NAME: &str = "jeeta-device-bridge.toml";
/// The environment variable that holds the bridge key.
pub const KEY_ENV: &str = "JEETA_DEVICE_BRIDGE_KEY";
/// The bridge id when this computer has no name to give.
pub const DEFAULT_BRIDGE_ID: &str = "jeeta-device-bridge";

/// The file as written.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    base_url: String,
    key: Option<String>,
    adb: Option<PathBuf>,
    serials: Option<Vec<String>>,
    bridge_id: Option<String>,
}

/// The bridge's configuration, checked.
#[derive(Clone, Debug)]
pub struct Config {
    /// The Jeeta server, ending in `/`: the bridge's routes are under `api/devices/bridge/`.
    /// `https`, or plain `http` to this computer only.
    pub base_url: Url,
    pub key: BridgeKey,
    /// The `adb` program the Android driver runs.
    pub adb: PathBuf,
    /// When set, only these phones are reported.
    pub serials: Option<Vec<String>>,
    /// This bridge's name in Jeeta.
    pub bridge_id: String,
}

/// The bridge's API key. Its `Debug` shows `***`, and nothing else prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct BridgeKey(String);

impl BridgeKey {
    /// The key itself, for the `Authorization` header and nothing else.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for BridgeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BridgeKey(***)")
    }
}

/// A configuration that cannot be used.
#[derive(Debug)]
pub enum ConfigError {
    /// The file could not be read.
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The file is not TOML of the expected shape. `line` is 1-based.
    Parse {
        line: Option<usize>,
        message: String,
    },
    /// A setting has a value that cannot be used.
    Invalid {
        setting: &'static str,
        reason: &'static str,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Read { path, source } => {
                write!(f, "cannot read {}: {source}", path.display())
            }
            ConfigError::Parse {
                line: Some(line),
                message,
            } => write!(f, "line {line}: {message}"),
            ConfigError::Parse {
                line: None,
                message,
            } => f.write_str(message),
            ConfigError::Invalid { setting, reason } => write!(f, "{setting}: {reason}"),
        }
    }
}

impl std::error::Error for ConfigError {}

fn invalid(setting: &'static str, reason: &'static str) -> ConfigError {
    ConfigError::Invalid { setting, reason }
}

impl Config {
    /// Reads the file at `path`, with this process's environment.
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_owned(),
            source,
        })?;
        Config::parse(&text, |name| std::env::var(name).ok())
    }

    /// Reads a configuration from the text of its file, with `env` for the environment variables
    /// it consults ([`KEY_ENV`], `PATH`, `LOCALAPPDATA`, `COMPUTERNAME`, `HOSTNAME`).
    pub fn parse(text: &str, env: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let file: File = toml::from_str(text).map_err(|error| ConfigError::Parse {
            line: error
                .span()
                .map(|span| text[..span.start.min(text.len())].matches('\n').count() + 1),
            message: error.message().to_owned(),
        })?;
        let env = |name: &str| env(name).filter(|value| !value.trim().is_empty());
        Ok(Config {
            base_url: base_url(&file.base_url)?,
            key: key(env(KEY_ENV).or(file.key))?,
            adb: match file.adb {
                Some(adb) if adb.as_os_str().is_empty() => {
                    return Err(invalid("adb", "must not be empty"));
                }
                Some(adb) => adb,
                None => default_adb(env("PATH"), env("LOCALAPPDATA"), |p| p.is_file()),
            },
            serials: match file.serials {
                Some(serials) if serials.is_empty() => {
                    return Err(invalid(
                        "serials",
                        "lists no phone; leave it out to report every phone",
                    ));
                }
                Some(serials) if serials.iter().any(|s| s.trim().is_empty()) => {
                    return Err(invalid("serials", "has a blank serial"));
                }
                serials => serials,
            },
            bridge_id: match file.bridge_id {
                Some(id) => {
                    if id.trim().is_empty() || id.contains('\0') {
                        return Err(invalid("bridge_id", "must be a name"));
                    }
                    if id.chars().count() > MAX_ID_CHARS {
                        return Err(invalid("bridge_id", "is longer than 128 characters"));
                    }
                    id
                }
                None => env("COMPUTERNAME")
                    .or_else(|| env("HOSTNAME"))
                    .map(|name| name.replace('\0', "").chars().take(MAX_ID_CHARS).collect())
                    .filter(|name: &String| !name.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_BRIDGE_ID.to_owned()),
            },
        })
    }
}

/// The server's address: `https`, or `http` to this computer (the key would cross the network in
/// the clear otherwise); no user name, password, query or fragment; ending in `/`, so the routes
/// join under it.
fn base_url(text: &str) -> Result<Url, ConfigError> {
    let mut url = Url::parse(text.trim()).map_err(|_| invalid("base_url", "is not a URL"))?;
    let Some(host) = url.host_str() else {
        return Err(invalid("base_url", "has no host"));
    };
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => {
            return Err(invalid(
                "base_url",
                "must be https (plain http only to this computer)",
            ));
        }
        _ => return Err(invalid("base_url", "must be an https address")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(
            "base_url",
            "must not carry a user name or password; the key goes in `key`",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(invalid("base_url", "must not have a query or a fragment"));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// The key: set, and printable ASCII without spaces (it goes into a header as it is).
fn key(key: Option<String>) -> Result<BridgeKey, ConfigError> {
    let Some(key) = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()) else {
        return Err(invalid(
            "key",
            "is not set: give it in the file or in JEETA_DEVICE_BRIDGE_KEY",
        ));
    };
    if !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid(
            "key",
            "must be printable ASCII without spaces, as Jeeta issued it",
        ));
    }
    Ok(BridgeKey(key))
}

/// `adb` on `path` (the `PATH` variable), else the Android SDK's copy under `local_app_data`
/// (`%LOCALAPPDATA%`), else plain `adb`, which the driver then reports as missing. `is_file`
/// tells whether a candidate exists.
pub fn default_adb(
    path: Option<String>,
    local_app_data: Option<String>,
    is_file: impl Fn(&Path) -> bool,
) -> PathBuf {
    let program = if cfg!(windows) { "adb.exe" } else { "adb" };
    if let Some(path) = path {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(program);
            if is_file(&candidate) {
                return candidate;
            }
        }
    }
    if let Some(local) = local_app_data {
        let sdk = Path::new(&local)
            .join("Android")
            .join("Sdk")
            .join("platform-tools")
            .join("adb.exe");
        if is_file(&sdk) {
            return sdk;
        }
    }
    PathBuf::from("adb")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "jk_test_0123456789";

    fn parse(text: &str) -> Result<Config, ConfigError> {
        Config::parse(text, |_| None)
    }

    #[test]
    fn a_full_file_is_read() {
        let config = parse(&format!(
            "base_url = \"https://jeeta.example/base\"\nkey = \"{KEY}\"\nadb = 'C:\\adb\\adb.exe'\n\
             serials = [\"18cf9fbb\"]\nbridge_id = \"atolye\"\n"
        ))
        .unwrap();
        assert_eq!(config.base_url.as_str(), "https://jeeta.example/base/");
        assert_eq!(config.key.expose(), KEY);
        assert_eq!(config.adb, PathBuf::from("C:\\adb\\adb.exe"));
        assert_eq!(config.serials, Some(vec!["18cf9fbb".to_owned()]));
        assert_eq!(config.bridge_id, "atolye");
        // Debug never shows the key.
        assert!(!format!("{config:?}").contains(KEY));
    }

    #[test]
    fn the_key_comes_from_the_environment_first() {
        let text = "base_url = \"https://jeeta.example\"\nkey = \"from-file\"\n";
        let env = |name: &str| (name == KEY_ENV).then(|| "from-env".to_owned());
        assert_eq!(Config::parse(text, env).unwrap().key.expose(), "from-env");
        assert_eq!(parse(text).unwrap().key.expose(), "from-file");
        // A blank variable counts as unset.
        let blank = |name: &str| (name == KEY_ENV).then(|| " ".to_owned());
        assert_eq!(
            Config::parse(text, blank).unwrap().key.expose(),
            "from-file"
        );
        let missing = parse("base_url = \"https://jeeta.example\"\n").unwrap_err();
        assert!(missing.to_string().starts_with("key:"), "{missing}");
    }

    #[test]
    fn plain_http_only_to_this_computer() {
        for ok in [
            "http://127.0.0.1:3100",
            "http://localhost:3100",
            "http://[::1]:8",
        ] {
            let text = format!("base_url = \"{ok}\"\nkey = \"{KEY}\"\n");
            assert!(parse(&text).is_ok(), "{ok}");
        }
        for refused in [
            "http://jeeta.example",
            "ftp://jeeta.example",
            "https://user:pw@jeeta.example",
            "https://jeeta.example/?a=1",
            "jeeta.example",
        ] {
            let text = format!("base_url = \"{refused}\"\nkey = \"{KEY}\"\n");
            let error = parse(&text).unwrap_err();
            assert!(
                error.to_string().starts_with("base_url:"),
                "{refused}: {error}"
            );
        }
    }

    #[test]
    fn errors_never_repeat_the_key() {
        // A setting that does not parse, on the key's own line.
        let broken = format!("base_url = \"https://jeeta.example\"\nkey = \"{KEY}\n");
        let error = parse(&broken).unwrap_err();
        assert!(
            matches!(error, ConfigError::Parse { line: Some(2), .. }),
            "{error}"
        );
        assert!(!error.to_string().contains(KEY), "{error}");
        // A key that cannot go into a header.
        let spaced = "base_url = \"https://jeeta.example\"\nkey = \"jk test secret\"\n";
        let error = parse(spaced).unwrap_err();
        assert!(!error.to_string().contains("secret"), "{error}");
        // A misspelt setting is refused by name.
        let typo = format!("base_url = \"https://jeeta.example\"\nkey = \"{KEY}\"\nserial = []\n");
        let error = parse(&typo).unwrap_err();
        assert!(error.to_string().contains("serial"), "{error}");
        assert!(!error.to_string().contains(KEY), "{error}");
    }

    #[test]
    fn the_bridge_id_defaults_to_the_computers_name() {
        let text = format!("base_url = \"https://jeeta.example\"\nkey = \"{KEY}\"\n");
        let named = |name: &str| (name == "COMPUTERNAME").then(|| "ATOLYE-PC".to_owned());
        assert_eq!(Config::parse(&text, named).unwrap().bridge_id, "ATOLYE-PC");
        assert_eq!(parse(&text).unwrap().bridge_id, DEFAULT_BRIDGE_ID);
    }

    #[test]
    fn adb_is_looked_up_on_the_path_then_in_the_sdk() {
        let program = if cfg!(windows) { "adb.exe" } else { "adb" };
        let path = std::env::join_paths(["/one", "/two"])
            .unwrap()
            .into_string()
            .unwrap();
        let on_path = Path::new("/two").join(program);
        let found = default_adb(Some(path.clone()), None, |p| p == on_path);
        assert_eq!(found, on_path);
        let sdk = Path::new("/local/Android/Sdk/platform-tools/adb.exe");
        let found = default_adb(Some(path), Some("/local".into()), |p| p == sdk);
        assert_eq!(found, sdk);
        assert_eq!(default_adb(None, None, |_| false), PathBuf::from("adb"));
    }
}
