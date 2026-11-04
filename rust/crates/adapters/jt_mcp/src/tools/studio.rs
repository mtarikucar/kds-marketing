use super::{ToolDef, args, listed, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{
        Deps,
        studio::{control, library, schema, trends, work},
    },
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "studio.overview",
            description: "Read shared five-region Studio overview. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("overview")).expect("studio schema"),
            run: overview,
        },
        ToolDef {
            use_case: "studio.ledger",
            description: "Read tenant-filtered Studio evidence, also after strategy archive. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("ledger")).expect("studio schema"),
            run: ledger,
        },
        ToolDef {
            use_case: "studio.ledger_export",
            description: "Export the same filtered, redacted ledger as formula-safe CSV. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("ledger_export")).expect("studio schema"),
            run: ledger_export,
        },
        ToolDef {
            use_case: "studio.adsets_list",
            description: "Manage externally created ad sets and hard spend caps. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("adsets_list")).expect("studio schema"),
            run: adsets_list,
        },
        ToolDef {
            use_case: "studio.adset_bind",
            description: "Manage externally created ad sets and hard spend caps. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("adset_bind")).expect("studio schema"),
            run: adset_bind,
        },
        ToolDef {
            use_case: "studio.budget_move",
            description: "Manage externally created ad sets and hard spend caps. [risk: SPEND]",
            permission: Permission::StudioManage,
            schema: || Schema::try_from(schema::input("budget_move")).expect("studio schema"),
            run: budget_move,
        },
        ToolDef {
            use_case: "studio.learned",
            description: "Read hypothesis results and evidence, lane performance and spend versus caps. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("learned")).expect("studio schema"),
            run: learned,
        },
        ToolDef {
            use_case: "studio.judgment_record",
            description: "Record an evidence-linked judgment separately from measured results. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("judgment_record")).expect("studio schema"),
            run: judgment_record,
        },
        ToolDef {
            use_case: "studio.file_upload",
            description: "Store validated tenant media with a replay key; needs no approved strategy. A piece shows only materials: add the stored file to the library with jeeta.studio.material_add first. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("file_upload")).expect("studio schema"),
            run: file_upload,
        },
        ToolDef {
            use_case: "studio.piece_submit",
            description: "Submit agent content and revision-bound Ready work atomically. The caption truth check never refuses a submission: its findings come back as material_check (what the texts name that the piece's olays do not back); until fixed by a new piece, or released by an owner or manager in the panel, they hold the publish. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("piece_submit")).expect("studio schema"),
            run: piece_submit,
        },
        ToolDef {
            use_case: "studio.pending",
            description: "Read pending Studio slots, revision consent, budget moves and blockers. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("pending")).expect("studio schema"),
            run: pending,
        },
        ToolDef {
            use_case: "studio.slot_get",
            description: "Read slot content, hypothesis, brand rules, learning and evidence, and the piece's material_check: caption findings (code, matched words), their digest, whether a human released them, and hard findings (never releasable). A failed or uncertain publish attempt carries failure_reason: the error kind, provider and the provider's reason (e.g. \"permanent: x: HTTP 402 CreditsDepleted: ...\"); the outcome itself keeps only the closed category. [risk: READ]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("slot_get")).expect("studio schema"),
            run: slot_get,
        },
        ToolDef {
            use_case: "studio.slot_cancel",
            description: "Cancel a Planned or Ready slot at its expected revision with a reason. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("slot_cancel")).expect("studio schema"),
            run: slot_cancel,
        },
        ToolDef {
            use_case: "studio.trend_record",
            description: "Record agent-observed context; trends never influence M3 selection. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("trend_record")).expect("studio schema"),
            run: trend_record,
        },
        ToolDef {
            use_case: "studio.hypothesis_propose",
            description: "Append one hypothesis to the strategy draft, requiring team.manage as well as studio.work. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || {
                Schema::try_from(schema::input("hypothesis_propose")).expect("studio schema")
            },
            run: hypothesis_propose,
        },
        ToolDef {
            use_case: "studio.brake",
            description: "Engage or release the workspace or lane brake. Flags persist before Meta status calls. Requires studio.manage. [risk: WRITE]",
            permission: Permission::StudioManage,
            schema: || Schema::try_from(schema::input("brake")).expect("studio schema"),
            run: brake,
        },
        ToolDef {
            use_case: "studio.policy_set",
            description: "Set optional lane human consent policy at the expected control revision. [risk: WRITE]",
            permission: Permission::StudioManage,
            schema: || Schema::try_from(schema::input("policy_set")).expect("studio schema"),
            run: policy_set,
        },
        ToolDef {
            use_case: "studio.approve",
            description: "Record revision-bound consent. Only an owner or manager human can approve; agent credentials cannot satisfy human consent. [risk: WRITE]",
            permission: Permission::StudioManage,
            schema: || Schema::try_from(schema::input("approve")).expect("studio schema"),
            run: approve,
        },
    ]
    .into_iter()
    .chain(library_definitions())
    .collect()
}

/// The materials library's tools (spec 2026-11-03 §5.2, §8): none needs an approved strategy.
/// What only a human decides (confirming an olay, a material's share permission, freeing,
/// rebinding or deleting it, the calendar and the policy) has no tool.
fn library_definitions() -> Vec<ToolDef> {
    let def = |use_case: &'static str,
               description: &'static str,
               schema: fn() -> Schema,
               run: crate::registry::ToolRun| ToolDef {
        use_case,
        description,
        permission: Permission::StudioWork,
        schema,
        run,
    };
    vec![
        def(
            "studio.olays_list",
            "List the workspace's olays (the real context of a material: a workshop, an order, \
             a season collection, a special day, a product shoot), newest start first, each with \
             its count of live materials; status filters proposed or confirmed. Only a confirmed \
             olay makes its materials usable, and only an owner or manager confirms one, in the \
             panel. Returns {olays: [{olay, materials}]}. Needs no approved strategy. \
             [risk: READ]",
            || library_schema("olays_list"),
            olays_list,
        ),
        def(
            "studio.olay_get",
            "Read one olay (olay_id) with its materials, each with used_in (the piece revisions, \
             slots and publications that showed it), and its open shoot requests. [risk: READ]",
            || library_schema("olay_get"),
            olay_get,
        ),
        def(
            "studio.olay_create",
            "Create an olay, with request_key (replayed): kind (workshop, order, season, \
             special_day, product_shoot, other), title, starts_on and ends_on (Istanbul dates, \
             less than 366 days apart), place, client {person_id: an inbox person, \
             organization}, notes, and occasion (the calendar key, required exactly for season \
             and special_day). An olay an agent creates is proposed: its materials are not usable \
             until an owner or manager confirms it in the panel. Create one only for an event \
             the owner told you about; never invent one. [risk: WRITE]",
            || library_schema("olay_create"),
            olay_create,
        ),
        def(
            "studio.olay_update",
            "Change an olay at expected_revision (olay_id): the fields given change; null clears \
             place, client or occasion. An agent changes proposed olays only: a confirmed olay \
             is changed by an owner or manager in the panel (FORBIDDEN owner_or_manager_human). \
             [risk: WRITE]",
            || library_schema("olay_update"),
            olay_update,
        ),
        def(
            "studio.materials_list",
            "List the materials, newest first: state live (the default), erased, needs_review or \
             all; olay_id filters. Each names its file_id, origin, binding (olay or genel), \
             freed, share permission, tags and people. needs_review: no share permission, a \
             depicting AI image whose permission an agent set, no quality, or tags no person \
             reviewed. Returns {materials: [...]}. [risk: READ]",
            || library_schema("materials_list"),
            materials_list,
        ),
        def(
            "studio.material_get",
            "Read one material (material_id) with used_in: each piece revision that showed it, \
             its slot and the posts it was published as (posts stay on their provider when a \
             material is deleted). [risk: READ]",
            || library_schema("material_get"),
            material_get,
        ),
        def(
            "studio.material_add",
            "Add a file stored by jeeta.studio.file_upload (file_id) to the library as a \
             material, with request_key (replayed). Name its olay (olay_id) or set genel true; \
             an agent adds no real genel material (a human frees one). origin is {kind: real} or \
             {kind: ai_generated, generator: e.g. codex}, fixed for ever. An AI image requires \
             depicts: which of face, name, child, client_logo, corporate_ref it shows, [] when \
             none. Tags: product_groups, doors, content_types, quality (publishable, needs_crop, \
             unusable); people: the inbox persons it shows. share (shareable, not_shareable, \
             product_only) is a human's decision: leave it out for a real material; set it for \
             an AI image only while its depicts is []. The capture time is read from the file \
             (JPEG EXIF, MP4) or taken from captured_at. Returns {material, olay_suggestions}: \
             the olays whose dates contain its capture day, for a human to choose from; nothing \
             is bound by them. [risk: WRITE]",
            || library_schema("material_add"),
            material_add,
        ),
        def(
            "studio.material_tag",
            "Change a material's tags at expected_revision (material_id): product_groups, doors, \
             content_types, quality (null clears it), depicts, people; each list given replaces \
             the old one. Your edit is a suggestion until a person reviews the tags. You may add \
             depicts flags and people, never remove them (FORBIDDEN human_required). Adding a \
             depicts flag to an AI image whose permission you set clears that permission: a \
             human decides it then. [risk: WRITE]",
            || library_schema("material_tag"),
            material_tag,
        ),
        def(
            "studio.slot_materials",
            "Read what a slot's piece may show at its scheduled time (slot_id): need (the tags \
             its anchor needs, from its hypothesis's segment and content type), candidates best \
             first (material_id, file_id, mime, subject {kind: olay, archive or generic, \
             olay_id}, role anchor or support, matches_need) and refused (material_id, code). \
             Submit the piece with jeeta.studio.piece_submit naming candidates' file ids and one \
             subject they all take, at least one as an anchor; the caption speaks about that \
             subject only. [risk: READ]",
            || library_schema("slot_materials"),
            slot_materials,
        ),
        def(
            "studio.calendar_list",
            "Read a year's calendar (year; this year when left out): the Turkish special days \
             and seasons with their windows, overlaid by the owner's edits. An entry with no \
             window is inactive (the lunar holidays wait for the owner's dates). Also rows (the \
             owner's own entries of that year) and policy (lead_days, reuse_days, recap_days). \
             Only an owner or manager edits the calendar and the policy, in the panel. \
             [risk: READ]",
            || library_schema("calendar_list"),
            calendar_list,
        ),
        def(
            "studio.shoot_list",
            "Read the shoot list (cekim listesi): what Studio needs shot or uploaded. status open \
             (the default), done, dismissed or all; newest week first. Returns {requests: \
             [...]}. [risk: READ]",
            || library_schema("shoot_list"),
            shoot_list,
        ),
        def(
            "studio.shoot_request",
            "Add a request to the shoot list, with request_key (replayed): text (what to shoot \
             or upload, in Turkish, for the owner) and week_start (a Monday; this week when left \
             out). You cannot shoot: the owner reads it. [risk: WRITE]",
            || library_schema("shoot_request"),
            shoot_request,
        ),
        def(
            "studio.shoot_resolve",
            "Mark a shoot request (request_id) done or dismissed. The requests Studio adds by \
             itself close themselves (CONFLICT closes_itself): resolve those you or a person \
             added. [risk: WRITE]",
            || library_schema("shoot_resolve"),
            shoot_resolve,
        ),
    ]
}

fn library_schema(action: &str) -> Schema {
    Schema::try_from(schema::input(action)).expect("studio schema")
}

fn olays_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { listed("olays", &library::olays_list(d, c, args(v)?).await?) })
}
fn olay_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::olay_get(d, c, args(v)?).await?) })
}
fn olay_create<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::olay_create(d, c, args(v)?).await?) })
}
fn olay_update<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::olay_update(d, c, args(v)?).await?) })
}
fn materials_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { listed("materials", &library::materials_list(d, c, args(v)?).await?) })
}
fn material_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::material_get(d, c, args(v)?).await?) })
}
fn material_add<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::material_add(d, c, args(v)?).await?) })
}
fn material_tag<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::material_tag(d, c, args(v)?).await?) })
}
fn slot_materials<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::slot_materials(d, c, args(v)?).await?) })
}
fn calendar_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::calendar_list(d, c, args(v)?).await?) })
}
fn shoot_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { listed("requests", &library::shoot_list(d, c, args(v)?).await?) })
}
fn shoot_request<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::shoot_request(d, c, args(v)?).await?) })
}
fn shoot_resolve<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&library::shoot_resolve(d, c, args(v)?).await?) })
}
fn brake<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&control::brake(d, c, args(v)?).await?) })
}
fn policy_set<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&control::policy_set(d, c, args(v)?).await?) })
}
fn approve<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&control::approve(d, c, args(v)?).await?) })
}

fn pending<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let _: work::EmptyInput = args(v)?;
        to_json(&work::pending(d, c).await?)
    })
}
fn slot_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let i: work::SlotInput = args(v)?;
        to_json(&work::slot_get(d, c, i.slot_id).await?)
    })
}
fn slot_cancel<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&work::slot_cancel(d, c, args(v)?).await?) })
}
fn trend_record<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&trends::trend_record(d, c, args(v)?).await?) })
}
fn hypothesis_propose<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&trends::hypothesis_propose(d, c, args(v)?).await?) })
}

fn file_upload<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        to_json(&jt_app::usecases::studio::files::file_upload(d, c, args(v)?).await?)
    })
}
fn piece_submit<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        to_json(&jt_app::usecases::studio::pieces::piece_submit(d, c, args(v)?).await?)
    })
}

fn learned<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::learning::learned(d, c, args(v)?).await?) },
    )
}
fn judgment_record<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        to_json(&jt_app::usecases::studio::learning::judgment_record(d, c, args(v)?).await?)
    })
}

fn adsets_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::ads::adsets_list(d, c, args(v)?).await?) },
    )
}

fn adset_bind<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::ads::adset_bind(d, c, args(v)?).await?) },
    )
}

fn budget_move<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::ads::budget_move(d, c, args(v)?).await?) },
    )
}

fn overview<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::views::overview(d, c, args(v)?).await?) },
    )
}

fn ledger<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(
        async move { to_json(&jt_app::usecases::studio::views::ledger(d, c, args(v)?).await?) },
    )
}

fn ledger_export<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        to_json(&jt_app::usecases::studio::views::ledger_export(d, c, args(v)?).await?)
    })
}
