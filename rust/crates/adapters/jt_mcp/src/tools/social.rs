use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{Deps, social},
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "social.version_schedule",
            description: "Give one platform version of a finished content package its account and time: the post is planned under the posting limits and is ready to go out at once, or waits for the person versions_waiting names in human_gate (an approval, or TikTok's posting screen). Schedule on any account versions_waiting lists for the version, human gate or not: the post goes out under the hypothesis named there in attribution (the version's own, another of its segment or channel, or the owner's request for a content a person asked for naming the account). A refusal names the limit; choose another time or account. A version the owner cancelled is refused (version_cancelled): leave it. [risk: WRITE]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("version_schedule")).expect("social schema"),
            run: version_schedule,
        },
        ToolDef {
            use_case: "social.versions_waiting",
            description: "The platform versions of finished content packages that have no time yet, each with the accounts it could go out on (accounts) and, per account (choices), human_gate (approval: the owner approves every post there; posting_screen: the owner fills the platform's posting screen for every post, TikTok; absent: it goes out by itself) and attribution (the hypothesis it goes out under: version, segment, channel or owner_request). Every listed account may be scheduled; you need no other rule. A version no account can take carries blocked with the reason, read from the facts now, so it goes when its cause does: material_removed (a material it shows was deleted; only a revision helps), no_approved_strategy, no_connected_account, account_paused, its_account_unavailable, format_not_supported, media_not_accepted (its materials are not what the platform takes, say an image for TikTok), channel_not_in_strategy, or hypothesis_does_not_post (no hypothesis of the strategy posts on the account's channel; the owner fixes it in the strategy). Nothing is yours to do about a blocked version. [risk: READ]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("versions_waiting")).expect("social schema"),
            run: versions_waiting,
        },
        ToolDef {
            use_case: "social.accounts_list",
            description: "The connected social accounts: name, kind, status, whether a person paused its posting, requires_human_approval (true when every post planned on it waits for a person before it goes out: the account's approval policy, or TikTok's posting screen, which a person fills for every TikTok post whatever the policy says; scheduling with jeeta.social.version_schedule is still allowed and is how the post reaches that person), human_gate (approval or posting_screen), stops (what would stop a post there now and what a post there will meet: reconnect, paused, braked, no_approved_strategy, channel_not_in_strategy, no_hypothesis, only_format, posting_screen, approval, lead; blocking says whether it stops posts now), the latest numbers its platform gave (a number it does not give is null, never zero) and its next planned post. [risk: READ]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("accounts_list")).expect("social schema"),
            run: accounts_list,
        },
        ToolDef {
            use_case: "social.account_get",
            description: "One social account over a period (the last 30 days when left out, at most 366): the account as jeeta.social.accounts_list gives it, requires_human_approval (its approval policy) included, its numbers day by day, the posts coming on it (state ready, waiting_person with waits_for, or held), the posts that went out with what each reached, and the period's totals. A number the platform does not give is null. at_platform, when the platform has a scheduler of its own that can be read, lists what that scheduler holds for the account right now (external_id, publish_at, title, known): known false is a post Jeeta does not hold there, left by hand or by a hand-over whose outcome was unknown; Jeeta neither reports it nor takes it back, so tell the owner. [risk: READ]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("account_get")).expect("social schema"),
            run: account_get,
        },
    ]
}
fn accounts_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&social::accounts_list(d, c, args(v)?).await?) })
}
fn account_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&social::account_get(d, c, args(v)?).await?) })
}
fn version_schedule<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&social::version_schedule(d, c, args(v)?).await?) })
}
fn versions_waiting<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&social::versions_waiting(d, c, args(v)?).await?) })
}
