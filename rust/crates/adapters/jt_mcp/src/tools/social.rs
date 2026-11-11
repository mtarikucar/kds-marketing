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
            description: "Give one platform version of a finished content package its account and time: the post is planned under the posting limits and is ready to go out at once. A refusal names the limit; choose another time or account. [risk: WRITE]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("version_schedule")).expect("social schema"),
            run: version_schedule,
        },
        ToolDef {
            use_case: "social.versions_waiting",
            description: "The platform versions of finished content packages that have no time yet, each with the accounts it could go out on. A version no account can take carries blocked with the reason: no_approved_strategy, no_connected_account, account_paused, its_account_unavailable, format_not_supported, channel_not_in_strategy, or hypothesis_does_not_post (its hypothesis names an organic cadence of no posts: that is a matter for the strategy). [risk: READ]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("versions_waiting")).expect("social schema"),
            run: versions_waiting,
        },
        ToolDef {
            use_case: "social.accounts_list",
            description: "The connected social accounts: name, kind, status, whether a person paused its posting, the latest numbers its platform gave (a number it does not give is null, never zero) and its next planned post. [risk: READ]",
            permissions: &[Permission::SocialWork],
            schema: || Schema::try_from(social::schema("accounts_list")).expect("social schema"),
            run: accounts_list,
        },
        ToolDef {
            use_case: "social.account_get",
            description: "One social account over a period (the last 30 days when left out, at most 366): its numbers day by day, the posts coming on it (state ready, waiting_person with waits_for, or held), the posts that went out with what each reached, and the period's totals. A number the platform does not give is null. [risk: READ]",
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
