//! Shared behavioral contracts for real PostgreSQL and the transactional fake.
use crate::fakes::FIXED_NOW as NOW;
use jt_app::{
    error::ErrorCode,
    ports::{billing::*, *},
};
use jt_ledger::Actor;
use jt_tenancy::{Email, OperatorId, UserId, WorkspaceId, WorkspaceStatus};
use time::Duration;

pub struct Fixture {
    pub ws: WorkspaceId,
    pub user: UserId,
    pub operator: OperatorId,
}
pub async fn fixture(uow: &dyn UnitOfWork) -> Fixture {
    let ws = WorkspaceId::new_v7();
    let user = UserId::new_v7();
    let operator = OperatorId::new_v7();
    let mut r = uow.user().await.unwrap();
    r.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{user}@billing.test")).unwrap(),
            password_hash: "synthetic".into(),
            display_name: "Billing fixture".into(),
            created_at: NOW,
        })
        .await
        .unwrap();
    r.workspaces_create(
        ws,
        "Billing fixture",
        &ws.to_string(),
        WorkspaceStatus::PendingPayment,
        NOW,
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
    let mut r = uow.platform().await.unwrap();
    r.operators()
        .insert(OperatorRow {
            id: operator,
            email: Email::parse(&format!("{operator}@billing.test")).unwrap(),
            password_hash: "synthetic".into(),
            created_at: NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    Fixture { ws, user, operator }
}
pub fn payment(f: &Fixture) -> PaymentNotification {
    PaymentNotification {
        id: PaymentId::new_v7(),
        workspace_id: f.ws,
        reported_by: f.user,
        reference_sealed: b"sealed synthetic bank reference".to_vec(),
        request_key: "request-one".into(),
        amount_minor: 123,
        currency: "TRY".into(),
        paid_at: NOW - Duration::days(1),
        reported_at: NOW,
    }
}
pub fn grant(f: &Fixture, p: &PaymentNotification) -> WorkspaceEntitlement {
    WorkspaceEntitlement {
        id: EntitlementId::new_v7(),
        workspace_id: f.ws,
        source: EntitlementSource::Paid,
        payment_id: Some(p.id),
        confirmed_by: Some(f.operator),
        confirmed_at: NOW,
        activated_at: None,
        redeemed_by: None,
        revoked_at: None,
        reason: None,
    }
}
pub fn code(f: &Fixture, e: &WorkspaceEntitlement) -> ActivationCodeRow {
    ActivationCodeRow {
        id: ActivationCodeId::new_v7(),
        workspace_id: f.ws,
        entitlement_id: e.id,
        action: "billing.activate".into(),
        digest: vec![7; 32],
        issued_by: f.operator,
        created_at: NOW,
        expires_at: NOW + Duration::hours(72),
        attempts: 0,
        invalidated_at: None,
        consumed_at: None,
        redeemed_by: None,
    }
}
pub async fn seed(
    uow: &dyn UnitOfWork,
    f: &Fixture,
) -> (PaymentNotification, WorkspaceEntitlement) {
    let p = payment(f);
    let e = grant(f, &p);
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.billing().insert_payment(p.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.platform().await.unwrap();
    t.entitlement_insert(e.clone()).await.unwrap();
    t.commit().await.unwrap();
    (p, e)
}
pub async fn request_key_unique_per_workspace(uow: &dyn UnitOfWork) {
    let a = fixture(uow).await;
    let b = fixture(uow).await;
    let p = payment(&a);
    let mut t = uow.tenant(a.ws).await.unwrap();
    t.billing().insert_payment(p.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a.ws).await.unwrap();
    assert_eq!(
        t.billing().get_payment(p.id).await.unwrap(),
        Some(p.clone())
    );
    assert_eq!(
        t.billing().find_request("request-one").await.unwrap(),
        Some(p.clone())
    );
    drop(t);
    let mut duplicate = p.clone();
    duplicate.id = PaymentId::new_v7();
    let mut t = uow.tenant(a.ws).await.unwrap();
    assert_eq!(
        t.billing()
            .insert_payment(duplicate)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(b.ws).await.unwrap();
    t.billing().insert_payment(payment(&b)).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b.ws).await.unwrap();
    assert!(t.billing().get_payment(p.id).await.unwrap().is_none());
    assert!(t.billing().insert_payment(p).await.is_err());
}
pub async fn paid_and_grandfathered_provenance_constraints(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let p = payment(&f);
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.billing().insert_payment(p.clone()).await.unwrap();
    t.commit().await.unwrap();
    for kind in 0..4 {
        let mut e = grant(&f, &p);
        match kind {
            0 => e.confirmed_by = None,
            1 => e.payment_id = None,
            2 => e.source = EntitlementSource::Grandfathered,
            _ => {
                e.source = EntitlementSource::Grandfathered;
                e.payment_id = None;
            }
        }
        let mut t = uow.platform().await.unwrap();
        assert!(t.entitlement_insert(e).await.is_err());
    }
    let mut e = grant(&f, &p);
    e.source = EntitlementSource::Grandfathered;
    e.payment_id = None;
    e.confirmed_by = None;
    e.activated_at = Some(NOW);
    let mut t = uow.platform().await.unwrap();
    t.entitlement_insert(e.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.billing().entitlement().await.unwrap(), Some(e));
}
pub async fn one_open_grant_preserves_closed_history(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let (p, e) = seed(uow, &f).await;
    let mut t = uow.platform().await.unwrap();
    assert_eq!(
        t.entitlement_insert(grant(&f, &p)).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.platform().await.unwrap();
    t.entitlement_revoke(f.ws, e.id, NOW, "refund recorded out of band")
        .await
        .unwrap();
    t.commit().await.unwrap();
    let fresh = grant(&f, &p);
    let mut t = uow.platform().await.unwrap();
    t.entitlement_insert(fresh.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.billing().entitlement().await.unwrap(), Some(fresh));
    assert!(
        t.billing()
            .activate_entitlement(e.id, NOW, f.user)
            .await
            .is_err()
    );
}
pub async fn workspace_status_reason_actor_is_atomic(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let by = Actor::Human { user_id: f.user };
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.workspace()
        .set_status(f.ws, WorkspaceStatus::Active, "payment redeemed", &by)
        .await
        .unwrap();
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.workspace().get().await.unwrap().status,
        WorkspaceStatus::PendingPayment
    );
    assert!(
        t.ledger()
            .list(LedgerFilter {
                action_prefix: None,
                actor_kind: None,
                agent_connection_id: None,
                limit: 50,
                before_id: None
            })
            .await
            .unwrap()
            .is_empty()
    );
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.workspace()
        .set_status(f.ws, WorkspaceStatus::Active, "payment redeemed", &by)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let entries = t
        .ledger()
        .list(LedgerFilter {
            action_prefix: None,
            actor_kind: None,
            agent_connection_id: None,
            limit: 50,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0].entry;
    assert_eq!(e.action.as_str(), "platform.workspace_status");
    assert_eq!(e.actor, by);
    assert_eq!(
        e.payload,
        serde_json::json!({"from":"pending_payment","to":"active","reason":"payment redeemed","by":by})
    );
    assert_eq!(
        t.workspace().get().await.unwrap().status,
        WorkspaceStatus::Active
    );
    drop(t);
    let mut t = uow.platform().await.unwrap();
    assert!(
        t.workspace_set_status(f.ws, WorkspaceStatus::Suspended, " ", &by)
            .await
            .is_err()
    );
    drop(t);
    let other = fixture(uow).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(
        t.workspace()
            .set_status(other.ws, WorkspaceStatus::Suspended, "cross tenant", &by)
            .await
            .is_err()
    );
    drop(t);
    let mut t = uow.platform().await.unwrap();
    t.workspace_set_status(f.ws, WorkspaceStatus::Suspended, "operator hold", &by)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.workspace().get().await.unwrap().status,
        WorkspaceStatus::Suspended
    );
    assert_eq!(
        t.ledger()
            .list(LedgerFilter {
                action_prefix: None,
                actor_kind: None,
                agent_connection_id: None,
                limit: 50,
                before_id: None
            })
            .await
            .unwrap()
            .len(),
        2
    );
}
pub async fn activation_challenge_attempts_replay_and_reissue(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let (_, e) = seed(uow, &f).await;
    let c = code(&f, &e);
    let mut t = uow.platform().await.unwrap();
    t.activation_code_insert(f.ws, c.clone()).await.unwrap();
    t.commit().await.unwrap();
    for _ in 0..7 {
        let mut t = uow.tenant(f.ws).await.unwrap();
        t.activation_codes()
            .record_failed_attempt(c.id)
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.activation_codes()
            .lock_current_by_workspace()
            .await
            .unwrap()
            .unwrap()
            .attempts,
        5
    );
    assert!(
        t.activation_codes()
            .consume(c.id, NOW, f.user)
            .await
            .is_err()
    );
    drop(t);
    let mut fresh = code(&f, &e);
    fresh.created_at = NOW + Duration::seconds(1);
    let mut t = uow.platform().await.unwrap();
    t.activation_code_invalidate_current(f.ws, NOW)
        .await
        .unwrap();
    t.activation_code_insert(f.ws, fresh.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.activation_codes()
        .consume(fresh.id, NOW + Duration::seconds(2), f.user)
        .await
        .unwrap();
    t.billing()
        .activate_entitlement(e.id, NOW + Duration::seconds(2), f.user)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    let replay = t
        .activation_codes()
        .lock_current_by_workspace()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.id, fresh.id);
    assert_eq!(replay.redeemed_by, Some(f.user));
    assert!(replay.consumed_at.is_some());
    assert!(
        t.activation_codes()
            .consume(fresh.id, NOW + Duration::seconds(3), f.user)
            .await
            .is_err()
    );
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let activated = t.billing().entitlement().await.unwrap().unwrap();
    assert_eq!(activated.redeemed_by, Some(f.user));
    assert_eq!(activated.activated_at, Some(NOW + Duration::seconds(2)));
}
pub async fn stable_reference_and_masked_debug(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let a = t.billing().reference_get_or_create().await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(a, t.billing().reference_get_or_create().await.unwrap());
    drop(t);
    assert_eq!(a.len(), 21);
    assert!(a.starts_with(&format!(
        "JEETA-{}-",
        &f.ws.as_uuid().simple().to_string()[..8].to_uppercase()
    )));
    assert!(a[15..].chars().all(|c| c.is_ascii_digit()));
    let p = payment(&f);
    let e = grant(&f, &p);
    let c = code(&f, &e);
    assert!(!format!("{p:?}").contains("sealed synthetic"));
    assert!(!format!("{p:?}").contains("115, 101, 97"));
    assert!(!format!("{c:?}").contains("7, 7, 7"));
    assert_eq!(
        serde_json::to_value(EntitlementSource::Paid).unwrap(),
        "paid"
    );
    assert_eq!(
        serde_json::to_value(EntitlementSource::Grandfathered).unwrap(),
        "grandfathered"
    );
}

pub async fn workspace_lock_serializes_grants_and_references(uow: &dyn UnitOfWork) {
    let f = fixture(uow).await;
    let p = payment(&f);
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.billing().insert_payment(p.clone()).await.unwrap();
    t.commit().await.unwrap();
    let e1 = grant(&f, &p);
    let e2 = grant(&f, &p);
    let confirm = |row: WorkspaceEntitlement| async move {
        let mut t = uow.platform().await.unwrap();
        let result = t.entitlement_insert(row).await;
        if result.is_ok() {
            t.commit().await.unwrap();
        }
        result
    };
    let (a, b) = tokio::join!(confirm(e1), confirm(e2));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(a.err().or(b.err()).unwrap().code, ErrorCode::Conflict);
    let reference = || async {
        let mut t = uow.tenant(f.ws).await.unwrap();
        let r = t.billing().reference_get_or_create().await.unwrap();
        t.commit().await.unwrap();
        r
    };
    let (a, b) = tokio::join!(reference(), reference());
    assert_eq!(a, b);
    let mut t = uow.platform().await.unwrap();
    let e = t.entitlement_get(f.ws).await.unwrap().unwrap();
    let c = code(&f, &e);
    t.activation_code_insert(f.ws, c.clone()).await.unwrap();
    t.commit().await.unwrap();
    let fail = || async {
        for _ in 0..4 {
            let mut t = uow.tenant(f.ws).await.unwrap();
            t.activation_codes()
                .record_failed_attempt(c.id)
                .await
                .unwrap();
            t.commit().await.unwrap();
        }
    };
    tokio::join!(fail(), fail());
    let mut t = uow.platform().await.unwrap();
    assert_eq!(
        t.activation_code_lock_current_by_workspace(f.ws)
            .await
            .unwrap()
            .unwrap()
            .attempts,
        5
    );
}
pub async fn challenge_expiry_and_tenant_references_are_enforced(uow: &dyn UnitOfWork) {
    let a = fixture(uow).await;
    let b = fixture(uow).await;
    let (p, e) = seed(uow, &a).await;
    let mut wrong = grant(&b, &p);
    wrong.payment_id = Some(p.id);
    let mut t = uow.platform().await.unwrap();
    assert!(t.entitlement_insert(wrong).await.is_err());
    drop(t);
    let c = code(&a, &e);
    let mut t = uow.platform().await.unwrap();
    assert!(t.activation_code_insert(b.ws, c.clone()).await.is_err());
    drop(t);
    let mut wrong_code = c.clone();
    wrong_code.workspace_id = b.ws;
    let mut t = uow.platform().await.unwrap();
    assert!(t.activation_code_insert(b.ws, wrong_code).await.is_err());
    drop(t);
    let mut t = uow.tenant(a.ws).await.unwrap();
    t.activation_codes().insert(c.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a.ws).await.unwrap();
    assert_eq!(
        t.activation_codes()
            .insert(code(&a, &e))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a.ws).await.unwrap();
    assert!(
        t.activation_codes()
            .consume(c.id, c.expires_at, a.user)
            .await
            .is_err()
    );
    drop(t);
    let mut t = uow.platform().await.unwrap();
    assert_eq!(
        t.activation_code_lock_current_by_workspace(a.ws)
            .await
            .unwrap(),
        Some(c.clone())
    );
    drop(t);
    let mut t = uow.tenant(b.ws).await.unwrap();
    assert!(
        t.activation_codes()
            .lock_current_by_workspace()
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        t.activation_codes()
            .record_failed_attempt(c.id)
            .await
            .is_err()
    );
    drop(t);
    let mut t = uow.platform().await.unwrap();
    t.entitlement_revoke(a.ws, e.id, NOW, "revoked while challenge pending")
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a.ws).await.unwrap();
    assert!(
        t.activation_codes()
            .consume(c.id, NOW, a.user)
            .await
            .is_err()
    );
}
