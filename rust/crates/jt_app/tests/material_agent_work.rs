//! The external worker sees durable work, never a promise that the server starts a model.
mod support;
use jt_app::{
    ports::{UnitOfWork, materials::*},
    usecases::work::{self, WorkKind},
};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, Permission};
use jt_testkit::{fakes::FIXED_NOW, studio_contract::seed_material};
use time::Duration;

#[tokio::test]
async fn analysis_work_is_agent_scoped_recovers_expired_leases_and_covers_legacy_materials() {
    let w = support::world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let material = seed_material(&w.uow, w.ws).await;
    let connection_id = AgentConnectionId::new_v7();
    let mut agent = w.owner_ctx.clone();
    agent.actor = Actor::Agent {
        connection_id,
        user_id: w.owner,
    };
    agent.agent_connection_id = Some(connection_id);
    let has = |p: &work::PendingOut| {
        p.items.iter().any(|i| matches!(i.kind, WorkKind::StudioMaterialAnalysis {material_id, expected_revision:1} if material_id==material.id))
    };
    // No stored metadata (pre-migration material) still has truthful, claimable pending work.
    let pending = work::pending(&w.deps, &agent).await.unwrap();
    assert!(has(&pending));
    let item = pending
        .items
        .iter()
        .find(|i| matches!(i.kind, WorkKind::StudioMaterialAnalysis { .. }))
        .unwrap();
    assert!(item.hint.contains("actual short-lived preview"));
    assert!(
        item.hint
            .contains("Never infer capture or event dates from upload time")
    );
    assert!(item.hint.contains("Nothing wakes you"));
    assert!(!has(&work::pending(&w.deps, &w.owner_ctx).await.unwrap()));
    let mut restricted = agent.clone();
    restricted.permissions.remove(&Permission::StudioWork);
    assert!(!has(&work::pending(&w.deps, &restricted).await.unwrap()));
    let mut row = MaterialAnalysisRecord::pending(material.id, FIXED_NOW, DateSource::Unknown);
    row.intelligence.status = AnalysisStatus::Running;
    row.lease = Some(MaterialAnalysisLease {
        token_hash: "private".into(),
        owner: connection_id,
        material_revision: 1,
        expires_at: FIXED_NOW + Duration::minutes(10),
    });
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    tx.studio_materials()
        .save_intelligence(row.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!has(&work::pending(&w.deps, &agent).await.unwrap()));
    let mut later = agent.clone();
    later.now += Duration::minutes(10);
    assert!(has(&work::pending(&w.deps, &later).await.unwrap()));
    row.intelligence.status = AnalysisStatus::Failed;
    row.lease = None;
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    tx.studio_materials().save_intelligence(row).await.unwrap();
    tx.commit().await.unwrap();
    assert!(!has(&work::pending(&w.deps, &later).await.unwrap()));
    // Payment-gated work stays out even though work.pending itself may run before payment.
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    tx.studio_materials()
        .save_intelligence(MaterialAnalysisRecord::pending(
            material.id,
            FIXED_NOW,
            DateSource::Unknown,
        ))
        .await
        .unwrap();
    tx.workspace()
        .set_status(
            w.ws,
            jt_tenancy::WorkspaceStatus::PendingPayment,
            "test",
            &w.owner_ctx.actor,
        )
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!has(&work::pending(&w.deps, &agent).await.unwrap()));
}

#[tokio::test]
async fn production_work_tracks_lease_expiry_and_omits_terminal_or_human_work() {
    use jt_app::ports::material_productions::*;
    let w = support::world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let source = seed_material(&w.uow, w.ws).await;
    let connection_id = AgentConnectionId::new_v7();
    let mut agent = w.owner_ctx.clone();
    agent.actor = Actor::Agent {
        connection_id,
        user_id: w.owner,
    };
    agent.agent_connection_id = Some(connection_id);
    let production_id = uuid::Uuid::from_u128(77);
    let mut row = ProductionRecord {
        production: MaterialProduction {
            id: production_id,
            workspace_id: w.ws,
            kind: ProductionKind::Crop,
            instructions: "Crop a square".into(),
            sources: vec![ProductionSource {
                material_id: source.id,
                expected_revision: 1,
            }],
            status: ProductionStatus::Pending,
            output_material_id: None,
            last_error_code: None,
            revision: 1,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        },
        lease: None,
    };
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    tx.studio_productions()
        .save_production(row.clone(), None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let has = |p: &work::PendingOut| {
        p.items.iter().any(|i|matches!(i.kind,WorkKind::StudioMaterialProduction{production_id:id,..} if id==production_id))
    };
    assert!(has(&work::pending(&w.deps, &agent).await.unwrap()));
    assert!(!has(&work::pending(&w.deps, &w.owner_ctx).await.unwrap()));
    row.production.status = ProductionStatus::Running;
    row.production.revision = 2;
    row.lease = Some(ProductionLease {
        token_hash: "private".into(),
        owner: connection_id,
        expires_at: FIXED_NOW + Duration::minutes(30),
    });
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    tx.studio_productions()
        .save_production(row.clone(), Some(1))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!has(&work::pending(&w.deps, &agent).await.unwrap()));
    agent.now += Duration::minutes(30);
    assert!(has(&work::pending(&w.deps, &agent).await.unwrap()));
    for status in [
        ProductionStatus::Completed,
        ProductionStatus::Failed,
        ProductionStatus::Cancelled,
    ] {
        let previous = row.production.revision;
        row.production.revision += 1;
        row.production.status = status;
        row.lease = None;
        let mut tx = w.uow.tenant(w.ws).await.unwrap();
        tx.studio_productions()
            .save_production(row.clone(), Some(previous))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(!has(&work::pending(&w.deps, &agent).await.unwrap()));
    }
}
