//! The user-level bundle: users, sessions and registration.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    MembershipRow, MembershipView, SessionRepo, SessionRow, UserRepo, UserRepos, UserRow,
    WorkspaceRow,
};
use jt_ledger::LedgerEntry;
use jt_tenancy::{
    Email, MembershipId, MembershipStatus, RoleDef, RoleId, SessionId, UserId, WorkspaceId,
    WorkspaceStatus,
};
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, MemTx, StoredRole, exists, unique};

/// A user-level bundle: users, sessions and registration.
pub(super) struct MemUser {
    pub(super) tx: MemTx,
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
    async fn lost_reasons_initialize(&mut self, ws: WorkspaceId) -> Result<(), AppError> {
        self.call(|this| {
            exists(
                this.state().workspace(ws).is_some(),
                "lost_reasons.workspace_id",
            )?;
            this.tx
                .write(move |s| super::inbox::initialize_defaults(&mut s.inbox, ws));
            Ok(())
        })
    }

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
