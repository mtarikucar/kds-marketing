//! `jeeta.workspace.info` (`workspace.info`).

use jt_app::ctx::Ctx;
use jt_app::usecases::{Deps, workspace};
use jt_tenancy::Permission;
use serde_json::Value;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![ToolDef {
        use_case: "workspace.info",
        description: "The workspace this API key belongs to: id, name, slug and status (only an \
                      active workspace runs gated tools), the issuer's role and the key's \
                      effective permissions. [risk: READ]",
        permission: Permission::WorkspaceRead,
        schema: schema_for::<NoArgs>,
        run: info,
    }]
}

fn info<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&workspace::info(deps, ctx).await?)
    })
}
