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
        let mut data = value!(row);
        data["workspace_id"] = value!(ws);
        sqlx::query("insert into suppressions select * from jsonb_populate_record(null::suppressions,$1) where workspace_id=$2 on conflict do nothing")
            .bind(data).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert suppression"))?;
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
        sqlx::query("delete from suppressions where workspace_id=$1 and person_id=$2 and channel=$3 and reason=$4")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()).bind(value!(channel).as_str()).bind(value!(reason).as_str())
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"remove suppression"))?;
        Ok(())
    }
}
