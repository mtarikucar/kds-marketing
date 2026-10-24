use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{
        Deps,
        studio::{control, schema},
    },
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
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
