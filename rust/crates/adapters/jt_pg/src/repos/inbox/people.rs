use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{MAX_INBOX_PAGE, PersonRepo},
};
use jt_inbox::{IdentityChannel, Person, PersonId};
use time::OffsetDateTime;

#[async_trait]
impl PersonRepo for PgTenantRepos {
    async fn set_write_time(&mut self, at: OffsetDateTime) -> Result<(), AppError> {
        let at = at
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| AppError::internal("invalid inbox write time"))?;
        sqlx::query("select set_config('app.inbox_write_at',$1,true)")
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "set inbox write time"))?;
        Ok(())
    }
    async fn lock_workspace(&mut self) -> Result<(), AppError> {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended('inbox:' || $1::text, 0))")
            .bind(self.workspace_id().as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "lock inbox workspace"))?;
        Ok(())
    }
    async fn insert(&mut self, person: Person) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, person.workspace_id)?;
        if let Some(id) = person.first_touch.capability_id {
            reference(self.tx.conn(), ws, "capabilities", id.as_uuid()).await?;
        }
        if let Some(id) = person.merged_into {
            reference(self.tx.conn(), ws, "people", id.as_uuid()).await?;
        }
        let mut row = value!(&person);
        row["first_touch_capability_id"] = value!(person.first_touch.capability_id);
        inserted(sqlx::query("insert into people select * from jsonb_populate_record(null::people, $1) where workspace_id = $2 on conflict do nothing")
            .bind(row).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"insert person"))?)
    }
    async fn get(&mut self, id: PersonId) -> Result<Option<Person>, AppError> {
        one!(
            sqlx::query_scalar("select to_jsonb(p) from people p where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id.as_uuid()),
            self,
            Person
        )
    }
    async fn lock(&mut self, id: PersonId) -> Result<Option<Person>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(p) from people p where workspace_id=$1 and id=$2 for update"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid()),
            self,
            Person
        )
    }
    async fn find_by_identity(
        &mut self,
        channel: IdentityChannel,
        normalized: &str,
    ) -> Result<Option<Person>, AppError> {
        one!(sqlx::query_scalar("select to_jsonb(p) from people p join identities i on i.person_id=p.id and i.workspace_id=p.workspace_id where p.workspace_id=$1 and i.channel=$2 and i.value_normalized=$3 and i.active and p.merged_into is null and p.erased_at is null")
            .bind(self.workspace_id().as_uuid()).bind(value!(channel).as_str()).bind(normalized),self,Person)
    }
    async fn search(
        &mut self,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Person>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(p) from people p where workspace_id=$1 and merged_into is null and erased_at is null and (strpos(lower(display_name),lower($2))>0 or strpos(lower(company),lower($2))>0) order by created_at,id limit $3 offset $4")
            .bind(self.workspace_id().as_uuid()).bind(query).bind(i64::from(limit.clamp(1,MAX_INBOX_PAGE))).bind(i64::from(offset)),self,Person)
    }
    async fn mark_merged(
        &mut self,
        id: PersonId,
        target: Option<PersonId>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        if target == Some(id) {
            return Err(AppError::validation(
                "cannot merge a person into itself",
                serde_json::json!({}),
            ));
        }
        if let Some(to) = target {
            reference(self.tx.conn(), ws, "people", to.as_uuid()).await?;
        }
        changed(
            sqlx::query(
                "update people set merged_into=$3,updated_at=greatest(updated_at+interval '1 microsecond',$4) where workspace_id=$1 and id=$2",
            )
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .bind(target.map(|x| x.as_uuid()))
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "merge person"))?,
        )
    }
    async fn set_erased(&mut self, id: PersonId, at: OffsetDateTime) -> Result<(), AppError> {
        changed(
            sqlx::query(
                "update people set erased_at=$3,updated_at=greatest(updated_at+interval '1 microsecond',$3) where workspace_id=$1 and id=$2",
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "erase person"))?,
        )
    }
}
