//! Cold email stays locked (owner rule; spec 2026-10-30-leads-pool-outreach-design.md D17, D24,
//! D53): with the platform switch `JEETA_OUTREACH_ENABLED` off, every path that could send
//! outreach email refuses. One file, so a path added later is added here.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::MailMessage;
use jt_app::usecases::inbox::{quotes, replies};
use jt_app::usecases::outreach::{self, ApproveInput, ControlAction, ControlInput, links};
use jt_inbox::{ConvState, Conversation, ConversationId, Executor, PersonId, RecipientKind};
use jt_outreach::{CampaignStatus, MacPurpose};
use outreach_support::*;
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;

/// The footer's source line of a consented recipient (spec §3.10).
const CONSENT_LINE: &str = "Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.";
/// The footer's source line of a business recipient reached on its public data.
const PUBLIC_DATA_LINE: &str =
    "Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.";

#[tokio::test]
async fn launch_refused_when_platform_disabled() {
    let mut o = outreach_world().await;
    platform(&mut o.w, false);
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    // Whoever launches, the switch is checked first: before the sender identity, before approval.
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"sender_company": ""})).unwrap(),
    )
    .await
    .unwrap();
    for ctx in [w.owner_ctx.clone(), w.agent(&["outreach.work"]).await] {
        let e = err(launch(w, &ctx, c.campaign.id, 1).await);
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    }
    let stored = outreach::campaigns_get(&w.deps, &w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(stored.campaign.status, CampaignStatus::Draft);
    assert!(w.entries("outreach.campaign_launched").is_empty());
}

#[tokio::test]
async fn resume_and_approval_refused_when_platform_disabled() {
    let mut o = outreach_world().await;
    let t = template(&o.w, &o.w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        &o.w,
        &o.w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    let id = c.campaign.id;
    launch(&o.w, &o.w.owner_ctx, id, 1).await.unwrap();
    outreach::campaigns_control(
        &o.w.deps,
        &o.w.owner_ctx,
        id,
        ControlInput {
            action: ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    // A second campaign waits for approval when the switch goes off.
    outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        serde_json::from_value(json!({"requires_approval": true})).unwrap(),
    )
    .await
    .unwrap();
    let agent = o.w.agent(&["outreach.work"]).await;
    let waiting = campaign(
        &o.w,
        &agent,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    launch(&o.w, &agent, waiting.campaign.id, 1).await.unwrap();
    platform(&mut o.w, false);
    let w = &o.w;
    let e = err(outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        id,
        ControlInput {
            action: ControlAction::Resume,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    let e = err(outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        waiting.campaign.id,
        ApproveInput {
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(
        r.outreach_campaigns()
            .get(id)
            .await
            .unwrap()
            .unwrap()
            .status,
        CampaignStatus::Paused
    );
    assert_eq!(
        r.outreach_campaigns()
            .get(waiting.campaign.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        CampaignStatus::AwaitingApproval
    );
}

// ---- The footer and the one-click unsubscribe (spec D62, D63): every commercial email ----

/// An email conversation of `person` on the world's mailbox, the person having just written.
async fn conversation(o: &Outreach, person: PersonId) -> ConversationId {
    let w = &o.w;
    let id = ConversationId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: w.ws,
            person_id: person,
            capability_id: o.mailbox,
            kind_key: "mailbox".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(w.owner_ctx.now),
            last_outbound_at: None,
            created_at: w.owner_ctx.now,
            updated_at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    // An existing conversation of the person on the mailbox keeps its id.
    w.uow
        .snapshot()
        .inbox
        .conversations
        .iter()
        .find(|c| c.person_id == person && c.capability_id == o.mailbox)
        .unwrap()
        .id
}

fn send_input(intent: &str, key: &str) -> replies::SendInput {
    serde_json::from_value(json!({
        "channel": "email", "text": "Yeni ürünümüzü tanıtmak isteriz.", "intent": intent,
        "request_key": key,
    }))
    .unwrap()
}

fn reply_input(intent: &str, key: &str) -> replies::ReplyInput {
    serde_json::from_value(
        json!({"text": "Teklifimiz ektedir.", "intent": intent, "request_key": key}),
    )
    .unwrap()
}

/// Asserts `mail` ends with the footer whose source line is `source`, and carries the one-click
/// unsubscribe address of its own outbox entry (a MAC'd link) and the mailto fallback.
fn assert_footed(o: &Outreach, mail: &MailMessage, source: &str) {
    let token: uuid::Uuid = mail
        .message_id
        .trim_start_matches('<')
        .split('@')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let u = mail.list_unsubscribe.as_ref().expect("List-Unsubscribe");
    let prefix = format!("https://panel.test/u/{}/{token}/", o.w.ws);
    let mac = u
        .https
        .strip_prefix(&prefix)
        .expect("the token is the outbox entry");
    assert!(
        links::verify(&o.w.deps, o.w.ws, MacPurpose::Unsubscribe, token, None, mac).unwrap(),
        "the link's MAC holds"
    );
    assert_eq!(
        u.mailto.as_deref(),
        Some("mailto:satis@acme.example.invalid?subject=unsubscribe")
    );
    let footer = [
        "",
        "",
        "--",
        "Acme Yazılım A.Ş. · Örnek Mah. Deneme Sk. No 1, İstanbul",
        source,
        "Kişisel verilerin işlenmesi hakkında: https://acme.example.invalid/kvkk",
        &format!("Bu e-postaları almak istemiyorsanız: {}", u.https),
    ]
    .join("\n");
    assert!(mail.text.ends_with(&footer), "{}", mail.text);
}

#[tokio::test]
async fn commercial_email_without_sender_identity_is_refused() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = conversation(&o, ada).await;
    for clear in ["sender_company", "sender_address", "privacy_notice_url"] {
        sender_identity(w).await;
        outreach::settings_set(
            &w.deps,
            &w.owner_ctx,
            serde_json::from_value(json!({ clear: "" })).unwrap(),
        )
        .await
        .unwrap();
        let e =
            err(replies::send(&w.deps, &w.owner_ctx, ada, send_input("commercial", clear)).await);
        assert_eq!(e.code, ErrorCode::Forbidden, "{clear}");
        assert_eq!(e.message, "sender_identity_missing", "{clear}");
        let e =
            err(replies::reply(&w.deps, &w.owner_ctx, c, reply_input("commercial", clear)).await);
        assert_eq!(e.message, "sender_identity_missing", "{clear}");
    }
    assert!(sent_mail(&o.mail).is_empty(), "nothing left bare");
    assert_eq!(w.entries("inbox.send.refused").len(), 6);
    // A reply (answering the customer) is unchanged: no footer, no unsubscribe header.
    o.mail.push_mail(accepted("reply-1"));
    replies::reply(&w.deps, &w.owner_ctx, c, reply_input("reply", "plain"))
        .await
        .unwrap();
    let mail = sent_mail(&o.mail).pop().unwrap();
    assert_eq!(mail.text, "Teklifimiz ektedir.");
    assert_eq!(mail.list_unsubscribe, None);
}

#[tokio::test]
async fn the_footer_and_one_click_unsubscribe_are_on_every_commercial_email() {
    let mut o = outreach_world().await;
    // inbox.send on the consent basis.
    let ada = consented(&o.w).await;
    o.mail.push_mail(accepted("send-consent"));
    let out = replies::send(
        &o.w.deps,
        &o.w.owner_ctx,
        ada,
        send_input("commercial", "c1"),
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    let first = sent_mail(&o.mail)[0].clone();
    assert_footed(&o, &first, CONSENT_LINE);
    // The stored message is what was sent, footer included.
    assert!(
        o.w.uow
            .snapshot()
            .inbox
            .messages
            .iter()
            .any(|m| m.body == first.text)
    );
    // inbox.reply, commercial, in the answering window.
    let c = conversation(&o, ada).await;
    o.mail.push_mail(accepted("reply-commercial"));
    replies::reply(
        &o.w.deps,
        &o.w.owner_ctx,
        c,
        reply_input("commercial", "c2"),
    )
    .await
    .unwrap();
    assert_footed(&o, &sent_mail(&o.mail)[1], CONSENT_LINE);
    // inbox.quotes.send, commercial, on email.
    let journey =
        o.w.uow
            .snapshot()
            .inbox
            .journeys
            .iter()
            .find(|j| j.person_id == ada)
            .unwrap()
            .id;
    o.mail.push_mail(accepted("quote"));
    quotes::send(
        &o.w.deps,
        &o.w.owner_ctx,
        journey,
        serde_json::from_value(json!({
            "amount_minor": 125000, "currency": "TRY",
            "valid_until": days_later(10).format(&Rfc3339).unwrap(),
            "file_ref": null, "channel": "email", "text": "Teklifimiz: 1.250 TL.",
            "intent": "commercial", "request_key": "q1",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_footed(&o, &sent_mail(&o.mail)[2], CONSENT_LINE);
    // inbox.send on the business-recipient basis: the public-data line.
    let bora = person(&o.w, "Bora", "bora@example.invalid").await;
    {
        let mut r = o.w.uow.tenant(o.w.ws).await.unwrap();
        r.people()
            .set_recipient_kind(bora, RecipientKind::Business, o.w.owner_ctx.now)
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        serde_json::from_value(json!({"b2b_basis": ["email"],
            "legal_ack": {"counsel_confirmed": true, "note": "Avukat görüşü"}}))
        .unwrap(),
    )
    .await
    .unwrap();
    o.mail.push_mail(accepted("send-b2b"));
    replies::send(
        &o.w.deps,
        &o.w.owner_ctx,
        bora,
        send_input("commercial", "c3"),
    )
    .await
    .unwrap();
    assert_footed(&o, &sent_mail(&o.mail)[3], PUBLIC_DATA_LINE);
    // With the switch off the same email has no basis at all (D53).
    platform(&mut o.w, false);
    let e = err(replies::send(
        &o.w.deps,
        &o.w.owner_ctx,
        bora,
        send_input("commercial", "c4"),
    )
    .await);
    assert_eq!(e.message, "IZIN_YOK");
    assert_eq!(sent_mail(&o.mail).len(), 4);
}

#[tokio::test]
async fn a_commercial_email_queued_without_its_footer_is_refused_at_claim() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = conversation(&o, ada).await;
    let id = match replies::enqueue(&w.deps, &w.owner_ctx, c, reply_input("commercial", "old"))
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        other => panic!("a new intent expected, got {other:?}"),
    };
    // As an intent queued before the footer rule reads: no unsubscribe addresses.
    w.uow.edit(|s| {
        let row = s.inbox.outbox.iter_mut().find(|o| o.id == id).unwrap();
        row.intent["mail"]
            .as_object_mut()
            .unwrap()
            .remove("list_unsubscribe");
    });
    let out = replies::send_step(&w.deps, &w.owner_ctx, id).await.unwrap();
    assert_eq!(out.state, "refused");
    assert!(sent_mail(&o.mail).is_empty());
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("footer_missing")
    );
}

#[tokio::test]
async fn the_unsubscribe_link_pins_its_shape() {
    let o = outreach_world().await;
    let w = &o.w;
    let token = uuid::Uuid::from_u128(0x0123_4567_89ab_cdef);
    let base = jt_app::ports::connectors::Url::parse("https://panel.test").unwrap();
    let url = links::unsubscribe_url(&w.deps, &base, w.ws, token).unwrap();
    let prefix = format!("https://panel.test/u/{}/{token}/", w.ws);
    let mac = url.strip_prefix(&prefix).unwrap();
    // 16 bytes of HMAC-SHA256, base64url without padding.
    assert_eq!(mac.len(), 22);
    assert!(
        mac.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(
        mac,
        links::mac(&w.deps, w.ws, MacPurpose::Unsubscribe, token, None).unwrap()
    );
    let verify = |purpose, token, link, mac: &str| {
        links::verify(&w.deps, w.ws, purpose, token, link, mac).unwrap()
    };
    assert!(verify(MacPurpose::Unsubscribe, token, None, mac));
    assert!(!verify(
        MacPurpose::Unsubscribe,
        uuid::Uuid::from_u128(1),
        None,
        mac
    ));
    assert!(!verify(MacPurpose::Click, token, Some(0), mac));
    assert!(!verify(MacPurpose::Unsubscribe, token, None, &mac[..21]));
    assert!(!verify(MacPurpose::Unsubscribe, token, None, "not base64!"));
    // Another workspace's key gives another MAC.
    let (other, _) = w.other_workspace().await;
    assert_ne!(
        links::mac(&w.deps, other, MacPurpose::Unsubscribe, token, None).unwrap(),
        mac
    );
    let click = links::click_url(&w.deps, &base, w.ws, token, 3).unwrap();
    assert!(click.starts_with(&format!("https://panel.test/c/{}/{token}/3/", w.ws)));
    assert_eq!(
        links::unsubscribe_mailto("satis@acme.example.invalid").as_deref(),
        Some("mailto:satis@acme.example.invalid?subject=unsubscribe")
    );
    assert_eq!(
        links::unsubscribe_mailto("satış@acme.example.invalid"),
        None
    );
}

// ---- The dispatcher and the claim (plan L4-T5) ----

#[tokio::test]
async fn the_dispatcher_sends_nothing_while_locked() {
    // A campaign set up as if it had been launched while the switch was on.
    let mut o = outreach_world().await;
    let ada = consented(&o.w).await;
    let t = template(&o.w, &o.w.owner_ctx, "Merhaba", "Selam").await;
    let c = running(&o, definition(t, json!({"explicit": [ada]}))).await;
    assert_eq!(c.campaign.status, CampaignStatus::Running);
    platform(&mut o.w, false);
    let w = &o.w;
    let report = dispatch(w, w.owner_ctx.now).await;
    assert_eq!(report.changed, 0);
    assert!(sent_mail(&o.mail).is_empty());
    assert!(w.uow.snapshot().inbox.outbox.is_empty(), "nothing queued");
    let e = enrollments(w, c.campaign.id).pop().unwrap();
    assert_eq!(e.status, jt_outreach::EnrollmentStatus::Active, "it waits");
    // Nor does the use case body when called directly.
    let d = jt_app::usecases::outreach::dispatch::run(
        &w.deps,
        &jt_app::ctx::Ctx {
            workspace_id: w.ws,
            actor: jt_ledger::Actor::System {
                component: "test".into(),
            },
            permissions: Default::default(),
            role_key: None,
            now: w.owner_ctx.now,
            agent_connection_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(d, jt_app::usecases::outreach::Dispatched::default());
}

#[tokio::test]
async fn a_queued_outreach_intent_is_refused_at_claim_while_locked() {
    let mut o = outreach_world().await;
    let ada = consented(&o.w).await;
    let t = template(&o.w, &o.w.owner_ctx, "Merhaba", "Selam").await;
    running(&o, definition(t, json!({"explicit": [ada]}))).await;
    o.mail.push_mail(accepted("once"));
    dispatch(&o.w, o.w.owner_ctx.now).await;
    assert_eq!(sent_mail(&o.mail).len(), 1);
    // As a crash before the claim leaves it: queued again (the outbox recovery claims it).
    let mut id = None;
    o.w.uow.edit(|s| {
        let row = s.inbox.outbox.last_mut().unwrap();
        row.state = "queued".into();
        row.fence_snapshot = None;
        id = Some(row.id);
    });
    platform(&mut o.w, false);
    let out = replies::send_step(&o.w.deps, &o.w.owner_ctx, id.unwrap())
        .await
        .unwrap();
    assert_eq!(out.state, "refused");
    assert_eq!(
        o.w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("outreach_disabled_on_platform")
    );
    assert_eq!(sent_mail(&o.mail).len(), 1, "nothing more left");
}

#[tokio::test]
async fn a_business_recipient_without_consent_is_skipped_while_the_b2b_basis_is_off() {
    let o = outreach_world().await;
    let w = &o.w;
    let firm = person(w, "Firma", "info@firma.example.invalid").await;
    business(w, firm).await;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = running(&o, definition(t, json!({"explicit": [firm]}))).await;
    let out = c.enrollment.unwrap();
    assert_eq!(out.enrolled, 0);
    assert_eq!(out.skipped["no_basis"], 1);
    // Stored without the counsel's confirmation, the basis counts for nothing either.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.workspace_policy()
        .patch_leads(
            json!({"outreach": {"b2b_basis": ["email"]}}),
            w.owner_ctx.now,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let preview = outreach::audience_preview(
        &w.deps,
        &w.owner_ctx,
        outreach::PreviewInput {
            audience: serde_json::from_value(json!({"explicit": [firm]})).unwrap(),
            mailbox_id: o.mailbox,
        },
    )
    .await
    .unwrap();
    assert_eq!(preview.by_skip_reason["no_basis"], 1);
    assert!(!preview.business_basis_in_force);
    // And an email to it through the inbox is refused.
    let e = err(replies::send(
        &w.deps,
        &w.owner_ctx,
        firm,
        serde_json::from_value(json!({"channel": "email", "text": "Merhaba",
                "intent": "commercial"}))
        .unwrap(),
    )
    .await);
    assert_eq!(e.message, "IZIN_YOK");
    dispatch(w, w.owner_ctx.now).await;
    assert!(sent_mail(&o.mail).is_empty());
}

#[tokio::test]
async fn a_test_email_is_refused_while_locked() {
    let mut o = outreach_world().await;
    let ada = consented(&o.w).await;
    let t = template(&o.w, &o.w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        &o.w,
        &o.w.owner_ctx,
        o.mailbox,
        definition(t, json!({"explicit": [ada]})),
    )
    .await
    .campaign
    .id;
    // Sent while the switch is on, then queued again as a crash before its claim leaves it.
    o.mail.push_mail(accepted("test-1"));
    let sent = outreach::test_send(&o.w.deps, &o.w.owner_ctx, c, Default::default())
        .await
        .unwrap();
    assert_eq!(sent.state, "sent");
    let mut id = None;
    o.w.uow.edit(|s| {
        let row = s.inbox.outbox.last_mut().unwrap();
        row.state = "queued".into();
        row.fence_snapshot = None;
        id = Some(row.id);
    });
    platform(&mut o.w, false);
    let w = &o.w;
    // Whoever asks, a test email is refused while locked: nothing queued.
    for ctx in [
        w.owner_ctx.clone(),
        w.agent(&["outreach.work", "inbox.work"]).await,
    ] {
        let e = err(outreach::test_send(&w.deps, &ctx, c, Default::default()).await);
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    }
    assert_eq!(w.uow.snapshot().inbox.outbox.len(), 1);
    // The one queued while it was on is refused at claim.
    let out = replies::send_step(&w.deps, &w.owner_ctx, id.unwrap())
        .await
        .unwrap();
    assert_eq!(out.state, "refused");
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("outreach_disabled_on_platform")
    );
    assert_eq!(sent_mail(&o.mail).len(), 1, "nothing more left");
}

// ---- The public links (plan L5-T2): they only ever reduce what may be sent ----

/// The one-click unsubscribe and the click redirect have no caller to fence: they queue,
/// send and open nothing, so the lock holds whatever they are asked. With the switch off an
/// email sent while it was on still unsubscribes (the objection is always honoured) and its
/// click still redirects; nothing is queued or sent, and the sequence stays stopped once the
/// switch is back on.
#[tokio::test]
async fn the_public_links_only_ever_reduce_what_may_be_sent() {
    let mut o = outreach_world().await;
    let ada = consented(&o.w).await;
    let t = template(
        &o.w,
        &o.w.owner_ctx,
        "Merhaba",
        "Kataloğumuz: https://acme.example.invalid/katalog",
    )
    .await;
    let mut d = definition_steps(&[(t, 0), (t, 3)], json!({"explicit": [ada]}));
    d.click_tracking = true;
    let c = running(&o, d).await;
    o.mail.push_mail(accepted("once"));
    dispatch(&o.w, o.w.owner_ctx.now).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    platform(&mut o.w, false);
    let w = &o.w;
    let outbox = w.uow.snapshot().inbox.outbox.len();
    let path = |url: &str| -> Vec<String> {
        url.strip_prefix("https://panel.test/")
            .unwrap()
            .split('/')
            .map(str::to_owned)
            .collect()
    };
    let click = mail
        .text
        .split_whitespace()
        .find(|t| t.starts_with("https://panel.test/c/"))
        .unwrap()
        .to_owned();
    let p = path(&click);
    let to = links::click(
        &w.deps,
        w.ws,
        &p[2],
        &p[3],
        &p[4],
        links::ClickFrom {
            head: false,
            user_agent: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(to.as_deref(), Some("https://acme.example.invalid/katalog"));
    let p = path(&mail.list_unsubscribe.as_ref().unwrap().https);
    assert!(
        links::unsubscribe(&w.deps, w.ws, &p[2], &p[3])
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        w.uow.snapshot().inbox.outbox.len(),
        outbox,
        "nothing queued"
    );
    assert_eq!(sent_mail(&o.mail).len(), 1, "nothing sent");
    let e = enrollments(w, c.campaign.id).pop().unwrap();
    assert_eq!(e.stop, Some(jt_outreach::StopReason::Unsubscribed));
    // The switch back on: the stopped sequence sends nothing more.
    platform(&mut o.w, true);
    dispatch(&o.w, days_later(4)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1);
}
