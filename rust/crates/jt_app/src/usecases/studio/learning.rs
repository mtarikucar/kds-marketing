//! Evidence-backed results and separate human/agent judgments.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::LedgerFilter,
    usecases::{Deps, ledger_entry},
};
use jt_strategy::{HypothesisId, LaneKind};
use jt_studio::*;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LearnedQuery {
    pub hypothesis_id: Option<HypothesisId>,
    pub lane: Option<LaneKind>,
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
}
#[derive(Clone, Debug, Serialize)]
pub struct LearnedHypothesis {
    pub prior_version_id: jt_strategy::StrategyVersionId,
    pub hypothesis_id: HypothesisId,
    pub prior_confidence: f32,
    pub derived_confidence: Option<f32>,
    pub evidence_ids: Vec<MeasurementId>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LearnedArm {
    pub arm: Arm,
    pub evidence: Vec<Measurement>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LanePerformance {
    pub lane: LaneKind,
    pub reward: Option<f64>,
    pub evidence_ids: Vec<MeasurementId>,
    pub attribution: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpendVsCap {
    pub cap_version_id: jt_strategy::StrategyVersionId,
    pub period: jt_strategy::Period,
    pub lane: LaneKind,
    pub currency: String,
    pub cap_minor: i64,
    pub observed_minor: Option<i64>,
    pub evidence_ids: Vec<MeasurementId>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LearnedOut {
    pub hypotheses: Vec<LearnedHypothesis>,
    pub arms: Vec<LearnedArm>,
    pub lane_performance: Vec<LanePerformance>,
    pub spend_vs_cap: Vec<SpendVsCap>,
    pub trends: Vec<TrendSignal>,
    pub judgments: Vec<JudgmentOut>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JudgmentInput {
    pub hypothesis_id: HypothesisId,
    pub evidence_ids: Vec<MeasurementId>,
    pub text: String,
    pub request_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JudgmentOut {
    pub id: uuid::Uuid,
    pub hypothesis_id: HypothesisId,
    pub evidence_ids: Vec<MeasurementId>,
    pub text: String,
    pub chains: Vec<Chain>,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}
pub async fn learned(d: &Deps, ctx: &Ctx, q: LearnedQuery) -> Result<LearnedOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    if q.from >= q.until {
        return Err(AppError::validation(
            "invalid result window",
            json!({"field":"until"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = super::work::gated(r.as_mut(), ctx).await?;
    let arms = r.studio().list_arms().await?;
    let rows: Vec<_> = r
        .studio()
        .list_measurements()
        .await?
        .into_iter()
        .filter(|m| {
            m.measured_at >= q.from
                && m.measured_at < q.until
                && q.hypothesis_id.is_none_or(|h| h == m.chain.hypothesis_id)
                && q.lane.is_none_or(|l| {
                    arms.iter()
                        .any(|a| a.id == m.chain.arm_id && a.key.lane == l)
                })
        })
        .collect();
    let rewards = observations(&rows).map_err(|e| AppError::conflict(e.to_string()))?;
    // A filtered report recomputes its posterior from that evidence slice; persisted learning
    // remains cumulative. Never pair an all-time number with an empty filtered evidence list.
    let arms: Vec<_> = arms
        .into_iter()
        .map(|mut a| {
            let values: Vec<_> = rewards.iter().filter(|v| v.chain.arm_id == a.id).collect();
            a.alpha = 1.0 + values.iter().map(|v| v.value).sum::<f64>();
            a.beta = 1.0 + values.iter().map(|v| 1.0 - v.value).sum::<f64>();
            a.weight = a.alpha / (a.alpha + a.beta);
            a
        })
        .collect();
    let mut hypotheses = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut versions = r.strategy().list().await?;
    versions.sort_by_key(|v| std::cmp::Reverse(v.number));
    for v in versions {
        for h in r.hypotheses().list(v.id).await? {
            if !seen.insert(h.id) || q.hypothesis_id.is_some_and(|id| id != h.id) {
                continue;
            }
            let evidence_ids = rows
                .iter()
                .filter(|m| m.chain.hypothesis_id == h.id)
                .map(|m| m.id)
                .collect();
            hypotheses.push(LearnedHypothesis {
                prior_version_id: v.id,
                hypothesis_id: h.id,
                prior_confidence: h.prior_confidence,
                derived_confidence: {
                    let observed: Vec<_> = arms
                        .iter()
                        .filter(|a| {
                            a.key.hypothesis_id == h.id
                                && rewards.iter().any(|v| v.chain.arm_id == a.id)
                        })
                        .collect();
                    if observed.is_empty() {
                        None
                    } else {
                        Some(
                            (observed.iter().map(|a| a.weight).sum::<f64>() / observed.len() as f64)
                                as f32,
                        )
                    }
                },
                evidence_ids,
            });
        }
    }
    let mut lane_performance = Vec::new();
    let mut spend_vs_cap = Vec::new();
    for lane in [LaneKind::Organic, LaneKind::Paid]
        .into_iter()
        .filter(|l| q.lane.is_none_or(|x| x == *l))
    {
        let evidence: Vec<_> = rewards
            .iter()
            .filter(|v| {
                arms.iter()
                    .any(|a| a.id == v.chain.arm_id && a.key.lane == lane)
            })
            .collect();
        lane_performance.push(LanePerformance {
            lane,
            reward: if evidence.is_empty() {
                None
            } else {
                Some(evidence.iter().map(|v| v.value).sum::<f64>() / evidence.len() as f64)
            },
            evidence_ids: evidence
                .iter()
                .flat_map(|v| v.measurement_ids.clone())
                .collect(),
            attribution: None,
        });
        for cap in frame
            .sections
            .budget_frame
            .lanes
            .iter()
            .filter(|c| c.lane == lane)
        {
            let mut latest = std::collections::BTreeMap::new();
            for m in rows.iter().filter(|m| {
                m.binding_id.is_some()
                    && m.currency.as_ref() == Some(&cap.currency)
                    && arms
                        .iter()
                        .any(|a| a.id == m.chain.arm_id && a.key.lane == lane)
            }) {
                let key = (m.binding_id, m.date);
                if latest
                    .get(&key)
                    .is_none_or(|old: &&Measurement| old.evidence_revision < m.evidence_revision)
                {
                    latest.insert(key, m);
                }
            }
            let values: Option<Vec<i64>> = latest
                .values()
                .map(|m| m.raw_metrics.get("spend_minor").copied().flatten())
                .collect();
            let observed = if latest.is_empty() {
                None
            } else {
                values.and_then(|v| v.into_iter().try_fold(0i64, |a, b| a.checked_add(b)))
            };
            spend_vs_cap.push(SpendVsCap {
                cap_version_id: frame.id,
                period: cap.period,
                lane,
                currency: cap.currency.clone(),
                cap_minor: cap.cap_minor,
                observed_minor: observed,
                evidence_ids: latest.values().map(|m| m.id).collect(),
            });
        }
    }
    let trends = r
        .studio()
        .list_trends()
        .await?
        .into_iter()
        .filter(|t| {
            t.observed_at >= q.from
                && t.observed_at < q.until
                && q.hypothesis_id.is_none_or(|h| t.hypothesis_id == h)
                && q.lane.is_none_or(|l| {
                    arms.iter().any(|a| {
                        a.key.hypothesis_id == t.hypothesis_id
                            && a.key.channel == t.channel
                            && a.key.lane == l
                    })
                })
        })
        .collect();
    let mut judgments = Vec::new();
    let mut before = None;
    loop {
        let page = r
            .ledger()
            .list(LedgerFilter {
                action_prefix: Some("studio.judgment_record".into()),
                limit: 500,
                before_id: before,
                actor_kind: None,
                agent_connection_id: None,
            })
            .await?;
        if page.is_empty() {
            break;
        }
        before = page.last().map(|e| e.id);
        for e in page {
            let j: JudgmentOut = serde_json::from_value(e.entry.payload["judgment"].clone())
                .map_err(|_| AppError::internal("invalid stored judgment"))?;
            if j.at >= q.from
                && j.at < q.until
                && q.hypothesis_id.is_none_or(|h| h == j.hypothesis_id)
                && q.lane.is_none_or(|l| {
                    j.chains
                        .iter()
                        .any(|c| arms.iter().any(|a| a.id == c.arm_id && a.key.lane == l))
                })
            {
                judgments.push(j);
            }
        }
    }
    let arms = arms
        .into_iter()
        .filter(|a| {
            q.hypothesis_id.is_none_or(|h| h == a.key.hypothesis_id)
                && q.lane.is_none_or(|l| l == a.key.lane)
        })
        .map(|arm| {
            let evidence = rows
                .iter()
                .filter(|m| m.chain.arm_id == arm.id)
                .cloned()
                .collect();
            LearnedArm { arm, evidence }
        })
        .collect();
    Ok(LearnedOut {
        hypotheses,
        arms,
        lane_performance,
        spend_vs_cap,
        trends,
        judgments,
    })
}
pub async fn judgment_record(
    d: &Deps,
    ctx: &Ctx,
    mut i: JudgmentInput,
) -> Result<JudgmentOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    if i.text.trim().is_empty()
        || i.text.len() > 4000
        || i.evidence_ids.is_empty()
        || i.evidence_ids.len() > 100
        || i.request_key.trim().is_empty()
        || i.request_key.len() > 200
    {
        return Err(AppError::validation(
            "invalid judgment",
            json!({"field":"judgment"}),
        ));
    }
    i.evidence_ids.sort();
    i.evidence_ids.dedup();
    let payload = serde_json::to_value(&i).map_err(|_| AppError::internal("judgment"))?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = super::work::gated(r.as_mut(), ctx).await?;
    r.studio_control().lock_control().await?;
    if let Some(out) = r
        .studio()
        .request_replay("studio.judgment_record", &i.request_key, &payload)
        .await?
    {
        return serde_json::from_value(out).map_err(|_| AppError::internal("judgment receipt"));
    }
    let rows = r.studio().list_measurements().await?;
    let mut chains = Vec::new();
    for id in &i.evidence_ids {
        let m = rows
            .iter()
            .find(|m| m.id == *id && m.chain.hypothesis_id == i.hypothesis_id)
            .ok_or_else(|| AppError::not_found("judgment evidence"))?;
        if !chains.contains(&m.chain) {
            chains.push(m.chain.clone());
        }
    }
    let out = JudgmentOut {
        id: d.ids.uuid(),
        hypothesis_id: i.hypothesis_id,
        evidence_ids: i.evidence_ids,
        text: i.text,
        chains,
        at: ctx.now,
    };
    let mut entry = ledger_entry(
        ctx,
        "studio.judgment_record",
        "hypothesis",
        i.hypothesis_id,
        json!({"judgment":out,"executed_version_id":frame.id}),
    )?;
    entry.strategy_version_id = Some(frame.id.0);
    r.ledger().append(entry).await?;
    r.studio()
        .request_receipt(
            "studio.judgment_record",
            &i.request_key,
            &payload,
            &serde_json::to_value(&out).map_err(|_| AppError::internal("judgment receipt"))?,
        )
        .await?;
    r.commit().await?;
    Ok(out)
}
pub async fn reweight_week(
    d: &Deps,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Result<bool, AppError> {
    let mut r = d.uow.tenant(ws).await?;
    r.strategy().lock_execution_frame().await?;
    super::chain::active(r.as_mut()).await?;
    r.studio_control().lock_control().await?;
    let key = istanbul_week_start(now).to_string();
    let payload = json!({"week":key,"rule":LEARNING_RULE});
    if r.studio()
        .request_replay("studio.reweight", &key, &payload)
        .await?
        .is_some()
    {
        return Ok(false);
    }
    let arms = r.studio().list_arms().await?;
    r.studio()
        .save_arm_weights(
            reweight(&arms, &LearningPolicy::default())
                .map_err(|e| AppError::conflict(e.to_string()))?,
        )
        .await?;
    r.studio()
        .request_receipt("studio.reweight", &key, &payload, &json!(true))
        .await?;
    r.commit().await?;
    Ok(true)
}

pub fn week_start(now: OffsetDateTime) -> OffsetDateTime {
    istanbul_week_start(now)
}
