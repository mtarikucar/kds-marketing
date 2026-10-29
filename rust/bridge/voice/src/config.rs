//! The bridge's configuration, from its environment (systemd `EnvironmentFile`s
//! `/etc/jeeta-voice/ari.env` and `/etc/jeeta-voice/bridge.env`). `Debug` hides the key and the
//! ARI password.
//!
//! | Variable | Default |
//! |---|---|
//! | `JEETA_BASE_URL`, `JEETA_BRIDGE_KEY` | none: required by `run` |
//! | `VOICE_EXTENSION` | `102` |
//! | `ARI_URL`, `ARI_USER` | `http://127.0.0.1:8188`, `jeeta-voice` |
//! | `ARI_PASSWORD` | none: always required |
//! | `LISTEN_SOCKET` | `unix:/run/jeeta-voice/listen/listen.sock` |
//! | `SPEAK_SOCKET` | `unix:/run/jeeta-voice/speak.sock` |
//! | `VOICE_CACHE_DIR` | `/var/lib/jeeta-voice/cache` |
//! | `VOICE_TRACE_FILE` | `/var/lib/jeeta-voice/traces.jsonl` |
//! | `VOICE_ACK_MS`, `VOICE_FILLER_MS`, `VOICE_LONG_WAIT_MS`, `VOICE_STILL_THERE_MS`, `VOICE_PHRASE_GAP_MS` | [`Timing::default`] |

use std::path::PathBuf;

use crate::speech::Endpoint;
use crate::talker::Timing;

#[derive(Clone)]
pub struct Config {
    pub jeeta_base_url: String,
    pub bridge_key: String,
    pub extension: String,
    pub ari_url: String,
    pub ari_user: String,
    pub ari_password: String,
    pub listen: Endpoint,
    pub speak: Endpoint,
    pub cache_dir: PathBuf,
    pub trace_file: PathBuf,
    pub timing: Timing,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("jeeta_base_url", &self.jeeta_base_url)
            .field("extension", &self.extension)
            .field("ari_url", &self.ari_url)
            .field("listen", &self.listen)
            .field("speak", &self.speak)
            .field("cache_dir", &self.cache_dir)
            .field("timing", &self.timing)
            .finish_non_exhaustive()
    }
}

/// What is wrong with the environment: the variable's name, never its value.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{0} is not valid")]
    Invalid(&'static str),
}

/// The milliseconds in `name`, or `default` when it is not set.
fn ms(
    get: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: u64,
) -> Result<u64, ConfigError> {
    match get(name) {
        Some(v) => v.trim().parse().map_err(|_| ConfigError::Invalid(name)),
        None => Ok(default),
    }
}

impl Config {
    /// The configuration from `get` (the environment). `need_core`: the core's address and the key
    /// must be set (`run`); the slice and the checks run without them.
    pub fn from_env(
        get: impl Fn(&str) -> Option<String>,
        need_core: bool,
    ) -> Result<Config, ConfigError> {
        let required = |name: &'static str| {
            get(name)
                .filter(|v| !v.trim().is_empty())
                .ok_or(ConfigError::Missing(name))
        };
        let (jeeta_base_url, bridge_key) = if need_core {
            (required("JEETA_BASE_URL")?, required("JEETA_BRIDGE_KEY")?)
        } else {
            (
                get("JEETA_BASE_URL").unwrap_or_default(),
                get("JEETA_BRIDGE_KEY").unwrap_or_default(),
            )
        };
        let endpoint = |name: &'static str, default: &str| -> Result<Endpoint, ConfigError> {
            get(name)
                .unwrap_or_else(|| default.to_owned())
                .parse()
                .map_err(|_| ConfigError::Invalid(name))
        };
        let base = Timing::default();
        Ok(Config {
            jeeta_base_url: jeeta_base_url.trim_end_matches('/').to_owned(),
            bridge_key,
            extension: get("VOICE_EXTENSION").unwrap_or_else(|| "102".into()),
            ari_url: get("ARI_URL").unwrap_or_else(|| "http://127.0.0.1:8188".into()),
            ari_user: get("ARI_USER").unwrap_or_else(|| "jeeta-voice".into()),
            ari_password: required("ARI_PASSWORD")?,
            listen: endpoint("LISTEN_SOCKET", "unix:/run/jeeta-voice/listen/listen.sock")?,
            speak: endpoint("SPEAK_SOCKET", "unix:/run/jeeta-voice/speak.sock")?,
            cache_dir: get("VOICE_CACHE_DIR")
                .unwrap_or_else(|| "/var/lib/jeeta-voice/cache".into())
                .into(),
            trace_file: get("VOICE_TRACE_FILE")
                .unwrap_or_else(|| "/var/lib/jeeta-voice/traces.jsonl".into())
                .into(),
            timing: Timing {
                ack_after_ms: ms(&get, "VOICE_ACK_MS", base.ack_after_ms)?,
                filler_after_ms: ms(&get, "VOICE_FILLER_MS", base.filler_after_ms)?,
                long_wait_after_ms: ms(&get, "VOICE_LONG_WAIT_MS", base.long_wait_after_ms)?,
                still_there_after_ms: ms(&get, "VOICE_STILL_THERE_MS", base.still_there_after_ms)?,
                phrase_gap_ms: ms(&get, "VOICE_PHRASE_GAP_MS", base.phrase_gap_ms)?,
            },
        })
    }
}
