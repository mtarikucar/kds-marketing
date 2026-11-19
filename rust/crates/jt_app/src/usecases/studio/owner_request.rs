//! The owner's request as a post's hypothesis (design 2026-11-19 §4 F2, rule R3).
//!
//! A hypothesis limits what an agent may post by itself. A content a person asked for in person,
//! naming the account it is for, is the owner's decision: it goes out on that account even when no
//! hypothesis of the strategy posts there. Its planned post is attributed to one built-in
//! hypothesis, "Sahibin isteği", so that the chain stays whole (every slot, arm and measurement
//! names a hypothesis of the strategy it was born under) and what such posts earn is measured on
//! its own arms, never mixed into a hypothesis the strategy wrote.
//!
//! The hypothesis has one id per workspace, stable across versions. It is written into the
//! strategy in force the first time a post needs it, carried into every version approved after
//! one that has it, never shown in the strategy's own lists, never offered to the planner or to an
//! agent's own packages, and refused in an agent's delivery. The finished post still waits for the
//! owner's approval where its account asks for one, or for the platform's posting screen.
use crate::{
    error::AppError,
    ports::{TenantRepos, production_projects::ProductionProject},
    usecases::studio::{chain::ORGANIC_KINDS, planner::stable_id},
};
use jt_capability::Capability;
use jt_strategy::{
    ContentTypeShare, Hypothesis, HypothesisCadence, HypothesisId, HypothesisState, LaneKind,
    StrategyVersionId,
};
use jt_studio::PostFormat;
use jt_tenancy::WorkspaceId;
use std::collections::BTreeMap;

/// The content type of a post made for the owner's request.
pub const CONTENT_TYPE: &str = "owner_request";

/// The built-in hypothesis's id in workspace `ws`.
pub fn id(ws: WorkspaceId) -> HypothesisId {
    HypothesisId(stable_id(ws, "strategy.hypothesis:owner_request"))
}

/// Whether `h` is workspace `ws`'s built-in hypothesis.
pub fn is(ws: WorkspaceId, h: HypothesisId) -> bool {
    h == id(ws)
}

/// `list` without the built-in hypothesis: what the strategy itself holds.
pub(crate) fn without(ws: WorkspaceId, list: Vec<Hypothesis>) -> Vec<Hypothesis> {
    list.into_iter().filter(|h| !is(ws, h.id)).collect()
}

/// The built-in hypothesis of workspace `ws`, in `state`: any channel, one organic content type.
pub fn hypothesis(ws: WorkspaceId, state: HypothesisState) -> Hypothesis {
    let mut cadence = BTreeMap::new();
    cadence.insert(
        LaneKind::Organic,
        HypothesisCadence {
            // Above zero so the chain takes it; the planner plans no organic slot of its own
            // (organic posts come from packages only), so the number plans nothing.
            slots_per_week: 1,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: CONTENT_TYPE.into(),
                min_bps: 0,
                max_bps: 10_000,
            }],
        },
    );
    Hypothesis {
        id: id(ws),
        title: "Sahibin isteği".into(),
        segment_key: "owner_request".into(),
        angle: "A post the owner asked for in person, naming the account.".into(),
        channel: "any".into(),
        metric: "engagement".into(),
        prior_confidence: 0.5,
        derived_confidence: None,
        cadence,
        state,
    }
}

/// Writes the built-in hypothesis into version `version` of workspace `ws` when it is not live
/// there: `kept` when `carried` (the version before had it), else `added`.
pub(crate) async fn ensure(
    r: &mut dyn TenantRepos,
    ws: WorkspaceId,
    version: StrategyVersionId,
    carried: bool,
) -> Result<(), AppError> {
    let live = r
        .hypotheses()
        .list(version)
        .await?
        .iter()
        .any(|h| is(ws, h.id) && h.state.is_live());
    if !live {
        let state = if carried {
            HypothesisState::Kept
        } else {
            HypothesisState::Added
        };
        r.hypotheses()
            .upsert(version, hypothesis(ws, state))
            .await?;
    }
    Ok(())
}

/// Whether version `version` of workspace `ws` holds the built-in hypothesis live.
pub(crate) async fn holds(
    r: &mut dyn TenantRepos,
    ws: WorkspaceId,
    version: StrategyVersionId,
) -> Result<bool, AppError> {
    Ok(r
        .hypotheses()
        .list(version)
        .await?
        .iter()
        .any(|h| is(ws, h.id) && h.state.is_live()))
}

/// The one organic kind that takes `format`, when only one does (a TikTok video, a reel, a
/// story): naming the format names the platform.
fn only_kind(format: PostFormat) -> Option<&'static str> {
    let mut kinds = ORGANIC_KINDS
        .iter()
        .copied()
        .filter(|k| jt_studio::supported_formats(k).contains(&format));
    let first = kinds.next()?;
    kinds.next().is_none().then_some(first)
}

/// Whether area `p` is a person's request naming `account` (rule R3): a person opened it in
/// person, and named that account, or, naming no account, a format only that account's platform
/// takes. An area an agent or the system opened names nothing in this sense.
pub(crate) fn names(p: &ProductionProject, account: &Capability) -> bool {
    p.requested_by.is_some()
        && (p.hints.capability_ids.contains(&account.id)
            || (p.hints.capability_ids.is_empty()
                && p.hints
                    .formats
                    .iter()
                    .any(|f| only_kind(*f) == Some(account.kind_key.as_str()))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_hypothesis_is_one_per_workspace_and_valid() {
        let ws = WorkspaceId::new_v7();
        assert_eq!(id(ws), id(ws));
        assert_ne!(id(ws), id(WorkspaceId::new_v7()));
        let h = hypothesis(ws, HypothesisState::Added);
        assert!(h.state.is_live());
        let cadence = &h.cadence[&LaneKind::Organic];
        assert!(cadence.validate().is_ok());
        assert!(cadence.slots_per_week > 0);
    }

    #[test]
    fn only_a_format_one_platform_takes_names_that_platform() {
        assert_eq!(only_kind(PostFormat::TiktokVideo), Some("tiktok"));
        assert_eq!(only_kind(PostFormat::Reel), Some("instagram"));
        assert_eq!(only_kind(PostFormat::FeedPost), None);
    }
}
