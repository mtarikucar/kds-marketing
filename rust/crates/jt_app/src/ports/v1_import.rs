//! Additive operator-only persistence. Serving bundles and their signatures stay unchanged.
use crate::{error::AppError, ports::TenantRepos};
use async_trait::async_trait;
use jt_inbox::{IdentityChannel, PersonId};
use jt_tenancy::WorkspaceId;
use serde_json::Value;

/// Extended tenant transaction used only by the offline importer.
#[async_trait]
pub trait ImportRepos: TenantRepos {
    /// Resolve all active keys, including merged/erased owners, so none can be stolen.
    async fn identity_owner(
        &mut self,
        channel: IdentityChannel,
        value: &str,
    ) -> Result<Option<PersonId>, AppError>;
    /// Durable lead marker, including duplicates sharing a person.
    async fn imported_lead(&mut self, lead: &str) -> Result<Option<PersonId>, AppError>;
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

/// Opens the extension on an ordinary-role, RLS-scoped tenant transaction.
#[async_trait]
pub trait ImportStore: Send + Sync {
    async fn begin(&self, workspace: WorkspaceId) -> Result<Box<dyn ImportRepos>, AppError>;
}
