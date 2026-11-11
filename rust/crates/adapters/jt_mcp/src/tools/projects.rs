use super::{ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    usecases::{
        Deps,
        studio::{project_schedule, projects},
    },
};
use schemars::Schema;
use serde_json::Value;
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "studio.project_list",
            description: "List a cursor page of tenant production projects; target dates are draft intentions. [risk: READ]",
            permissions: jt_app::usecases::studio::permissions::for_use_case("studio.project_list"),
            schema: || Schema::try_from(projects::schema("list")).expect("project schema"),
            run: project_list,
        },
        ToolDef {
            use_case: "studio.project_create",
            description: "Create a production workspace within the tenant; does not publish or start a model. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_create",
            ),
            schema: || Schema::try_from(projects::schema("create")).expect("project schema"),
            run: project_create,
        },
        ToolDef {
            use_case: "studio.project_get",
            description: "Read a project and its live sources, derivative job history and canonical publication links. [risk: READ]",
            permissions: jt_app::usecases::studio::permissions::for_use_case("studio.project_get"),
            schema: || Schema::try_from(projects::schema("get")).expect("project schema"),
            run: project_get,
        },
        ToolDef {
            use_case: "studio.project_update",
            description: "Update brief, draft outputs or archive state at expected revision. Brief edits invalidate old production context; archive cancels active derivative jobs but not scheduled publications. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_update",
            ),
            schema: || Schema::try_from(projects::schema("update")).expect("project schema"),
            run: project_update,
        },
        ToolDef {
            use_case: "studio.project_materials",
            description: "Attach materials to a production area with `add` (material ids; adding one that is already attached refreshes it to the material's current revision), or take sources out with `remove` (content.manage). Pass the area's current revision as expected_revision. Removing or refreshing sources invalidates dependent production jobs. Returns the area. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_materials",
            ),
            schema: || Schema::try_from(projects::schema("materials")).expect("project schema"),
            run: project_materials,
        },
        ToolDef {
            use_case: "studio.project_request",
            description: "Ask a person for a real photo or video the production area needs; the area waits for it and returns to check-in once it is supplied. Records a task and never invents a supplied file. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_request",
            ),
            schema: || Schema::try_from(projects::schema("request")).expect("project schema"),
            run: project_request,
        },
        ToolDef {
            use_case: "studio.project_request_update",
            description: "Complete with real live materials, dismiss or reopen a project request. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_request_update",
            ),
            schema: || {
                Schema::try_from(projects::schema("request_update")).expect("project schema")
            },
            run: project_request_update,
        },
        ToolDef {
            use_case: "studio.project_publication",
            description: "Link an existing canonical planned post matching this output and its materials; does not publish. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_publication",
            ),
            schema: || Schema::try_from(projects::schema("publication")).expect("project schema"),
            run: project_publication,
        },
        ToolDef {
            use_case: "studio.project_schedule",
            description: "Schedule a project output using the existing canonical posting policy and strategy gate; this does not mark it published. [risk: WRITE]",
            permissions: jt_app::usecases::studio::permissions::for_use_case(
                "studio.project_schedule",
            ),
            schema: || Schema::try_from(project_schedule::schema()).expect("project schema"),
            run: project_schedule,
        },
    ]
}
fn project_list<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_list(d, c, args(v)?).await?) })
}
fn project_create<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_create(d, c, args(v)?).await?) })
}
fn project_get<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_get(d, c, args(v)?).await?) })
}
fn project_update<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_update(d, c, args(v)?).await?) })
}
fn project_materials<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_materials(d, c, args(v)?).await?) })
}
fn project_request<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_request(d, c, args(v)?).await?) })
}
fn project_request_update<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_request_update(d, c, args(v)?).await?) })
}
fn project_publication<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&projects::project_publication(d, c, args(v)?).await?) })
}
fn project_schedule<'a>(d: &'a Deps, c: &'a Ctx, v: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&project_schedule::project_schedule(d, c, args(v)?).await?) })
}
