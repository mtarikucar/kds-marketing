//! What an agent can ask a device to do, and the bounds a command must respect.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The most characters one `text` command types, and in one `tap_on` target.
pub const MAX_TEXT_CHARS: usize = 4000;
/// The longest swipe, in milliseconds.
pub const MAX_SWIPE_MS: u32 = 5000;
/// The longest long press, in milliseconds.
pub const MAX_LONG_PRESS_MS: u32 = 10_000;
/// The most arguments one `shell` command passes.
pub const MAX_SHELL_ARGS: usize = 64;
/// The most characters in one `shell` argument.
pub const MAX_ARG_CHARS: usize = 4096;
/// The most characters in all of a `shell` command's arguments together, counting one separator
/// per argument.
pub const MAX_SHELL_TOTAL_CHARS: usize = 16_384;
/// The most characters in the address an `open_url` command opens.
pub const MAX_URL_CHARS: usize = 8192;
/// The most characters in the app id a `launch_app` command starts.
pub const MAX_APP_ID_CHARS: usize = 256;
/// The most characters in the device path of a `push_file` destination or a `pull_file` source.
pub const MAX_PATH_CHARS: usize = 4096;

/// One command for a device. On the wire it is an object tagged by `kind`; an unknown kind or an
/// unknown field is refused.
///
/// The payload carries typed text, shell arguments and screen text: log [`DeviceCommand::kind`],
/// never the `{:?}` of a command.
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
        // serde documents `flatten` together with `deny_unknown_fields` as unsupported. What this
        // type relies on (a second target key, or any unknown key, is refused) is pinned by the
        // test `unknown_kind_and_unknown_field_refused`.
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
    /// Run a program on the device. An argument list, never a command line to be split. The
    /// bridge must quote each argument for the device's shell: `adb shell` joins its arguments
    /// with spaces before the device shell reads them.
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

impl DeviceKey {
    /// Every key, in declaration order.
    pub const ALL: &[DeviceKey] = &[
        DeviceKey::Back,
        DeviceKey::Home,
        DeviceKey::Enter,
        DeviceKey::AppSwitch,
        DeviceKey::Delete,
        DeviceKey::VolumeUp,
        DeviceKey::VolumeDown,
        DeviceKey::Power,
    ];

    /// The wire name, e.g. `"app_switch"`.
    pub fn key(self) -> &'static str {
        match self {
            DeviceKey::Back => "back",
            DeviceKey::Home => "home",
            DeviceKey::Enter => "enter",
            DeviceKey::AppSwitch => "app_switch",
            DeviceKey::Delete => "delete",
            DeviceKey::VolumeUp => "volume_up",
            DeviceKey::VolumeDown => "volume_down",
            DeviceKey::Power => "power",
        }
    }

    /// The key named `key`.
    pub fn from_key(key: &str) -> Option<DeviceKey> {
        DeviceKey::ALL.iter().copied().find(|k| k.key() == key)
    }
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

/// A string that becomes (part of) a process argument: no NUL character, at most `max` characters.
fn argument(
    field: &'static str,
    value: &str,
    max: usize,
    too_long: &'static str,
) -> Result<(), CommandError> {
    if value.contains('\0') {
        return Err(invalid(field, "must not contain a NUL character"));
    }
    if value.chars().count() > max {
        return Err(invalid(field, too_long));
    }
    Ok(())
}

/// [`argument`] for a name, address or path, which must also carry something.
fn name(
    field: &'static str,
    value: &str,
    max: usize,
    too_long: &'static str,
) -> Result<(), CommandError> {
    not_blank(field, value)?;
    argument(field, value, max, too_long)
}

impl DeviceCommand {
    /// Every command kind: the wire tags [`DeviceCommand::kind`] returns, which are also the
    /// feature names a bridge lists for the commands it runs.
    pub const KINDS: &[&str] = &[
        "observe",
        "tap",
        "tap_on",
        "long_press",
        "swipe",
        "text",
        "key",
        "open_url",
        "launch_app",
        "shell",
        "push_file",
        "pull_file",
        "screenshot",
    ];

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

    /// Whether the command respects its bounds and is well formed: the lengths above, and no NUL
    /// character in a string that becomes a process argument (text, shell arguments, address,
    /// app id, paths, target). Bounds and well-formedness only: what a command is allowed to
    /// touch is not decided here.
    pub fn validate(&self) -> Result<(), CommandError> {
        match self {
            Self::Observe { .. } | Self::Tap { .. } | Self::Key { .. } | Self::Screenshot {} => {
                Ok(())
            }
            Self::TapOn { target, .. } => name(
                "target",
                target.value(),
                MAX_TEXT_CHARS,
                "is longer than 4000 characters",
            ),
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
                argument(
                    "value",
                    value,
                    MAX_TEXT_CHARS,
                    "is longer than 4000 characters",
                )
            }
            Self::OpenUrl { url } => {
                name("url", url, MAX_URL_CHARS, "is longer than 8192 characters")
            }
            Self::LaunchApp { app_id } => name(
                "app_id",
                app_id,
                MAX_APP_ID_CHARS,
                "is longer than 256 characters",
            ),
            Self::Shell { argv } => {
                if argv.is_empty() {
                    return Err(invalid("argv", "must have at least one argument"));
                }
                if argv.len() > MAX_SHELL_ARGS {
                    return Err(invalid("argv", "has more than 64 arguments"));
                }
                // One separator per argument, counted with the characters.
                let mut total = argv.len();
                for arg in argv {
                    argument(
                        "argv",
                        arg,
                        MAX_ARG_CHARS,
                        "has an argument longer than 4096 characters",
                    )?;
                    total += arg.chars().count();
                }
                if total > MAX_SHELL_TOTAL_CHARS {
                    return Err(invalid("argv", "has more than 16384 characters in all"));
                }
                Ok(())
            }
            Self::PushFile { dest, .. } => name(
                "dest",
                dest,
                MAX_PATH_CHARS,
                "is longer than 4096 characters",
            ),
            Self::PullFile { path } => name(
                "path",
                path,
                MAX_PATH_CHARS,
                "is longer than 4096 characters",
            ),
        }
    }
}
