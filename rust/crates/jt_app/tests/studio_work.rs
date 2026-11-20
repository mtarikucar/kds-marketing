#[path = "support/studio.rs"]
mod support;
use jt_app::usecases::{
    studio,
    work::{self, WorkKind},
};
use time::Duration;
/// A slot with no piece yet is the agent's: it stays pending, and overdue, while no agent comes.
/// A slot whose piece is done is listed in `studio.pending` but asks for no content (2026-11-20).
#[tokio::test]
async fn agent_absent_leaves_work_pending_and_overdue_visible() {
    use jt_app::ports::UnitOfWork;
    let w = support::world().await;
    let mut planned = w.f.slot.clone();
    planned.id = jt_studio::SlotId::new_v7();
    planned.state = jt_studio::SlotState::Planned;
    planned.revision = 0;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio()
        .insert_slots("unprepared", vec![planned.clone()])
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut late = w.ctx.clone();
    late.now += Duration::days(2);
    let first = work::pending(&w.d, &late).await.unwrap();
    assert!(first.items.iter().any(
        |i| matches!(i.kind,WorkKind::StudioSlot{slot_id,overdue:true} if slot_id==planned.id)
    ));
    assert!(
        !first
            .items
            .iter()
            .any(|i| matches!(i.kind,WorkKind::StudioSlot{slot_id,..} if slot_id==w.f.slot.id)),
        "a ready piece is not asked for again"
    );
    assert_eq!(work::pending(&w.d, &late).await.unwrap(), first);
    let studio = studio::work::pending(&w.d, &late).await.unwrap();
    let listed = |id| studio.slots.iter().find(|s| s.slot.id == id).unwrap();
    assert!(listed(planned.id).needs_piece);
    assert!(!listed(w.f.slot.id).needs_piece);
    assert_eq!(first.agent.last_seen_at, None);
    assert!(first.agent.overdue);
    // No agent is registered: leave existing last-seen/overdue semantics unchanged.
    assert_eq!(
        w.uow.snapshot().studio.slots[0].state,
        jt_studio::SlotState::Ready
    );
}
