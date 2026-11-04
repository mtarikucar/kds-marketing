//! The life of a queued command: `queued` to `leased` to one of four ends.

use serde::{Deserialize, Serialize};
use time::Duration;

/// How long a leased command waits for its acknowledgement before it is handed out again. The
/// bridge tells a redelivery from a new command by the command's id.
pub const REDELIVER_AFTER: Duration = Duration::seconds(10);

/// How long a command may wait to be leased unless the caller says otherwise: a bridge that was
/// off must not replay a stale tap hours later.
pub const DEFAULT_EXPIRES_IN: Duration = Duration::minutes(5);

/// Where a command stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Queued,
    Leased,
    Done,
    Failed,
    Expired,
    Canceled,
}

impl CommandStatus {
    /// Every status, in declaration order.
    pub const ALL: &[CommandStatus] = &[
        CommandStatus::Queued,
        CommandStatus::Leased,
        CommandStatus::Done,
        CommandStatus::Failed,
        CommandStatus::Expired,
        CommandStatus::Canceled,
    ];

    /// The stored and wire name, e.g. `"leased"`.
    pub fn key(self) -> &'static str {
        match self {
            CommandStatus::Queued => "queued",
            CommandStatus::Leased => "leased",
            CommandStatus::Done => "done",
            CommandStatus::Failed => "failed",
            CommandStatus::Expired => "expired",
            CommandStatus::Canceled => "canceled",
        }
    }

    /// The status named `key`.
    pub fn from_key(key: &str) -> Option<CommandStatus> {
        CommandStatus::ALL.iter().copied().find(|s| s.key() == key)
    }

    /// Whether the command is over: it is never leased again and nobody waits for it. A final
    /// status is not always the last word: a result that arrives late can still replace an
    /// `Expired` or `Canceled` one, if the command was leased before it ended (see
    /// [`next_status`]).
    pub fn is_final(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Failed | Self::Expired | Self::Canceled
        )
    }
}

/// Why a command failed: a stable code, so a caller can act on it without reading a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    DeviceOffline,
    ElementNotFound,
    UnicodeUnsupported,
    UnsupportedOnPlatform,
    UnsupportedByBridge,
    AdbError,
    ScreenBusy,
    Timeout,
    BridgeError,
    /// The file a command names is not there: a `push_file`'s Jeeta file is not stored (it was
    /// removed, or never was), or a `pull_file`'s path names nothing on the phone.
    FileNotFound,
    /// A reason this version does not know: a newer bridge's new reason must not make an older
    /// server reject a whole batch of results. Always the last variant.
    #[serde(other)]
    Unknown,
}

impl FailReason {
    /// Every reason, in declaration order.
    pub const ALL: &[FailReason] = &[
        FailReason::DeviceOffline,
        FailReason::ElementNotFound,
        FailReason::UnicodeUnsupported,
        FailReason::UnsupportedOnPlatform,
        FailReason::UnsupportedByBridge,
        FailReason::AdbError,
        FailReason::ScreenBusy,
        FailReason::Timeout,
        FailReason::BridgeError,
        FailReason::FileNotFound,
        FailReason::Unknown,
    ];

    /// The stored and wire name, e.g. `"adb_error"`.
    pub fn key(self) -> &'static str {
        match self {
            FailReason::DeviceOffline => "device_offline",
            FailReason::ElementNotFound => "element_not_found",
            FailReason::UnicodeUnsupported => "unicode_unsupported",
            FailReason::UnsupportedOnPlatform => "unsupported_on_platform",
            FailReason::UnsupportedByBridge => "unsupported_by_bridge",
            FailReason::AdbError => "adb_error",
            FailReason::ScreenBusy => "screen_busy",
            FailReason::Timeout => "timeout",
            FailReason::BridgeError => "bridge_error",
            FailReason::FileNotFound => "file_not_found",
            FailReason::Unknown => "unknown",
        }
    }

    /// The reason named `key`. A name no variant owns is `None`, not `Unknown`: only the wire is
    /// forgiving.
    pub fn from_key(key: &str) -> Option<FailReason> {
        FailReason::ALL.iter().copied().find(|r| r.key() == key)
    }
}

/// Something that happens to a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleEvent {
    Leased,
    Done,
    Failed,
    Expired,
    Canceled,
}

impl LifecycleEvent {
    /// Every event, in declaration order.
    pub const ALL: &[LifecycleEvent] = &[
        LifecycleEvent::Leased,
        LifecycleEvent::Done,
        LifecycleEvent::Failed,
        LifecycleEvent::Expired,
        LifecycleEvent::Canceled,
    ];

    /// The wire name, e.g. `"expired"`.
    pub fn key(self) -> &'static str {
        match self {
            LifecycleEvent::Leased => "leased",
            LifecycleEvent::Done => "done",
            LifecycleEvent::Failed => "failed",
            LifecycleEvent::Expired => "expired",
            LifecycleEvent::Canceled => "canceled",
        }
    }
}

/// An event a command's status does not allow.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a {} command cannot be {}", .from.key(), .event.key())]
pub struct LifecycleError {
    pub from: CommandStatus,
    pub event: LifecycleEvent,
}

/// The status after `event`. `ever_leased` is whether a bridge was ever handed the command (the
/// row's lease time is set); it matters only for a late result.
///
/// - A command is leased from `Queued`, and again from `Leased` (a redelivery).
/// - It finishes (`Done`) only after a lease, but it can fail, expire or be canceled before one
///   (refused up front, or never picked up).
/// - A bridge's result is the truth even after the fact: a `Done` or `Failed` result arriving for
///   an `Expired` or `Canceled` command replaces that status, but only if the command was leased
///   before it ended. A command that ended in the queue has no bridge that ever held it, so a
///   result for it is refused. Such a command is never leased again.
/// - Nothing else moves a command that is `Done`, `Failed`, `Expired` or `Canceled`.
pub fn next_status(
    current: CommandStatus,
    event: LifecycleEvent,
    ever_leased: bool,
) -> Result<CommandStatus, LifecycleError> {
    use CommandStatus as S;
    use LifecycleEvent as E;
    match (current, event) {
        (S::Queued | S::Leased, E::Leased) => Ok(S::Leased),
        (S::Leased, E::Done) => Ok(S::Done),
        (S::Expired | S::Canceled, E::Done) if ever_leased => Ok(S::Done),
        (S::Queued | S::Leased, E::Failed) => Ok(S::Failed),
        (S::Expired | S::Canceled, E::Failed) if ever_leased => Ok(S::Failed),
        (S::Queued | S::Leased, E::Expired) => Ok(S::Expired),
        (S::Queued | S::Leased, E::Canceled) => Ok(S::Canceled),
        _ => Err(LifecycleError {
            from: current,
            event,
        }),
    }
}
