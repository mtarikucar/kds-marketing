//! Shared billing storage types; secret-bearing rows intentionally have no Serialize impl.
pub use crate::ports::billing::{
    ActivationCodeId, ActivationCodeRow, EntitlementId, EntitlementSource, PaymentId,
    PaymentNotification, WorkspaceEntitlement,
};

/// Shared audit shape for repository status mutation. Adapters supply their transaction time.
pub fn status_entry(
    ws: jt_tenancy::WorkspaceId,
    from: jt_tenancy::WorkspaceStatus,
    to: jt_tenancy::WorkspaceStatus,
    reason: &str,
    by: &jt_ledger::Actor,
    at: time::OffsetDateTime,
) -> Result<jt_ledger::LedgerEntry, crate::error::AppError> {
    let mut entry = jt_ledger::LedgerEntry::new(
        ws,
        by.clone(),
        super::super::action("platform.workspace_status")?,
        serde_json::json!({"from":from.key(),"to":to.key(),"reason":reason,"by":by}),
        at,
    );
    entry.subject = Some(jt_ledger::Subject {
        kind: "workspace".into(),
        id: ws.to_string(),
    });
    Ok(entry)
}

use jt_tenancy::WorkspaceStatus;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

/// Required deployment inputs. There are no business-value defaults.
#[derive(Clone, PartialEq, Eq)]
pub struct BillingConfig {
    pub price_minor: i64,
    pub price_currency: String,
    pub bank_instructions: String,
}
impl std::fmt::Debug for BillingConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BillingConfig").finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportPaymentInput {
    pub reference: String,
    pub amount_minor: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub paid_at: OffsetDateTime,
    pub request_key: String,
}
impl std::fmt::Debug for ReportPaymentInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReportPaymentInput").finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PaymentOut {
    pub id: PaymentId,
    #[serde(with = "time::serde::rfc3339")]
    pub reported_at: OffsetDateTime,
    pub amount_minor: i64,
    pub currency: String,
    #[serde(with = "time::serde::rfc3339")]
    pub paid_at: OffsetDateTime,
    pub confirmed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EntitlementOut {
    pub id: EntitlementId,
    pub source: EntitlementSource,
    pub payment_id: Option<PaymentId>,
    #[serde(with = "time::serde::rfc3339")]
    pub confirmed_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub activated_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub revoked_at: Option<OffsetDateTime>,
}
impl From<WorkspaceEntitlement> for EntitlementOut {
    fn from(r: WorkspaceEntitlement) -> Self {
        Self {
            id: r.id,
            source: r.source,
            payment_id: r.payment_id,
            confirmed_at: r.confirmed_at,
            activated_at: r.activated_at,
            revoked_at: r.revoked_at,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BillingStatusOut {
    pub workspace_status: WorkspaceStatus,
    pub entitlement: Option<EntitlementOut>,
    pub payment: Option<PaymentOut>,
    pub price_minor: i64,
    pub price_currency: String,
    pub bank_instructions: String,
    pub payment_reference: String,
}

/// Secret-bearing panel input; never include the submitted code in diagnostics.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivateInput {
    pub code: String,
}
impl std::fmt::Debug for ActivateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivateInput").finish_non_exhaustive()
    }
}
