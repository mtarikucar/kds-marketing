mod support;
use jt_app::{
    ports::UnitOfWork,
    usecases::inbox::{conversations, people},
};
use jt_inbox::*;
use serde_json::json;
use support::*;
use time::Duration;
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
async fn sla_handover_owner_or_none_ledgers_once() {
    let (w, id) = setup().await;
    let now = w.owner_ctx.now + Duration::seconds(3601);
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, now)
            .await
            .changed,
        1
    );
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, now)
            .await
            .changed,
        0
    );
    let c = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(c.executor, Executor::Human { user_id: None });
    assert_eq!(c.executor_generation, 1);
    assert_eq!(w.entries("inbox.response_sla").len(), 1);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let j = r.journeys().open_for(c.person_id).await.unwrap().unwrap();
    r.journeys()
        .assign_owner(j.id, Some(w.owner))
        .await
        .unwrap();
    r.conversations()
        .update_executor(id, Executor::Agent)
        .await
        .unwrap();
    let mut policy = r.workspace_policy().get().await.unwrap();
    policy.inbox.max_response_s.insert("sms".into(), 10);
    r.workspace_policy()
        .set(policy, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, w.owner_ctx.now + Duration::seconds(10))
            .await
            .changed,
        0
    );
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, w.owner_ctx.now + Duration::seconds(11))
            .await
            .changed,
        1
    );
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, now)
            .await
            .changed,
        0
    );
    let c = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(
        c.executor,
        Executor::Human {
            user_id: Some(w.owner)
        }
    );
    assert_eq!(c.executor_generation, 3);
    assert_eq!(w.entries("inbox.response_sla").len(), 2);
}

#[tokio::test]
async fn snooze_wake_timezone_boundary_once() {
    let (w, id) = setup().await;
    let until = (w.owner_ctx.now + Duration::hours(1))
        .to_offset(time::UtcOffset::from_hms(3, 0, 0).unwrap());
    conversations::snooze(
        &w.deps,
        &w.owner_ctx,
        id,
        conversations::SnoozeInput { until },
    )
    .await
    .unwrap();
    assert_eq!(
        jt_app::usecases::jobs::run_snooze_wake(&w.deps, until - Duration::seconds(1))
            .await
            .changed,
        0
    );
    assert_eq!(
        jt_app::usecases::jobs::run_snooze_wake(&w.deps, until.to_offset(time::UtcOffset::UTC))
            .await
            .changed,
        1
    );
    assert_eq!(
        jt_app::usecases::jobs::run_snooze_wake(&w.deps, until)
            .await
            .changed,
        0
    );
    assert_eq!(
        conversations::get(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .state,
        ConvState::Ours
    );
    assert_eq!(w.entries("inbox.snooze_wake").len(), 1);
}

#[tokio::test]
async fn departure_unassigns_executor_and_journeys() {
    use jt_app::usecases::{inbox::journeys, team};
    use jt_ledger::Actor;
    let (w, id) = setup().await;
    let rep = w.member("rep").await;
    let Actor::Human { user_id } = rep.actor else {
        panic!("human")
    };
    let membership = w
        .uow
        .snapshot()
        .memberships
        .iter()
        .find(|m| m.workspace_id == w.ws && m.user_id == Some(user_id))
        .unwrap()
        .id;
    let c = conversations::take_over(&w.deps, &rep, id).await.unwrap();
    let j = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .journeys()
        .open_for(c.person_id)
        .await
        .unwrap()
        .unwrap();
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j.id,
        journeys::AssignOwnerInput {
            user_id: Some(user_id),
        },
    )
    .await
    .unwrap();
    // A second owned journey has no conversation and must still be unassigned.
    let p=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"No conversation","identities":[{"channel":"email","value":"no-conversation@example.test"}],"source":"form"})).unwrap()).await.unwrap();
    let j2 = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .journeys()
        .open_for(p.person.id)
        .await
        .unwrap()
        .unwrap();
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j2.id,
        journeys::AssignOwnerInput {
            user_id: Some(user_id),
        },
    )
    .await
    .unwrap();
    team::remove(&w.deps, &w.owner_ctx, membership)
        .await
        .unwrap();
    let c = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(c.executor, Executor::Human { user_id: None });
    assert_eq!(c.executor_generation, 2);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(r.journeys().get(j.id).await.unwrap().unwrap().owner, None);
    assert_eq!(r.journeys().get(j2.id).await.unwrap().unwrap().owner, None);
    drop(r);
    assert_eq!(w.entries("inbox.executor_departed").len(), 1);
    assert_eq!(w.entries("inbox.owner_departed").len(), 2);
}

#[tokio::test]
async fn response_sla_whatsapp_defaults_and_non_candidates() {
    let (w, id) = setup().await;
    let c = conversations::get(&w.deps, &w.owner_ctx, id).await.unwrap();
    let cap = w.declare("whatsapp_cloud", "WhatsApp").await;
    let wa = ConversationId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut row = c.clone();
    row.id = wa;
    row.capability_id = cap.capability.id;
    row.kind_key = "whatsapp_cloud".into();
    r.conversations().upsert_on_inbound(row).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, w.owner_ctx.now + Duration::seconds(900))
            .await
            .changed,
        0
    );
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, w.owner_ctx.now + Duration::seconds(901))
            .await
            .changed,
        1
    );
    assert_eq!(
        conversations::get(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .executor,
        Executor::Agent
    );
    conversations::close(&w.deps, &w.owner_ctx, id)
        .await
        .unwrap();
    assert_eq!(
        jt_app::usecases::jobs::run_response_sla(&w.deps, w.owner_ctx.now + Duration::hours(2))
            .await
            .changed,
        0
    );
    assert_eq!(w.entries("inbox.response_sla").len(), 1);
}
