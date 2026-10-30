//! What the bridge needs of a phone: a driver per platform behind [`PhoneDriver`], the phones
//! attached to this computer behind [`PhoneRegistry`], and [`FileTransfer`], the seam through
//! which a driver moves screenshots and files to and from Jeeta.
//!
//! The loop ([`crate::run_loop`]) owns everything between the server and these traits: which
//! phones are registered, which commands run when, and what is posted back. A driver only reads
//! its phone and carries out one command at a time; the loop never runs two commands on one
//! phone at once.

pub mod android;

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use jt_device_protocol::{CommandResult, DeviceCommand, FailReason, PhoneReport, Platform};
use uuid::Uuid;

/// One phone, driven through its platform's tools (`adb` for Android).
///
/// # Cancellation
///
/// The loop cancels a command by dropping the future [`PhoneDriver::execute`] returned: when the
/// command outlasts its timeout (`Timing::command_timeout`, or `Timing::transfer_timeout` for
/// `push_file` and `pull_file`) and when the bridge stops. The future may be dropped at any
/// `.await`, so a driver:
///
/// - spawns every child process with `kill_on_drop(true)` (`tokio::process::Command`), so that a
///   cancelled command leaves no `adb` running;
/// - holds every temporary file in a guard that removes it on drop;
/// - leaves what it cannot undo in `Drop` (which cannot `.await`, such as restoring the input
///   method a Unicode `text` command set) to [`PhoneDriver::recover`], which the loop awaits
///   after the dropped future is gone and before the phone's next command.
#[async_trait]
pub trait PhoneDriver: Send + Sync {
    /// The platform of the phone. The loop sets each report's `platform` to it.
    fn platform(&self) -> Platform;

    /// What the phone is and what the bridge can run on it, for the next register. The loop sets
    /// its `serial` to the one the registry listed the phone under, and its `platform` to
    /// [`PhoneDriver::platform`].
    ///
    /// It runs at every heartbeat, possibly while a command runs on the same phone (a
    /// `push_file` may take minutes): it must not wait behind [`PhoneDriver::execute`]. One that
    /// fails or takes longer than `Timing::report_timeout` is replaced by the phone's last good
    /// report for a few heartbeats (`run_loop::STALE_REPORT_HEARTBEATS`).
    async fn report(&self) -> Result<PhoneReport, DriverError>;

    /// Carries out one command, which already passed `DeviceCommand::validate`. A screenshot
    /// or a pulled file goes up, and a `push_file` command's file comes down, through `files`.
    /// The future may be dropped: see the trait's notes on cancellation.
    async fn execute(
        &self,
        cmd: &DeviceCommand,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError>;

    /// Puts the phone back in a usable state after a command was cut off (its timeout, or the
    /// bridge stopping) or its driver panicked, once that command's future is gone and before
    /// the phone's next command: for example, restores the input method a cut Unicode `text`
    /// command set. It is bounded by `run_loop::RECOVER_TIMEOUT`, it is not called after a
    /// command that ended on its own, and it must be cheap when nothing is left to undo. The
    /// default does nothing.
    async fn recover(&self) {}
}

/// Why a phone could not be read or a command not carried out.
///
/// `detail` becomes the failure's detail on the server (see `Outcome::failed`, which cuts it to
/// size). It can carry on-screen labels, so the bridge never logs it: only `reason`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriverError {
    pub reason: FailReason,
    pub detail: String,
}

impl DriverError {
    /// A failure for `reason`, described by `detail`.
    pub fn new(reason: FailReason, detail: impl Into<String>) -> DriverError {
        DriverError {
            reason,
            detail: detail.into(),
        }
    }
}

/// The type of a file uploaded to Jeeta: the two the bridge's files route takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentType {
    /// A screenshot.
    Png,
    /// Any other file, such as one pulled from the phone.
    OctetStream,
}

impl ContentType {
    /// The media type, e.g. `image/png`.
    pub fn mime(self) -> &'static str {
        match self {
            ContentType::Png => "image/png",
            ContentType::OctetStream => "application/octet-stream",
        }
    }
}

/// Moves the files of one command between the bridge and Jeeta.
///
/// The loop hands each command its own transfer, which holds that command's signed download
/// address, if it has one: a driver never sees the address, so it cannot leak it into a log or a
/// failure's detail. A failed transfer is a [`FailReason::BridgeError`] whose detail names no
/// address; a download Jeeta answers 404 (the file was deleted, or its address ran out) is a
/// [`FailReason::FileNotFound`].
#[async_trait]
pub trait FileTransfer: Send + Sync {
    /// Uploads `bytes` (a screenshot, say) as a Jeeta file and answers its id.
    async fn upload(&self, bytes: Vec<u8>, content_type: ContentType) -> Result<Uuid, DriverError>;

    /// Uploads the file at `path` (one pulled from the phone, say) as a Jeeta file, streaming it
    /// rather than holding it in memory, and answers its id.
    async fn upload_file(
        &self,
        path: &Path,
        content_type: ContentType,
    ) -> Result<Uuid, DriverError>;

    /// Downloads the file of the command being run (a `push_file`) into `dest`, a file the
    /// driver chose, and answers how many bytes were written. The file is written as it arrives,
    /// not held in memory, and is removed when the download fails or is cancelled. A command
    /// without a file to download is refused.
    async fn download(&self, dest: &Path) -> Result<u64, DriverError>;
}

/// A phone attached to this computer now, and its driver.
#[derive(Clone)]
pub struct AttachedPhone {
    /// The platform's own id of the phone (`adb devices` serial, iOS UDID). Commands are routed
    /// by it.
    pub serial: String,
    pub driver: Arc<dyn PhoneDriver>,
}

/// The phones attached to this computer.
#[async_trait]
pub trait PhoneRegistry: Send + Sync {
    /// The phones attached now, one driver each, listed before every register. A phone listed
    /// twice is reported once.
    ///
    /// The same phone gets the same driver (the same `Arc`) on every call while it stays
    /// attached: a driver may hold a session or a process for its phone (an iOS driver holds a
    /// WebDriverAgent session and its port forward), and the loop keeps using the driver it was
    /// given. A listing that fails, panics or takes longer than `Timing::report_timeout` is
    /// replaced by the last good one.
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError>;
}
