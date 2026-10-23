use super::{changed, inserted, map_sqlx, reference, same_workspace};
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::inbox::{CommissionRepo, CommissionRow},
};
use jt_inbox::{CommissionState, JourneyId};
use uuid::Uuid;
#[async_trait]
impl CommissionRepo for PgTenantRepos {
    async fn insert(&mut self, row: CommissionRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, row.workspace_id)?;
        reference(
            self.tx.conn(),
            ws,
            "journeys",
            row.commission.journey_id.as_uuid(),
        )
        .await?;
        if let Some(user) = row.commission.payee {
            user_exists(self, user).await?;
        }
        inserted(sqlx::query("insert into commissions select * from jsonb_populate_record(null::commissions,$1) on conflict do nothing")
            .bind(value!(row)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert commission"))?)
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<CommissionRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(t) from commissions t where workspace_id=$1 and id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(id),
            self,
            CommissionRow
        )
    }
    async fn by_journey(&mut self, journey: JourneyId) -> Result<Option<CommissionRow>, AppError> {
        one!(
            sqlx::query_scalar(
                "select to_jsonb(c) from commissions c where workspace_id=$1 and journey_id=$2"
            )
            .bind(self.workspace_id().as_uuid())
            .bind(journey.as_uuid()),
            self,
            CommissionRow
        )
    }
    async fn list(&mut self) -> Result<Vec<CommissionRow>, AppError> {
        many!(
            sqlx::query_scalar(
                "select to_jsonb(c) from commissions c where workspace_id=$1 order by created_at,id"
            )
            .bind(self.workspace_id().as_uuid()),
            self,
            CommissionRow
        )
    }
    async fn default_rate(&mut self) -> Result<Option<u16>, AppError> {
        let rate: Option<i32> =
            sqlx::query_scalar("select rate_bp from commission_default where workspace_id=$1")
                .bind(self.workspace_id().as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read default rate"))?;
        rate.map(|r| u16::try_from(r).map_err(|_| AppError::internal("invalid commission rate")))
            .transpose()
    }
    async fn set_default_rate(&mut self, rate_bp: u16) -> Result<(), AppError> {
        sqlx::query("insert into commission_default(workspace_id,rate_bp) values ($1,$2) on conflict(workspace_id) do update set rate_bp=excluded.rate_bp")
            .bind(self.workspace_id().as_uuid()).bind(i32::from(rate_bp)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"set default rate"))?;
        Ok(())
    }
    async fn user_rate(&mut self, user: jt_tenancy::UserId) -> Result<Option<u16>, AppError> {
        let rate: Option<i32> = sqlx::query_scalar(
            "select rate_bp from commission_user_rates where workspace_id=$1 and user_id=$2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(user.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read user rate"))?;
        rate.map(|r| u16::try_from(r).map_err(|_| AppError::internal("invalid commission rate")))
            .transpose()
    }
    async fn set_user_rate(
        &mut self,
        user: jt_tenancy::UserId,
        rate_bp: Option<u16>,
    ) -> Result<(), AppError> {
        if let Some(rate) = rate_bp {
            user_exists(self, user).await?;
            sqlx::query("insert into commission_user_rates(workspace_id,user_id,rate_bp) values ($1,$2,$3) on conflict(workspace_id,user_id) do update set rate_bp=excluded.rate_bp")
                .bind(self.workspace_id().as_uuid()).bind(user.as_uuid()).bind(i32::from(rate)).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"set user rate"))?;
        } else {
            sqlx::query("delete from commission_user_rates where workspace_id=$1 and user_id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(user.as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "remove user rate"))?;
        }
        Ok(())
    }
    async fn set_state(&mut self, id: Uuid, state: CommissionState) -> Result<(), AppError> {
        changed(
            sqlx::query("update commissions set state=$3 where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().as_uuid())
                .bind(id)
                .bind(value!(state).as_str())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "set commission state"))?,
        )
    }
}
async fn user_exists(repos: &mut PgTenantRepos, user: jt_tenancy::UserId) -> Result<(), AppError> {
    let exists: bool = sqlx::query_scalar("select exists(select 1 from users where id=$1)")
        .bind(user.as_uuid())
        .fetch_one(repos.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find commission user"))?;
    if exists {
        Ok(())
    } else {
        Err(AppError::not_found("no such user"))
    }
}
