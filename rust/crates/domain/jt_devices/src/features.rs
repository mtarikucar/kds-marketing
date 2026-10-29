//! What a bridge says it can do, and which commands that covers.

use serde::{Deserialize, Serialize};

use crate::command::DeviceCommand;

/// The feature a bridge lists when it can type characters outside ASCII.
pub const TEXT_UNICODE: &str = "text.unicode";

/// The kind of device behind a bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Android,
    Ios,
}

impl Platform {
    /// Every platform, in declaration order.
    pub const ALL: &[Platform] = &[Platform::Android, Platform::Ios];

    /// The stored and wire name, e.g. `"android"`.
    pub fn key(self) -> &'static str {
        match self {
            Platform::Android => "android",
            Platform::Ios => "ios",
        }
    }

    /// The platform named `key`.
    pub fn from_key(key: &str) -> Option<Platform> {
        Platform::ALL.iter().copied().find(|p| p.key() == key)
    }
}

/// Whether a bridge that lists `features` can carry out `cmd`: the command's kind must be listed,
/// and a `text` command with any character outside ASCII also needs [`TEXT_UNICODE`].
pub fn supports(features: &[String], cmd: &DeviceCommand) -> bool {
    let listed = |feature: &str| features.iter().any(|f| f == feature);
    if !listed(cmd.kind()) {
        return false;
    }
    match cmd {
        DeviceCommand::Text { value } if !value.is_ascii() => listed(TEXT_UNICODE),
        _ => true,
    }
}
