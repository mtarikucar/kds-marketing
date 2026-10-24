//! Agent observations and append-only draft suggestions; neither changes arm selection.
use super::{
    planner::{stable_id, validation},
    work::gated,
};
use crate::{
    ctx::Ctx,
    error::AppError,
    usecases::{Deps, ledger_entry},
};
use jt_strategy::{
    HypothesisId, HypothesisInput, StrategyVersion, StrategyVersionId, VersionStatus,
    next_draft_from,
};
use jt_studio::{TrendSignal, TrendSignalId, integer_quotas};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use url::Url;
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrendInput {
    pub hypothesis_id: HypothesisId,
    pub channel: String,
    pub summary: String,
    pub source_url: Option<Url>,
    #[serde(with = "time::serde::rfc3339")]
    pub observed_at: OffsetDateTime,
    pub request_key: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct HypothesisProposalOut {
    pub draft_version_id: StrategyVersionId,
    pub hypothesis_id: HypothesisId,
}
pub async fn trend_record(d: &Deps, ctx: &Ctx, i: TrendInput) -> Result<TrendSignal, AppError> {
    ctx.require(Permission::StudioWork)?;
    if i.request_key.trim().is_empty()
        || i.request_key.len() > 200
        || i.summary.len() > 4000
        || i.observed_at > ctx.now
    {
        return Err(AppError::validation(
            "invalid trend context",
            json!({"field":"trend"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(r.as_mut(), ctx).await?;
    r.studio_control().lock_control().await?;
    let h = r
        .hypotheses()
        .list(frame.id)
        .await?
        .into_iter()
        .find(|h| h.id == i.hypothesis_id && h.state.is_live())
        .ok_or_else(|| AppError::not_found("live hypothesis"))?;
    if !(h.channel == "any" || h.channel == i.channel)
        || !frame
            .sections
            .channels
            .iter()
            .any(|c| c.channel == "any" || c.channel == i.channel)
        || jt_capability::CapabilityKind::parse(&i.channel).is_none()
    {
        return Err(AppError::validation(
            "trend channel not selected",
            json!({"field":"channel"}),
        ));
    }
    let id = TrendSignalId(stable_id(
        ctx.workspace_id,
        &format!("studio.trend:{}", i.request_key),
    ));
    let old = r.studio().get_trend(id).await?;
    let mut source_url = i.source_url;
    if let Some(url) = &mut source_url {
        url.set_query(None);
        url.set_fragment(None);
    }
    let t = TrendSignal {
        id,
        workspace_id: ctx.workspace_id,
        born_version_id: old.as_ref().map_or(frame.id, |t| t.born_version_id),
        hypothesis_id: i.hypothesis_id,
        channel: i.channel,
        summary: i.summary,
        source_url,
        observed_at: i.observed_at,
        actor: ctx.actor.clone(),
    };
    t.validate()
        .map_err(|e| AppError::validation(e.to_string(), json!({"field":"trend"})))?;
    if let Some(old) = old {
        if old != t {
            return Err(AppError::conflict("request key payload mismatch"));
        }
        return Ok(old);
    }
    let out = r.studio().save_trend(t, &i.request_key).await?;
    let mut e = ledger_entry(
        ctx,
        "studio.trend_record",
        "studio_trend",
        id,
        json!({"hypothesis_id":h.id,"born_version_id":frame.id,"channel":out.channel}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(out)
}
pub async fn hypothesis_propose(
    d: &Deps,
    ctx: &Ctx,
    input: HypothesisInput,
) -> Result<HypothesisProposalOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    ctx.require(Permission::TeamManage)?;
    if input.id.is_some() {
        return Err(AppError::validation(
            "proposal must add a new hypothesis",
            json!({"field":"id"}),
        ));
    }
    jt_strategy::parse_hypotheses_strict(&json!([input])).map_err(|e| {
        AppError::validation("invalid hypothesis", json!({"field":"hypothesis","gaps":e}))
    })?;
    for c in input.cadence.values() {
        integer_quotas(c).map_err(validation)?;
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    // Same lock order as strategy editing/approval: draft, frame, control. lock_draft also
    // serializes an absent draft, so the first two concurrent suggestions share its creation.
    let draft = r.strategy().lock_draft().await?;
    let frame = gated(r.as_mut(), ctx).await?;
    let draft = if let Some(v) = draft {
        v
    } else {
        let hypotheses = r.hypotheses().list(frame.id).await?;
        let (sections, hypotheses) = next_draft_from(&frame, &hypotheses);
        let v = StrategyVersion {
            id: StrategyVersionId(d.ids.uuid()),
            workspace_id: ctx.workspace_id,
            number: r.strategy().next_number().await?,
            status: VersionStatus::Draft,
            sections,
            created_at: ctx.now,
            created_by: ctx.actor.clone(),
            submitted_at: None,
            approved_at: None,
            approved_by: None,
            archived_at: None,
        };
        r.strategy().insert(v.clone()).await?;
        for h in hypotheses {
            r.hypotheses().upsert(v.id, h).await?;
        }
        v
    };
    let hypothesis_id = r
        .hypotheses()
        .append_draft_hypothesis(draft.id, input)
        .await?;
    let mut e = ledger_entry(
        ctx,
        "studio.hypothesis_propose",
        "hypothesis",
        hypothesis_id,
        json!({"draft_version_id":draft.id,"executed_version_id":frame.id}),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(HypothesisProposalOut {
        draft_version_id: draft.id,
        hypothesis_id,
    })
}
