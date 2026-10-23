use super::{map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{ErasureLog, ErasureRepo},
};
use jt_inbox::{IdentityChannel, PersonId};
#[async_trait]
impl ErasureRepo for PgTenantRepos {
    async fn record(&mut self, row: ErasureLog) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        sqlx::query("insert into erasure_log select * from jsonb_populate_record(null::erasure_log,$1) on conflict do nothing")
            .bind(value!(row)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"record erasure"))?;
        Ok(())
    }
    async fn get(&mut self, person: PersonId) -> Result<Option<ErasureLog>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(e) from erasure_log e where workspace_id=$1 and person_id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(person.as_uuid()),
            self,
            ErasureLog
        )
    }
    async fn remember_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<(), AppError> {
        if value_hash.len() != 64
            || !value_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(AppError::validation(
                "invalid identity hash",
                serde_json::json!({}),
            ));
        }
        sqlx::query("insert into erased_identities(workspace_id,channel,value_hash) values ($1,$2,$3) on conflict do nothing")
            .bind(self.workspace_id().as_uuid()).bind(value!(channel).as_str()).bind(value_hash)
            .execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"remember erased identity"))?;
        Ok(())
    }
    async fn is_erased_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar("select exists(select 1 from erased_identities where workspace_id=$1 and channel=$2 and value_hash=$3)")
            .bind(self.workspace_id().as_uuid()).bind(value!(channel).as_str()).bind(value_hash)
            .fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"check erased identity"))
    }
}
