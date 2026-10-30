use super::{changed, map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{ConsumptionOutcome, ConsumptionRepo, DEFERRAL_GIVE_UP},
};
use jt_connector::InboundEventId;
use time::OffsetDateTime;
#[async_trait]
impl ConsumptionRepo for PgTenantRepos {
    async fn try_claim(&mut self, consumer: &str, id: InboundEventId) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "inbound_events", id.as_uuid()).await?;
        let done=sqlx::query("insert into event_consumption (workspace_id,consumer,event_id) values ($1,$2,$3) on conflict (workspace_id,consumer,event_id) do update set consumed_at=null,outcome=null where event_consumption.outcome='retry_due' or (event_consumption.outcome='deferred' and excluded.consumer='inbox@2' and exists (select 1 from inbound_events e where e.workspace_id=excluded.workspace_id and e.id=excluded.event_id and e.provider='meta' and e.kind='lead_gen'))").bind(ws.as_uuid()).bind(consumer).bind(id.as_uuid()).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"claim inbound event"))?;
        Ok(done.rows_affected() == 1)
    }
    async fn record(
        &mut self,
        consumer: &str,
        id: InboundEventId,
        outcome: ConsumptionOutcome,
    ) -> Result<(), AppError> {
        // A deferral counts and is due again an hour per deferral later, at most a day
        // (`jt_app::ports::inbox::deferral_due`).
        changed(sqlx::query("update event_consumption set consumed_at=$4,outcome=$5,attempts=attempts+case when $5='deferred' then 1 else 0 end,retry_at=case when $5='deferred' then $4+least(attempts+1,24)*interval '1 hour' else null end where workspace_id=$1 and consumer=$2 and event_id=$3 and outcome is null")
            .bind(self.workspace_id().as_uuid()).bind(consumer).bind(id.as_uuid()).bind(outcome.consumed_at).bind(outcome.outcome)
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"record event consumption"))?)
    }
    async fn release_due_deferrals(
        &mut self,
        consumer: &str,
        now: OffsetDateTime,
    ) -> Result<Vec<InboundEventId>, AppError> {
        let ws = self.workspace_id();
        let abandoned: Vec<uuid::Uuid> = sqlx::query_scalar("update event_consumption c set outcome='abandoned',retry_at=null from inbound_events e where c.workspace_id=$1 and c.consumer=$2 and c.outcome='deferred' and e.workspace_id=c.workspace_id and e.id=c.event_id and e.received_at < $3 returning c.event_id")
            .bind(ws.as_uuid()).bind(consumer).bind(now - DEFERRAL_GIVE_UP)
            .fetch_all(self.tx.conn()).await.map_err(|e| map_sqlx(e,"abandon deferred events"))?;
        sqlx::query("update event_consumption set outcome='retry_due' where workspace_id=$1 and consumer=$2 and outcome='deferred' and (retry_at is null or retry_at <= $3)")
            .bind(ws.as_uuid()).bind(consumer).bind(now)
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"release due deferrals"))?;
        Ok(abandoned.into_iter().map(InboundEventId).collect())
    }
}
