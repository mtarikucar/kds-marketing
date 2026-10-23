//! `strategy_hypotheses`: the hypotheses of each strategy version, in order (`position`).
//!
//! A hypothesis id is stable across versions, so rows are keyed by (version, hypothesis). Writes
//! check first that the version is this workspace's, so a foreign version is `NOT_FOUND` before
//! the composite foreign key `(version_id, workspace_id)` would refuse it.

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
    prior_confidence: f32,
    cadence: serde_json::Value,
    derived_confidence: Option<f32>,
    state: String,
}

impl HypothesisRecord {
    fn into_hypothesis(self) -> Result<Hypothesis, AppError> {
        Ok(Hypothesis {
            cadence: serde_json::from_value(self.cadence)
                .map_err(|_| AppError::internal("invalid stored cadence"))?,
            derived_confidence: self.derived_confidence,
            id: HypothesisId(self.hypothesis_id),
            title: self.title,
            segment_key: self.segment_key,
            angle: self.angle,
            channel: self.channel,
            metric: self.metric,
            prior_confidence: self.prior_confidence,
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
         segment_key, angle, channel, metric, prior_confidence, state, position, cadence) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing",
    )
    .bind(version_id.as_uuid())
    .bind(ws.as_uuid())
    .bind(h.id.as_uuid())
    .bind(&h.title)
    .bind(&h.segment_key)
    .bind(&h.angle)
    .bind(&h.channel)
    .bind(&h.metric)
    .bind(h.prior_confidence)
    .bind(h.state.key())
    .bind(position)
    .bind(serde_json::to_value(&h.cadence).map_err(|_| AppError::internal("invalid cadence"))?)
    .execute(conn)
    .await
    .map_err(|e| map_sqlx(e, "insert hypothesis"))?;
    Ok(done.rows_affected() > 0)
}

#[async_trait]
impl HypothesisRepo for PgTenantRepos {
    async fn set_derived_confidence(
        &mut self,
        id: HypothesisId,
        confidence: f32,
        evidence_key: &str,
    ) -> Result<(), AppError> {
        if !(0.0..=1.0).contains(&confidence) || evidence_key.trim().is_empty() {
            return Err(AppError::validation(
                "invalid learning evidence",
                serde_json::json!({}),
            ));
        }
        let ws = self.workspace_id();
        let version: Option<Uuid> = sqlx::query_scalar("select h.version_id from strategy_hypotheses h join strategy_versions v on v.id = h.version_id and v.workspace_id = h.workspace_id where h.workspace_id = $1 and h.hypothesis_id = $2 and v.status <> 'draft' order by v.number desc limit 1")
            .bind(ws.as_uuid()).bind(id.as_uuid()).fetch_optional(self.tx.conn()).await.map_err(|e| map_sqlx(e, "find learning hypothesis"))?;
        let version = version.ok_or_else(|| AppError::not_found("no such executed hypothesis"))?;
        let stored: f32 = sqlx::query_scalar("insert into studio_learning_applications (workspace_id, hypothesis_id, born_version_id, evidence_key, derived_confidence) values ($1, $2, $3, $4, $5) on conflict (workspace_id, hypothesis_id, evidence_key) do update set evidence_key = excluded.evidence_key returning derived_confidence")
            .bind(ws.as_uuid()).bind(id.as_uuid()).bind(version).bind(evidence_key).bind(confidence)
            .fetch_one(self.tx.conn()).await.map_err(|e| map_sqlx(e, "record derived confidence"))?;
        if stored != confidence {
            return Err(AppError::conflict("learning evidence changed"));
        }
        Ok(())
    }
    async fn append_draft_hypothesis(
        &mut self,
        draft_id: StrategyVersionId,
        input: jt_strategy::HypothesisInput,
    ) -> Result<HypothesisId, AppError> {
        use jt_app::ports::StrategyRepo;
        let draft = self
            .lock_draft()
            .await?
            .ok_or_else(|| AppError::conflict("no draft"))?;
        if draft.id != draft_id || input.id.is_some() {
            return Err(AppError::conflict(
                "append requires the current draft and a new hypothesis",
            ));
        }
        if !(0.0..=1.0).contains(&input.prior_confidence) {
            return Err(AppError::validation(
                "prior confidence must be between 0 and 1",
                serde_json::json!({"field":"prior_confidence"}),
            ));
        }
        jt_strategy::parse_hypotheses_strict(&serde_json::json!([input]))
            .map_err(|_| AppError::validation("invalid hypothesis", serde_json::json!({})))?;
        let id = HypothesisId(Uuid::new_v4());
        self.upsert(
            draft_id,
            Hypothesis {
                id,
                title: input.title,
                segment_key: input.segment_key,
                angle: input.angle,
                channel: input.channel,
                metric: input.metric,
                prior_confidence: input.prior_confidence,
                derived_confidence: None,
                cadence: input.cadence,
                state: HypothesisState::Added,
            },
        )
        .await?;
        self.set_submitted(draft_id, None).await?;
        Ok(id)
    }

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
            "select hypothesis_id, title, segment_key, angle, channel, metric, prior_confidence, state, cadence, \
             (select derived_confidence from studio_learning_applications l where l.workspace_id = h.workspace_id \
              and l.hypothesis_id = h.hypothesis_id order by applied_order desc limit 1) as derived_confidence \
             from strategy_hypotheses h where workspace_id = $1 and version_id = $2 \
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
             segment_key, angle, channel, metric, prior_confidence, state, position, cadence) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
             (select coalesce(max(position), -1) + 1 from strategy_hypotheses \
             where workspace_id = $2 and version_id = $1), $11) \
             on conflict (version_id, hypothesis_id) do update set title = excluded.title, \
             segment_key = excluded.segment_key, angle = excluded.angle, \
             channel = excluded.channel, metric = excluded.metric, \
             prior_confidence = excluded.prior_confidence, state = excluded.state, cadence = excluded.cadence",
        )
        .bind(version_id.as_uuid())
        .bind(ws.as_uuid())
        .bind(hypothesis.id.as_uuid())
        .bind(&hypothesis.title)
        .bind(&hypothesis.segment_key)
        .bind(&hypothesis.angle)
        .bind(&hypothesis.channel)
        .bind(&hypothesis.metric)
        .bind(hypothesis.prior_confidence)
        .bind(hypothesis.state.key())
        .bind(serde_json::to_value(&hypothesis.cadence).map_err(|_| AppError::internal("invalid cadence"))?)
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
