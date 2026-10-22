//! The strategy gate, answered from `strategy_versions`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::gate::StrategyGate;
use jt_tenancy::WorkspaceId;
use sqlx::PgPool;

use crate::repos::map_sqlx;
use crate::tx::TenantTx;

/// Opens the strategy gate for a workspace while it has a committed approved strategy version.
/// Each question runs in its own short tenant transaction, so it sees only committed approvals.
#[derive(Clone, Debug)]
pub struct PgStrategyGate {
    pool: PgPool,
}

impl PgStrategyGate {
    /// A gate over `pool`, which must connect as a role row-level security binds.
    pub fn new(pool: PgPool) -> PgStrategyGate {
        PgStrategyGate { pool }
    }
}

#[async_trait]
impl StrategyGate for PgStrategyGate {
    async fn has_approved_strategy(&self, ws: WorkspaceId) -> Result<bool, AppError> {
        let mut tx = TenantTx::begin(&self.pool, ws)
            .await
            .map_err(|e| map_sqlx(e, "begin tenant transaction"))?;
        let approved: bool = sqlx::query_scalar(
            "select exists(select 1 from strategy_versions \
             where workspace_id = $1 and status = 'approved')",
        )
        .bind(ws.as_uuid())
        .fetch_one(tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "check for an approved strategy"))?;
        tx.rollback()
            .await
            .map_err(|e| map_sqlx(e, "end tenant transaction"))?;
        Ok(approved)
    }
}
