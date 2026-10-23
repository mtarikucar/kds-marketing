use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{QuoteRepo, QuoteRow},
};
use jt_inbox::{JourneyId, QuoteState};
use uuid::Uuid;
#[async_trait]
impl QuoteRepo for PgTenantRepos {
    async fn insert(&mut self, row: QuoteRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "journeys",
            row.quote.journey_id.as_uuid(),
        )
        .await?;
        row.quote
            .validate()
            .map_err(|e| AppError::validation(e.to_string(), serde_json::json!({})))?;
        inserted(sqlx::query("insert into quotes select * from jsonb_populate_record(null::quotes,$1) where workspace_id=$2 on conflict do nothing")
            .bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert quote"))?)
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<QuoteRow>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(t) from quotes t where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id),
            self,
            QuoteRow
        )
    }
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<QuoteRow>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(t) from quotes t where workspace_id=$1 and journey_id=$2 order by created_at,id")
            .bind(self.workspace_id().as_uuid()).bind(journey.as_uuid()),self,QuoteRow)
    }
    async fn set_state(&mut self, id: Uuid, state: QuoteState) -> Result<(), AppError> {
        changed(
            sqlx::query("update quotes set state=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id)
                .bind(value!(state).as_str())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set quote state"))?,
        )
    }
}
