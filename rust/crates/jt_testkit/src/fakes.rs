//! Fakes for the application ports: a fixed clock, sequential ids, scripted tokens, a plain-text
//! "hasher" and an in-memory unit of work.
//!
//! [`InMemoryUow`] keeps its tables behind one shared lock. Each bundle it opens works on a copy
//! taken when it opens (reads see that copy plus the bundle's own writes) and records its writes;
//! `commit` replays them onto the shared tables, and dropping a bundle uncommitted discards them.
//! Bundles keep the contracts of `jt_app::ports` and the constraints of migration 0001, answering
//! as `jt_pg` does so that a fake is never more permissive than the database:
//! - a duplicate where the schema has a unique key is `CONFLICT`;
//! - a reference to a role, user or workspace that does not exist is `NOT_FOUND`, as is a role
//!   that is not the membership's workspace's; any other dangling reference is `INTERNAL`;
//! - a tenant bundle sees only its own workspace's rows and refuses rows for another with
//!   `INTERNAL`;
//! - `RoleRepo::insert` refuses a role marked `is_system` with `INTERNAL`;
//! - once any call on a bundle has failed, the bundle is spoiled: its `commit` returns
//!   `INTERNAL` and writes nothing, as a Postgres transaction aborted by a failed statement does.
//!
//! Ledger ids come from one shared sequence that, like a database sequence, never rolls back.
//!
//! Commit replays a bundle's buffered writes onto the shared tables without validating them again,
//! so two bundles that each passed their checks on their own copy both commit, where Postgres
//! would refuse one (a unique key, a row lock). Tests of races and concurrent transactions must
//! run against Postgres (`TestDb`), not these fakes.

use std::collections::{BTreeSet, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    AgentConnectionRepo, AgentConnectionRow, ApiKeyRepo, ApiKeyRow, ApiKeyStatus, Clock, IdGen,
    LedgerFilter, LedgerRepo, LedgerRow, MemberOut, MembershipRepo, MembershipRow, MembershipView,
    OperatorRepo, OperatorRow, PasswordHasher, PlatformRepos, PlatformSessionRepo,
    PlatformSessionRow, RoleRepo, SessionRepo, SessionRow, TenantRepos, TokenGen, UnitOfWork,
    UserRepo, UserRepos, UserRow, WorkspaceRepo, WorkspaceRow,
};
use jt_ledger::{Actor, LedgerEntry};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, Email, MembershipId, MembershipStatus, Permission, RoleDef,
    RoleId, SessionId, SystemRole, UserId, WorkspaceId, WorkspaceStatus,
};
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------------------------
// Service fakes
// ---------------------------------------------------------------------------------------------

/// A clock that always reads the same instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedClock(pub OffsetDateTime);

impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime {
        self.0
    }
}

/// Deterministic ids: `Uuid::from_u128(1)`, `Uuid::from_u128(2)`, … in call order.
#[derive(Debug, Default)]
pub struct SeqIdGen {
    issued: AtomicU64,
}

impl SeqIdGen {
    pub fn new() -> Self {
        Self::default()
    }
}

impl IdGen for SeqIdGen {
    fn uuid(&self) -> Uuid {
        let n = self.issued.fetch_add(1, Ordering::SeqCst) + 1;
        Uuid::from_u128(u128::from(n))
    }
}

/// Hands out scripted tokens in order, whatever byte length is asked for.
#[derive(Debug)]
pub struct FixedTokenGen {
    tokens: Mutex<VecDeque<String>>,
}

impl FixedTokenGen {
    pub fn new<I, S>(tokens: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        FixedTokenGen {
            tokens: Mutex::new(tokens.into_iter().map(Into::into).collect()),
        }
    }
}

impl TokenGen for FixedTokenGen {
    /// The next scripted token. Panics when none is left: the test scripted too few.
    fn token(&self, _bytes: usize) -> String {
        lock(&self.tokens).pop_front().unwrap_or_else(|| {
            panic!("FixedTokenGen is exhausted: the test scripted fewer tokens than were requested")
        })
    }
}

/// The hash `PlainHasher` writes is the password behind this prefix.
pub const PLAIN_PREFIX: &str = "plain:";

/// A "hasher" that stores `plain:<password>`, so tests can read and seed hashes directly.
#[derive(Clone, Copy, Debug, Default)]
pub struct PlainHasher;

#[async_trait]
impl PasswordHasher for PlainHasher {
    async fn hash(&self, pw: &str) -> Result<String, AppError> {
        Ok(format!("{PLAIN_PREFIX}{pw}"))
    }

    async fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> {
        hash.strip_prefix(PLAIN_PREFIX)
            .map(|stored| stored == pw)
            .ok_or_else(|| AppError::internal("not a plain: hash"))
    }
}

// ---------------------------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------------------------

/// A role together with the workspace it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRole {
    pub workspace_id: WorkspaceId,
    pub role: RoleDef,
}

/// Every table, in insertion order.
#[derive(Clone, Debug, Default)]
pub struct MemState {
    pub workspaces: Vec<WorkspaceRow>,
    pub users: Vec<UserRow>,
    pub sessions: Vec<SessionRow>,
    pub roles: Vec<StoredRole>,
    pub memberships: Vec<MembershipRow>,
    pub api_keys: Vec<ApiKeyRow>,
    pub agent_connections: Vec<AgentConnectionRow>,
    pub ledger: Vec<LedgerRow>,
    pub operators: Vec<OperatorRow>,
    pub platform_sessions: Vec<PlatformSessionRow>,
}

impl MemState {
    fn workspace(&self, ws: WorkspaceId) -> Option<&WorkspaceRow> {
        self.workspaces.iter().find(|w| w.id == ws)
    }

    fn user(&self, id: UserId) -> Option<&UserRow> {
        self.users.iter().find(|u| u.id == id)
    }

    fn role_in(&self, ws: WorkspaceId, id: RoleId) -> Option<&RoleDef> {
        self.roles
            .iter()
            .find(|r| r.workspace_id == ws && r.role.id == id)
            .map(|r| &r.role)
    }

    fn membership_in(&self, ws: WorkspaceId, id: MembershipId) -> Option<&MembershipRow> {
        self.memberships
            .iter()
            .find(|m| m.workspace_id == ws && m.id == id)
    }

    /// Whether `user` holds a membership in `ws` that is not `Removed`, other than `except`.
    fn has_live_membership(&self, ws: WorkspaceId, user: UserId, except: MembershipId) -> bool {
        self.memberships.iter().any(|m| {
            m.workspace_id == ws
                && m.user_id == Some(user)
                && m.status != MembershipStatus::Removed
                && m.id != except
        })
    }

    fn is_owner_role(&self, ws: WorkspaceId, id: RoleId) -> bool {
        self.role_in(ws, id)
            .is_some_and(|r| r.is_system && r.key == SystemRole::Owner.key())
    }

    /// Active owner memberships of `ws`, oldest first.
    fn active_owners(&self, ws: WorkspaceId) -> Vec<&MembershipRow> {
        let mut owners: Vec<&MembershipRow> = self
            .memberships
            .iter()
            .filter(|m| {
                m.workspace_id == ws
                    && m.status == MembershipStatus::Active
                    && self.is_owner_role(ws, m.role_id)
            })
            .collect();
        owners.sort_by_key(|m| (m.created_at, m.id));
        owners
    }

    /// Checks the role for `ws`: a dangling workspace is `INTERNAL`, a taken key or id `CONFLICT`.
    fn check_new_role(&self, ws: WorkspaceId, role: &RoleDef) -> Result<(), AppError> {
        exists(self.workspace(ws).is_some(), "roles.workspace_id")?;
        unique(
            !self
                .roles
                .iter()
                .any(|r| r.role.id == role.id || (r.workspace_id == ws && r.role.key == role.key)),
            "role key is already taken",
        )
    }

    /// Checks a new membership's references and the one-live-membership-per-user rule. A role that
    /// is not the membership's workspace's is `NOT_FOUND`, checked first as in `jt_pg`.
    fn check_new_membership(&self, row: &MembershipRow) -> Result<(), AppError> {
        role_in_workspace(self, row.workspace_id, row.role_id)?;
        exists(
            self.workspace(row.workspace_id).is_some(),
            "memberships.workspace_id",
        )?;
        if let Some(user) = row.user_id {
            exists(self.user(user).is_some(), "memberships.user_id")?;
        }
        if let Some(by) = row.invited_by {
            exists(self.user(by).is_some(), "memberships.invited_by")?;
        }
        unique(
            !self.memberships.iter().any(|m| m.id == row.id),
            "membership id is already taken",
        )?;
        if let Some(hash) = &row.invite_token_hash {
            unique(
                !self
                    .memberships
                    .iter()
                    .any(|m| m.invite_token_hash.as_ref() == Some(hash)),
                "invite token is already taken",
            )?;
        }
        if let (Some(user), true) = (row.user_id, row.status != MembershipStatus::Removed) {
            unique(
                !self.has_live_membership(row.workspace_id, user, row.id),
                "the user is already a member of this workspace",
            )?;
        }
        Ok(())
    }

    fn check_new_ledger_entry(&self, entry: &LedgerEntry) -> Result<(), AppError> {
        exists(
            self.workspace(entry.workspace_id).is_some(),
            "ledger_entries.workspace_id",
        )
    }

    fn membership_view(&self, m: &MembershipRow) -> Result<MembershipView, AppError> {
        let ws = self
            .workspace(m.workspace_id)
            .ok_or_else(|| dangling("memberships.workspace_id"))?;
        let role = self
            .role_in(m.workspace_id, m.role_id)
            .ok_or_else(|| dangling("memberships.role_id"))?;
        Ok(MembershipView {
            membership_id: m.id,
            workspace_id: ws.id,
            workspace_name: ws.name.clone(),
            workspace_slug: ws.slug.clone(),
            workspace_status: ws.status,
            role_key: role.key.clone(),
            permissions: role.permissions.clone(),
        })
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn dangling(reference: &str) -> AppError {
    AppError::internal(format!("{reference} references a row that does not exist"))
}

/// Refuses a write whose reference, a foreign key in the schema named `table.column`, points
/// nowhere, answering as `jt_pg::map_sqlx` does: `NOT_FOUND` for a role, user or workspace (which
/// the caller supplied), `INTERNAL` for anything else.
fn exists(found: bool, reference: &str) -> Result<(), AppError> {
    if found {
        return Ok(());
    }
    let column = reference.rsplit('.').next().unwrap_or(reference);
    let kind = if column.ends_with("role_id") {
        Some("role")
    } else if column.ends_with("workspace_id") {
        Some("workspace")
    } else if matches!(column, "user_id" | "invited_by" | "issued_by") {
        Some("user")
    } else {
        None
    };
    match kind {
        Some(kind) => Err(AppError::not_found(format!("no such {kind}"))),
        None => Err(dangling(reference)),
    }
}

/// `NOT_FOUND` unless role `id` belongs to workspace `ws`, as `jt_pg` checks before every write
/// that sets a role (a foreign key alone would accept another workspace's role).
fn role_in_workspace(state: &MemState, ws: WorkspaceId, id: RoleId) -> Result<(), AppError> {
    if state.role_in(ws, id).is_some() {
        Ok(())
    } else {
        Err(AppError::not_found("no such role"))
    }
}

/// `CONFLICT` unless the value is free (a unique key in the schema).
fn unique(free: bool, message: &str) -> Result<(), AppError> {
    if free {
        Ok(())
    } else {
        Err(AppError::conflict(message))
    }
}

/// `INTERNAL` when a row for `row_ws` is handed to the tenant bundle of `ws`.
fn same_workspace(ws: WorkspaceId, row_ws: WorkspaceId) -> Result<(), AppError> {
    if ws == row_ws {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "a row for workspace {row_ws} was given to the bundle of workspace {ws}"
        )))
    }
}

fn actor_kind(actor: &Actor) -> &'static str {
    match actor {
        Actor::Human { .. } => "human",
        Actor::Agent { .. } => "agent",
        Actor::System { .. } => "system",
    }
}

// ---------------------------------------------------------------------------------------------
// The unit of work and its transactions
// ---------------------------------------------------------------------------------------------

/// An in-memory `UnitOfWork`. Clones share the same tables.
#[derive(Clone, Default)]
pub struct InMemoryUow {
    state: Arc<Mutex<MemState>>,
    ledger_seq: Arc<AtomicI64>,
}

impl InMemoryUow {
    pub fn new() -> Self {
        Self::default()
    }

    /// A copy of the committed tables, for assertions.
    pub fn snapshot(&self) -> MemState {
        lock(&self.state).clone()
    }
}

type Op = Box<dyn Fn(&mut MemState) + Send + Sync>;

/// One bundle's transaction: a private working copy plus the writes to replay on commit.
struct MemTx {
    shared: Arc<Mutex<MemState>>,
    ledger_seq: Arc<AtomicI64>,
    work: MemState,
    ops: Vec<Op>,
    /// Set once a call on the bundle has failed; `commit` then refuses.
    spoiled: bool,
}

impl MemTx {
    fn begin(uow: &InMemoryUow) -> MemTx {
        MemTx {
            shared: Arc::clone(&uow.state),
            ledger_seq: Arc::clone(&uow.ledger_seq),
            work: lock(&uow.state).clone(),
            ops: Vec::new(),
            spoiled: false,
        }
    }

    /// Applies `op` to the working copy now and records it for commit.
    fn write(&mut self, op: impl Fn(&mut MemState) + Send + Sync + 'static) {
        op(&mut self.work);
        self.ops.push(Box::new(op));
    }

    /// Replays the writes onto the shared tables, or, when a call failed, refuses with `INTERNAL`
    /// and writes nothing.
    fn commit(self) -> Result<(), AppError> {
        if self.spoiled {
            return Err(AppError::internal(
                "an earlier call failed, so the transaction was rolled back and nothing was \
                 committed",
            ));
        }
        let mut shared = lock(&self.shared);
        for op in &self.ops {
            op(&mut shared);
        }
        Ok(())
    }

    /// `MembershipRepo::activate` for membership `id` of `ws`.
    fn activate(
        &mut self,
        ws: WorkspaceId,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let m = self
            .work
            .membership_in(ws, id)
            .ok_or_else(|| AppError::not_found("no such membership"))?;
        let open = m.status == MembershipStatus::Invited
            && m.invite_expires_at.is_some_and(|expires| expires > at);
        if !open {
            return Err(AppError::conflict(
                "the membership is not an open invitation",
            ));
        }
        exists(self.work.user(user_id).is_some(), "memberships.user_id")?;
        unique(
            !self.work.has_live_membership(ws, user_id, id),
            "the user is already a member of this workspace",
        )?;
        self.write(move |s| {
            if let Some(m) = s.memberships.iter_mut().find(|m| m.id == id) {
                m.user_id = Some(user_id);
                m.status = MembershipStatus::Active;
                m.invite_token_hash = None;
                m.invite_expires_at = None;
            }
        });
        Ok(())
    }

    fn append_ledger(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.work.check_new_ledger_entry(&entry)?;
        let id = self.ledger_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let row = LedgerRow { id, entry };
        self.write(move |s| s.ledger.push(row.clone()));
        Ok(id)
    }
}

/// A bundle over one [`MemTx`].
trait MemBundle: Sized {
    fn tx(&mut self) -> &mut MemTx;

    /// Runs one fallible repo call. An error spoils the transaction, so `commit` refuses it.
    /// Every call that can fail goes through here.
    fn call<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, AppError>) -> Result<T, AppError> {
        let result = f(self);
        if result.is_err() {
            self.tx().spoiled = true;
        }
        result
    }
}

#[async_trait]
impl UnitOfWork for InMemoryUow {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        Ok(Box::new(MemTenant {
            tx: MemTx::begin(self),
            ws,
        }))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        Ok(Box::new(MemPlatform {
            tx: MemTx::begin(self),
        }))
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        Ok(Box::new(MemUser {
            tx: MemTx::begin(self),
        }))
    }
}

// ---------------------------------------------------------------------------------------------
// Tenant bundle
// ---------------------------------------------------------------------------------------------

/// A tenant bundle: every repo sees and writes only `ws`.
struct MemTenant {
    tx: MemTx,
    ws: WorkspaceId,
}

impl MemTenant {
    fn state(&self) -> &MemState {
        &self.tx.work
    }
}

impl MemBundle for MemTenant {
    fn tx(&mut self) -> &mut MemTx {
        &mut self.tx
    }
}

#[async_trait]
impl TenantRepos for MemTenant {
    fn roles(&mut self) -> &mut dyn RoleRepo {
        self
    }

    fn memberships(&mut self) -> &mut dyn MembershipRepo {
        self
    }

    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo {
        self
    }

    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo {
        self
    }

    fn ledger(&mut self) -> &mut dyn LedgerRepo {
        self
    }

    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.tx.commit()
    }
}

#[async_trait]
impl RoleRepo for MemTenant {
    async fn list(&mut self) -> Result<Vec<RoleDef>, AppError> {
        Ok(self
            .state()
            .roles
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .map(|r| r.role.clone())
            .collect())
    }

    async fn find_by_key(&mut self, key: &str) -> Result<Option<RoleDef>, AppError> {
        Ok(self
            .state()
            .roles
            .iter()
            .find(|r| r.workspace_id == self.ws && r.role.key == key)
            .map(|r| r.role.clone()))
    }

    async fn find(&mut self, id: RoleId) -> Result<Option<RoleDef>, AppError> {
        Ok(self.state().role_in(self.ws, id).cloned())
    }

    /// A role marked `is_system` is `INTERNAL`, as in `jt_pg`: system roles are created only with
    /// their workspace.
    async fn insert(&mut self, role: RoleDef) -> Result<(), AppError> {
        self.call(|this| {
            if role.is_system {
                return Err(AppError::internal(
                    "system roles are created only with their workspace",
                ));
            }
            this.state().check_new_role(this.ws, &role)?;
            let stored = StoredRole {
                workspace_id: this.ws,
                role,
            };
            this.tx.write(move |s| s.roles.push(stored.clone()));
            Ok(())
        })
    }

    async fn update_permissions(
        &mut self,
        id: RoleId,
        permissions: BTreeSet<Permission>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if this.state().role_in(this.ws, id).is_none() {
                return Err(AppError::not_found("no such role"));
            }
            let ws = this.ws;
            this.tx.write(move |s| {
                if let Some(r) = s
                    .roles
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.role.id == id)
                {
                    r.role.permissions = permissions.clone();
                }
            });
            Ok(())
        })
    }

    async fn delete_custom(&mut self, id: RoleId) -> Result<(), AppError> {
        self.call(|this| {
            let role = this
                .state()
                .role_in(this.ws, id)
                .ok_or_else(|| AppError::not_found("no such role"))?;
            if role.is_system {
                return Err(AppError::forbidden("a system role cannot be deleted"));
            }
            // `memberships.role_id` references the role without a cascade.
            if this.state().memberships.iter().any(|m| m.role_id == id) {
                return Err(AppError::conflict("the role is still in use"));
            }
            let ws = this.ws;
            this.tx.write(move |s| {
                s.roles
                    .retain(|r| !(r.workspace_id == ws && r.role.id == id));
            });
            Ok(())
        })
    }

    async fn count_memberships_using(&mut self, id: RoleId) -> Result<i64, AppError> {
        let n = self
            .state()
            .memberships
            .iter()
            .filter(|m| m.workspace_id == self.ws && m.role_id == id)
            .count();
        Ok(n as i64)
    }
}

#[async_trait]
impl MembershipRepo for MemTenant {
    async fn list(&mut self) -> Result<Vec<MemberOut>, AppError> {
        self.call(|this| {
            let (state, ws) = (this.state(), this.ws);
            let mut rows: Vec<&MembershipRow> = state
                .memberships
                .iter()
                .filter(|m| m.workspace_id == ws && m.status != MembershipStatus::Removed)
                .collect();
            rows.sort_by_key(|m| (m.created_at, m.id));
            rows.into_iter()
                .map(|m| {
                    let role = state
                        .role_in(ws, m.role_id)
                        .ok_or_else(|| dangling("memberships.role_id"))?;
                    let user = m.user_id.and_then(|u| state.user(u));
                    let email = match (user, &m.invited_email) {
                        (Some(u), _) => u.email.clone(),
                        (None, Some(invited)) => invited.clone(),
                        (None, None) => {
                            return Err(AppError::internal(
                                "a membership has neither user nor email",
                            ));
                        }
                    };
                    Ok(MemberOut {
                        membership_id: m.id,
                        user_id: m.user_id,
                        email,
                        display_name: user.map(|u| u.display_name.clone()),
                        role_key: role.key.clone(),
                        role_name: role.name.clone(),
                        status: m.status,
                        created_at: m.created_at,
                    })
                })
                .collect()
        })
    }

    async fn find(&mut self, id: MembershipId) -> Result<Option<MembershipRow>, AppError> {
        Ok(self.state().membership_in(self.ws, id).cloned())
    }

    async fn find_by_user(&mut self, user_id: UserId) -> Result<Option<MembershipRow>, AppError> {
        Ok(self
            .state()
            .memberships
            .iter()
            .find(|m| {
                m.workspace_id == self.ws
                    && m.user_id == Some(user_id)
                    && m.status != MembershipStatus::Removed
            })
            .cloned())
    }

    async fn insert_invite(&mut self, row: MembershipRow) -> Result<(), AppError> {
        self.call(|this| {
            same_workspace(this.ws, row.workspace_id)?;
            this.state().check_new_membership(&row)?;
            this.tx.write(move |s| s.memberships.push(row.clone()));
            Ok(())
        })
    }

    async fn activate(
        &mut self,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.ws;
        self.call(|this| this.tx.activate(ws, id, user_id, at))
    }

    async fn set_role(&mut self, id: MembershipId, role_id: RoleId) -> Result<(), AppError> {
        self.call(|this| {
            role_in_workspace(this.state(), this.ws, role_id)?;
            if this.state().membership_in(this.ws, id).is_none() {
                return Err(AppError::not_found("no such membership"));
            }
            this.tx.write(move |s| {
                if let Some(m) = s.memberships.iter_mut().find(|m| m.id == id) {
                    m.role_id = role_id;
                }
            });
            Ok(())
        })
    }

    async fn remove(&mut self, id: MembershipId) -> Result<(), AppError> {
        self.call(|this| {
            if this.state().membership_in(this.ws, id).is_none() {
                return Err(AppError::not_found("no such membership"));
            }
            this.tx.write(move |s| {
                if let Some(m) = s.memberships.iter_mut().find(|m| m.id == id) {
                    m.status = MembershipStatus::Removed;
                }
            });
            Ok(())
        })
    }

    async fn count_active_owners(&mut self) -> Result<i64, AppError> {
        Ok(self.state().active_owners(self.ws).len() as i64)
    }
}

#[async_trait]
impl ApiKeyRepo for MemTenant {
    async fn insert(&mut self, row: ApiKeyRow) -> Result<(), AppError> {
        self.call(|this| {
            same_workspace(this.ws, row.workspace_id)?;
            let state = this.state();
            exists(
                state.workspace(row.workspace_id).is_some(),
                "api_keys.workspace_id",
            )?;
            exists(state.user(row.issued_by).is_some(), "api_keys.issued_by")?;
            unique(
                !state
                    .api_keys
                    .iter()
                    .any(|k| k.id == row.id || k.key_hash == row.key_hash),
                "API key is already taken",
            )?;
            this.tx.write(move |s| s.api_keys.push(row.clone()));
            Ok(())
        })
    }

    async fn list(&mut self) -> Result<Vec<ApiKeyRow>, AppError> {
        let mut keys: Vec<ApiKeyRow> = self
            .state()
            .api_keys
            .iter()
            .filter(|k| k.workspace_id == self.ws)
            .cloned()
            .collect();
        keys.sort_by_key(|k| (k.created_at, k.id));
        Ok(keys)
    }

    async fn revoke(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if !this
                .state()
                .api_keys
                .iter()
                .any(|k| k.workspace_id == ws && k.id == id)
            {
                return Err(AppError::not_found("no such API key"));
            }
            this.tx.write(move |s| {
                if let Some(k) = s.api_keys.iter_mut().find(|k| k.id == id) {
                    k.status = ApiKeyStatus::Revoked;
                    k.revoked_at = Some(at);
                }
            });
            Ok(())
        })
    }

    async fn touch_last_used(&mut self, id: ApiKeyId, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            if let Some(k) = s
                .api_keys
                .iter_mut()
                .find(|k| k.workspace_id == ws && k.id == id)
            {
                k.last_used_at = Some(at);
            }
        });
        Ok(())
    }
}

#[async_trait]
impl AgentConnectionRepo for MemTenant {
    async fn upsert_on_initialize(
        &mut self,
        row: AgentConnectionRow,
    ) -> Result<(AgentConnectionId, bool), AppError> {
        self.call(|this| {
            same_workspace(this.ws, row.workspace_id)?;
            let ws = this.ws;
            let existing = this
                .state()
                .agent_connections
                .iter()
                .find(|c| {
                    c.workspace_id == ws
                        && c.api_key_id == row.api_key_id
                        && c.client_name == row.client_name
                        && c.client_version == row.client_version
                })
                .map(|c| c.id);
            if let Some(id) = existing {
                let (last_seen_at, protocol_version) = (row.last_seen_at, row.protocol_version);
                this.tx.write(move |s| {
                    if let Some(c) = s.agent_connections.iter_mut().find(|c| c.id == id) {
                        c.last_seen_at = last_seen_at;
                        c.protocol_version = protocol_version.clone();
                    }
                });
                return Ok((id, false));
            }
            let state = this.state();
            exists(
                state
                    .api_keys
                    .iter()
                    .any(|k| k.workspace_id == ws && k.id == row.api_key_id),
                "agent_connections.api_key_id",
            )?;
            unique(
                !state.agent_connections.iter().any(|c| c.id == row.id),
                "agent connection id is already taken",
            )?;
            let id = row.id;
            this.tx
                .write(move |s| s.agent_connections.push(row.clone()));
            Ok((id, true))
        })
    }

    async fn touch_tool_call(
        &mut self,
        id: AgentConnectionId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.ws;
        self.tx.write(move |s| {
            if let Some(c) = s
                .agent_connections
                .iter_mut()
                .find(|c| c.workspace_id == ws && c.id == id)
            {
                c.tool_calls += 1;
                c.last_seen_at = at;
            }
        });
        Ok(())
    }

    async fn list(&mut self) -> Result<Vec<AgentConnectionRow>, AppError> {
        let mut rows: Vec<AgentConnectionRow> = self
            .state()
            .agent_connections
            .iter()
            .filter(|c| c.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by_key(|c| (c.first_seen_at, c.id));
        Ok(rows)
    }

    async fn find(
        &mut self,
        id: AgentConnectionId,
    ) -> Result<Option<AgentConnectionRow>, AppError> {
        Ok(self
            .state()
            .agent_connections
            .iter()
            .find(|c| c.workspace_id == self.ws && c.id == id)
            .cloned())
    }
}

#[async_trait]
impl LedgerRepo for MemTenant {
    async fn append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.call(|this| {
            same_workspace(this.ws, entry.workspace_id)?;
            this.tx.append_ledger(entry)
        })
    }

    async fn list(&mut self, filter: LedgerFilter) -> Result<Vec<LedgerRow>, AppError> {
        let mut rows: Vec<LedgerRow> = self
            .state()
            .ledger
            .iter()
            .filter(|r| r.entry.workspace_id == self.ws)
            .filter(|r| filter.before_id.is_none_or(|before| r.id < before))
            .filter(|r| {
                filter
                    .action_prefix
                    .as_deref()
                    .is_none_or(|p| r.entry.action.as_str().starts_with(p))
            })
            .filter(|r| {
                filter
                    .actor_kind
                    .as_deref()
                    .is_none_or(|k| actor_kind(&r.entry.actor) == k)
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        rows.truncate(filter.limit as usize);
        Ok(rows)
    }
}

#[async_trait]
impl WorkspaceRepo for MemTenant {
    async fn get(&mut self) -> Result<WorkspaceRow, AppError> {
        self.call(|this| {
            this.state()
                .workspace(this.ws)
                .cloned()
                .ok_or_else(|| AppError::not_found("no such workspace"))
        })
    }
}

// ---------------------------------------------------------------------------------------------
// User bundle
// ---------------------------------------------------------------------------------------------

/// A user-level bundle: users, sessions and registration.
struct MemUser {
    tx: MemTx,
}

impl MemUser {
    fn state(&self) -> &MemState {
        &self.tx.work
    }
}

impl MemBundle for MemUser {
    fn tx(&mut self) -> &mut MemTx {
        &mut self.tx
    }
}

#[async_trait]
impl UserRepo for MemUser {
    async fn find_by_email(&mut self, email: &Email) -> Result<Option<UserRow>, AppError> {
        Ok(self
            .state()
            .users
            .iter()
            .find(|u| u.email == *email)
            .cloned())
    }

    async fn find_by_id(&mut self, id: UserId) -> Result<Option<UserRow>, AppError> {
        Ok(self.state().user(id).cloned())
    }

    async fn insert(&mut self, row: UserRow) -> Result<(), AppError> {
        self.call(|this| {
            unique(
                !this
                    .state()
                    .users
                    .iter()
                    .any(|u| u.id == row.id || u.email == row.email),
                "email is already registered",
            )?;
            this.tx.write(move |s| s.users.push(row.clone()));
            Ok(())
        })
    }
}

#[async_trait]
impl SessionRepo for MemUser {
    async fn insert(&mut self, row: SessionRow) -> Result<(), AppError> {
        self.call(|this| {
            let state = this.state();
            exists(state.user(row.user_id).is_some(), "sessions.user_id")?;
            if let Some(ws) = row.current_workspace_id {
                exists(
                    state.workspace(ws).is_some(),
                    "sessions.current_workspace_id",
                )?;
            }
            unique(
                !state
                    .sessions
                    .iter()
                    .any(|x| x.id == row.id || x.token_hash == row.token_hash),
                "session token is already taken",
            )?;
            this.tx.write(move |s| s.sessions.push(row.clone()));
            Ok(())
        })
    }

    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<SessionRow>, AppError> {
        Ok(self
            .state()
            .sessions
            .iter()
            .find(|x| x.token_hash == token_hash)
            .cloned())
    }

    async fn revoke(&mut self, id: SessionId, at: OffsetDateTime) -> Result<(), AppError> {
        self.tx.write(move |s| {
            if let Some(x) = s
                .sessions
                .iter_mut()
                .find(|x| x.id == id && x.revoked_at.is_none())
            {
                x.revoked_at = Some(at);
            }
        });
        Ok(())
    }

    async fn revoke_all_for_workspace(
        &mut self,
        user_id: UserId,
        workspace_id: WorkspaceId,
        now: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.tx.write(move |s| {
            for x in s.sessions.iter_mut().filter(|x| {
                x.user_id == user_id
                    && x.current_workspace_id == Some(workspace_id)
                    && x.revoked_at.is_none()
                    && x.expires_at > now
            }) {
                x.revoked_at = Some(now);
            }
        });
        Ok(())
    }

    async fn set_current_workspace(
        &mut self,
        id: SessionId,
        ws: Option<WorkspaceId>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if let Some(ws) = ws {
                exists(
                    this.state().workspace(ws).is_some(),
                    "sessions.current_workspace_id",
                )?;
            }
            this.tx.write(move |s| {
                if let Some(x) = s.sessions.iter_mut().find(|x| x.id == id) {
                    x.current_workspace_id = ws;
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl UserRepos for MemUser {
    fn users(&mut self) -> &mut dyn UserRepo {
        self
    }

    fn sessions(&mut self) -> &mut dyn SessionRepo {
        self
    }

    async fn memberships_of_user(
        &mut self,
        user_id: UserId,
    ) -> Result<Vec<MembershipView>, AppError> {
        self.call(|this| {
            let state = this.state();
            let mut rows: Vec<&MembershipRow> = state
                .memberships
                .iter()
                .filter(|m| m.user_id == Some(user_id) && m.status == MembershipStatus::Active)
                .collect();
            rows.sort_by_key(|m| (m.created_at, m.id));
            rows.into_iter().map(|m| state.membership_view(m)).collect()
        })
    }

    async fn workspaces_create(
        &mut self,
        id: WorkspaceId,
        name: &str,
        slug: &str,
        status: WorkspaceStatus,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            unique(
                !this
                    .state()
                    .workspaces
                    .iter()
                    .any(|w| w.id == id || w.slug == slug),
                "workspace slug is already taken",
            )?;
            let row = WorkspaceRow {
                id,
                name: name.to_owned(),
                slug: slug.to_owned(),
                status,
                created_at,
            };
            this.tx.write(move |s| s.workspaces.push(row.clone()));
            Ok(())
        })
    }

    async fn roles_create_system(
        &mut self,
        ws: WorkspaceId,
        roles: &[RoleDef],
    ) -> Result<(), AppError> {
        self.call(|this| {
            for role in roles {
                let role = RoleDef {
                    is_system: true,
                    ..role.clone()
                };
                this.state().check_new_role(ws, &role)?;
                let stored = StoredRole {
                    workspace_id: ws,
                    role,
                };
                this.tx.write(move |s| s.roles.push(stored.clone()));
            }
            Ok(())
        })
    }

    async fn memberships_insert_active(
        &mut self,
        id: MembershipId,
        workspace_id: WorkspaceId,
        user_id: UserId,
        role_id: RoleId,
        created_at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let row = MembershipRow {
                id,
                workspace_id,
                user_id: Some(user_id),
                role_id,
                status: MembershipStatus::Active,
                invited_email: None,
                invite_token_hash: None,
                invite_expires_at: None,
                invited_by: None,
                created_at,
            };
            this.state().check_new_membership(&row)?;
            this.tx.write(move |s| s.memberships.push(row.clone()));
            Ok(())
        })
    }

    async fn memberships_activate(
        &mut self,
        workspace_id: WorkspaceId,
        id: MembershipId,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| this.tx.activate(workspace_id, id, user_id, at))
    }

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.call(|this| this.tx.append_ledger(entry))
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.tx.commit()
    }
}

// ---------------------------------------------------------------------------------------------
// Platform bundle
// ---------------------------------------------------------------------------------------------

/// A platform-wide bundle.
struct MemPlatform {
    tx: MemTx,
}

impl MemPlatform {
    fn state(&self) -> &MemState {
        &self.tx.work
    }
}

impl MemBundle for MemPlatform {
    fn tx(&mut self) -> &mut MemTx {
        &mut self.tx
    }
}

#[async_trait]
impl OperatorRepo for MemPlatform {
    async fn count(&mut self) -> Result<i64, AppError> {
        Ok(self.state().operators.len() as i64)
    }

    async fn insert(&mut self, row: OperatorRow) -> Result<(), AppError> {
        self.call(|this| {
            unique(
                !this
                    .state()
                    .operators
                    .iter()
                    .any(|o| o.id == row.id || o.email == row.email),
                "operator email is already registered",
            )?;
            this.tx.write(move |s| s.operators.push(row.clone()));
            Ok(())
        })
    }

    async fn find_by_email(&mut self, email: &Email) -> Result<Option<OperatorRow>, AppError> {
        Ok(self
            .state()
            .operators
            .iter()
            .find(|o| o.email == *email)
            .cloned())
    }
}

#[async_trait]
impl PlatformSessionRepo for MemPlatform {
    async fn insert(&mut self, row: PlatformSessionRow) -> Result<(), AppError> {
        self.call(|this| {
            let state = this.state();
            exists(
                state.operators.iter().any(|o| o.id == row.operator_id),
                "platform_sessions.operator_id",
            )?;
            unique(
                !state
                    .platform_sessions
                    .iter()
                    .any(|x| x.id == row.id || x.token_hash == row.token_hash),
                "platform session token is already taken",
            )?;
            this.tx
                .write(move |s| s.platform_sessions.push(row.clone()));
            Ok(())
        })
    }

    async fn find_by_token_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<PlatformSessionRow>, AppError> {
        Ok(self
            .state()
            .platform_sessions
            .iter()
            .find(|x| x.token_hash == token_hash)
            .cloned())
    }
}

#[async_trait]
impl PlatformRepos for MemPlatform {
    fn operators(&mut self) -> &mut dyn OperatorRepo {
        self
    }

    fn platform_sessions(&mut self) -> &mut dyn PlatformSessionRepo {
        self
    }

    async fn workspaces_list(&mut self) -> Result<Vec<WorkspaceRow>, AppError> {
        let mut rows = self.state().workspaces.clone();
        rows.sort_by_key(|w| (w.created_at, w.id));
        Ok(rows)
    }

    async fn workspace_get(&mut self, ws: WorkspaceId) -> Result<Option<WorkspaceRow>, AppError> {
        Ok(self.state().workspace(ws).cloned())
    }

    async fn workspace_set_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if this.state().workspace(ws).is_none() {
                return Err(AppError::not_found("no such workspace"));
            }
            this.tx.write(move |s| {
                if let Some(w) = s.workspaces.iter_mut().find(|w| w.id == ws) {
                    w.status = status;
                }
            });
            Ok(())
        })
    }

    async fn workspace_owner_email(&mut self, ws: WorkspaceId) -> Result<Option<Email>, AppError> {
        let state = self.state();
        Ok(state
            .active_owners(ws)
            .first()
            .and_then(|m| m.user_id)
            .and_then(|u| state.user(u))
            .map(|u| u.email.clone()))
    }

    async fn workspace_member_count(&mut self, ws: WorkspaceId) -> Result<i64, AppError> {
        let n = self
            .state()
            .memberships
            .iter()
            .filter(|m| m.workspace_id == ws && m.status == MembershipStatus::Active)
            .count();
        Ok(n as i64)
    }

    async fn api_key_find_by_hash(
        &mut self,
        key_hash: &str,
    ) -> Result<Option<ApiKeyRow>, AppError> {
        Ok(self
            .state()
            .api_keys
            .iter()
            .find(|k| k.key_hash == key_hash)
            .cloned())
    }

    async fn membership_find_by_invite_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<MembershipRow>, AppError> {
        Ok(self
            .state()
            .memberships
            .iter()
            .find(|m| m.invite_token_hash.as_deref() == Some(token_hash))
            .cloned())
    }

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.call(|this| this.tx.append_ledger(entry))
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.tx.commit()
    }
}
