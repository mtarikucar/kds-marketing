//! The strategy gate: gated use cases need an active workspace with an approved strategy.

use async_trait::async_trait;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

use crate::catalog::{GateMode, UseCase};
use crate::error::AppError;

/// Answers whether a workspace has an approved strategy.
#[async_trait]
pub trait StrategyGate: Send + Sync {
    async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError>;
}

/// The gate until strategies exist: no workspace has an approved strategy.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoStrategyYet;

#[async_trait]
impl StrategyGate for NoStrategyYet {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(false)
    }
}

/// Lets `uc` run in workspace `ws` (whose status is `ws_status`) or refuses it.
///
/// `Exempt` use cases always pass; the caller must still have been authenticated. A `Gated` use
/// case needs an `Active` workspace (else `WORKSPACE_INACTIVE`, checked first) and an approved
/// strategy (else `STRATEGY_REQUIRED`).
pub async fn check_gate(
    uc: &UseCase,
    ws_status: WorkspaceStatus,
    gate: &dyn StrategyGate,
    ws: WorkspaceId,
) -> Result<(), AppError> {
    if uc.gate == GateMode::Exempt {
        return Ok(());
    }
    if ws_status != WorkspaceStatus::Active {
        return Err(AppError::workspace_inactive(ws_status));
    }
    if !gate.has_approved_strategy(ws).await? {
        return Err(AppError::strategy_required());
    }
    Ok(())
}
