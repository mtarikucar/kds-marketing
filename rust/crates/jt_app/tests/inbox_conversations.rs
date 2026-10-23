mod support;
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::inbox::{conversations, people},
};
use jt_inbox::*;
use serde_json::json;
use support::*;
use time::Duration;
async fn setup() -> (World, ConversationId) {
    let w = world().await;
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
async fn handovers_increment_generation_and_agent_takeover_is_rejected() {
    let (w, id) = setup().await;
    let row = conversations::take_over(&w.deps, &w.owner_ctx, id)
        .await
        .unwrap();
    assert_eq!(
        row.executor,
        Executor::Human {
            user_id: Some(w.owner)
        }
    );
    assert_eq!(row.executor_generation, 1);
    assert_eq!(
        conversations::hand_to_agent(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .executor_generation,
        2
    );
    let agent = w.agent(&["inbox.work"]).await;
    let e = conversations::take_over(&w.deps, &agent, id)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.message, "executor must be a person");
}
#[tokio::test]
async fn unsnooze_and_close_clear_snooze() {
    let (w, id) = setup().await;
    let until = w.owner_ctx.now + Duration::hours(2);
    assert_eq!(
        conversations::snooze(
            &w.deps,
            &w.owner_ctx,
            id,
            conversations::SnoozeInput { until }
        )
        .await
        .unwrap()
        .state,
        ConvState::Snoozed { until }
    );
    assert_eq!(
        conversations::unsnooze(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .state,
        ConvState::Ours
    );
    assert_eq!(
        conversations::close(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .state,
        ConvState::Closed
    );
}
#[tokio::test]
async fn reads_are_tenant_scoped_and_invalid_cursor_is_validation() {
    let (w, id) = setup().await;
    let mut ctx = w.owner_ctx.clone();
    ctx.workspace_id = jt_tenancy::WorkspaceId::new_v7();
    assert_eq!(
        conversations::get(&w.deps, &ctx, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let input = serde_json::from_value(json!({"cursor":"invalid"})).unwrap();
    assert_eq!(
        conversations::list(&w.deps, &w.owner_ctx, input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
}
#[tokio::test]
async fn pagination_filters_before_limit_and_handles_equal_timestamps() {
    let (w, id) = setup().await;
    let original = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    for i in 0..3 {
        r.messages()
            .insert_if_new(Message {
                id: MessageId::new_v7(),
                workspace_id: w.ws,
                conversation_id: id,
                direction: Direction::Inbound,
                author: Author::Customer,
                body: format!("{i}"),
                external_id: None,
                status: MsgStatus::Received,
                cost_minor: None,
                at: w.owner_ctx.now,
            })
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let mut seen = vec![];
    let mut cursor = None;
    loop {
        let page = conversations::messages(
            &w.deps,
            &w.owner_ctx,
            id,
            conversations::MessagesInput {
                cursor,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
        seen.extend(page.items.into_iter().map(|m| m.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 3);
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 3);
    // More than one conversation with the same creation timestamp, and a snoozed filter.
    for i in 0..3 {
        let cap = w.declare("sms_line", &format!("SMS {i}")).await;
        let mut c = original.clone();
        c.id = ConversationId::new_v7();
        c.capability_id = cap.capability.id;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let row = r.conversations().upsert_on_inbound(c).await.unwrap();
        r.commit().await.unwrap();
        if i == 2 {
            conversations::snooze(
                &w.deps,
                &w.owner_ctx,
                row.id,
                conversations::SnoozeInput {
                    until: w.owner_ctx.now + Duration::hours(1),
                },
            )
            .await
            .unwrap();
        }
    }
    let mut seen = vec![];
    let mut cursor = None;
    loop {
        let page = conversations::list(
            &w.deps,
            &w.owner_ctx,
            conversations::ListInput {
                queue: jt_app::ports::inbox::ConversationQueue::All,
                cursor,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
        seen.extend(page.items.into_iter().map(|c| c.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 4);
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 4);
    let page = conversations::list(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"queue":"snoozed","limit":1})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.next_cursor.is_none());
    assert!(matches!(page.items[0].state, ConvState::Snoozed { .. }));
}
