//! `strategy_hypotheses`: the hypotheses of each strategy version, in order (`position`).
//!
//! A hypothesis id is stable across versions, so rows are keyed by (version, hypothesis). Writes
//! check first that the version is this workspace's: the foreign key to `strategy_versions`
//! ignores row-level security and would accept another workspace's version.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::HypothesisRepo;
use jt_strategy::{Hypothesis, HypothesisId, HypothesisState, StrategyVersionId};
use jt_tenancy::WorkspaceId;
use sqlx::PgConnection;
use uuid::Uuid;

use super::strategy::ensure_version;
use super::{map_sqlx, stored};
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct HypothesisRecord {
    hypothesis_id: Uuid,
    title: String,
    segment_key: String,
    angle: String,
    channel: String,
    metric: String,
    confidence: f32,
    state: String,
}

impl HypothesisRecord {
    fn into_hypothesis(self) -> Result<Hypothesis, AppError> {
        Ok(Hypothesis {
            id: HypothesisId(self.hypothesis_id),
            title: self.title,
            segment_key: self.segment_key,
            angle: self.angle,
            channel: self.channel,
            metric: self.metric,
            confidence: self.confidence,
            state: stored(
                HypothesisState::parse(&self.state),
                "strategy_hypotheses.state",
            )?,
        })
    }
}

/// Inserts `h` at `position` in the version's list; `false` when the version already has a
/// hypothesis with that id.
async fn insert_at(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    version_id: StrategyVersionId,
    h: &Hypothesis,
    position: i32,
) -> Result<bool, AppError> {
    let done = sqlx::query(
        "insert into strategy_hypotheses (version_id, workspace_id, hypothesis_id, title, \
         segment_key, angle, channel, metric, confidence, state, position) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing",
    )
    .bind(version_id.as_uuid())
    .bind(ws.as_uuid())
    .bind(h.id.as_uuid())
    .bind(&h.title)
    .bind(&h.segment_key)
    .bind(&h.angle)
    .bind(&h.channel)
    .bind(&h.metric)
    .bind(h.confidence)
    .bind(h.state.key())
    .bind(position)
    .execute(conn)
    .await
    .map_err(|e| map_sqlx(e, "insert hypothesis"))?;
    Ok(done.rows_affected() > 0)
}

#[async_trait]
impl HypothesisRepo for PgTenantRepos {
    async fn replace_all(
        &mut self,
        version_id: StrategyVersionId,
        hypotheses: Vec<Hypothesis>,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        ensure_version(self.tx.conn(), ws, version_id).await?;
        sqlx::query("delete from strategy_hypotheses where workspace_id = $1 and version_id = $2")
            .bind(ws.as_uuid())
            .bind(version_id.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "clear hypotheses"))?;
        for (position, h) in hypotheses.iter().enumerate() {
            let position = i32::try_from(position)
                .map_err(|_| AppError::internal("too many hypotheses to store"))?;
            if !insert_at(self.tx.conn(), ws, version_id, h, position).await? {
                return Err(AppError::conflict(format!(
                    "hypothesis {} is listed twice",
                    h.id
                )));
            }
        }
        Ok(())
    }

    async fn list(&mut self, version_id: StrategyVersionId) -> Result<Vec<Hypothesis>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<HypothesisRecord> = sqlx::query_as(
            "select hypothesis_id, title, segment_key, angle, channel, metric, confidence, state \
             from strategy_hypotheses where workspace_id = $1 and version_id = $2 \
             order by position, hypothesis_id",
        )
        .bind(ws.as_uuid())
        .bind(version_id.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list hypotheses"))?;
        records
            .into_iter()
            .map(HypothesisRecord::into_hypothesis)
            .collect()
    }

    async fn upsert(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis: Hypothesis,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        ensure_version(self.tx.conn(), ws, version_id).await?;
        // A new hypothesis goes after the version's last one; an existing one keeps its place.
        sqlx::query(
            "insert into strategy_hypotheses (version_id, workspace_id, hypothesis_id, title, \
             segment_key, angle, channel, metric, confidence, state, position) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
             (select coalesce(max(position), -1) + 1 from strategy_hypotheses \
             where workspace_id = $2 and version_id = $1)) \
             on conflict (version_id, hypothesis_id) do update set title = excluded.title, \
             segment_key = excluded.segment_key, angle = excluded.angle, \
             channel = excluded.channel, metric = excluded.metric, \
             confidence = excluded.confidence, state = excluded.state",
        )
        .bind(version_id.as_uuid())
        .bind(ws.as_uuid())
        .bind(hypothesis.id.as_uuid())
        .bind(&hypothesis.title)
        .bind(&hypothesis.segment_key)
        .bind(&hypothesis.angle)
        .bind(&hypothesis.channel)
        .bind(&hypothesis.metric)
        .bind(hypothesis.confidence)
        .bind(hypothesis.state.key())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "upsert hypothesis"))?;
        Ok(())
    }

    async fn set_state(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis_id: HypothesisId,
        state: HypothesisState,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update strategy_hypotheses set state = $4 \
             where workspace_id = $1 and version_id = $2 and hypothesis_id = $3",
        )
        .bind(ws.as_uuid())
        .bind(version_id.as_uuid())
        .bind(hypothesis_id.as_uuid())
        .bind(state.key())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set hypothesis state"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such hypothesis"));
        }
        Ok(())
    }
}
