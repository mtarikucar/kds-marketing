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
//!
//! The provider adapters and the platform's provider apps have their own module,
//! [`connectors`].

pub mod connectors;

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetSpend, BudgetSpendId, Capability, CapabilityGroup,
    CapabilityGroupId, CapabilityId, KindGroup, StoredStatus,
};
use jt_connector::{EventKind, InboundEvent, InboundEventId, ProbeResult, Provider};
use jt_ledger::LedgerEntry;
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, Hypothesis, HypothesisId,
    HypothesisState, Sections, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, MembershipStatus, OperatorId, Permission,
    RoleDef, RoleId, SessionId, UserId, WorkspaceId, WorkspaceStatus, define_id,
};
use serde::Serialize;
use serde_json::Value;
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
    /// A 32-byte key for computing MACs on behalf of workspace `ws` for one `purpose` (e.g.
    /// `"oauth-state"`, `"netgsm-hook"`): the same for the same workspace and purpose (also after
    /// a restart), different for another workspace or another purpose, and independent of the
    /// sealing key. Like what `open` gives back, it is never returned, logged or stored, and it
    /// is wiped from memory when dropped (functions taking `&[u8; 32]` get `&key`, which
    /// dereferences).
    fn hmac_key(&self, ws: WorkspaceId, purpose: &str) -> Result<Zeroizing<[u8; 32]>, AppError>;
}

/// The kinds of channel a workspace can use: the kind keys (e.g. `instagram`, `mailbox`) of its
/// capabilities that are not retired. A strategy may choose only these, or `any`.
#[async_trait]
pub trait ChannelCatalog: Send + Sync {
    /// The kind keys in use in `ws`; none at all is an empty set.
    async fn kinds_in_use(&self, ws: WorkspaceId) -> Result<BTreeSet<String>, AppError>;
}

/// The hosts each workspace's connectors may reach: the tenant tier of the egress allowlist
/// (spec §4.3), filled from the hosts a capability declares and emptied again when it retires.
///
/// Only a public host enters it. A host that names this machine or a private network (`localhost`,
/// a single-label name, a private suffix such as `.local` or `.internal`, an IP literal in a
/// loopback, private, link-local, shared or other special-purpose range) is refused, so a tenant
/// cannot point the system at its own network. The check is on the text of the host; what a
/// public name resolves to is checked by the egress client's DNS guard when it connects.
///
/// The tier is one set of hosts per workspace, not counted per capability: a caller revoking a
/// host first makes sure no other capability of the workspace still needs it. It lives in memory,
/// so every method is synchronous, and it starts empty: it is rebuilt from the capability records
/// at start-up (`rebuild_from`).
pub trait TenantHostRegistry: Send + Sync {
    /// `Ok` when `host` (`host` or `host:port`, an IPv6 literal in brackets) may enter a tenant
    /// tier, else `VALIDATION` "host is not public" naming it in `details.host`. Changes nothing:
    /// a use case checks every host before it writes, and allows them once it has committed.
    fn check(&self, host: &str) -> Result<(), AppError>;
    /// Lets workspace `ws` reach `host`; refuses what `check` refuses, and then changes nothing.
    /// Allowing a host twice is allowing it once.
    fn allow(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError>;
    /// Workspace `ws` may no longer reach `host`. A host it could not reach is a no-op: revoking
    /// only takes away, so it refuses nothing.
    fn revoke(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError>;
    /// Replaces workspace `ws`'s whole tier with `hosts`: afterwards it reaches exactly those of
    /// them `check` accepts, and nothing it reached before. A host `check` refuses is skipped
    /// with a warning, not an error, so one bad stored host cannot keep the others out; an empty
    /// list empties the tier. Returns how many distinct hosts the tier now holds. Used to rebuild
    /// the tier from the capability records, which outlive it.
    fn rebuild_from(&self, ws: WorkspaceId, hosts: Vec<String>) -> Result<usize, AppError>;
}

/// Told when a workspace's approved strategy version has been archived, after the archive is
/// committed, so that work planned under it can be called off (spec §5: the gate closes again).
///
/// An error does not undo the archive, which already holds; the archive use case passes it on.
/// Implementations are therefore idempotent, so that telling them twice about one version is
/// harmless.
#[async_trait]
pub trait StrategyArchivedHook: Send + Sync {
    async fn on_archived(
        &self,
        ws: WorkspaceId,
        version_id: StrategyVersionId,
    ) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------------------------
// Rows and views
//
// A row that carries a secret's hash (a password, a session, invite or API-key token) does not
// implement `Serialize`, so it cannot reach a response or a ledger payload by accident; the use
// cases answer with views and summaries that leave the hash out. Its `Debug` prints the hash as
// `***`, so a log line or a failed assertion does not show it either.
// ---------------------------------------------------------------------------------------------

/// Prints `***` in place of a secret (a hash, a sealed blob, a credential) in a `Debug` output.
pub(crate) struct Masked;

impl std::fmt::Debug for Masked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

/// A user account. Not `Serialize`, and `Debug` masks it: it carries the password hash (see the
/// section note).
#[derive(Clone, PartialEq, Eq)]
pub struct UserRow {
    pub id: UserId,
    pub email: Email,
    pub password_hash: String,
    pub display_name: String,
    pub created_at: OffsetDateTime,
}

impl std::fmt::Debug for UserRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserRow")
            .field("id", &self.id)
            .field("email", &self.email)
            .field("password_hash", &Masked)
            .field("display_name", &self.display_name)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// A panel login session. Only the hash of its token is stored. Not `Serialize`; `Debug` masks
/// the hash.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub id: SessionId,
    pub user_id: UserId,
    pub token_hash: String,
    pub current_workspace_id: Option<WorkspaceId>,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub revoked_at: Option<OffsetDateTime>,
}

impl std::fmt::Debug for SessionRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRow")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("token_hash", &Masked)
            .field("current_workspace_id", &self.current_workspace_id)
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

/// A membership as stored: an invitation (`user_id` unset until accepted) or an active member.
/// Not `Serialize`, and `Debug` masks it: it carries the invite token's hash.
#[derive(Clone, PartialEq, Eq)]
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

impl std::fmt::Debug for MembershipRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MembershipRow")
            .field("id", &self.id)
            .field("workspace_id", &self.workspace_id)
            .field("user_id", &self.user_id)
            .field("role_id", &self.role_id)
            .field("status", &self.status)
            .field("invited_email", &self.invited_email)
            .field(
                "invite_token_hash",
                &self.invite_token_hash.as_ref().map(|_| Masked),
            )
            .field("invite_expires_at", &self.invite_expires_at)
            .field("invited_by", &self.invited_by)
            .field("created_at", &self.created_at)
            .finish()
    }
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
/// `Serialize`: callers show a `KeySummary`; `Debug` masks the hash.
#[derive(Clone, PartialEq, Eq)]
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

impl std::fmt::Debug for ApiKeyRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiKeyRow")
            .field("id", &self.id)
            .field("workspace_id", &self.workspace_id)
            .field("name", &self.name)
            .field("prefix", &self.prefix)
            .field("key_hash", &Masked)
            .field("scopes", &self.scopes)
            .field("issued_by", &self.issued_by)
            .field("status", &self.status)
            .field("created_at", &self.created_at)
            .field("last_used_at", &self.last_used_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
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

/// A platform operator. Not `Serialize`, and `Debug` masks it: it carries the password hash.
#[derive(Clone, PartialEq, Eq)]
pub struct OperatorRow {
    pub id: OperatorId,
    pub email: Email,
    pub password_hash: String,
    pub created_at: OffsetDateTime,
}

impl std::fmt::Debug for OperatorRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorRow")
            .field("id", &self.id)
            .field("email", &self.email)
            .field("password_hash", &Masked)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// A platform operator's login session. Only the hash of its token is stored. Not `Serialize`;
/// `Debug` masks the hash.
#[derive(Clone, PartialEq, Eq)]
pub struct PlatformSessionRow {
    pub id: Uuid,
    pub operator_id: OperatorId,
    pub token_hash: String,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

impl std::fmt::Debug for PlatformSessionRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlatformSessionRow")
            .field("id", &self.id)
            .field("operator_id", &self.operator_id)
            .field("token_hash", &Masked)
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Which ledger entries to list: newest first, at most `limit`, optionally older than `before_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LedgerFilter {
    /// Keep only actions starting with this text, e.g. `"team."`.
    pub action_prefix: Option<String>,
    /// Keep only this actor kind: `"human"`, `"agent"` or `"system"`.
    pub actor_kind: Option<String>,
    /// Keep only entries an agent made through this connection.
    pub agent_connection_id: Option<AgentConnectionId>,
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

/// The action of an agent's check-in entry (`work.checkin`), which
/// [`LedgerRepo::last_checkin_at`] looks up.
pub const CHECKIN_ACTION: &str = "work.checkin";

/// The workspace's append-only ledger.
#[async_trait]
pub trait LedgerRepo: Send + Sync {
    /// Appends the entry and returns its sequence id. An `entry.workspace_id` other than the
    /// bundle's is `INTERNAL`.
    async fn append(&mut self, entry: LedgerEntry) -> Result<i64, AppError>;
    async fn list(&mut self, filter: LedgerFilter) -> Result<Vec<LedgerRow>, AppError>;
    /// When the latest [`CHECKIN_ACTION`] entry an agent wrote through connection `connection_id`
    /// was made (the entry with the highest sequence id), or `None` when it has none. In Postgres
    /// the lookup matches the partial index `ledger_entries_agent_connection_idx` exactly (its
    /// action is a literal in both), so it never scans the workspace's ledger.
    async fn last_checkin_at(
        &mut self,
        connection_id: AgentConnectionId,
    ) -> Result<Option<OffsetDateTime>, AppError>;
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
    /// The version's entries of `kind`, newest first as [`ConsultationRepo::list`] orders them,
    /// at most `limit` (clamped to `1..=MAX_CONSULTATION_PAGE`); an unknown version has none.
    async fn list_kind(
        &mut self,
        version_id: StrategyVersionId,
        kind: ConsultationKind,
        limit: u32,
    ) -> Result<Vec<ConsultationEntry>, AppError>;
    /// How many entries the version's log holds; an unknown version has none.
    async fn count(&mut self, version_id: StrategyVersionId) -> Result<i64, AppError>;
}

// ---------------------------------------------------------------------------------------------
// Capability repositories: tenant repositories too, over one workspace's capabilities, their
// groups, budget items and spend, and its workspace-wide policies.
// ---------------------------------------------------------------------------------------------

/// Which capabilities [`CapabilityRepo::list`] returns: those matching every field that is set
/// (all of them when none is).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CapabilityFilter {
    /// Only kinds of this group.
    pub group: Option<KindGroup>,
    /// Only this kind key (a [`jt_capability::CapabilityKind::key`]).
    pub kind: Option<&'static str>,
    /// Only this stored status.
    pub status: Option<StoredStatus>,
    /// Only members of this capability group; a group that is not the workspace's has none.
    pub group_id: Option<CapabilityGroupId>,
}

/// The workspace's capabilities.
///
/// A kind may have many capabilities (B10), but one external account (the same `kind_key` and
/// `external_id`) is held by at most one capability that is not `Retired`. Postgres enforces it
/// with a partial unique index, so of two transactions racing to break it the second one fails
/// with `CONFLICT`; the fakes refuse the same writes.
///
/// The sealed connector credentials are stored beside a capability but never inside the
/// [`Capability`] value: it only says whether there are any (`has_sealed_config`), and the bytes
/// come back only from [`CapabilityRepo::read_sealed`]. `has_sealed_config` and
/// `budget_item_ids` are derived on read (from the sealed column and from the budget links), so
/// `insert` and `update` ignore them: the blob is written by `insert`'s `sealed` and by
/// `set_sealed`, the links by [`BudgetRepo::link`] and [`BudgetRepo::unlink`].
///
/// Values are stored as given: callers build them with `Capability::new` and validate changes
/// first.
///
/// **Every mutation of a capability** (verifying it, marking it unreachable, setting its policy,
/// retiring it, linking or unlinking a budget item, adding it to a group) **reads the capability
/// through [`CapabilityRepo::lock`] first, in the bundle that writes**, and decides on what that
/// returns. The lock is held until the bundle commits or is dropped, so a concurrent mutation of
/// the same capability waits and then sees the committed result: one cannot write back a row the
/// other changed (a policy flag, a retirement) or attach a capability retired meanwhile.
#[async_trait]
pub trait CapabilityRepo: Send + Sync {
    /// Stores a capability with its sealed credentials, if any. A `capability.workspace_id` other
    /// than the bundle's is `INTERNAL`; a taken id, or an external account already held by a
    /// capability of the same kind that is not retired, is `CONFLICT`.
    async fn insert(
        &mut self,
        capability: Capability,
        sealed: Option<Vec<u8>>,
    ) -> Result<(), AppError>;
    /// The capability, with `has_sealed_config` and its budget item ids (in id order), read
    /// without a lock: for answering, not for deciding a write.
    async fn find(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError>;
    /// The capability as [`CapabilityRepo::find`] reads it, its row locked against every other
    /// `lock` (and every write to it) until this bundle commits or is dropped; `None` when the id
    /// is not the workspace's.
    ///
    /// A call that has to wait for another bundle holding the lock returns what that bundle
    /// committed, its budget links and groups included. In Postgres it is `select .. for update`
    /// followed by a fresh read; the in-memory fakes run one bundle at a time in tests, so there
    /// it is `find`.
    async fn lock(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError>;
    /// The capabilities `filter` matches, oldest (`created_at`, then id) first.
    async fn list(&mut self, filter: CapabilityFilter) -> Result<Vec<Capability>, AppError>;
    /// Writes every stored field of `capability` but its identity: `kind_key`, `created_at` and
    /// `declared_by_connection` stay as stored, and the sealed blob and the budget links are not
    /// touched. A
    /// `capability.workspace_id` other than the bundle's is `INTERNAL`; an unknown id is
    /// `NOT_FOUND`; moving it onto an external account another live capability of its kind
    /// holds is `CONFLICT` (in Postgres the transaction is then aborted).
    async fn update(&mut self, capability: Capability) -> Result<(), AppError>;
    /// Replaces the sealed credentials (`None` removes them) and sets `updated_at = at`, so a
    /// credential change shows in the capability's update time. An unknown id is `NOT_FOUND`.
    async fn set_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// The sealed credentials, `None` when there are none. An unknown id is `NOT_FOUND`.
    ///
    /// Only the connector use cases call it, to open the blob with the `SecretBox`; no use case
    /// returns what it gives back.
    async fn read_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError>;
    /// Sets the stored status and `updated_at = at`. An unknown id is `NOT_FOUND`; bringing a
    /// retired capability back while another live one holds its external account is `CONFLICT`
    /// (in Postgres the transaction is then aborted).
    async fn set_status(
        &mut self,
        id: CapabilityId,
        status: StoredStatus,
        at: OffsetDateTime,
    ) -> Result<(), AppError>;
    /// The kind keys of the capabilities that are not retired; none at all is an empty set. The
    /// `ChannelCatalog` answers from it.
    async fn kinds_in_use(&mut self) -> Result<BTreeSet<String>, AppError>;
}

/// The workspace's capability groups and their members. A group's name is unique within the
/// workspace (exactly, case included). Member ids come in id order.
#[async_trait]
pub trait CapabilityGroupRepo: Send + Sync {
    /// Stores a group created at `at`. A `group.workspace_id` other than the bundle's is
    /// `INTERNAL`; a taken id or name is `CONFLICT`.
    async fn insert(&mut self, group: CapabilityGroup, at: OffsetDateTime) -> Result<(), AppError>;
    /// Every group with its members, oldest group first.
    async fn list(&mut self) -> Result<Vec<(CapabilityGroup, Vec<CapabilityId>)>, AppError>;
    /// The group with its members.
    async fn find(
        &mut self,
        id: CapabilityGroupId,
    ) -> Result<Option<(CapabilityGroup, Vec<CapabilityId>)>, AppError>;
    /// Renames the group (callers validate the name). An unknown id is `NOT_FOUND`; a name
    /// another group of the workspace has is `CONFLICT` (in Postgres the transaction is then
    /// aborted).
    async fn rename(&mut self, id: CapabilityGroupId, name: &str) -> Result<(), AppError>;
    /// Deletes the group; its members are detached, the capabilities stay. An unknown id is
    /// `NOT_FOUND`.
    async fn delete(&mut self, id: CapabilityGroupId) -> Result<(), AppError>;
    /// Adds the capability to the group; adding a member again changes nothing. A group or a
    /// capability that is not the bundle's workspace's is `NOT_FOUND` (Review Focus 3).
    async fn add_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError>;
    /// Removes the capability from the group. A pair that is not a member of a group of the
    /// workspace is `NOT_FOUND`.
    async fn remove_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError>;
}

/// The most entries one [`BudgetRepo::list_spend`] returns.
pub const MAX_SPEND_PAGE: u32 = 500;

/// The workspace's budget items, the capabilities linked to them, and the append-only ledger of
/// what was spent from each. Spend entries are never changed or deleted (Postgres refuses it with
/// a trigger).
///
/// Values are stored as given: callers build them with `BudgetItem::new` and `BudgetSpend::new`.
/// A negative cap or an amount that is not positive breaks a check constraint and is `INTERNAL`.
#[async_trait]
pub trait BudgetRepo: Send + Sync {
    /// Stores a budget item. An `item.workspace_id` other than the bundle's is `INTERNAL`; a
    /// taken id is `CONFLICT`.
    async fn insert_item(&mut self, item: BudgetItem) -> Result<(), AppError>;
    /// Every budget item, retired ones included, oldest (`created_at`, then id) first.
    async fn list_items(&mut self) -> Result<Vec<BudgetItem>, AppError>;
    async fn find_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError>;
    /// Budget item `id`, locked until the bundle ends (`select … for update` in `jt_pg`), or
    /// `None` when it is not the workspace's. Editing or retiring an item, linking a capability
    /// to it and recording a spend from it read it through here first, so a retirement and a
    /// link or a spend take turns: neither lands on an item retired meanwhile. Whoever also locks
    /// a capability locks it first (`CapabilityRepo::lock`), then the item.
    async fn lock_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError>;
    /// Writes the item's name, cap, period and retirement time (`retired_at`); its kind, unit,
    /// strategy version and creation time never change. An item that is not the workspace's is
    /// `NOT_FOUND`; an `item.workspace_id` other than the bundle's is `INTERNAL`.
    async fn update_item(&mut self, item: BudgetItem) -> Result<(), AppError>;
    /// Removes every capability's link to the item and answers how many there were (none for an
    /// item that is not the workspace's).
    async fn unlink_item(&mut self, item: BudgetItemId) -> Result<u64, AppError>;
    /// Links the capability to the budget item it spends from; linking again changes nothing. A
    /// capability or an item that is not the bundle's workspace's is `NOT_FOUND` (Review Focus
    /// 3). Whether the kinds fit (`can_link_budget`) is the caller's rule.
    async fn link(&mut self, capability: CapabilityId, item: BudgetItemId) -> Result<(), AppError>;
    /// Removes the link. A pair that is not linked in the workspace is `NOT_FOUND`.
    async fn unlink(
        &mut self,
        capability: CapabilityId,
        item: BudgetItemId,
    ) -> Result<(), AppError>;
    /// Appends a spend to the ledger of its item and returns its id. A `spend.workspace_id`
    /// other than the bundle's is `INTERNAL`; an item that is not the workspace's is
    /// `NOT_FOUND`; a taken id is `CONFLICT`.
    async fn append_spend(&mut self, spend: BudgetSpend) -> Result<BudgetSpendId, AppError>;
    /// The sum of the item's spend at `from` or later and before `to` (the half-open window of
    /// `period_window`); 0 for an item with none (or not the workspace's). A sum beyond
    /// `i64::MAX` reads as `i64::MAX`.
    async fn spent_between(
        &mut self,
        item: BudgetItemId,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<i64, AppError>;
    /// The item's spend newest first, ordered by `(at, id)` descending, at most `limit` (clamped
    /// to `1..=MAX_SPEND_PAGE`). `before` is a keyset cursor, the `(at, id)` of the previous
    /// page's last entry: only entries ordered after it are returned.
    async fn list_spend(
        &mut self,
        item: BudgetItemId,
        limit: u32,
        before: Option<(OffsetDateTime, BudgetSpendId)>,
    ) -> Result<Vec<BudgetSpend>, AppError>;
}

/// How often an agent checks in unless the workspace says otherwise: once a day.
pub const DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES: u32 = 1_440;
/// The shortest check-in interval a workspace may set, in minutes.
pub const MIN_AGENT_CHECKIN_INTERVAL_MINUTES: u32 = 15;
/// The longest check-in interval a workspace may set, in minutes: a week.
pub const MAX_AGENT_CHECKIN_INTERVAL_MINUTES: u32 = 10_080;

/// The workspace-wide policies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspacePolicy {
    /// How often an agent is expected to check in, in minutes:
    /// `MIN_AGENT_CHECKIN_INTERVAL_MINUTES..=MAX_AGENT_CHECKIN_INTERVAL_MINUTES`.
    pub agent_checkin_interval_minutes: u32,
}

impl Default for WorkspacePolicy {
    fn default() -> Self {
        WorkspacePolicy {
            agent_checkin_interval_minutes: DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES,
        }
    }
}

/// The workspace's policies.
#[async_trait]
pub trait WorkspacePolicyRepo: Send + Sync {
    /// The stored policies, or [`WorkspacePolicy::default`] while none are stored.
    async fn get(&mut self) -> Result<WorkspacePolicy, AppError>;
    /// Stores the policies, updated at `at`, replacing any stored before. An interval outside
    /// `MIN_AGENT_CHECKIN_INTERVAL_MINUTES..=MAX_AGENT_CHECKIN_INTERVAL_MINUTES` breaks a check
    /// constraint and is `INTERNAL`: callers validate first.
    async fn set(&mut self, policy: WorkspacePolicy, at: OffsetDateTime) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------------------------
// Connector repositories: tenant repositories too, over one workspace's inbound events, pending
// OAuth flows and probe runs.
// ---------------------------------------------------------------------------------------------

/// The most events one [`InboundEventRepo::list_pending`] or [`InboundEventRepo::list`]
/// returns.
pub const MAX_EVENT_PAGE: u32 = 500;

/// Which inbound events [`InboundEventRepo::list`] reads, and in which order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventQuery {
    /// Only events not yet processed.
    pub pending_only: bool,
    /// Only events of this provider.
    pub provider: Option<Provider>,
    /// Only events of this kind (compared by key, so an `Unknown` kind matches its own key).
    pub kind: Option<EventKind>,
    /// The order, and where the page starts.
    pub order: EventOrder,
    /// At most this many events (clamped to `1..=MAX_EVENT_PAGE`).
    pub limit: u32,
}

/// The order of an event listing and its key-set cursor: an event's `(received_at, id)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventOrder {
    /// Oldest (`received_at`, then id) first; with a cursor, only events after it.
    OldestFirst {
        after: Option<(OffsetDateTime, InboundEventId)>,
    },
    /// Newest (`received_at`, then id, both descending) first; with a cursor, only events
    /// before it.
    NewestFirst {
        before: Option<(OffsetDateTime, InboundEventId)>,
    },
}

/// The workspace's inbound events: what webhooks and polls brought in, each stored once per
/// provider id (`(provider, external_id)` is unique within a workspace), with its raw body for a
/// while.
///
/// An event never changes but for its processing time and the removal of its raw body, and is
/// never deleted: Postgres refuses anything else with a trigger, and the fakes offer no other
/// write.
#[async_trait]
pub trait InboundEventRepo: Send + Sync {
    /// Stores `event` with its raw body and returns its id, unless the workspace already holds
    /// an event with the same provider and provider id: then nothing is written and the answer is
    /// `None` (a replayed delivery, Review Focus 2), and the bundle stays usable. Of two bundles
    /// racing to store the same event, the second waits for the first and then gets `None` (or
    /// stores it, if the first rolled back).
    ///
    /// An `event.workspace_id` other than the bundle's is `INTERNAL`; a `capability_id` that is
    /// not the workspace's is `NOT_FOUND`; a taken id (for another event) is `CONFLICT`.
    async fn insert_if_new(
        &mut self,
        event: InboundEvent,
        raw: Option<Vec<u8>>,
    ) -> Result<Option<InboundEventId>, AppError>;
    /// The events not yet processed, oldest (`received_at`, then id) first, at most `limit`
    /// (clamped to `1..=MAX_EVENT_PAGE`).
    async fn list_pending(&mut self, limit: u32) -> Result<Vec<InboundEvent>, AppError>;
    /// Marks the event processed at `at` and answers `true`; an event already processed keeps
    /// its time and answers `false`. An unknown id is `NOT_FOUND`.
    async fn mark_processed(
        &mut self,
        id: InboundEventId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError>;
    /// Removes the raw body of every event received before `cutoff` (the rest of each event
    /// stays) and returns how many bodies were removed.
    async fn purge_raw_before(&mut self, cutoff: OffsetDateTime) -> Result<u64, AppError>;
    /// The events `query` selects, in its order, at most its `limit` (clamped to
    /// `1..=MAX_EVENT_PAGE`). Never the raw bodies: no read gives them back.
    async fn list(&mut self, query: EventQuery) -> Result<Vec<InboundEvent>, AppError>;
    /// How many events are not yet processed, counting no further than `cap`: the answer is
    /// `min(pending, cap)`.
    async fn count_pending(&mut self, cap: u32) -> Result<u32, AppError>;
}

define_id!(
    /// A pending OAuth flow.
    OAuthPendingId
);

/// An OAuth flow between its start and the owner's choice of assets. Found by the hash of its
/// signed state ([`jt_connector::OAuthState`]); the PKCE code verifier, when the flow uses one, is
/// sealed here and never travels in the state.
///
/// Not `Serialize`, and `Debug` masks it: it carries sealed blobs and the state's hash.
#[derive(Clone, PartialEq, Eq)]
pub struct OAuthPendingRow {
    pub id: OAuthPendingId,
    pub workspace_id: WorkspaceId,
    pub provider: Provider,
    /// The capability kind being connected, e.g. `"facebook_page"`.
    pub kind_key: String,
    /// The hash of the signed state, unique across every workspace.
    pub state_hash: String,
    /// The user who started it (for an agent, the user who issued its key).
    pub started_by: UserId,
    /// The capability a reconnection renews: confirming the flow replaces this capability's
    /// sealed credentials instead of creating capabilities. `None` for a new connection.
    pub capability_id: Option<CapabilityId>,
    /// The PKCE code verifier, sealed for the workspace.
    pub pkce_verifier_sealed: Option<Vec<u8>>,
    /// The assets the account can reach, credentials included, sealed for the workspace; set
    /// once the provider has called back.
    pub assets_sealed: Option<Vec<u8>>,
    /// The non-secret facts of those assets, a JSON array (`[]` until then).
    pub assets_public: Value,
    /// When the flow stops being accepted.
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
}

impl std::fmt::Debug for OAuthPendingRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthPendingRow")
            .field("id", &self.id)
            .field("workspace_id", &self.workspace_id)
            .field("provider", &self.provider)
            .field("kind_key", &self.kind_key)
            .field("state_hash", &Masked)
            .field("started_by", &self.started_by)
            .field("capability_id", &self.capability_id)
            .field(
                "pkce_verifier_sealed",
                &self.pkce_verifier_sealed.as_ref().map(|_| Masked),
            )
            .field(
                "assets_sealed",
                &self.assets_sealed.as_ref().map(|_| Masked),
            )
            .field("assets_public", &self.assets_public)
            .field("expires_at", &self.expires_at)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// The workspace's pending OAuth flows. Short-lived rows: a flow is deleted once confirmed, and
/// expired flows are purged.
#[async_trait]
pub trait OAuthPendingRepo: Send + Sync {
    /// Stores the flow. A `row.workspace_id` other than the bundle's is `INTERNAL`; a
    /// `started_by` that names no user, or a `capability_id` that is not the workspace's, is
    /// `NOT_FOUND`; a taken id, or a state hash any workspace already holds, is `CONFLICT`.
    async fn insert(&mut self, row: OAuthPendingRow) -> Result<(), AppError>;
    /// The workspace's flow with this state hash, expired ones included, read without a lock;
    /// the caller checks.
    async fn find_by_state_hash(
        &mut self,
        state_hash: &str,
    ) -> Result<Option<OAuthPendingRow>, AppError>;
    /// The workspace's flow `id`, expired ones included, its row locked against every other
    /// `lock` (and every write to it) until this bundle commits or is dropped; `None` when the id
    /// is not the workspace's. A call that has to wait for another bundle holding the lock
    /// returns what that bundle committed (`None` once it deleted the flow). Every write that
    /// decides on a flow's state (storing its assets, confirming it) reads it through here first.
    /// In Postgres it is `select .. for update`; the in-memory fakes run one bundle at a time in
    /// tests, so there it is a plain read.
    async fn lock(&mut self, id: OAuthPendingId) -> Result<Option<OAuthPendingRow>, AppError>;
    /// Stores the assets the provider's callback found: `sealed` (credentials included, sealed
    /// for the workspace) and their public facts. An unknown id is `NOT_FOUND`.
    async fn set_assets(
        &mut self,
        id: OAuthPendingId,
        sealed: Vec<u8>,
        public: Value,
    ) -> Result<(), AppError>;
    /// Deletes the flow. An unknown id is `NOT_FOUND`.
    async fn delete(&mut self, id: OAuthPendingId) -> Result<(), AppError>;
    /// Deletes every flow that expired before `now` (`expires_at < now`: a flow is still
    /// accepted at its expiry instant) and returns how many.
    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError>;
}

define_id!(
    /// A probe run.
    ProbeRunId
);

/// One probe of a connector capability: when, whether it succeeded, why not (the
/// [`jt_connector::ConnectorError::kind`] key, `None` when it succeeded or the adapter did not
/// say), how long it took, and the non-secret facts it returned. Build it from the probe's result
/// with [`ProbeRun::from_result`], so the error kind is always one the schema accepts.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProbeRun {
    pub id: ProbeRunId,
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub ok: bool,
    pub error_kind: Option<String>,
    /// Stored as a 32-bit signed integer: a latency beyond `i32::MAX` milliseconds (24 days) is
    /// stored, and read back, as `i32::MAX`.
    pub latency_ms: u32,
    pub facts: Value,
}

impl ProbeRun {
    /// The run that records `result`: `ok` decides (as in [`jt_connector::status_after_probe`]),
    /// the error kind is the [`jt_connector::ConnectorError::kind`] of a failure's error (`None`
    /// for a success, and for a failure the adapter did not explain), and the facts are the
    /// result's.
    pub fn from_result(
        id: ProbeRunId,
        workspace_id: WorkspaceId,
        capability_id: CapabilityId,
        at: OffsetDateTime,
        result: &ProbeResult,
    ) -> ProbeRun {
        let error_kind = if result.ok {
            None
        } else {
            result.error.as_ref().map(|e| e.kind().to_owned())
        };
        ProbeRun {
            id,
            workspace_id,
            capability_id,
            at,
            ok: result.ok,
            error_kind,
            latency_ms: result.latency_ms,
            facts: result.facts.clone(),
        }
    }
}

/// The most runs one [`ProbeRunRepo::list`] returns.
pub const MAX_PROBE_PAGE: u32 = 500;

/// The workspace's probe log. Runs are never changed or deleted (Postgres refuses it with a
/// trigger).
#[async_trait]
pub trait ProbeRunRepo: Send + Sync {
    /// Appends the run and returns its id. A `run.workspace_id` other than the bundle's is
    /// `INTERNAL`; a capability that is not the workspace's is `NOT_FOUND`; a taken id is
    /// `CONFLICT`; an `error_kind` that is not a `ConnectorError` kind key breaks a check
    /// constraint and is `INTERNAL`.
    async fn append(&mut self, run: ProbeRun) -> Result<ProbeRunId, AppError>;
    /// The capability's newest run (`at`, then id), if any.
    async fn latest(&mut self, capability_id: CapabilityId) -> Result<Option<ProbeRun>, AppError>;
    /// The capability's runs newest first, ordered by `(at, id)` descending, at most `limit`
    /// (clamped to `1..=MAX_PROBE_PAGE`); a capability that is not the workspace's has none.
    async fn list(
        &mut self,
        capability_id: CapabilityId,
        limit: u32,
    ) -> Result<Vec<ProbeRun>, AppError>;
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
    fn capabilities(&mut self) -> &mut dyn CapabilityRepo;
    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo;
    fn budget(&mut self) -> &mut dyn BudgetRepo;
    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo;
    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo;
    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo;
    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo;
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
    /// The connected capability, in whichever workspace it belongs to, whose kind is one of
    /// `kind_keys` and whose external account id is `external_id`: where an inbound event for
    /// that account is routed. Connected means proved through the provider: sealed credentials
    /// present, stored status `Verified` or `Unreachable` (an expired token keeps its events, so
    /// they are there when the owner reconnects), **and** verified at least once
    /// (`last_verified_at` set). For a connector capability only a successful probe sets
    /// `last_verified_at`, and only when the probe showed the credential to be the capability's
    /// own account; binding the capability to another account clears it. So a capability that is
    /// only declared (anyone can type a public page id), sealed but never verified (a pasted
    /// token that failed its probe, or reached another account, ends `Unreachable` and sealed),
    /// verified on an agent's word without credentials, or retired never receives events,
    /// whichever workspace holds it.
    ///
    /// `None` when no workspace holds the account connected (the event is routed nowhere, Review
    /// Focus 1). When several do (the same account connected in two workspaces, or under two
    /// kinds), a `Verified` one wins over an `Unreachable` one, then the most recently created
    /// (`created_at`, then id, both descending). Read as [`CapabilityRepo::find`] reads it.
    async fn capability_by_external(
        &mut self,
        kind_keys: &[&str],
        external_id: &str,
    ) -> Result<Option<Capability>, AppError>;
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

#[cfg(test)]
mod tests {
    use jt_connector::{ConnectorError, ProbeResult};
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    #[test]
    fn a_probe_run_records_the_kind_of_its_error_and_only_when_it_failed() {
        let (id, ws, cap) = (
            ProbeRunId::new_v7(),
            WorkspaceId::new_v7(),
            CapabilityId::new_v7(),
        );
        let at = datetime!(2026-10-22 09:00 UTC);
        let ok = ProbeRun::from_result(
            id,
            ws,
            cap,
            at,
            &ProbeResult::success(12, json!({ "n": 1 })),
        );
        assert_eq!(
            ok,
            ProbeRun {
                id,
                workspace_id: ws,
                capability_id: cap,
                at,
                ok: true,
                error_kind: None,
                latency_ms: 12,
                facts: json!({ "n": 1 }),
            }
        );
        let failed = ProbeRun::from_result(
            id,
            ws,
            cap,
            at,
            &ProbeResult::failure(30, ConnectorError::auth("expired")),
        );
        assert!(!failed.ok);
        assert_eq!(failed.error_kind.as_deref(), Some("auth"));
        assert_eq!(failed.latency_ms, 30);
        assert_eq!(failed.facts, json!({}));
        let throttled = ProbeRun::from_result(
            id,
            ws,
            cap,
            at,
            &ProbeResult::failure(5, ConnectorError::throttle(None)),
        );
        assert_eq!(throttled.error_kind.as_deref(), Some("throttle"));
        // A failure the adapter did not explain has no kind; `ok` decides when the two disagree.
        let unexplained = ProbeResult {
            ok: false,
            latency_ms: 1,
            error: None,
            facts: json!({}),
        };
        assert_eq!(
            ProbeRun::from_result(id, ws, cap, at, &unexplained).error_kind,
            None
        );
        let contradictory = ProbeResult {
            ok: true,
            latency_ms: 1,
            error: Some(ConnectorError::transient("late")),
            facts: json!({}),
        };
        let run = ProbeRun::from_result(id, ws, cap, at, &contradictory);
        assert!(run.ok);
        assert_eq!(run.error_kind, None);
    }
}
