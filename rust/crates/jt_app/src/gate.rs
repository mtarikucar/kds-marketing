//! The gate in front of every use case: the workspace-status check, then the strategy gate.

use async_trait::async_trait;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

use crate::catalog::{GateMode, UseCase};
use crate::error::AppError;

/// Answers whether a workspace has an approved strategy.
#[async_trait]
pub trait StrategyGate: Send + Sync {
    async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError>;
}

/// A gate under which no workspace has an approved strategy, for tests over in-memory ports; the
/// binary serves the gate answered from the database (`jt_pg::PgStrategyGate`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoStrategyYet;

#[async_trait]
impl StrategyGate for NoStrategyYet {
    async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
        Ok(false)
    }
}

/// Lets `uc` run in workspace `ws` (whose status is `ws_status`) or refuses it. The caller must
/// already have been authenticated.
///
/// Two independent checks, in this order:
/// 1. Unless `uc` is `status_exempt`, the workspace must be `Active`, else `WORKSPACE_INACTIVE`
///    (`details.status`), whatever the strategy.
/// 2. A `Gated` use case needs an approved strategy, else `STRATEGY_REQUIRED`; `gate` is asked
///    only then.
pub async fn check_gate(
    uc: &UseCase,
    ws_status: WorkspaceStatus,
    gate: &dyn StrategyGate,
    ws: WorkspaceId,
) -> Result<(), AppError> {
    if !uc.status_exempt && ws_status != WorkspaceStatus::Active {
        return Err(AppError::workspace_inactive(ws_status));
    }
    if uc.gate == GateMode::Gated && !gate.has_approved_strategy(ws).await? {
        return Err(AppError::strategy_required());
    }
    Ok(())
}
