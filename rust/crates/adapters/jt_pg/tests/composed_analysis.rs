//! `0054_composed_material_analysis`: a composed material the previous release left with pending
//! analysis work is marked analysed when everything behind it is analysed, and left as it is
//! otherwise; an upload's analysis is never touched.
use jt_app::ports::{
    UnitOfWork,
    files::StoredFile,
    materials::{AnalysisStatus, DateSource, MaterialAnalysisRecord},
};
use jt_pg::PgUnitOfWork;
use jt_studio::{FileId, Material, MaterialId, compose::Composition};
use jt_testkit::TestDb;
use jt_testkit::fakes::FIXED_NOW;

/// Stores a composition drawn from `sources`, as the previous release did.
async fn composite(
    uow: &PgUnitOfWork,
    from: &Material,
    sources: Vec<MaterialId>,
    n: u8,
) -> Material {
    let file = StoredFile {
        id: FileId::new_v7(),
        workspace_id: from.workspace_id,
        mime: "image/jpeg".into(),
        filename: "cover-full_top.jpg".into(),
        sha256: format!("{n:x}").repeat(64).chars().take(64).collect(),
        created_at: FIXED_NOW,
        cleanup_due_at: None,
        deleted_at: None,
        size_bytes: 1,
    };
    let m = Material {
        id: MaterialId::new_v7(),
        file_id: file.id,
        mime: "image/jpeg".into(),
        title: "cover · full_top".into(),
        composition: Some(Composition {
            logo: None,
            renderer: "jeeta-compose".into(),
            role: jt_studio::compose::Role::Cover.into(),
            variant: "full_top".into(),
            frame: jt_studio::compose::Frame::Slide.into(),
            sources,
            unknown: Default::default(),
        }),
        ..from.clone()
    };
    let mut r = uow.tenant(from.workspace_id).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m
}

async fn set(uow: &PgUnitOfWork, m: &Material, status: AnalysisStatus) {
    let mut row = MaterialAnalysisRecord::pending(m.id, FIXED_NOW, DateSource::Unknown);
    row.intelligence.status = status;
    let mut r = uow.tenant(m.workspace_id).await.unwrap();
    r.studio_materials().save_intelligence(row).await.unwrap();
    r.commit().await.unwrap();
}

async fn status(uow: &PgUnitOfWork, m: &Material) -> Option<AnalysisStatus> {
    let mut r = uow.tenant(m.workspace_id).await.unwrap();
    r.studio_materials()
        .get_intelligence(m.id)
        .await
        .unwrap()
        .map(|row| row.intelligence.status)
}

/// A material a later release stored, with a role, a frame and fields this build does not know
/// (on the material and on its composition), reads through the repository and keeps them all
/// when this build saves it again; a material with nothing unknown reads back exactly as written.
#[tokio::test]
async fn fields_and_values_a_later_release_added_survive_a_save() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = jt_testkit::studio_contract::ready(&uow).await;
    let photo = jt_testkit::studio_contract::seed_material(&uow, f.ws).await;
    let made = composite(&uow, &photo, vec![photo.id], 4).await;
    // As the later release would write it (through the same repository).
    let mut v = serde_json::to_value(&made).unwrap();
    v["composition"]["role"] = serde_json::json!("some_new_role");
    v["composition"]["frame"] = serde_json::json!("some_new_frame");
    v["composition"]["added_later"] = serde_json::json!({"n": 1});
    v["added_later"] = serde_json::json!(["kept"]);
    v["revision"] = serde_json::json!(made.revision + 1);
    let later: Material = serde_json::from_value(v.clone()).unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.studio_materials()
        .update_material(later, made.revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    let all = r.studio_materials().list_materials().await.unwrap();
    let read = all
        .iter()
        .find(|m| m.id == made.id)
        .expect("listed")
        .clone();
    assert_eq!(serde_json::to_value(&read).unwrap(), v);
    // Saved again by this build (a new title): everything it did not know is still there.
    let mut changed = read.clone();
    changed.title = "renamed".into();
    changed.revision += 1;
    r.studio_materials()
        .update_material(changed, read.revision)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    let stored = serde_json::to_value(
        r.studio_materials()
            .get_material(made.id)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored["added_later"], serde_json::json!(["kept"]));
    assert_eq!(stored["composition"], v["composition"]);
    assert_eq!(stored["title"], "renamed");
    // A material with nothing unknown reads back exactly as it was written: no extra key.
    let plain = serde_json::to_value(
        r.studio_materials()
            .get_material(photo.id)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(plain, serde_json::to_value(&photo).unwrap());
    assert!(plain.get("unknown").is_none());
}

#[tokio::test]
async fn only_composites_with_everything_behind_them_analysed_are_marked_analysed() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = jt_testkit::studio_contract::ready(&uow).await;
    let checked = jt_testkit::studio_contract::seed_material(&uow, f.ws).await;
    let unchecked = jt_testkit::studio_contract::seed_material(&uow, f.ws).await;
    set(&uow, &checked, AnalysisStatus::Completed).await;
    set(&uow, &unchecked, AnalysisStatus::Pending).await;
    // From an analysed photo: queued by the previous release.
    let good = composite(&uow, &checked, vec![checked.id], 1).await;
    set(&uow, &good, AnalysisStatus::Pending).await;
    // From an unanalysed photo, directly and through another composition.
    let bad = composite(&uow, &unchecked, vec![unchecked.id], 2).await;
    let worse = composite(&uow, &checked, vec![checked.id, bad.id], 3).await;

    for _ in 0..2 {
        sqlx::raw_sql(include_str!(
            "../../../../migrations/0054_composed_material_analysis.up.sql"
        ))
        .execute(&db.pool)
        .await
        .unwrap();
    }

    assert_eq!(status(&uow, &good).await, Some(AnalysisStatus::Completed));
    let mut r = uow.tenant(f.ws).await.unwrap();
    let row = r
        .studio_materials()
        .get_intelligence(good.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.intelligence.analyzed_revision, Some(good.revision));
    assert!(row.lease.is_none());
    assert!(row.intelligence.manual_fields.contains("labels"));
    drop(r);
    // Not completed: something behind them was never checked.
    assert_eq!(status(&uow, &bad).await, None);
    assert_eq!(status(&uow, &worse).await, None);
    // Uploads untouched.
    assert_eq!(
        status(&uow, &checked).await,
        Some(AnalysisStatus::Completed)
    );
    assert_eq!(
        status(&uow, &unchecked).await,
        Some(AnalysisStatus::Pending)
    );
}
