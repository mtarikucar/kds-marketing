//! Inbox tools use the panel's input types and JSON serialization.
use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    error::AppError,
    usecases::{
        Deps,
        inbox::{JourneyId, PersonId, dictionaries, journeys, people, schema},
    },
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "inbox.status_labels.set",
            description: "Replace workspace display-label overrides for the nine fixed journey stages. Unknown keys or blank labels are VALIDATION. An empty map restores default labels. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("status_labels.set")).expect("inbox schema"),
            run: status_labels_set,
        },
        ToolDef {
            use_case: "inbox.people.search",
            description: "Search workspace people. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("people.search")).expect("inbox schema"),
            run: people_search,
        },
        ToolDef {
            use_case: "inbox.people.get",
            description: "Read a person, identities, open journey and conversations; merged aliases resolve to their keeper. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("people.get")).expect("inbox schema"),
            run: people_get,
        },
        ToolDef {
            use_case: "inbox.people.create",
            description: "Match normalized identities or create a person and initial journey atomically; conflicting identities return a merge suggestion. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("people.create")).expect("inbox schema"),
            run: people_create,
        },
        ToolDef {
            use_case: "inbox.identities.add",
            description: "Add a normalized identity; collisions suggest a merge without stealing the identity. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("identities.add")).expect("inbox schema"),
            run: identities_add,
        },
        ToolDef {
            use_case: "inbox.journeys.open",
            description: "Open a journey. An open journey conflicts; Lost requires explicit reopen, Won starts Repeat. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("journeys.open")).expect("inbox schema"),
            run: journeys_open,
        },
        ToolDef {
            use_case: "inbox.events.report",
            description: "Report an allowed event with a required workspace-unique idempotency key. The reducer and all effects commit atomically; repeats suppress effects. Reopening requires a human owner or manager with inbox.manage. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("events.report")).expect("inbox schema"),
            run: events_report,
        },
        ToolDef {
            use_case: "inbox.lost_reasons.list",
            description: "Read the workspace lost-reason dictionary. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("lost_reasons.list")).expect("inbox schema"),
            run: lost_reasons_list,
        },
        ToolDef {
            use_case: "inbox.lost_reasons.set",
            description: "Set a lost-reason label and active flag; the last active reason cannot be deactivated. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("lost_reasons.set")).expect("inbox schema"),
            run: lost_reasons_set,
        },
        ToolDef {
            use_case: "inbox.journeys.get",
            description: "Read a journey, latest 50 events, tasks and notes. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("journeys.get")).expect("inbox schema"),
            run: journeys_get,
        },
        ToolDef {
            use_case: "inbox.journeys.assign_owner",
            description: "Assign an active workspace member as commission owner; null clears the owner. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || {
                Schema::try_from(schema::tool("journeys.assign_owner")).expect("inbox schema")
            },
            run: journeys_assign_owner,
        },
    ]
}
fn take_id<T: DeserializeOwned>(raw: &mut Value, key: &str) -> Result<T, AppError> {
    let value = raw
        .as_object_mut()
        .and_then(|m| m.remove(key))
        .unwrap_or(Value::Null);
    args(value)
}
fn people_search<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&people::search(deps, ctx, args(raw)?).await?) })
}
fn people_get<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&people::get(deps, ctx, id).await?)
    })
}
fn people_create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&people::create(deps, ctx, args(raw)?).await?) })
}
fn identities_add<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&people::add_identity(deps, ctx, id, args(raw)?).await?)
    })
}
fn journeys_open<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&journeys::open(deps, ctx, id).await?)
    })
}
fn events_report<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&journeys::report(deps, ctx, id, args(raw)?).await?)
    })
}
fn lost_reasons_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let _: NoArgs = args(raw)?;
        to_json(&dictionaries::list_lost_reasons(deps, ctx).await?)
    })
}
fn lost_reasons_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&dictionaries::set_lost_reason(deps, ctx, args(raw)?).await?) })
}
fn journeys_get<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&journeys::get(deps, ctx, id).await?)
    })
}
fn journeys_assign_owner<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&journeys::assign_owner(deps, ctx, id, args(raw)?).await?)
    })
}

fn status_labels_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&dictionaries::set_status_labels(deps, ctx, args(raw)?).await?) })
}
