//! The public links' use cases (plan L5-T2; spec 2026-10-30-leads-pool-outreach-design.md
//! §3.14, D20, D63): the one-click unsubscribe writes the suppression and the withdrawal, stops
//! the person's sequence and records the send's unsubscribe once; the emailed `unsubscribe` (the
//! `mailto:` fallback) does the same; a click goes where the email's own link went, and only an
//! email whose links were rewritten has click links. The routes over them are
//! `jt_webhook/tests/links.rs`'s. Every value is invented.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::MailMessage;
use jt_app::usecases::inbox::replies;
use jt_app::usecases::outreach::links::{self, ClickFrom, Lang, LinkPage};
use jt_app::usecases::outreach::{self, CampaignSaveInput, ControlAction, ControlInput};
use jt_connector::{InboundEvent, InboundEventId, Provider};
use jt_inbox::{Channel, ConsentKind, ConsentSource, PersonId, SuppressionReason, SyncState};
use jt_ledger::Actor;
use jt_outreach::{CampaignId, EnrollmentStatus, MacPurpose, StopReason};
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use outreach_support::*;
use serde_json::json;
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime};

/// The workspace, token and MAC of a public link `url` (`/u/{ws}/{token}/{mac}`, or a click's
/// `/c/{ws}/{token}/{link}/{mac}`), as its route receives them.
fn parts(url: &str) -> Vec<String> {
    url.strip_prefix("https://panel.test/")
        .unwrap_or_else(|| panic!("{url}"))
        .split('/')
        .map(str::to_owned)
        .collect()
}

/// Follows the unsubscribe link of `mail` as its route does.
async fn unsubscribe(w: &World, mail: &MailMessage) -> Option<LinkPage> {
    let url = &mail.list_unsubscribe.as_ref().unwrap().https;
    let p = parts(url);
    assert_eq!(p[0], "u");
    links::unsubscribe(&w.deps, p[1].parse().unwrap(), &p[2], &p[3])
        .await
        .unwrap()
}

/// The click links of `text`, in order.
fn click_urls(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|w| w.starts_with("https://panel.test/c/"))
        .map(str::to_owned)
        .collect()
}

/// Follows click link `url` at `now` as a browser would (a `GET` with a `User-Agent`).
async fn follow(w: &World, url: &str, now: OffsetDateTime) -> Option<String> {
    let p = parts(url);
    assert_eq!(p[0], "c");
    let mut deps = w.deps.clone();
    deps.clock = Arc::new(FixedClock(now));
    links::click(
        &deps,
        p[1].parse().unwrap(),
        &p[2],
        &p[3],
        &p[4],
        ClickFrom {
            head: false,
            user_agent: true,
        },
    )
    .await
    .unwrap()
}

/// A running two-step campaign (the second five days later) reaching `people`, from a template
/// whose body is `body`, its first step sent to each of them at `FIXED_NOW`.
async fn sent(o: &Outreach, people: &[PersonId], body: &str, click_tracking: bool) -> CampaignId {
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"frequency": {"min_gap_days": 0, "max_per_30_days": 30}}))
            .unwrap(),
    )
    .await
    .unwrap();
    let t = template(w, &w.owner_ctx, "Merhaba", body).await;
    let mut d = definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": people }));
    d.click_tracking = click_tracking;
    let c = running(o, d).await;
    let before = sent_mail(&o.mail).len();
    // One a minute (the campaign's pacing at 60 an hour).
    for m in 0..people.len() {
        o.mail.push_mail(accepted("s"));
        dispatch(w, FIXED_NOW + Duration::minutes(m as i64)).await;
    }
    assert_eq!(sent_mail(&o.mail).len(), before + people.len());
    c.campaign.id
}

fn enrollment_of(w: &World, c: CampaignId, p: PersonId) -> jt_app::ports::outreach::EnrollmentRow {
    enrollments(w, c)
        .into_iter()
        .find(|e| e.person_id == p)
        .unwrap()
}

fn send_to(w: &World, c: CampaignId, p: PersonId) -> jt_app::ports::outreach::SendRow {
    let e = enrollment_of(w, c, p);
    sends(w)
        .into_iter()
        .find(|s| s.enrollment_id == e.id)
        .unwrap()
}

/// `person`'s suppressions and email consents, as stored.
fn compliance(w: &World, person: PersonId) -> (Vec<SuppressionReason>, Vec<jt_inbox::Consent>) {
    let s = w.uow.snapshot();
    let suppressions = s
        .inbox
        .suppressions
        .iter()
        .map(|(_, x)| x)
        .filter(|x| x.person_id == person && x.channel == Channel::Email)
        .map(|x| x.reason)
        .collect();
    let consents = s
        .inbox
        .consents
        .iter()
        .map(|(_, c)| c.clone())
        .filter(|c| c.person_id == person && c.channel == Channel::Email)
        .collect();
    (suppressions, consents)
}

#[tokio::test]
async fn unsubscribe_writes_suppression_consent_stops_and_ledger() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let page = unsubscribe(w, &mail).await.expect("the link holds");
    assert_eq!(
        page,
        LinkPage {
            lang: Lang::Tr,
            sender_company: Some("Acme Yazılım A.Ş.".into()),
        }
    );
    // The suppression and a withdrawal by the customer, now, for the İYS sync to push.
    let (suppressions, consents) = compliance(w, ada);
    assert_eq!(suppressions, [SuppressionReason::Unsubscribe]);
    let withdrawal = consents.last().unwrap();
    assert_eq!(
        (
            withdrawal.kind,
            withdrawal.source,
            withdrawal.at,
            withdrawal.sync_state
        ),
        (
            ConsentKind::Withdrawn,
            ConsentSource::Customer,
            FIXED_NOW,
            SyncState::Pending
        )
    );
    // The sequence stops, the send records it, the ledger names ids only.
    let e = enrollment_of(w, c, ada);
    assert_eq!(e.status, EnrollmentStatus::Stopped);
    assert_eq!(e.stop, Some(StopReason::Unsubscribed));
    let send = send_to(w, c, ada);
    assert_eq!(send.unsubscribed_at, Some(FIXED_NOW));
    let entry = w.entries("outreach.unsubscribed").pop().unwrap();
    assert_eq!(
        entry.payload,
        json!({"person_id": ada, "send_id": send.id, "via": "link"})
    );
    assert_eq!(
        entry.actor,
        Actor::System {
            component: "unsubscribe_link".into()
        }
    );
    let stopped = w.entries("outreach.enrollment_stopped").pop().unwrap();
    assert_eq!(stopped.payload["reason"], "unsubscribed");
    for e in w.ledger("outreach.") {
        assert!(!e.payload.to_string().contains("example.invalid"), "{e:?}");
    }
    // The next step never goes out; the email carried the link once more, which changes nothing.
    dispatch(w, FIXED_NOW + Duration::days(6)).await;
    assert_eq!(sent_mail(&o.mail).len(), 1);
    assert!(unsubscribe(w, &mail).await.is_some());
    assert_eq!(w.entries("outreach.unsubscribed").len(), 1);
    assert_eq!(compliance(w, ada).1.len(), consents.len());
}

/// An email from `from` to the mailbox, consumed, with `subject` and `text`.
async fn email_in(o: &Outreach, from: &str, subject: &str, text: &str, at: OffsetDateTime) {
    let w = &o.w;
    let raw = format!(
        "From: {from}\r\nTo: {FROM}\r\nSubject: {subject}\r\nMessage-ID: <in-{}@example.invalid>\r\n\r\n{text}",
        InboundEventId::new_v7()
    );
    let draft = jt_mail::parse_message("account", "INBOX", 42, 7, raw.as_bytes(), false).unwrap();
    let n = InboundEventId::new_v7();
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

#[tokio::test]
async fn mailto_subject_unsubscribe_is_honoured() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    assert_eq!(
        mail.list_unsubscribe.unwrap().mailto.as_deref(),
        Some("mailto:satis@acme.example.invalid?subject=unsubscribe")
    );
    // What a mail client sends for the mailto address.
    let later = FIXED_NOW + Duration::hours(2);
    email_in(&o, "ada@example.invalid", "UNSUBSCRIBE", "", later).await;
    let (suppressions, consents) = compliance(w, ada);
    assert_eq!(suppressions, [SuppressionReason::Unsubscribe]);
    assert_eq!(consents.last().unwrap().kind, ConsentKind::Withdrawn);
    assert_eq!(
        enrollment_of(w, c, ada).stop,
        Some(StopReason::Unsubscribed)
    );
    let send = send_to(w, c, ada);
    assert_eq!(send.unsubscribed_at, Some(later));
    assert_eq!(
        w.entries("outreach.unsubscribed").pop().unwrap().payload,
        json!({"person_id": ada, "send_id": send.id, "via": "mail"})
    );
    // Someone no outreach email reached in 90 days who writes the same is a withdrawal like any
    // other: suppressed and withdrawn, no outreach unsubscribe.
    let bora = person(w, "Bora", "bora@example.invalid").await;
    email_in(&o, "bora@example.invalid", "unsubscribe", "", later).await;
    let (suppressions, consents) = compliance(w, bora);
    assert_eq!(suppressions, [SuppressionReason::Unsubscribe]);
    assert_eq!(consents.last().unwrap().kind, ConsentKind::Withdrawn);
    assert_eq!(w.entries("outreach.unsubscribed").len(), 1);
    // A withdrawal in the text, not the subject, stops Cem's sequence as withdrawn consent.
    let cem = person(w, "Cem", "cem@example.invalid").await;
    consent_email(w, cem).await;
    let c2 = sent(&o, &[cem], "İkinci kampanya.", false).await;
    email_in(
        &o,
        "cem@example.invalid",
        "Re: Merhaba",
        "withdraw consent",
        later,
    )
    .await;
    assert_eq!(
        enrollment_of(w, c2, cem).stop,
        Some(StopReason::ConsentWithdrawn)
    );
    assert_eq!(w.entries("outreach.unsubscribed").len(), 1);
}

#[tokio::test]
async fn click_disabled_campaign_has_no_rewritten_links() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        false,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    assert!(
        mail.text
            .contains("Kataloğumuz: https://acme.example.invalid/katalog\n"),
        "{}",
        mail.text
    );
    assert!(click_urls(&mail.text).is_empty());
    // A click link made for it (its MAC holds) leads nowhere and counts nothing.
    let token = mail.message_id[1..].split('@').next().unwrap().to_owned();
    let mac = links::mac(
        &w.deps,
        w.ws,
        MacPurpose::Click,
        token.parse().unwrap(),
        Some(0),
    )
    .unwrap();
    let url = format!("https://panel.test/c/{}/{token}/0/{mac}", w.ws);
    assert_eq!(
        follow(w, &url, FIXED_NOW + Duration::minutes(5)).await,
        None
    );
    assert!(sends(w).iter().all(|s| s.clicks + s.automated_clicks == 0));
}

#[tokio::test]
async fn a_click_goes_where_the_emails_own_link_went_even_after_an_edit() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog ve fiyatlar: https://acme.example.invalid/fiyat",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let urls = click_urls(&mail.text);
    assert_eq!(urls.len(), 2, "{}", mail.text);
    assert!(!mail.text.contains("acme.example.invalid/katalog"));
    // The campaign is paused, its steps edited to another template, and resumed.
    outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c,
        ControlInput {
            action: ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    let other = template(
        w,
        &w.owner_ctx,
        "Yeni",
        "Başka bir yer: https://acme.example.invalid/yeni",
    )
    .await;
    let current = outreach::campaigns_get(&w.deps, &w.owner_ctx, c)
        .await
        .unwrap()
        .campaign;
    let mut d = definition_steps(&[(other, 0), (other, 5)], json!({ "explicit": [ada] }));
    d.click_tracking = true;
    outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: Some(c),
            expected_revision: Some(current.revision),
            name: current.name.clone(),
            mailbox_id: o.mailbox,
            definition: d,
            request_key: None,
        },
    )
    .await
    .unwrap();
    outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c,
        ControlInput {
            action: ControlAction::Resume,
        },
    )
    .await
    .unwrap();
    let later = FIXED_NOW + Duration::minutes(5);
    assert_eq!(
        follow(w, &urls[0], later).await.as_deref(),
        Some("https://acme.example.invalid/katalog")
    );
    assert_eq!(
        follow(w, &urls[1], later).await.as_deref(),
        Some("https://acme.example.invalid/fiyat")
    );
    let send = send_to(w, c, ada);
    assert_eq!((send.clicks, send.automated_clicks), (2, 0));
    assert_eq!(send.first_clicked_at, Some(later));
}

#[tokio::test]
async fn an_inbox_commercial_email_unsubscribes_its_person() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    o.mail.push_mail(accepted("inbox-send"));
    replies::send(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({
            "channel": "email", "text": "Yeni ürünümüzü tanıtmak isteriz.",
            "intent": "commercial", "request_key": "k1",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let mail = sent_mail(&o.mail).pop().unwrap();
    let page = unsubscribe(w, &mail).await.expect("the link holds");
    assert_eq!(page.lang, Lang::Tr);
    let (suppressions, consents) = compliance(w, ada);
    assert_eq!(suppressions, [SuppressionReason::Unsubscribe]);
    assert_eq!(consents.last().unwrap().kind, ConsentKind::Withdrawn);
    // No outreach email: no send row to mark.
    assert_eq!(
        w.entries("outreach.unsubscribed").pop().unwrap().payload,
        json!({"person_id": ada, "send_id": null, "via": "link"})
    );
    // The next commercial email to her is refused.
    let e = err(replies::send(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({
            "channel": "email", "text": "Bir kez daha.", "intent": "commercial",
            "request_key": "k2",
        }))
        .unwrap(),
    )
    .await);
    assert_eq!(e.message, "IZIN_YOK");
}

#[tokio::test]
async fn a_test_emails_link_unsubscribes_the_members_inbox_person() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let d = definition(t, json!({"explicit": [ada]}));
    let c = campaign(w, &w.owner_ctx, o.mailbox, d).await.campaign.id;
    o.mail.push_mail(accepted("test"));
    outreach::test_send(&w.deps, &w.owner_ctx, c, Default::default())
        .await
        .unwrap();
    let mail = sent_mail(&o.mail).pop().unwrap();
    assert!(unsubscribe(w, &mail).await.is_some());
    let me = w
        .uow
        .snapshot()
        .inbox
        .identities
        .iter()
        .find(|i| i.value_normalized == "owner@acme.example")
        .unwrap()
        .person_id;
    // The suppression only: a test email rests on no consent row, so its unsubscribe writes
    // no withdrawal either (nothing for İYS about the member's own address).
    assert_eq!(
        compliance(w, me),
        (vec![SuppressionReason::Unsubscribe], vec![])
    );
    assert_eq!(
        w.entries("outreach.unsubscribed").pop().unwrap().payload,
        json!({"person_id": me, "send_id": null, "via": "link"})
    );
    let e = err(outreach::test_send(&w.deps, &w.owner_ctx, c, Default::default()).await);
    assert_eq!(e.details["reason"], "IZIN_YOK");
    // Ada, the campaign's audience, is untouched.
    assert!(compliance(w, ada).0.is_empty());
}

#[tokio::test]
async fn a_link_that_does_not_hold_writes_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let p = parts(&mail.list_unsubscribe.as_ref().unwrap().https);
    let (ws, token, mac) = (w.ws, p[2].clone(), p[3].clone());
    let (other, _) = w.other_workspace().await;
    let state = || {
        let s = w.uow.snapshot();
        format!("{:?} {:?} {:?}", s.inbox, s.outreach, s.ledger)
    };
    let before = state();
    let mut changed = mac.clone();
    changed.replace_range(..1, if mac.starts_with('A') { "B" } else { "A" });
    let click_mac =
        links::mac(&w.deps, ws, MacPurpose::Click, token.parse().unwrap(), None).unwrap();
    for (ws, token, mac) in [
        (ws, format!("urn:uuid:{token}"), mac.clone()),
        (ws, format!("{{{token}}}"), mac.clone()),
        (ws, token.replace('-', ""), mac.clone()),
        (ws, token.clone(), changed),
        (ws, token.clone(), click_mac),
        (ws, token.clone(), String::new()),
        (other, token.clone(), mac.clone()),
    ] {
        assert_eq!(
            links::unsubscribe(&w.deps, ws, &token, &mac).await.unwrap(),
            None,
            "{token} {mac}"
        );
        assert_eq!(
            links::unsubscribe_page(&w.deps, ws, &token, &mac)
                .await
                .unwrap(),
            None
        );
    }
    // A MAC that holds for a token of no email.
    let stray = uuid::Uuid::from_u128(77);
    let stray_mac = links::mac(&w.deps, ws, MacPurpose::Unsubscribe, stray, None).unwrap();
    assert_eq!(
        links::unsubscribe(&w.deps, ws, &stray.to_string(), &stray_mac)
            .await
            .unwrap(),
        None
    );
    assert!(state() == before, "nothing written");
    assert!(compliance(w, ada).0.is_empty());
    assert_eq!(
        enrollments(w, sends(w)[0].campaign_id)[0].status,
        EnrollmentStatus::Active
    );
}

#[tokio::test]
async fn an_erased_recipient_answers_the_page_and_writes_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    jt_app::usecases::inbox::erasure::erase(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({"confirm": true})).unwrap(),
    )
    .await
    .unwrap();
    let ledger = w.ledger("").len();
    let (suppressions, consents) = compliance(w, ada);
    let page = unsubscribe(w, &mail).await.expect("answered");
    assert_eq!(page.sender_company.as_deref(), Some("Acme Yazılım A.Ş."));
    assert_eq!(w.ledger("").len(), ledger);
    assert_eq!(compliance(w, ada), (suppressions, consents));
}
