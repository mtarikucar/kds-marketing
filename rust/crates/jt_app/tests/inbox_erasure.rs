mod support;
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::inbox::{erasure, journeys, people},
};
use jt_inbox::*;
use serde_json::json;
use support::*;

async fn setup() -> (World, PersonId) {
    let w = world().await;
    let p = people::create(&w.deps, &w.owner_ctx, serde_json::from_value(json!({"display_name":"Ada", "source":"form", "identities":[{"channel":"email","value":" Ada@Example.com "}]})).unwrap()).await.unwrap().person;
    (w, p.id)
}
#[tokio::test]
async fn erase_requires_confirm_manage() {
    let (w, p) = setup().await;
    let mut ctx = w.owner_ctx.clone();
    ctx.permissions.remove(&jt_tenancy::Permission::InboxManage);
    assert_eq!(
        erasure::erase(&w.deps, &ctx, p, erasure::EraseInput { confirm: true })
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        erasure::erase(
            &w.deps,
            &w.owner_ctx,
            p,
            erasure::EraseInput { confirm: false }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Validation
    );
    assert!(w.uow.snapshot().inbox.erasure_logs.is_empty());
}
#[tokio::test]
async fn erase_keeps_anonymous_ids_amounts_and_tombstone() {
    let (w, p) = setup().await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(&w.deps,&w.owner_ctx,j,serde_json::from_value(json!({"kind":"won","idempotency_key":"sale","payload":{"product":"Ada private plan","amount_minor":15000,"currency":"TRY"}})).unwrap()).await.unwrap();
    let before = w.uow.snapshot();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.people[0].id, p);
    assert_eq!(after.inbox.people[0].display_name, "silinmiş kişi");
    assert!(after.inbox.people[0].erased_at.is_some());
    assert!(after.inbox.identities.is_empty());
    assert_eq!(after.inbox.erasure_logs.len(), 1);
    assert_eq!(after.inbox.erased_identities.len(), 1);
    assert_eq!(after.inbox.commissions, before.inbox.commissions);
    assert_eq!(after.inbox.events[0].id, before.inbox.events[0].id);
    assert!(
        matches!(&after.inbox.events[0].kind,JourneyEventKind::Won{product,amount_minor:15000,..} if product.is_empty())
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        r.erasure()
            .is_erased_identity(
                IdentityChannel::Email,
                &identity_hash(IdentityChannel::Email, "ada@example.com")
            )
            .await
            .unwrap()
    );
    let err=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada", "source":"form", "identities":[{"channel":"email","value":"ada@example.com"}]})).unwrap()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn erased_journey_refuses_personal_writes() {
    use jt_app::usecases::inbox::tasks;
    let (w, p) = setup().await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let note = tasks::add_note(
        &w.deps,
        &w.owner_ctx,
        j,
        tasks::NoteInput {
            text: "Private note".into(),
        },
    )
    .await
    .unwrap_err();
    let task = tasks::create(
        &w.deps,
        &w.owner_ctx,
        j,
        tasks::CreateInput {
            title: "Private task".into(),
            due_at: w.owner_ctx.now,
            assignee: None,
        },
    )
    .await
    .unwrap_err();
    let report = journeys::report(&w.deps, &w.owner_ctx, j, serde_json::from_value(json!({"kind":"won","idempotency_key":"after-erase","payload":{"product":"Private plan","amount_minor":1000,"currency":"TRY"}})).unwrap()).await.unwrap_err();
    for err in [note, task, report] {
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(err.details["reason"], "person_erased");
    }
    let s = w.uow.snapshot();
    assert!(s.inbox.notes.is_empty());
    assert!(s.inbox.tasks.is_empty());
    assert!(s.inbox.events.is_empty());
}

#[tokio::test]
async fn repeat_erasure_scrubs_late_personal_writes() {
    let (w, p) = setup().await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.notes()
        .insert(Note {
            id: NoteId::new_v7(),
            workspace_id: w.ws,
            journey_id: j,
            author: EventSource::System,
            text: "Legacy private write".into(),
            at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert!(w.uow.snapshot().inbox.notes[0].text.is_empty());
}

#[tokio::test]
async fn imap_uidvalidity_reset_after_erasure_stores_nothing_personal() {
    use jt_app::{
        ports::connectors::{InboundEventDraft, MailboxCursor, MailboxPosition},
        usecases::jobs,
    };
    use jt_connector::EventKind;
    let (w, _, mail) = support::outbound::setup_channel("mailbox").await;
    let p = w.uow.snapshot().inbox.people[0].id;
    let cap = w.uow.snapshot().inbox.conversations[0].capability_id;
    for validity in [7, 8] {
        let next = MailboxCursor {
            mailboxes: [(
                "INBOX".into(),
                MailboxPosition {
                    uidvalidity: validity,
                    last_uid: 1,
                },
            )]
            .into_iter()
            .collect(),
            read_history: false,
        };
        mail.push_mailbox_poll(Ok((vec![InboundEventDraft {
            external_id: format!("imap:support@example.com:INBOX:{validity}:1"), kind: EventKind::Message,
            payload: json!({"from":"ADA@example.com","text":"Private replay","message_id":"<replayed@example.com>"}), occurred_at: None,
        }], next.clone())));
        assert_eq!(
            jobs::run_mail_inbox_poll(&w.deps, w.owner_ctx.now)
                .await
                .failed,
            0
        );
        if validity == 7 {
            assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
            erasure::erase(
                &w.deps,
                &w.owner_ctx,
                p,
                erasure::EraseInput { confirm: true },
            )
            .await
            .unwrap();
        }
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        assert_eq!(r.mail_cursors().get(cap).await.unwrap(), next);
        drop(r);
        for row in &w.uow.snapshot().inbound_events {
            assert!(!row.event.payload.to_string().contains("ADA@example.com"));
            assert!(!row.event.payload.to_string().contains("Private replay"));
            assert!(row.raw.is_none());
        }
    }
    assert_eq!(w.uow.snapshot().inbox.people.len(), 1);
    assert_eq!(w.uow.snapshot().inbox.messages.len(), 1);
    assert!(w.uow.snapshot().inbox.messages[0].body.is_empty());
}

#[tokio::test]
async fn webhook_erasure_scrubs_entire_raw_batch_before_first_insert() {
    use jt_app::{ports::connectors::InboundEventDraft, usecases::webhook};
    use jt_connector::{EventKind, NetgsmPurpose};
    let (w, _, _) = support::outbound::setup_channel("sms_line").await;
    let p = w.uow.snapshot().inbox.people[0].id;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let drafts = [
        ("a-unrelated", "+905331234567", "Other body"),
        ("z-erased", "05321234567", "Private body"),
    ]
    .into_iter()
    .map(|(id, from, text)| InboundEventDraft {
        external_id: id.into(),
        kind: EventKind::Message,
        payload: json!({"from":from,"text":text}),
        occurred_at: None,
    })
    .collect();
    webhook::receive_netgsm(
        &w.deps,
        w.ws,
        NetgsmPurpose::Mo,
        drafts,
        b"05321234567 Private body and other body",
    )
    .await
    .unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.inbound_events.len(), 2);
    assert!(s.inbound_events.iter().all(|e| e.raw.is_none()));
    let unrelated = s
        .inbound_events
        .iter()
        .find(|e| e.event.external_id == "a-unrelated")
        .unwrap();
    assert_eq!(
        unrelated.event.payload,
        json!({"from":"+905331234567","text":"Other body"})
    );
    let erased = s
        .inbound_events
        .iter()
        .find(|e| e.event.external_id == "z-erased")
        .unwrap();
    assert_eq!(erased.event.payload["from"], "");
    assert_eq!(erased.event.payload["text"], "");
}

#[tokio::test]
async fn erased_sms_jobs_are_not_polled_and_ignore_inflight_reports() {
    use jt_app::{
        ports::{
            compliance::{OutboundJobRow, OutboundJobState},
            connectors::{DeliveryState, DeliveryStatus},
        },
        usecases::jobs,
    };
    let (w, c, connector) = support::outbound::setup_channel("sms_line").await;
    let snapshot = w.uow.snapshot();
    let p = snapshot.inbox.people[0].id;
    let cap = snapshot.inbox.conversations[0].capability_id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let m = MessageId::new_v7();
    r.messages()
        .insert_if_new(Message {
            id: m,
            workspace_id: w.ws,
            conversation_id: c,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "Private SMS".into(),
            external_id: Some("job".into()),
            status: MsgStatus::Sent,
            cost_minor: None,
            at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    let id = uuid::Uuid::now_v7();
    r.outbound_jobs()
        .insert(OutboundJobRow {
            id,
            workspace_id: w.ws,
            capability_id: cap,
            provider_job_id: Some("job".into()),
            message_id: Some(m),
            state: OutboundJobState::Sent,
            last_status: None,
            created_at: w.owner_ctx.now,
            updated_at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        p,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let polled = jobs::run_netgsm_dlr_poll(&w.deps, w.owner_ctx.now).await;
    assert_eq!(polled.failed, 0);
    assert_eq!(polled.touched, 0);
    assert!(connector.calls().is_empty());
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.outbound_jobs()
        .record_status(
            w.ws,
            cap,
            vec![DeliveryStatus {
                job_id: "job".into(),
                recipient: "+905321234567".into(),
                status: DeliveryState::Delivered,
                at: None,
                raw_code: "1".into(),
            }],
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.outbound_jobs[0].row.state, OutboundJobState::Erased);
    assert!(s.outbound_jobs[0].row.last_status.is_none());
    assert!(s.outbound_jobs[0].status.is_none());
}
