mod support;
use jt_app::usecases::inbox::{merge, people};
use jt_inbox::*;
use serde_json::json;
use support::*;

async fn pair(w: &World) -> (Person, Person, jt_app::ports::inbox::MergeRow) {
    let mut people_out = vec![];
    for phone in ["05321234567", "05321234568"] {
        let input = serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":phone}],"source":"form"})).unwrap();
        people_out.push(
            people::create(&w.deps, &w.owner_ctx, input)
                .await
                .unwrap()
                .person,
        );
    }
    let input = serde_json::from_value(json!({"channel":"phone","value":"05321234568"})).unwrap();
    people::add_identity(&w.deps, &w.owner_ctx, people_out[0].id, input)
        .await
        .unwrap();
    let row = merge::list(&w.deps, &w.owner_ctx).await.unwrap().remove(0);
    (people_out.remove(0), people_out.remove(0), row)
}
#[tokio::test]
async fn merge_refuses_two_open_journeys() {
    let w = world().await;
    let (a, _, m) = pair(&w).await;
    let err = merge::apply(
        &w.deps,
        &w.owner_ctx,
        m.id,
        merge::ApplyInput { keep: a.id },
    )
    .await
    .unwrap_err();
    assert_eq!(err.details["reason"], "two_open_journeys");
    assert!(
        w.uow
            .snapshot()
            .inbox
            .people
            .iter()
            .all(|p| p.merged_into.is_none())
    );
}

#[tokio::test]
async fn merge_snapshot_restores_conversation_collisions() {
    jt_testkit::inbox_merge_contract::merge_snapshot_restores_conversation_collisions(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}

#[tokio::test]
async fn undo_restores_active_identities() {
    jt_testkit::inbox_merge_contract::undo_restores_active_identities(std::sync::Arc::new(
        jt_testkit::fakes::InMemoryUow::new(),
    ))
    .await;
}

#[tokio::test]
async fn keeper_first_touch_preserved() {
    jt_testkit::inbox_merge_contract::keeper_first_touch_preserved(std::sync::Arc::new(
        jt_testkit::fakes::InMemoryUow::new(),
    ))
    .await;
}

#[tokio::test]
async fn undo_requires_confirm() {
    jt_testkit::inbox_merge_contract::undo_requires_confirm(std::sync::Arc::new(
        jt_testkit::fakes::InMemoryUow::new(),
    ))
    .await;
}

#[tokio::test]
async fn undo_refuses_after_thirty_days_or_aggregate_edit() {
    jt_testkit::inbox_merge_contract::undo_refuses_after_thirty_days_or_aggregate_edit(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}

#[tokio::test]
async fn merge_permissions_tenant_refusal_and_replays() {
    jt_testkit::inbox_merge_contract::merge_permissions_tenant_refusal_and_replays(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}
#[tokio::test]
async fn later_merge_cannot_erase_an_earlier_edit_guard() {
    jt_testkit::inbox_merge_contract::later_merge_cannot_erase_an_earlier_edit_guard(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    )
    .await;
}
#[tokio::test]
async fn merge_and_undo_late_failures_roll_back() {
    jt_testkit::inbox_merge_contract::merge_and_undo_late_failures_roll_back(std::sync::Arc::new(
        jt_testkit::fakes::InMemoryUow::new(),
    ))
    .await;
}

#[tokio::test]
async fn coalescing_refuses_moved_live_outbox_without_undo_resurrection() {
    jt_testkit::inbox_merge_contract::coalescing_refuses_moved_live_outbox_without_undo_resurrection(
        std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()),
    ).await;
}
