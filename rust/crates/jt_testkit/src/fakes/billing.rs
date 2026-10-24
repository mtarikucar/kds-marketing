//! Durable billing parity. The fake holds its transaction write lock until commit/drop.
use super::{
    services::FIXED_NOW,
    state::{MemBundle, MemTx, exists, same_workspace, unique},
    tenant::MemTenant,
};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{WorkspaceRow, billing::*},
};
use jt_ledger::Actor;
use jt_tenancy::{UserId, WorkspaceId, WorkspaceStatus};
use time::OffsetDateTime;

impl MemTx {
    pub(super) fn billing_workspace(&self, ws: WorkspaceId) -> Result<WorkspaceRow, AppError> {
        self.work
            .workspace(ws)
            .cloned()
            .ok_or_else(|| AppError::not_found("no such workspace"))
    }
    pub(super) fn billing_status(
        &mut self,
        ws: WorkspaceId,
        status: WorkspaceStatus,
        reason: &str,
        by: &Actor,
    ) -> Result<(), AppError> {
        let row = self.billing_workspace(ws)?;
        if reason.trim().is_empty() {
            return Err(AppError::validation(
                "reason is required",
                serde_json::json!({"field":"reason"}),
            ));
        }
        if row.status == status {
            return Ok(());
        }
        let entry = jt_app::usecases::billing::schema::status_entry(
            ws, row.status, status, reason, by, FIXED_NOW,
        )?;
        self.append_ledger(entry)?;
        self.write(move |s| {
            s.workspaces.iter_mut().find(|w| w.id == ws).unwrap().status = status;
        });
        Ok(())
    }
    pub(super) fn billing_payment(
        &self,
        ws: WorkspaceId,
        id: PaymentId,
    ) -> Option<PaymentNotification> {
        self.work
            .payments
            .iter()
            .find(|p| p.workspace_id == ws && p.id == id)
            .cloned()
    }
    pub(super) fn billing_grant(&self, ws: WorkspaceId) -> Option<WorkspaceEntitlement> {
        self.work
            .entitlements
            .iter()
            .find(|e| e.workspace_id == ws && e.revoked_at.is_none())
            .cloned()
    }
    pub(super) fn billing_code(&self, ws: WorkspaceId) -> Option<ActivationCodeRow> {
        self.work
            .activation_codes
            .iter()
            .filter(|c| c.workspace_id == ws && c.invalidated_at.is_none())
            .max_by_key(|c| (c.created_at, c.id))
            .cloned()
    }
    pub(super) fn payment_insert(&mut self, row: PaymentNotification) -> Result<(), AppError> {
        self.billing_workspace(row.workspace_id)?;
        exists(
            self.work.user(row.reported_by).is_some(),
            "payment_notifications.reported_by",
        )?;
        if row.amount_minor <= 0
            || row.currency.len() != 3
            || !row.currency.bytes().all(|b| b.is_ascii_uppercase())
        {
            return Err(AppError::internal("invalid payment evidence"));
        }
        unique(
            !self.work.payments.iter().any(|p| {
                p.id == row.id
                    || (p.workspace_id == row.workspace_id && p.request_key == row.request_key)
            }),
            "payment already exists",
        )?;
        self.write(move |s| s.payments.push(row.clone()));
        Ok(())
    }
    pub(super) fn entitlement_insert(&mut self, row: WorkspaceEntitlement) -> Result<(), AppError> {
        self.billing_workspace(row.workspace_id)?;
        let provenance = match row.source {
            EntitlementSource::Paid => row.payment_id.is_some() && row.confirmed_by.is_some(),
            EntitlementSource::Grandfathered => {
                row.payment_id.is_none() && row.confirmed_by.is_none()
            }
        };
        if !provenance
            || (!(match (&row.revoked_at, &row.reason) {
                (None, None) => true,
                (Some(_), Some(r)) => !r.trim().is_empty(),
                _ => false,
            }))
            || (row.activated_at.is_none() && row.redeemed_by.is_some())
            || (row.source == EntitlementSource::Paid
                && row.activated_at.is_some()
                && row.redeemed_by.is_none())
        {
            return Err(AppError::internal("invalid entitlement provenance"));
        }
        if let Some(id) = row.payment_id {
            exists(
                self.billing_payment(row.workspace_id, id).is_some(),
                "workspace_entitlements.payment_id",
            )?;
        }
        if let Some(id) = row.confirmed_by {
            exists(
                self.work.operators.iter().any(|o| o.id == id),
                "workspace_entitlements.confirmed_by",
            )?;
        }
        if let Some(id) = row.redeemed_by {
            exists(
                self.work.user(id).is_some(),
                "workspace_entitlements.redeemed_by",
            )?;
        }
        unique(
            !self.work.entitlements.iter().any(|e| {
                e.id == row.id
                    || (e.workspace_id == row.workspace_id
                        && e.revoked_at.is_none()
                        && row.revoked_at.is_none())
            }),
            "grant already exists",
        )?;
        self.write(move |s| s.entitlements.push(row.clone()));
        Ok(())
    }
    pub(super) fn entitlement_revoke(
        &mut self,
        ws: WorkspaceId,
        id: EntitlementId,
        at: OffsetDateTime,
        reason: &str,
    ) -> Result<(), AppError> {
        self.billing_workspace(ws)?;
        if reason.trim().is_empty() {
            return Err(AppError::validation(
                "reason is required",
                serde_json::json!({"field":"reason"}),
            ));
        }
        if !self
            .work
            .entitlements
            .iter()
            .any(|e| e.workspace_id == ws && e.id == id && e.revoked_at.is_none())
        {
            return Err(AppError::conflict("billing row is not open"));
        }
        let reason = reason.to_owned();
        self.write(move |s| {
            let e = s
                .entitlements
                .iter_mut()
                .find(|e| e.workspace_id == ws && e.id == id)
                .unwrap();
            e.revoked_at = Some(at);
            e.reason = Some(reason.clone());
        });
        Ok(())
    }
    fn entitlement_activate(
        &mut self,
        ws: WorkspaceId,
        id: EntitlementId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.billing_workspace(ws)?;
        if !self.work.entitlements.iter().any(|e| {
            e.workspace_id == ws && e.id == id && e.revoked_at.is_none() && e.activated_at.is_none()
        }) {
            return Err(AppError::conflict("billing row is not open"));
        }
        exists(
            self.work.user(by).is_some(),
            "workspace_entitlements.redeemed_by",
        )?;
        self.write(move |s| {
            let e = s
                .entitlements
                .iter_mut()
                .find(|e| e.id == id && e.workspace_id == ws)
                .unwrap();
            e.activated_at = Some(at);
            e.redeemed_by = Some(by);
        });
        Ok(())
    }
    pub(super) fn code_insert(
        &mut self,
        ws: WorkspaceId,
        row: ActivationCodeRow,
    ) -> Result<(), AppError> {
        same_workspace(ws, row.workspace_id)?;
        self.billing_workspace(ws)?;
        if !self.work.entitlements.iter().any(|e| {
            e.workspace_id == ws
                && e.id == row.entitlement_id
                && e.revoked_at.is_none()
                && e.activated_at.is_none()
        }) {
            return Err(AppError::conflict(
                "activation requires an unactivated open grant",
            ));
        }
        exists(
            self.work.operators.iter().any(|o| o.id == row.issued_by),
            "activation_codes.issued_by",
        )?;
        if let Some(id) = row.redeemed_by {
            exists(self.work.user(id).is_some(), "activation_codes.redeemed_by")?;
        }
        if row.action != "billing.activate"
            || row.digest.len() != 32
            || row.expires_at <= row.created_at
            || !(0..=5).contains(&row.attempts)
            || row.consumed_at.is_some() != row.redeemed_by.is_some()
        {
            return Err(AppError::internal("invalid activation challenge"));
        }
        unique(
            !self.work.activation_codes.iter().any(|c| {
                c.id == row.id
                    || (c.workspace_id == ws
                        && c.invalidated_at.is_none()
                        && c.consumed_at.is_none()
                        && row.invalidated_at.is_none()
                        && row.consumed_at.is_none())
            }),
            "challenge already exists",
        )?;
        self.write(move |s| s.activation_codes.push(row.clone()));
        Ok(())
    }
    pub(super) fn code_fail(
        &mut self,
        ws: WorkspaceId,
        id: ActivationCodeId,
    ) -> Result<(), AppError> {
        self.billing_workspace(ws)?;
        if !self.work.activation_codes.iter().any(|c| {
            c.workspace_id == ws
                && c.id == id
                && c.invalidated_at.is_none()
                && c.consumed_at.is_none()
        }) {
            return Err(AppError::conflict("billing row is not open"));
        }
        self.write(move |s| {
            let c = s
                .activation_codes
                .iter_mut()
                .find(|c| c.workspace_id == ws && c.id == id)
                .unwrap();
            c.attempts = (c.attempts + 1).min(5);
        });
        Ok(())
    }
    pub(super) fn code_invalidate(
        &mut self,
        ws: WorkspaceId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.billing_workspace(ws)?;
        self.write(move |s| {
            for c in s
                .activation_codes
                .iter_mut()
                .filter(|c| c.workspace_id == ws && c.invalidated_at.is_none())
            {
                c.invalidated_at = Some(at);
            }
        });
        Ok(())
    }
    pub(super) fn code_consume(
        &mut self,
        ws: WorkspaceId,
        id: ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.billing_workspace(ws)?;
        let c = self
            .work
            .activation_codes
            .iter()
            .find(|c| {
                c.workspace_id == ws
                    && c.id == id
                    && c.invalidated_at.is_none()
                    && c.consumed_at.is_none()
                    && c.attempts < 5
                    && c.expires_at > at
                    && c.created_at <= at
            })
            .ok_or_else(|| AppError::conflict("billing row is not open"))?;
        if !self.work.entitlements.iter().any(|e| {
            e.workspace_id == ws
                && e.id == c.entitlement_id
                && e.revoked_at.is_none()
                && e.activated_at.is_none()
        }) {
            return Err(AppError::conflict("billing row is not open"));
        }
        exists(self.work.user(by).is_some(), "activation_codes.redeemed_by")?;
        self.write(move |s| {
            let c = s
                .activation_codes
                .iter_mut()
                .find(|c| c.workspace_id == ws && c.id == id)
                .unwrap();
            c.consumed_at = Some(at);
            c.redeemed_by = Some(by);
        });
        Ok(())
    }
}
#[async_trait]
impl BillingRepo for MemTenant {
    async fn get_payment(
        &mut self,
        id: PaymentId,
    ) -> Result<Option<PaymentNotification>, AppError> {
        Ok(self.tx.billing_payment(self.ws, id))
    }
    async fn find_request(&mut self, key: &str) -> Result<Option<PaymentNotification>, AppError> {
        Ok(self
            .tx
            .work
            .payments
            .iter()
            .find(|p| p.workspace_id == self.ws && p.request_key == key)
            .cloned())
    }
    async fn insert_payment(&mut self, row: PaymentNotification) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            t.tx.payment_insert(row)
        })
    }
    async fn entitlement(&mut self) -> Result<Option<WorkspaceEntitlement>, AppError> {
        Ok(self.tx.billing_grant(self.ws))
    }
    async fn latest_entitlement(&mut self) -> Result<Option<WorkspaceEntitlement>, AppError> {
        Ok(self
            .tx
            .work
            .entitlements
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .max_by_key(|r| (r.confirmed_at, r.id))
            .cloned())
    }
    async fn latest_payment(&mut self) -> Result<Option<PaymentNotification>, AppError> {
        Ok(self
            .tx
            .work
            .payments
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .max_by_key(|r| (r.reported_at, r.id))
            .cloned())
    }
    async fn payment_confirmed(&mut self, id: PaymentId) -> Result<bool, AppError> {
        self.tx
            .billing_payment(self.ws, id)
            .ok_or_else(|| AppError::not_found("payment"))?;
        Ok(self.tx.work.entitlements.iter().any(|r| {
            r.workspace_id == self.ws
                && r.payment_id == Some(id)
                && r.source == EntitlementSource::Paid
        }))
    }
    async fn activate_entitlement(
        &mut self,
        id: EntitlementId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.entitlement_activate(t.ws, id, at, by))
    }
    async fn reference_get_or_create(&mut self) -> Result<String, AppError> {
        self.tx.lock_studio().await;
        self.call(|t| {
            t.tx.billing_workspace(t.ws)?;
            if let Some((_, r)) =
                t.tx.work
                    .billing_references
                    .iter()
                    .find(|(ws, _)| *ws == t.ws)
            {
                return Ok(r.clone());
            }
            let ws = t.ws;
            loop {
                let r = format!(
                    "JEETA-{}-{:06}",
                    &ws.as_uuid().simple().to_string()[..8].to_uppercase(),
                    rand::random_range(0..1_000_000u32)
                );
                if t.tx.work.billing_references.iter().any(|(_, v)| *v == r) {
                    continue;
                }
                let stored = r.clone();
                t.tx.write(move |s| s.billing_references.push((ws, stored.clone())));
                return Ok(r);
            }
        })
    }
}
#[async_trait]
impl ActivationCodeRepo for MemTenant {
    async fn insert(&mut self, row: ActivationCodeRow) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_insert(t.ws, row))
    }
    async fn lock_current_by_workspace(&mut self) -> Result<Option<ActivationCodeRow>, AppError> {
        self.tx.lock_studio().await;
        self.call(|t| {
            t.tx.billing_workspace(t.ws)?;
            Ok(t.tx.billing_code(t.ws))
        })
    }
    async fn record_failed_attempt(&mut self, id: ActivationCodeId) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_fail(t.ws, id))
    }
    async fn invalidate_current(&mut self, at: OffsetDateTime) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_invalidate(t.ws, at))
    }
    async fn consume(
        &mut self,
        id: ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|t| t.tx.code_consume(t.ws, id, at, by))
    }
}
