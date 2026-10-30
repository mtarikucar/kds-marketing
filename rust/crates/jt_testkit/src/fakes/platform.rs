//! The platform-wide bundle: operators, their sessions, every workspace and lookups by secret
//! hash.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::billing::*;
use jt_app::ports::{
    ApiKeyRow, MembershipRow, OperatorRepo, OperatorRow, PlatformRepos, PlatformSessionRepo,
    PlatformSessionRow, WorkspaceRow,
};
use jt_capability::{Capability, StoredStatus};
use jt_ledger::LedgerEntry;
use jt_tenancy::{Email, MembershipStatus, WorkspaceId, WorkspaceStatus};
use jt_tenancy::{OperatorId, UserId};
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, MemTx, exists, unique};

/// A platform-wide bundle.
pub(super) struct MemPlatform {
    pub(super) tx: MemTx,
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
    async fn lock_all(&mut self) -> Result<Vec<OperatorRow>, AppError> {
        self.tx.lock_studio().await;
        Ok(self.state().operators.clone())
    }
    async fn set_password(&mut self, id: OperatorId, password_hash: &str) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        if !self.state().operators.iter().any(|o| o.id == id) {
            return Err(AppError::not_found("operator"));
        }
        let hash = password_hash.to_owned();
        self.tx.write(move |s| {
            if let Some(o) = s.operators.iter_mut().find(|o| o.id == id) {
                o.password_hash = hash.clone();
            }
        });
        Ok(())
    }
    async fn count(&mut self) -> Result<i64, AppError> {
        Ok(self.state().operators.len() as i64)
    }

    async fn insert(&mut self, row: OperatorRow) -> Result<(), AppError> {
        self.tx.lock_studio().await;
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
        self.tx.lock_studio().await;
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
    async fn revoke_all(&mut self, operator: OperatorId) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.tx
            .write(move |s| s.platform_sessions.retain(|x| x.operator_id != operator));
        Ok(())
    }
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
    async fn connector_health_counts(
        &mut self,
    ) -> Result<Vec<jt_app::ports::ops::ConnectorHealthCount>, AppError> {
        let mut out = std::collections::BTreeMap::new();
        for stored in &self.state().capabilities {
            let c = &stored.capability;
            if stored.sealed.is_none() || c.status == StoredStatus::Retired {
                continue;
            }
            let row = out.entry((c.workspace_id, c.kind_key.clone())).or_insert(
                jt_app::ports::ops::ConnectorHealthCount {
                    workspace_id: c.workspace_id,
                    kind_key: c.kind_key.clone(),
                    reconnect_required: 0,
                    expires_before: None,
                },
            );
            row.reconnect_required +=
                u64::from(c.connector_public["reconnect_required"].as_bool() == Some(true));
            if let Some(at) = c.connector_public["access"]["expires_at"]
                .as_str()
                .and_then(|v| {
                    OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339).ok()
                })
            {
                row.expires_before = Some(row.expires_before.map_or(at, |old| old.min(at)));
            }
        }
        Ok(out.into_values().collect())
    }

    async fn workspace_lock(&mut self, ws: WorkspaceId) -> Result<WorkspaceRow, AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.billing_workspace(ws))
    }
    async fn payment_get(
        &mut self,
        ws: WorkspaceId,
        id: PaymentId,
    ) -> Result<Option<PaymentNotification>, AppError> {
        Ok(self.tx.billing_payment(ws, id))
    }
    async fn payments_list(&mut self) -> Result<Vec<PaymentNotification>, AppError> {
        let mut rows = self.tx.work.payments.clone();
        rows.sort_by_key(|p| (p.reported_at, p.id));
        Ok(rows)
    }
    async fn payment_entitlements_latest(&mut self) -> Result<Vec<WorkspaceEntitlement>, AppError> {
        let mut latest: std::collections::BTreeMap<_, WorkspaceEntitlement> =
            std::collections::BTreeMap::new();
        for row in &self.tx.work.entitlements {
            let Some(payment) = row.payment_id else {
                continue;
            };
            let key = (row.workspace_id, payment);
            if latest
                .get(&key)
                .is_none_or(|old| (row.confirmed_at, row.id) > (old.confirmed_at, old.id))
            {
                latest.insert(key, row.clone());
            }
        }
        Ok(latest.into_values().collect())
    }
    async fn entitlement_get(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<WorkspaceEntitlement>, AppError> {
        Ok(self.tx.billing_grant(ws))
    }
    async fn entitlement_insert(&mut self, row: WorkspaceEntitlement) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.entitlement_insert(row))
    }
    async fn entitlement_revoke(
        &mut self,
        ws: WorkspaceId,
        id: EntitlementId,
        at: OffsetDateTime,
        reason: &str,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.entitlement_revoke(ws, id, at, reason))
    }
    async fn activation_code_insert(
        &mut self,
        ws: WorkspaceId,
        row: ActivationCodeRow,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_insert(ws, row))
    }
    async fn activation_code_digest_exists(
        &mut self,
        ws: WorkspaceId,
        digest: &[u8],
    ) -> Result<bool, AppError> {
        self.tx.lock_studio().await;
        Ok(self
            .state()
            .activation_codes
            .iter()
            .any(|c| c.workspace_id == ws && c.digest == digest))
    }
    async fn activation_code_lock_current_by_workspace(
        &mut self,
        ws: WorkspaceId,
    ) -> Result<Option<ActivationCodeRow>, AppError> {
        self.tx.lock_studio().await;
        self.call(|t| {
            t.tx.billing_workspace(ws)?;
            Ok(t.tx.billing_code(ws))
        })
    }
    async fn activation_code_record_failed_attempt(
        &mut self,
        ws: WorkspaceId,
        id: ActivationCodeId,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_fail(ws, id))
    }
    async fn activation_code_invalidate_current(
        &mut self,
        ws: WorkspaceId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_invalidate(ws, at))
    }
    async fn activation_code_consume(
        &mut self,
        ws: WorkspaceId,
        id: ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_consume(ws, id, at, by))
    }

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
        reason: &str,
        by: &jt_ledger::Actor,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.billing_status(ws, status, reason, by))
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

    async fn capability_by_external(
        &mut self,
        kind_keys: &[&str],
        external_id: &str,
    ) -> Result<Option<Capability>, AppError> {
        let state = self.state();
        Ok(state
            .capabilities
            .iter()
            .filter(|s| {
                let c = &s.capability;
                matches!(c.status, StoredStatus::Verified | StoredStatus::Unreachable)
                    && s.sealed.is_some()
                    && c.last_verified_at.is_some()
                    && kind_keys.contains(&c.kind_key.as_str())
                    && c.external_id.as_deref() == Some(external_id)
            })
            .max_by_key(|s| {
                let c = &s.capability;
                (c.status == StoredStatus::Verified, c.created_at, c.id)
            })
            .map(|s| state.capability_view(s)))
    }

    async fn capabilities_holding(
        &mut self,
        kind_keys: &[&str],
        external_id: &str,
    ) -> Result<Vec<Capability>, AppError> {
        let state = self.state();
        let mut held: Vec<Capability> = state
            .capabilities
            .iter()
            .filter(|s| {
                let c = &s.capability;
                c.status != StoredStatus::Retired
                    && s.sealed.is_some()
                    && kind_keys.contains(&c.kind_key.as_str())
                    && c.external_id.as_deref() == Some(external_id)
            })
            .map(|s| state.capability_view(s))
            .collect();
        held.sort_by_key(|c| (c.workspace_id, c.id));
        Ok(held)
    }

    async fn workspaces_with_verified(
        &mut self,
        kind_keys: &[&str],
    ) -> Result<Vec<WorkspaceId>, AppError> {
        let ids: BTreeSet<WorkspaceId> = self
            .state()
            .capabilities
            .iter()
            .filter(|s| {
                let c = &s.capability;
                c.status == StoredStatus::Verified
                    && s.sealed.is_some()
                    && kind_keys.contains(&c.kind_key.as_str())
            })
            .map(|s| s.capability.workspace_id)
            .collect();
        Ok(ids.into_iter().collect())
    }

    async fn workspaces_with_live_agent_calls(&mut self) -> Result<Vec<WorkspaceId>, AppError> {
        let ids: BTreeSet<WorkspaceId> = self
            .state()
            .calls
            .sessions
            .iter()
            .filter(|s| s.mode == jt_calls::CallMode::Agent && s.state.is_live())
            .map(|s| s.workspace_id)
            .collect();
        Ok(ids.into_iter().collect())
    }

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.call(|this| this.tx.append_ledger(entry))
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.tx.commit()
    }
}
