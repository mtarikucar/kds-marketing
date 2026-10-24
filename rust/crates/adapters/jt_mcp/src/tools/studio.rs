use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{
        Deps,
        studio::{control, schema, trends, work},
    },
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "studio.file_upload",
            description: "Store validated tenant media with a replay key. [risk: WRITE]",
            permission: Permission::StudioWork,
            schema: || Schema::try_from(schema::input("file_upload")).expect("studio schema"),
            run: file_upload,
        },
        ToolDef {
            use_case: "studio.piece_submit",
            description: "Submit agent content and revision-bound Ready work atomically. [risk: WRITE]",
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
            description: "Read slot content, hypothesis, brand rules, learning and evidence. [risk: READ]",
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
