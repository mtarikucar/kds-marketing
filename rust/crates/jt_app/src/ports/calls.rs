//! Call sessions, their turn log, the commands queued for the voice bridge and the workspace's
//! call policy (spec §9), stored per tenant, and the signals that wake what long-polls them. The
//! call records themselves live in `jt_calls` and are re-exported here, as the Studio records are
//! from `ports::studio`.
pub use jt_calls::*;

use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::PersonId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use crate::error::AppError;

/// The most sessions or turns one read returns.
pub const MAX_CALL_PAGE: u32 = 200;

/// What a long-poll awaits ([`CallSignals::watch`]): done once its workspace was signalled after
/// the watch began.
pub type CallWatch = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Wakes the long-polls of a workspace's calls (`calls.listen`, the voice bridge's commands) when
/// something they wait for was committed: a turn appended, a command queued. A poll starts
/// watching *before* it reads, so a signal sent between its read and its wait still wakes it.
/// Signals are a hint, never the record: a poll reads the store again when woken, and also, at
/// least every second, when nothing woke it (a signal sent by another server instance reaches
/// none of this one's polls).
pub trait CallSignals: Send + Sync {
    /// A watch on workspace `ws`, done at the first [`CallSignals::notify`] of `ws` after this
    /// call.
    fn watch(&self, ws: WorkspaceId) -> CallWatch;
    /// Wakes every watch on workspace `ws` begun before this call.
    fn notify(&self, ws: WorkspaceId);
}

/// Which sessions [`CallRepo::list`] returns, newest first (`started_at`, then id).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallFilter {
    pub person_id: Option<PersonId>,
    pub state: Option<CallState>,
    pub direction: Option<CallDirection>,
    /// Only sessions started at or after this.
    pub since: Option<OffsetDateTime>,
    /// Keyset cursor: the `(started_at, id)` of the previous page's last session.
    pub before: Option<(OffsetDateTime, CallId)>,
    /// Clamped to `1..=MAX_CALL_PAGE`.
    pub limit: u32,
}

/// A command queued for the voice bridge, as a poll hands it out: the call it is for, the bridge's
/// own id of that call when it has one, and what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueuedCommand {
    pub id: CallCommandId,
    pub call_id: CallId,
    pub bridge_call_id: Option<String>,
    pub command: Command,
}

/// The workspace's calls. A session is stored whole (the domain's encoding) beside the columns
/// its reads filter on; a turn is appended once and changed only when the caller is reported to
/// have cut it ([`CallRepo::mark_interrupted`]; the person-erasure flow empties its text). The
/// voice bridge's commands are queued per call and leased to the bridge; the events it reported
/// are noted by their `(bridge_call_id, bridge_seq)` so each is applied once.
#[async_trait]
pub trait CallRepo: Send + Sync {
    /// Stores a new session. A `session.workspace_id` other than the bundle's is `INTERNAL`; a
    /// taken id, or a `crm_id` / `bridge_call_id` another session holds, is `CONFLICT`. Callers
    /// pass a capability, person and journey of the workspace (a foreign one breaks a foreign
    /// key and is `INTERNAL`).
    async fn insert(&mut self, session: CallSession, at: OffsetDateTime) -> Result<(), AppError>;
    async fn get(&mut self, id: CallId) -> Result<Option<CallSession>, AppError>;
    /// Session `id`, locked until the bundle ends.
    async fn lock(&mut self, id: CallId) -> Result<Option<CallSession>, AppError>;
    /// The session the PBX correlates by `crm_id`, locked until the bundle ends.
    async fn lock_by_crm_id(&mut self, crm_id: &str) -> Result<Option<CallSession>, AppError>;
    /// The session holding the PBX's call id `unique_id` (learned from its call events), locked
    /// until the bundle ends.
    async fn lock_by_pbx_id(&mut self, unique_id: &str) -> Result<Option<CallSession>, AppError>;
    /// The session the voice bridge knows as `bridge_call_id`, locked until the bundle ends.
    async fn lock_by_bridge_id(
        &mut self,
        bridge_call_id: &str,
    ) -> Result<Option<CallSession>, AppError>;
    /// Writes the session as it now stands. An unknown id is `NOT_FOUND`.
    async fn update(&mut self, session: CallSession, at: OffsetDateTime) -> Result<(), AppError>;
    async fn list(&mut self, filter: CallFilter) -> Result<Vec<CallSession>, AppError>;
    /// How many outbound sessions of `capability` started in `[from, to)`, refused ones and
    /// `except` excluded (a refusal never dialed).
    async fn count_started(
        &mut self,
        capability: CapabilityId,
        from: OffsetDateTime,
        to: OffsetDateTime,
        except: Option<CallId>,
    ) -> Result<u32, AppError>;
    /// Whether a session other than `except` that is not ended uses `rep_extension` (the rep's
    /// line is busy).
    async fn extension_busy(
        &mut self,
        rep_extension: &str,
        except: Option<CallId>,
    ) -> Result<bool, AppError>;
    /// Whether the person called in (an inbound session) at or after `since`.
    async fn inbound_since(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// The sessions on the line (dialing to ending, [`CallState::is_live`]), oldest first (by
    /// `started_at`, then id), at most [`MAX_CALL_PAGE`].
    async fn live(&mut self) -> Result<Vec<CallSession>, AppError>;
    /// Appends turns of call `call`. A taken `(call, seq)` is `CONFLICT`; an unknown call
    /// `NOT_FOUND`.
    async fn append_turns(&mut self, call: CallId, turns: Vec<Turn>) -> Result<(), AppError>;
    /// Records that the caller cut the sentence of turn `seq` of call `call` at character
    /// `at_char` (its `meta.interrupted_at_char`); `false` when the call has no such turn.
    async fn mark_interrupted(
        &mut self,
        call: CallId,
        seq: u32,
        at_char: u32,
    ) -> Result<bool, AppError>;
    /// The call's turns in order, those after `after_seq` when given, at most `limit`.
    async fn turns(
        &mut self,
        call: CallId,
        after_seq: Option<u32>,
        limit: u32,
    ) -> Result<Vec<Turn>, AppError>;
    /// Queues `commands` for the voice bridge of call `call`, in their order, created at `at`. An
    /// unknown call is `NOT_FOUND`; a taken command id `CONFLICT`.
    async fn enqueue_commands(
        &mut self,
        call: CallId,
        commands: Vec<(CallCommandId, Command)>,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Leases to the voice bridge `capability` at most `limit` (clamped to `1..=MAX_CALL_PAGE`)
    /// of the commands of its calls that are not acknowledged and were never taken, or were last
    /// taken before `stale_before`: oldest first (by creation, then id), each marked taken at
    /// `now`. A command another bundle is leasing at that moment is passed over.
    async fn take_commands(
        &mut self,
        capability: CapabilityId,
        now: OffsetDateTime,
        stale_before: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<QueuedCommand>, AppError>;
    /// Marks command `id`, of one of the voice bridge `capability`'s calls, acknowledged at `at`;
    /// `false` when there is no such command or it was acknowledged already.
    async fn ack_command(
        &mut self,
        capability: CapabilityId,
        id: CallCommandId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Deletes the commands queued before `before`, acknowledged or not; how many.
    async fn purge_commands(&mut self, before: OffsetDateTime) -> Result<u64, AppError>;
    /// Notes that the voice bridge `capability` reported event `bridge_seq` (of `kind`) of its call
    /// `bridge_call_id`, received at `at`; `false` when that event was noted before, so it was
    /// applied already.
    async fn note_bridge_event(
        &mut self,
        capability: CapabilityId,
        bridge_call_id: &str,
        bridge_seq: u32,
        kind: &str,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// The workspace's call policy; the defaults while none is stored. Serializes policy
    /// read/modify/write transactions like `WorkspacePolicyRepo::get`.
    async fn policy(&mut self) -> Result<CallPolicy, AppError>;
    /// Stores the call policy, leaving the workspace's other policies as they are.
    async fn set_policy(&mut self, policy: CallPolicy, at: OffsetDateTime) -> Result<(), AppError>;
}
