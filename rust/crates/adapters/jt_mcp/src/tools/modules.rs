//! Declarative workspace modules; bindings do not expand API-key permissions.
use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};
use jt_app::{
    ctx::Ctx,
    usecases::{Deps, modules},
};
use jt_capability::CapabilityId;
use jt_tenancy::{AgentConnectionId, Permission};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "modules.list",
            description: "List workspace blueprints, briefs, assigned agents and capability bindings. Assignments do not grant permissions. [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: list,
        },
        ToolDef {
            use_case: "modules.install",
            description: "Install an existing or bounded custom declarative blueprint. Does not execute code or grant permissions. [risk: WRITE]",
            permissions: &[Permission::CapabilitiesManage],
            schema: schema_for::<InstallArgs>,
            run: install,
        },
        ToolDef {
            use_case: "modules.update",
            description: "Update a module brief and existing agent/capability bindings at its revision. Does not grant permissions. [risk: WRITE]",
            permissions: &[Permission::CapabilitiesManage],
            schema: schema_for::<UpdateArgs>,
            run: update,
        },
        ToolDef {
            use_case: "modules.remove",
            description: "Remove an optional module from navigation, preserving its data and ongoing jobs. Inbox and strategy cannot be removed. [risk: WRITE]",
            permissions: &[Permission::CapabilitiesManage],
            schema: schema_for::<IdArgs>,
            run: remove,
        },
    ]
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    module_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
struct BlueprintArgs {
    id: String,
    name: String,
    description: String,
    version: String,
    requirements: Vec<String>,
    workflow: Vec<String>,
    #[serde(default)]
    builtin: bool,
}
impl From<BlueprintArgs> for modules::Blueprint {
    fn from(b: BlueprintArgs) -> Self {
        Self {
            id: b.id,
            name: b.name,
            description: b.description,
            version: b.version,
            requirements: b.requirements,
            workflow: b.workflow,
            builtin: b.builtin,
        }
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InstallArgs {
    module_id: String,
    blueprint: Option<BlueprintArgs>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
struct ConfigArgs {
    brief: String,
    agent_ids: Vec<Uuid>,
    capability_ids: Vec<Uuid>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    module_id: String,
    config: ConfigArgs,
    revision: u32,
}
fn list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(v)?;
        to_json(&modules::list(d, c).await?)
    })
}
fn install<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let a: InstallArgs = args(v)?;
        to_json(
            &modules::install(
                d,
                c,
                &a.module_id,
                modules::InstallInput {
                    blueprint: a.blueprint.map(Into::into),
                },
            )
            .await?,
        )
    })
}
fn update<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let a: UpdateArgs = args(v)?;
        to_json(
            &modules::update(
                d,
                c,
                &a.module_id,
                modules::UpdateInput {
                    config: modules::ModuleConfig {
                        brief: a.config.brief,
                        agent_ids: a
                            .config
                            .agent_ids
                            .into_iter()
                            .map(AgentConnectionId)
                            .collect(),
                        capability_ids: a
                            .config
                            .capability_ids
                            .into_iter()
                            .map(CapabilityId)
                            .collect(),
                    },
                    revision: a.revision,
                },
            )
            .await?,
        )
    })
}
fn remove<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let a: IdArgs = args(v)?;
        to_json(&modules::remove(d, c, &a.module_id).await?)
    })
}
