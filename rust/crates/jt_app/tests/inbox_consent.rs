mod support;
use jt_app::{
    ports::{UnitOfWork, connectors::SendReceipt},
    usecases::inbox::{people, replies},
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use std::sync::Arc;
use support::*;

async fn setup() -> (World, ConversationId, Arc<ScriptedConnector>) {
    setup_channel("sms_line").await
}
async fn setup_channel(kind: &str) -> (World, ConversationId, Arc<ScriptedConnector>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let connector = Arc::new(ScriptedConnector::new(match kind {
        "mailbox" => Provider::Mail,
        "sms_line" => Provider::Netgsm,
        _ => Provider::Meta,
    }));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let p = people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":if kind == "mailbox" { "email" } else { "phone" },"value":if kind == "mailbox" { "ada@example.com" } else { "05321234567" }}],"source":"form"})).unwrap()).await.unwrap().person;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: "Support".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    let cred = Credential::WhatsAppCloud {
        phone_number_id: "line".into(),
        token: "private-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let cred = match kind {
        "mailbox" => Credential::Mailbox {
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            username: "support@example.com".into(),
            password: "private-mail".into(),
            from_address: "support@example.com".into(),
            tls: jt_connector::MailTls::Implicit,
        },
        "sms_line" => Credential::NetgsmSms {
            usercode: "user".into(),
            password: "private-sms".into(),
            msgheader: "Support".into(),
        },
        _ => cred,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = ConversationId::new_v7();
    let c = Conversation {
        id,
        workspace_id: w.ws,
        person_id: p.id,
        capability_id: cap.id,
        kind_key: cap.kind_key.clone(),
        state: ConvState::Ours,
        executor: Executor::Agent,
        executor_generation: 0,
        last_inbound_at: Some(now),
        last_outbound_at: None,
        created_at: now,
        updated_at: now,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.conversations().upsert_on_inbound(c).await.unwrap();
    r.commit().await.unwrap();
    (w, id, connector)
}
fn input(key: Option<&str>) -> replies::ReplyInput {
    serde_json::from_value(json!({"text":"Hello","intent":"reply","request_key":key})).unwrap()
}
fn accepted() -> Result<SendReceipt, jt_connector::ConnectorError> {
    Ok(SendReceipt {
        provider_id: "provider-1".into(),
        cost_minor: None,
    })
}

fn commercial() -> replies::ReplyInput {
    serde_json::from_value(json!({"text":"Offer","intent":"commercial"})).unwrap()
}
async fn grant(w: &World, kind: ConsentKind, at: time::OffsetDateTime) {
    let person = w.uow.snapshot().inbox.people[0].id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: person,
            channel: Channel::Sms,
            kind,
            source: ConsentSource::Customer,
            at,
            sync_state: SyncState::Pending,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
}
#[tokio::test]
async fn commercial_without_consent_refused() {
    for kind in ["sms_line", "mailbox"] {
        let (w, id, c) = setup_channel(kind).await;
        let e = replies::reply(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap_err();
        assert_eq!(e.code, jt_app::error::ErrorCode::Forbidden);
        assert_eq!(e.message, "IZIN_YOK");
        assert!(c.calls().is_empty());
        assert!(w.uow.snapshot().inbox.outbox.is_empty());
        assert!(
            w.uow
                .snapshot()
                .ledger
                .iter()
                .any(|e| e.entry.payload["reason"] == "IZIN_YOK")
        );
    }
}
#[tokio::test]
async fn withdrawal_between_queue_and_send_refuses() {
    let (w, id, c) = setup().await;
    grant(
        &w,
        ConsentKind::Explicit,
        w.owner_ctx.now - time::Duration::hours(1),
    )
    .await;
    let replies::Enqueued::New(q) = replies::enqueue(&w.deps, &w.owner_ctx, id, commercial())
        .await
        .unwrap()
    else {
        panic!()
    };
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, q)
            .await
            .unwrap()
            .state,
        "refused"
    );
    assert!(c.calls().is_empty());
    assert_eq!(
        w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
        Some("IZIN_YOK")
    );
}
#[tokio::test]
async fn late_grant_does_not_restore_consent() {
    let (w, id, c) = setup().await;
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    for at in [w.owner_ctx.now - time::Duration::hours(1), w.owner_ctx.now] {
        grant(&w, ConsentKind::Explicit, at).await;
        assert_eq!(
            replies::reply(&w.deps, &w.owner_ctx, id, commercial())
                .await
                .unwrap_err()
                .message,
            "IZIN_YOK"
        );
    }
    assert!(c.calls().is_empty());
}
#[tokio::test]
async fn reply_window_stays_bound() {
    let (w, id, c) = setup().await;
    let mut ctx = w.owner_ctx.clone();
    ctx.now += time::Duration::hours(25);
    assert_eq!(
        replies::reply(&w.deps, &ctx, id, input(None))
            .await
            .unwrap_err()
            .message,
        "reply_window_closed"
    );
    assert!(c.calls().is_empty());
}

#[tokio::test]
async fn send_request_key_reuses_response() {
    let (w, _, c) = setup().await;
    grant(&w, ConsentKind::Explicit, w.owner_ctx.now).await;
    let person = w.uow.snapshot().inbox.people[0].id;
    c.push_sms(accepted());
    let input = || {
        serde_json::from_value(
            json!({"channel":"sms","text":"Offer","intent":"commercial","request_key":"offer-1"}),
        )
        .unwrap()
    };
    let a = replies::send(&w.deps, &w.owner_ctx, person, input())
        .await
        .unwrap();
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    let b = replies::send(&w.deps, &w.owner_ctx, person, input())
        .await
        .unwrap();
    assert_eq!(a, b);
    assert_eq!(a.state, "sent");
    assert_eq!(c.calls().len(), 1);
    assert!(matches!(
        &c.calls()[0],
        jt_testkit::fakes::ConnectorCall::SendSms {
            commercial: true,
            ..
        }
    ));
}

async fn iys_setup() -> (World, Arc<ScriptedConnector>) {
    let (w, _, c) = setup().await;
    provision_iys(&w).await;
    (w, c)
}
#[tokio::test]
async fn iys_success_marks_sent_without_resubmission() {
    let (w, c) = iys_setup().await;
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    c.push_consent_add(accepted());
    assert_eq!(
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now)
            .await
            .changed,
        1
    );
    assert_eq!(
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(1))
            .await
            .changed,
        0
    );
    assert_eq!(c.calls().len(), 1);
    assert_eq!(
        w.uow.snapshot().inbox.consents[0].1.sync_state,
        SyncState::Sent
    );
    match &c.calls()[0] {
        jt_testkit::fakes::ConnectorCall::ConsentAdd { rows, credential } => {
            assert!(
                matches!(credential,Credential::NetgsmIys {brand_code,..} if brand_code=="brand-42")
            );
            assert_eq!(rows[0].channel, "MESAJ");
            assert!(!rows[0].granted);
        }
        _ => panic!(),
    }
}
#[tokio::test]
async fn iys_errors_retry_hourly_then_failed_final_human_work() {
    let (w, c) = iys_setup().await;
    grant(&w, ConsentKind::Explicit, w.owner_ctx.now).await;
    for n in 1..=5 {
        c.push_consent_add(Err(jt_connector::ConnectorError::permanent(
            "provider refused",
        )));
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(n))
            .await;
        let row = &w.uow.snapshot().inbox.consents[0].1;
        assert_eq!(row.attempts, n as u32);
        assert_eq!(
            row.sync_state,
            if n == 5 {
                SyncState::FailedFinal
            } else {
                SyncState::Failed
            }
        );
    }
    jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(6)).await;
    let s = w.uow.snapshot();
    assert_eq!(c.calls().len(), 5);
    assert_eq!(s.inbox.tasks.len(), 1);
    assert!(s.inbox.tasks[0].assignee.is_some());
}

#[test]
fn consent_catalog_surface_contract() {
    for id in [
        "inbox.consent.record",
        "inbox.consent.list",
        "inbox.suppressions.add",
        "inbox.suppressions.remove",
        "inbox.send",
    ] {
        assert!(jt_app::catalog::CATALOG.iter().any(|c| c.id == id), "{id}");
    }
    assert_eq!(
        jt_app::usecases::inbox::schema::input("send")["properties"]["intent"]["enum"],
        json!(["commercial"])
    );
}

#[tokio::test]
async fn new_commercial_conversation_has_no_reply_window() {
    let (w, _, c) = setup().await;
    let person=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"New","identities":[{"channel":"phone","value":"05321234568"}],"source":"form"})).unwrap()).await.unwrap().person;
    jt_app::usecases::inbox::consent::record_consent(&w.deps,&w.owner_ctx,person.id,serde_json::from_value(json!({"channel":"sms","kind":"explicit","source":"agent","at":w.owner_ctx.now.format(&time::format_description::well_known::Rfc3339).unwrap()})).unwrap()).await.unwrap();
    c.push_sms(accepted());
    let result = replies::send(
        &w.deps,
        &w.owner_ctx,
        person.id,
        serde_json::from_value(json!({"channel":"sms","text":"Offer","intent":"commercial"}))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(result.state, "sent");
    let conv = w
        .uow
        .snapshot()
        .inbox
        .conversations
        .into_iter()
        .find(|c| c.person_id == person.id)
        .unwrap();
    assert_eq!(conv.last_inbound_at, None);
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, conv.id, input(None))
            .await
            .unwrap_err()
            .message,
        "reply_window_closed"
    );
}
#[tokio::test]
async fn suppression_permissions_and_channel_isolation() {
    use jt_app::usecases::inbox::consent;
    let (w, id, c) = setup().await;
    let person = w.uow.snapshot().inbox.people[0].id;
    let agent = w.agent(&["inbox.work"]).await;
    let manual = || serde_json::from_value(json!({"channel":"sms","reason":"manual"})).unwrap();
    assert_eq!(
        consent::add_suppression(&w.deps, &agent, person, manual())
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::Forbidden
    );
    consent::add_suppression(&w.deps, &w.owner_ctx, person, manual())
        .await
        .unwrap();
    grant(&w, ConsentKind::Explicit, w.owner_ctx.now).await;
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap_err()
            .message,
        "IZIN_YOK"
    );
    consent::remove_suppression(&w.deps, &w.owner_ctx, person, manual())
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.suppressions()
        .insert(Suppression {
            person_id: person,
            channel: Channel::Phone,
            reason: SuppressionReason::Complaint,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    c.push_sms(accepted());
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap()
            .state,
        "sent"
    );
}
#[tokio::test]
async fn adapter_bounce_and_complaint_refuse_queued_email() {
    use jt_app::usecases::{inbox::consumer, jobs};
    for complaint in [false, true] {
        let (w, id, c) = setup_channel("mailbox").await;
        let person = w.uow.snapshot().inbox.people[0].id;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.consents()
            .insert(Consent {
                id: ConsentId::new_v7(),
                person_id: person,
                channel: Channel::Email,
                kind: ConsentKind::Explicit,
                source: ConsentSource::Customer,
                at: w.owner_ctx.now,
                sync_state: SyncState::Pending,
                attempts: 0,
            })
            .await
            .unwrap();
        r.commit().await.unwrap();
        c.push_mail(accepted());
        replies::reply(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap();
        let old = w.uow.snapshot().inbox.outbox[0].clone();
        let replies::Enqueued::New(q) = replies::enqueue(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap()
        else {
            panic!()
        };
        let fixture: &[u8] = if complaint {
            include_bytes!("../../adapters/jt_mail/tests/fixtures/complaint.eml")
        } else {
            include_bytes!("../../adapters/jt_mail/tests/fixtures/bounce.eml")
        };
        let raw = String::from_utf8(fixture.to_vec()).unwrap().replace(
            "<original@example.com>",
            old.intent["mail"]["message_id"].as_str().unwrap(),
        );
        let draft =
            jt_mail::parse_message("account", "INBOX", 42, 2, raw.as_bytes(), false).unwrap();
        assert_eq!(draft.kind, jt_connector::EventKind::Status);
        assert_eq!(
            draft.payload["status"],
            if complaint { "complaint" } else { "failed" }
        );
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let event = jt_connector::InboundEvent {
            id: jt_connector::InboundEventId::new_v7(),
            workspace_id: w.ws,
            capability_id: Some(old.capability_id),
            provider: Provider::Mail,
            external_id: draft.external_id,
            kind: draft.kind,
            payload: draft.payload,
            received_at: w.owner_ctx.now,
            processed_at: None,
        };
        r.inbound_events().insert_if_new(event, None).await.unwrap();
        r.commit().await.unwrap();
        assert_eq!(consumer::CONSUMER, "inbox@2");
        assert_eq!(
            jobs::run_inbox_consume(&w.deps, w.owner_ctx.now)
                .await
                .changed,
            1
        );
        assert_eq!(
            jobs::run_inbox_consume(&w.deps, w.owner_ctx.now)
                .await
                .changed,
            0
        );
        assert_eq!(
            replies::send_step(&w.deps, &w.owner_ctx, q)
                .await
                .unwrap()
                .state,
            "refused"
        );
        assert_eq!(c.calls().len(), 1);
    }
}

#[tokio::test]
async fn iys_batches_backlog_and_does_not_spend_retries_on_throttle() {
    let (w, c) = iys_setup().await;
    for _ in 0..60 {
        grant(&w, ConsentKind::Explicit, w.owner_ctx.now).await;
    }
    c.push_consent_add(Err(jt_connector::ConnectorError::throttle(None)));
    jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now).await;
    assert!(
        w.uow
            .snapshot()
            .inbox
            .consents
            .iter()
            .all(|(_, r)| r.attempts == 0)
    );
    assert_eq!(c.calls().len(), 1);
    c.push_consent_add(accepted());
    assert_eq!(
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(1))
            .await
            .changed,
        60
    );
    assert_eq!(c.calls().len(), 2);
    assert!(
        w.uow
            .snapshot()
            .inbox
            .consents
            .iter()
            .all(|(_, r)| r.sync_state == SyncState::Sent)
    );
}
#[tokio::test]
async fn iys_inapplicable_channels_do_not_starve_later_withdrawals() {
    let (w, c) = iys_setup().await;
    let person = w.uow.snapshot().inbox.people[0].id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    for _ in 0..1000 {
        r.consents()
            .insert(Consent {
                id: ConsentId::new_v7(),
                person_id: person,
                channel: Channel::WhatsApp,
                kind: ConsentKind::Explicit,
                source: ConsentSource::Agent,
                at: w.owner_ctx.now - time::Duration::hours(1),
                sync_state: SyncState::Pending,
                attempts: 0,
            })
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    c.push_consent_add(accepted());
    assert_eq!(
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now)
            .await
            .changed,
        1
    );
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn merged_withdrawal_is_honored_by_both_commercial_fences() {
    use jt_app::usecases::inbox::{journeys, merge};
    let (w, id, c) = setup().await;
    let keeper = w.uow.snapshot().inbox.people[0].id;
    grant(
        &w,
        ConsentKind::Explicit,
        w.owner_ctx.now - time::Duration::hours(2),
    )
    .await;
    let donor=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Alias","identities":[{"channel":"email","value":"alias@example.com"}],"source":"form"})).unwrap()).await.unwrap();
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        w.uow
            .snapshot()
            .inbox
            .journeys
            .iter()
            .find(|j| j.person_id == donor.person.id)
            .unwrap()
            .id,
        serde_json::from_value(
            json!({"kind":"lost","idempotency_key":"close-alias","payload":{"reason_key":"fiyat"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: donor.person.id,
            channel: Channel::Sms,
            kind: ConsentKind::Withdrawn,
            source: ConsentSource::Customer,
            at: w.owner_ctx.now - time::Duration::hours(1),
            sync_state: SyncState::Pending,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let replies::Enqueued::New(q) = replies::enqueue(&w.deps, &w.owner_ctx, id, commercial())
        .await
        .unwrap()
    else {
        panic!()
    };
    people::add_identity(
        &w.deps,
        &w.owner_ctx,
        keeper,
        serde_json::from_value(json!({"channel":"email","value":"alias@example.com"})).unwrap(),
    )
    .await
    .unwrap();
    let m = merge::list(&w.deps, &w.owner_ctx).await.unwrap().remove(0);
    merge::apply(
        &w.deps,
        &w.owner_ctx,
        m.id,
        merge::ApplyInput { keep: keeper },
    )
    .await
    .unwrap();
    assert_eq!(
        replies::send_step(&w.deps, &w.owner_ctx, q)
            .await
            .unwrap()
            .state,
        "refused"
    );
    assert_eq!(
        replies::reply(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap_err()
            .message,
        "IZIN_YOK"
    );
    assert!(c.calls().is_empty());
    // A pre-merge withdrawal must also reach IYS via the survivor's current identity.
    provision_iys(&w).await;
    c.push_consent_add(accepted());
    assert_eq!(
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now)
            .await
            .changed,
        2
    );
    match &c.calls()[0] {
        jt_testkit::fakes::ConnectorCall::ConsentAdd { rows, .. } => {
            assert!(rows.iter().any(|r| !r.granted))
        }
        _ => panic!(),
    }
}

#[tokio::test]
async fn iys_missing_recipient_reaches_human_work_without_blocking_valid_rows() {
    let (w, c) = iys_setup().await;
    let person = w.uow.snapshot().inbox.people[0].id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: person,
            channel: Channel::Email,
            kind: ConsentKind::Withdrawn,
            source: ConsentSource::Agent,
            at: w.owner_ctx.now,
            sync_state: SyncState::Pending,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    grant(&w, ConsentKind::Explicit, w.owner_ctx.now).await;
    c.push_consent_add(accepted());
    for n in 0..5 {
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(n))
            .await;
    }
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.tasks.len(), 1);
    assert_eq!(c.calls().len(), 1);
    assert!(
        s.inbox
            .consents
            .iter()
            .any(|(_, c)| c.channel == Channel::Email && c.sync_state == SyncState::FailedFinal)
    );
    assert!(
        s.inbox
            .consents
            .iter()
            .any(|(_, c)| c.channel == Channel::Sms && c.sync_state == SyncState::Sent)
    );
}

#[tokio::test]
async fn undated_invalid_and_future_iys_grants_cannot_restore_withdrawal() {
    for date in [None, Some("bad-date"), Some("2099-01-01 10:00:00")] {
        let (w, id, c) = setup().await;
        grant(
            &w,
            ConsentKind::Withdrawn,
            w.owner_ctx.now - time::Duration::hours(1),
        )
        .await;
        let mut raw = json!({"transactionid":"delayed","recipient":"+905321234567","type":"MESAJ","status":"ONAY"});
        if let Some(date) = date {
            raw["consentDate"] = json!(date);
        }
        let mut draft = jt_netgsm::webhook::parse(
            jt_connector::NetgsmPurpose::Iys,
            &serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap()
        .remove(0);
        if let Some(at) = draft.occurred_at {
            draft.payload["occurred_at"] = json!(
                at.format(&time::format_description::well_known::Rfc3339)
                    .unwrap()
            );
        }
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.inbound_events()
            .insert_if_new(
                jt_connector::InboundEvent {
                    id: jt_connector::InboundEventId::new_v7(),
                    workspace_id: w.ws,
                    capability_id: Some(w.uow.snapshot().inbox.conversations[0].capability_id),
                    provider: Provider::Netgsm,
                    external_id: draft.external_id,
                    kind: draft.kind,
                    payload: draft.payload,
                    received_at: w.owner_ctx.now,
                    processed_at: None,
                },
                None,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
        jt_app::usecases::jobs::run_inbox_consume(&w.deps, w.owner_ctx.now).await;
        c.push_sms(accepted());
        assert_eq!(
            replies::reply(&w.deps, &w.owner_ctx, id, commercial())
                .await
                .unwrap_err()
                .message,
            "IZIN_YOK"
        );
        assert!(c.calls().is_empty());
        assert_eq!(w.uow.snapshot().inbox.consents.len(), 1);
    }
}
#[tokio::test]
async fn inherited_suppression_removal_blocks_merge_undo() {
    use jt_app::usecases::inbox::{consent, journeys, merge};
    let (w, _, _) = setup().await;
    let keeper = w.uow.snapshot().inbox.people[0].id;
    let donor=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Alias","identities":[{"channel":"email","value":"guard@example.com"}],"source":"form"})).unwrap()).await.unwrap().person;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        w.uow
            .snapshot()
            .inbox
            .journeys
            .iter()
            .find(|j| j.person_id == donor.id)
            .unwrap()
            .id,
        serde_json::from_value(
            json!({"kind":"lost","idempotency_key":"close-guard","payload":{"reason_key":"fiyat"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    consent::add_suppression(
        &w.deps,
        &w.owner_ctx,
        donor.id,
        consent::SuppressionInput {
            channel: Channel::Email,
            reason: SuppressionReason::Manual,
        },
    )
    .await
    .unwrap();
    people::add_identity(
        &w.deps,
        &w.owner_ctx,
        keeper,
        serde_json::from_value(json!({"channel":"email","value":"guard@example.com"})).unwrap(),
    )
    .await
    .unwrap();
    let m = merge::list(&w.deps, &w.owner_ctx).await.unwrap().remove(0);
    merge::apply(
        &w.deps,
        &w.owner_ctx,
        m.id,
        merge::ApplyInput { keep: keeper },
    )
    .await
    .unwrap();
    consent::remove_suppression(
        &w.deps,
        &w.owner_ctx,
        keeper,
        consent::SuppressionInput {
            channel: Channel::Email,
            reason: SuppressionReason::Manual,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        merge::undo(
            &w.deps,
            &w.owner_ctx,
            m.id,
            merge::UndoInput { confirm: true }
        )
        .await
        .unwrap_err()
        .details["reason"],
        "edited_after_merge"
    );
}

#[tokio::test]
async fn missing_iys_slot_keeps_pending_and_asks_owner_once() {
    let (w, _, c) = setup().await;
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    for n in 0..2 {
        jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now + time::Duration::hours(n))
            .await;
    }
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.consents[0].1.sync_state, SyncState::Pending);
    assert_eq!(s.inbox.consents[0].1.attempts, 0);
    assert!(c.calls().is_empty());
    assert_eq!(s.inbox.tasks.len(), 1);
    assert!(s.inbox.tasks[0].title.contains("Provision IYS"));
    assert_eq!(s.inbox.tasks[0].assignee, Some(w.owner));
}

async fn provision_iys(w: &World) {
    let cap = w
        .uow
        .snapshot()
        .capabilities
        .iter()
        .find(|c| c.capability.kind_key == "sms_line")
        .unwrap()
        .capability
        .id;
    jt_app::usecases::connector::set_credentials(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"capability_id":cap,"credential":{"kind":"netgsm_iys","usercode":"user","password":"iys-secret","brand_code":"brand-42"}})).unwrap()).await.unwrap();
}

#[tokio::test]
async fn missing_iys_slot_requests_owner_even_without_adapter() {
    let (mut w, _, _) = setup().await;
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    w.deps.connectors = Arc::new(ScriptedRegistry::new());
    jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now).await;
    assert_eq!(w.uow.snapshot().inbox.tasks.len(), 1);
}

#[tokio::test]
async fn iys_slot_on_live_unreachable_sms_line_still_syncs() {
    let (w, _, c) = setup().await;
    let cap = w.uow.snapshot().capabilities[0].capability.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities()
        .set_status(cap, StoredStatus::Unreachable, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
    provision_iys(&w).await;
    grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
    c.push_consent_add(accepted());
    let report = jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now).await;
    assert_eq!(report.changed, 1);
    assert_eq!(
        w.uow.snapshot().capabilities[0].capability.status,
        StoredStatus::Unreachable
    );
}

#[tokio::test]
async fn retiring_sms_line_clears_both_credential_slots() {
    let (w, _) = iys_setup().await;
    let id = w.uow.snapshot().capabilities[0].capability.id;
    jt_app::usecases::capabilities::retire(&w.deps, &w.owner_ctx, id, true)
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(r.capabilities().read_sealed(id).await.unwrap(), None);
    assert_eq!(r.capabilities().read_iys_sealed(id).await.unwrap(), None);
}

#[tokio::test]
async fn rebinding_sms_line_clears_iys_slot_and_brand() {
    let (w, _) = iys_setup().await;
    let id = w.uow.snapshot().capabilities[0].capability.id;
    let out = jt_app::usecases::capabilities::update(
        &w.deps,
        &w.owner_ctx,
        id,
        serde_json::from_value(json!({"external_id":"different-line"})).unwrap(),
    )
    .await
    .unwrap();
    assert!(out.current.capability.connector_public.get("iys").is_none());
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(r.capabilities().read_sealed(id).await.unwrap(), None);
    assert_eq!(r.capabilities().read_iys_sealed(id).await.unwrap(), None);
}

#[tokio::test]
async fn commercial_meta_outside_window_is_refused() {
    for kind in [
        "whatsapp_cloud",
        "messenger",
        "instagram_dm",
        "sms_line",
        "mailbox",
    ] {
        let (w, id, connector) = setup_channel(kind).await;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let person = w.uow.snapshot().inbox.people[0].id;
        r.consents()
            .insert(Consent {
                id: ConsentId::new_v7(),
                person_id: person,
                channel: channel_for_kind(kind).unwrap(),
                kind: ConsentKind::Explicit,
                source: ConsentSource::Customer,
                at: w.owner_ctx.now,
                sync_state: SyncState::Pending,
                attempts: 0,
            })
            .await
            .unwrap();
        if matches!(kind, "messenger" | "instagram_dm") {
            let mut cap = w.uow.snapshot().capabilities[0].capability.clone();
            cap.external_id = Some("page".into());
            r.capabilities().update(cap).await.unwrap();
            r.identities()
                .insert(Identity {
                    id: IdentityId::new_v7(),
                    workspace_id: w.ws,
                    person_id: person,
                    channel: if kind == "messenger" {
                        IdentityChannel::Messenger
                    } else {
                        IdentityChannel::InstagramDm
                    },
                    value_normalized: "page:recipient".into(),
                    value_display: "recipient".into(),
                    active: true,
                    first_seen_at: w.owner_ctx.now,
                })
                .await
                .unwrap();
        }
        r.commit().await.unwrap();
        let mut late = w.owner_ctx.clone();
        late.now += time::Duration::hours(25);
        if matches!(kind, "sms_line" | "mailbox") {
            if kind == "sms_line" {
                connector.push_sms(accepted());
            } else {
                connector.push_mail(accepted());
            }
            assert_eq!(
                replies::reply(&w.deps, &late, id, commercial())
                    .await
                    .unwrap()
                    .state,
                "sent"
            );
            continue;
        }
        // An expired provider window must fail before enqueue.
        let error = replies::enqueue(&w.deps, &late, id, commercial())
            .await
            .unwrap_err();
        assert_eq!(error.code, jt_app::error::ErrorCode::Validation);
        assert_eq!(error.details["reason"], "provider_window_closed");
        assert!(w.uow.snapshot().inbox.outbox.is_empty());
        // A valid queued send must be refused if its provider window expires before claim.
        let replies::Enqueued::New(q) = replies::enqueue(&w.deps, &w.owner_ctx, id, commercial())
            .await
            .unwrap()
        else {
            panic!()
        };
        let error = replies::send_step(&w.deps, &late, q).await.unwrap_err();
        assert_eq!(error.code, jt_app::error::ErrorCode::Validation);
        assert_eq!(error.details["reason"], "provider_window_closed");
        assert_eq!(w.uow.snapshot().inbox.outbox[0].state, "refused");
        assert_eq!(
            w.uow.snapshot().inbox.outbox[0].last_error.as_deref(),
            Some("provider_window_closed")
        );
        assert!(connector.calls().is_empty());
    }
}

#[tokio::test]
async fn iys_sync_uses_one_consistent_snapshot() {
    for public_brand in ["new-brand", "display-only"] {
        let (w, connector) = iys_setup().await;
        grant(&w, ConsentKind::Withdrawn, w.owner_ctx.now).await;
        let mut replacement = w.uow.snapshot().capabilities[0].clone();
        let credential = Credential::NetgsmIys {
            usercode: "user".into(),
            password: "new-iys-password".into(),
            brand_code: "new-brand".into(),
        };
        replacement.iys_sealed = Some(
            w.deps
                .seal
                .seal(w.ws, &serde_json::to_vec(&credential).unwrap())
                .unwrap(),
        );
        replacement.capability.connector_public["iys"]["brand_code"] = json!(public_brand);
        w.uow.replace_capability_after_list(replacement);
        connector.push_consent_add(accepted());
        let result = jt_app::usecases::jobs::run_iys_sync(&w.deps, w.owner_ctx.now).await;
        assert_eq!(result.failed, 0);
        assert_eq!(result.changed, 1);
        let calls = connector.calls();
        let jt_testkit::fakes::ConnectorCall::ConsentAdd {
            credential: sent, ..
        } = calls.last().unwrap()
        else {
            panic!("expected consent submission")
        };
        assert_eq!(sent, &credential);
        assert_eq!(
            w.uow.snapshot().inbox.consents[0].1.sync_state,
            SyncState::Sent
        );
    }
}

#[tokio::test]
async fn mail_hosts_refresh_across_instances() {
    use jt_app::{
        ports::TenantHostRegistry,
        usecases::{connector as connection, jobs},
    };
    use jt_outbound::{Egress, EgressScope, EgressTenantHosts, Url};
    let (mut w, conversation, mail) = setup_channel("mailbox").await;
    let a = Arc::new(Egress::new(&[]));
    w.deps.hosts = Arc::new(EgressTenantHosts::new(a.clone()));
    let id = w.uow.snapshot().capabilities[0].capability.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities()
        .set_status(id, StoredStatus::Unreachable, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();

    mail.push_probe(jt_connector::ProbeResult::success(
        1,
        json!({"account_id":"support@example.com"}),
    ));
    connection::set_credentials(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "capability_id": id,
            "credential":{"kind":"mailbox", "smtp_host":"smtp.example.com", "smtp_port":465,
            "imap_host":"imap.example.com", "imap_port":993, "username":"support@example.com",
            "password":"secret", "from_address":"support@example.com", "tls":"implicit"}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let smtp = Url::parse("https://smtp.example.com:465").unwrap();
    let imap = Url::parse("https://imap.example.com:993").unwrap();
    assert!(a.permits(EgressScope::Tenant(w.ws), &smtp));
    assert!(a.permits(EgressScope::Tenant(w.ws), &imap));
    for call in ["send", "poll", "probe", "scheduled"] {
        let b = Arc::new(Egress::new(&[]));
        let hosts_b = Arc::new(EgressTenantHosts::new(b.clone()));
        let mut instance_b = w.deps.clone();
        instance_b.hosts = hosts_b.clone();
        assert!(!b.permits(EgressScope::Tenant(w.ws), &smtp));
        assert!(!b.permits(EgressScope::Tenant(w.ws), &imap));
        match call {
            "send" => {
                mail.push_mail(accepted());
                assert_eq!(
                    replies::reply(&instance_b, &w.owner_ctx, conversation, input(None))
                        .await
                        .unwrap()
                        .state,
                    "sent"
                );
            }
            "poll" => {
                mail.push_mailbox_poll(Ok((vec![], Default::default())));
                let report = jobs::run_mail_inbox_poll(&instance_b, w.owner_ctx.now).await;
                assert_eq!(report.touched, 1);
                assert_eq!(report.failed, 0);
            }
            "probe" => {
                mail.push_probe(jt_connector::ProbeResult::success(
                    1,
                    json!({"account_id":"support@example.com"}),
                ));
                connection::probe(&instance_b, &w.owner_ctx, id)
                    .await
                    .unwrap();
            }
            _ => {
                // An obsolete local grant is removed by a full workspace replacement.
                hosts_b.allow(w.ws, "obsolete.example.com").unwrap();
                let job = jobs::Job::ALL
                    .iter()
                    .find(|j| j.name() == "refresh_tenant_hosts")
                    .expect("refresh job");
                assert_eq!(job.run(&instance_b, w.owner_ctx.now).await.failed, 0);
                assert!(!b.permits(
                    EgressScope::Tenant(w.ws),
                    &Url::parse("https://obsolete.example.com").unwrap()
                ));
            }
        }
        assert!(b.permits(EgressScope::Tenant(w.ws), &smtp), "{call}: SMTP");
        assert!(b.permits(EgressScope::Tenant(w.ws), &imap), "{call}: IMAP");
        assert!(!b.permits(
            EgressScope::Tenant(jt_tenancy::WorkspaceId::new_v7()),
            &smtp
        ));
    }
}
