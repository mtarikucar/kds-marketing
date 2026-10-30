//! The tenant bundle and its tenancy repos: roles, memberships, API keys, agent connections, the
//! ledger and the workspace's own row.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::inbox::*;
use jt_app::ports::{
    AgentConnectionRepo, AgentConnectionRow, ApiKeyRepo, ApiKeyRow, ApiKeyStatus, BudgetRepo,
    CHECKIN_ACTION, CapabilityGroupRepo, CapabilityRepo, ConsultationRepo, HypothesisRepo,
    InboundEventRepo, LedgerFilter, LedgerRepo, LedgerRow, MemberOut, MembershipRepo,
    MembershipRow, OAuthPendingRepo, OutboundJobRepo, ProbeRunRepo, RoleRepo, StrategyRepo,
    TenantRepos, WorkspacePolicyRepo, WorkspaceRepo, WorkspaceRow,
};
use jt_ledger::{Actor, LedgerEntry};
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, MembershipId, MembershipStatus, Permission, RoleDef, RoleId,
    SystemRole, UserId, WorkspaceId,
};
use time::OffsetDateTime;

use super::state::{
    MemBundle, MemState, MemTx, StoredRole, actor_kind, dangling, exists, role_in_workspace,
    same_workspace, unique,
};

/// A tenant bundle: every repo sees and writes only `ws`.
pub(super) struct MemTenant {
    pub(super) tx: MemTx,
    pub(super) ws: WorkspaceId,
}

impl MemTenant {
    pub(super) fn inbox_write_at(&self) -> OffsetDateTime {
        self.tx
            .inbox_write_at
            .unwrap_or_else(OffsetDateTime::now_utc)
    }

    pub(super) fn state(&self) -> &MemState {
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
    fn billing(&mut self) -> &mut dyn jt_app::ports::billing::BillingRepo {
        self
    }

    fn activation_codes(&mut self) -> &mut dyn jt_app::ports::billing::ActivationCodeRepo {
        self
    }

    fn studio(&mut self) -> &mut dyn jt_app::ports::studio::StudioRepo {
        self
    }

    fn studio_budget(&mut self) -> &mut dyn jt_app::ports::studio::StudioBudgetRepo {
        self
    }

    fn studio_control(&mut self) -> &mut dyn jt_app::ports::studio::StudioControlRepo {
        self
    }

    fn calls(&mut self) -> &mut dyn jt_app::ports::calls::CallRepo {
        self
    }

    fn device_commands(&mut self) -> &mut dyn jt_app::ports::devices::DeviceCommandRepo {
        self
    }
    fn prospects(&mut self) -> &mut dyn jt_app::ports::prospects::ProspectRepo {
        self
    }

    fn research_tasks(&mut self) -> &mut dyn jt_app::ports::prospects::ResearchTaskRepo {
        self
    }

    fn prospect_blocklist(&mut self) -> &mut dyn jt_app::ports::prospects::BlocklistRepo {
        self
    }

    fn consents(&mut self) -> &mut dyn jt_app::ports::inbox::ConsentRepo {
        self
    }
    fn suppressions(&mut self) -> &mut dyn jt_app::ports::inbox::SuppressionRepo {
        self
    }
    fn quotes(&mut self) -> &mut dyn jt_app::ports::inbox::QuoteRepo {
        self
    }
    fn appointments(&mut self) -> &mut dyn jt_app::ports::inbox::AppointmentRepo {
        self
    }
    fn commissions(&mut self) -> &mut dyn jt_app::ports::inbox::CommissionRepo {
        self
    }
    fn erasure(&mut self) -> &mut dyn jt_app::ports::inbox::ErasureRepo {
        self
    }
    fn mail_cursors(&mut self) -> &mut dyn jt_app::ports::inbox::MailCursorRepo {
        self
    }
    fn attribution(&mut self) -> &mut dyn jt_app::ports::inbox::AttributionRepo {
        self
    }

    fn people(&mut self) -> &mut dyn PersonRepo {
        self
    }
    fn identities(&mut self) -> &mut dyn IdentityRepo {
        self
    }
    fn conversations(&mut self) -> &mut dyn ConversationRepo {
        self
    }
    fn messages(&mut self) -> &mut dyn MessageRepo {
        self
    }
    fn journeys(&mut self) -> &mut dyn JourneyRepo {
        self
    }
    fn tasks(&mut self) -> &mut dyn TaskRepo {
        self
    }
    fn notes(&mut self) -> &mut dyn NoteRepo {
        self
    }
    fn merges(&mut self) -> &mut dyn MergeRepo {
        self
    }
    fn lost_reasons(&mut self) -> &mut dyn LostReasonRepo {
        self
    }
    fn consumption(&mut self) -> &mut dyn ConsumptionRepo {
        self
    }
    fn request_keys(&mut self) -> &mut dyn RequestKeyRepo {
        self
    }
    fn outbox(&mut self) -> &mut dyn OutboxRepo {
        self
    }

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

    fn strategy(&mut self) -> &mut dyn StrategyRepo {
        self
    }

    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo {
        self
    }

    fn consultation(&mut self) -> &mut dyn ConsultationRepo {
        self
    }

    fn capabilities(&mut self) -> &mut dyn CapabilityRepo {
        self
    }

    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo {
        self
    }

    fn budget(&mut self) -> &mut dyn BudgetRepo {
        self
    }

    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo {
        self
    }

    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo {
        self
    }

    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo {
        self
    }

    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo {
        self
    }

    fn outbound_jobs(&mut self) -> &mut dyn OutboundJobRepo {
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
        self.tx.lock_studio().await;
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
            let ws = this.ws;
            let state = this.state();
            if state
                .memberships
                .iter()
                .any(|m| m.role_id == id && m.status != MembershipStatus::Removed)
            {
                return Err(AppError::conflict("the role is still in use"));
            }
            // `memberships.role_id` references the role without a cascade, so removed
            // memberships move to the system `rep` role first, as in `jt_pg`.
            let rep = state
                .roles
                .iter()
                .find(|r| {
                    r.workspace_id == ws && r.role.is_system && r.role.key == SystemRole::Rep.key()
                })
                .map(|r| r.role.id)
                .ok_or_else(|| AppError::internal("the workspace has no system rep role"))?;
            this.tx.write(move |s| {
                for m in s.memberships.iter_mut().filter(|m| {
                    m.workspace_id == ws && m.role_id == id && m.status == MembershipStatus::Removed
                }) {
                    m.role_id = rep;
                }
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
            .filter(|m| {
                m.workspace_id == self.ws
                    && m.role_id == id
                    && m.status != MembershipStatus::Removed
            })
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

    async fn lock_by_user(&mut self, user_id: UserId) -> Result<Option<MembershipRow>, AppError> {
        self.tx.lock_studio().await;
        self.find_by_user(user_id).await
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
        self.tx.lock_studio().await;
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
        self.tx.lock_studio().await;
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
        self.tx.lock_studio().await;
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

    async fn revoke_all_for_user(
        &mut self,
        user_id: UserId,
        at: OffsetDateTime,
    ) -> Result<Vec<ApiKeyId>, AppError> {
        let ws = self.ws;
        let revocable = move |k: &ApiKeyRow| {
            k.workspace_id == ws && k.issued_by == user_id && k.status == ApiKeyStatus::Active
        };
        let mut ids: Vec<ApiKeyId> = self
            .state()
            .api_keys
            .iter()
            .filter(|k| revocable(k))
            .map(|k| k.id)
            .collect();
        ids.sort();
        self.tx.write(move |s| {
            for k in s.api_keys.iter_mut().filter(|k| revocable(k)) {
                k.status = ApiKeyStatus::Revoked;
                k.revoked_at = Some(at);
            }
        });
        Ok(ids)
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
            .filter(|r| {
                filter.agent_connection_id.is_none_or(|id| {
                    matches!(r.entry.actor, Actor::Agent { connection_id, .. } if connection_id == id)
                })
            })
            .cloned()
            .collect();
        for row in &mut rows {
            if self.state().inbox.erasure_logs.iter().any(|e| {
                e.workspace_id == self.ws
                    && row.entry.payload["person_id"] == serde_json::json!(e.person_id)
            }) {
                jt_app::usecases::inbox::erasure::mask_personal(&mut row.entry.payload);
            }
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        rows.truncate(filter.limit as usize);
        Ok(rows)
    }

    async fn last_checkin_at(
        &mut self,
        connection_id: AgentConnectionId,
    ) -> Result<Option<OffsetDateTime>, AppError> {
        Ok(self
            .state()
            .ledger
            .iter()
            .filter(|r| r.entry.workspace_id == self.ws)
            .filter(|r| r.entry.action.as_str() == CHECKIN_ACTION)
            .filter(|r| {
                matches!(r.entry.actor, Actor::Agent { connection_id: c, .. } if c == connection_id)
            })
            .max_by_key(|r| r.id)
            .map(|r| r.entry.at))
    }
}

#[async_trait]
impl WorkspaceRepo for MemTenant {
    async fn lock(&mut self) -> Result<WorkspaceRow, AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.billing_workspace(t.ws))
    }
    async fn set_status(
        &mut self,
        ws: WorkspaceId,
        status: jt_tenancy::WorkspaceStatus,
        reason: &str,
        by: &Actor,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| {
            same_workspace(t.ws, ws)?;
            t.tx.billing_status(ws, status, reason, by)
        })
    }

    async fn get(&mut self) -> Result<WorkspaceRow, AppError> {
        self.call(|this| {
            this.state()
                .workspace(this.ws)
                .cloned()
                .ok_or_else(|| AppError::not_found("no such workspace"))
        })
    }
}
