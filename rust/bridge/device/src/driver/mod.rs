//! What the bridge needs of a phone: a driver per platform behind [`PhoneDriver`], the phones
//! attached to this computer behind [`PhoneRegistry`], and [`FileTransfer`], the seam through
//! which a driver moves screenshots and files to and from Jeeta.
//!
//! The loop ([`crate::run_loop`]) owns everything between the server and these traits: which
//! phones are registered, which commands run when, and what is posted back. A driver only reads
//! its phone and carries out one command at a time; the loop never runs two commands on one
//! phone at once.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use jt_device_protocol::{CommandResult, DeviceCommand, FailReason, PhoneReport, Platform};
use uuid::Uuid;

/// One phone, driven through its platform's tools (`adb` for Android).
#[async_trait]
pub trait PhoneDriver: Send + Sync {
    /// The platform of the phone.
    fn platform(&self) -> Platform;

    /// What the phone is and what the bridge can run on it, for the next register. Its `serial`
    /// is the one the registry listed the phone under: the loop sets it to that.
    async fn report(&self) -> Result<PhoneReport, DriverError>;

    /// Carries out one command, which already passed `DeviceCommand::validate`. A screenshot
    /// or a pulled file goes up, and a `push_file` command's file comes down, through `files`.
    async fn execute(
        &self,
        cmd: &DeviceCommand,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError>;
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

/// Moves the files of one command between the bridge and Jeeta.
///
/// The loop hands each command its own transfer, which holds that command's signed download
/// address, if it has one: a driver never sees the address, so it cannot leak it into a log or a
/// failure's detail. A failed transfer is a [`FailReason::BridgeError`] whose detail names no
/// address.
#[async_trait]
pub trait FileTransfer: Send + Sync {
    /// Uploads `bytes` as a Jeeta file and answers its id: a screenshot (`image/png`) or a file
    /// pulled from the phone (`application/octet-stream`).
    async fn upload(&self, bytes: Vec<u8>, content_type: &str) -> Result<Uuid, DriverError>;

    /// Downloads the file of the command being run (a `push_file`) into `dest`, a file the
    /// driver chose, and answers how many bytes were written. The file is written as it arrives,
    /// not held in memory. A command without a file to download is refused.
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
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError>;
}
