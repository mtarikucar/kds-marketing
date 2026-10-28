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
    /// Whether no event can move the command any more.
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

/// An event a command's status does not allow.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a {from:?} command cannot be {event:?}")]
pub struct LifecycleError {
    pub from: CommandStatus,
    pub event: LifecycleEvent,
}

/// The status after `event`. A leased command can be leased again (a redelivery), a command can
/// fail before it was ever leased (refused up front), and a final status accepts nothing.
pub fn next_status(
    current: CommandStatus,
    event: LifecycleEvent,
) -> Result<CommandStatus, LifecycleError> {
    if current.is_final() {
        return Err(LifecycleError {
            from: current,
            event,
        });
    }
    Ok(match event {
        LifecycleEvent::Leased => CommandStatus::Leased,
        LifecycleEvent::Done => CommandStatus::Done,
        LifecycleEvent::Failed => CommandStatus::Failed,
        LifecycleEvent::Expired => CommandStatus::Expired,
        LifecycleEvent::Canceled => CommandStatus::Canceled,
    })
}
