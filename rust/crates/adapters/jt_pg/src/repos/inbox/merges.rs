use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::*};
use jt_inbox::*;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;
#[async_trait]
impl MergeRepo for PgTenantRepos {
    async fn list_all(&mut self) -> Result<Vec<MergeRow>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(m) from merges m where workspace_id=$1 order by at,id"
            )
            .bind(self.workspace_id().as_uuid()),
            self,
            MergeRow
        )
    }
    async fn save(&mut self, row: MergeRow) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), row.workspace_id)?;
        changed(sqlx::query("update merges set source_id=$3,target_id=$4,status=$5,moved_snapshot=$6,at=$7,applied_by=$8 where workspace_id=$1 and id=$2")
            .bind(self.workspace_id().as_uuid()).bind(row.id.as_uuid()).bind(row.source_id.as_uuid()).bind(row.target_id.as_uuid()).bind(row.status).bind(row.moved_snapshot).bind(row.at).bind(row.applied_by.map(|u|u.as_uuid())).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"save merge"))?)
    }
    async fn snapshot(&mut self, a: PersonId, b: PersonId) -> Result<MergeSnapshot, AppError> {
        let ws = self.workspace_id().as_uuid();
        let people = vec![a.as_uuid(), b.as_uuid()];
        let conversations:Vec<Conversation>=many!(sqlx::query_scalar(&format!("select {} from conversations c where workspace_id=$1 and person_id=any($2) order by id for update",super::conversations::ROW)).bind(ws).bind(&people),self,Conversation)?;
        let journeys:Vec<JourneyParent>=many!(sqlx::query_scalar("select to_jsonb(j) from journeys j where workspace_id=$1 and person_id=any($2) order by id for update").bind(ws).bind(&people),self,JourneyParent)?;
        let journey_ids: Vec<Uuid> = journeys.iter().map(|j| j.id.as_uuid()).collect();
        let conversation_ids: Vec<Uuid> = conversations.iter().map(|c| c.id.as_uuid()).collect();
        let latest_write_at:OffsetDateTime=sqlx::query_scalar("select max(updated_at) from (select updated_at from people where workspace_id=$1 and id=any($2) union all select updated_at from journeys where workspace_id=$1 and person_id=any($2) union all select updated_at from conversations where workspace_id=$1 and person_id=any($2)) aggregates").bind(ws).bind(&people).fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge checkpoint"))?;
        Ok(MergeSnapshot {
            latest_write_at,
            people:[a,b], version:1, journeys, conversations,
            identities:many!(sqlx::query_scalar("select to_jsonb(i) from identities i where workspace_id=$1 and person_id=any($2) order by id for update").bind(ws).bind(&people),self,IdentityParent)?,
            messages:many!(sqlx::query_scalar("select to_jsonb(m) from messages m where workspace_id=$1 and conversation_id=any($2) order by at,id for update").bind(ws).bind(&conversation_ids),self,MessageParent)?,
            tasks:many!(sqlx::query_scalar("select to_jsonb(t) from tasks t where workspace_id=$1 and journey_id=any($2) order by id for update").bind(ws).bind(&journey_ids),self,TaskParent)?,
            notes:many!(sqlx::query_scalar("select to_jsonb(n) from notes n where workspace_id=$1 and journey_id=any($2) order by id for update").bind(ws).bind(&journey_ids),self,NoteParent)?,
            outbox:many!(sqlx::query_scalar("select to_jsonb(o) from outbox o where workspace_id=$1 and conversation_id=any($2) order by id for update").bind(ws).bind(&conversation_ids),self,OutboxParent)?,
        })
    }
    async fn edited_since(
        &mut self,
        person: PersonId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar("select exists(select 1 from people where workspace_id=$1 and id=$2 and updated_at>$3) or exists(select 1 from journeys where workspace_id=$1 and person_id=$2 and updated_at>$3) or exists(select 1 from conversations where workspace_id=$1 and person_id=$2 and updated_at>$3)")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).bind(at).fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge edit guard"))
    }
    async fn apply_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        keep: PersonId,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id().as_uuid();
        let ids: Vec<Uuid> = snapshot.people.iter().map(|p| p.as_uuid()).collect();
        sqlx::query("update identities set person_id=$3 where workspace_id=$1 and person_id=any($2) and active").bind(ws).bind(&ids).bind(keep.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge identities"))?;
        sqlx::query("update journeys set person_id=$3,updated_at=$4 where workspace_id=$1 and person_id=any($2)").bind(ws).bind(&ids).bind(keep.as_uuid()).bind(at).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge journeys"))?;
        let targets = snapshot.conversation_targets();
        clear_external_ids(self, snapshot).await?;
        for m in &snapshot.messages {
            let target = targets[&m.conversation_id];
            // Preserve both messages on a provider-id collision. The snapshot restores the id.
            let collision:bool=sqlx::query_scalar("select exists(select 1 from messages where workspace_id=$1 and conversation_id=$2 and external_id=$3)").bind(ws).bind(target.as_uuid()).bind(&m.external_id).fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge message collision"))?;
            sqlx::query("update messages set conversation_id=$3,external_id=$4 where workspace_id=$1 and id=$2").bind(ws).bind(m.id.as_uuid()).bind(target.as_uuid()).bind(if collision {None} else {m.external_id.clone()}).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge message"))?;
        }
        for o in &snapshot.outbox {
            sqlx::query("update outbox set conversation_id=$3 where workspace_id=$1 and id=$2")
                .bind(ws)
                .bind(o.id)
                .bind(targets[&o.conversation_id].as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "merge outbox"))?;
        }
        for (&id, &target) in &targets {
            if id != target {
                sqlx::query("delete from conversations where workspace_id=$1 and id=$2")
                    .bind(ws)
                    .bind(id.as_uuid())
                    .execute(self.tx.conn())
                    .await
                    .map_err(|e| map_sqlx(e, "coalesce conversation"))?;
            }
        }
        sqlx::query("update conversations set person_id=$3,updated_at=$4 where workspace_id=$1 and person_id=any($2)").bind(ws).bind(&ids).bind(keep.as_uuid()).bind(at).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"merge conversations"))?;
        normalize_people(self, snapshot, at).await
    }
    async fn restore_snapshot(
        &mut self,
        snapshot: &MergeSnapshot,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id().as_uuid();
        // Move existing survivors back before reintroducing the other person/capability rows.
        for c in &snapshot.conversations {
            sqlx::query("update conversations set person_id=$3 where workspace_id=$1 and id=$2")
                .bind(ws)
                .bind(c.id.as_uuid())
                .bind(c.person_id.as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "restore conversation parent"))?;
        }
        for c in &snapshot.conversations {
            restore_conversation(self, c).await?;
        }
        clear_external_ids(self, snapshot).await?;
        for m in &snapshot.messages {
            changed(sqlx::query("update messages set conversation_id=$3,external_id=$4 where workspace_id=$1 and id=$2").bind(ws).bind(m.id.as_uuid()).bind(m.conversation_id.as_uuid()).bind(&m.external_id).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"restore message"))?)?;
        }
        for o in &snapshot.outbox {
            changed(
                sqlx::query("update outbox set conversation_id=$3 where workspace_id=$1 and id=$2")
                    .bind(ws)
                    .bind(o.id)
                    .bind(o.conversation_id.as_uuid())
                    .execute(self.tx.conn())
                    .await
                    .map_err(|e| map_sqlx(e, "restore outbox"))?,
            )?;
        }
        for i in &snapshot.identities {
            changed(
                sqlx::query(
                    "update identities set person_id=$3,active=$4 where workspace_id=$1 and id=$2",
                )
                .bind(ws)
                .bind(i.id.as_uuid())
                .bind(i.person_id.as_uuid())
                .bind(i.active)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "restore identity"))?,
            )?;
        }
        for j in &snapshot.journeys {
            changed(sqlx::query("update journeys set person_id=$3,updated_at=$4 where workspace_id=$1 and id=$2").bind(ws).bind(j.id.as_uuid()).bind(j.person_id.as_uuid()).bind(at).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"restore journey"))?)?;
        }
        for t in &snapshot.tasks {
            changed(
                sqlx::query("update tasks set journey_id=$3 where workspace_id=$1 and id=$2")
                    .bind(ws)
                    .bind(t.id.as_uuid())
                    .bind(t.journey_id.as_uuid())
                    .execute(self.tx.conn())
                    .await
                    .map_err(|e| map_sqlx(e, "restore task"))?,
            )?;
        }
        for n in &snapshot.notes {
            changed(
                sqlx::query("update notes set journey_id=$3 where workspace_id=$1 and id=$2")
                    .bind(ws)
                    .bind(n.id.as_uuid())
                    .bind(n.journey_id.as_uuid())
                    .execute(self.tx.conn())
                    .await
                    .map_err(|e| map_sqlx(e, "restore note"))?,
            )?;
        }
        for c in &snapshot.conversations {
            sqlx::query("update conversations set updated_at=$3 where workspace_id=$1 and id=$2")
                .bind(ws)
                .bind(c.id.as_uuid())
                .bind(at)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "touch restored conversation"))?;
        }
        normalize_people(self, snapshot, at).await
    }
    async fn insert(&mut self, row: MergeRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "people", row.source_id.as_uuid()).await?;
        reference(self.tx.conn(), ws, "people", row.target_id.as_uuid()).await?;
        inserted(sqlx::query("insert into merges select * from jsonb_populate_record(null::merges,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert merge"))?)
    }
    async fn get(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(m) from merges m where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid()),
            self,
            MergeRow
        )
    }
    async fn lock(&mut self, id: MergeId) -> Result<Option<MergeRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(m) from merges m where workspace_id=$1 and id=$2 for update"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            MergeRow
        )
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<MergeRow>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(m) from merges m where workspace_id=$1 and (source_id=$2 or target_id=$2) order by at,id").bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,MergeRow)
    }
    async fn mark_undone(&mut self, id: MergeId, at: OffsetDateTime) -> Result<(), AppError> {
        changed(
            sqlx::query(
                "update merges set status='undone',undone_at=$3 where workspace_id=$1 and id=$2",
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "undo merge"))?,
        )
    }
}

async fn clear_external_ids(
    r: &mut PgTenantRepos,
    snapshot: &MergeSnapshot,
) -> Result<(), AppError> {
    let ids: Vec<Uuid> = snapshot.messages.iter().map(|m| m.id.as_uuid()).collect();
    sqlx::query("update messages set external_id=null where workspace_id=$1 and id=any($2)")
        .bind(r.workspace_id().as_uuid())
        .bind(ids)
        .execute(r.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "clear coalesced message ids"))?;
    Ok(())
}
async fn normalize_people(
    r: &mut PgTenantRepos,
    snapshot: &MergeSnapshot,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    let ids: Vec<Uuid> = snapshot.people.iter().map(|p| p.as_uuid()).collect();
    sqlx::query("update people set updated_at=$3 where workspace_id=$1 and id=any($2)")
        .bind(r.workspace_id().as_uuid())
        .bind(ids)
        .bind(at)
        .execute(r.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "touch merge people"))?;
    Ok(())
}
async fn restore_conversation(r: &mut PgTenantRepos, c: &Conversation) -> Result<(), AppError> {
    let mut data = value!(c);
    let (state, until) = match c.state {
        ConvState::Open => ("open", None),
        ConvState::Ours => ("ours", None),
        ConvState::Theirs => ("theirs", None),
        ConvState::Closed => ("closed", None),
        ConvState::Snoozed { until } => ("snoozed", Some(until)),
    };
    data["state"] = value!(state);
    data["snoozed_until"] = match until {
        Some(v) => value!(
            v.format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| AppError::internal("invalid snooze time"))?
        ),
        None => Value::Null,
    };
    let (kind, user) = match c.executor {
        Executor::Agent => ("agent", None),
        Executor::Human { user_id } => ("human", user_id),
    };
    data["executor_kind"] = value!(kind);
    data["executor_user_id"] = value!(user);
    sqlx::query("insert into conversations select * from jsonb_populate_record(null::conversations,$1) where workspace_id=$2 on conflict(id) do update set person_id=excluded.person_id,state=excluded.state,snoozed_until=excluded.snoozed_until,executor_kind=excluded.executor_kind,executor_user_id=excluded.executor_user_id,executor_generation=excluded.executor_generation,last_inbound_at=excluded.last_inbound_at,last_outbound_at=excluded.last_outbound_at,created_at=excluded.created_at,updated_at=excluded.updated_at where conversations.workspace_id=$2").bind(data).bind(r.workspace_id().as_uuid()).execute(r.tx.conn()).await.map_err(|e|map_sqlx(e,"restore conversation"))?;
    Ok(())
}
