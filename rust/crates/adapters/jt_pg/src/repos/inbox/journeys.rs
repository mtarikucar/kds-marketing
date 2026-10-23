use super::{inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::JourneyRepo};
use jt_inbox::{Journey, JourneyEvent, JourneyId, JourneyStatus, PersonId, Transition};
const ROW: &str = "to_jsonb(j) || jsonb_build_object('owner',owner_id)";
#[async_trait]
impl JourneyRepo for PgTenantRepos {
    async fn event_by_key(&mut self, key: &str) -> Result<Option<JourneyEvent>, AppError> {
        one!(sqlx::query_scalar("select to_jsonb(e) || jsonb_build_object('kind',payload) from journey_events e where workspace_id=$1 and idempotency_key=$2")
            .bind(self.workspace_id().as_uuid()).bind(key),self,JourneyEvent)
    }
    async fn assign_owner(
        &mut self,
        id: JourneyId,
        owner: Option<jt_tenancy::UserId>,
    ) -> Result<(), AppError> {
        super::changed(
            sqlx::query("update journeys set owner_id=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid())
                .bind(owner.map(|id| id.as_uuid()))
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "assign journey owner"))?,
        )
    }
    async fn get(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError> {
        one!(
            sqlx::query_scalar(&format!(
                "select {ROW} from journeys j where workspace_id=$1 and id=$2"
            ))
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Journey
        )
    }
    async fn lock(&mut self, id: JourneyId) -> Result<Option<Journey>, AppError> {
        one!(
            sqlx::query_scalar(&format!(
                "select {ROW} from journeys j where workspace_id=$1 and id=$2 for update"
            ))
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Journey
        )
    }
    async fn open_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError> {
        one!(sqlx::query_scalar(&format!("select {ROW} from journeys j where workspace_id=$1 and person_id=$2 and closed_at is null")).bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Journey)
    }
    async fn latest_for(&mut self, person: PersonId) -> Result<Option<Journey>, AppError> {
        one!(sqlx::query_scalar(&format!("select {ROW} from journeys j where workspace_id=$1 and person_id=$2 order by opened_at desc,id desc limit 1")).bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Journey)
    }
    async fn insert(&mut self, row: Journey) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        if row.status != JourneyStatus::New
            || row.closed_at.is_some()
            || row.lost_reason.is_some()
            || row.unreachable_attempts != 0
        {
            return Err(AppError::validation(
                "journey must start in new state",
                serde_json::json!({}),
            ));
        }
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        let mut data = value!(&row);
        data["owner_id"] = value!(row.owner);
        inserted(sqlx::query("insert into journeys select * from jsonb_populate_record(null::journeys,$1) where workspace_id=$2 on conflict do nothing").bind(data).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert journey"))?)
    }
    async fn apply_transition(
        &mut self,
        id: JourneyId,
        transition: Transition,
        event: JourneyEvent,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, event.workspace_id)?;
        if event.journey_id != id {
            return Err(AppError::validation(
                "event names another journey",
                serde_json::json!({}),
            ));
        }
        let current = JourneyRepo::lock(self, id)
            .await?
            .ok_or_else(|| AppError::not_found("no such journey"))?;
        if current.status != transition.from() {
            return Err(AppError::conflict("journey changed before transition"));
        }
        let mut data = value!(&event);
        data["payload"] = value!(&event.kind);
        data["from_status"] = value!(transition.from());
        data["to_status"] = value!(transition.to());
        inserted(sqlx::query("insert into journey_events select * from jsonb_populate_record(null::journey_events,$1) where workspace_id=$2 on conflict do nothing")
            .bind(data).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"append journey event"))?)?;
        let p = transition.patch();
        sqlx::query("update journeys set status=$3,unreachable_attempts=$4,closed_at=$5,lost_reason=$6,updated_at=$7 where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid()).bind(id.as_uuid()).bind(value!(p.status).as_str()).bind(i16::from(p.unreachable_attempts)).bind(p.closed_at).bind(p.lost_reason.as_ref().map(serde_json::to_value).transpose().map_err(|_| AppError::internal("encode loss"))?).bind(p.updated_at)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"apply journey transition"))?;
        Ok(())
    }
    async fn events(&mut self, id: JourneyId) -> Result<Vec<JourneyEvent>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(e) || jsonb_build_object('kind',payload) from journey_events e where workspace_id=$1 and journey_id=$2 order by at,id").bind(self.workspace_id().as_uuid()).bind(id.as_uuid()),self,JourneyEvent)
    }
}
