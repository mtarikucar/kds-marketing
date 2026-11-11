use super::{PgTenantRepos, decode, encode, map_sqlx, revision};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::ads::{AdCampaign, AdsRepo, CampaignScope},
};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

#[async_trait]
impl AdsRepo for PgTenantRepos {
    async fn get_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError> {
        self.studio_record("ads_campaigns", id).await
    }
    async fn lock_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from ads_campaigns where workspace_id=$1 and id=$2 for update",
        )
        .bind(self.workspace_id().0)
        .bind(id)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock ad campaign"))?;
        row.map(decode).transpose()
    }
    async fn list_campaigns(
        &mut self,
        scope: CampaignScope,
        before: Option<OffsetDateTime>,
    ) -> Result<Vec<AdCampaign>, AppError> {
        let rows: Vec<Value> = match scope {
            CampaignScope::Open => {
                sqlx::query_scalar(
                    "select data from ads_campaigns where workspace_id=$1 and closed_at is null \
                 order by start_at,id limit 200",
                )
                .bind(self.workspace_id().0)
                .fetch_all(self.tx.conn())
                .await
            }
            CampaignScope::Closed => sqlx::query_scalar(
                "select data from ads_campaigns where workspace_id=$1 and closed_at is not null \
                 and ($2::timestamptz is null or closed_at<$2) \
                 order by closed_at desc,id desc limit 51",
            )
            .bind(self.workspace_id().0)
            .bind(before)
            .fetch_all(self.tx.conn())
            .await,
        }
        .map_err(|e| map_sqlx(e, "list ad campaigns"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn list_winding_down(
        &mut self,
        since: OffsetDateTime,
    ) -> Result<Vec<AdCampaign>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from ads_campaigns where workspace_id=$1 and closed_at is not null \
             and data->'built'->>'activated_at' is not null \
             and (closed_at>$2 \
                  or not coalesce((data->'built'->>'provider_paused')::boolean,false)) \
             order by closed_at,id limit 200",
        )
        .bind(self.workspace_id().0)
        .bind(since)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list ad campaigns that wind down"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn save_campaign(
        &mut self,
        mut c: AdCampaign,
        expected: Option<u64>,
        closed_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        if c.workspace_id != self.workspace_id() {
            return Err(AppError::internal("ad campaign workspace mismatch"));
        }
        if c.revision != expected.unwrap_or(0).saturating_add(1) {
            return Err(AppError::conflict("ad campaign revision changed"));
        }
        // Projections of one moment: the document does not carry them.
        c.state = None;
        c.totals = None;
        let count = if let Some(expected) = expected {
            sqlx::query(
                "update ads_campaigns set data=$3,revision=$4,start_at=$5,closed_at=$6 \
                 where workspace_id=$1 and id=$2 and revision=$7",
            )
            .bind(c.workspace_id.0)
            .bind(c.id)
            .bind(encode(&c)?)
            .bind(revision(c.revision)?)
            .bind(c.start_at)
            .bind(closed_at)
            .bind(revision(expected)?)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "update ad campaign"))?
            .rows_affected()
        } else {
            sqlx::query(
                "insert into ads_campaigns(workspace_id,id,revision,data,start_at,closed_at) \
                 values($1,$2,$3,$4,$5,$6) on conflict do nothing",
            )
            .bind(c.workspace_id.0)
            .bind(c.id)
            .bind(revision(c.revision)?)
            .bind(encode(&c)?)
            .bind(c.start_at)
            .bind(closed_at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "insert ad campaign"))?
            .rows_affected()
        };
        if count != 1 {
            return Err(AppError::conflict("ad campaign revision changed"));
        }
        Ok(())
    }
}
