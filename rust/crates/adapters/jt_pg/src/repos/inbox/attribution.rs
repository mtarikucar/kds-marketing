use super::{map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{AttributionRepo, JourneyAttribution},
};
use jt_inbox::JourneyId;
use time::OffsetDateTime;
#[async_trait]
impl AttributionRepo for PgTenantRepos {
    async fn insert_once(&mut self, row: JourneyAttribution) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "journeys", row.journey_id.as_uuid()).await?;
        Ok(sqlx::query("insert into journey_attribution select * from jsonb_populate_record(null::journey_attribution,$1) on conflict(journey_id) do nothing")
            .bind(value!(row)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert attribution"))?.rows_affected()==1)
    }
    async fn by_journey(
        &mut self,
        journey: JourneyId,
    ) -> Result<Option<JourneyAttribution>, AppError> {
        one!(sqlx::query_scalar("select to_jsonb(a) from journey_attribution a where workspace_id=$1 and journey_id=$2")
            .bind(self.workspace_id().as_uuid()).bind(journey.as_uuid()),self,JourneyAttribution)
    }
    async fn by_ad(
        &mut self,
        ad_id: &str,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<JourneyAttribution>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(a) from journey_attribution a where workspace_id=$1 and ad_id=$2 and acquired_at >= $3 and acquired_at < $4 order by acquired_at,journey_id")
            .bind(self.workspace_id().as_uuid()).bind(ad_id).bind(from).bind(to),self,JourneyAttribution)
    }
}
