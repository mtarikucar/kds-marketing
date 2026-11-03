//! The materials library on PostgreSQL (migration `0021_studio_materials`): the repo's contracts,
//! row-level security, the fixed origin and file, the insert-only piece uses, and the down that
//! refuses while the library holds anything.
use jt_app::{error::ErrorCode, ports::UnitOfWork, ports::materials::*};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::{
    TestDb,
    fakes::FIXED_NOW,
    studio_contract::{confirmed_olay, eligible_material, ready, seed_material},
};
use time::macros::date;

#[tokio::test]
async fn olays_and_materials_round_trip_and_one_file_is_one_material() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials()
            .get_material(material.id)
            .await
            .unwrap(),
        Some(material.clone())
    );
    assert_eq!(
        tx.studio_materials()
            .material_by_file(material.file_id)
            .await
            .unwrap(),
        Some(material.clone())
    );
    let olay_id = material.olay_id().unwrap();
    let mut olay = tx
        .studio_materials()
        .get_olay(olay_id)
        .await
        .unwrap()
        .unwrap();
    // The same file again is a conflict.
    let mut again = eligible_material(&olay, material.file_id);
    again.id = MaterialId::new_v7();
    assert_eq!(
        tx.studio_materials()
            .insert_material(again)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(tx);
    // A revisioned update; a stale one conflicts.
    let mut tx = uow.tenant(f.ws).await.unwrap();
    olay.revision = 2;
    olay.place = Some("Kadıköy".into());
    tx.studio_materials()
        .update_olay(olay.clone(), 1)
        .await
        .unwrap();
    let mut freed = material.clone();
    freed.revision = 2;
    freed.freed = Some(HumanMark {
        by: jt_tenancy::UserId::new_v7(),
        at: FIXED_NOW,
    });
    tx.studio_materials()
        .update_material(freed.clone(), 1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials()
            .update_material(freed.clone(), 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(tx);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials().get_olay(olay_id).await.unwrap(),
        Some(olay)
    );
    // The fixture's piece shows its own material as recorded.
    let shown = tx
        .studio_materials()
        .piece_materials(f.slot.id, f.piece.revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shown.uses.len(), 1);
    assert_eq!(shown.uses[0].role, UseRole::Anchor);
    assert_eq!(
        tx.studio_materials()
            .uses_of(shown.uses[0].material_id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn another_workspace_sees_none_of_it() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let other = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let mut tx = uow.tenant(other.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials()
            .get_material(material.id)
            .await
            .unwrap(),
        None
    );
    assert!(
        tx.studio_materials()
            .list_olays()
            .await
            .unwrap()
            .iter()
            .all(|o| o.workspace_id == other.ws)
    );
    // Raw rows too: RLS hides them.
    let mut raw = TenantTx::begin(&db.pool, other.ws).await.unwrap();
    let seen: i64 = sqlx::query_scalar("select count(*) from studio_materials where id = $1")
        .bind(material.id.0)
        .fetch_one(raw.conn())
        .await
        .unwrap();
    assert_eq!(seen, 0);
    raw.rollback().await.unwrap();
}

#[tokio::test]
async fn origin_and_file_never_change_and_piece_uses_are_never_rewritten() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let attempt = |sql: &'static str| {
        let pool = db.pool.clone();
        let ws = f.ws;
        let id = material.id.0;
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let r = sqlx::query(sql).bind(id).execute(tx.conn()).await;
            tx.rollback().await.unwrap();
            r.map(|_| ()).map_err(|e| e.to_string())
        }
    };
    let e =
        attempt("update studio_materials set origin='ai_generated', generator='codex' where id=$1")
            .await
            .unwrap_err();
    assert!(e.contains("never change"), "{e}");
    let e = attempt("delete from studio_materials where id=$1")
        .await
        .unwrap_err();
    assert!(e.contains("never deleted"), "{e}");
    let e =
        attempt("update studio_piece_materials set role='support' where material_id<>$1 or true")
            .await
            .unwrap_err();
    assert!(e.contains("never changed or removed"), "{e}");
    // Through the repo: a changed origin is refused before the database.
    let mut changed = material.clone();
    changed.revision = 2;
    changed.origin = Origin::AiGenerated {
        generator: "codex".into(),
    };
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_materials()
            .update_material(changed, 1)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal
    );
}

#[tokio::test]
async fn calendar_rows_shoot_requests_policy_and_releases() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut row = jt_studio::turkish_defaults(2027)
        .into_iter()
        .find(|e| e.key == "ramazan_bayrami")
        .unwrap();
    row.window_start = Some(date!(2027 - 02 - 25));
    row.window_end = Some(date!(2027 - 03 - 11));
    tx.studio_materials()
        .save_calendar_row(row.clone())
        .await
        .unwrap();
    row.lead_days = Some(28);
    tx.studio_materials()
        .save_calendar_row(row.clone())
        .await
        .unwrap();
    assert_eq!(tx.studio_materials().calendar_rows().await.unwrap(), [row]);

    let request = ShootRequest {
        id: ShootRequestId::new_v7(),
        workspace_id: f.ws,
        key: "season:yilbasi:2026".into(),
        reason: ShootReason::SeasonAhead {
            occasion: "yilbasi".into(),
            year: 2026,
        },
        text: "Yılbaşı için ürün fotoğrafı yükle.".into(),
        week_start: date!(2026 - 11 - 09),
        status: ShootStatus::Open,
        created_by: jt_ledger::Actor::System {
            component: "test".into(),
        },
        created_at: FIXED_NOW,
        resolved_by: None,
        resolved_at: None,
    };
    assert!(
        tx.studio_materials()
            .insert_shoot_request(request.clone())
            .await
            .unwrap()
    );
    let mut same_key = request.clone();
    same_key.id = ShootRequestId::new_v7();
    assert!(
        !tx.studio_materials()
            .insert_shoot_request(same_key)
            .await
            .unwrap()
    );
    let mut done = request.clone();
    done.status = ShootStatus::Done;
    done.resolved_by = Some(request.created_by.clone());
    done.resolved_at = Some(FIXED_NOW);
    tx.studio_materials()
        .update_shoot_request(done.clone())
        .await
        .unwrap();
    assert_eq!(
        tx.studio_materials().list_shoot_requests().await.unwrap(),
        [done]
    );

    assert_eq!(
        tx.studio_materials().material_policy().await.unwrap(),
        MaterialPolicy::default()
    );
    let policy = MaterialPolicy {
        lead_days: 28,
        reuse_days: 7,
        recap_days: 45,
    };
    tx.studio_materials()
        .save_material_policy(policy)
        .await
        .unwrap();
    assert_eq!(
        tx.studio_materials().material_policy().await.unwrap(),
        policy
    );

    let release = MaterialRelease {
        slot_id: f.slot.id,
        revision: 1,
        digest: "a".repeat(64),
        by: jt_tenancy::UserId::new_v7(),
        at: FIXED_NOW,
    };
    tx.studio_materials()
        .save_release(release.clone())
        .await
        .unwrap();
    assert_eq!(
        tx.studio_materials()
            .get_release(f.slot.id, 1)
            .await
            .unwrap(),
        Some(release)
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn the_down_refuses_while_the_library_holds_anything() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("materials-down").await;
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../migrations");
    let up = std::fs::read_to_string(dir.join("0021_studio_materials.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0021_studio_materials.down.sql")).unwrap();
    // Empty: down and up again, each twice.
    for _ in 0..2 {
        sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
    }
    for _ in 0..2 {
        sqlx::raw_sql(&up).execute(&db.pool).await.unwrap();
    }
    let mut tx = uow.tenant(ws).await.unwrap();
    tx.studio_materials()
        .insert_olay(confirmed_olay(ws))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let refused = sqlx::raw_sql(&down)
        .execute(&db.pool)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("down refused: olays are stored"),
        "{refused}"
    );
    let mut tx = uow.tenant(ws).await.unwrap();
    assert_eq!(tx.studio_materials().list_olays().await.unwrap().len(), 1);
}
