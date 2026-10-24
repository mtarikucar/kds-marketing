use jt_app::{ctx::Ctx, ports::UnitOfWork, usecases::studio::trends};
use jt_pg::PgUnitOfWork;
use jt_tenancy::SystemRole;
use jt_testkit::{
    TestDb,
    fakes::{FIXED_NOW, deps},
    studio_contract::ready,
};
use std::sync::Arc;

#[tokio::test]
async fn concurrent_proposals_append_both_under_draft_lock() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = ready(uow.as_ref()).await;
    let d = deps(uow.clone());
    let mut r = uow.tenant(f.ws).await.unwrap();
    let approved = r.strategy().current_approved().await.unwrap().unwrap();
    drop(r);
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: approved.created_by.clone(),
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let a = serde_json::from_value(serde_json::json!({"title":"a","channel":"x"})).unwrap();
    let b = serde_json::from_value(serde_json::json!({"title":"b","channel":"x"})).unwrap();
    let (a, b) = tokio::join!(
        trends::hypothesis_propose(&d, &ctx, a),
        trends::hypothesis_propose(&d, &ctx, b)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.hypothesis_id, b.hypothesis_id);
    assert_eq!(a.draft_version_id, b.draft_version_id);
    let mut r = uow.tenant(f.ws).await.unwrap();
    let h = r.hypotheses().list(a.draft_version_id).await.unwrap();
    assert_eq!(h.len(), 3);
    assert!(h.iter().any(|h| h.id == a.hypothesis_id));
    assert!(h.iter().any(|h| h.id == b.hypothesis_id));
    assert_eq!(r.hypotheses().list(approved.id).await.unwrap().len(), 1);
    assert_eq!(
        r.strategy().current_approved().await.unwrap().unwrap().id,
        approved.id
    );
}
#[tokio::test]
async fn planning_read_projections_are_tenant_scoped_and_keep_evidence() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let other = ready(&uow).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(r.studio().list_arms().await.unwrap().len(), 1);
    let a = r
        .studio()
        .claim_publication(FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    r.studio()
        .finish_publication(
            a.id(),
            jt_app::ports::studio::PublishOutcome::Succeeded(
                jt_app::ports::connectors::PublishReceipt {
                    external_id: "published".into(),
                    url: None,
                },
            ),
            jt_testkit::fakes::FIXED_NOW,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(other.ws).await.unwrap();
    assert!(
        r.studio()
            .slot_evidence(f.slot.id)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    drop(r);
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.studio().slot_evidence(f.slot.id).await.unwrap().0.len(),
        1
    );
}

#[tokio::test]
async fn pending_and_planning_read_all_stored_positions() {
    let db = TestDb::new().await;
    let uow = Arc::new(PgUnitOfWork::new(db.pool.clone()));
    let f = ready(uow.as_ref()).await;
    let d = deps(uow.clone());
    let mut r = uow.tenant(f.ws).await.unwrap();
    let v = r.strategy().current_approved().await.unwrap().unwrap();
    drop(r);
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: v.created_by,
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let out = jt_app::usecases::studio::work::pending(&d, &ctx)
        .await
        .unwrap();
    assert_eq!(out.slots.len(), 1);
    assert_eq!(out.slots[0].slot.id, f.slot.id);
    assert_eq!(
        jt_app::usecases::studio::planner::plan(&d, f.ws, FIXED_NOW)
            .await
            .unwrap(),
        0
    );
}
