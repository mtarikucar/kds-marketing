//! The signed retrieval route, `GET /files/{id}?workspace&expires&signature[&purpose]`
//! ([`router`]): a file the store keeps, while its address is signed for ([`crate::verify_for`]),
//! served as a stream (`FileStore::read_stream`) with its length announced. Neither a large file
//! nor many reads of one at once (a ten-minute `push_file` address that leaked, say) are held in
//! memory whole.
//!
//! - **Checked before it is answered, where it fits.** The file's first chunk (up to
//!   [`crate::READ_CHUNK`] bytes) is read before anything is sent, and the store gives out the
//!   chunk that completes a file only once its hash is the header's: a file that fits in one chunk
//!   (most screenshots) and fails its check, an empty one included, is `404`. A larger one that
//!   fails is cut off short of its announced length, which a client reads as an error.
//! - **A few at a time, per workspace.** A response holds three turns until its last byte is taken
//!   or it is dropped: one of its file's ([`READS_PER_FILE`], so one leaked address cannot take a
//!   workspace's pool), one of its workspace's pool for its use ([`READS_PER_WORKSPACE`]; a
//!   workspace's providers fetching its media and its devices downloading files never share a
//!   pool, so a bridge's downloads never hold up a publish), and one of the process-wide ceiling
//!   ([`MAX_CONCURRENT_READS`], a backstop). They are taken in that order, together within
//!   [`READ_TURN_WAIT`]; a request that gets them not in time is `503` with `Retry-After`. One
//!   workspace's readers never hold up another's, unless every workspace together reaches the
//!   ceiling. The workspace is the address's own, verified before any turn is taken.
//! - **Never held by a reader that stopped.** A response whose client takes nothing for
//!   [`READ_IDLE`], or that runs past [`READ_DEADLINE`], is cut off: its turns and its open file
//!   are let go then (a watchdog does it, since a client that stopped reading stops the body being
//!   asked for more), and the client sees the body end short of its length.
//!
//! An address is a provider's (signed without a purpose, as studio hands its media to Meta and
//! TikTok) or a device's (`purpose=device`, signed with it: a `push_file` download, an agent's
//! `file_url`). A request for anything else (an address that does not verify, another purpose, a
//! file that is not there) is `404`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration as StdDuration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::ports::{Clock, files::ByteSource, files::FileStore};
use jt_studio::FileId;
use jt_tenancy::WorkspaceId;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

/// How many files one workspace is served at once in each of its pools: its providers' fetches,
/// and its devices' downloads and file addresses.
pub const READS_PER_WORKSPACE: usize = 8;
/// How many reads of one file run at once.
pub const READS_PER_FILE: usize = 3;
/// How many files the route serves at once, process-wide: a backstop under the workspaces' pools.
/// Each read holds an open file and a chunk of it while its client takes it.
pub const MAX_CONCURRENT_READS: usize = 96;
/// How long a request waits for its turns before it is answered `503`.
pub const READ_TURN_WAIT: StdDuration = StdDuration::from_secs(10);
/// How long a response may go without its client taking a chunk (or the store yielding one)
/// before it is cut off.
pub const READ_IDLE: StdDuration = StdDuration::from_secs(30);
/// The longest one response may take, however steadily its client reads: the device bridge's own
/// bound on a transfer (`Timing::transfer_timeout`, 30 minutes). The largest file the store keeps
/// (studio's 200 MB video limit) is read within it at about 111 KB/s or faster.
pub const READ_DEADLINE: StdDuration = StdDuration::from_secs(30 * 60);
/// The purpose a device's address is signed with (`purpose=device`).
pub const DEVICE_PURPOSE: &str = "device";

/// The route's limits ([`router_with_limits`]); [`router`] uses the constants above.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadLimits {
    /// [`MAX_CONCURRENT_READS`].
    pub global: usize,
    /// [`READS_PER_WORKSPACE`].
    pub per_workspace: usize,
    /// [`READS_PER_FILE`].
    pub per_file: usize,
    /// [`READ_TURN_WAIT`].
    pub turn_wait: StdDuration,
    /// [`READ_IDLE`].
    pub idle: StdDuration,
    /// [`READ_DEADLINE`].
    pub deadline: StdDuration,
}

impl Default for ReadLimits {
    fn default() -> Self {
        ReadLimits {
            global: MAX_CONCURRENT_READS,
            per_workspace: READS_PER_WORKSPACE,
            per_file: READS_PER_FILE,
            turn_wait: READ_TURN_WAIT,
            idle: READ_IDLE,
            deadline: READ_DEADLINE,
        }
    }
}

/// Whose read an address is: which of its workspace's pools it takes a turn from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Use {
    /// A provider's fetch of studio media (an address signed without a purpose).
    Provider,
    /// A device's download, or an agent's `file_url` (`purpose=device`).
    Device,
}

/// The turns of every read: one semaphore per file, one per workspace and [`Use`], and the
/// ceiling. A file's or a pool's semaphore is made when it is first asked for, and dropped once no
/// read holds or waits for it.
struct Turns {
    limits: ReadLimits,
    global: Arc<Semaphore>,
    pools: StdMutex<HashMap<(WorkspaceId, Use), Arc<Semaphore>>>,
    files: StdMutex<HashMap<(WorkspaceId, FileId), Arc<Semaphore>>>,
}

/// The three turns a response holds (see the module docs).
struct Turn {
    _file: OwnedSemaphorePermit,
    _pool: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

/// The semaphore of `key` in `map`, with `permits` when it is made; semaphores nobody else holds
/// (no read holds a turn of them or waits for one) are dropped on the way.
fn semaphore<K: Eq + std::hash::Hash>(
    map: &StdMutex<HashMap<K, Arc<Semaphore>>>,
    key: K,
    permits: usize,
) -> Arc<Semaphore> {
    let mut map = map
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.retain(|_, s| Arc::strong_count(s) > 1);
    map.entry(key)
        .or_insert_with(|| Arc::new(Semaphore::new(permits)))
        .clone()
}

impl Turns {
    fn new(limits: ReadLimits) -> Self {
        Turns {
            limits,
            global: Arc::new(Semaphore::new(limits.global)),
            pools: StdMutex::default(),
            files: StdMutex::default(),
        }
    }

    /// The turns of a read of file `id` of workspace `ws` for `use_`, within
    /// [`ReadLimits::turn_wait`]; `None` when they do not come in time.
    async fn take(&self, ws: WorkspaceId, id: FileId, use_: Use) -> Option<Turn> {
        let file = semaphore(&self.files, (ws, id), self.limits.per_file);
        let pool = semaphore(&self.pools, (ws, use_), self.limits.per_workspace);
        let global = self.global.clone();
        let all = async move {
            let file = file.acquire_owned().await.ok()?;
            let pool = pool.acquire_owned().await.ok()?;
            let global = global.acquire_owned().await.ok()?;
            Some(Turn {
                _file: file,
                _pool: pool,
                _global: global,
            })
        };
        tokio::time::timeout(self.limits.turn_wait, all)
            .await
            .ok()
            .flatten()
    }
}

#[derive(Clone)]
struct Retrieval {
    store: Arc<dyn FileStore>,
    clock: Arc<dyn Clock>,
    key: [u8; 32],
    limits: ReadLimits,
    turns: Arc<Turns>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedQuery {
    workspace: WorkspaceId,
    expires: i64,
    signature: String,
    #[serde(default)]
    purpose: Option<String>,
}

/// The signed retrieval route (see the module docs), with the default [`ReadLimits`].
pub fn router(store: Arc<dyn FileStore>, clock: Arc<dyn Clock>, key: [u8; 32]) -> axum::Router {
    router_with_limits(store, clock, key, ReadLimits::default())
}

/// [`router`] with these limits.
pub fn router_with_limits(
    store: Arc<dyn FileStore>,
    clock: Arc<dyn Clock>,
    key: [u8; 32],
    limits: ReadLimits,
) -> axum::Router {
    let turns = Arc::new(Turns::new(limits));
    axum::Router::new()
        .route("/files/{id}", axum::routing::get(retrieve))
        .with_state(Retrieval {
            store,
            clock,
            key,
            limits,
            turns,
        })
}

async fn retrieve(
    State(s): State<Retrieval>,
    Path(id): Path<FileId>,
    Query(q): Query<SignedQuery>,
) -> Response {
    let now = s.clock.now();
    let purpose = q.purpose.as_deref();
    let use_ = match purpose {
        None => Use::Provider,
        Some(DEVICE_PURPOSE) => Use::Device,
        Some(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let verified = crate::verify_for(
        &s.key,
        q.workspace,
        id,
        q.expires,
        purpose,
        &q.signature,
        now,
    );
    if verified.is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(turn) = s.turns.take(q.workspace, id, use_).await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "5")],
        )
            .into_response();
    };
    let Ok(file) = s.store.read_stream(q.workspace, id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut bytes = file.bytes;
    // The first chunk before anything is answered: a file that fits in it is checked whole.
    let Ok(Ok(first)) = tokio::time::timeout(s.limits.idle, bytes.next_chunk()).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let held = Arc::new(Mutex::new(
        first.is_some().then(|| Held { bytes, _turn: turn }),
    ));
    let activity = Arc::new(Activity {
        started: Instant::now(),
        last: StdMutex::new(Instant::now()),
        cut: AtomicBool::new(false),
    });
    if first.is_some() {
        watch(held.clone(), activity.clone(), s.limits);
    }
    let body = Served {
        first,
        held,
        activity,
        limits: s.limits,
    };
    (
        [
            (header::CONTENT_TYPE, file.mime),
            (header::CONTENT_LENGTH, file.size_bytes.to_string()),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        Body::from_stream(body.into_stream()),
    )
        .into_response()
}

/// What a response being served holds while its client takes it: the rest of the file, and its
/// turns.
struct Held {
    bytes: Box<dyn ByteSource>,
    _turn: Turn,
}

/// When a response began, when its client last took a chunk, and whether it was cut off.
struct Activity {
    started: Instant,
    last: StdMutex<Instant>,
    cut: AtomicBool,
}

impl Activity {
    fn touch(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = Instant::now();
        }
    }

    fn last(&self) -> Instant {
        self.last.lock().map_or(self.started, |last| *last)
    }
}

/// A response's body: its first chunk, read already, then the rest as its client takes it.
struct Served {
    first: Option<Vec<u8>>,
    held: Arc<Mutex<Option<Held>>>,
    activity: Arc<Activity>,
    limits: ReadLimits,
}

impl Drop for Served {
    /// A response dropped part way (its client went away) lets go of its file and its turn at
    /// once; when the lock is busy, the watchdog does it at its next look.
    fn drop(&mut self) {
        if let Ok(mut held) = self.held.try_lock() {
            held.take();
        }
    }
}

/// The error a body ends with: short of its announced length, which a client reads as a failed
/// download.
fn cut_off() -> std::io::Error {
    std::io::Error::other("the stored file could not be served")
}

impl Served {
    /// The body's chunks, each as its client asks for it; an error ends it there.
    fn into_stream(
        self,
    ) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
        futures_util::stream::unfold(Some(self), |state| async move {
            let mut state = state?;
            if let Some(first) = state.first.take() {
                state.activity.touch();
                return Some((Ok(Bytes::from(first)), Some(state)));
            }
            let next = {
                let mut held = state.held.lock().await;
                let Some(open) = held.as_mut() else {
                    // Let go: at its end (nothing more), or cut off by the watchdog.
                    let cut = state.activity.cut.load(Ordering::SeqCst);
                    return cut.then(|| (Err(cut_off()), None));
                };
                if state.activity.started.elapsed() > state.limits.deadline {
                    held.take();
                    return Some((Err(cut_off()), None));
                }
                let read = tokio::time::timeout(state.limits.idle, open.bytes.next_chunk()).await;
                match read {
                    Ok(Ok(Some(chunk))) => Some(chunk),
                    Ok(Ok(None)) => {
                        held.take();
                        None
                    }
                    Ok(Err(_)) | Err(_) => {
                        held.take();
                        return Some((Err(cut_off()), None));
                    }
                }
            };
            let chunk = next?;
            state.activity.touch();
            Some((Ok(Bytes::from(chunk)), Some(state)))
        })
    }
}

/// Cuts a response off once its client has taken nothing for `limits.idle` or it has run past
/// `limits.deadline`: its file and its turn are let go, and its next read ends the body with an
/// error. Ends once the response let go of them itself (its end, or dropped).
fn watch(held: Arc<Mutex<Option<Held>>>, activity: Arc<Activity>, limits: ReadLimits) {
    tokio::spawn(async move {
        loop {
            let idle_due = activity.last() + limits.idle;
            let deadline = activity.started + limits.deadline;
            tokio::time::sleep_until(idle_due.min(deadline)).await;
            let mut open = held.lock().await;
            if open.is_none() {
                return;
            }
            let now = Instant::now();
            let gone = Arc::strong_count(&held) == 1;
            if gone || now >= activity.last() + limits.idle || now >= deadline {
                activity.cut.store(true, Ordering::SeqCst);
                open.take();
                return;
            }
        }
    });
}
