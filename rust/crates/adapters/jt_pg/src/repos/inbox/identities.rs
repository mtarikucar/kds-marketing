use super::{inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::inbox::IdentityRepo};
use jt_inbox::{Identity, PersonId};
#[async_trait]
impl IdentityRepo for PgTenantRepos {
    async fn insert(&mut self, row: Identity) -> Result<(), AppError> {
        let person_id = row.person_id;
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(self.tx.conn(), ws, "people", row.person_id.as_uuid()).await?;
        inserted(sqlx::query("insert into identities select * from jsonb_populate_record(null::identities,$1) where workspace_id=$2 on conflict do nothing").bind(value!(row)).bind(ws.as_uuid()).execute(self.tx.conn()).await.map_err(|e| map_sqlx(e,"insert identity"))?)?;
        super::touch_person(self, person_id).await
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<Identity>, AppError> {
        many!(sqlx::query_scalar("select to_jsonb(i) from identities i where workspace_id=$1 and person_id=$2 and active order by first_seen_at,id").bind(self.workspace_id().as_uuid()).bind(person.as_uuid()),self,Identity)
    }
    async fn deactivate_for(&mut self, person: PersonId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "people", person.as_uuid()).await?;
        sqlx::query(
            "update identities set active=false where workspace_id=$1 and person_id=$2 and active",
        )
        .bind(ws.as_uuid())
        .bind(person.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "deactivate identities"))?;
        super::touch_person(self, person).await
    }
    async fn move_to(&mut self, from: PersonId, to: PersonId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        reference(self.tx.conn(), ws, "people", from.as_uuid()).await?;
        reference(self.tx.conn(), ws, "people", to.as_uuid()).await?;
        sqlx::query(
            "update identities set person_id=$3 where workspace_id=$1 and person_id=$2 and active",
        )
        .bind(ws.as_uuid())
        .bind(from.as_uuid())
        .bind(to.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "move identities"))?;
        super::touch_person(self, from).await?;
        super::touch_person(self, to).await
    }
}
