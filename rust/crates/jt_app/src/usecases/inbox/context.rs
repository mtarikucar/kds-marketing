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
use serde_json::{Value, json};
use time::OffsetDateTime;

#[derive(Debug, Serialize)]
pub struct PendingOut {
    pub ours: Vec<Conversation>,
    pub reopen_questions: Vec<Conversation>,
    pub merges: Vec<MergeRow>,
    pub tasks_due: Vec<Task>,
    /// The owed comments of the caller's conversations in `ours` and
    /// `reopen_questions`, soonest deadline first (those without one last), then oldest.
    pub public_due: Vec<PublicDue>,
    /// The held replies waiting for a human (spec §3.7), oldest first: listed to human callers
    /// only, whoever holds the conversation.
    pub approvals: Vec<Approval>,
}

/// An owed public item (spec §3.11).
#[derive(Clone, Debug, Serialize)]
pub struct PublicDue {
    pub conversation_id: ConversationId,
    pub item_id: PublicItemId,
    pub channel: Channel,
    #[serde(with = "time::serde::rfc3339")]
    pub awaiting_since: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deadline: Option<OffsetDateTime>,
}

/// A held reply (spec §3.11).
#[derive(Clone, Debug, Serialize)]
pub struct Approval {
    pub outbox_id: uuid::Uuid,
    pub conversation_id: ConversationId,
    pub item_id: Option<PublicItemId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deadline: Option<OffsetDateTime>,
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
    /// The prospect this person was promoted from: why this business was chosen.
    pub prospect: Option<crate::usecases::prospects::ProspectSummary>,
    /// For a comment conversation (spec §6.8); absent for a direct one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public: Option<PublicContext>,
}

/// The most items of its conversation a public context shows: the latest.
pub const CONTEXT_ITEMS: usize = 20;
/// The most items of one thread a public context shows.
pub const THREAD_ITEMS: u32 = 50;

/// What a public conversation's context adds (spec §6.8).
#[derive(Debug, Serialize)]
pub struct PublicContext {
    pub channel: Channel,
    /// What the surface allows (`jt_inbox::public::rules`): text bounds, the private reply and
    /// its window in seconds, one answer, the platform's review, moderation.
    pub rules: Value,
    /// Whether the agent's replies on the capability wait for a human (spec §3.7).
    pub approval_required: bool,
    /// What to do, in English, for the agent.
    pub hint: &'static str,
    /// The conversation's latest items ([`CONTEXT_ITEMS`]), oldest first.
    pub items: Vec<PublicItemContext>,
}

/// One item of a public context.
#[derive(Debug, Serialize)]
pub struct PublicItemContext {
    pub item: PublicItem,
    pub subject: Option<PublicSubject>,
    /// The thread the item is in, oldest first: `them` (this conversation's person), `other`
    /// (another author) and `us` (our answers).
    pub thread: Vec<ThreadEntry>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub private_reply_until: Option<OffsetDateTime>,
    /// Whether the item is owed an answer ([`PublicItem::awaiting`]).
    pub owed: bool,
}

/// One message of a public thread.
#[derive(Debug, Serialize)]
pub struct ThreadEntry {
    pub author: &'static str,
    pub text: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub external_id: Option<String>,
}

/// `rules` as a public context shows them.
pub(crate) fn rules_view(rules: &jt_inbox::public::PublicRules) -> Value {
    json!({
        "public": {"min": rules.public.min, "max": rules.public.max},
        "private": rules.private.map(|p| json!({
            "window_s": p.window.whole_seconds(), "max_chars": p.max_chars,
        })),
        "one_answer": rules.one_answer,
        "moderated": rules.moderated,
        "hide": rules.hide,
        "delete": rules.delete,
    })
}

/// The agent's hint on a public surface (spec §3.10).
const PUBLIC_HINT: &str = "Answer owed comments in public, briefly. When an item shows buying \
     intent, open a journey for the person, then answer privately. Hide abuse; mark what needs \
     no answer handled.";

/// The public part of `conversation`'s context; `None` for a direct conversation.
async fn public_context(
    r: &mut dyn TenantRepos,
    conversation: &Conversation,
) -> Result<Option<PublicContext>, AppError> {
    let Some(channel) = public_channel_for_kind(&conversation.kind_key) else {
        return Ok(None);
    };
    let rules = jt_inbox::public::rules(channel)
        .ok_or_else(|| AppError::internal("a public conversation without rules"))?;
    let cap = r
        .capabilities()
        .find(conversation.capability_id)
        .await?
        .ok_or_else(|| AppError::internal("a public conversation's capability is gone"))?;
    let mut items = r.public_items().for_conversation(conversation.id).await?;
    let latest = items.split_off(items.len().saturating_sub(CONTEXT_ITEMS));
    let mut out = Vec::with_capacity(latest.len());
    for item in latest {
        let subject = match item.subject_id {
            Some(id) => r.public_subjects().get(id).await?,
            None => None,
        };
        let mut thread = Vec::new();
        for entry in r
            .public_items()
            .thread(item.capability_id, &item.root_external_id, THREAD_ITEMS)
            .await?
        {
            if let Some(m) = r.messages().get(entry.message_id).await? {
                thread.push(ThreadEntry {
                    author: if entry.conversation_id == conversation.id {
                        "them"
                    } else {
                        "other"
                    },
                    text: m.body,
                    at: m.at,
                    external_id: Some(entry.external_id.clone()),
                });
            }
            let ours = match entry.answer {
                AnswerState::Answered {
                    by: AnsweredBy::Us,
                    message_id,
                    ..
                } => message_id,
                AnswerState::Pending { message_id } => Some(message_id),
                _ => None,
            };
            if let Some(id) = ours
                && let Some(m) = r.messages().get(id).await?
            {
                thread.push(ThreadEntry {
                    author: "us",
                    text: m.body,
                    at: m.at,
                    external_id: m.external_id,
                });
            }
        }
        thread.sort_by_key(|t| t.at);
        out.push(PublicItemContext {
            owed: item.awaiting(),
            private_reply_until: item.private_reply_until,
            subject,
            thread,
            item,
        });
    }
    Ok(Some(PublicContext {
        channel,
        rules: rules_view(&rules),
        approval_required: cap.policy.requires_human_approval,
        hint: PUBLIC_HINT,
        items: out,
    }))
}

/// The held replies of the workspace, oldest first (at most [`crate::ports::inbox::MAX_INBOX_PAGE`]).
pub(crate) async fn held_replies(
    r: &mut dyn TenantRepos,
    now: OffsetDateTime,
) -> Result<Vec<crate::ports::inbox::OutboxRow>, AppError> {
    r.outbox()
        .list_pending(
            "held",
            now + time::Duration::days(1),
            crate::ports::inbox::MAX_INBOX_PAGE,
        )
        .await
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
        public_due: vec![],
        approvals: vec![],
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
        if let Some(channel) = public_channel_for_kind(&c.kind_key) {
            for item in r.public_items().for_conversation(c.id).await? {
                if item.awaiting() {
                    out.public_due.push(PublicDue {
                        conversation_id: c.id,
                        item_id: item.id,
                        channel,
                        awaiting_since: item.created_at,
                        deadline: item.deadline,
                    });
                }
            }
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
    out.public_due.sort_by_key(|d| {
        (
            d.deadline.is_none(),
            d.deadline,
            d.awaiting_since,
            d.item_id,
        )
    });
    if matches!(ctx.actor, Actor::Human { .. }) {
        for row in held_replies(r, ctx.now).await? {
            let item_id = super::public::intent_of(&row.intent)?.map(|p| p.item_id);
            let deadline = match item_id {
                Some(id) => r.public_items().get(id).await?.and_then(|i| i.deadline),
                None => None,
            };
            out.approvals.push(Approval {
                outbox_id: row.id,
                conversation_id: row.conversation_id,
                item_id,
                deadline,
            });
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
    let prospect = crate::usecases::prospects::promote::summary_for(r.as_mut(), person.id).await?;
    let public = public_context(r.as_mut(), &conversation).await?;
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
        prospect,
        public,
    })
}

/// Runs in the membership-removal transaction under the inbox workspace lock.
pub(crate) async fn departure(
    deps: &Deps,
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
        crate::usecases::distribution::record_member_left(deps, ctx, r, j.id).await?;
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
