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
            use_case: "content.olay_view",
            description: "Read one olay (olay_id, or genel for the materials bound genel and the contents of no olay) as the owner's content page shows it: the olay; its flow (files, analysed, in_queue, contents, in_production, awaiting_time, awaiting_approval, published, problems); its contents, each production area with its pipeline of eight stages (hazirlik steps 1-3, fikir 4-6, metin 7-8, gorsel 9-10, paket 11-14, onay, yayin, sonuc), each stage's state (done, current, waiting_person, problem, todo) and what the finished ones produced (the reported steps, the package, approvals, publications, results), and unscheduled: the versions of its finished package with no planned post yet, each with the accounts that could take it, or blocked with the reason none can (give each a time with jeeta.social.version_schedule; a blocked one is a problem for the owner); its files with their analysis and the areas that use them; and its needs (\"Eksikler\": the shoot list's requests and the captures agents asked for, each naming the content that asked). contents needs content.work or content.manage and files materials.work: each is null without it. Without materials.work the olay is its identity only (id, kind, title, dates, occasion, status; no place, client, notes or confirmation) and needs lists no shoot list requests. Needs no approved strategy. [risk: READ]",
            permissions: content::views::PAGE_PERMISSIONS,
            schema: || {
                Schema::try_from(content::views::schema("olay_view")).expect("content schema")
            },
            run: olay_view,
        },
        ToolDef {
            use_case: "content.area_claim",
            description: "Take a production area whose start time has come and that no agent is working (a content_area item at check-in), at its expected_revision. Returns the claim_token for progress, release and delivery, once. The claim lasts 30 minutes from your last progress report; while you hold it the area is not in your check-in. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_claim")).expect("content schema"),
            run: area_claim,
        },
        ToolDef {
            use_case: "content.area_progress",
            description: "Say which of the content workflow's 14 steps you are at, with a note the owner sees on the area's page (write it in the workspace's language), and, when the step has one, its result in one line as output (at most 240 characters), shown under the step's stage of the production line: step 1 the goal, 2 the audience, 3 the platform and format (e.g. \"Instagram, Reels\"), 4 the research in a phrase, 5 the idea, 6 the main message, 7 the headline, 8 the text's first line, 10 what you edited, 11 the versions (e.g. \"Instagram Reels, Instagram Story\"), 12 the posting details, 13 the checks' result; at steps 9 and 10 also give material_ids, the materials you chose, in display order (filed, live materials of the workspace). Both are optional: a report without them is kept as before. The area keeps one report per step for the attempt that leads to its next package: a report of a step replaces your earlier report of it and drops the reports of every later step (going back to a step means redoing what follows), so report in order. A person's redo (send back with a note) starts a new attempt with no reports; the delivered package keeps the reports that made it. Each report renews the 30-minute claim and moves the area's revision. [risk: WRITE]",
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
            description: "Deliver the area's platform versions as one package. Every version passes the material check (its materials are the area's, shareable and publishable) and the text check (its text, title and tags name no recorded event, place or client its materials do not come from), or nothing is stored: a refusal (CONFLICT, reason package_refused) lists what holds each version by index; fix that and deliver again with a new request_key. Three refusals in a row hold the area for a person. A malformed request (VALIDATION) is not a refusal. hypothesis_id: on an area a person asked for (requested_by) leave it out, the post is the owner's request; otherwise name a topic of jeeta.strategy.knowledge_get frame.topics. An accepted delivery means every check passed: the area is done and its versions wait for a time; when a person asked for it, the social agent is woken for its time. [risk: WRITE]",
            permissions: &[Permission::ContentWork],
            schema: || Schema::try_from(content::schema("area_deliver")).expect("content schema"),
            run: area_deliver,
        },
    ]
}
fn olay_view<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&content::olay_view(d, c, args(v)?).await?) })
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
