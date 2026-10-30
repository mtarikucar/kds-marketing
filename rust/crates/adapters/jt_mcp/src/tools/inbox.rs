//! Inbox tools use the panel's input types and JSON serialization.
use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::ToolFuture;
use jt_app::{
    ctx::Ctx,
    error::AppError,
    usecases::{
        Deps,
        inbox::{
            JourneyId, MergeId, PersonId, TaskId, commissions, dictionaries, journeys, merge,
            people, schema, tasks,
        },
    },
};
use jt_tenancy::Permission;
use schemars::Schema;
use serde::de::DeserializeOwned;
use serde_json::Value;

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "inbox.people.erase",
            description: "Permanently erase personal data, retain anonymous financial references. Requires confirm: true. [risk: DESTRUCTIVE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("people.erase")).expect("inbox schema"),
            run: people_erase,
        },
        ToolDef {
            use_case: "inbox.commissions.list",
            description: "commissions.list for workspace commissions. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("commissions.list")).expect("inbox schema"),
            run: commissions_list,
        },
        ToolDef {
            use_case: "inbox.commissions.approve",
            description: "commissions.approve for workspace commissions. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("commissions.approve")).expect("inbox schema"),
            run: commissions_approve,
        },
        ToolDef {
            use_case: "inbox.commissions.pay",
            description: "commissions.pay for workspace commissions. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("commissions.pay")).expect("inbox schema"),
            run: commissions_pay,
        },
        ToolDef {
            use_case: "inbox.commission_rates.set",
            description: "commission_rates.set for workspace commissions. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || {
                Schema::try_from(schema::tool("commission_rates.set")).expect("inbox schema")
            },
            run: commission_rates_set,
        },
        ToolDef {
            use_case: "inbox.quotes.send",
            description: "quotes.send for an internal journey. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("quotes.send")).expect("inbox schema"),
            run: quotes_send,
        },
        ToolDef {
            use_case: "inbox.quotes.accept",
            description: "quotes.accept for an internal journey. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("quotes.accept")).expect("inbox schema"),
            run: quotes_accept,
        },
        ToolDef {
            use_case: "inbox.quotes.list",
            description: "quotes.list for an internal journey. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("quotes.list")).expect("inbox schema"),
            run: quotes_list,
        },
        ToolDef {
            use_case: "inbox.appointments.book",
            description: "appointments.book for an internal journey. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("appointments.book")).expect("inbox schema"),
            run: appointments_book,
        },
        ToolDef {
            use_case: "inbox.appointments.cancel",
            description: "appointments.cancel for an internal journey. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("appointments.cancel")).expect("inbox schema"),
            run: appointments_cancel,
        },
        ToolDef {
            use_case: "inbox.appointments.held",
            description: "appointments.held for an internal journey. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("appointments.held")).expect("inbox schema"),
            run: appointments_held,
        },
        ToolDef {
            use_case: "inbox.consent.record",
            description: "consent.record for a workspace person. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("consent.record")).expect("inbox schema"),
            run: consent_record,
        },
        ToolDef {
            use_case: "inbox.consent.list",
            description: "consent.list for a workspace person. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("consent.list")).expect("inbox schema"),
            run: consent_list,
        },
        ToolDef {
            use_case: "inbox.suppressions.add",
            description: "suppressions.add for a workspace person. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("suppressions.add")).expect("inbox schema"),
            run: suppressions_add,
        },
        ToolDef {
            use_case: "inbox.suppressions.remove",
            description: "suppressions.remove for a workspace person. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("suppressions.remove")).expect("inbox schema"),
            run: suppressions_remove,
        },
        ToolDef {
            use_case: "inbox.send",
            description: "send for a workspace person. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("send")).expect("inbox schema"),
            run: send,
        },
        ToolDef {
            use_case: "inbox.pending",
            description: "Read the executor-visible inbox queues. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("pending")).expect("inbox schema"),
            run: pending,
        },
        ToolDef {
            use_case: "inbox.context",
            description: "Read recent conversation context and strategy guidance. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("context")).expect("inbox schema"),
            run: context,
        },
        ToolDef {
            use_case: "inbox.conversations.list",
            description: "conversations.list for workspace conversations. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("conversations.list")).expect("inbox schema"),
            run: conversations_list,
        },
        ToolDef {
            use_case: "inbox.conversations.get",
            description: "conversations.get for workspace conversations. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("conversations.get")).expect("inbox schema"),
            run: conversations_get,
        },
        ToolDef {
            use_case: "inbox.messages.list",
            description: "messages.list for workspace conversations. An outbound message that failed, or whose outcome is unknown, carries failure_reason: the error kind, provider and the provider's reason (e.g. \"permanent: meta: HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list\"); null otherwise. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("messages.list")).expect("inbox schema"),
            run: messages_list,
        },
        ToolDef {
            use_case: "inbox.take_over",
            description: "take_over for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("take_over")).expect("inbox schema"),
            run: take_over,
        },
        ToolDef {
            use_case: "inbox.hand_to_agent",
            description: "hand_to_agent for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("hand_to_agent")).expect("inbox schema"),
            run: hand_to_agent,
        },
        ToolDef {
            use_case: "inbox.snooze",
            description: "snooze for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("snooze")).expect("inbox schema"),
            run: snooze,
        },
        ToolDef {
            use_case: "inbox.unsnooze",
            description: "unsnooze for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("unsnooze")).expect("inbox schema"),
            run: unsnooze,
        },
        ToolDef {
            use_case: "inbox.close",
            description: "close for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("close")).expect("inbox schema"),
            run: close,
        },
        ToolDef {
            use_case: "inbox.reply",
            description: "reply for workspace conversations. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("reply")).expect("inbox schema"),
            run: reply,
        },
        ToolDef {
            use_case: "inbox.merges.list",
            description: "List merge suggestions and their decisions. [risk: READ]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("merges.list")).expect("inbox schema"),
            run: merges_list,
        },
        ToolDef {
            use_case: "inbox.merges.apply",
            description: "Apply a merge keeping the selected person; two open journeys conflict. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("merges.apply")).expect("inbox schema"),
            run: merges_apply,
        },
        ToolDef {
            use_case: "inbox.merges.undo",
            description: "Undo a merge within 30 days, requiring confirm: true and unchanged aggregates. [risk: DESTRUCTIVE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("merges.undo")).expect("inbox schema"),
            run: merges_undo,
        },
        ToolDef {
            use_case: "inbox.merges.refuse",
            description: "Refuse a pending merge suggestion. [risk: WRITE]",
            permission: Permission::InboxManage,
            schema: || Schema::try_from(schema::tool("merges.refuse")).expect("inbox schema"),
            run: merges_refuse,
        },
        ToolDef {
            use_case: "inbox.tasks.create",
            description: "Create a follow-up task with a due time and optional assignee. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("tasks.create")).expect("inbox schema"),
            run: tasks_create,
        },
        ToolDef {
            use_case: "inbox.tasks.complete",
            description: "Complete a follow-up task. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("tasks.complete")).expect("inbox schema"),
            run: tasks_complete,
        },
        ToolDef {
            use_case: "inbox.tasks.list",
            description: "List tasks in the due_24h, overdue or all queue, optionally filtered by assignee. [risk: READ]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("tasks.list")).expect("inbox schema"),
            run: tasks_list,
        },
        ToolDef {
            use_case: "inbox.notes.add",
            description: "Add a journey note; its text is excluded from the ledger. [risk: WRITE]",
            permission: Permission::InboxWork,
            schema: || Schema::try_from(schema::tool("notes.add")).expect("inbox schema"),
            run: notes_add,
        },
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

fn merges_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let _: NoArgs = args(raw)?;
        to_json(&merge::list(deps, ctx).await?)
    })
}

fn merges_apply<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: MergeId = take_id(&mut raw, "merge_id")?;
        to_json(&merge::apply(deps, ctx, id, args(raw)?).await?)
    })
}

fn merges_undo<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: MergeId = take_id(&mut raw, "merge_id")?;
        to_json(&merge::undo(deps, ctx, id, args(raw)?).await?)
    })
}

fn merges_refuse<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: MergeId = take_id(&mut raw, "merge_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&merge::refuse(deps, ctx, id).await?)
    })
}

fn tasks_create<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&tasks::create(deps, ctx, id, args(raw)?).await?)
    })
}

fn tasks_complete<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: TaskId = take_id(&mut raw, "task_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&tasks::complete(deps, ctx, id).await?)
    })
}

fn tasks_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&tasks::list(deps, ctx, args(raw)?).await?) })
}

fn notes_add<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&tasks::add_note(deps, ctx, id, args(raw)?).await?)
    })
}

use jt_app::usecases::inbox::{ConversationId, conversations, replies};
fn conversations_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&conversations::list(deps, ctx, args(raw)?).await?) })
}
fn conversations_get<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&conversations::get(deps, ctx, id).await?)
    })
}
fn messages_list<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        to_json(&conversations::messages(deps, ctx, id, args(raw)?).await?)
    })
}
fn take_over<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&conversations::take_over(deps, ctx, id).await?)
    })
}
fn hand_to_agent<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&conversations::hand_to_agent(deps, ctx, id).await?)
    })
}
fn snooze<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        to_json(&conversations::snooze(deps, ctx, id, args(raw)?).await?)
    })
}
fn unsnooze<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&conversations::unsnooze(deps, ctx, id).await?)
    })
}
fn close<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&conversations::close(deps, ctx, id).await?)
    })
}
fn reply<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        to_json(&replies::reply(deps, ctx, id, args(raw)?).await?)
    })
}

fn pending<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let _: NoArgs = args(raw)?;
        to_json(&jt_app::usecases::inbox::context::pending(deps, ctx).await?)
    })
}
fn context<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: ConversationId = take_id(&mut raw, "conversation_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&jt_app::usecases::inbox::context::context(deps, ctx, id).await?)
    })
}

use jt_app::usecases::inbox::consent;
fn consent_record<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&consent::record_consent(deps, ctx, id, args(raw)?).await?)
    })
}
fn consent_list<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&consent::list(deps, ctx, id).await?)
    })
}
fn suppressions_add<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&consent::add_suppression(deps, ctx, id, args(raw)?).await?)
    })
}
fn suppressions_remove<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&consent::remove_suppression(deps, ctx, id, args(raw)?).await?)
    })
}
fn send<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&replies::send(deps, ctx, id, args(raw)?).await?)
    })
}

use jt_app::usecases::inbox::{appointments, quotes};
fn quotes_send<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&quotes::send(deps, ctx, id, args(raw)?).await?)
    })
}
fn quotes_accept<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: uuid::Uuid = take_id(&mut raw, "quote_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&quotes::accept(deps, ctx, id).await?)
    })
}
fn quotes_list<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&quotes::list(deps, ctx, id).await?)
    })
}
fn appointments_book<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: JourneyId = take_id(&mut raw, "journey_id")?;
        to_json(&appointments::book(deps, ctx, id, args(raw)?).await?)
    })
}
fn appointments_cancel<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: uuid::Uuid = take_id(&mut raw, "appointment_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&appointments::cancel(deps, ctx, id).await?)
    })
}
fn appointments_held<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: uuid::Uuid = take_id(&mut raw, "appointment_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&appointments::held(deps, ctx, id).await?)
    })
}

fn commissions_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&commissions::list(deps, ctx, args(raw)?).await?) })
}
fn commission_rates_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move { to_json(&commissions::set_rate(deps, ctx, args(raw)?).await?) })
}
fn commissions_approve<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: uuid::Uuid = take_id(&mut raw, "commission_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&commissions::approve(deps, ctx, id).await?)
    })
}
fn commissions_pay<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: uuid::Uuid = take_id(&mut raw, "commission_id")?;
        let _: NoArgs = args(raw)?;
        to_json(&commissions::pay(deps, ctx, id).await?)
    })
}

fn people_erase<'a>(deps: &'a Deps, ctx: &'a Ctx, mut raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let id: PersonId = take_id(&mut raw, "person_id")?;
        to_json(&jt_app::usecases::inbox::erasure::erase(deps, ctx, id, args(raw)?).await?)
    })
}
