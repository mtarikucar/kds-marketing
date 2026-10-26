//! Additive operator-only persistence. Serving bundles and their signatures stay unchanged.
use crate::{error::AppError, ports::TenantRepos};
use async_trait::async_trait;
use jt_inbox::{IdentityChannel, PersonId};
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use std::collections::HashMap;

/// Extended tenant transaction used only by the offline importer.
#[async_trait]
pub trait ImportRepos: TenantRepos {
    /// Finish a preview chunk and release its locks before starting the next chunk.
    async fn rollback(self: Box<Self>) -> Result<(), AppError>;
    /// Resolve all active keys, including merged/erased owners, so none can be stolen.
    async fn identity_owner(
        &mut self,
        channel: IdentityChannel,
        value: &str,
    ) -> Result<Option<PersonId>, AppError>;
    /// Load legacy-to-person markers once per run, including coalesced leads.
    async fn imported_leads(&mut self) -> Result<HashMap<String, PersonId>, AppError>;
    /// Revalidate marker candidates by primary key; never scan the workspace per lead.
    async fn imported_lead(
        &mut self,
        lead: &str,
        candidates: &[PersonId],
    ) -> Result<Option<PersonId>, AppError>;
    /// True only for an importer-owned, unchanged aggregate. Locks its complete graph.
    async fn untouched(&mut self, person: PersonId) -> Result<bool, AppError>;
    /// Append provenance and checkpoint after this transaction's import inserts.
    async fn checkpoint(
        &mut self,
        person: PersonId,
        lead: &str,
        provenance: Value,
    ) -> Result<(), AppError>;
    /// Delete only a complete unchanged import aggregate; false means keep it.
    async fn rollback_import(&mut self, person: PersonId) -> Result<bool, AppError>;
}

/// Exclusive operator run; separate from the inbox lock held only inside each chunk.
#[async_trait]
pub trait ImportRunGuard: Send {
    /// Release before reporting success; dropping on error/cancellation must also release.
    async fn release(self: Box<Self>) -> Result<(), AppError>;
}

/// Opens the extension on an ordinary-role, RLS-scoped tenant transaction.
#[async_trait]
pub trait ImportStore: Send + Sync {
    /// Reject overlapping operator runs so their once-loaded marker snapshots stay complete.
    async fn lock_run(&self, workspace: WorkspaceId) -> Result<Box<dyn ImportRunGuard>, AppError>;
    async fn begin(&self, workspace: WorkspaceId) -> Result<Box<dyn ImportRepos>, AppError>;
}
