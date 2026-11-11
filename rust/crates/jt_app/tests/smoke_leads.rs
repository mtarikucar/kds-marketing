//! `make smoke-leads` (spec 2026-10-30-leads-pool-outreach-design.md §11 "Smoke"; plan L9-T1):
//! the leads program end to end, in process. The fakes hold the data; the mail goes through the
//! real `jt_mail` adapter to `jt_mail/tests/support`'s loopback SMTP and IMAP fixtures (TLS with
//! the fixtures' own CA), so the headers and the footer are read off the wire. No database, no
//! provider, no network beyond loopback. The platform switch `JEETA_OUTREACH_ENABLED` is turned
//! on here, inside the test, and the same flow with it off sends nothing. Every value is invented.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

#[allow(dead_code, unused_imports)]
#[path = "../../adapters/jt_mail/tests/support/mod.rs"]
mod mail_fixture;

use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    LeadGenFetcher, MailSender, MailboxCursor, MailboxPoller, MailboxPosition, MessagingSender,
    OAuthProvider, Publisher, SmsSender, Telephony,
};
use jt_app::usecases::inbox::replies;
use jt_app::usecases::jobs::{run_mail_inbox_poll, run_research_plan};
use jt_app::usecases::outreach::{self, links};
use jt_app::usecases::{prospects, research};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, MailTls, Provider};
use jt_inbox::{ConvState, JourneyStatus, PersonId};
use jt_ledger::Actor;
use jt_mail::MailConnector;
use jt_outbound::Egress;
use jt_outreach::{CampaignStatus, EnrollmentStatus, StopReason};
use jt_prospects::{
    CreateInput, EntityKind, FieldInput, ProspectStatus, ReasonInput, ScoreInput, SourceRefInput,
    TaskKind,
};
use jt_strategy::{
    Area, Criterion, IcpEntry, Prospecting, Rubric, Sections, Segment, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_testkit::fakes::{FIXED_NOW, ScriptedConnector};
use mail_fixture::{CA, ImapMode, SmtpMode};
use outreach_support::*;
use serde_json::json;
use support::*;
use time::format_description::well_known::{Rfc2822, Rfc3339};
use time::{Duration, OffsetDateTime};

/// The customer's mailbox: the outreach sender and the address replies reach.
const MAILBOX: &str = "satis@acme.example.invalid";
/// The two businesses the agent finds.
const ADA: (&str, &str) = ("Ada Kafe", "info@ada-kafe.example.invalid");
const BORA: (&str, &str) = ("Bora Kafe", "info@bora-kafe.example.invalid");
/// The footer's source line of a business recipient reached on its public data (spec §3.10).
const PUBLIC_DATA_LINE: &str =
    "Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.";
/// The UIDVALIDITY the IMAP fixture answers.
const VALIDITY: u32 = 42;

/// A registry holding the real mail adapter, nothing else.
struct MailOnly(Arc<MailConnector>);

impl ConnectorRegistry for MailOnly {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        (provider == Provider::Mail).then(|| self.0.clone() as Arc<dyn Connector>)
    }
    fn oauth(&self, _: Provider) -> Option<Arc<dyn OAuthProvider>> {
        None
    }
    fn sms(&self, _: Provider) -> Option<Arc<dyn SmsSender>> {
        None
    }
    fn mail_sender(&self, provider: Provider) -> Option<Arc<dyn MailSender>> {
        (provider == Provider::Mail).then(|| self.0.clone() as Arc<dyn MailSender>)
    }
    fn mailbox_poller(&self, provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        (provider == Provider::Mail).then(|| self.0.clone() as Arc<dyn MailboxPoller>)
    }
    fn publisher(&self, _: Provider) -> Option<Arc<dyn Publisher>> {
        None
    }
    fn insights(&self, _: Provider) -> Option<Arc<dyn InsightsReader>> {
        None
    }
    fn messaging(&self, _: Provider) -> Option<Arc<dyn MessagingSender>> {
        None
    }
    fn ads(&self, _: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        None
    }
    fn leadgen(&self, _: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        None
    }
    fn telephony(&self, _: Provider) -> Option<Arc<dyn Telephony>> {
        None
    }
    fn consent(&self, _: Provider) -> Option<Arc<dyn ConsentSync>> {
        None
    }
    fn delivery_reports(&self, _: Provider) -> Option<Arc<dyn DeliveryReports>> {
        None
    }
}

/// The mailbox credential pointing at the loopback fixtures on `smtp` and `imap`.
fn credential(smtp: u16, imap: u16) -> Credential {
    Credential::Mailbox {
        smtp_host: "localhost".into(),
        smtp_port: smtp,
        imap_host: "localhost".into(),
        imap_port: imap,
        username: "private-login".into(),
        // The IMAP fixture accepts this password only.
        password: "mail-password".into(),
        from_address: MAILBOX.into(),
        tls: MailTls::Implicit,
    }
}

/// Points the mailbox at fixtures listening on `smtp` and `imap` (each fixture is one session).
async fn point(o: &Outreach, smtp: u16, imap: u16) {
    let w = &o.w;
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&credential(smtp, imap)).unwrap())
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities()
        .set_sealed(o.mailbox, Some(sealed), w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
}

/// An SMTP fixture expecting one email from the mailbox to `to`; its port and what it received.
async fn smtp_to(to: &'static str) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    mail_fixture::smtp(SmtpMode {
        from: Some(MAILBOX),
        to: Some(to),
        ..SmtpMode::default()
    })
    .await
}

/// The strategy in force: one ICP entry (cafes in İstanbul) and a one-criterion rubric that
/// qualifies at 60.
fn sections() -> Sections {
    Sections {
        audience: vec![Segment {
            key: "kafeler".into(),
            name: "Kafeler".into(),
            description: "mahalle kafeleri".into(),
        }],
        prospecting: Prospecting {
            icp: vec![IcpEntry {
                key: "kafeler".into(),
                segment_key: "kafeler".into(),
                sectors: vec!["kafe".into()],
                areas: vec![Area {
                    city: "İstanbul".into(),
                    district: None,
                }],
                signals: vec!["yeni şube".into()],
                exclusions: vec![],
                size_hint: String::new(),
                language: Some("tr".into()),
                daily_cap: 20,
                backlog_target: 10,
            }],
            rubric: Rubric {
                criteria: vec![Criterion {
                    key: "fit".into(),
                    description: "serves coffee".into(),
                    weight: 100,
                }],
                qualify_at: 60,
            },
        },
        ..Sections::default()
    }
}

/// The smoke's world: an active workspace with the strategy of [`sections`] in force, the
/// footer's sender identity, the platform switch `on` or off, and a verified mailbox whose mail
/// goes through the real adapter (the fixtures are on loopback, so only `localhost` is allowed).
async fn smoke_world(on: bool) -> Outreach {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id: StrategyVersionId::new_v7(),
            workspace_id: w.ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: sections(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: w.owner },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(w.owner),
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    let egress = Arc::new(Egress::new(&[]));
    egress.allow_tenant_host(w.ws, "localhost");
    let mail = MailConnector::new(egress)
        .with_root_certificate(CA.to_vec())
        .unwrap();
    w.deps.connectors = Arc::new(MailOnly(Arc::new(mail)));
    platform(&mut w, on);
    sender_identity(&w).await;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "mailbox".into(),
            name: "Satış".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    cap.external_id = Some(MAILBOX.into());
    // Nothing listens on port 1: a send that is not expected fails instead of reaching a fixture.
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&credential(1, 1)).unwrap())
        .unwrap();
    let mailbox = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    Outreach {
        w,
        mailbox,
        // Unused: the registry above holds the real adapter.
        mail: Arc::new(ScriptedConnector::new(Provider::Mail)),
        netgsm: Arc::new(ScriptedConnector::new(Provider::Netgsm)),
    }
}

/// What the agent records for business `name` reached at `email`, found for research `task`.
fn found(name: &str, email: &str, task: jt_prospects::ResearchTaskId) -> CreateInput {
    let evidence = |value: &str| {
        Some(FieldInput {
            value: value.to_owned(),
            sources: vec![SourceRefInput::Url {
                url: format!("https://{}/iletisim", email.split('@').nth(1).unwrap()),
                note: None,
            }],
            captured_at: FIXED_NOW - Duration::days(1),
        })
    };
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: None,
        language: Some("tr".into()),
        segment_key: Some("kafeler".into()),
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
        research_task_id: Some(task),
        discovered_at: vec![],
        distinct_from: vec![],
        request_key: None,
    }
}

/// The run up to a launch: the planner opens the ICP's standing task, an agent claims it,
/// records both businesses, scores them (each qualifies at the threshold on its own) and
/// promotes them (the solo owner gets them inline); the owner opens the business-recipient
/// basis and saves a two-step campaign (the second step five days later) reaching both.
/// The two people, Ada's first, and the draft.
async fn up_to_launch(o: &Outreach) -> ([PersonId; 2], outreach::CampaignOut) {
    let w = &o.w;
    run_research_plan(&w.deps, FIXED_NOW).await;
    let tasks = w.uow.snapshot().prospects.tasks;
    assert_eq!(tasks.len(), 1);
    assert!(matches!(tasks[0].kind, TaskKind::Standing { .. }));
    let agent = w
        .agent(&[
            "prospects.work",
            "inbox.work",
            "outreach.work",
            "workspace.read",
        ])
        .await;
    assert!(
        research::tasks_claim(&w.deps, &agent, tasks[0].id)
            .await
            .unwrap()
            .claimed
    );
    let digest = prospects::rubric_digest(&sections().prospecting.rubric);
    let mut people = Vec::new();
    for (name, email) in [ADA, BORA] {
        let p = prospects::create(&w.deps, &agent, found(name, email, tasks[0].id))
            .await
            .unwrap()
            .prospect;
        let scored = prospects::score(
            &w.deps,
            &agent,
            p.id,
            ScoreInput {
                score: 80,
                reasons: vec![ReasonInput {
                    criterion: "fit".into(),
                    points: 80,
                    evidence: "espresso on their menu".into(),
                    source: None,
                }],
                rubric_digest: digest.clone(),
            },
        )
        .await
        .unwrap();
        assert!(scored.qualified, "auto-qualified at the threshold");
        assert_eq!(scored.status, ProspectStatus::Qualified);
        let out = prospects::promote(
            &w.deps,
            &agent,
            prospects::PromoteInput {
                prospect_ids: vec![p.id],
                request_key: None,
            },
        )
        .await
        .unwrap()
        .items
        .remove(0);
        let prospects::PromoteOutcome::Promoted {
            person_id,
            journey_id,
            ..
        } = out
        else {
            panic!("not promoted: {out:?}");
        };
        let journey = w
            .uow
            .snapshot()
            .inbox
            .journeys
            .into_iter()
            .find(|j| j.id == journey_id)
            .unwrap();
        assert_eq!(journey.status, JourneyStatus::New);
        assert_eq!(journey.owner, Some(w.owner), "distributed inline");
        people.push(person_id);
    }
    open_b2b(w, false).await;
    let t = template(
        w,
        &w.owner_ctx,
        "{{company}} için kısa bir tanışma",
        "Merhaba, {{company}} için siparişleri kolaylaştıran bir uygulamamız var.",
    )
    .await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition_steps(&[(t, 0), (t, 5)], json!({"explicit": people})),
    )
    .await;
    ([people[0], people[1]], c)
}

/// The headers of `wire`, folded lines joined.
fn headers(wire: &str) -> String {
    let end = wire.find("\r\n\r\n").unwrap();
    wire[..end].replace("\r\n ", " ").replace("\r\n\t", " ")
}

/// The value of header `name` in `wire`.
fn header(wire: &str, name: &str) -> Option<String> {
    let prefix = format!("{}:", name.to_ascii_lowercase());
    headers(wire)
        .split("\r\n")
        .find(|l| l.to_ascii_lowercase().starts_with(&prefix))
        .map(|l| l[prefix.len()..].trim().to_owned())
}

/// The decoded text of the email `wire`, as the inbox's own parser reads it.
fn text_of(wire: &[u8]) -> String {
    let draft = jt_mail::parse_message("smoke", "INBOX", VALIDITY, 1, wire, false).unwrap();
    draft.payload["text"]
        .as_str()
        .unwrap()
        .replace("\r\n", "\n")
}

/// Checks the outreach email `wire` sent to `to`: the footer and the RFC 8058 one-click
/// unsubscribe (both `List-Unsubscribe` addresses and `List-Unsubscribe-Post`). Its one-click
/// address.
fn assert_outreach_email(wire: &[u8], to: &str) -> String {
    let raw = String::from_utf8_lossy(wire).into_owned();
    assert!(header(&raw, "To").unwrap().contains(to), "{raw}");
    assert!(
        header(&raw, "From").unwrap().contains(MAILBOX),
        "the mailbox sends"
    );
    assert_eq!(
        header(&raw, "List-Unsubscribe-Post").as_deref(),
        Some("List-Unsubscribe=One-Click")
    );
    let list = header(&raw, "List-Unsubscribe").expect("List-Unsubscribe");
    let https = list
        .split(',')
        .map(|a| a.trim().trim_start_matches('<').trim_end_matches('>'))
        .find(|a| a.starts_with("https://panel.test/u/"))
        .unwrap_or_else(|| panic!("no one-click address: {list}"))
        .to_owned();
    assert!(
        list.contains(&format!("<mailto:{MAILBOX}?subject=unsubscribe>")),
        "{list}"
    );
    let text = text_of(wire);
    assert!(text.contains(PUBLIC_DATA_LINE), "{text}");
    assert!(text.contains("Acme Yazılım A.Ş."), "{text}");
    assert!(text.contains("https://acme.example.invalid/kvkk"), "{text}");
    assert!(text.contains(&https), "the footer carries the link: {text}");
    https
}

/// The conversation of `person`.
fn conversation_of(o: &Outreach, person: PersonId) -> jt_inbox::Conversation {
    o.w.uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|c| c.person_id == person)
        .unwrap()
}

fn journey_status(o: &Outreach, person: PersonId) -> JourneyStatus {
    o.w.uow
        .snapshot()
        .inbox
        .journeys
        .into_iter()
        .find(|j| j.person_id == person)
        .unwrap()
        .status
}

/// `email` (a reply of `from` to `in_reply_to`) as the IMAP fixture serves it.
fn reply_mail(from: &str, in_reply_to: &str, at: OffsetDateTime) -> Vec<u8> {
    format!(
        "From: Ada Kafe <{from}>\r\nTo: {MAILBOX}\r\nSubject: Re: tanışma\r\nMessage-ID: <reply-1@ada-kafe.example.invalid>\r\nIn-Reply-To: {in_reply_to}\r\nReferences: {in_reply_to}\r\nDate: {}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMerhaba, fiyatlarınızı alabilir miyiz?\r\n",
        at.format(&Rfc2822).unwrap()
    )
    .into_bytes()
}

#[tokio::test]
async fn prospect_to_contacted_through_the_real_mail_adapter() {
    let o = smoke_world(true).await;
    let w = &o.w;
    let ([ada, bora], c) = up_to_launch(&o).await;
    let c = launch(w, &w.owner_ctx, c.campaign.id, c.campaign.revision)
        .await
        .unwrap();
    assert_eq!(c.campaign.status, CampaignStatus::Running);
    let id = c.campaign.id;
    assert_eq!(c.enrollment.as_ref().unwrap().enrolled, 2);
    // The dispatcher paces one email a minute (60 an hour): Ada first, then Bora.
    let order: Vec<PersonId> = enrollments(w, id).iter().map(|e| e.person_id).collect();
    assert_eq!(order, [ada, bora]);
    let mut wires = Vec::new();
    for (minute, to) in [(0, ADA.1), (1, BORA.1)] {
        let (port, task) = smtp_to(to).await;
        point(&o, port, 1).await;
        let report = dispatch(w, FIXED_NOW + Duration::minutes(minute)).await;
        assert_eq!(report.failed, 0, "{report:?}");
        wires.push(task.await.unwrap());
    }
    let ada_unsubscribe = assert_outreach_email(&wires[0], ADA.1);
    let bora_unsubscribe = assert_outreach_email(&wires[1], BORA.1);
    assert_ne!(ada_unsubscribe, bora_unsubscribe);
    assert!(text_of(&wires[0]).contains("Ada Kafe için siparişleri"));
    assert_eq!(sends(w).len(), 2);
    // An outreach email moves no journey (`OutreachSent` is rank-neutral).
    assert_eq!(journey_status(&o, ada), JourneyStatus::New);

    // Ada answers; the mailbox's next poll reads it from the IMAP fixture.
    let ada_mid = header(&String::from_utf8_lossy(&wires[0]), "Message-ID").unwrap();
    let replied_at = FIXED_NOW + Duration::hours(1);
    let body = reply_mail(ADA.1, &ada_mid, replied_at);
    let (imap, task) = mail_fixture::imap_with_mode(
        false,
        VALIDITY,
        vec![(7, body.len() as u32, body)],
        1,
        ImapMode {
            sent: None,
            ..ImapMode::default()
        },
    )
    .await;
    point(&o, 1, imap).await;
    {
        // Connected earlier: the cursor stands before the reply.
        let mut cursor = MailboxCursor::default();
        cursor.mailboxes.insert(
            "INBOX".into(),
            MailboxPosition {
                uidvalidity: VALIDITY,
                last_uid: 6,
            },
        );
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.mail_cursors().store(o.mailbox, cursor).await.unwrap();
        r.commit().await.unwrap();
    }
    let polled = run_mail_inbox_poll(&w.deps, replied_at + Duration::minutes(5)).await;
    assert_eq!((polled.changed, polled.failed), (1, 0), "{polled:?}");
    task.await.unwrap();
    let rows = enrollments(w, id);
    assert_eq!(rows[0].status, EnrollmentStatus::Stopped);
    assert_eq!(rows[0].stop, Some(StopReason::Replied));
    assert_eq!(rows[1].status, EnrollmentStatus::Active, "Bora's goes on");
    let conversation = conversation_of(&o, ada);
    assert_eq!(conversation.state, ConvState::Ours, "our turn to answer");
    assert_eq!(journey_status(&o, ada), JourneyStatus::New);

    // Our answer (the agent's, in the thread) moves Ada's journey to Contacted.
    let agent = w.agent(&["inbox.work", "workspace.read"]).await;
    let (port, task) = smtp_to(ADA.1).await;
    point(&o, port, 1).await;
    let answered = replies::reply(
        &w.deps,
        &at(&agent, replied_at + Duration::minutes(10)),
        conversation.id,
        serde_json::from_value(json!({
            "text": "Merhaba, fiyat listemizi ekte bulabilirsiniz.",
            "intent": "reply", "request_key": "smoke-answer",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(answered.state, "sent");
    let answer = String::from_utf8_lossy(&task.await.unwrap()).into_owned();
    assert_eq!(
        header(&answer, "In-Reply-To").as_deref(),
        Some("<reply-1@ada-kafe.example.invalid>")
    );
    assert!(
        header(&answer, "List-Unsubscribe").is_none(),
        "a reply is not commercial"
    );
    assert_eq!(conversation_of(&o, ada).state, ConvState::Theirs);
    assert_eq!(journey_status(&o, ada), JourneyStatus::Contacted);

    // Bora uses the one-click unsubscribe (the RFC 8058 POST).
    let parts: Vec<&str> = bora_unsubscribe
        .strip_prefix("https://panel.test/u/")
        .unwrap()
        .split('/')
        .collect();
    assert_eq!(parts[0], w.ws.to_string());
    let page = links::unsubscribe(&w.deps, w.ws, parts[1], parts[2])
        .await
        .unwrap();
    assert!(page.is_some(), "the link holds");
    let s = w.uow.snapshot();
    assert!(
        s.inbox.suppressions.iter().any(|(_, x)| x.person_id == bora
            && x.channel == jt_inbox::Channel::Email
            && x.reason == jt_inbox::SuppressionReason::Unsubscribe),
        "the suppression is written"
    );
    let rows = enrollments(w, id);
    assert_eq!(rows[1].status, EnrollmentStatus::Stopped);
    assert_eq!(rows[1].stop, Some(StopReason::Unsubscribed));

    // Day six: the second step is due for nobody; nothing is sent (nothing listens either).
    let report = dispatch(w, FIXED_NOW + Duration::days(6)).await;
    assert_eq!(report.failed, 0);
    assert_eq!(sends(w).len(), 2);

    // The report numbers match what happened.
    let window = |d: i64| (FIXED_NOW + Duration::days(d)).format(&Rfc3339).unwrap();
    let out = outreach::report::report(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "campaign_id": id, "from": window(-1), "to": window(30),
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(out.groups.len(), 1);
    let g = &out.groups[0];
    assert_eq!(
        (g.enrolled, g.sent, g.failed, g.refused, g.bounced),
        (2, 2, 0, 0, 0)
    );
    assert_eq!((g.replied, g.replied_threaded, g.unsubscribed), (1, 1, 1));
    assert_eq!(g.stopped.get("replied"), Some(&1));
    assert_eq!(g.stopped.get("unsubscribed"), Some(&1));
    let pool = prospects::report::report(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"from": window(-1), "to": window(30)})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(pool.groups.len(), 1, "{pool:?}");
    let p = &pool.groups[0];
    assert_eq!(
        p.key.as_deref(),
        Some("research_task"),
        "found for the standing task"
    );
    assert_eq!((p.created, p.scored, p.qualified, p.promoted), (2, 2, 2, 2));
    // The pool counts an outreach email as contact (each once), unlike the journey's status.
    assert_eq!((p.contacted, p.replied), (2, 1));
    // The ledger names ids and counts, never an address.
    for e in w.ledger("") {
        assert!(!e.payload.to_string().contains("example.invalid"), "{e:?}");
    }
}

#[tokio::test]
async fn with_the_platform_switch_off_nothing_is_sent() {
    let mut o = smoke_world(false).await;
    let (_, c) = up_to_launch(&o).await;
    let id = c.campaign.id;
    // The launch is refused; nothing is enrolled.
    let (port, task) = smtp_to(ADA.1).await;
    point(&o, port, 1).await;
    let e = err(launch(&o.w, &o.w.owner_ctx, id, c.campaign.revision).await);
    assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    assert!(enrollments(&o.w, id).is_empty());
    // A campaign launched while the switch was on waits once it is off: the dispatcher sends
    // nothing and the SMTP fixture is never reached.
    platform(&mut o.w, true);
    let running = launch(&o.w, &o.w.owner_ctx, id, c.campaign.revision)
        .await
        .unwrap();
    assert_eq!(running.campaign.status, CampaignStatus::Running);
    platform(&mut o.w, false);
    let w = &o.w;
    for minute in 0..3 {
        let report = dispatch(w, FIXED_NOW + Duration::minutes(minute)).await;
        assert_eq!(report.changed, 0);
    }
    assert!(sends(w).is_empty());
    assert!(w.uow.snapshot().inbox.outbox.is_empty(), "nothing queued");
    assert!(
        enrollments(w, id)
            .iter()
            .all(|e| e.status == EnrollmentStatus::Active),
        "they wait"
    );
    assert!(!task.is_finished(), "no connection reached the fixture");
    task.abort();
}
