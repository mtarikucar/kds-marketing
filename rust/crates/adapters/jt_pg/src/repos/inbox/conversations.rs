use super::{changed, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{ConversationRepo, MAX_INBOX_PAGE},
};
use jt_capability::CapabilityId;
use jt_inbox::{ConvState, Conversation, ConversationId, Executor, PersonId};
use time::OffsetDateTime;

pub(super) const ROW: &str = "to_jsonb(c) || jsonb_build_object('state', case when state='snoozed' then jsonb_build_object('snoozed',jsonb_build_object('until',snoozed_until)) else to_jsonb(state) end, 'executor',case when executor_kind='agent' then '\"agent\"'::jsonb else jsonb_build_object('human',jsonb_build_object('user_id',executor_user_id)) end)";
fn state_columns(state: &ConvState) -> (&'static str, Option<OffsetDateTime>) {
    match state {
        ConvState::Open => ("open", None),
        ConvState::Ours => ("ours", None),
        ConvState::Theirs => ("theirs", None),
        ConvState::Closed => ("closed", None),
        ConvState::Snoozed { until } => ("snoozed", Some(*until)),
    }
}
#[async_trait]
impl ConversationRepo for PgTenantRepos {
    async fn lock_for_person(&mut self, person: PersonId) -> Result<Vec<Conversation>, AppError> {
        many!(sqlx::query_scalar(&format!("select {ROW} from conversations c where workspace_id=$1 and person_id=$2 order by id for update"))
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Conversation)
    }
    async fn get(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError> {
        one!(
            sqlx::query_scalar(&format!(
                "select {ROW} from conversations c where workspace_id=$1 and id=$2"
            ))
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Conversation
        )
    }
    async fn lock(&mut self, id: ConversationId) -> Result<Option<Conversation>, AppError> {
        one!(
            sqlx::query_scalar(&format!(
                "select {ROW} from conversations c where workspace_id=$1 and id=$2 for update"
            ))
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Conversation
        )
    }
    async fn find(
        &mut self,
        person: PersonId,
        capability: CapabilityId,
    ) -> Result<Option<Conversation>, AppError> {
        one!(sqlx::query_scalar(&format!("select {ROW} from conversations c where workspace_id=$1 and person_id=$2 and capability_id=$3")).bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).bind(capability.as_uuid()),self,Conversation)
    }
    async fn upsert_on_inbound(&mut self, row: Conversation) -> Result<Conversation, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        let write_at = super::write_time(self).await?;
        let at = row.last_inbound_at.ok_or_else(|| {
            AppError::validation("inbound time is required", serde_json::json!({}))
        })?;
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        reference(
            self.tx.conn(),
            ws,
            "capabilities",
            row.capability_id.as_uuid(),
        )
        .await?;
        let (kind, user) = match row.executor {
            Executor::Agent => ("agent", None),
            Executor::Human { user_id } => ("human", user_id.map(|u| u.as_uuid())),
        };
        sqlx::query("insert into conversations (id,workspace_id,person_id,capability_id,kind_key,state,executor_kind,executor_user_id,executor_generation,last_inbound_at,last_outbound_at,created_at,updated_at) values ($1,$2,$3,$4,$5,'ours',$6,$7,$8,$9,$10,$11,$11) on conflict (workspace_id,person_id,capability_id) do update set state='ours',snoozed_until=null,last_inbound_at=greatest(conversations.last_inbound_at,excluded.last_inbound_at)")
            .bind(row.id.as_uuid()).bind(ws.as_uuid()).bind(row.person_id.as_uuid()).bind(row.capability_id.as_uuid()).bind(&row.kind_key).bind(kind).bind(user).bind(i64::from(row.executor_generation)).bind(at).bind(row.last_outbound_at).bind(write_at)
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"upsert inbound conversation"))?;
        let stored = ConversationRepo::find(self, row.person_id, row.capability_id)
            .await?
            .ok_or_else(|| AppError::internal("upserted conversation missing"))?;
        super::touch_conversation(self, stored.id).await?;
        ConversationRepo::get(self, stored.id)
            .await?
            .ok_or_else(|| AppError::internal("conversation missing"))
    }
    async fn update_state(
        &mut self,
        id: ConversationId,
        state: ConvState,
        outbound_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        let (state, until) = state_columns(&state);
        changed(sqlx::query("update conversations set state=$3,snoozed_until=$4,last_outbound_at=coalesce($5,last_outbound_at) where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(state).bind(until).bind(outbound_at).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"set conversation state"))?)?;
        super::touch_conversation(self, id).await
    }
    async fn update_executor(
        &mut self,
        id: ConversationId,
        executor: Executor,
    ) -> Result<u32, AppError> {
        let (kind, user) = match executor {
            Executor::Agent => ("agent", None),
            Executor::Human { user_id } => ("human", user_id.map(|u| u.as_uuid())),
        };
        let generation: Option<i64>=sqlx::query_scalar("update conversations set executor_kind=$3,executor_user_id=$4,executor_generation=executor_generation+1 where workspace_id=$1 and id=$2 returning executor_generation")
            .bind(self.workspace_id().as_uuid()).bind(id.as_uuid()).bind(kind).bind(user).fetch_optional(self.tx.conn()).await.map_err(|e| map_sqlx(e,"set conversation executor"))?;
        super::touch_conversation(self, id).await?;
        u32::try_from(generation.ok_or_else(|| AppError::not_found("no such conversation"))?)
            .map_err(|_| AppError::internal("invalid executor generation"))
    }
    async fn list(
        &mut self,
        person: Option<PersonId>,
        limit: u32,
    ) -> Result<Vec<Conversation>, AppError> {
        many!(sqlx::query_scalar(&format!("select {ROW} from conversations c where workspace_id=$1 and ($2::uuid is null or person_id=$2) order by id limit $3"))
            .bind(self.workspace_id().as_uuid()).bind(person.map(|x|x.as_uuid())).bind(i64::from(limit.clamp(1,MAX_INBOX_PAGE))),self,Conversation)
    }
}
