//! The chat media's repository contracts (`jt_app::ports::message_media`), exercised by both
//! adapters: the in-memory fake (`tests/message_media_fakes.rs`) and PostgreSQL
//! (`jt_pg/tests/message_media_repos.rs`).

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::message_media::{
    ErasedFiles, MediaDirection, MediaKind, MediaReason, MediaSource, MediaState, MessageMediaRow,
};
use jt_capability::CapabilityId;
use jt_inbox::{MessageId, PersonId};
use jt_studio::FileId;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::fakes::FIXED_NOW;
use crate::inbox_contract::Fixture;

/// `FIXED_NOW` plus `m` minutes.
fn at(m: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(m)
}

fn hash(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}

/// A customer's image of `message` at `position`, pending since `at(minute)`.
pub fn pending(
    capability: CapabilityId,
    message: MessageId,
    position: u8,
    minute: i64,
) -> MessageMediaRow {
    MessageMediaRow {
        id: Uuid::now_v7(),
        message_id: message,
        position,
        capability_id: capability,
        direction: MediaDirection::Inbound,
        kind: MediaKind::Image,
        source: MediaSource::Provider,
        material_id: None,
        file_id: None,
        provider_media_id: Some(format!("15000000000000{minute:02}")),
        declared_mime: "image/jpeg".into(),
        mime: None,
        filename: String::new(),
        size_bytes: None,
        sha256: None,
        width: None,
        height: None,
        state: MediaState::Pending,
        reason: None,
        attempts: 0,
        next_attempt_at: None,
        created_at: at(minute),
        stored_at: None,
        deleted_at: None,
    }
}

/// `row` stored at `at(minute)` with `size` bytes.
pub fn stored(row: MessageMediaRow, minute: i64, size: u64) -> MessageMediaRow {
    MessageMediaRow {
        state: MediaState::Stored,
        file_id: Some(FileId::new_v7()),
        provider_media_id: None,
        mime: Some("image/jpeg".into()),
        size_bytes: Some(size),
        sha256: Some(hash('a')),
        width: Some(640),
        height: Some(480),
        stored_at: Some(at(minute)),
        ..row
    }
}

/// A person with a conversation on `cap`, and a message in it.
async fn thread(f: &Fixture, cap: CapabilityId, name: &str) -> (PersonId, MessageId) {
    let p = f.insert_person(name).await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    let mut m = f.message(c.id);
    m.external_id = Some(format!("wamid.{}", m.id));
    t.messages().insert_if_new(m.clone()).await.unwrap();
    t.commit().await.unwrap();
    (p.id, m.id)
}

/// A row is recorded once per message and position; the due list follows the next attempt
/// times, oldest first; a save moves a row on (its message, position and source kept); the purge
/// lists stored inbound rows past a time; `kept` names stored rows' files; the day's bytes count
/// what was stored since.
pub async fn record_fetch_purge(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (_, message) = thread(&f, cap, "Ornek").await;
    let (_, later) = thread(&f, cap, "Diger").await;
    let first = pending(cap, message, 0, 0);
    let second = pending(cap, message, 1, 1);
    let waiting = MessageMediaRow {
        attempts: 1,
        next_attempt_at: Some(at(30)),
        ..pending(cap, later, 0, 2)
    };
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for row in [&first, &second, &waiting] {
        assert!(t.message_media().insert_if_new(row).await.unwrap());
    }
    // The message's position is taken: nothing is written.
    assert!(
        !t.message_media()
            .insert_if_new(&pending(cap, message, 0, 3))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();

    // A taken id is a conflict.
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let e = t
        .message_media()
        .insert_if_new(&MessageMediaRow {
            position: 5,
            ..first.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    drop(t);

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.message_media().due(at(10), 10).await.unwrap(),
        [first.id, second.id]
    );
    assert_eq!(
        t.message_media().due(at(30), 10).await.unwrap(),
        [first.id, second.id, waiting.id]
    );
    assert_eq!(t.message_media().due(at(30), 1).await.unwrap(), [first.id]);
    let kept = stored(first.clone(), 5, 1000);
    // A save never moves a row to another message, position or source.
    t.message_media()
        .save(&MessageMediaRow {
            position: 7,
            message_id: later,
            ..kept.clone()
        })
        .await
        .unwrap();
    let refused = MessageMediaRow {
        state: MediaState::Failed,
        reason: Some(MediaReason::NotAllowed),
        provider_media_id: None,
        ..second.clone()
    };
    t.message_media().save(&refused).await.unwrap();
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.message_media().get(first.id).await.unwrap(),
        Some(kept.clone())
    );
    assert_eq!(
        t.message_media().lock(second.id).await.unwrap(),
        Some(refused.clone())
    );
    assert_eq!(
        t.message_media()
            .for_messages(&[message, later])
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.message_id == message)
            .map(|r| r.position)
            .collect::<Vec<_>>(),
        [0, 1]
    );
    assert_eq!(
        t.message_media().due(at(60), 10).await.unwrap(),
        [waiting.id]
    );
    assert_eq!(
        t.message_media().inbound_bytes_since(at(5)).await.unwrap(),
        1000
    );
    assert_eq!(
        t.message_media().inbound_bytes_since(at(6)).await.unwrap(),
        0
    );
    assert!(
        t.message_media()
            .due_for_purge(at(4), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        t.message_media().due_for_purge(at(5), 10).await.unwrap(),
        std::slice::from_ref(&kept)
    );
    let file = kept.file_id.unwrap();
    let unknown = FileId::new_v7();
    assert_eq!(
        t.message_media().kept(&[file, unknown]).await.unwrap(),
        [file]
    );
    // An unknown row is not found.
    let e = t
        .message_media()
        .save(&pending(cap, message, 3, 9))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

/// A person's erasure reaches every row of their conversations' messages and of the people merged
/// into them: names and media ids gone, every row `deleted` (`erased`); the stored files the inbox
/// owns are answered, a library material's never. Other people's rows are untouched. Rows that
/// break the table's rules are refused.
pub async fn erasure_deletes_and_answers_the_files(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (person, message) = thread(&f, cap, "Silinecek").await;
    let (alias, alias_message) = thread(&f, cap, "Eski").await;
    let (_, other_message) = thread(&f, cap, "Kalacak").await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.people()
        .mark_merged(alias, Some(person), FIXED_NOW)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let image = stored(pending(cap, message, 0, 0), 1, 10);
    let document = MessageMediaRow {
        kind: MediaKind::Document,
        filename: "teklif.pdf".into(),
        ..pending(cap, message, 1, 0)
    };
    let alias_image = stored(pending(cap, alias_message, 0, 0), 1, 10);
    let material = MessageMediaRow {
        direction: MediaDirection::Outbound,
        source: MediaSource::Material,
        material_id: Some(Uuid::now_v7()),
        ..stored(pending(cap, message, 2, 0), 1, 10)
    };
    // The team's uploads: one sent only to the erased person, one also sent to another person.
    let upload = |message, position| MessageMediaRow {
        direction: MediaDirection::Outbound,
        source: MediaSource::Upload,
        ..stored(pending(cap, message, position, 0), 1, 10)
    };
    let only_theirs = upload(message, 3);
    let shared = upload(message, 4);
    let shared_elsewhere = MessageMediaRow {
        file_id: shared.file_id,
        ..upload(other_message, 1)
    };
    let others = stored(pending(cap, other_message, 0, 0), 1, 10);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for row in [
        &image,
        &document,
        &alias_image,
        &material,
        &only_theirs,
        &shared,
        &shared_elsewhere,
        &others,
    ] {
        assert!(t.message_media().insert_if_new(row).await.unwrap());
    }
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut gone = t
        .message_media()
        .erase_person(person, at(30))
        .await
        .unwrap();
    gone.customer.sort();
    let mut expected = vec![image.file_id.unwrap(), alias_image.file_id.unwrap()];
    expected.sort();
    assert_eq!(gone.customer, expected);
    // An upload sent only here goes; one another conversation still shows stays.
    assert_eq!(gone.uploads, [only_theirs.file_id.unwrap()]);
    // Again: nothing is left to delete.
    assert_eq!(
        t.message_media()
            .erase_person(person, at(31))
            .await
            .unwrap(),
        ErasedFiles::default()
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for id in [image.id, document.id, alias_image.id, material.id] {
        let row = t.message_media().get(id).await.unwrap().unwrap();
        assert_eq!(
            (
                row.state,
                row.reason,
                row.deleted_at,
                row.filename.as_str(),
                row.provider_media_id.as_deref(),
                row.file_id,
            ),
            (
                MediaState::Deleted,
                Some(MediaReason::Erased),
                Some(at(30)),
                "",
                None,
                None
            ),
            "{id}"
        );
    }
    assert_eq!(
        t.message_media().get(others.id).await.unwrap(),
        Some(others.clone())
    );
    assert!(
        t.message_media()
            .kept(&[image.file_id.unwrap(), others.file_id.unwrap()])
            .await
            .unwrap()
            == [others.file_id.unwrap()]
    );
    drop(t);

    // Rows that break the table's rules are refused, each in a bundle of its own.
    let base = pending(cap, other_message, 4, 0);
    let broken = [
        MessageMediaRow {
            provider_media_id: None,
            ..base.clone()
        },
        MessageMediaRow {
            state: MediaState::Stored,
            ..base.clone()
        },
        MessageMediaRow {
            state: MediaState::Failed,
            ..base.clone()
        },
        MessageMediaRow {
            state: MediaState::Failed,
            reason: Some(MediaReason::Erased),
            ..base.clone()
        },
        MessageMediaRow {
            state: MediaState::Deleted,
            reason: Some(MediaReason::Retention),
            ..base.clone()
        },
        MessageMediaRow {
            reason: Some(MediaReason::Expired),
            ..base.clone()
        },
        MessageMediaRow {
            source: MediaSource::Upload,
            ..base.clone()
        },
        MessageMediaRow {
            direction: MediaDirection::Outbound,
            source: MediaSource::Material,
            ..base.clone()
        },
        MessageMediaRow {
            position: 10,
            ..base.clone()
        },
        MessageMediaRow {
            filename: "x".repeat(256),
            ..base.clone()
        },
        MessageMediaRow {
            message_id: MessageId::new_v7(),
            ..base.clone()
        },
        MessageMediaRow {
            capability_id: CapabilityId::new_v7(),
            ..base.clone()
        },
    ];
    for row in broken {
        let mut t = f.uow.tenant(f.ws).await.unwrap();
        let e = t.message_media().insert_if_new(&row).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal, "{row:?}");
    }
}

/// A workspace sees, lists, purges, erases and counts its own rows only, and cannot name another
/// workspace's message or capability.
pub async fn rows_are_workspace_scoped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (person, message) = thread(&f, cap, "Ornek").await;
    let mine = stored(pending(cap, message, 0, 0), 1, 100);
    let waiting = pending(cap, message, 1, 0);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert!(t.message_media().insert_if_new(&mine).await.unwrap());
    assert!(t.message_media().insert_if_new(&waiting).await.unwrap());
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(t.message_media().get(mine.id).await.unwrap(), None);
    assert_eq!(t.message_media().lock(waiting.id).await.unwrap(), None);
    assert!(
        t.message_media()
            .for_messages(&[message])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(t.message_media().due(at(100), 10).await.unwrap().is_empty());
    assert!(
        t.message_media()
            .due_for_purge(at(100), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        t.message_media()
            .kept(&[mine.file_id.unwrap()])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        t.message_media().inbound_bytes_since(at(-1)).await.unwrap(),
        0
    );
    assert_eq!(
        t.message_media().erase_person(person, at(1)).await.unwrap(),
        ErasedFiles::default()
    );
    let e = t.message_media().save(&mine).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    drop(t);
    // Another workspace's message and capability cannot be named.
    let mut t = f.uow.tenant(f.other).await.unwrap();
    let e = t
        .message_media()
        .insert_if_new(&pending(cap, message, 2, 0))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.message_media().get(mine.id).await.unwrap(), Some(mine));
    assert_eq!(
        t.message_media().get(waiting.id).await.unwrap(),
        Some(waiting)
    );
}
