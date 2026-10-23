use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{AppointmentRepo, AppointmentRow},
};
use jt_inbox::{AppointmentState, JourneyId};
use uuid::Uuid;
#[async_trait]
impl AppointmentRepo for PgTenantRepos {
    async fn insert(&mut self, row: AppointmentRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "journeys",
            row.appointment.journey_id.as_uuid(),
        )
        .await?;
        row.appointment
            .validate()
            .map_err(|e| AppError::validation(e.to_string(), serde_json::json!({})))?;
        inserted(sqlx::query("insert into appointments select * from jsonb_populate_record(null::appointments,$1) on conflict do nothing")
            .bind(value!(row)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert appointment"))?)
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<AppointmentRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(t) from appointments t where workspace_id=$1 and id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id),
            self,
            AppointmentRow
        )
    }
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<AppointmentRow>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(t) from appointments t where workspace_id=$1 and journey_id=$2 order by created_at,id")
            .bind(self.workspace_id().as_uuid()).bind(journey.as_uuid()),self,AppointmentRow)
    }
    async fn set_state(&mut self, id: Uuid, state: AppointmentState) -> Result<(), AppError> {
        changed(
            sqlx::query("update appointments set state=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id)
                .bind(value!(state).as_str())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set appointment state"))?,
        )
    }
}
