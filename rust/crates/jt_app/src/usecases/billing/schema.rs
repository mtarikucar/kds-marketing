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
