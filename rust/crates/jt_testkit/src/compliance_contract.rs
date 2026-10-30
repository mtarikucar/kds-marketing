//! Shared compliance persistence contracts run against PostgreSQL and memory.
use crate::{fakes::FIXED_NOW, inbox_contract::Fixture};
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, inbox::*},
};
use jt_inbox::*;
use std::sync::Arc;
use time::Duration;
use uuid::Uuid;

pub async fn compliance_history_rates_and_financial_rows(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Compliance").await;
    let j = f.journey(p.id);
    let mut t = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(&mut *t, &j).await.unwrap();
    let consent = Consent {
        id: ConsentId::new_v7(),
        person_id: p.id,
        channel: Channel::Sms,
        kind: ConsentKind::Explicit,
        source: ConsentSource::Agent,
        at: FIXED_NOW,
        sync_state: SyncState::Pending,
        attempts: 0,
    };
    t.consents().insert(consent.clone()).await.unwrap();
    let mut withdrawal = consent.clone();
    withdrawal.id = ConsentId::new_v7();
    withdrawal.kind = ConsentKind::Withdrawn;
    t.consents().insert(withdrawal.clone()).await.unwrap();
    assert_eq!(t.consents().list(p.id).await.unwrap().len(), 2);
    assert_eq!(t.consents().pending_sync(10).await.unwrap().len(), 2);
    t.consents()
        .set_sync(consent.id, SyncState::Sent, 1)
        .await
        .unwrap();
    assert_eq!(
        t.consents().pending_sync(10).await.unwrap(),
        vec![withdrawal]
    );
    let suppression = Suppression {
        person_id: p.id,
        channel: Channel::Sms,
        reason: SuppressionReason::Bounce,
    };
    t.suppressions().insert(suppression.clone()).await.unwrap();
    t.suppressions().insert(suppression.clone()).await.unwrap();
    assert_eq!(
        t.suppressions().list(p.id).await.unwrap(),
        vec![suppression]
    );
    t.suppressions()
        .remove(p.id, Channel::Sms, SuppressionReason::Bounce)
        .await
        .unwrap();
    assert!(t.suppressions().list(p.id).await.unwrap().is_empty());
    let q = QuoteRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        created_at: FIXED_NOW,
        quote: Quote {
            journey_id: j.id,
            amount_minor: 12000,
            currency: "TRY".into(),
            valid_until: FIXED_NOW + Duration::days(1),
            file_ref: Some("opaque".into()),
            channel: Channel::Sms,
            state: QuoteState::Sent,
        },
    };
    t.quotes().insert(q.clone()).await.unwrap();
    assert_eq!(t.quotes().list(j.id).await.unwrap(), vec![q.clone()]);
    t.quotes()
        .set_state(q.id, QuoteState::Accepted)
        .await
        .unwrap();
    assert_eq!(
        t.quotes().get(q.id).await.unwrap().unwrap().quote.state,
        QuoteState::Accepted
    );
    let a = AppointmentRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        created_at: FIXED_NOW,
        appointment: Appointment {
            journey_id: j.id,
            starts_at: FIXED_NOW,
            ends_at: FIXED_NOW + Duration::hours(1),
            location: "office".into(),
            state: AppointmentState::Booked,
        },
    };
    t.appointments().insert(a.clone()).await.unwrap();
    assert_eq!(t.appointments().list(j.id).await.unwrap(), vec![a.clone()]);
    t.appointments()
        .set_state(a.id, AppointmentState::Held)
        .await
        .unwrap();
    assert_eq!(
        t.appointments()
            .get(a.id)
            .await
            .unwrap()
            .unwrap()
            .appointment
            .state,
        AppointmentState::Held
    );
    assert_eq!(t.commissions().default_rate().await.unwrap(), None);
    t.commissions().set_default_rate(500).await.unwrap();
    t.commissions()
        .set_user_rate(f.user, Some(750))
        .await
        .unwrap();
    assert_eq!(t.commissions().default_rate().await.unwrap(), Some(500));
    assert_eq!(t.commissions().user_rate(f.user).await.unwrap(), Some(750));
    t.commissions().set_user_rate(f.user, None).await.unwrap();
    assert_eq!(t.commissions().user_rate(f.user).await.unwrap(), None);
    let c = CommissionRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        created_at: FIXED_NOW,
        commission: Commission {
            journey_id: j.id,
            payee: Some(f.user),
            amount_minor: 600,
            currency: "TRY".into(),
            rate_bp: 500,
            state: CommissionState::Pending,
        },
    };
    t.commissions().insert(c.clone()).await.unwrap();
    assert_eq!(
        t.commissions().by_journey(j.id).await.unwrap(),
        Some(c.clone())
    );
    t.commissions()
        .set_state(c.id, CommissionState::Approved)
        .await
        .unwrap();
    assert_eq!(
        t.commissions()
            .get(c.id)
            .await
            .unwrap()
            .unwrap()
            .commission
            .state,
        CommissionState::Approved
    );
    assert_eq!(t.commissions().list().await.unwrap().len(), 1);
    t.commit().await.unwrap();
    let mut other = uow.tenant(f.other).await.unwrap();
    assert!(other.consents().list(p.id).await.unwrap().is_empty());
    assert!(other.quotes().get(q.id).await.unwrap().is_none());
    assert!(other.appointments().get(a.id).await.unwrap().is_none());
    assert!(other.commissions().get(c.id).await.unwrap().is_none());
    assert_eq!(other.commissions().default_rate().await.unwrap(), None);
    assert_eq!(
        other.consents().insert(consent).await.unwrap_err().code,
        ErrorCode::NotFound
    );
}

pub async fn commission_unique_per_journey(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Won").await;
    let j = f.journey(p.id);
    let c = CommissionRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        created_at: FIXED_NOW,
        commission: Commission {
            journey_id: j.id,
            payee: None,
            amount_minor: 100,
            currency: "TRY".into(),
            rate_bp: 100,
            state: CommissionState::NoPayee,
        },
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(&mut *t, &j).await.unwrap();
    t.commissions().insert(c.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut duplicate = c.clone();
    duplicate.id = Uuid::now_v7();
    duplicate.commission.amount_minor = 999;
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.commissions().insert(duplicate).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.commissions().by_journey(j.id).await.unwrap(), Some(c));
}

pub async fn erasure_replay_and_tenant_isolation(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Erase").await;
    let log = ErasureLog {
        workspace_id: f.ws,
        person_id: p.id,
        requested_via: "panel".into(),
        at: FIXED_NOW,
    };
    let hash = identity_hash(IdentityChannel::Email, "someone@example.test");
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.erasure().record(log.clone()).await.unwrap();
    t.erasure()
        .remember_identity(IdentityChannel::Email, &hash)
        .await
        .unwrap();
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.erasure().get(p.id).await.unwrap(), None);
    assert!(
        !t.erasure()
            .is_erased_identity(IdentityChannel::Email, &hash)
            .await
            .unwrap()
    );
    t.erasure().record(log.clone()).await.unwrap();
    let mut later = log.clone();
    later.at += Duration::days(1);
    later.requested_via = "replay".into();
    t.erasure().record(later).await.unwrap();
    for _ in 0..2 {
        t.erasure()
            .remember_identity(IdentityChannel::Email, &hash)
            .await
            .unwrap();
    }
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.erasure().get(p.id).await.unwrap(), Some(log));
    assert!(
        t.erasure()
            .is_erased_identity(IdentityChannel::Email, &hash)
            .await
            .unwrap()
    );
    assert!(
        !t.erasure()
            .is_erased_identity(IdentityChannel::Phone, &hash)
            .await
            .unwrap()
    );
    let mut t = uow.tenant(f.other).await.unwrap();
    assert_eq!(t.erasure().get(p.id).await.unwrap(), None);
    assert!(
        !t.erasure()
            .is_erased_identity(IdentityChannel::Email, &hash)
            .await
            .unwrap()
    );
}

pub async fn mail_cursor_and_drafts_atomic(uow: Arc<dyn UnitOfWork>) {
    use jt_app::ports::connectors::{MailboxCursor, MailboxPosition};
    use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
    let f = Fixture::new(uow.clone()).await;
    let cap = f.capability().await;
    let cursor = MailboxCursor {
        mailboxes: [
            (
                "INBOX".into(),
                MailboxPosition {
                    uidvalidity: u32::MAX,
                    last_uid: 123,
                },
            ),
            (
                "Sent".into(),
                MailboxPosition {
                    uidvalidity: 2,
                    last_uid: 456,
                },
            ),
        ]
        .into(),
        read_history: false,
    };
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: f.ws,
        capability_id: Some(cap),
        // Cursor/event transactionality is provider-independent. The SQL schema suite
        // separately verifies mail acceptance without depending on the mail adapter branch.
        provider: Provider::Meta,
        external_id: "imap:account:INBOX:123:1".into(),
        kind: EventKind::Message,
        payload: serde_json::json!({"text":"mail"}),
        received_at: FIXED_NOW,
        processed_at: None,
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.mail_cursors().store(cap, cursor.clone()).await.unwrap();
    t.inbound_events()
        .insert_if_new(event.clone(), None)
        .await
        .unwrap();
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.mail_cursors().get(cap).await.unwrap(),
        MailboxCursor::default()
    );
    assert!(
        t.inbound_events()
            .list_pending(10)
            .await
            .unwrap()
            .is_empty()
    );
    t.mail_cursors().store(cap, cursor.clone()).await.unwrap();
    t.inbound_events()
        .insert_if_new(event.clone(), None)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.mail_cursors().get(cap).await.unwrap(), cursor);
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![event]
    );
    let reset = MailboxCursor {
        mailboxes: [(
            "INBOX".into(),
            MailboxPosition {
                uidvalidity: 5,
                last_uid: 1,
            },
        )]
        .into(),
        read_history: false,
    };
    t.mail_cursors().store(cap, reset).await.unwrap();
    let read = t.mail_cursors().get(cap).await.unwrap();
    assert_eq!(read.mailboxes["INBOX"].last_uid, 1);
    assert_eq!(read.mailboxes["Sent"].last_uid, 456);
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.other).await.unwrap();
    assert_eq!(
        t.mail_cursors().get(cap).await.unwrap(),
        MailboxCursor::default()
    );
    assert_eq!(
        t.mail_cursors().store(cap, cursor).await.unwrap_err().code,
        ErrorCode::NotFound
    );
}

pub async fn dlr_capability_isolation(uow: Arc<dyn UnitOfWork>) {
    use jt_app::ports::connectors::{DeliveryState, DeliveryStatus};
    let f = Fixture::new(uow.clone()).await;
    let a = f.capability().await;
    let b = f.capability().await;
    let make = |cap, id: &str, age, state| OutboundJobRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        capability_id: cap,
        provider_job_id: Some(id.into()),
        message_id: None,
        state,
        last_status: None,
        created_at: FIXED_NOW - Duration::hours(age),
        updated_at: FIXED_NOW,
    };
    let first = make(a, "same", 1, OutboundJobState::Queued);
    let second = make(b, "same", 1, OutboundJobState::Sent);
    let unknown = make(a, "unknown", 1, OutboundJobState::Unknown);
    let mut t = uow.tenant(f.ws).await.unwrap();
    for row in [
        first.clone(),
        second.clone(),
        unknown,
        make(a, "too-old", 72, OutboundJobState::Queued),
        make(a, "recent", 71, OutboundJobState::Sent),
        make(a, "done", 1, OutboundJobState::Delivered),
        make(a, "future", -1, OutboundJobState::Queued),
    ] {
        t.outbound_jobs().insert(row).await.unwrap();
    }
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.people().set_write_time(FIXED_NOW).await.unwrap();
    assert_eq!(
        t.outbound_jobs()
            .pending_job_ids(f.ws, a, 100)
            .await
            .unwrap(),
        vec!["recent", "same"]
    );
    assert_eq!(
        t.outbound_jobs().pending_job_ids(f.ws, a, 0).await.unwrap(),
        vec!["recent"]
    );
    assert_eq!(
        t.outbound_jobs()
            .pending_job_ids(f.ws, b, 100)
            .await
            .unwrap(),
        vec!["same"]
    );
    t.outbound_jobs()
        .record_status(
            f.ws,
            a,
            vec![DeliveryStatus {
                job_id: "same".into(),
                recipient: "905000000000".into(),
                status: DeliveryState::Delivered,
                at: Some(FIXED_NOW),
                raw_code: "1".into(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(
        t.outbound_jobs()
            .get(a, first.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        OutboundJobState::Delivered
    );
    assert_eq!(
        t.outbound_jobs().get(b, second.id).await.unwrap(),
        Some(second)
    );
    assert_eq!(
        t.outbound_jobs()
            .pending_job_ids(f.ws, a, 100)
            .await
            .unwrap(),
        vec!["recent"]
    );
    assert!(t.outbound_jobs().get(b, first.id).await.unwrap().is_none());
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.other).await.unwrap();
    assert!(
        t.outbound_jobs()
            .pending_job_ids(f.other, a, 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(t.outbound_jobs().get(a, first.id).await.unwrap().is_none());
    assert_eq!(
        t.outbound_jobs()
            .pending_job_ids(f.ws, a, 100)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal
    );
}

pub async fn attribution_by_ad_half_open_window_and_tenant_isolation(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = f.insert_person("Lead").await;
    let mut rows = Vec::new();
    let mut t = uow.tenant(f.ws).await.unwrap();
    for age in [0, 0, 1, 2] {
        let lead = f.person("Attributed lead");
        t.people().insert(lead.clone()).await.unwrap();
        let j = f.journey(lead.id);
        f.insert_journey(&mut *t, &j).await.unwrap();
        let row = JourneyAttribution {
            workspace_id: f.ws,
            journey_id: j.id,
            provider: "meta".into(),
            ad_id: Some("ad-1".into()),
            adset_id: None,
            campaign_id: None,
            form_id: Some("form".into()),
            leadgen_id: j.id.to_string(),
            acquired_at: FIXED_NOW + Duration::days(age),
        };
        assert!(t.attribution().insert_once(row.clone()).await.unwrap());
        rows.push(row);
    }
    t.commit().await.unwrap();
    rows.sort_by_key(|r| (r.acquired_at, r.journey_id));
    let deps = crate::fakes::deps(uow.clone());
    let reader = deps.attribution();
    let range = reader
        .by_ad(f.ws, "ad-1", FIXED_NOW, FIXED_NOW + Duration::days(1))
        .await
        .unwrap();
    assert_eq!(range, rows[..2]);
    assert_eq!(
        reader.by_journey(f.ws, rows[0].journey_id).await.unwrap(),
        Some(rows[0].clone())
    );
    assert!(
        reader
            .by_ad(f.other, "ad-1", FIXED_NOW, FIXED_NOW + Duration::days(5))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        reader
            .by_journey(f.other, rows[0].journey_id)
            .await
            .unwrap()
            .is_none()
    );
    let mut t = uow.tenant(f.ws).await.unwrap();
    let mut replay = rows[0].clone();
    replay.ad_id = Some("other".into());
    replay.acquired_at += Duration::days(9);
    assert!(!t.attribution().insert_once(replay).await.unwrap());
    t.commit().await.unwrap();
    assert_eq!(
        reader.by_journey(f.ws, rows[0].journey_id).await.unwrap(),
        Some(rows[0].clone())
    );
    let j = f.journey(p.id);
    let mut rolled = rows[0].clone();
    rolled.journey_id = j.id;
    let mut t = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(&mut *t, &j).await.unwrap();
    assert!(t.attribution().insert_once(rolled).await.unwrap());
    drop(t);
    assert!(reader.by_journey(f.ws, j.id).await.unwrap().is_none());
}

/// Both sealed slots are tenant scoped, transactional and independent of public projections.
pub async fn iys_slot_is_separate_and_tenant_scoped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let id = f.capability().await;
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    r.capabilities()
        .set_iys_sealed(id, Some(b"iys-secret-blob".to_vec()), FIXED_NOW)
        .await
        .unwrap();
    assert!(
        !r.capabilities()
            .find(id)
            .await
            .unwrap()
            .unwrap()
            .has_sealed_config
    );
    r.capabilities()
        .set_sealed(id, Some(b"sms-blob".to_vec()), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.capabilities().read_iys_sealed(id).await.unwrap(),
        Some(b"iys-secret-blob".to_vec())
    );
    assert_eq!(
        r.capabilities().read_sealed(id).await.unwrap(),
        Some(b"sms-blob".to_vec())
    );
    assert!(
        !serde_json::to_string(&r.capabilities().find(id).await.unwrap())
            .unwrap()
            .contains("iys-secret-blob")
    );
    r.capabilities()
        .set_iys_sealed(id, None, FIXED_NOW)
        .await
        .unwrap();
    drop(r); // rollback must preserve the slot
    let mut other = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(
        other
            .capabilities()
            .read_iys_sealed(id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(other);
    let mut other = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(
        other
            .capabilities()
            .set_iys_sealed(id, None, FIXED_NOW)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(other);
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.capabilities().read_iys_sealed(id).await.unwrap(),
        Some(b"iys-secret-blob".to_vec())
    );
    r.capabilities()
        .set_iys_sealed(id, None, FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(r.capabilities().read_iys_sealed(id).await.unwrap(), None);
    assert_eq!(
        r.capabilities().read_sealed(id).await.unwrap(),
        Some(b"sms-blob".to_vec())
    );
}

/// No replacement API exists: a second insert must preserve every original provenance field.
pub async fn journey_attribution_is_immutable(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let person = f.insert_person("Lead").await;
    let j = f.journey(person.id);
    let original = JourneyAttribution {
        workspace_id: f.ws,
        journey_id: j.id,
        provider: "meta".into(),
        ad_id: Some("ad-original".into()),
        adset_id: None,
        campaign_id: Some("campaign-original".into()),
        form_id: None,
        leadgen_id: "lead-original".into(),
        acquired_at: FIXED_NOW,
    };
    let mut r = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(r.as_mut(), &j).await.unwrap();
    assert!(r.attribution().insert_once(original.clone()).await.unwrap());
    r.commit().await.unwrap();
    let mut replacement = original.clone();
    replacement.provider = "other".into();
    replacement.ad_id = None;
    replacement.adset_id = Some("set-later".into());
    replacement.campaign_id = None;
    replacement.form_id = Some("form-later".into());
    replacement.leadgen_id = "lead-later".into();
    replacement.acquired_at += Duration::days(1);
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(!r.attribution().insert_once(replacement).await.unwrap());
    r.commit().await.unwrap();
    let reader = crate::fakes::deps(uow.clone()).attribution();
    assert_eq!(reader.by_journey(f.ws, j.id).await.unwrap(), Some(original));
}

/// The same committed read contract runs against PostgreSQL and the in-memory bundle.
pub async fn attribution_by_journey_pg_fake_parity(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let person = f.insert_person("Lead").await;
    let j = f.journey(person.id);
    let row = JourneyAttribution {
        workspace_id: f.ws,
        journey_id: j.id,
        provider: "meta".into(),
        ad_id: None,
        adset_id: None,
        campaign_id: None,
        form_id: None,
        leadgen_id: "lead".into(),
        acquired_at: FIXED_NOW,
    };
    let reader = crate::fakes::deps(uow.clone()).attribution();
    assert!(reader.by_journey(f.ws, j.id).await.unwrap().is_none());
    let mut r = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(r.as_mut(), &j).await.unwrap();
    r.attribution().insert_once(row.clone()).await.unwrap();
    drop(r);
    assert!(reader.by_journey(f.ws, j.id).await.unwrap().is_none());
    let mut r = uow.tenant(f.ws).await.unwrap();
    f.insert_journey(r.as_mut(), &j).await.unwrap();
    r.attribution().insert_once(row.clone()).await.unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        reader.by_journey(f.ws, j.id).await.unwrap(),
        Some(row.clone())
    );
    assert!(reader.by_journey(f.other, j.id).await.unwrap().is_none());
    let mut r = uow.tenant(f.other).await.unwrap();
    assert!(r.attribution().insert_once(row).await.is_err());
}

/// Only Meta forms deferred by inbox@2 can be reclaimed in that same generation.
pub async fn deferred_leadgen_claim_is_narrow_and_transactional(uow: Arc<dyn UnitOfWork>) {
    use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
    let f = Fixture::new(uow.clone()).await;
    let mut ids = Vec::new();
    let mut r = uow.tenant(f.ws).await.unwrap();
    for (provider, kind, outcome) in [
        (Provider::Meta, EventKind::LeadGen, "deferred"),
        (Provider::Meta, EventKind::Message, "deferred"),
        (Provider::Netgsm, EventKind::LeadGen, "deferred"),
        (Provider::Meta, EventKind::LeadGen, "consumed"),
    ] {
        let id = InboundEventId::new_v7();
        r.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: f.ws,
                    capability_id: None,
                    provider,
                    kind,
                    external_id: id.to_string(),
                    payload: serde_json::json!({}),
                    received_at: FIXED_NOW,
                    processed_at: None,
                },
                None,
            )
            .await
            .unwrap();
        assert!(r.consumption().try_claim("inbox@2", id).await.unwrap());
        r.consumption()
            .record(
                "inbox@2",
                id,
                ConsumptionOutcome {
                    consumed_at: FIXED_NOW,
                    outcome: outcome.into(),
                },
            )
            .await
            .unwrap();
        ids.push(id);
    }
    r.commit().await.unwrap();
    let mut other = uow.tenant(f.other).await.unwrap();
    assert!(
        other
            .inbound_events()
            .list_for_consumer("inbox@2", None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    drop(other);
    let mut r = uow.tenant(f.ws).await.unwrap();
    let eligible = r
        .inbound_events()
        .list_for_consumer("inbox@2", None, 10)
        .await
        .unwrap();
    assert_eq!(
        eligible.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![ids[0]]
    );
    assert!(r.consumption().try_claim("inbox@2", ids[0]).await.unwrap());
    drop(r); // an interrupted reclaim must retain the old deferral for another attempt
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(r.consumption().try_claim("inbox@2", ids[0]).await.unwrap());
    assert!(!r.consumption().try_claim("inbox@2", ids[0]).await.unwrap());
    for id in &ids[1..] {
        assert!(!r.consumption().try_claim("inbox@2", *id).await.unwrap());
    }
    r.consumption()
        .record(
            "inbox@2",
            ids[0],
            ConsumptionOutcome {
                consumed_at: FIXED_NOW,
                outcome: "consumed".into(),
            },
        )
        .await
        .unwrap();
    // The same exception must not silently apply to unrelated consumers.
    assert!(r.consumption().try_claim("other", ids[0]).await.unwrap());
    r.consumption()
        .record(
            "other",
            ids[0],
            ConsumptionOutcome {
                consumed_at: FIXED_NOW,
                outcome: "deferred".into(),
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(!r.consumption().try_claim("other", ids[0]).await.unwrap());
    assert!(
        r.inbound_events()
            .list_for_consumer("inbox@2", None, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

/// A deferred event of any provider is due again an hour per deferral later, and is abandoned,
/// once, when it was received more than seven days ago (C5).
pub async fn deferred_events_retry_with_backoff_then_abandon(uow: Arc<dyn UnitOfWork>) {
    use jt_app::ports::TenantRepos;
    use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
    use jt_tenancy::WorkspaceId;
    use time::OffsetDateTime;
    async fn defer(r: &mut dyn TenantRepos, id: InboundEventId, at: OffsetDateTime) {
        r.consumption()
            .record(
                "inbox@2",
                id,
                ConsumptionOutcome {
                    consumed_at: at,
                    outcome: "deferred".into(),
                },
            )
            .await
            .unwrap();
    }
    async fn release(
        uow: &Arc<dyn UnitOfWork>,
        ws: WorkspaceId,
        at: OffsetDateTime,
    ) -> Vec<InboundEventId> {
        let mut r = uow.tenant(ws).await.unwrap();
        let out = r
            .consumption()
            .release_due_deferrals("inbox@2", at)
            .await
            .unwrap();
        r.commit().await.unwrap();
        out
    }
    async fn listed(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId) -> Vec<InboundEventId> {
        let mut r = uow.tenant(ws).await.unwrap();
        r.inbound_events()
            .list_for_consumer("inbox@2", None, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect()
    }
    let f = Fixture::new(uow.clone()).await;
    let (fresh, old) = (InboundEventId::new_v7(), InboundEventId::new_v7());
    let mut r = uow.tenant(f.ws).await.unwrap();
    for (id, received_at) in [(fresh, FIXED_NOW), (old, FIXED_NOW - Duration::days(8))] {
        r.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: f.ws,
                    capability_id: None,
                    provider: Provider::Netgsm,
                    kind: EventKind::CallEvent,
                    external_id: id.to_string(),
                    payload: serde_json::json!({}),
                    received_at,
                    processed_at: None,
                },
                None,
            )
            .await
            .unwrap();
        assert!(r.consumption().try_claim("inbox@2", id).await.unwrap());
        defer(&mut *r, id, FIXED_NOW).await;
    }
    r.commit().await.unwrap();
    assert!(listed(&uow, f.ws).await.is_empty());

    // Before the first hour: the old event is given up on, the fresh one waits.
    assert_eq!(
        release(&uow, f.ws, FIXED_NOW + Duration::minutes(30)).await,
        vec![old]
    );
    assert!(listed(&uow, f.ws).await.is_empty());
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(!r.consumption().try_claim("inbox@2", fresh).await.unwrap());
    drop(r);

    // An hour after the first deferral it is listed and claimable again; deferred a second
    // time, it is due two hours after that.
    assert!(
        release(&uow, f.ws, FIXED_NOW + Duration::hours(1))
            .await
            .is_empty()
    );
    assert_eq!(listed(&uow, f.ws).await, vec![fresh]);
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(r.consumption().try_claim("inbox@2", fresh).await.unwrap());
    defer(&mut *r, fresh, FIXED_NOW + Duration::hours(1)).await;
    r.commit().await.unwrap();
    assert!(
        release(&uow, f.ws, FIXED_NOW + Duration::hours(2))
            .await
            .is_empty()
    );
    assert!(listed(&uow, f.ws).await.is_empty());
    assert!(
        release(&uow, f.ws, FIXED_NOW + Duration::hours(3))
            .await
            .is_empty()
    );
    assert_eq!(listed(&uow, f.ws).await, vec![fresh]);

    // The abandoned event stays abandoned, and another workspace's run touches nothing.
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(!r.consumption().try_claim("inbox@2", old).await.unwrap());
    drop(r);
    assert!(
        release(&uow, f.other, FIXED_NOW + Duration::days(9))
            .await
            .is_empty()
    );
    assert!(listed(&uow, f.other).await.is_empty());

    // Consumed at last, it is never released nor abandoned.
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert!(r.consumption().try_claim("inbox@2", fresh).await.unwrap());
    r.consumption()
        .record(
            "inbox@2",
            fresh,
            ConsumptionOutcome {
                consumed_at: FIXED_NOW + Duration::hours(3),
                outcome: "consumed".into(),
            },
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert!(
        release(&uow, f.ws, FIXED_NOW + Duration::days(9))
            .await
            .is_empty()
    );
    assert!(listed(&uow, f.ws).await.is_empty());
}
