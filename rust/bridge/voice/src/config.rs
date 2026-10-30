//! The bridge's configuration, from its environment (systemd `EnvironmentFile`s
//! `/etc/jeeta-voice/ari.env` and `/etc/jeeta-voice/bridge.env`). `Debug` hides the key and the
//! ARI password. A variable set to nothing (or to spaces) is unset, so `VOICE_CACHE_DIR=` is the
//! default directory and not the working one.
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
//! | `VOICE_MAX_CALL_S` | `600`: the slice's longest call, 1 to 3 600 s (`run` takes each plan's) |
//! | `VOICE_ACK_MS`, `VOICE_FILLER_MS`, `VOICE_LONG_WAIT_MS`, `VOICE_STILL_THERE_MS`, `VOICE_PHRASE_GAP_MS` | [`Timing::default`] |
//!
//! The sockets follow the speech services' own rules ([`Endpoint`]). The timings must be ones the
//! talker can keep (design addendum §3): acknowledgement before filler before long wait, the long
//! wait before the core's fallback line ([`LONG_WAIT_LIMIT_MS`]), "still there" before the core
//! closes a silent call ([`STILL_THERE_LIMIT_MS`]), and a gap between phrases below
//! [`PHRASE_GAP_LIMIT_MS`]. A phrase timed past its successor or past the core is never heard,
//! so such a value is refused at start instead of skipped during a call.

use std::path::PathBuf;

use crate::speech::Endpoint;
use crate::talker::Timing;

/// The core plays its fallback line 20 s into a wait for the agent: a long wait after it never
/// plays.
pub const LONG_WAIT_LIMIT_MS: u64 = 20_000;
/// The core ends a call after 15 s of the caller's silence: a "still there" after it never plays.
pub const STILL_THERE_LIMIT_MS: u64 = 15_000;
/// The longest a slice's call may be, in seconds, unless `VOICE_MAX_CALL_S` says otherwise.
pub const MAX_CALL_S: u64 = 600;
/// The most `VOICE_MAX_CALL_S` may be: an hour.
const MAX_CALL_LIMIT_S: u64 = 3_600;

/// The gap holds the filler back after the acknowledgement ends (about 1.1 s into the wait, by
/// default): below this cap the filler still comes before the core's own 4 s holding line, with a
/// margin for a longer acknowledgement.
pub const PHRASE_GAP_LIMIT_MS: u64 = 2_000;

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
    /// The slice's longest call, in seconds (B6 review): its closing plays then.
    pub max_call_s: u64,
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
            .field("max_call_s", &self.max_call_s)
            .finish_non_exhaustive()
    }
}

/// What is wrong with the environment: the variables' names and the limits, never a value.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{0} is not valid")]
    Invalid(&'static str),
    #[error("{0} must be less than {1}")]
    Order(&'static str, &'static str),
    #[error("{0} must be less than {1} ms")]
    TooLarge(&'static str, u64),
}

/// The whole number in `name` (milliseconds, or seconds for `VOICE_MAX_CALL_S`), or `default`
/// when it is not set.
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

/// Refuses timings the talker cannot keep (see the module docs).
fn check(timing: &Timing) -> Result<(), ConfigError> {
    if timing.ack_after_ms >= timing.filler_after_ms {
        return Err(ConfigError::Order("VOICE_ACK_MS", "VOICE_FILLER_MS"));
    }
    if timing.filler_after_ms >= timing.long_wait_after_ms {
        return Err(ConfigError::Order("VOICE_FILLER_MS", "VOICE_LONG_WAIT_MS"));
    }
    for (name, value, limit) in [
        (
            "VOICE_LONG_WAIT_MS",
            timing.long_wait_after_ms,
            LONG_WAIT_LIMIT_MS,
        ),
        (
            "VOICE_STILL_THERE_MS",
            timing.still_there_after_ms,
            STILL_THERE_LIMIT_MS,
        ),
        (
            "VOICE_PHRASE_GAP_MS",
            timing.phrase_gap_ms,
            PHRASE_GAP_LIMIT_MS,
        ),
    ] {
        if value >= limit {
            return Err(ConfigError::TooLarge(name, limit));
        }
    }
    Ok(())
}

impl Config {
    /// The configuration from `get` (the environment). `need_core`: the core's address and the key
    /// must be set (`run`); the slice and the checks run without them.
    pub fn from_env(
        get: impl Fn(&str) -> Option<String>,
        need_core: bool,
    ) -> Result<Config, ConfigError> {
        // Set to nothing is unset (B5 review).
        let get = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let required = |name: &'static str| get(name).ok_or(ConfigError::Missing(name));
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
                .trim()
                .parse()
                .map_err(|_| ConfigError::Invalid(name))
        };
        let base = Timing::default();
        let timing = Timing {
            ack_after_ms: ms(&get, "VOICE_ACK_MS", base.ack_after_ms)?,
            filler_after_ms: ms(&get, "VOICE_FILLER_MS", base.filler_after_ms)?,
            long_wait_after_ms: ms(&get, "VOICE_LONG_WAIT_MS", base.long_wait_after_ms)?,
            still_there_after_ms: ms(&get, "VOICE_STILL_THERE_MS", base.still_there_after_ms)?,
            phrase_gap_ms: ms(&get, "VOICE_PHRASE_GAP_MS", base.phrase_gap_ms)?,
        };
        check(&timing)?;
        let max_call_s = ms(&get, "VOICE_MAX_CALL_S", MAX_CALL_S)?;
        if !(1..=MAX_CALL_LIMIT_S).contains(&max_call_s) {
            return Err(ConfigError::Invalid("VOICE_MAX_CALL_S"));
        }
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
            timing,
            max_call_s,
        })
    }
}
