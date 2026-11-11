//! The module capability gate answered from `capabilities` (spec
//! 2026-11-10-module-capability-gating-design.md).
use jt_app::gate::StrategyGate;
use jt_pg::{PgStrategyGate, TenantTx};
use jt_testkit::TestDb;
use uuid::Uuid;

async fn capability(db: &TestDb, ws: jt_tenancy::WorkspaceId, kind: &str, status: &str) {
    let mut tx = TenantTx::begin(&db.pool, ws).await.unwrap();
    sqlx::query("insert into capabilities(id,workspace_id,kind_key,name,reach,status,created_at,updated_at) values($1,$2,$3,$3,'connector',$4,now(),now())")
        .bind(Uuid::now_v7())
        .bind(ws.as_uuid())
        .bind(kind)
        .bind(status)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn a_module_opens_once_a_capability_it_needs_is_connected_in_its_own_workspace() {
    let db = TestDb::new().await;
    let gate = PgStrategyGate::new(db.pool.clone());
    let (a, _) = db.seed_workspace("gate-a").await;
    let (b, _) = db.seed_workspace("gate-b").await;
    assert_eq!(
        gate.missing_capabilities(a, "inbox").await.unwrap(),
        vec!["messaging".to_owned()]
    );
    assert!(
        gate.missing_capabilities(a, "strategy")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        gate.missing_capabilities(a, "people")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        gate.missing_capabilities(a, "no-such-module")
            .await
            .unwrap()
            .is_empty()
    );

    // Declared or retired does not count; verified and unreachable do.
    capability(&db, a, "mailbox", "declared").await;
    capability(&db, a, "whatsapp_cloud", "retired").await;
    assert_eq!(
        gate.missing_capabilities(a, "inbox").await.unwrap().len(),
        1
    );
    capability(&db, a, "instagram_dm", "unreachable").await;
    assert!(
        gate.missing_capabilities(a, "inbox")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        gate.missing_capabilities(a, "outreach").await.unwrap(),
        vec!["mailbox|sms_line|whatsapp_cloud".to_owned()]
    );
    capability(&db, a, "netgsm_pbx", "verified").await;
    assert!(
        gate.missing_capabilities(a, "calls")
            .await
            .unwrap()
            .is_empty()
    );

    // Never another workspace's capabilities.
    assert_eq!(
        gate.missing_capabilities(b, "inbox").await.unwrap(),
        vec!["messaging".to_owned()]
    );
}
