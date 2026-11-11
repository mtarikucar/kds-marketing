//! `jeeta.ads.*`: an agent's side of an ad campaign (design 2026-11-10 section 8). It reads the
//! campaigns, proposes one, takes one that waits for a plan, delivers the plan, changes the ads
//! of a running one and may stop it. Opening, approving, declining, letting go on, ending and
//! changing the budget are a person's, in the panel.
use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{Deps, ads},
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;

macro_rules! tool {
    ($use_case:literal, $schema:literal, $run:ident, $description:literal) => {
        ToolDef {
            use_case: $use_case,
            description: $description,
            permissions: &[Permission::AdsWork],
            schema: || Schema::try_from(ads::schema($schema)).expect("ads schema"),
            run: $run,
        }
    };
}

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        tool!(
            "ads.campaigns_list",
            "campaigns_list",
            campaigns_list,
            "The ad campaigns: scope open (the default; not over, by start time) or closed (ended, declined, expired; newest first, 50 a page with next_before). Each with its goal, budget (a total, minor units), state (proposed, queued, planning, building, in_review, live, paused, rejected, ended, held, expired, declined) and what it spent and brought so far; a number the provider does not give is null. [risk: READ]"
        ),
        tool!(
            "ads.campaign_get",
            "campaign_get",
            campaign_get,
            "One ad campaign: its plan, what was built at the provider (each ad's state and review feedback), the agent's moves with their reasons, the daily numbers per ad and the materials its ads show. [risk: READ]"
        ),
        tool!(
            "ads.campaign_propose",
            "campaign_propose",
            campaign_propose,
            "Propose an ad campaign: a goal, a total budget in minor units of the general ad budget's currency, a start time and why it is worth its budget. It spends nothing until a person approves it, and closes by itself after seven days. One proposal a week. [risk: WRITE]"
        ),
        tool!(
            "ads.campaign_claim",
            "campaign_claim",
            campaign_claim,
            "Take an ad campaign that waits for an agent (state queued or rejected, its start time come). Returns the campaign and a claim_token for jeeta.ads.plan_submit; the claim lasts 30 minutes. One live claim per campaign. [risk: WRITE]"
        ),
        tool!(
            "ads.campaign_release",
            "campaign_release",
            campaign_release,
            "Let a claimed ad campaign go, for another agent to take. [risk: WRITE]"
        ),
        tool!(
            "ads.plan_submit",
            "plan_submit",
            plan_submit,
            "Deliver the plan of the claimed ad campaign: the ad account, the result (link_click with a website, or lead_form with a form), the audience, the placements, the end time and one to six ads (one image material each, texts, a call to action, the Facebook Page). Jeeta checks it whole, holds the campaign's whole budget against every limit and builds the campaign at the provider itself, paused first, with the budget as the provider's own total. A plan that breaks a rule is refused with every finding (plan_refused); after three in a row the campaign waits for a person. [risk: SPEND]"
        ),
        tool!(
            "ads.campaign_move",
            "campaign_move",
            campaign_move,
            "Change a built ad campaign's ads, with why: pause_ad, resume_ad, add_ad (six at most), fix_ad (replace the ad the provider turned down) or none (looked, changed nothing). A new ad is checked as a plan's ad is. The budget and the end date are a person's to change. [risk: WRITE]"
        ),
        tool!(
            "ads.campaign_pause",
            "campaign_pause",
            campaign_pause,
            "Stop an ad campaign, with why: it is paused at the provider at once. Only a person lets it go on. [risk: WRITE]"
        ),
        tool!(
            "ads.ad_preview",
            "ad_preview",
            ad_preview,
            "How the provider shows one ad of a built campaign in a placement (facebook_feed, instagram_feed, instagram_story, instagram_reels): the provider's own short-lived preview frame as html. [risk: READ]"
        ),
    ]
}
fn campaigns_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaigns_list(d, c, args(v)?).await?) })
}
fn campaign_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_get(d, c, args(v)?).await?) })
}
fn campaign_propose<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_propose(d, c, args(v)?).await?) })
}
fn campaign_claim<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_claim(d, c, args(v)?).await?) })
}
fn campaign_release<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_release(d, c, args(v)?).await?) })
}
fn plan_submit<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::plan_submit(d, c, args(v)?).await?) })
}
fn campaign_move<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_move(d, c, args(v)?).await?) })
}
fn campaign_pause<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::campaign_pause(d, c, args(v)?).await?) })
}
fn ad_preview<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&ads::ad_preview(d, c, args(v)?).await?) })
}
