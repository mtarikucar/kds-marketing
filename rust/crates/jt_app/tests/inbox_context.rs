mod support;
use jt_app::{
    ports::UnitOfWork,
    usecases::inbox::{conversations, people},
};
use jt_inbox::*;
use serde_json::json;
use support::*;
async fn setup() -> (World, ConversationId) {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let p=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()).await.unwrap();
    let cap = w.declare("sms_line", "SMS").await;
    let id = ConversationId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: w.ws,
            person_id: p.person.id,
            capability_id: cap.capability.id,
            kind_key: "sms_line".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(w.owner_ctx.now),
            last_outbound_at: None,
            created_at: w.owner_ctx.now,
            updated_at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    (w, id)
}
#[tokio::test]
async fn pending_filters_executor_and_unassigned() {
    let (w, id) = setup().await;
    let agent = w.agent(&["inbox.work"]).await;
    assert_eq!(
        jt_app::usecases::inbox::context::pending(&w.deps, &agent)
            .await
            .unwrap()
            .ours
            .len(),
        1
    );
    conversations::take_over(&w.deps, &w.owner_ctx, id)
        .await
        .unwrap();
    assert!(
        jt_app::usecases::inbox::context::pending(&w.deps, &agent)
            .await
            .unwrap()
            .ours
            .is_empty()
    );
    assert_eq!(
        jt_app::usecases::inbox::context::pending(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .ours
            .len(),
        1
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .update_executor(id, Executor::Human { user_id: None })
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        jt_app::usecases::inbox::context::pending(&w.deps, &agent)
            .await
            .unwrap()
            .ours
            .len(),
        1
    );
}

#[tokio::test]
async fn context_only_same_person_and_channel_hypotheses() {
    use jt_app::usecases::inbox::{context, journeys};
    use jt_strategy::*;
    use time::Duration;
    let (w, id) = setup().await;
    let original = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    let p=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Other","identities":[{"channel":"email","value":"other@example.test"}],"source":"form"})).unwrap()).await.unwrap();
    let j = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .journeys()
        .latest_for(original.person_id)
        .await
        .unwrap()
        .unwrap();
    for i in 0..12 {
        journeys::report(&w.deps,&w.owner_ctx,j.id,serde_json::from_value(json!({"kind":"call_made","idempotency_key":format!("call-{i}"),"payload":{"connected":true}})).unwrap()).await.unwrap();
    }
    let version = StrategyVersionId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut other = original.clone();
    other.id = ConversationId::new_v7();
    other.person_id = p.person.id;
    r.conversations().upsert_on_inbound(other).await.unwrap();
    for i in 0..5 {
        r.messages()
            .insert_if_new(Message {
                id: MessageId::new_v7(),
                workspace_id: w.ws,
                conversation_id: id,
                direction: Direction::Inbound,
                author: Author::Customer,
                body: format!("message-{i}"),
                external_id: Some(format!("msg-{i}")),
                status: MsgStatus::Received,
                cost_minor: None,
                at: w.owner_ctx.now + Duration::seconds(i),
            })
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let before = context::context(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert!(before.strategy_guidance.is_none());
    assert_eq!(before.events.len(), 10);
    assert_eq!(before.recent_conversations.len(), 1);
    assert_eq!(
        before.recent_conversations[0]
            .messages
            .iter()
            .map(|m| m.body.as_str())
            .collect::<Vec<_>>(),
        ["message-2", "message-3", "message-4"]
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut sections = Sections::default();
    sections.identity.product = "Consulting".into();
    sections.audience.push(Segment {
        key: "buyers".into(),
        name: "Buyers".into(),
        description: "Potential buyers".into(),
    });
    sections
        .prohibitions
        .push("Never promise guaranteed results".into());
    r.strategy()
        .insert(StrategyVersion {
            id: version,
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections,
            created_at: w.owner_ctx.now,
            created_by: w.owner_ctx.actor.clone(),
            submitted_at: Some(w.owner_ctx.now),
            approved_at: Some(w.owner_ctx.now),
            approved_by: Some(w.owner),
            archived_at: None,
        })
        .await
        .unwrap();
    for (channel, state) in [
        ("sms_line", HypothesisState::Kept),
        ("instagram", HypothesisState::Kept),
        ("any", HypothesisState::Added),
        ("sms_line", HypothesisState::Retired),
    ] {
        r.hypotheses()
            .upsert(
                version,
                Hypothesis {
                    cadence: Default::default(),
                    derived_confidence: None,
                    id: HypothesisId::new_v7(),
                    title: channel.into(),
                    segment_key: "buyers".into(),
                    angle: "help".into(),
                    channel: channel.into(),
                    metric: "replies".into(),
                    prior_confidence: 0.5,
                    state,
                },
            )
            .await
            .unwrap();
    }
    r.conversations()
        .update_executor(id, Executor::Human { user_id: None })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let agent = w.agent(&["inbox.work"]).await;
    let out = context::context(&w.deps, &agent, id).await.unwrap();
    assert!(out.prohibitions.contains(&"human_held_for_agent".into()));
    assert!(
        out.prohibitions
            .contains(&"Never promise guaranteed results".into())
    );
    let guidance = out.strategy_guidance.unwrap();
    assert_eq!(guidance.summary.product, "Consulting");
    assert_eq!(guidance.segments[0].description, "Potential buyers");
    assert_eq!(
        guidance
            .hypotheses
            .iter()
            .map(|h| h.channel.as_str())
            .collect::<Vec<_>>(),
        ["sms_line", "any"]
    );
    assert!(
        out.recent_conversations
            .iter()
            .all(|c| c.conversation.person_id == original.person_id)
    );
    let mut foreign = w.owner_ctx.clone();
    foreign.workspace_id = jt_tenancy::WorkspaceId::new_v7();
    assert!(context::context(&w.deps, &foreign, id).await.is_err());
}

#[tokio::test]
async fn pending_hides_other_executors_and_requires_inbox_work() {
    use jt_app::usecases::inbox::context;
    let (w, id) = setup().await;
    let rep = w.member("rep").await;
    conversations::take_over(&w.deps, &rep, id).await.unwrap();
    assert!(
        context::pending(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .ours
            .is_empty()
    );
    let mut denied = w.owner_ctx.clone();
    denied.permissions.clear();
    assert_eq!(
        context::pending(&w.deps, &denied).await.unwrap_err().code,
        jt_app::error::ErrorCode::Forbidden
    );
    assert_eq!(
        context::context(&w.deps, &denied, id)
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn unassigned_tasks_without_conversations_are_visible() {
    use jt_app::usecases::inbox::context;
    let w = world().await;
    let p=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Form lead","identities":[{"channel":"email","value":"form@example.test"}],"source":"form"})).unwrap()).await.unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let j = r.journeys().open_for(p.person.id).await.unwrap().unwrap();
    let id = TaskId::new_v7();
    r.tasks()
        .insert(Task {
            id,
            workspace_id: w.ws,
            journey_id: j.id,
            title: "First contact".into(),
            due_at: w.owner_ctx.now,
            assignee: None,
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        context::pending(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .tasks_due[0]
            .id,
        id
    );
}
