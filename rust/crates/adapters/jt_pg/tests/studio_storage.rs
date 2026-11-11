//! Studio rows stored before `jt_studio::time_compat` carry `time`'s compact tuples in their JSON
//! columns; they keep decoding through the repositories, and every new write is RFC 3339 text.

use jt_app::ports::UnitOfWork;
use jt_app::ports::files::StoredFile;
use jt_app::ports::studio::FileId;
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_testkit::{TestDb, studio_contract};
use serde_json::{Value, json};
use time::Duration;

/// `value` as `time`'s own serde writes it (the stored encoding before `time_compat`).
fn legacy(value: time::OffsetDateTime) -> Value {
    let tuple = serde_json::to_value(value).unwrap();
    assert!(tuple.is_array(), "{tuple}");
    tuple
}

#[tokio::test]
async fn stored_tuple_rows_still_decode() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = studio_contract::seed(&uow).await;

    // A slot written today stores its schedule as text.
    let mut tx = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let stored: Value = sqlx::query_scalar("select data from studio_slots where id = $1")
        .bind(f.slot.id.0)
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert!(stored["scheduled_at"].is_string(), "{stored}");

    // The same row as an older release stored it: the tuple. It still reads back unchanged.
    sqlx::query(
        "update studio_slots set data = jsonb_set(data, '{scheduled_at}', $2) where id = $1",
    )
    .bind(f.slot.id.0)
    .bind(legacy(f.slot.scheduled_at))
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let slot = t
        .studio()
        .get_slot(f.slot.id)
        .await
        .unwrap()
        .expect("the slot");
    assert_eq!(slot, f.slot);
    drop(t);

    // A stored file with tuple timestamps (one optional one set, one null) decodes too.
    let created = f.slot.scheduled_at;
    let file = StoredFile {
        id: FileId::new_v7(),
        workspace_id: f.ws,
        mime: "image/jpeg".into(),
        filename: "a.jpg".into(),
        sha256: "00".repeat(32),
        created_at: created,
        cleanup_due_at: Some(created + Duration::days(30)),
        deleted_at: None,
        size_bytes: 10,
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.studio().save_file(file.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let data: Value = sqlx::query_scalar("select data from studio_files where id = $1")
        .bind(file.id.0)
        .fetch_one(tx.conn())
        .await
        .unwrap();
    let text = created
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    assert_eq!(data["created_at"], json!(text));
    let mut old = data.clone();
    old["created_at"] = legacy(file.created_at);
    old["cleanup_due_at"] = legacy(file.cleanup_due_at.unwrap());
    old["deleted_at"] = Value::Null;
    sqlx::query("update studio_files set data = $2 where id = $1")
        .bind(file.id.0)
        .bind(&old)
        .execute(tx.conn())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.studio().get_file(file.id).await.unwrap(), Some(file));
}
