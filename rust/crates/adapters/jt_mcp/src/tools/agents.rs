//! `jeeta.agent.whoami` (`auth.me`) and `jeeta.agents.list` (`agents.list`).

use jt_app::ctx::Ctx;
use jt_app::usecases::{Deps, agents};
use jt_tenancy::Permission;
use serde_json::Value;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "auth.me",
            description: "Who this API key acts as: the agent actor (its connection and the user \
                          who issued the key), the workspace, the issuer's role and the key's \
                          effective permissions. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: whoami,
        },
        ToolDef {
            use_case: "agents.list",
            description: "List the agent clients that have connected with this workspace's API \
                          keys: client name and version, the key used, when first and last seen, \
                          and how many tools each has called. Returns {connections: [...]}. \
                          [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: list,
        },
    ]
}

fn whoami<'a>(_deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&agents::whoami(ctx))
    })
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("connections", &agents::list(deps, ctx).await?)
    })
}
