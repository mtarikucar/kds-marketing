//! Ports: the traits adapters implement and use cases call, plus the plain rows they exchange.
//!
//! Persistence is reached through a `UnitOfWork`, which opens one of three repo bundles, each a
//! single transaction: `TenantRepos` (one workspace's rows only), `UserRepos` (user-level data and
//! registration) and `PlatformRepos` (platform-wide reads and lookups that cannot know the
//! workspace in advance). A bundle commits with `commit`; dropping it uncommitted rolls back.
//! After any call on a bundle, or on a repo it hands out, returns an error, the bundle must be
//! dropped: its `commit` fails with `INTERNAL` (always in the in-memory fakes; in Postgres
//! whenever the failed statement aborted the transaction). A use case that wants to go on after
//! an expected refusal checks first (e.g. `find_by_email` before `insert`) or opens a new bundle.
//!
//! Contracts every adapter keeps:
//! - Every timestamp the application can see is passed in, taken from the `Clock` port; a
//!   database default such as `now()` is only a fallback and never the source of such a value.
//! - A row or entry whose `workspace_id` differs from the tenant bundle's workspace is refused
//!   with `INTERNAL` (it is a programming error) and nothing is written.
//! - Mutations documented as such return `NOT_FOUND` when the id does not exist in scope.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_ledger::LedgerEntry;
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, Hypothesis, HypothesisId, HypothesisState, Sections,
    StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, MembershipStatus, OperatorId, Permission,
    RoleDef, RoleId, SessionId, UserId, WorkspaceId, WorkspaceStatus,
};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::AppError;

// ---------------------------------------------------------------------------------------------
// Service ports
// ---------------------------------------------------------------------------------------------

/// The current time.
pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;
}

/// Fresh unique identifiers.
pub trait IdGen: Send + Sync {
    fn uuid(&self) -> Uuid;
}

/// Random secrets such as session tokens, invite tokens and API keys.
pub trait TokenGen: Send + Sync {
    /// `bytes` random bytes, encoded base64url without padding.
    fn token(&self, bytes: usize) -> String;
}

/// One-way password hashing. The work may be CPU-bound (Argon2id takes tens of milliseconds), so
/// implementations keep it off the async reactor threads themselves (`std_impls::Argon2Hasher`
/// runs it on a blocking thread); callers simply await.
#[async_trait]
pub trait PasswordHasher: Send + Sync {
    /// A self-describing hash of `pw` that `verify` accepts.
    async fn hash(&self, pw: &str) -> Result<String, AppError>;
    /// Whether `pw` matches `hash`; `Ok(false)` on a mismatch, `Err` only for an unusable hash.
    async fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError>;
}

/// Seals secrets (a connector's token or password) for one workspace, so that only that
/// workspace can open them again. The sealed bytes are opaque and safe to store; no use case
/// returns them, nor what `open` gives back.
///
/// Sealing is randomised: two seals of the same plaintext differ, and the plaintext never appears
/// in the output. The work is a few microseconds of CPU, so both methods are synchronous.
pub trait SecretBox: Send + Sync {
    /// `plaintext` sealed for `ws`.
    fn seal(&self, ws: WorkspaceId, plaintext: &[u8]) -> Result<Vec<u8>, AppError>;
    /// The plaintext that `seal` sealed for `ws`, wiped from memory when dropped.
    ///
    /// Bytes sealed for another workspace or under another key, cut short, or changed in any way
    /// are refused with `INTERNAL` and the message `"sealed data cannot be opened"`, whatever the
    /// reason, so a refusal tells a caller nothing about the bytes.
    fn open(&self, ws: WorkspaceId, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, AppError>;
}

// ---------------------------------------------------------------------------------------------
// Rows and views
//
// A row that carries a secret's hash (a password, a session, invite or API-key token) does not
// implement `Serialize`, so it cannot reach a response or a ledger payload by accident; the use
// cases answer with views and summaries that leave the hash out.
// ---------------------------------------------------------------------------------------------

/// A user account. Not `Serialize`: it carries the password hash (see the section note).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserRow {
    pub id: UserId,
    pub email: Email,
    pub password_hash: String,
    pub display_name: String,
    pub created_at: OffsetDateTime,
}

/// A panel login session. Only the hash of its token is stored. Not `Serialize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRow {
    pub id: SessionId,
    pub user_id: UserId,
    pub token_hash: String,
    pub current_workspace_id: Option<WorkspaceId>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub revoked_at: Option<OffsetDateTime>,
}

/// A membership as stored: an invitation (`user_id` unset until accepted) or an active member.
/// Not `Serialize`: it carries the invite token's hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MembershipRow {
    pub id: MembershipId,
    pub workspace_id: WorkspaceId,
    pub user_id: Option<UserId>,
    pub role_id: RoleId,
    pub status: MembershipStatus,
    pub invited_email: Option<Email>,
    pub invite_token_hash: Option<String>,
    pub invite_expires_at: Option<OffsetDateTime>,
    pub invited_by: Option<UserId>,
    pub created_at: OffsetDateTime,
}

/// One of a user's memberships, joined with its workspace and role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MembershipView {
    pub membership_id: MembershipId,
    pub workspace_id: WorkspaceId,
    pub workspace_name: String,
    pub workspace_slug: String,
    pub workspace_status: WorkspaceStatus,
    pub role_key: String,
    pub permissions: BTreeSet<Permission>,
}

/// A workspace member (or pending invitee) as the team list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MemberOut {
    pub membership_id: MembershipId,
    pub user_id: Option<UserId>,
    /// The user's email, or the invited email while the invitation is pending.
    pub email: Email,
    pub display_name: Option<String>,
    pub role_key: String,
    pub role_name: String,
    pub status: MembershipStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Lifecycle of an API key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyStatus {
    Active,
    Revoked,
}

impl ApiKeyStatus {
    /// The stable key, e.g. `"active"`.
    pub fn key(&self) -> &'static str {
        match self {
            ApiKeyStatus::Active => "active",
            ApiKeyStatus::Revoked => "revoked",
        }
    }

    /// The status with this key, if any.
    pub fn parse(key: &str) -> Option<ApiKeyStatus> {
        match key {
            "active" => Some(ApiKeyStatus::Active),
            "revoked" => Some(ApiKeyStatus::Revoked),
            _ => None,
        }
    }
}

/// An API key as stored. Only the hash of the key is kept; `prefix` is for display. Not
/// `Serialize`: callers show a `KeySummary`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiKeyRow {
    pub id: ApiKeyId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    pub prefix: String,
    pub key_hash: String,
    pub scopes: BTreeSet<Permission>,
    pub issued_by: UserId,
    pub status: ApiKeyStatus,
    pub created_at: OffsetDateTime,
    pub last_used_at: Option<OffsetDateTime>,
    pub revoked_at: Option<OffsetDateTime>,
}

/// An agent client seen through an API key, one per (key, client name, client version).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentConnectionRow {
    pub id: AgentConnectionId,
    pub workspace_id: WorkspaceId,
    pub api_key_id: ApiKeyId,
    pub client_name: String,
    pub client_version: String,
    pub protocol_version: String,
    #[serde(with = "time::serde::rfc3339")]
    pub first_seen_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_seen_at: OffsetDateTime,
    pub tool_calls: i64,
}

/// A workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceRow {
    pub id: WorkspaceId,
    pub name: String,
    pub slug: String,
    pub status: WorkspaceStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A platform operator. Not `Serialize`: it carries the password hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatorRow {
    pub id: OperatorId,
    pub email: Email,
    pub password_hash: String,
    pub created_at: OffsetDateTime,
}

/// A platform operator's login session. Only the hash of its token is stored. Not `Serialize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformSessionRow {
    pub id: Uuid,
    pub operator_id: OperatorId,
    pub token_hash: String,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

/// Which ledger entries to list: newest first, at most `limit`, optionally older than `before_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LedgerFilter {
    /// Keep only actions starting with this text, e.g. `"team."`.
    pub action_prefix: Option<String>,
    /// Keep only this actor kind: `"human"`, `"agent"` or `"system"`.
    pub actor_kind: Option<String>,
    pub limit: u32,
    /// Keep only entries with an id below this one (the previous page's last id).
    pub before_id: Option<i64>,
}

/// A stored ledger entry with its sequence id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LedgerRow {
    pub id: i64,
    pub entry: LedgerEntry,
}

// ---------------------------------------------------------------------------------------------
// User-level repositories
// ---------------------------------------------------------------------------------------------

/// User accounts.
#[async_trait]
pub trait UserRepo: Send + Sync {
    /// The user with this (normalised) email.
    async fn find_by_email(&mut self, email: &Email) -> Result<Option<UserRow>, AppError>;
    async fn find_by_id(&mut self, id: UserId) -> Result<Option<UserRow>, AppError>;
    /// A taken email is `CONFLICT`.
    async fn insert(&mut self, row: UserRow) -> Result<(), AppError>;
}

/// Panel login sessions.
#[async_trait]
pub trait SessionRepo: Send + Sync {
    async fn insert(&mut self, row: SessionRow) -> Result<(), AppError>;
    /// The session with this token hash, expired and revoked ones included; the caller checks.
    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<SessionRow>, AppError>;
    /// Sets `revoked_at` to `at`; a no-op when the session is already revoked.
    async fn revoke(&mut self, id: SessionId, at: OffsetDateTime) -> Result<(), AppError>;
    /// Revokes, with `revoked_at = now`, every session of `user_id` whose current workspace is
    /// `workspace_id` and which is live at `now` (not revoked and `expires_at > now`).
    async fn revoke_all_for_workspace(
        &mut self,
        user_id: UserId,
        workspace_id: WorkspaceId,
        now: OffsetDateTime,
    ) -> Result<(), AppError>;
    async fn set_current_workspace(
        &mut self,
        id: SessionId,
        ws: Option<WorkspaceId>,
    ) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------------------------
// Tenant repositories: every method sees and writes only the bundle's own workspace.
// ---------------------------------------------------------------------------------------------

/// The workspace's roles, system and custom.
#[async_trait]
pub trait RoleRepo: Send + Sync {
    async fn list(&mut self) -> Result<Vec<RoleDef>, AppError>;
    async fn find_by_key(&mut self, key: &str) -> Result<Option<RoleDef>, AppError>;
    async fn find(&mut self, id: RoleId) -> Result<Option<RoleDef>, AppError>;
    /// Stores a custom role. A taken key is `CONFLICT`. A role with `is_system` set is
    /// `INTERNAL`: system roles are created only with their workspace, by
    /// `UserRepos::roles_create_system`.
    async fn insert(&mut self, role: RoleDef) -> Result<(), AppError>;
    /// Replaces the role's permissions. An unknown id is `NOT_FOUND`.
    async fn update_permissions(
        &mut self,
        id: RoleId,
        permissions: BTreeSet<Permission>,
    ) -> Result<(), AppError>;
    /// Deletes a custom role. An unknown id is `NOT_FOUND`; a system role is `FORBIDDEN` and
    /// stays; a role a membership that is not `Removed` holds is `CONFLICT` and stays. `Removed`
    /// memberships that still reference the role are moved to the workspace's system `rep` role
    /// first, in the same transaction.
    async fn delete_custom(&mut self, id: RoleId) -> Result<(), AppError>;
    /// How many memberships that are not `Removed` (members and open invitations) hold the role.
    async fn count_memberships_using(&mut self, id: RoleId) -> Result<i64, AppError>;
}

/// The workspace's memberships and invitations.
#[async_trait]
pub trait MembershipRepo: Send + Sync {
    /// Every membership that is not `Removed`, with member and role details, oldest first.
    async fn list(&mut self) -> Result<Vec<MemberOut>, AppError>;
    async fn find(&mut self, id: MembershipId) -> Result<Option<MembershipRow>, AppError>;
    /// The user's membership here that is not `Removed`.
    async fn find_by_user(&mut self, user_id: UserId) -> Result<Option<MembershipRow>, AppError>;
    /// Stores an `Invited` membership with its invite fields set. A `row.workspace_id` other than
    /// the bundle's is `INTERNAL`; a role that is not this workspace's (or does not exist) is
    /// `NOT_FOUND`.
    async fn insert_invite(&mut self, row: MembershipRow) -> Result<(), AppError>;
    /// Binds an open invitation to `user_id` and makes it `Active`, clearing `invite_token_hash`
    /// and `invite_expires_at` so the token can never be found or used again (`invited_email` and
    /// `invited_by` stay as the record of the invitation).
    ///
    /// The row is locked first, so two concurrent activations of one invitation cannot both
    /// succeed. An unknown id is `NOT_FOUND`; a membership that is not `Invited`, or whose
    /// invitation has expired at `at` (`invite_expires_at` not after `at`), is `CONFLICT`, as is
    /// a user who already holds a membership here that is not `Removed`.
    async fn activate(
        &mut self,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Moves the membership to `role_id`. An unknown id, or a role that is not this workspace's,
    /// is `NOT_FOUND`. Callers that may demote an owner call `count_active_owners` first, in the
    /// same transaction.
    async fn set_role(&mut self, id: MembershipId, role_id: RoleId) -> Result<(), AppError>;
    /// Sets the status to `Removed`. An unknown id is `NOT_FOUND`. Callers that may remove an
    /// owner call `count_active_owners` first, in the same transaction.
    async fn remove(&mut self, id: MembershipId) -> Result<(), AppError>;
    /// Active memberships holding the `owner` system role.
    ///
    /// Implementations lock those memberships until the transaction ends (select their rows
    /// `FOR UPDATE`, then count; Postgres refuses `FOR UPDATE` on an aggregate), so that
    /// `can_change_role(.., target_is_last_owner)` followed by `set_role` or `remove` in the same
    /// transaction cannot race another transaction demoting or removing an owner.
    async fn count_active_owners(&mut self) -> Result<i64, AppError>;
}

/// The workspace's API keys. Lookup by key hash lives on `PlatformRepos`.
#[async_trait]
pub trait ApiKeyRepo: Send + Sync {
    /// A `row.workspace_id` other than the bundle's is `INTERNAL`.
    async fn insert(&mut self, row: ApiKeyRow) -> Result<(), AppError>;
    async fn list(&mut self) -> Result<Vec<ApiKeyRow>, AppError>;
    /// Sets the status to `Revoked` and `revoked_at` to `at`. An unknown id is `NOT_FOUND`.
    async fn revoke(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError>;
    /// Revokes, with `revoked_at = at`, every `Active` key `user_id` issued in this workspace,
    /// and returns their ids in id order (none: an empty list). Keys already revoked keep their
    /// time.
    async fn revoke_all_for_user(
        &mut self,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<Vec<ApiKeyId>, AppError>;
    async fn touch_last_used(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError>;
}

/// The workspace's agent connections.
#[async_trait]
pub trait AgentConnectionRepo: Send + Sync {
    /// Inserts `row`, or, when the same (key, client name, client version) is already known,
    /// sets its `last_seen_at` and `protocol_version` from `row`. Returns the stored id and
    /// whether the connection was created. A `row.workspace_id` other than the bundle's is
    /// `INTERNAL`.
    async fn upsert_on_initialize(
        &mut self,
        row: AgentConnectionRow,
    ) -> Result<(AgentConnectionId, bool), AppError>;
    /// Counts one tool call and sets `last_seen_at` to `at`.
    async fn touch_tool_call(
        &mut self,
        id: AgentConnectionId,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    async fn list(&mut self) -> Result<Vec<AgentConnectionRow>, AppError>;
    async fn find(&mut self, id: AgentConnectionId)
    -> Result<Option<AgentConnectionRow>, AppError>;
}

/// The workspace's append-only ledger.
#[async_trait]
pub trait LedgerRepo: Send + Sync {
    /// Appends the entry and returns its sequence id. An `entry.workspace_id` other than the
    /// bundle's is `INTERNAL`.
    async fn append(&mut self, entry: LedgerEntry) -> Result<i64, AppError>;
    async fn list(&mut self, filter: LedgerFilter) -> Result<Vec<LedgerRow>, AppError>;
}

/// The workspace's own row.
#[async_trait]
pub trait WorkspaceRepo: Send + Sync {
    async fn get(&mut self) -> Result<WorkspaceRow, AppError>;
}

// ---------------------------------------------------------------------------------------------
// Strategy repositories: tenant repositories too, over one workspace's strategy.
// ---------------------------------------------------------------------------------------------

/// The most entries one `ConsultationRepo::list` returns.
pub const MAX_CONSULTATION_PAGE: u32 = 500;

/// The workspace's strategy versions.
///
/// A workspace has at most one `Draft` and at most one `Approved` version at a time. Postgres
/// enforces both with partial unique indexes, so of two transactions racing to break either rule
/// the second one fails with `CONFLICT`; the fakes refuse the same writes.
///
/// **Every mutation of the draft** (its sections, its submission, its hypotheses, approving or
/// archiving it) **reads the draft through [`StrategyRepo::lock_draft`] first, in the same
/// bundle**, and decides on what that returns. The lock is held until the bundle commits or is
/// dropped, so a concurrent mutation waits and then sees the committed result: approval cannot
/// approve sections it did not validate, and two edits cannot lose each other's change.
#[async_trait]
pub trait StrategyRepo: Send + Sync {
    /// Stores a version. A `version.workspace_id` other than the bundle's is `INTERNAL`; a taken
    /// id or number, or a second `Draft` or `Approved` version in the workspace, is `CONFLICT`;
    /// an `approved_by` that names no user is `NOT_FOUND`.
    async fn insert(&mut self, version: StrategyVersion) -> Result<(), AppError>;
    async fn find(&mut self, id: StrategyVersionId) -> Result<Option<StrategyVersion>, AppError>;
    /// The `Approved` version, if any.
    async fn current_approved(&mut self) -> Result<Option<StrategyVersion>, AppError>;
    /// The `Draft` version, if any, read without a lock: for answering, not for deciding a write.
    async fn current_draft(&mut self) -> Result<Option<StrategyVersion>, AppError>;
    /// The `Draft` version, if any, locked against every other `lock_draft` (and every write to
    /// the row) until this bundle commits or is dropped.
    ///
    /// A call that has to wait for another bundle holding the lock returns what that bundle
    /// committed: the edited draft, or `None` when it approved or archived it. In Postgres it is
    /// `select .. for update`; the in-memory fakes run one bundle at a time in tests, so there
    /// it is `current_draft`.
    async fn lock_draft(&mut self) -> Result<Option<StrategyVersion>, AppError>;
    /// Every version, newest (highest number) first.
    async fn list(&mut self) -> Result<Vec<StrategyVersion>, AppError>;
    /// Replaces the sections of draft `id`. An unknown id is `NOT_FOUND`; a version that is not a
    /// `Draft` is `CONFLICT` (approved and archived versions keep the sections they had). The
    /// caller holds the draft lock ([`StrategyRepo::lock_draft`]).
    ///
    /// `at` is the time of the edit. The version keeps no edit time of its own (the consultation
    /// log and the ledger record edits), so it is not stored.
    async fn update_sections(
        &mut self,
        id: StrategyVersionId,
        sections: Sections,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Sets `submitted_at` of draft `id`: `Some(at)` records that it was submitted for approval
    /// at `at`, `None` withdraws the submission. An unknown id is `NOT_FOUND`; a version that is
    /// not a `Draft` is `CONFLICT`. The caller holds the draft lock
    /// ([`StrategyRepo::lock_draft`]).
    async fn set_submitted(
        &mut self,
        id: StrategyVersionId,
        at: Option<OffsetDateTime>,
    ) -> Result<(), AppError>;
    /// Moves version `id` forward to `status` at `at` and returns how many rows changed. A
    /// caller moving the draft holds the draft lock ([`StrategyRepo::lock_draft`]).
    ///
    /// - `Approved` moves a `Draft` only, setting `approved_at = at` and `approved_by = by`. While
    ///   another version is approved it is `CONFLICT` (the partial unique index; in Postgres the
    ///   transaction is then aborted); a `by` that names no user is `NOT_FOUND`.
    /// - `Archived` moves a `Draft` or an `Approved` version, setting `archived_at = at`; the
    ///   approval fields stay, and `by` is not stored (the ledger records who archived it).
    /// - `Draft` is `INTERNAL`: a version never returns to draft.
    ///
    /// 0 rows means the id is unknown here, or the version is not in a status the move starts
    /// from. A caller that has not read the version maps 0 to `NOT_FOUND`; one that read it in the
    /// same transaction maps 0 to `CONFLICT`, since another transaction moved it first (in
    /// Postgres the update waits for that transaction and then finds the row moved).
    async fn set_status(
        &mut self,
        id: StrategyVersionId,
        status: VersionStatus,
        at: OffsetDateTime,
        by: Option<UserId>,
    ) -> Result<u64, AppError>;
    /// One more than the workspace's highest version number, 1 when it has none. Two transactions
    /// may both get the same number; the second to insert it gets `CONFLICT`.
    async fn next_number(&mut self) -> Result<i32, AppError>;
}

/// The hypotheses of the workspace's strategy versions, each version's in its own order.
///
/// A hypothesis id is stable across versions, so the same id appears once per version. Writes
/// name a version of the bundle's workspace, else `NOT_FOUND`. A confidence outside `0.0..=1.0`
/// (or NaN) breaks a check constraint and is `INTERNAL`: callers validate first. A write to the
/// draft's hypotheses is a draft mutation: the caller holds the draft lock
/// ([`StrategyRepo::lock_draft`]).
#[async_trait]
pub trait HypothesisRepo: Send + Sync {
    /// Makes `hypotheses`, in this order, the version's whole list. An id listed twice is
    /// `CONFLICT`. The caller holds the draft lock ([`StrategyRepo::lock_draft`]).
    async fn replace_all(
        &mut self,
        version_id: StrategyVersionId,
        hypotheses: Vec<Hypothesis>,
    ) -> Result<(), AppError>;
    /// The version's hypotheses in order; an unknown version has none.
    async fn list(&mut self, version_id: StrategyVersionId) -> Result<Vec<Hypothesis>, AppError>;
    /// Replaces the version's hypothesis with this id in place, or appends it when the version
    /// has none with that id.
    async fn upsert(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis: Hypothesis,
    ) -> Result<(), AppError>;
    /// Sets the state of one hypothesis of the version. An unknown version or hypothesis is
    /// `NOT_FOUND`.
    async fn set_state(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis_id: HypothesisId,
        state: HypothesisState,
    ) -> Result<(), AppError>;
}

/// The append-only consultation log of the workspace's strategy versions. Entries are never
/// changed or deleted (Postgres refuses it with a trigger).
#[async_trait]
pub trait ConsultationRepo: Send + Sync {
    /// Appends `entry` to the log of its version, in the bundle's workspace, and returns its id.
    /// A version that is not this workspace's is `NOT_FOUND`; a taken id is `CONFLICT`.
    async fn append(&mut self, entry: ConsultationEntry) -> Result<ConsultationEntryId, AppError>;
    /// The version's entries newest first, ordered by `(at, id)` descending, at most `limit`
    /// (clamped to `1..=MAX_CONSULTATION_PAGE`).
    ///
    /// `before` is a keyset cursor: the `(at, id)` of the previous page's last entry. Only
    /// entries ordered after it are returned (`(at, id) < before`), so paging neither skips nor
    /// repeats entries that share an instant.
    async fn list(
        &mut self,
        version_id: StrategyVersionId,
        limit: u32,
        before: Option<(OffsetDateTime, ConsultationEntryId)>,
    ) -> Result<Vec<ConsultationEntry>, AppError>;
}

// ---------------------------------------------------------------------------------------------
// Platform repositories
// ---------------------------------------------------------------------------------------------

/// Platform operators.
#[async_trait]
pub trait OperatorRepo: Send + Sync {
    async fn count(&mut self) -> Result<i64, AppError>;
    async fn insert(&mut self, row: OperatorRow) -> Result<(), AppError>;
    async fn find_by_email(&mut self, email: &Email) -> Result<Option<OperatorRow>, AppError>;
}

/// Platform operator sessions.
#[async_trait]
pub trait PlatformSessionRepo: Send + Sync {
    async fn insert(&mut self, row: PlatformSessionRow) -> Result<(), AppError>;
    /// The session with this token hash, expired ones included; the caller checks.
    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<PlatformSessionRow>, AppError>;
}

// ---------------------------------------------------------------------------------------------
// Bundles and the unit of work
// ---------------------------------------------------------------------------------------------

/// One transaction scoped to a single workspace: every repo it hands out reads and writes only
/// that workspace's rows.
///
/// After an error from any call the bundle must be dropped, not committed: `commit` fails (see
/// the module docs).
#[async_trait]
pub trait TenantRepos: Send + Sync {
    fn roles(&mut self) -> &mut dyn RoleRepo;
    fn memberships(&mut self) -> &mut dyn MembershipRepo;
    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo;
    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo;
    fn ledger(&mut self) -> &mut dyn LedgerRepo;
    fn workspace(&mut self) -> &mut dyn WorkspaceRepo;
    fn strategy(&mut self) -> &mut dyn StrategyRepo;
    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo;
    fn consultation(&mut self) -> &mut dyn ConsultationRepo;
    async fn commit(self: Box<Self>) -> Result<(), AppError>;
}

/// One transaction over user-level data, including registering a new workspace.
///
/// After an error from any call the bundle must be dropped, not committed: `commit` fails (see
/// the module docs).
#[async_trait]
pub trait UserRepos: Send + Sync {
    fn users(&mut self) -> &mut dyn UserRepo;
    fn sessions(&mut self) -> &mut dyn SessionRepo;
    /// The user's active memberships across workspaces, oldest first.
    async fn memberships_of_user(
        &mut self,
        user_id: UserId,
    ) -> Result<Vec<MembershipView>, AppError>;
    /// A taken slug is `CONFLICT`.
    async fn workspaces_create(
        &mut self,
        id: WorkspaceId,
        name: &str,
        slug: &str,
        status: WorkspaceStatus,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Stores the system roles of a newly created workspace.
    async fn roles_create_system(
        &mut self,
        ws: WorkspaceId,
        roles: &[RoleDef],
    ) -> Result<(), AppError>;
    /// Stores an `Active` membership, e.g. the owner of a newly created workspace. A role that is
    /// not `workspace_id`'s (or does not exist) is `NOT_FOUND`; a user who is already a member is
    /// `CONFLICT`.
    async fn memberships_insert_active(
        &mut self,
        id: MembershipId,
        workspace_id: WorkspaceId,
        user_id: UserId,
        role_id: RoleId,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// `MembershipRepo::activate` for membership `id` of `workspace_id`, with the same contract
    /// (an `id` that is not `workspace_id`'s is `NOT_FOUND`). Accepting an invitation uses it to
    /// create the user, activate the membership and open a session in one transaction.
    async fn memberships_activate(
        &mut self,
        workspace_id: WorkspaceId,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// Writes into the workspace named by the entry; used by registration and by accepting an
    /// invitation, in the same transaction. Returns the entry's sequence id.
    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError>;
    async fn commit(self: Box<Self>) -> Result<(), AppError>;
}

/// One platform-wide transaction: operators, all workspaces, and lookups by secret hash.
///
/// After an error from any call the bundle must be dropped, not committed: `commit` fails (see
/// the module docs).
#[async_trait]
pub trait PlatformRepos: Send + Sync {
    fn operators(&mut self) -> &mut dyn OperatorRepo;
    fn platform_sessions(&mut self) -> &mut dyn PlatformSessionRepo;
    async fn workspaces_list(&mut self) -> Result<Vec<WorkspaceRow>, AppError>;
    async fn workspace_get(&mut self, ws: WorkspaceId) -> Result<Option<WorkspaceRow>, AppError>;
    /// An unknown workspace is `NOT_FOUND`.
    async fn workspace_set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
    ) -> Result<(), AppError>;
    /// The email of the workspace's oldest active owner.
    async fn workspace_owner_email(&mut self, ws: WorkspaceId) -> Result<Option<Email>, AppError>;
    /// Active memberships in the workspace.
    async fn workspace_member_count(&mut self, ws: WorkspaceId) -> Result<i64, AppError>;
    /// The API key with this hash, in whichever workspace it belongs to.
    async fn api_key_find_by_hash(&mut self, key_hash: &str)
    -> Result<Option<ApiKeyRow>, AppError>;
    /// The membership whose invite token has this hash, in whichever workspace it belongs to.
    async fn membership_find_by_invite_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<MembershipRow>, AppError>;
    /// Appends a ledger entry to `entry.workspace_id` on behalf of the platform.
    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError>;
    async fn commit(self: Box<Self>) -> Result<(), AppError>;
}

/// Opens repo bundles. Each returned bundle is one transaction.
#[async_trait]
pub trait UnitOfWork: Send + Sync {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError>;
    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError>;
    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError>;
}
