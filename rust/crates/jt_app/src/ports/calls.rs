//! Call sessions, their turn log and the workspace's call policy (spec §9), stored per tenant.
//! The call records themselves live in `jt_calls` and are re-exported here, as the Studio
//! records are from `ports::studio`.
pub use jt_calls::*;

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_inbox::PersonId;
use time::OffsetDateTime;

use crate::error::AppError;

/// The most sessions or turns one read returns.
pub const MAX_CALL_PAGE: u32 = 200;

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

/// The workspace's calls. A session is stored whole (the domain's encoding) beside the columns
/// its reads filter on; a turn is appended once and never changed (the person-erasure flow
/// empties its text).
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
    /// Appends turns of call `call`. A taken `(call, seq)` is `CONFLICT`; an unknown call
    /// `NOT_FOUND`.
    async fn append_turns(&mut self, call: CallId, turns: Vec<Turn>) -> Result<(), AppError>;
    /// The call's turns in order, those after `after_seq` when given, at most `limit`.
    async fn turns(
        &mut self,
        call: CallId,
        after_seq: Option<u32>,
        limit: u32,
    ) -> Result<Vec<Turn>, AppError>;
    /// The workspace's call policy; the defaults while none is stored. Serializes policy
    /// read/modify/write transactions like `WorkspacePolicyRepo::get`.
    async fn policy(&mut self) -> Result<CallPolicy, AppError>;
    /// Stores the call policy, leaving the workspace's other policies as they are.
    async fn set_policy(&mut self, policy: CallPolicy, at: OffsetDateTime) -> Result<(), AppError>;
}
