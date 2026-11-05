//! The mail files' repository contracts (`jt_app::ports::mail_files`), exercised by both
//! adapters: the in-memory fake (`tests/mail_files_fakes.rs`) and PostgreSQL
//! (`jt_pg/tests/mail_files_repos.rs`).

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::mail_files::{MailFileDirection, MailFileRow, MailFileState, SkipReason};
use jt_capability::CapabilityId;
use jt_inbox::{ConversationId, MessageId, PersonId};
use jt_studio::FileId;
use time::{Duration, OffsetDateTime};

use crate::fakes::FIXED_NOW;
use crate::inbox_contract::Fixture;

/// `FIXED_NOW` plus `m` minutes.
fn at(m: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(m)
}

/// A SHA-256 in hex, made of `c`.
fn hash(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}

/// An inbound file of email event `event` on `capability`, stored at `at(minute)`.
pub fn inbound(capability: CapabilityId, event: &str, minute: i64, size: u64) -> MailFileRow {
    MailFileRow {
        id: FileId::new_v7(),
        direction: MailFileDirection::Inbound,
        state: MailFileState::Stored,
        skip_reason: None,
        capability_id: Some(capability),
        event_external_id: Some(event.into()),
        message_id: None,
        person_id: None,
        filename: "teklif.pdf".into(),
        declared_mime: "application/pdf".into(),
        size_bytes: size,
        sha256: Some(hash('a')),
        created_at: at(minute),
        expires_at: None,
        deleted_at: None,
    }
}

/// An uploaded outbound file, staged at `at(minute)` until `at(expires)`.
pub fn staged(minute: i64, expires: i64) -> MailFileRow {
    MailFileRow {
        id: FileId::new_v7(),
        direction: MailFileDirection::Outbound,
        state: MailFileState::Staged,
        skip_reason: None,
        capability_id: None,
        event_external_id: None,
        message_id: None,
        person_id: None,
        filename: "katalog.pdf".into(),
        declared_mime: "application/pdf".into(),
        size_bytes: 2048,
        sha256: Some(hash('b')),
        created_at: at(minute),
        expires_at: Some(at(expires)),
        deleted_at: None,
    }
}

/// A person with a conversation on `cap`, and a message in it.
async fn thread(
    f: &Fixture,
    cap: CapabilityId,
    name: &str,
) -> (PersonId, CapabilityId, ConversationId, MessageId) {
    let p = f.insert_person(name).await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    let mut m = f.message(c.id);
    m.external_id = Some(format!("<{}@example.invalid>", m.id));
    t.messages().insert_if_new(m.clone()).await.unwrap();
    t.commit().await.unwrap();
    (p.id, cap, c.id, m.id)
}

/// Inbound rows are stored with the email's event and linked to its message and person when it
/// is consumed (only the rows not yet linked); a staged outbound file attaches once, to one
/// message; the purge lists stored inbound files past retention and staged files past expiry,
/// oldest first, and marks only rows holding bytes; `kept` names the rows holding bytes, and
/// the day's inbound bytes count what the store held.
pub async fn insert_link_attach_purge(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (person, _, _, message) = thread(&f, cap, "Ornek").await;
    let first = inbound(cap, "imap:a:1", 0, 1000);
    let second = inbound(cap, "imap:a:1", 1, 500);
    let skipped = MailFileRow {
        state: MailFileState::Skipped,
        skip_reason: Some(SkipReason::FileTooLarge),
        sha256: None,
        size_bytes: 20_000_000,
        ..inbound(cap, "imap:a:1", 2, 0)
    };
    let other_email = inbound(cap, "imap:a:2", 3, 700);
    let upload = staged(4, 60 * 24 * 7);
    let expired = staged(5, 10);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for row in [&first, &second, &skipped, &other_email, &upload, &expired] {
        t.mail_files().insert(row.clone()).await.unwrap();
    }
    t.commit().await.unwrap();

    // A taken id is a conflict.
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let e = t.mail_files().insert(first.clone()).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    drop(t);

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.mail_files().get(first.id).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        t.mail_files().lock(upload.id).await.unwrap(),
        Some(upload.clone())
    );
    // The email's three rows link; again, none is left to link.
    assert_eq!(
        t.mail_files()
            .link_event_to_message(cap, "imap:a:1", message, person)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        t.mail_files()
            .link_event_to_message(cap, "imap:a:1", message, person)
            .await
            .unwrap(),
        0
    );
    // The staged file attaches once; the expired one too (the use case checks expiry), a
    // stored inbound file never.
    assert_eq!(
        t.mail_files()
            .attach(&[upload.id, first.id], message, person)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.mail_files()
            .attach(&[upload.id], message, person)
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let listed = t.mail_files().for_messages(&[message]).await.unwrap();
    assert_eq!(
        listed.iter().map(|r| r.id).collect::<Vec<_>>(),
        [first.id, second.id, skipped.id, upload.id]
    );
    assert!(
        listed[..3]
            .iter()
            .all(|r| r.message_id == Some(message) && r.person_id == Some(person))
    );
    let attached = &listed[3];
    assert_eq!(attached.state, MailFileState::Attached);
    assert_eq!(
        (attached.message_id, attached.person_id),
        (Some(message), Some(person))
    );
    assert_eq!(attached.expires_at, None);
    assert!(t.mail_files().for_messages(&[]).await.unwrap().is_empty());

    // Nothing is due before retention or expiry.
    assert!(
        t.mail_files()
            .due_for_purge(at(-1), at(9), 100)
            .await
            .unwrap()
            .is_empty()
    );
    // Stored inbound files created at the cut or before, staged files expired at now or before.
    let due = t
        .mail_files()
        .due_for_purge(at(1), at(10), 100)
        .await
        .unwrap();
    assert_eq!(
        due.iter().map(|r| r.id).collect::<Vec<_>>(),
        [first.id, second.id, expired.id]
    );
    let due = t
        .mail_files()
        .due_for_purge(at(3), at(10), 2)
        .await
        .unwrap();
    assert_eq!(
        due.iter().map(|r| r.id).collect::<Vec<_>>(),
        [first.id, second.id]
    );

    // The day's inbound bytes: what the store held, the skipped file not.
    assert_eq!(
        t.mail_files().inbound_bytes_since(at(0)).await.unwrap(),
        2200
    );
    assert_eq!(
        t.mail_files().inbound_bytes_since(at(1)).await.unwrap(),
        1200
    );
    assert_eq!(
        t.mail_files()
            .kept(&[first.id, skipped.id, upload.id, FileId::new_v7()])
            .await
            .unwrap()
            .len(),
        2
    );

    // Marking deleted changes only rows holding bytes, once; the name stays.
    assert_eq!(
        t.mail_files()
            .mark_deleted(&[first.id, skipped.id, expired.id], at(20))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        t.mail_files()
            .mark_deleted(&[first.id], at(21))
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let gone = t.mail_files().get(first.id).await.unwrap().unwrap();
    assert_eq!(
        (gone.state, gone.deleted_at, gone.filename.as_str()),
        (MailFileState::Deleted, Some(at(20)), "teklif.pdf")
    );
    let kept = t.mail_files().get(skipped.id).await.unwrap().unwrap();
    assert_eq!(kept.state, MailFileState::Skipped);
    // A deleted file's bytes still count for the day they were stored.
    assert_eq!(
        t.mail_files().inbound_bytes_since(at(0)).await.unwrap(),
        2200
    );
    assert_eq!(
        t.mail_files()
            .kept(&[first.id, expired.id, upload.id])
            .await
            .unwrap(),
        [upload.id]
    );
    let due = t
        .mail_files()
        .due_for_purge(at(3), at(10), 100)
        .await
        .unwrap();
    assert_eq!(
        due.iter().map(|r| r.id).collect::<Vec<_>>(),
        [second.id, other_email.id]
    );
}

/// A person's erasure reaches the rows of the person, of the people merged into them, and of
/// their conversations' messages: names blanked, rows holding bytes deleted, their ids answered;
/// a skipped row loses its name only. An email dropped because its sender was erased loses its
/// files the same way. Other people's rows are untouched; rules the table holds are refused.
pub async fn erasure_blanks_names_and_answers_the_files_to_delete(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (person, _, _, message) = thread(&f, cap, "Silinecek").await;
    let (alias, alias_cap, _, alias_message) = thread(&f, cap, "Eski").await;
    let (other, other_cap, _, other_message) = thread(&f, cap, "Kalacak").await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.people()
        .mark_merged(alias, Some(person), FIXED_NOW)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let by_message = MailFileRow {
        message_id: Some(message),
        ..inbound(cap, "imap:p:1", 0, 10)
    };
    let skipped = MailFileRow {
        state: MailFileState::Skipped,
        skip_reason: Some(SkipReason::TooManyFiles),
        sha256: None,
        message_id: Some(message),
        person_id: Some(person),
        ..inbound(cap, "imap:p:1", 1, 10)
    };
    let alias_file = MailFileRow {
        message_id: Some(alias_message),
        person_id: Some(alias),
        ..inbound(alias_cap, "imap:q:1", 2, 10)
    };
    let sent = MailFileRow {
        state: MailFileState::Attached,
        expires_at: None,
        message_id: Some(message),
        person_id: Some(person),
        ..staged(3, 100)
    };
    let others = MailFileRow {
        message_id: Some(other_message),
        person_id: Some(other),
        ..inbound(other_cap, "imap:r:1", 4, 10)
    };
    let unlinked = inbound(other_cap, "imap:r:2", 5, 10);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for row in [
        &by_message,
        &skipped,
        &alias_file,
        &sent,
        &others,
        &unlinked,
    ] {
        t.mail_files().insert(row.clone()).await.unwrap();
    }
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut gone = t.mail_files().erase_person(person, at(30)).await.unwrap();
    gone.sort();
    let mut expected = vec![by_message.id, alias_file.id, sent.id];
    expected.sort();
    assert_eq!(gone, expected);
    // Again: names were blanked already, nothing holds bytes any more.
    assert!(
        t.mail_files()
            .erase_person(person, at(31))
            .await
            .unwrap()
            .is_empty()
    );
    // The dropped email of an erased sender.
    assert_eq!(
        t.mail_files()
            .erase_event(other_cap, "imap:r:2", at(32))
            .await
            .unwrap(),
        [unlinked.id]
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    for id in [by_message.id, alias_file.id, sent.id] {
        let row = t.mail_files().get(id).await.unwrap().unwrap();
        assert_eq!(
            (row.state, row.deleted_at, row.filename.as_str()),
            (MailFileState::Deleted, Some(at(30)), "")
        );
    }
    let row = t.mail_files().get(skipped.id).await.unwrap().unwrap();
    assert_eq!(
        (row.state, row.filename.as_str()),
        (MailFileState::Skipped, "")
    );
    let row = t.mail_files().get(unlinked.id).await.unwrap().unwrap();
    assert_eq!(
        (row.state, row.deleted_at, row.filename.as_str()),
        (MailFileState::Deleted, Some(at(32)), "")
    );
    assert_eq!(
        t.mail_files().get(others.id).await.unwrap(),
        Some(others.clone())
    );
    drop(t);

    // Rows that break the table's rules are refused, each in a bundle of its own.
    let broken = [
        MailFileRow {
            skip_reason: Some(SkipReason::DailyLimit),
            ..inbound(cap, "imap:x", 0, 1)
        },
        MailFileRow {
            capability_id: None,
            ..inbound(cap, "imap:x", 0, 1)
        },
        MailFileRow {
            state: MailFileState::Staged,
            ..inbound(cap, "imap:x", 0, 1)
        },
        MailFileRow {
            sha256: None,
            ..inbound(cap, "imap:x", 0, 1)
        },
        MailFileRow {
            state: MailFileState::Deleted,
            ..inbound(cap, "imap:x", 0, 1)
        },
        MailFileRow {
            expires_at: None,
            ..staged(0, 1)
        },
        MailFileRow {
            state: MailFileState::Attached,
            ..staged(0, 1)
        },
        MailFileRow {
            filename: "x".repeat(256),
            ..staged(0, 1)
        },
        MailFileRow {
            message_id: Some(MessageId::new_v7()),
            ..staged(0, 1)
        },
    ];
    for row in broken {
        let mut t = f.uow.tenant(f.ws).await.unwrap();
        let e = t.mail_files().insert(row).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
    }
}

/// A workspace sees, links, purges, erases and counts its own rows only, and cannot name another
/// workspace's capability, message or person.
pub async fn rows_are_workspace_scoped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let cap = f.capability().await;
    let (person, _, _, message) = thread(&f, cap, "Ornek").await;
    let mine = MailFileRow {
        message_id: Some(message),
        person_id: Some(person),
        ..inbound(cap, "imap:a:1", 0, 100)
    };
    let upload = staged(0, 1);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.mail_files().insert(mine.clone()).await.unwrap();
    t.mail_files().insert(upload.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(t.mail_files().get(mine.id).await.unwrap(), None);
    assert_eq!(t.mail_files().lock(upload.id).await.unwrap(), None);
    assert!(
        t.mail_files()
            .for_messages(&[message])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        t.mail_files()
            .due_for_purge(at(100), at(100), 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        t.mail_files()
            .kept(&[mine.id, upload.id])
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(t.mail_files().inbound_bytes_since(at(-1)).await.unwrap(), 0);
    assert_eq!(
        t.mail_files()
            .mark_deleted(&[mine.id, upload.id], at(1))
            .await
            .unwrap(),
        0
    );
    assert!(
        t.mail_files()
            .erase_event(cap, "imap:a:1", at(1))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        t.mail_files()
            .erase_person(person, at(1))
            .await
            .unwrap()
            .is_empty()
    );
    t.commit().await.unwrap();
    // Another workspace's capability, message or person cannot be named.
    for row in [
        inbound(cap, "imap:b:1", 0, 1),
        MailFileRow {
            message_id: Some(message),
            ..staged(0, 1)
        },
        MailFileRow {
            person_id: Some(person),
            ..staged(0, 1)
        },
    ] {
        let mut t = f.uow.tenant(f.other).await.unwrap();
        let e = t.mail_files().insert(row).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
    }
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.mail_files().get(mine.id).await.unwrap(), Some(mine));
    assert_eq!(t.mail_files().get(upload.id).await.unwrap(), Some(upload));
}
