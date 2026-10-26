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
use jt_tenancy::UserId;
use jt_tenancy::{Email, MembershipStatus, WorkspaceId, WorkspaceStatus};
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

    async fn ledger_append(&mut self, entry: LedgerEntry) -> Result<i64, AppError> {
        self.call(|this| this.tx.append_ledger(entry))
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.tx.commit()
    }
}
