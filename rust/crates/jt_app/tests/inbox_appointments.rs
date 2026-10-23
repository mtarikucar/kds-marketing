mod support;
use jt_app::{
    ports::UnitOfWork,
    usecases::inbox::{appointments, replies},
};
use jt_inbox::*;
use serde_json::json;
use support::{outbound::setup_channel, *};
fn input(w: &World, intent: &str) -> appointments::BookInput {
    serde_json::from_value(json!({"starts_at":(w.owner_ctx.now+time::Duration::hours(4)).format(&time::format_description::well_known::Rfc3339).unwrap(),"ends_at":(w.owner_ctx.now+time::Duration::hours(5)).format(&time::format_description::well_known::Rfc3339).unwrap(),"location":"Office, floor 2","intent":intent})).unwrap()
}
#[tokio::test]
async fn appointment_reminder_one_hour_before() {
    let (w, _, _) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let out = appointments::book(&w.deps, &w.owner_ctx, j, input(&w, "reply"))
        .await
        .unwrap();
    assert_eq!(
        out.reminder.due_at,
        out.appointment.appointment.starts_at - time::Duration::hours(1)
    );
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Appointment
    );
    assert_eq!(out.reminder.status, TaskStatus::Open);
    appointments::held(&w.deps, &w.owner_ctx, out.appointment.id)
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Met
    );
    assert_eq!(w.uow.snapshot().inbox.tasks[0].status, TaskStatus::Done);
}
#[tokio::test]
async fn appointment_ics_uses_both_fences() {
    let (w, _, c) = setup_channel("mailbox").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let refused = appointments::book(&w.deps, &w.owner_ctx, j, input(&w, "commercial"))
        .await
        .unwrap();
    assert_eq!(refused.notification.state, "refused");
    assert!(w.uow.snapshot().inbox.outbox.is_empty());
    assert!(c.calls().is_empty());
    let person = w.uow.snapshot().inbox.journeys[0].person_id;
    jt_app::usecases::inbox::consent::record_consent(&w.deps,&w.owner_ctx,person,
        serde_json::from_value(json!({"channel":"email","kind":"explicit","source":"agent","at":"2020-01-01T00:00:00Z"})).unwrap()).await.unwrap();
    let queued = appointments::enqueue(&w.deps, &w.owner_ctx, j, input(&w, "commercial"))
        .await
        .unwrap();
    assert_eq!(queued.notification.state, "queued");
    let row = w.uow.snapshot().inbox.outbox[0].clone();
    let mail: jt_app::ports::connectors::MailMessage =
        serde_json::from_value(row.intent["mail"].clone()).unwrap();
    assert_eq!(mail.attachments.len(), 1);
    assert_eq!(mail.attachments[0].mime, "text/calendar");
    assert!(
        String::from_utf8(mail.attachments[0].bytes.clone())
            .unwrap()
            .contains("BEGIN:VCALENDAR\r\n")
    );
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.suppressions()
        .insert(Suppression {
            person_id: person,
            channel: Channel::Email,
            reason: SuppressionReason::Manual,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, row.id)
            .await
            .unwrap()
            .state,
        "refused"
    );
    assert!(c.calls().is_empty());
}

#[tokio::test]
async fn appointment_cancel_cancels_exact_reminder_and_queued_mail() {
    let (w, _, c) = setup_channel("mailbox").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let out = appointments::enqueue(&w.deps, &w.owner_ctx, j, input(&w, "reply"))
        .await
        .unwrap();
    let other = appointments::enqueue(&w.deps, &w.owner_ctx, j, input(&w, "reply"))
        .await
        .unwrap();
    let cancelled = appointments::cancel(&w.deps, &w.owner_ctx, out.appointment.id)
        .await
        .unwrap();
    assert_eq!(cancelled.appointment.state, AppointmentState::Cancelled);
    assert_eq!(
        appointments::cancel(&w.deps, &w.owner_ctx, out.appointment.id)
            .await
            .unwrap(),
        cancelled
    );
    assert!(
        appointments::held(&w.deps, &w.owner_ctx, out.appointment.id)
            .await
            .is_err()
    );
    let s = w.uow.snapshot();
    assert_eq!(
        s.inbox
            .tasks
            .iter()
            .find(|t| t.id == out.reminder.id)
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
    assert_eq!(
        s.inbox
            .tasks
            .iter()
            .find(|t| t.id == other.reminder.id)
            .unwrap()
            .status,
        TaskStatus::Open
    );
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, s.inbox.outbox[0].id)
            .await
            .unwrap()
            .state,
        "refused"
    );
    assert!(c.calls().is_empty());
}

#[tokio::test]
async fn appointment_unknown_mail_is_durable_and_never_resent() {
    let (w, _, c) = setup_channel("mailbox").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_mail(Err(jt_connector::ConnectorError::unknown(
        "lost mail acknowledgement",
    )));
    let out = appointments::book(&w.deps, &w.owner_ctx, j, input(&w, "reply"))
        .await
        .unwrap();
    assert_eq!(out.notification.state, "unknown");
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.appointments.len(), 1);
    assert_eq!(s.inbox.tasks.len(), 1);
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, s.inbox.outbox[0].id)
            .await
            .unwrap()
            .state,
        "unknown"
    );
    assert_eq!(c.calls().len(), 1);
    match &c.calls()[0] {
        jt_testkit::fakes::ConnectorCall::SendMail { message, .. } => {
            assert_eq!(
                message.message_id,
                s.inbox.outbox[0].intent["mail"]["message_id"]
            );
            assert_eq!(message.attachments.len(), 1);
            assert!(
                String::from_utf8(message.attachments[0].bytes.clone())
                    .unwrap()
                    .contains("BEGIN:VCALENDAR\r\n")
            );
        }
        _ => panic!("mail sender expected"),
    }
}

#[tokio::test]
async fn invalid_or_unauthorized_appointment_leaves_no_rows() {
    let (w, _, _) = setup_channel("mailbox").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let mut bad = input(&w, "reply");
    bad.ends_at = bad.starts_at;
    assert!(
        appointments::book(&w.deps, &w.owner_ctx, j, bad)
            .await
            .is_err()
    );
    let mut ctx = w.owner_ctx.clone();
    ctx.permissions.clear();
    assert!(
        appointments::book(&w.deps, &ctx, j, input(&w, "reply"))
            .await
            .is_err()
    );
    let s = w.uow.snapshot();
    assert!(s.inbox.appointments.is_empty());
    assert!(s.inbox.tasks.is_empty());
    assert!(s.inbox.outbox.is_empty());
    assert!(s.inbox.events.is_empty());
}

#[tokio::test]
async fn appointment_cancel_on_terminal_journey() {
    for (kind, payload) in [
        ("lost", json!({"reason_key":"fiyat"})),
        (
            "won",
            json!({"product":"Plan","amount_minor":1000,"currency":"TRY"}),
        ),
    ] {
        let (w, _, _) = setup_channel("mailbox").await;
        let j = w.uow.snapshot().inbox.journeys[0].id;
        let booked = appointments::enqueue(&w.deps, &w.owner_ctx, j, input(&w, "reply"))
            .await
            .unwrap();
        jt_app::usecases::inbox::journeys::report(
            &w.deps,
            &w.owner_ctx,
            j,
            serde_json::from_value(
                json!({"kind":kind,"idempotency_key":"close","payload":payload}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let before = w.uow.snapshot();
        let cancelled = appointments::cancel(&w.deps, &w.owner_ctx, booked.appointment.id)
            .await
            .unwrap();
        assert_eq!(cancelled.appointment.state, AppointmentState::Cancelled);
        assert_eq!(
            appointments::cancel(&w.deps, &w.owner_ctx, booked.appointment.id)
                .await
                .unwrap(),
            cancelled
        );
        let after = w.uow.snapshot();
        // Cancelling a reminder touches the activity timestamp, but never the reducer.
        assert_eq!(
            after.inbox.journey_reducer_revisions,
            before.inbox.journey_reducer_revisions
        );
        let mut expected = before.inbox.journeys;
        assert!(after.inbox.journeys[0].updated_at >= expected[0].updated_at);
        expected[0].updated_at = after.inbox.journeys[0].updated_at;
        assert_eq!(after.inbox.journeys, expected);
        assert_eq!(after.inbox.events, before.inbox.events);
        assert_eq!(
            after
                .inbox
                .tasks
                .iter()
                .find(|t| t.id == booked.reminder.id)
                .unwrap()
                .status,
            TaskStatus::Cancelled
        );
        assert!(
            appointments::held(&w.deps, &w.owner_ctx, booked.appointment.id)
                .await
                .is_err()
        );
    }
}
