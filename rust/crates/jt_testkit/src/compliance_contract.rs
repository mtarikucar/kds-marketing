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
