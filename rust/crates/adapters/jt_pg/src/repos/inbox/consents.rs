use super::{changed, inserted, map_sqlx, reference};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::ConsentRepo};
use jt_inbox::{Consent, ConsentId, PersonId, SyncState};

#[async_trait]
impl ConsentRepo for PgTenantRepos {
    async fn insert(&mut self, row: Consent) -> Result<(), AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        let mut data = value!(row);
        data["workspace_id"] = value!(ws);
        inserted(sqlx::query("insert into consents select * from jsonb_populate_record(null::consents,$1) where workspace_id=$2 on conflict do nothing")
            .bind(data).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert consent"))?)
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<Consent>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(c) from consents c where workspace_id=$1 and person_id=$2 order by at,id")
            .bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Consent)
    }
    async fn pending_sync(&mut self, limit: u32) -> Result<Vec<Consent>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(c) from consents c where workspace_id=$1 and sync_state in ('pending','failed') order by at,id limit $2")
            .bind(self.workspace_id().as_uuid()).bind(i64::from(limit.clamp(1,1000))),self,Consent)
    }
    async fn set_sync(
        &mut self,
        id: ConsentId,
        state: SyncState,
        attempts: u32,
    ) -> Result<(), AppError> {
        changed(
            sqlx::query(
                "update consents set sync_state=$3,attempts=$4 where workspace_id=$1 and id=$2",
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .bind(value!(state).as_str())
            .bind(i64::from(attempts))
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "update consent sync"))?,
        )
    }
}
