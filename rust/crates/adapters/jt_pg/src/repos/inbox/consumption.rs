use super::{changed, map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{ConsumptionOutcome, ConsumptionRepo},
};
use jt_connector::InboundEventId;
#[async_trait]
impl ConsumptionRepo for PgTenantRepos {
    async fn try_claim(&mut self, consumer: &str, id: InboundEventId) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "inbound_events", id.as_uuid()).await?;
        let done=sqlx::query("insert into event_consumption (workspace_id,consumer,event_id) values ($1,$2,$3) on conflict (workspace_id,consumer,event_id) do update set consumed_at=null,outcome=null where event_consumption.outcome='deferred' and excluded.consumer='inbox@2' and exists (select 1 from inbound_events e where e.workspace_id=excluded.workspace_id and e.id=excluded.event_id and e.provider='meta' and e.kind='lead_gen')").bind(ws.as_uuid()).bind(consumer).bind(id.as_uuid()).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"claim inbound event"))?;
        Ok(done.rows_affected() == 1)
    }
    async fn record(
        &mut self,
        consumer: &str,
        id: InboundEventId,
        outcome: ConsumptionOutcome,
    ) -> Result<(), AppError> {
        changed(sqlx::query("update event_consumption set consumed_at=$4,outcome=$5 where workspace_id=$1 and consumer=$2 and event_id=$3 and outcome is null")
            .bind(self.workspace_id().as_uuid()).bind(consumer).bind(id.as_uuid()).bind(outcome.consumed_at).bind(outcome.outcome)
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"record event consumption"))?)
    }
}
