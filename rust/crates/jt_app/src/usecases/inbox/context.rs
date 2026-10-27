//! Derived inbox queues and the compact context used before responding.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        inbox::{ConversationQueue, MergeRow, TaskQueue},
    },
    usecases::Deps,
};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::{Permission, UserId};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PendingOut {
    pub ours: Vec<Conversation>,
    pub reopen_questions: Vec<Conversation>,
    pub merges: Vec<MergeRow>,
    pub tasks_due: Vec<Task>,
}
#[derive(Debug, Serialize)]
pub struct RecentConversation {
    pub conversation: Conversation,
    pub messages: Vec<Message>,
}
#[derive(Debug, Serialize)]
pub struct StrategyGuidance {
    pub summary: jt_strategy::Identity,
    pub segments: Vec<jt_strategy::Segment>,
    pub hypotheses: Vec<jt_strategy::Hypothesis>,
}
#[derive(Debug, Serialize)]
pub struct ContextOut {
    pub status_labels: std::collections::BTreeMap<String, String>,
    pub status_label_overrides: std::collections::BTreeMap<String, String>,
    pub person: Person,
    pub journey: Option<Journey>,
    pub events: Vec<JourneyEvent>,
    pub open_tasks: Vec<Task>,
    pub recent_conversations: Vec<RecentConversation>,
    pub strategy_guidance: Option<StrategyGuidance>,
    pub prohibitions: Vec<String>,
}

pub(crate) fn visible(ctx: &Ctx, executor: Executor) -> bool {
    match (executor, &ctx.actor) {
        (Executor::Human { user_id: None }, _) => true,
        (Executor::Agent, Actor::Agent { .. }) => true,
        (
            Executor::Human {
                user_id: Some(assigned),
            },
            Actor::Human { user_id },
        ) => assigned == *user_id,
        _ => false,
    }
}

/// Read all pages before deriving queues, so hidden rows never consume a caller's limit.
pub(crate) async fn all_conversations(
    r: &mut dyn TenantRepos,
) -> Result<Vec<Conversation>, AppError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let rows = r
            .conversations()
            .page(ConversationQueue::All, after, 500)
            .await?;
        let more = rows.len() == 500;
        after = rows.last().map(|c| (c.created_at, c.id));
        out.extend(rows);
        if !more {
            return Ok(out);
        }
    }
}

pub async fn pending(deps: &Deps, ctx: &Ctx) -> Result<PendingOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    pending_in(r.as_mut(), ctx).await
}
pub(crate) async fn pending_in(r: &mut dyn TenantRepos, ctx: &Ctx) -> Result<PendingOut, AppError> {
    let conversations = all_conversations(r).await?;
    let mut out = PendingOut {
        ours: vec![],
        reopen_questions: vec![],
        merges: vec![],
        tasks_due: vec![],
    };
    let people_with_conversations: std::collections::BTreeSet<_> =
        conversations.iter().map(|c| c.person_id).collect();
    let mut visible_people = std::collections::BTreeSet::new();
    for c in conversations {
        if !visible(ctx, c.executor) {
            continue;
        }
        let Some(person) = r.people().get(c.person_id).await? else {
            continue;
        };
        if person.erased_at.is_some() || person.merged_into.is_some() {
            continue;
        }
        visible_people.insert(c.person_id);
        if c.state != ConvState::Ours {
            continue;
        }
        if super::active_or_latest_journey(r, c.person_id)
            .await?
            .is_some_and(|j| j.status == JourneyStatus::Lost)
        {
            out.reopen_questions.push(c);
        } else {
            out.ours.push(c);
        }
    }
    // Imported/form contacts may have no conversation yet: their work is unassigned.
    let merges = r.merges().list_all().await?;
    for merge in merges.into_iter().filter(|m| m.status == "suggested") {
        let mut can_see = false;
        for person in [merge.source_id, merge.target_id] {
            if visible_people.contains(&person)
                || (!people_with_conversations.contains(&person)
                    && r.people()
                        .get(person)
                        .await?
                        .is_some_and(|p| p.erased_at.is_none() && p.merged_into.is_none()))
            {
                can_see = true;
            }
        }
        if can_see {
            out.merges.push(merge);
        }
    }
    for task in r.tasks().query(TaskQueue::All, None, ctx.now).await? {
        let Some(journey) = r.journeys().get(task.journey_id).await? else {
            continue;
        };
        let person_visible = visible_people.contains(&journey.person_id)
            || (!people_with_conversations.contains(&journey.person_id)
                && r.people()
                    .get(journey.person_id)
                    .await?
                    .is_some_and(|p| p.erased_at.is_none() && p.merged_into.is_none()));
        if task.due_at <= ctx.now
            && person_visible
            && visible(
                ctx,
                Executor::Human {
                    user_id: task.assignee,
                },
            )
        {
            out.tasks_due.push(task);
        }
    }
    Ok(out)
}

pub async fn context(deps: &Deps, ctx: &Ctx, id: ConversationId) -> Result<ContextOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let conversation = r
        .conversations()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such conversation"))?;
    let person = r
        .people()
        .get(conversation.person_id)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    let journey = super::active_or_latest_journey(r.as_mut(), person.id).await?;
    let (events, open_tasks) = if let Some(j) = &journey {
        (
            r.journeys().events(j.id, 10).await?,
            r.tasks()
                .list(j.id)
                .await?
                .into_iter()
                .filter(|t| t.status == TaskStatus::Open)
                .collect(),
        )
    } else {
        (vec![], vec![])
    };
    let mut recent = all_conversations(r.as_mut()).await?;
    recent.retain(|c| c.person_id == person.id);
    recent.sort_by_key(|c| std::cmp::Reverse((c.updated_at, c.id)));
    recent.truncate(10);
    let mut recent_conversations = Vec::new();
    for c in recent {
        let messages = r.messages().recent(c.id, 3).await?;
        recent_conversations.push(RecentConversation {
            conversation: c,
            messages,
        });
    }
    let mut prohibitions = Vec::new();
    if journey
        .as_ref()
        .is_some_and(|j| j.status == JourneyStatus::Lost)
    {
        prohibitions.push("lost".into());
    }
    if matches!(ctx.actor, Actor::Agent { .. })
        && matches!(conversation.executor, Executor::Human { .. })
    {
        prohibitions.push("human_held_for_agent".into());
    }
    let strategy_guidance = if let Some(v) = r.strategy().current_approved().await? {
        prohibitions.extend(v.sections.prohibitions.clone());
        let hypotheses = r
            .hypotheses()
            .list(v.id)
            .await?
            .into_iter()
            .filter(|h| {
                h.state.is_live() && (h.channel == conversation.kind_key || h.channel == "any")
            })
            .collect();
        Some(StrategyGuidance {
            summary: v.sections.identity,
            segments: v.sections.audience,
            hypotheses,
        })
    } else {
        None
    };
    let labels = super::dictionaries::status_labels(r.as_mut()).await?;
    Ok(ContextOut {
        status_labels: labels.effective,
        status_label_overrides: labels.overrides,
        person,
        journey,
        events,
        open_tasks,
        recent_conversations,
        strategy_guidance,
        prohibitions,
    })
}

/// Runs in the membership-removal transaction under the inbox workspace lock.
pub(crate) async fn departure(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    user: UserId,
) -> Result<(), AppError> {
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    for c in all_conversations(r).await? {
        if c.executor
            == (Executor::Human {
                user_id: Some(user),
            })
        {
            let generation = r
                .conversations()
                .update_executor(c.id, Executor::Human { user_id: None })
                .await?;
            super::record(
                r,
                ctx,
                "inbox.executor_departed",
                "conversation",
                c.id,
                serde_json::json!({"generation":generation}),
            )
            .await?;
        }
    }
    for j in r.journeys().open_owned_by(user).await? {
        r.journeys().assign_owner(j.id, None).await?;
        super::record(
            r,
            ctx,
            "inbox.owner_departed",
            "journey",
            j.id,
            serde_json::json!({}),
        )
        .await?;
    }
    Ok(())
}
