//! The device bridges' upload turns: how many uploads (`bridge::files`) a workspace's bridges have
//! stored at once, screenshots and pulled files in pools of their own. A workspace's slow pulls
//! never hold up another workspace's uploads, nor its own screenshots. An upload that gets no turn
//! within [`UploadLimits::turn_wait`] is answered at once with a status the bridge tries again
//! (`503`), not held; a body that sends nothing for [`UploadLimits::chunk_idle`] is refused.
//!
//! The turns are this server instance's own (like the bridges' signals): `Deps::device_uploads`
//! holds them, and a test makes its own with the limits it needs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use jt_tenancy::WorkspaceId;
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{AppError, ErrorCode};

/// How many screenshots one workspace's bridges upload at once.
pub const SCREENSHOT_TURNS: usize = 2;
/// How many pulled files one workspace's bridges upload at once.
pub const PULLED_FILE_TURNS: usize = 2;
/// The longest an upload waits for its turn before it is answered `503`.
pub const TURN_WAIT: StdDuration = StdDuration::from_secs(10);
/// The longest an upload's body may send nothing before it is refused.
pub const CHUNK_IDLE: StdDuration = StdDuration::from_secs(30);
/// What a `503` for a turn tells the bridge to wait before it tries again, in seconds.
pub const RETRY_AFTER_S: i64 = 5;

/// Which pool an upload takes its turn from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UploadKind {
    /// A screenshot (`image/png`): small, and what an agent waits on while it looks at a phone.
    Screenshot,
    /// A file pulled off a phone (`application/octet-stream`): up to `DEVICE_FILE_LIMIT`.
    PulledFile,
}

/// The limits of the upload turns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UploadLimits {
    /// Per workspace, [`UploadKind::Screenshot`].
    pub screenshot_turns: usize,
    /// Per workspace, [`UploadKind::PulledFile`].
    pub pulled_file_turns: usize,
    /// The longest an upload waits for its turn.
    pub turn_wait: StdDuration,
    /// The longest a body may send nothing.
    pub chunk_idle: StdDuration,
}

impl Default for UploadLimits {
    /// [`SCREENSHOT_TURNS`], [`PULLED_FILE_TURNS`], [`TURN_WAIT`] and [`CHUNK_IDLE`].
    fn default() -> Self {
        UploadLimits {
            screenshot_turns: SCREENSHOT_TURNS,
            pulled_file_turns: PULLED_FILE_TURNS,
            turn_wait: TURN_WAIT,
            chunk_idle: CHUNK_IDLE,
        }
    }
}

/// The upload turns of every workspace, one pool per workspace and [`UploadKind`], made when the
/// workspace's first upload of that kind asks.
#[derive(Debug, Default)]
pub struct UploadTurns {
    limits: UploadLimits,
    pools: Mutex<HashMap<(WorkspaceId, UploadKind), Arc<Semaphore>>>,
}

/// A turn: the upload holds it until it is dropped.
#[derive(Debug)]
pub struct UploadTurn {
    _permit: OwnedSemaphorePermit,
}

impl UploadTurns {
    /// Turns with `limits`.
    pub fn new(limits: UploadLimits) -> Self {
        UploadTurns {
            limits,
            pools: Mutex::default(),
        }
    }

    pub fn limits(&self) -> UploadLimits {
        self.limits
    }

    /// A turn of workspace `ws` for an upload of `kind`, waited for at most
    /// [`UploadLimits::turn_wait`]. When none comes in time, `UPSTREAM_UNAVAILABLE` (`503`),
    /// retryable, with `details.retry_after_s`.
    pub async fn take(&self, ws: WorkspaceId, kind: UploadKind) -> Result<UploadTurn, AppError> {
        let pool = {
            let mut pools = self
                .pools
                .lock()
                .map_err(|_| AppError::internal("the upload turns are poisoned"))?;
            let turns = match kind {
                UploadKind::Screenshot => self.limits.screenshot_turns,
                UploadKind::PulledFile => self.limits.pulled_file_turns,
            };
            pools
                .entry((ws, kind))
                .or_insert_with(|| Arc::new(Semaphore::new(turns)))
                .clone()
        };
        match tokio::time::timeout(self.limits.turn_wait, pool.acquire_owned()).await {
            Ok(Ok(permit)) => Ok(UploadTurn { _permit: permit }),
            _ => Err(AppError {
                code: ErrorCode::UpstreamUnavailable,
                message: "every upload turn of the workspace is taken; try again later".into(),
                details: json!({
                    "reason": "upload_turns_taken",
                    "retryable": true,
                    "retry_after_s": RETRY_AFTER_S,
                }),
            }),
        }
    }
}
