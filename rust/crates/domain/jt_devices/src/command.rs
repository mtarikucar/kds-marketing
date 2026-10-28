//! What an agent can ask a device to do, and the bounds a command must respect.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most characters one `text` command types.
pub const MAX_TEXT_CHARS: usize = 4000;
/// The longest swipe, in milliseconds.
pub const MAX_SWIPE_MS: u32 = 5000;
/// The longest long press, in milliseconds.
pub const MAX_LONG_PRESS_MS: u32 = 10_000;
/// The most arguments one `shell` command passes.
pub const MAX_SHELL_ARGS: usize = 64;
/// The most characters in one `shell` argument.
pub const MAX_ARG_CHARS: usize = 4096;

/// One command for a device. On the wire it is an object tagged by `kind`; an unknown kind or an
/// unknown field is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeviceCommand {
    /// Read the screen as a list of elements, optionally with a screenshot.
    Observe {
        #[serde(default)]
        screenshot: bool,
    },
    /// Tap a point, in screen pixels.
    Tap { x: u32, y: u32 },
    /// Find an element and tap it in one step.
    TapOn {
        #[serde(flatten)]
        target: ElementTarget,
        /// Match the whole string instead of a part of it.
        #[serde(default)]
        exact: bool,
    },
    /// Press a point for `ms` milliseconds.
    LongPress { x: u32, y: u32, ms: u32 },
    /// Drag from one point to another over `ms` milliseconds.
    Swipe {
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        ms: u32,
    },
    /// Type into the focused field.
    Text { value: String },
    /// Press a hardware or system key.
    Key { key: DeviceKey },
    /// Open a URL (or any address the device resolves, such as an intent).
    OpenUrl { url: String },
    /// Start an app by its package or bundle id.
    LaunchApp { app_id: String },
    /// Run a program on the device. An argument list, never a command line to be split.
    Shell { argv: Vec<String> },
    /// Copy a Jeeta file to `dest` on the device.
    PushFile { file_id: Uuid, dest: String },
    /// Copy the file at `path` on the device into Jeeta.
    PullFile { path: String },
    /// Capture the screen as an image. An empty struct variant rather than a unit one: serde
    /// ignores unknown fields on a unit variant of a tagged enum, and this one must refuse them.
    Screenshot {},
}

/// How `tap_on` finds its element: exactly one of the element's text, id or content description.
/// Flattened into the command, so it appears as a single `text`, `id` or `desc` field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementTarget {
    Text(String),
    Id(String),
    Desc(String),
}

impl ElementTarget {
    fn value(&self) -> &str {
        match self {
            Self::Text(v) | Self::Id(v) | Self::Desc(v) => v,
        }
    }
}

/// A key the `key` command presses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKey {
    Back,
    Home,
    Enter,
    AppSwitch,
    Delete,
    VolumeUp,
    VolumeDown,
    Power,
}

/// A command that breaks a bound.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CommandError {
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

fn invalid(field: &'static str, reason: &'static str) -> CommandError {
    CommandError::Invalid { field, reason }
}

fn not_blank(field: &'static str, value: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(invalid(field, "must not be blank"));
    }
    Ok(())
}

impl DeviceCommand {
    /// The command's wire tag.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Observe { .. } => "observe",
            Self::Tap { .. } => "tap",
            Self::TapOn { .. } => "tap_on",
            Self::LongPress { .. } => "long_press",
            Self::Swipe { .. } => "swipe",
            Self::Text { .. } => "text",
            Self::Key { .. } => "key",
            Self::OpenUrl { .. } => "open_url",
            Self::LaunchApp { .. } => "launch_app",
            Self::Shell { .. } => "shell",
            Self::PushFile { .. } => "push_file",
            Self::PullFile { .. } => "pull_file",
            Self::Screenshot {} => "screenshot",
        }
    }

    /// Whether the command respects its bounds. Bounds only: what a command is allowed to touch
    /// is not decided here.
    pub fn validate(&self) -> Result<(), CommandError> {
        match self {
            Self::Observe { .. } | Self::Tap { .. } | Self::Key { .. } | Self::Screenshot {} => {
                Ok(())
            }
            Self::TapOn { target, .. } => not_blank("target", target.value()),
            Self::LongPress { ms, .. } => {
                if *ms == 0 || *ms > MAX_LONG_PRESS_MS {
                    return Err(invalid("ms", "must be between 1 and 10000"));
                }
                Ok(())
            }
            Self::Swipe { ms, .. } => {
                if *ms == 0 || *ms > MAX_SWIPE_MS {
                    return Err(invalid("ms", "must be between 1 and 5000"));
                }
                Ok(())
            }
            Self::Text { value } => {
                if value.is_empty() {
                    return Err(invalid("value", "must not be empty"));
                }
                if value.chars().count() > MAX_TEXT_CHARS {
                    return Err(invalid("value", "is longer than 4000 characters"));
                }
                Ok(())
            }
            Self::OpenUrl { url } => not_blank("url", url),
            Self::LaunchApp { app_id } => not_blank("app_id", app_id),
            Self::Shell { argv } => {
                if argv.is_empty() {
                    return Err(invalid("argv", "must have at least one argument"));
                }
                if argv.len() > MAX_SHELL_ARGS {
                    return Err(invalid("argv", "has more than 64 arguments"));
                }
                if argv.iter().any(|a| a.chars().count() > MAX_ARG_CHARS) {
                    return Err(invalid(
                        "argv",
                        "has an argument longer than 4096 characters",
                    ));
                }
                Ok(())
            }
            Self::PushFile { dest, .. } => not_blank("dest", dest),
            Self::PullFile { path } => not_blank("path", path),
        }
    }
}
