//! Enrollment, personalization and the outreach dispatcher (plan L4-T5; spec
//! 2026-10-30-leads-pool-outreach-design.md §3.10–§3.12): the audience frozen into
//! enrollments, every send through the outbox with its footer, the budgets, the stop rules
//! checked at dispatch and again at claim, and the İYS lookup of business-basis sends.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::IysAnswer;
use jt_app::usecases::inbox::replies;
use jt_app::usecases::outreach::{
    self, EnrollInput, PersonalizeInput, PersonalizeItem, PreviewInput,
};
use jt_app::usecases::prospects::{self, DecideInput, DecideKind};
use jt_inbox::{
    ConsentKind, ConsentSource, ConvState, Conversation, ConversationId, Executor, JourneyStatus,
    PersonId,
};
use jt_outreach::{CampaignStatus, EnrollmentStatus, PauseReason, SendOutcome, StopReason};
use jt_prospects::{CreateInput, EntityKind, FieldInput, SourceRefInput};
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW};
use outreach_support::*;
use serde_json::json;
use support::*;
use time::Duration;

/// The footer's source line of a consented recipient.
const CONSENT_LINE: &str = "Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.";
/// The footer's source line of a business recipient reached on its public data.
const PUBLIC_DATA_LINE: &str =
    "Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.";

fn minutes(n: i64) -> time::OffsetDateTime {
    FIXED_NOW + Duration::minutes(n)
}

/// A consented person called `name` at `<name>@example.invalid`.
async fn consented_as(w: &World, name: &str) -> PersonId {
    let p = person(w, name, &format!("{}@example.invalid", name.to_lowercase())).await;
    consent_email(w, p).await;
    p
}

/// The owner's settings change.
async fn set(w: &World, v: serde_json::Value) {
    outreach::settings_set(&w.deps, &w.owner_ctx, serde_json::from_value(v).unwrap())
        .await
        .unwrap();
}

/// Steps one after another may follow at once and up to 30 a month (the frequency cap off).
async fn no_frequency_cap(w: &World) {
    set(
        w,
        json!({"frequency": {"min_gap_days": 0, "max_per_30_days": 30}}),
    )
    .await;
}

/// A simple one-step template.
async fn hello(w: &World) -> jt_outreach::TemplateId {
    template(w, &w.owner_ctx, "Merhaba", "Tanışmak isteriz.").await
}

fn enrollment_of(
    w: &World,
    c: jt_outreach::CampaignId,
    p: PersonId,
) -> jt_app::ports::outreach::EnrollmentRow {
    enrollments(w, c)
        .into_iter()
        .find(|e| e.person_id == p)
        .unwrap()
}

#[tokio::test]
async fn an_outreach_email_goes_through_the_outbox_with_its_footer_and_sender_name() {
    let o = outreach_world().await;
    let ada = consented(&o.w).await;
    let t = template(
        &o.w,
        &o.w.owner_ctx,
        "Merhaba {{company|işletmeniz}}",
        "Merhaba {{first_name|dostum}}, tanışalım.",
    )
    .await;
    let c = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    assert_eq!(c.campaign.status, CampaignStatus::Running);
    assert_eq!(c.enrollment.as_ref().unwrap().enrolled, 1);
    assert_eq!(c.active_enrollments, 1);
    o.mail.push_mail(accepted("outreach-1"));
    let report = dispatch(&o.w, FIXED_NOW).await;
    assert_eq!(report.failed, 0);
    let mail = sent_mail(&o.mail);
    assert_eq!(mail.len(), 1);
    let m = &mail[0];
    assert_eq!(m.to, "ada@example.invalid");
    assert_eq!(m.from_name.as_deref(), Some("Acme Satış"));
    assert_eq!(m.subject, "Merhaba işletmeniz");
    assert!(
        m.text.starts_with("Merhaba Ada, tanışalım.\n\n--\n"),
        "{}",
        m.text
    );
    assert!(m.text.contains(CONSENT_LINE));
    let send = sends(&o.w).pop().unwrap();
    assert_eq!(send.step, 1);
    assert_eq!(send.recipient_domain, "example.invalid");
    // The receipt settles the send row (L4-T6).
    assert_eq!(send.outcome, SendOutcome::Sent);
    // The unsubscribe link and the Message-ID name the outbox entry (spec D63).
    let token = send.outbox_id;
    assert_eq!(m.message_id, format!("<{token}@panel.test>"));
    let u = m.list_unsubscribe.as_ref().unwrap();
    assert!(
        u.https
            .starts_with(&format!("https://panel.test/u/{}/{token}/", o.w.ws))
    );
    let outbox = o.w.uow.snapshot().inbox.outbox;
    assert_eq!(outbox[0].intent["use_case"], "outreach.dispatch");
    assert_eq!(
        outbox[0].intent["outreach"]["campaign_id"],
        json!(c.campaign.id)
    );
    assert_eq!(outbox[0].state, "sent");
    let e = enrollment_of(&o.w, c.campaign.id, ada);
    assert_eq!(e.status, EnrollmentStatus::Completed);
    assert_eq!(e.last_sent_at, Some(FIXED_NOW));
    // The campaign completes once nobody is left to send to.
    dispatch(&o.w, minutes(1)).await;
    let after = outreach::campaigns_get(&o.w.deps, &o.w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(after.campaign.status, CampaignStatus::Completed);
}

#[tokio::test]
async fn enroll_skips_with_reasons() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = person(w, "Bora", "bora@example.invalid").await;
    let cem = consented_as(w, "Cem").await;
    jt_app::usecases::inbox::consent::add_suppression(
        &w.deps,
        &w.owner_ctx,
        cem,
        serde_json::from_value(json!({"channel": "email", "reason": "manual"})).unwrap(),
    )
    .await
    .unwrap();
    let deniz = jt_app::usecases::inbox::people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Deniz",
            "identities": [{"channel": "phone", "value": "+905000000002"}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id;
    let t = hello(w).await;
    let audience = json!({"explicit": [ada, bora, cem, deniz]});
    let preview = outreach::audience_preview(
        &w.deps,
        &w.owner_ctx,
        PreviewInput {
            audience: serde_json::from_value(audience.clone()).unwrap(),
            mailbox_id: o.mailbox,
        },
    )
    .await
    .unwrap();
    let c = running(&o, definition(t, audience)).await;
    let enrolled = c.enrollment.unwrap();
    assert_eq!(enrolled.enrolled, 1);
    assert_eq!(enrolled.skipped["no_basis"], 1);
    assert_eq!(enrolled.skipped["suppressed"], 1);
    assert_eq!(enrolled.skipped["no_deliverable_email"], 1);
    // The preview said so (they share one resolver).
    assert_eq!(preview.eligible, enrolled.enrolled);
    assert_eq!(preview.by_skip_reason, enrolled.skipped);
    let rows = enrollments(w, c.campaign.id);
    assert_eq!(rows.len(), 4);
    let of = |p| rows.iter().find(|e| e.person_id == p).unwrap();
    assert_eq!(of(ada).status, EnrollmentStatus::Active);
    assert_eq!(of(ada).basis, Some(jt_inbox::CommercialBasis::Consent));
    assert_eq!(of(bora).skip, Some(jt_outreach::SkipReason::NoBasis));
    assert_eq!(of(cem).skip, Some(jt_outreach::SkipReason::Suppressed));
    assert_eq!(
        of(deniz).skip,
        Some(jt_outreach::SkipReason::NoDeliverableEmail)
    );
    let entry = w.entries("outreach.enrolled").pop().unwrap();
    assert_eq!(entry.payload["count"], 1);
    assert!(!entry.payload.to_string().contains("example.invalid"));
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
async fn enroll_promotes_qualified_prospects_within_cap() {
    let o = outreach_world().await;
    let w = &o.w;
    let first = qualified_prospect(w, "Örnek Kafe", "info@ornek-kafe.example.invalid").await;
    let second = qualified_prospect(w, "Deneme Fırın", "info@deneme-firin.example.invalid").await;
    let t = hello(w).await;
    // Without the business-recipient basis a prospect is not promoted only to be skipped.
    let c = running(
        &o,
        definition(t, json!({"prospects": {"cities": ["istanbul"]}})),
    )
    .await;
    let out = c.enrollment.unwrap();
    assert_eq!((out.promoted, out.enrolled), (0, 0));
    assert_eq!(out.skipped["no_basis"], 2);
    // With it, the pool's daily promotion cap holds.
    open_b2b(w, false).await;
    prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        prospects::SettingsInput {
            max_promotions_per_day: Some(1),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let c = running(&o, definition(t, json!({"prospects": {"min_score": null}}))).await;
    let out = c.enrollment.unwrap();
    assert_eq!(out.promoted, 1);
    assert_eq!(out.waiting_for_promotion, 1);
    assert_eq!(out.enrolled, 1);
    let rows = enrollments(w, c.campaign.id);
    assert_eq!(rows.len(), 1);
    // One of the two (the pool lists the newest first), the other waits for tomorrow.
    let promoted = rows[0].prospect_id.unwrap();
    assert!([first, second].contains(&promoted));
    let p = w
        .uow
        .snapshot()
        .prospects
        .prospects
        .into_iter()
        .find(|p| p.id == promoted)
        .unwrap();
    assert_eq!(p.status, jt_prospects::ProspectStatus::Promoted);
    assert_eq!(
        rows[0].basis,
        Some(jt_inbox::CommercialBasis::BusinessRecipient)
    );
}

#[tokio::test]
async fn one_active_enrollment_across_campaigns() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let t = hello(w).await;
    running(&o, definition(t, json!({"explicit": [ada]}))).await;
    let second = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    let out = second.enrollment.unwrap();
    assert_eq!(out.enrolled, 0);
    assert_eq!(out.skipped["active_elsewhere"], 1);
    // An explicit enrollment adds people to a running campaign; one already in it is not added
    // twice.
    let more = outreach::enroll(
        &w.deps,
        &w.owner_ctx,
        second.campaign.id,
        EnrollInput {
            person_ids: vec![bora, ada],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(more.enrolled, 1);
    assert_eq!(more.already_enrolled, 1);
    let e = err(outreach::enroll(
        &w.deps,
        &w.owner_ctx,
        second.campaign.id,
        EnrollInput {
            audience: true,
            person_ids: vec![bora],
            ..Default::default()
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    // A draft takes no enrollment.
    let draft = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"explicit": [bora]})),
    )
    .await;
    let e = err(outreach::enroll(
        &w.deps,
        &w.owner_ctx,
        draft.campaign.id,
        EnrollInput {
            audience: true,
            ..Default::default()
        },
    )
    .await);
    assert_eq!(e.details["reason"], "not_enrollable");
}

#[tokio::test]
async fn personalize_only_custom_vars_of_the_campaign() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = template(w, &w.owner_ctx, "Merhaba", "{{custom.opener}} Tanışalım.").await;
    let c = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    let e = enrollment_of(w, c.campaign.id, ada);
    let item = |k: &str, v: &str| PersonalizeItem {
        enrollment_id: e.id,
        values: [(k.to_owned(), v.to_owned())].into(),
    };
    let unused = err(outreach::personalize(
        &w.deps,
        &w.owner_ctx,
        PersonalizeInput {
            items: vec![item("custom.other", "x")],
        },
    )
    .await);
    assert_eq!(unused.details["reason"], "unused_key");
    let bad = err(outreach::personalize(
        &w.deps,
        &w.owner_ctx,
        PersonalizeInput {
            items: vec![item("custom.Opener", "x")],
        },
    )
    .await);
    assert_eq!(bad.code, ErrorCode::Validation);
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(outreach::personalize(
            &w.deps,
            &rep,
            PersonalizeInput {
                items: vec![item("custom.opener", "x")],
            },
        )
        .await),
        "outreach.work",
    );
    let out = outreach::personalize(
        &w.deps,
        &w.owner_ctx,
        PersonalizeInput {
            items: vec![item("custom.opener", "Kahveniz çok güzel.")],
        },
    )
    .await
    .unwrap();
    assert_eq!(out.updated, 1);
    o.mail.push_mail(accepted("p1"));
    dispatch(w, FIXED_NOW).await;
    let m = sent_mail(&o.mail).pop().unwrap();
    assert!(
        m.text.starts_with("Kahveniz çok güzel. Tanışalım."),
        "{}",
        m.text
    );
    assert!(
        !w.entries("outreach.personalized")[0]
            .payload
            .to_string()
            .contains("Kahve")
    );
}

#[tokio::test]
async fn dispatch_respects_window_and_mailbox_hours() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    // FIXED_NOW is 12:00 in Istanbul; the window opens at 13:00.
    let mut d = definition(t, json!({"explicit": [ada]}));
    d.schedule.window.from = 13;
    d.schedule.window.to = 18;
    running(&o, d).await;
    dispatch(w, FIXED_NOW).await;
    assert!(sent_mail(&o.mail).is_empty(), "the window is closed");
    // The mailbox's own hours close it too.
    {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let mut cap = r.capabilities().find(o.mailbox).await.unwrap().unwrap();
        cap.policy.active_hours = Some(jt_capability::Hours {
            tz: "Europe/Istanbul".into(),
            from: 9,
            to: 14,
            days: vec![1, 2, 3, 4, 5, 6, 7],
        });
        r.capabilities().update(cap).await.unwrap();
        r.commit().await.unwrap();
    }
    dispatch(w, minutes(150)).await;
    assert!(
        sent_mail(&o.mail).is_empty(),
        "the mailbox's hours are over at 14:30"
    );
    o.mail.push_mail(accepted("window"));
    dispatch(w, minutes(70)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1, "13:10 is inside both");
}

#[tokio::test]
async fn dispatch_respects_daily_hourly_and_pacing_budgets() {
    let o = outreach_world().await;
    let w = &o.w;
    let mut people = Vec::new();
    for name in ["Ada", "Bora", "Cem"] {
        people.push(consented_as(w, name).await);
    }
    let t = hello(w).await;
    let mut d = definition(t, json!({"explicit": people}));
    d.throttle.per_day = 2;
    running(&o, d).await;
    for _ in 0..3 {
        o.mail.push_mail(accepted("budget"));
    }
    // ⌈60 / 60⌉ = 1 a run; two a day.
    dispatch(w, FIXED_NOW).await;
    assert_eq!(sent_mail(&o.mail).len(), 1, "one a minute");
    dispatch(w, minutes(1)).await;
    dispatch(w, minutes(2)).await;
    assert_eq!(sent_mail(&o.mail).len(), 2, "two a day");
    dispatch(w, FIXED_NOW + Duration::days(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 3, "the next local day");
}

#[tokio::test]
async fn warmup_limits_a_new_mailbox() {
    let o = outreach_world().await;
    let w = &o.w;
    set(w, json!({"warmup": {"start": 1, "step": 1}})).await;
    let mut people = Vec::new();
    for name in ["Ada", "Bora", "Cem"] {
        people.push(consented_as(w, name).await);
    }
    let t = hello(w).await;
    running(&o, definition(t, json!({"explicit": people}))).await;
    for _ in 0..3 {
        o.mail.push_mail(accepted("warm"));
    }
    dispatch(w, FIXED_NOW).await;
    dispatch(w, minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1, "day 0: start 1");
    let tomorrow = FIXED_NOW + Duration::days(1);
    dispatch(w, tomorrow).await;
    dispatch(w, tomorrow + Duration::minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 3, "day 1: 1 + 1 × 1");
}

#[tokio::test]
async fn domain_pacing_postpones() {
    let o = outreach_world().await;
    let w = &o.w;
    let mut people = Vec::new();
    for name in ["Ada", "Bora", "Cem", "Deniz", "Ece", "Fatma"] {
        people.push(consented_as(w, name).await);
    }
    let t = hello(w).await;
    let c = running(&o, definition(t, json!({"explicit": people}))).await;
    for _ in 0..5 {
        o.mail.push_mail(accepted("domain"));
    }
    for m in 0..6 {
        dispatch(w, minutes(m)).await;
    }
    assert_eq!(sent_mail(&o.mail).len(), 5, "five an hour to one domain");
    let waiting: Vec<_> = enrollments(w, c.campaign.id)
        .into_iter()
        .filter(|e| e.status == EnrollmentStatus::Active)
        .collect();
    assert_eq!(waiting.len(), 1);
    assert_eq!(
        waiting[0].next_send_at,
        Some(minutes(5) + Duration::minutes(20))
    );
}

#[tokio::test]
async fn frequency_cap_across_campaigns() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    let first = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    o.mail.push_mail(accepted("f1"));
    dispatch(w, FIXED_NOW).await;
    assert_eq!(sent_mail(&o.mail).len(), 1);
    // The first campaign is over for Ada; a second reaches her no sooner than 3 days later.
    assert_eq!(
        enrollment_of(w, first.campaign.id, ada).status,
        EnrollmentStatus::Completed
    );
    let second = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    dispatch(w, minutes(10)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1);
    assert_eq!(
        enrollment_of(w, second.campaign.id, ada).next_send_at,
        Some(FIXED_NOW + Duration::days(3))
    );
}

#[tokio::test]
async fn missing_variable_stops_with_reason() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let sector = template(w, &w.owner_ctx, "Merhaba {{sector}}", "Selam").await;
    let custom = template(w, &w.owner_ctx, "Merhaba", "{{custom.opener}} Selam").await;
    let a = running(&o, definition(sector, json!({"explicit": [ada]}))).await;
    let b = running(&o, definition(custom, json!({"explicit": [bora]}))).await;
    dispatch(w, FIXED_NOW).await;
    dispatch(w, minutes(1)).await;
    assert!(sent_mail(&o.mail).is_empty(), "never sent with a blank");
    let e = enrollment_of(w, a.campaign.id, ada);
    assert_eq!(e.stop, Some(StopReason::MissingVariable("sector".into())));
    // A missing personalization waits for the agent, then stops.
    let e = enrollment_of(w, b.campaign.id, bora);
    assert_eq!(e.status, EnrollmentStatus::Active);
    assert!(e.next_send_at.unwrap() > minutes(1));
    dispatch(w, FIXED_NOW + Duration::hours(73)).await;
    let e = enrollment_of(w, b.campaign.id, bora);
    assert_eq!(
        e.stop,
        Some(StopReason::MissingVariable("custom.opener".into()))
    );
}

/// An email conversation of `person` on the mailbox held by `executor`.
async fn conversation_held(o: &Outreach, person: PersonId, executor: Executor) {
    let w = &o.w;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(Conversation {
            id: ConversationId::new_v7(),
            workspace_id: w.ws,
            person_id: person,
            capability_id: o.mailbox,
            kind_key: "mailbox".into(),
            state: ConvState::Ours,
            executor,
            executor_generation: 0,
            last_inbound_at: Some(FIXED_NOW - Duration::days(10)),
            last_outbound_at: None,
            created_at: FIXED_NOW - Duration::days(10),
            updated_at: FIXED_NOW - Duration::days(10),
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
}

#[tokio::test]
async fn refused_at_enqueue_stops_enrollment() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let cem = consented_as(w, "Cem").await;
    let t = hello(w).await;
    let c = running(&o, definition(t, json!({"explicit": [ada, bora, cem]}))).await;
    // A person holds Ada's conversation.
    conversation_held(
        &o,
        ada,
        Executor::Human {
            user_id: Some(w.owner),
        },
    )
    .await;
    // Bora objected: on the do-not-contact list.
    prospects::do_not_contact(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"confirm": true, "keys": [{"kind": "email",
            "value": "bora@example.invalid"}], "reason": "objected", "note": "Aradı, istemiyor"}))
        .unwrap(),
    )
    .await
    .unwrap();
    // Cem withdrew consent after enrolling, written straight to the repos: no hook stopped the
    // enrollment (L4-T6's would), so the enqueue's fence refuses it.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consents()
        .insert(jt_inbox::Consent {
            id: jt_inbox::ConsentId::new_v7(),
            person_id: cem,
            channel: jt_inbox::Channel::Email,
            kind: ConsentKind::Withdrawn,
            source: ConsentSource::Customer,
            at: FIXED_NOW,
            sync_state: jt_inbox::SyncState::Pending,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    for m in 0..3 {
        dispatch(w, minutes(m)).await;
    }
    assert!(sent_mail(&o.mail).is_empty());
    let stop = |p| enrollment_of(w, c.campaign.id, p).stop;
    assert_eq!(stop(ada), Some(StopReason::HumanHoldsConversation));
    assert_eq!(stop(bora), Some(StopReason::DoNotContact));
    assert_eq!(stop(cem), Some(StopReason::Refused("IZIN_YOK".into())));
    assert_eq!(w.entries("outreach.enrollment_stopped").len(), 3);
}

/// The single outbox entry of the world put back as queued, as a crash before its claim leaves
/// it (the outbox recovery claims such an entry again).
fn requeue(w: &World) -> uuid::Uuid {
    let mut id = None;
    w.uow.edit(|s| {
        let row = s.inbox.outbox.last_mut().unwrap();
        row.state = "queued".into();
        row.fence_snapshot = None;
        id = Some(row.id);
    });
    id.unwrap()
}

#[tokio::test]
async fn refused_at_claim_too() {
    // The campaign paused between the enqueue and the claim.
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    // Two steps: the campaign is still running after the first.
    let c = running(
        &o,
        definition_steps(&[(t, 0), (t, 5)], json!({"explicit": [ada]})),
    )
    .await;
    o.mail.push_mail(accepted("c1"));
    dispatch(w, FIXED_NOW).await;
    let id = requeue(w);
    outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        outreach::ControlInput {
            action: outreach::ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    let out = replies::send_step(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(out.state, "refused");
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("campaign_not_running")
    );
    assert_eq!(sent_mail(&o.mail).len(), 1, "never sent twice");
    // The person wrote after enrolling.
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    running(
        &o,
        definition_steps(&[(t, 0), (t, 5)], json!({"explicit": [ada]})),
    )
    .await;
    o.mail.push_mail(accepted("c2"));
    dispatch(w, FIXED_NOW).await;
    let id = requeue(w);
    w.uow.edit(|s| {
        for c in &mut s.inbox.conversations {
            c.last_inbound_at = Some(minutes(5));
        }
    });
    replies::send_step(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("replied")
    );
    // Its email on the do-not-contact list.
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    running(
        &o,
        definition_steps(&[(t, 0), (t, 5)], json!({"explicit": [ada]})),
    )
    .await;
    o.mail.push_mail(accepted("c3"));
    dispatch(w, FIXED_NOW).await;
    let id = requeue(w);
    prospects::do_not_contact(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"confirm": true, "keys": [{"kind": "email",
            "value": "ada@example.invalid"}], "reason": "objected", "note": "İstemiyor"}))
        .unwrap(),
    )
    .await
    .unwrap();
    replies::send_step(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("do_not_contact")
    );
}

#[tokio::test]
async fn stop_rules_hold_without_hooks() {
    let o = outreach_world().await;
    let w = &o.w;
    no_frequency_cap(w).await;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let t = hello(w).await;
    let d = definition_steps(&[(t, 0), (t, 2)], json!({"explicit": [ada, bora]}));
    let c = running(&o, d).await;
    o.mail.push_mail(accepted("s1"));
    o.mail.push_mail(accepted("s2"));
    dispatch(w, FIXED_NOW).await;
    dispatch(w, minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 2);
    // No hook ran: Ada wrote back, Bora's journey was won.
    w.uow.edit(|s| {
        for conv in &mut s.inbox.conversations {
            if conv.person_id == ada {
                conv.last_inbound_at = Some(minutes(30));
            }
        }
        for j in &mut s.inbox.journeys {
            if j.person_id == bora {
                j.status = JourneyStatus::Won;
                j.closed_at = Some(minutes(40));
            }
        }
    });
    let later = FIXED_NOW + Duration::days(2) + Duration::minutes(5);
    dispatch(w, later).await;
    dispatch(w, later + Duration::minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 2, "nothing more");
    let stop = |p| enrollment_of(w, c.campaign.id, p).stop;
    assert_eq!(stop(ada), Some(StopReason::Replied));
    assert_eq!(stop(bora), Some(StopReason::JourneyWon));
}

#[tokio::test]
async fn same_thread_step_replies_to_previous_message_id() {
    let o = outreach_world().await;
    let w = &o.w;
    no_frequency_cap(w).await;
    let ada = consented(w).await;
    let t = hello(w).await;
    let mut d = definition_steps(&[(t, 0), (t, 1)], json!({"explicit": [ada]}));
    d.steps[1].same_thread = true;
    running(&o, d).await;
    o.mail.push_mail(accepted("t1"));
    o.mail.push_mail(accepted("t2"));
    dispatch(w, FIXED_NOW).await;
    dispatch(w, FIXED_NOW + Duration::days(1)).await;
    let mail = sent_mail(&o.mail);
    assert_eq!(mail.len(), 2);
    assert_eq!(
        mail[1].in_reply_to.as_deref(),
        Some(mail[0].message_id.as_str())
    );
    assert!(mail[1].references.contains(&mail[0].message_id));
    assert_eq!(mail[0].in_reply_to, None);
}

#[tokio::test]
async fn rerun_after_crash_is_idempotent() {
    let o = outreach_world().await;
    let w = &o.w;
    no_frequency_cap(w).await;
    let ada = consented(w).await;
    let t = hello(w).await;
    let c = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    o.mail.push_mail(accepted("r1"));
    dispatch(w, FIXED_NOW).await;
    // As if the enrollment's advance had been lost: step 1 due again.
    let e = enrollment_of(w, c.campaign.id, ada);
    w.uow.edit(|s| {
        for (_, row) in &mut s.outreach.enrollments {
            if row.id == e.id {
                row.status = EnrollmentStatus::Active;
                row.next_step = 1;
                row.next_send_at = Some(FIXED_NOW);
            }
        }
    });
    dispatch(w, minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1, "the request key replays");
    assert_eq!(w.uow.snapshot().inbox.outbox.len(), 1);
    assert_eq!(sends(w).len(), 1);
}

#[tokio::test]
async fn send_uses_named_mailbox_even_with_two() {
    let o = outreach_world().await;
    let w = &o.w;
    let second = add_mailbox(w, "Kampanya", "kampanya@acme.example.invalid", false).await;
    let ada = consented(w).await;
    let t = hello(w).await;
    let c = campaign(
        w,
        &w.owner_ctx,
        second,
        definition(t, json!({"explicit": [ada]})),
    )
    .await;
    launch(w, &w.owner_ctx, c.campaign.id, 1).await.unwrap();
    o.mail.push_mail(accepted("m2"));
    dispatch(w, FIXED_NOW).await;
    let call = o
        .mail
        .calls()
        .into_iter()
        .find_map(|c| match c {
            ConnectorCall::SendMail {
                credential,
                message,
                ..
            } => Some((credential, message)),
            _ => None,
        })
        .unwrap();
    assert!(
        matches!(&call.0, jt_connector::Credential::Mailbox { from_address, .. }
        if from_address == "kampanya@acme.example.invalid")
    );
    assert_eq!(
        call.1.list_unsubscribe.unwrap().mailto.as_deref(),
        Some("mailto:kampanya@acme.example.invalid?subject=unsubscribe")
    );
    assert_eq!(sends(w)[0].mailbox_id, second);
}

/// Four consented people of a two-step campaign, their first steps sent; the send rows' ids.
async fn four_sent(o: &Outreach) -> (jt_outreach::CampaignId, Vec<jt_outreach::SendId>) {
    let w = &o.w;
    let mut people = Vec::new();
    for name in ["Ada", "Bora", "Cem", "Deniz"] {
        people.push(consented_as(w, name).await);
    }
    let t = hello(w).await;
    let c = running(
        o,
        definition_steps(&[(t, 0), (t, 5)], json!({"explicit": people})),
    )
    .await;
    for m in 0..4 {
        o.mail.push_mail(accepted("a"));
        dispatch(w, minutes(m)).await;
    }
    (c.campaign.id, sends(w).into_iter().map(|s| s.id).collect())
}

async fn outcome(w: &World, id: jt_outreach::SendId, to: SendOutcome) {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.outreach_sends()
        .set_outcome(id, SendOutcome::Sent, FIXED_NOW)
        .await
        .unwrap();
    r.outreach_sends()
        .set_outcome(id, to, FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
}

#[tokio::test]
async fn auto_pause_on_bounce_rate() {
    let o = outreach_world().await;
    let (c, ids) = four_sent(&o).await;
    assert_eq!(ids.len(), 4);
    for id in &ids[..3] {
        outcome(&o.w, *id, SendOutcome::Bounced).await;
    }
    dispatch(&o.w, minutes(10)).await;
    let out = outreach::campaigns_get(&o.w.deps, &o.w.owner_ctx, c)
        .await
        .unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::Paused);
    assert_eq!(out.campaign.pause_reason, Some(PauseReason::BounceRate));
}

#[tokio::test]
async fn auto_pause_on_complaints() {
    let o = outreach_world().await;
    let (c, ids) = four_sent(&o).await;
    for id in &ids[..2] {
        outcome(&o.w, *id, SendOutcome::Complained).await;
    }
    dispatch(&o.w, minutes(10)).await;
    let out = outreach::campaigns_get(&o.w.deps, &o.w.owner_ctx, c)
        .await
        .unwrap();
    assert_eq!(out.campaign.pause_reason, Some(PauseReason::Complaints));
}

#[tokio::test]
async fn a_mailbox_that_is_down_pauses_the_campaign() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = hello(w).await;
    let c = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.capabilities()
            .set_status(
                o.mailbox,
                jt_capability::StoredStatus::Unreachable,
                FIXED_NOW,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    dispatch(w, FIXED_NOW).await;
    assert!(sent_mail(&o.mail).is_empty());
    let out = outreach::campaigns_get(&w.deps, &w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(out.campaign.pause_reason, Some(PauseReason::MailboxDown));
    assert_eq!(
        enrollment_of(w, c.campaign.id, ada).status,
        EnrollmentStatus::Active,
        "the enrollment waits"
    );
}

/// A business recipient without consent called `name`.
async fn business_as(w: &World, name: &str) -> PersonId {
    let p = person(
        w,
        name,
        &format!("{}@firma.example.invalid", name.to_lowercase()),
    )
    .await;
    business(w, p).await;
    p
}

#[tokio::test]
async fn iys_lookup_caches_and_refuses_ret() {
    let o = outreach_world().await;
    let w = &o.w;
    open_b2b(w, true).await;
    add_iys(&o).await;
    no_frequency_cap(w).await;
    let refusing = business_as(w, "Ret").await;
    let granting = business_as(w, "Onay").await;
    let absent = business_as(w, "Yok").await;
    let t = hello(w).await;
    let c = running(
        &o,
        definition_steps(
            &[(t, 0), (t, 1)],
            json!({"explicit": [refusing, granting, absent]}),
        ),
    )
    .await;
    assert_eq!(c.enrollment.unwrap().enrolled, 3);
    o.netgsm.push_consent_search(Ok(IysAnswer::Refused));
    o.netgsm.push_consent_search(Ok(IysAnswer::Granted));
    o.netgsm.push_consent_search(Ok(IysAnswer::Absent));
    o.mail.push_mail(accepted("i1"));
    o.mail.push_mail(accepted("i2"));
    for m in 0..3 {
        dispatch(w, minutes(m)).await;
    }
    let lookups: Vec<(String, String)> = o
        .netgsm
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            ConnectorCall::ConsentSearch {
                recipient, channel, ..
            } => Some((recipient, channel)),
            _ => None,
        })
        .collect();
    assert_eq!(lookups.len(), 3);
    assert!(lookups.iter().all(|(_, ch)| ch == "EPOSTA"));
    assert_eq!(
        enrollment_of(w, c.campaign.id, refusing).stop,
        Some(StopReason::ConsentWithdrawn)
    );
    let consents = w.uow.snapshot().inbox.consents;
    let iys: Vec<_> = consents
        .iter()
        .filter(|(_, c)| c.source == ConsentSource::IysSync)
        .map(|(_, c)| (c.person_id, c.kind))
        .collect();
    assert!(iys.contains(&(refusing, ConsentKind::Withdrawn)));
    assert!(iys.contains(&(granting, ConsentKind::Explicit)));
    assert_eq!(iys.len(), 2, "YOK leaves nothing");
    let mail = sent_mail(&o.mail);
    assert_eq!(mail.len(), 2);
    let to = |p: &str| mail.iter().find(|m| m.to.starts_with(p)).unwrap();
    // ONAY is a consent now: the consent line.
    assert!(to("onay@").text.contains(CONSENT_LINE));
    assert!(to("yok@").text.contains(PUBLIC_DATA_LINE));
    // The next step asks İYS no more: an answer of the last 30 days stands.
    o.mail.push_mail(accepted("i3"));
    o.mail.push_mail(accepted("i4"));
    let next = FIXED_NOW + Duration::days(1);
    dispatch(w, next + Duration::minutes(2)).await;
    dispatch(w, next + Duration::minutes(3)).await;
    assert_eq!(sent_mail(&o.mail).len(), 4);
    assert_eq!(
        o.netgsm
            .calls()
            .iter()
            .filter(|c| matches!(c, ConnectorCall::ConsentSearch { .. }))
            .count(),
        3
    );
}

#[tokio::test]
async fn iys_lookup_unavailable_without_capability() {
    let o = outreach_world().await;
    let w = &o.w;
    open_b2b(w, true).await;
    let firm = business_as(w, "Firma").await;
    let t = hello(w).await;
    let c = running(&o, definition(t, json!({"explicit": [firm]}))).await;
    dispatch(w, FIXED_NOW).await;
    assert!(sent_mail(&o.mail).is_empty());
    assert_eq!(
        enrollment_of(w, c.campaign.id, firm).stop,
        Some(StopReason::Refused("iys_lookup_unavailable".into()))
    );
}

#[tokio::test]
async fn iys_budget_8_per_minute() {
    let o = outreach_world().await;
    let w = &o.w;
    open_b2b(w, true).await;
    add_iys(&o).await;
    let t = hello(w).await;
    let mut campaigns = Vec::new();
    for i in 0..10 {
        // Each on its own domain: the domain pacing (five an hour) stays out of the way.
        let p = person(
            w,
            &format!("Firma{i}"),
            &format!("info@firma{i}.example.invalid"),
        )
        .await;
        business(w, p).await;
        campaigns.push((
            running(&o, definition(t, json!({"explicit": [p]}))).await,
            p,
        ));
    }
    for _ in 0..10 {
        o.netgsm.push_consent_search(Ok(IysAnswer::Absent));
        o.mail.push_mail(accepted("b"));
    }
    dispatch(w, FIXED_NOW).await;
    assert_eq!(sent_mail(&o.mail).len(), 8, "eight lookups a minute");
    let waiting = campaigns
        .iter()
        .filter(|(c, p)| enrollment_of(w, c.campaign.id, *p).status == EnrollmentStatus::Active)
        .count();
    assert_eq!(waiting, 2);
    dispatch(w, minutes(1)).await;
    assert_eq!(sent_mail(&o.mail).len(), 10);
}

/// The owner's login address in the outreach world.
const OWNER_LOGIN: &str = "owner@acme.example";

#[tokio::test]
async fn test_send_only_to_a_members_login_address() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = template(
        w,
        &w.owner_ctx,
        "Merhaba {{company}}",
        "Merhaba {{first_name}}, {{custom.opener}}",
    )
    .await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"explicit": [ada]})),
    )
    .await
    .campaign
    .id;
    // Any other address is refused, nothing queued.
    for to in ["ada@example.invalid", "baska@acme.example"] {
        let e = err(outreach::test_send(
            &w.deps,
            &w.owner_ctx,
            c,
            outreach::TestSendInput {
                step: None,
                to: Some(to.into()),
            },
        )
        .await);
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert_eq!(e.details["reason"], "not_a_members_login_address");
    }
    assert!(w.uow.snapshot().inbox.outbox.is_empty());
    // To the caller's own login address (named or not), through the outbox, with the footer
    // and the one-click unsubscribe; missing values read as their variable.
    o.mail.push_mail(accepted("test-1"));
    let out = outreach::test_send(
        &w.deps,
        &w.owner_ctx,
        c,
        outreach::TestSendInput {
            step: Some(1),
            to: Some("Owner@Acme.Example".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        (out.to.as_str(), out.step, out.state.as_str()),
        (OWNER_LOGIN, 1, "sent")
    );
    let m = sent_mail(&o.mail).pop().unwrap();
    assert_eq!(m.to, OWNER_LOGIN);
    assert_eq!(m.subject, "Merhaba [company]");
    assert!(
        m.text.starts_with("Merhaba Owner, [custom.opener]\n\n--\n"),
        "{}",
        m.text
    );
    assert!(m.text.contains(CONSENT_LINE));
    assert!(m.list_unsubscribe.is_some());
    assert_eq!(m.from_name.as_deref(), Some("Acme Satış"));
    let outbox = w.uow.snapshot().inbox.outbox;
    assert_eq!(outbox[0].intent["use_case"], "outreach.test_send");
    assert!(
        outbox[0].intent.get("outreach").is_none(),
        "no send row, no enrollment"
    );
    assert!(sends(w).is_empty());
    // The member's inbox person has no journey and no consent row: nothing counts it.
    let s = w.uow.snapshot();
    let me = s
        .inbox
        .identities
        .iter()
        .find(|i| i.value_normalized == OWNER_LOGIN)
        .unwrap()
        .person_id;
    assert!(s.inbox.journeys.iter().all(|j| j.person_id != me));
    assert!(s.inbox.consents.iter().all(|(_, c)| c.person_id != me));
    assert_eq!(w.entries("outreach.test_sent").len(), 1);
    // An agent's goes to the member who issued its key; a second one reuses the person.
    let agent = w.agent(&["outreach.work"]).await;
    o.mail.push_mail(accepted("test-2"));
    let out = outreach::test_send(&w.deps, &agent, c, Default::default())
        .await
        .unwrap();
    assert_eq!(out.to, OWNER_LOGIN);
    assert_eq!(sent_mail(&o.mail).len(), 2);
    assert_eq!(w.uow.snapshot().inbox.people.len(), s.inbox.people.len());
    // A step the campaign does not have is refused; a rep without outreach.work is refused.
    let e = err(outreach::test_send(
        &w.deps,
        &w.owner_ctx,
        c,
        outreach::TestSendInput {
            step: Some(2),
            to: None,
        },
    )
    .await);
    assert_eq!(e.details["field"], "step");
    let rep = w.member("rep").await;
    let e = err(outreach::test_send(&w.deps, &rep, c, Default::default()).await);
    assert_forbidden(&e, "outreach.work");
    // An address the member unsubscribed from is refused like any other suppression.
    jt_app::usecases::inbox::consent::add_suppression(
        &w.deps,
        &w.owner_ctx,
        me,
        serde_json::from_value(json!({"channel": "email", "reason": "manual"})).unwrap(),
    )
    .await
    .unwrap();
    let e = err(outreach::test_send(&w.deps, &w.owner_ctx, c, Default::default()).await);
    assert_eq!(e.details["reason"], "IZIN_YOK");
}

#[tokio::test]
async fn an_outreach_email_on_a_mailbox_requiring_approval_is_never_held() {
    let o = outreach_world().await;
    let w = &o.w;
    let gated = add_mailbox(w, "Onaylı", "onay@acme.example.invalid", true).await;
    let ada = consented(w).await;
    let t = hello(w).await;
    let c = campaign(
        w,
        &w.owner_ctx,
        gated,
        definition(t, json!({"explicit": [ada]})),
    )
    .await;
    // The owner's launch approves the revision it launches (the mailbox requires approval).
    let launched = launch(w, &w.owner_ctx, c.campaign.id, 1).await.unwrap();
    assert!(launched.approval_required);
    assert_eq!(launched.campaign.status, CampaignStatus::Running);
    o.mail.push_mail(accepted("not-held"));
    dispatch(w, FIXED_NOW).await;
    let outbox = w.uow.snapshot().inbox.outbox;
    assert_eq!(outbox.len(), 1);
    assert_eq!(
        outbox[0].state, "sent",
        "the campaign's approval is the approval"
    );
    assert!(w.entries("inbox.public.held").is_empty());
    assert_eq!(sent_mail(&o.mail).len(), 1);
}

#[tokio::test]
async fn personalization_due_raised_within_24h() {
    let o = outreach_world().await;
    let w = &o.w;
    no_frequency_cap(w).await;
    let ada = consented(w).await;
    let bora = consented_as(w, "Bora").await;
    let t = template(w, &w.owner_ctx, "Merhaba", "{{custom.opener}}, tanışalım.").await;
    let c = running(&o, definition(t, json!({"explicit": [ada, bora]})))
        .await
        .campaign
        .id;
    // Bora's step is three days away.
    w.uow.edit(|s| {
        for (_, e) in &mut s.outreach.enrollments {
            if e.person_id == bora {
                e.next_send_at = Some(FIXED_NOW + Duration::days(3));
            }
        }
    });
    let agent = w.agent(&["workspace.read", "outreach.work"]).await;
    let due = |out: &jt_app::usecases::work::PendingOut| {
        out.items.iter().find_map(|i| match i.kind {
            jt_app::usecases::work::WorkKind::PersonalizationDue { campaign_id, count }
                if campaign_id == c =>
            {
                Some((count, i.priority))
            }
            _ => None,
        })
    };
    let out = jt_app::usecases::work::pending(&w.deps, &agent)
        .await
        .unwrap();
    assert_eq!(
        due(&out),
        Some((1, 2)),
        "Ada's step is due, Bora's is days away"
    );
    let e = enrollment_of(w, c, ada);
    outreach::personalize(
        &w.deps,
        &agent,
        PersonalizeInput {
            items: vec![PersonalizeItem {
                enrollment_id: e.id,
                values: [("opener".to_owned(), "Merhaba".to_owned())].into(),
            }],
        },
    )
    .await
    .unwrap();
    let out = jt_app::usecases::work::pending(&w.deps, &agent)
        .await
        .unwrap();
    assert_eq!(due(&out), None);
    // A day before Bora's step it is due.
    let later = at(&agent, FIXED_NOW + Duration::days(2) + Duration::hours(1));
    let out = jt_app::usecases::work::pending(&w.deps, &later)
        .await
        .unwrap();
    assert_eq!(due(&out), Some((1, 2)));
}

#[tokio::test]
async fn the_outreach_work_items_name_who_clears_them() {
    use jt_app::usecases::work::{PendingOut, WorkKind, pending};
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"requires_approval": true})).unwrap(),
    )
    .await
    .unwrap();
    let ada = consented(w).await;
    let t = hello(w).await;
    // An agent's launch waits for a person's approval.
    let agent = w
        .agent(&["workspace.read", "outreach.work", "inbox.work"])
        .await;
    let c = campaign(
        w,
        &agent,
        o.mailbox,
        definition(t, json!({"explicit": [ada]})),
    )
    .await;
    let waiting = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(waiting.campaign.status, CampaignStatus::AwaitingApproval);
    let approval = WorkKind::CampaignApproval {
        campaign_id: c.campaign.id,
        revision: 1,
    };
    let kinds = |out: PendingOut| out.items.into_iter().map(|i| i.kind).collect::<Vec<_>>();
    assert!(kinds(pending(&w.deps, &w.owner_ctx).await.unwrap()).contains(&approval));
    assert!(
        !kinds(pending(&w.deps, &agent).await.unwrap()).contains(&approval),
        "an agent cannot approve"
    );
    outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        outreach::ApproveInput {
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert!(!kinds(pending(&w.deps, &w.owner_ctx).await.unwrap()).contains(&approval));
    // Paused for its bounces: blocked, for whoever works outreach, until resumed or canceled.
    outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        outreach::ControlInput {
            action: outreach::ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    // A manual pause is nobody's work item.
    let blocked = |out: PendingOut| {
        out.items
            .into_iter()
            .filter_map(|i| match i.kind {
                WorkKind::CampaignBlocked {
                    campaign_id,
                    reason,
                } => Some((campaign_id, reason)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert!(blocked(pending(&w.deps, &agent).await.unwrap()).is_empty());
    w.uow.edit(|s| {
        for (_, row) in &mut s.outreach.campaigns {
            row.pause_reason = Some(PauseReason::BounceRate);
        }
    });
    assert_eq!(
        blocked(pending(&w.deps, &agent).await.unwrap()),
        [(c.campaign.id, PauseReason::BounceRate)]
    );
}

#[tokio::test]
async fn promoted_not_contacted_counts_prospects_nobody_wrote_to() {
    use jt_app::usecases::work::{WorkKind, pending};
    let o = outreach_world().await;
    let w = &o.w;
    let id = qualified_prospect(w, "Örnek Kafe", "info@ornek-kafe.example.invalid").await;
    prospects::promote(
        &w.deps,
        &w.owner_ctx,
        prospects::PromoteInput {
            prospect_ids: vec![id],
            request_key: None,
        },
    )
    .await
    .unwrap();
    let count = |out: jt_app::usecases::work::PendingOut| {
        out.items.into_iter().find_map(|i| match i.kind {
            WorkKind::PromotedNotContacted { count } => Some((count, i.priority)),
            _ => None,
        })
    };
    let agent = w.agent(&["workspace.read", "outreach.work"]).await;
    // Not yet two days old.
    assert_eq!(count(pending(&w.deps, &agent).await.unwrap()), None);
    let later = at(&agent, FIXED_NOW + Duration::days(3));
    assert_eq!(count(pending(&w.deps, &later).await.unwrap()), Some((1, 3)));
    // Enrolling clears it (a skipped enrollment too: the attempt was made).
    let person = w
        .uow
        .snapshot()
        .prospects
        .prospects
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
        .promoted
        .unwrap()
        .person_id;
    let t = hello(w).await;
    running(&o, definition(t, json!({"explicit": [person]}))).await;
    assert_eq!(count(pending(&w.deps, &later).await.unwrap()), None);
}
