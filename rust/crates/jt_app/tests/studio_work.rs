#[path = "support/studio.rs"]
mod support;
use jt_app::usecases::{
    studio,
    work::{self, WorkKind},
};
use time::Duration;
#[tokio::test]
async fn agent_absent_leaves_work_pending_and_overdue_visible() {
    let w = support::world().await;
    let mut late = w.ctx.clone();
    late.now += Duration::days(2);
    let first = work::pending(&w.d, &late).await.unwrap();
    assert!(first.items.iter().any(
        |i| matches!(i.kind,WorkKind::StudioSlot{slot_id,overdue:true} if slot_id==w.f.slot.id)
    ));
    assert_eq!(work::pending(&w.d, &late).await.unwrap(), first);
    assert_eq!(
        studio::work::pending(&w.d, &late).await.unwrap().slots[0]
            .slot
            .id,
        w.f.slot.id
    );
    assert_eq!(first.agent.last_seen_at, None);
    assert!(first.agent.overdue);
    // No agent is registered: leave existing last-seen/overdue semantics unchanged.
    assert_eq!(
        w.uow.snapshot().studio.slots[0].state,
        jt_studio::SlotState::Ready
    );
}
