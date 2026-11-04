//! Outreach's stop hooks and report (plan L4-T6; spec 2026-10-30-leads-pool-outreach-design.md
//! §3.14, §3.16, D16, D18, D22): a reply, a bounce, a complaint, withdrawn consent, a meeting, a
//! won or lost journey, an erasure and a merge stop the person's sequence at once; an outreach
//! receipt records the touch without moving the journey; the send rows follow the outbox; the
//! report counts by step and template. Every value is invented.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::ports::UnitOfWork;
use jt_app::usecases::inbox::{appointments, consent, erasure, journeys, merge, people, replies};
use jt_app::usecases::outreach::{self, PersonalizeInput, PersonalizeItem, report};
use jt_app::usecases::prospects::{self, DecideInput, DecideKind};
use jt_app::usecases::work::{self, WorkKind};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::{ConvState, JourneyEventKind, JourneyStatus, PersonId};
use jt_outreach::{CampaignId, EnrollmentStatus, SendOutcome, StopReason};
use jt_prospects::{CreateInput, EntityKind, FieldInput, SourceRefInput};
use jt_testkit::fakes::FIXED_NOW;
use outreach_support::*;
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

fn minutes(n: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(n)
}

/// A consented person called `name` at `<name>@example.invalid`.
async fn consented_as(w: &World, name: &str) -> PersonId {
    let p = person(w, name, &format!("{}@example.invalid", name.to_lowercase())).await;
    consent_email(w, p).await;
    p
}

async fn hello(w: &World) -> jt_outreach::TemplateId {
    template(w, &w.owner_ctx, "Merhaba", "Tanışmak isteriz.").await
}

/// Steps may follow each other at once and up to 30 a month (the frequency cap off).
async fn no_frequency_cap(w: &World) {
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"frequency": {"min_gap_days": 0, "max_per_30_days": 30}}))
            .unwrap(),
    )
    .await
    .unwrap();
}

/// A running two-step campaign (the second five days later) reaching `people`, whose first
/// steps went out at `FIXED_NOW` and the minutes after.
async fn two_steps_sent(o: &Outreach, people: &[PersonId]) -> CampaignId {
    let t = hello(&o.w).await;
    let c = running(
        o,
        definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": people })),
    )
    .await;
    for m in 0..people.len() {
        o.mail.push_mail(accepted("s"));
        dispatch(&o.w, minutes(m as i64)).await;
    }
    c.campaign.id
}

fn enrollment_of(w: &World, c: CampaignId, p: PersonId) -> jt_app::ports::outreach::EnrollmentRow {
    enrollments(w, c)
        .into_iter()
        .find(|e| e.person_id == p)
        .unwrap()
}

/// The send row whose email went to `person`'s enrollment in `c`.
fn send_to(w: &World, c: CampaignId, person: PersonId) -> jt_app::ports::outreach::SendRow {
    let e = enrollment_of(w, c, person);
    sends(w)
        .into_iter()
        .find(|s| s.enrollment_id == e.id)
        .unwrap()
}

/// An email from `from` arriving at `at` through the mailbox, consumed by the inbox.
async fn inbound_mail(o: &Outreach, from: &str, in_reply_to: Option<&str>, at: OffsetDateTime) {
    let w = &o.w;
    let n = InboundEventId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: n,
                workspace_id: w.ws,
                capability_id: Some(o.mailbox),
                provider: Provider::Mail,
                external_id: format!("imap:account:INBOX:1:{n}"),
                kind: EventKind::Message,
                payload: json!({
                    "from": from, "subject": "Re: Merhaba", "text": "İlgileniyoruz, arayın.",
                    "message_id": format!("<in-{n}@example.invalid>"), "in_reply_to": in_reply_to,
                }),
                received_at: at,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = jt_app::usecases::jobs::run_inbox_consume(&w.deps, at).await;
    assert_eq!(report.failed, 0);
}

/// The adapter's bounce (or complaint) fixture about the email `message_id`, consumed.
async fn mail_evidence(o: &Outreach, message_id: &str, complaint: bool, at: OffsetDateTime) {
    let w = &o.w;
    let fixture: &[u8] = if complaint {
        include_bytes!("../../adapters/jt_mail/tests/fixtures/complaint.eml")
    } else {
        include_bytes!("../../adapters/jt_mail/tests/fixtures/bounce.eml")
    };
    let raw = String::from_utf8(fixture.to_vec())
        .unwrap()
        .replace("<original@example.com>", message_id);
    let n = InboundEventId::new_v7();
    let draft = jt_mail::parse_message("account", "INBOX", 42, 2, raw.as_bytes(), false).unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: n,
                workspace_id: w.ws,
                capability_id: Some(o.mailbox),
                provider: Provider::Mail,
                external_id: format!("{}:{n}", draft.external_id),
                kind: draft.kind,
                payload: draft.payload,
                received_at: at,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let report = jt_app::usecases::jobs::run_inbox_consume(&w.deps, at).await;
    assert_eq!(report.failed, 0);
}

/// The Message-ID of the email sent to `person` in `c`.
fn message_id(w: &World, c: CampaignId, person: PersonId) -> String {
    format!("<{}@panel.test>", send_to(w, c, person).outbox_id)
}

/// The open (or latest) journey of `person`.
async fn journey_of(w: &World, person: PersonId) -> jt_inbox::Journey {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    match r.journeys().open_for(person).await.unwrap() {
        Some(j) => j,
        None => r.journeys().latest_for(person).await.unwrap().unwrap(),
    }
}

fn report_event(kind: &str, key: &str, payload: serde_json::Value) -> journeys::ReportInput {
    serde_json::from_value(json!({"kind": kind, "idempotency_key": key, "payload": payload}))
        .unwrap()
}

#[tokio::test]
async fn threaded_reply_marks_that_send() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    let id = message_id(w, c, ada);
    inbound_mail(&o, "ada@example.invalid", Some(&id), minutes(30)).await;
    let send = send_to(w, c, ada);
    assert_eq!(send.replied_threaded, Some(true));
    assert_eq!(send.replied_at, Some(minutes(30)));
    assert_eq!(enrollment_of(w, c, ada).stop, Some(StopReason::Replied));
    let entry = w.entries("outreach.enrollment_stopped").pop().unwrap();
    assert_eq!(entry.payload["reason"], "replied");
    assert!(!entry.payload.to_string().contains("example.invalid"));
}

#[tokio::test]
async fn unthreaded_reply_marks_latest_within_30_days() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let c = two_steps_sent(&o, &[ada, bora]).await;
    // Ada answers in a new thread the same day: her latest outreach email is the one replied.
    inbound_mail(&o, "ada@example.invalid", None, minutes(60)).await;
    let ada_send = send_to(w, c, ada);
    assert_eq!(ada_send.replied_threaded, Some(false));
    assert_eq!(enrollment_of(w, c, ada).stop, Some(StopReason::Replied));
    // Bora writes 31 days later: no outreach email of the last 30 days to mark, but the
    // sequence still stops.
    let later = FIXED_NOW + Duration::days(31);
    w.uow.edit(|s| {
        for (_, e) in &mut s.outreach.enrollments {
            if e.person_id == bora {
                e.next_send_at = Some(later + Duration::days(1));
            }
        }
    });
    inbound_mail(&o, "bora@example.invalid", None, later).await;
    let bora_send = send_to(w, c, bora);
    assert_eq!(bora_send.replied_at, None);
    assert_eq!(enrollment_of(w, c, bora).stop, Some(StopReason::Replied));
}

#[tokio::test]
async fn reply_stops_every_active_enrollment_of_the_person() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let c = two_steps_sent(&o, &[ada, bora]).await;
    // A second campaign reaches Ada too: she is active in the first, so skipped there.
    let t = hello(w).await;
    let second = running(
        &o,
        definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": [ada] })),
    )
    .await;
    assert_eq!(
        enrollment_of(w, second.campaign.id, ada).skip,
        Some(jt_outreach::SkipReason::ActiveElsewhere)
    );
    inbound_mail(&o, "ada@example.invalid", None, minutes(90)).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(
        r.outreach_enrollments().active_for(ada).await.unwrap(),
        None
    );
    drop(r);
    assert_eq!(enrollment_of(w, c, ada).stop, Some(StopReason::Replied));
    assert_eq!(
        enrollment_of(w, c, bora).status,
        EnrollmentStatus::Active,
        "only the person who wrote"
    );
    // A message from before the enrollment (a late poll) does not stop it.
    let cem = consented_as(w, "Cem").await;
    let c2 = {
        let t = hello(w).await;
        running(
            &o,
            definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": [cem] })),
        )
        .await
        .campaign
        .id
    };
    inbound_mail(
        &o,
        "cem@example.invalid",
        None,
        FIXED_NOW - Duration::days(2),
    )
    .await;
    assert_eq!(enrollment_of(w, c2, cem).status, EnrollmentStatus::Active);
}

#[tokio::test]
async fn reply_makes_conversation_ours_and_reply_due() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    let id = message_id(w, c, ada);
    inbound_mail(&o, "ada@example.invalid", Some(&id), minutes(30)).await;
    let conv = w
        .uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|conv| conv.person_id == ada)
        .unwrap();
    assert_eq!(conv.state, ConvState::Ours);
    // The agent answers the conversation (it is the agent's, as every outreach one is).
    let agent = w.agent(&["workspace.read", "inbox.work"]).await;
    let pending = work::pending(&w.deps, &at(&agent, minutes(31)))
        .await
        .unwrap();
    assert!(pending.items.iter().any(|i| i.kind
        == WorkKind::ReplyDue {
            conversation_id: conv.id
        }));
}

fn evidence(value: &str) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.into(),
        sources: vec![SourceRefInput::Url {
            url: "https://kaynak.example.invalid/iletisim".into(),
            note: None,
        }],
        captured_at: FIXED_NOW - Duration::days(1),
    })
}

/// A qualified prospect called `name` with the email `email`.
async fn qualified_prospect(w: &World, name: &str, email: &str) -> jt_prospects::ProspectId {
    let p = prospects::create(
        &w.deps,
        &w.owner_ctx,
        CreateInput {
            business_name: name.into(),
            entity_kind: EntityKind::LegalEntity,
            sector: Some("kafe".into()),
            city: Some("İstanbul".into()),
            district: None,
            language: Some("tr".into()),
            segment_key: None,
            country: None,
            labels: vec![],
            phone: None,
            email: evidence(email),
            website: None,
            instagram: None,
            tiktok: None,
            address: None,
            contact_person: None,
            size: None,
            signals: vec![],
            notes: String::new(),
            research_task_id: None,
            discovered_at: vec![],
            distinct_from: vec![],
            request_key: None,
        },
    )
    .await
    .unwrap()
    .prospect;
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        DecideInput {
            decision: DecideKind::Qualify,
            reason: None,
            note: None,
            expected_revision: p.revision,
        },
    )
    .await
    .unwrap()
    .prospect
    .id
}

#[tokio::test]
async fn bounce_marks_send_stops_and_flags_prospect_email() {
    let o = outreach_world().await;
    let w = &o.w;
    open_b2b(w, false).await;
    let id = qualified_prospect(w, "Örnek Kafe", "info@ornek-kafe.example.invalid").await;
    let t = hello(w).await;
    let c = running(
        &o,
        definition_steps(
            &[(t, 0), (t, 5)],
            json!({"prospects": {"cities": ["istanbul"]}}),
        ),
    )
    .await;
    assert_eq!(c.enrollment.as_ref().unwrap().enrolled, 1);
    o.mail.push_mail(accepted("b1"));
    dispatch(w, FIXED_NOW).await;
    let e = enrollments(w, c.campaign.id).pop().unwrap();
    let person = e.person_id;
    let mid = message_id(w, c.campaign.id, person);
    mail_evidence(&o, &mid, false, minutes(20)).await;
    let send = send_to(w, c.campaign.id, person);
    assert_eq!(send.outcome, SendOutcome::Bounced);
    assert_eq!(
        enrollment_of(w, c.campaign.id, person).stop,
        Some(StopReason::Bounced)
    );
    let p = w
        .uow
        .snapshot()
        .prospects
        .prospects
        .into_iter()
        .find(|p| p.id == id)
        .unwrap();
    let email = p.contact.email.unwrap();
    assert!(!email.deliverable, "the bounced address is undeliverable");
    assert_eq!(email.value, "info@ornek-kafe.example.invalid");
    let entry = w.entries("prospects.updated").pop().unwrap();
    assert_eq!(entry.payload["fields"], json!(["email"]));
    assert!(!entry.payload.to_string().contains("example.invalid"));
}

#[tokio::test]
async fn complaint_counts_for_auto_pause() {
    let o = outreach_world().await;
    let w = &o.w;
    let mut people = Vec::new();
    for name in ["Ada", "Bora", "Cem", "Deniz"] {
        people.push(consented_as(w, name).await);
    }
    let c = two_steps_sent(&o, &people).await;
    for p in &people[..2] {
        let mid = message_id(w, c, *p);
        mail_evidence(&o, &mid, true, minutes(20)).await;
        assert_eq!(send_to(w, c, *p).outcome, SendOutcome::Complained);
        assert_eq!(enrollment_of(w, c, *p).stop, Some(StopReason::Complained));
    }
    dispatch(w, minutes(30)).await;
    let out = outreach::campaigns_get(&w.deps, &w.owner_ctx, c)
        .await
        .unwrap();
    assert_eq!(out.campaign.status, jt_outreach::CampaignStatus::Paused);
    assert_eq!(
        out.campaign.pause_reason,
        Some(jt_outreach::PauseReason::Complaints)
    );
}

#[tokio::test]
async fn withdrawn_consent_stops() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    consent::record_consent(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({"channel": "email", "kind": "withdrawn",
            "source": "customer", "at": FIXED_NOW.format(&Rfc3339).unwrap()}))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        enrollment_of(w, c, ada).stop,
        Some(StopReason::ConsentWithdrawn)
    );
}

#[tokio::test]
async fn meeting_booked_stops() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    let j = journey_of(w, ada).await;
    appointments::enqueue(
        &w.deps,
        &w.owner_ctx,
        j.id,
        serde_json::from_value(json!({
            "starts_at": (FIXED_NOW + Duration::days(3)).format(&Rfc3339).unwrap(),
            "ends_at": (FIXED_NOW + Duration::days(3) + Duration::hours(1)).format(&Rfc3339).unwrap(),
            "location": "Ofis", "intent": "reply",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        enrollment_of(w, c, ada).stop,
        Some(StopReason::MeetingBooked)
    );
}

#[tokio::test]
async fn won_and_lost_stop() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let c = two_steps_sent(&o, &[ada, bora]).await;
    let won = journey_of(w, ada).await;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        won.id,
        report_event(
            "won",
            "won-1",
            json!({"product": "Kahve makinesi", "amount_minor": 1_500_000, "currency": "TRY"}),
        ),
    )
    .await
    .unwrap();
    let lost = journey_of(w, bora).await;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        lost.id,
        report_event("lost", "lost-1", json!({"reason_key": "fiyat"})),
    )
    .await
    .unwrap();
    assert_eq!(enrollment_of(w, c, ada).stop, Some(StopReason::JourneyWon));
    assert_eq!(
        enrollment_of(w, c, bora).stop,
        Some(StopReason::JourneyLost)
    );
}

#[tokio::test]
async fn erasure_stops_and_keeps_ids() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = template(
        w,
        &w.owner_ctx,
        "Merhaba",
        "{{custom.opener|Merhaba}}, tanışalım.",
    )
    .await;
    let c = running(
        &o,
        definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": [ada] })),
    )
    .await
    .campaign
    .id;
    let e = enrollment_of(w, c, ada);
    outreach::personalize(
        &w.deps,
        &w.owner_ctx,
        PersonalizeInput {
            items: vec![PersonalizeItem {
                enrollment_id: e.id,
                values: [("opener".to_owned(), "Ada Hanım".to_owned())].into(),
            }],
        },
    )
    .await
    .unwrap();
    o.mail.push_mail(accepted("e1"));
    dispatch(w, FIXED_NOW).await;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        ada,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let after = enrollment_of(w, c, ada);
    assert_eq!(after.id, e.id, "the row and its ids stay");
    assert_eq!(after.stop, Some(StopReason::PersonErased));
    assert!(
        after.personalization.is_empty(),
        "the recipient's text goes"
    );
    assert_eq!(sends(w).len(), 1, "the send row stays for the reports");
    assert_eq!(sends(w)[0].enrollment_id, e.id);
}

#[tokio::test]
async fn merge_stops_source_enrollments() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    // A second record of Ada, her journey closed, then given her address: a suggested merge.
    let twin = person(w, "Ada K.", "ada.k@example.invalid").await;
    let j = journey_of(w, twin).await;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        j.id,
        report_event("lost", "twin-lost", json!({"reason_key": "fiyat"})),
    )
    .await
    .unwrap();
    people::add_identity(
        &w.deps,
        &w.owner_ctx,
        twin,
        serde_json::from_value(json!({"channel": "email", "value": "ada@example.invalid"}))
            .unwrap(),
    )
    .await
    .unwrap();
    let suggestion = merge::list(&w.deps, &w.owner_ctx).await.unwrap().remove(0);
    merge::apply(
        &w.deps,
        &w.owner_ctx,
        suggestion.id,
        merge::ApplyInput { keep: twin },
    )
    .await
    .unwrap();
    assert_eq!(
        enrollment_of(w, c, ada).stop,
        Some(StopReason::PersonMerged)
    );
}

#[tokio::test]
async fn outreach_receipt_keeps_journey_new() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    let j = journey_of(w, ada).await;
    assert_eq!(j.status, JourneyStatus::New, "a cold send never contacts");
    let events = w
        .uow
        .snapshot()
        .inbox
        .events
        .into_iter()
        .filter(|ev| ev.journey_id == j.id)
        .map(|ev| ev.kind)
        .collect::<Vec<_>>();
    assert!(events.contains(&JourneyEventKind::OutreachSent {
        campaign_id: c.as_uuid(),
        step: 1,
    }));
    assert!(!events.contains(&JourneyEventKind::Replied));
    // The send row follows the outbox: sent, at the time it was handed over.
    let send = send_to(w, c, ada);
    assert_eq!(send.outcome, SendOutcome::Sent);
    assert_eq!(send.sent_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn our_answer_after_reply_moves_to_contacted() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    let id = message_id(w, c, ada);
    inbound_mail(&o, "ada@example.invalid", Some(&id), minutes(30)).await;
    assert_eq!(journey_of(w, ada).await.status, JourneyStatus::New);
    let conv = w
        .uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|conv| conv.person_id == ada)
        .unwrap();
    o.mail.push_mail(accepted("answer"));
    replies::reply(
        &w.deps,
        &at(&w.owner_ctx, minutes(40)),
        conv.id,
        serde_json::from_value(json!({"text": "Teşekkürler, yarın arayalım.", "intent": "reply"}))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(journey_of(w, ada).await.status, JourneyStatus::Contacted);
}

#[tokio::test]
async fn a_refused_claim_marks_the_send_refused() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = two_steps_sent(&o, &[ada]).await;
    // Put back as queued, as a crash before its claim leaves it; the campaign is paused.
    let mut id = None;
    w.uow.edit(|s| {
        let row = s.inbox.outbox.last_mut().unwrap();
        row.state = "queued".into();
        row.fence_snapshot = None;
        id = Some(row.id);
    });
    w.uow.edit(|s| {
        for (_, send) in &mut s.outreach.sends {
            send.outcome = SendOutcome::Queued;
            send.sent_at = None;
        }
    });
    outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c,
        outreach::ControlInput {
            action: outreach::ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    let out = replies::send_step(&w.deps, &w.owner_ctx, id.unwrap())
        .await
        .unwrap();
    assert_eq!(out.state, "refused");
    assert_eq!(send_to(w, c, ada).outcome, SendOutcome::Refused);
}

#[tokio::test]
async fn outreach_report_counts_by_step_and_template() {
    let o = outreach_world().await;
    let w = &o.w;
    no_frequency_cap(w).await;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let first = template(w, &w.owner_ctx, "Merhaba", "Tanışmak isteriz.").await;
    let second = template(w, &w.owner_ctx, "Tekrar merhaba", "Bir daha yazıyoruz.").await;
    let c = running(
        &o,
        definition_steps(
            &[(first, 0), (second, 1)],
            json!({ "explicit": [ada, bora] }),
        ),
    )
    .await
    .campaign
    .id;
    for m in 0..2 {
        o.mail.push_mail(accepted("r"));
        dispatch(w, minutes(m)).await;
    }
    // Bora answers the first email; Ada gets the second a day later.
    let bora_id = message_id(w, c, bora);
    inbound_mail(&o, "bora@example.invalid", Some(&bora_id), minutes(10)).await;
    o.mail.push_mail(accepted("r2"));
    dispatch(w, FIXED_NOW + Duration::days(1) + Duration::minutes(5)).await;
    assert_eq!(sends(w).len(), 3);
    let range = |group_by| report::ReportInput {
        campaign_id: None,
        from: FIXED_NOW.format(&Rfc3339).unwrap(),
        to: (FIXED_NOW + Duration::days(7)).format(&Rfc3339).unwrap(),
        group_by,
    };
    let by_step = report::report(&w.deps, &w.owner_ctx, range(report::GroupBy::Step))
        .await
        .unwrap();
    assert_eq!(by_step.groups.len(), 2);
    let one = &by_step.groups[0];
    assert_eq!(
        (one.campaign_id, one.step, one.template_id),
        (Some(c), Some(1), Some(first))
    );
    assert_eq!((one.sent, one.enrolled), (2, 2));
    assert_eq!((one.replied, one.replied_threaded), (1, 1));
    assert_eq!(one.stopped.get("replied"), Some(&1));
    assert_eq!(one.unique_clicks, None, "click tracking is off");
    let two = &by_step.groups[1];
    assert_eq!((two.step, two.template_id), (Some(2), Some(second)));
    assert_eq!((two.sent, two.enrolled, two.replied), (1, 0, 0));
    let by_template = report::report(&w.deps, &w.owner_ctx, range(report::GroupBy::Template))
        .await
        .unwrap();
    let sent: Vec<_> = by_template
        .groups
        .iter()
        .map(|g| (g.template_id, g.campaign_id, g.sent))
        .collect();
    let mut expected = vec![(Some(first), None, 2), (Some(second), None, 1)];
    expected.sort();
    let mut got = sent;
    got.sort();
    assert_eq!(got, expected);
    let by_campaign = report::report(&w.deps, &w.owner_ctx, range(report::GroupBy::Campaign))
        .await
        .unwrap();
    assert_eq!(by_campaign.groups.len(), 1);
    assert_eq!(by_campaign.groups[0].sent, 3);
    // A range that starts after the sends counts none of them.
    let later = report::report(
        &w.deps,
        &w.owner_ctx,
        report::ReportInput {
            campaign_id: Some(c),
            from: (FIXED_NOW + Duration::days(2)).format(&Rfc3339).unwrap(),
            to: (FIXED_NOW + Duration::days(3)).format(&Rfc3339).unwrap(),
            group_by: report::GroupBy::Campaign,
        },
    )
    .await
    .unwrap();
    assert!(later.groups.iter().all(|g| g.sent == 0));
    // Outreach's report needs outreach.work; a backwards range is refused.
    let rep = w.member("rep").await;
    let e = err(report::report(&w.deps, &rep, range(report::GroupBy::Step)).await);
    assert_forbidden(&e, "outreach.work");
    let e = err(report::report(
        &w.deps,
        &w.owner_ctx,
        report::ReportInput {
            campaign_id: None,
            from: FIXED_NOW.format(&Rfc3339).unwrap(),
            to: FIXED_NOW.format(&Rfc3339).unwrap(),
            group_by: report::GroupBy::Step,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "not_after_from");
}
