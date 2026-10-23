use super::{map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::SuppressionRepo};
use jt_inbox::{Channel, PersonId, Suppression, SuppressionReason};
#[async_trait]
impl SuppressionRepo for PgTenantRepos {
    async fn insert(&mut self, row: Suppression) -> Result<(), AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        let mut data = value!(&row);
        data["workspace_id"] = value!(ws);
        let result=sqlx::query("insert into suppressions select * from jsonb_populate_record(null::suppressions,$1) where workspace_id=$2 on conflict do nothing")
            .bind(data).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert suppression"))?;
        if result.rows_affected() > 0 {
            super::touch_person(self, row.person_id).await?;
        }
        Ok(())
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<Suppression>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(s) from suppressions s where workspace_id=$1 and person_id=$2 order by channel,reason")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Suppression)
    }
    async fn remove(
        &mut self,
        person: PersonId,
        channel: Channel,
        reason: SuppressionReason,
    ) -> Result<(), AppError> {
        let result=sqlx::query("delete from suppressions where workspace_id=$1 and person_id=$2 and channel=$3 and reason=$4")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).bind(value!(channel).as_str()).bind(value!(reason).as_str())
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"remove suppression"))?;
        if result.rows_affected() > 0 {
            // A survivor may remove a suppression retained on its merged alias. Advance
            // every current survivor's edit guard so undo cannot ignore that mutation.
            let at = super::write_time(self).await?;
            sqlx::query("with recursive affected as (select id,merged_into from people where workspace_id=$1 and id=$2 union select p.id,p.merged_into from people p join affected a on p.id=a.merged_into where p.workspace_id=$1) update people set updated_at=greatest(updated_at+interval '1 microsecond',$3) where workspace_id=$1 and id in (select id from affected)")
                .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).bind(at)
                .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"touch suppression survivors"))?;
        }
        Ok(())
    }
}
