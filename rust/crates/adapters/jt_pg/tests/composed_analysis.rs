//! `0054_composed_material_analysis`: a composed material left with pending analysis work by the
//! previous release is marked analysed, and an upload's analysis is left as it is.
use jt_app::ports::{
    UnitOfWork,
    files::StoredFile,
    materials::{AnalysisStatus, DateSource, MaterialAnalysisRecord},
};
use jt_pg::PgUnitOfWork;
use jt_studio::{FileId, MaterialId, compose::Composition};
use jt_testkit::TestDb;
use jt_testkit::fakes::FIXED_NOW;

#[tokio::test]
async fn composed_materials_queued_before_are_marked_analysed_and_uploads_are_not() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = jt_testkit::studio_contract::ready(&uow).await;
    let upload = jt_testkit::studio_contract::seed_material(&uow, f.ws).await;
    // A composition drawn from the upload, as the previous release stored it: no analysis
    // record (read as pending), then an agent's pending row.
    let file = StoredFile {
        id: FileId::new_v7(),
        workspace_id: f.ws,
        mime: "image/jpeg".into(),
        filename: "cover-full_top.jpg".into(),
        sha256: "1".repeat(64),
        created_at: FIXED_NOW,
        cleanup_due_at: None,
        deleted_at: None,
        size_bytes: 1,
    };
    let composite = jt_studio::Material {
        id: MaterialId::new_v7(),
        file_id: file.id,
        mime: "image/jpeg".into(),
        title: "cover · full_top".into(),
        composition: Some(Composition {
            renderer: "jeeta-compose".into(),
            role: jt_studio::compose::Role::Cover,
            variant: "full_top".into(),
            frame: jt_studio::compose::Frame::Slide,
            sources: vec![upload.id],
        }),
        ..upload.clone()
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials()
        .insert_material(composite.clone())
        .await
        .unwrap();
    for id in [upload.id, composite.id] {
        r.studio_materials()
            .save_intelligence(MaterialAnalysisRecord::pending(
                id,
                FIXED_NOW,
                DateSource::Unknown,
            ))
            .await
            .unwrap();
    }
    r.commit().await.unwrap();

    for _ in 0..2 {
        sqlx::raw_sql(include_str!(
            "../../../../migrations/0054_composed_material_analysis.up.sql"
        ))
        .execute(&db.pool)
        .await
        .unwrap();
    }

    let mut r = uow.tenant(f.ws).await.unwrap();
    let done = r
        .studio_materials()
        .get_intelligence(composite.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(done.intelligence.status, AnalysisStatus::Completed);
    assert_eq!(
        done.intelligence.analyzed_revision,
        Some(composite.revision)
    );
    assert!(done.lease.is_none());
    assert!(done.intelligence.manual_fields.contains("labels"));
    let untouched = r
        .studio_materials()
        .get_intelligence(upload.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(untouched.intelligence.status, AnalysisStatus::Pending);
}
