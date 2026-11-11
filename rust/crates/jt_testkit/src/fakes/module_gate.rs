//! A gate for tests about something else than module capability requirements.

use std::sync::Arc;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::gate::StrategyGate;
use jt_tenancy::WorkspaceId;

/// Asks `inner` about the strategy and holds every module ready: for the panel and parity
/// harnesses whose tests are about other rules. The capability lock has its own tests over the
/// database's gate (`jt_pg::PgStrategyGate`), on both transports.
#[derive(Clone)]
pub struct ModulesReadyGate(pub Arc<dyn StrategyGate>);

#[async_trait]
impl StrategyGate for ModulesReadyGate {
    async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError> {
        self.0.has_approved_strategy(ws).await
    }
    async fn missing_capabilities(
        &self,
        _ws: WorkspaceId,
        _module: &str,
    ) -> Result<Vec<String>, AppError> {
        Ok(Vec::new())
    }
}
