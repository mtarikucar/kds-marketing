//! The strategy gate, answered from `strategy_versions`, and the module capability gate,
//! answered from `capabilities`.

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

    async fn missing_capabilities(
        &self,
        ws: WorkspaceId,
        module: &str,
    ) -> Result<Vec<String>, AppError> {
        let Some(blueprint) = jt_app::usecases::modules::catalog()
            .into_iter()
            .find(|b| b.id == module)
        else {
            return Ok(Vec::new());
        };
        if blueprint.requirements.is_empty() {
            return Ok(Vec::new());
        }
        let mut tx = TenantTx::begin(&self.pool, ws)
            .await
            .map_err(|e| map_sqlx(e, "begin tenant transaction"))?;
        let rows: Vec<(String, String)> =
            sqlx::query_as("select kind_key, status from capabilities where workspace_id = $1")
                .bind(ws.as_uuid())
                .fetch_all(tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read the capabilities a module needs"))?;
        tx.rollback()
            .await
            .map_err(|e| map_sqlx(e, "end tenant transaction"))?;
        let states: Vec<(&str, jt_capability::StoredStatus)> = rows
            .iter()
            .filter_map(|(kind, status)| {
                jt_capability::StoredStatus::parse(status).map(|s| (kind.as_str(), s))
            })
            .collect();
        Ok(jt_capability::missing_requirements(
            blueprint.requirements.iter().map(String::as_str),
            &states,
        ))
    }

    async fn module_installed(&self, ws: WorkspaceId, module: &str) -> Result<bool, AppError> {
        let mut tx = TenantTx::begin(&self.pool, ws)
            .await
            .map_err(|e| map_sqlx(e, "begin tenant transaction"))?;
        let data: Option<serde_json::Value> =
            sqlx::query_scalar("select data from workspace_modules where workspace_id = $1")
                .bind(ws.as_uuid())
                .fetch_optional(tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read the module registry"))?;
        tx.rollback()
            .await
            .map_err(|e| map_sqlx(e, "end tenant transaction"))?;
        jt_app::usecases::modules::installed_in(data.as_ref(), module)
    }
}
