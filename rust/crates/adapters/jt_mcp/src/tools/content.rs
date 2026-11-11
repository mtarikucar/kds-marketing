use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{Deps, content},
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "content.area_claim",
            description: "Take a production area whose start time has come and that no agent is working (a content_area item at check-in), at its expected_revision. Returns the claim_token for progress, release and delivery, once. The claim lasts 30 minutes from your last progress report; while you hold it the area is not in your check-in. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_claim")).expect("content schema"),
            run: area_claim,
        },
        ToolDef {
            use_case: "content.area_progress",
            description: "Say which of the content workflow's 14 steps you are at, with a sentence the owner sees on the area's page (write it in the workspace's language). Report as you go; the steps need not all be reported, nor in order. Each report renews the 30-minute claim and moves the area's revision. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_progress")).expect("content schema"),
            run: area_progress,
        },
        ToolDef {
            use_case: "content.area_release",
            description: "Give a claimed area back, saying why: you stop, or you wait for a capture you asked for. It returns to check-in at once, or once the capture is supplied. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_release")).expect("content schema"),
            run: area_release,
        },
        ToolDef {
            use_case: "content.area_deliver",
            description: "Deliver the area's platform versions as one package. Every version passes the material check (its materials are the area's, shareable and publishable) and the text check (its text, title and tags name no recorded event, place or client its materials do not come from), or nothing is stored: a refusal (CONFLICT, reason package_refused) lists what holds each version by index; fix that and deliver again with a new request_key. Three refusals in a row hold the area for a person. A malformed request (VALIDATION) is not a refusal. An accepted delivery means every check passed: the area is done and its versions wait for a time. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_deliver")).expect("content schema"),
            run: area_deliver,
        },
    ]
}
fn area_claim<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&content::area_claim(d, c, args(v)?).await?) })
}
fn area_progress<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&content::area_progress(d, c, args(v)?).await?) })
}
fn area_release<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&content::area_release(d, c, args(v)?).await?) })
}
fn area_deliver<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&content::area_deliver(d, c, args(v)?).await?) })
}
