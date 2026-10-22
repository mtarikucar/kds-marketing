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
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, MembershipStatus, OperatorId, Permission,
    RoleDef, RoleId, SessionId, UserId, WorkspaceId, WorkspaceStatus,
};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

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

// ---------------------------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------------------------

/// A user account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UserRow {
    pub id: UserId,
    pub email: Email,
    pub password_hash: String,
    pub display_name: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A panel login session. Only the hash of its token is stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SessionRow {
    pub id: SessionId,
    pub user_id: UserId,
    pub token_hash: String,
    pub current_workspace_id: Option<WorkspaceId>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub revoked_at: Option<OffsetDateTime>,
}

/// A membership as stored: an invitation (`user_id` unset until accepted) or an active member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MembershipRow {
    pub id: MembershipId,
    pub workspace_id: WorkspaceId,
    pub user_id: Option<UserId>,
    pub role_id: RoleId,
    pub status: MembershipStatus,
    pub invited_email: Option<Email>,
    pub invite_token_hash: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub invite_expires_at: Option<OffsetDateTime>,
    pub invited_by: Option<UserId>,
    #[serde(with = "time::serde::rfc3339")]
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

/// An API key as stored. Only the hash of the key is kept; `prefix` is for display.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApiKeyRow {
    pub id: ApiKeyId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    pub prefix: String,
    pub key_hash: String,
    pub scopes: BTreeSet<Permission>,
    pub issued_by: UserId,
    pub status: ApiKeyStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_used_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
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

/// A platform operator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OperatorRow {
    pub id: OperatorId,
    pub email: Email,
    pub password_hash: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// A platform operator's login session. Only the hash of its token is stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlatformSessionRow {
    pub id: Uuid,
    pub operator_id: OperatorId,
    pub token_hash: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
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
    /// stays.
    async fn delete_custom(&mut self, id: RoleId) -> Result<(), AppError>;
    /// How many memberships, in any status, reference the role.
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
    /// Binds an invitation to `user_id` and makes it `Active`. Only `Invited` → `Active` is
    /// allowed: an unknown id is `NOT_FOUND`, a membership in any other status is `CONFLICT`.
    async fn activate(&mut self, id: MembershipId, user_id: UserId) -> Result<(), AppError>;
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
    /// Writes into the workspace named by the entry; used by registration in the same
    /// transaction. Returns the entry's sequence id.
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
