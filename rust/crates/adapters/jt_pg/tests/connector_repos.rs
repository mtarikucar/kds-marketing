//! Inbound events, pending OAuth flows and probe runs against a real database: the repos'
//! contracts, deduplication of replayed webhooks (Review Focus 2), the append-only probe log, the
//! column guard on inbound events (only the raw body and the processing time change), workspace
//! scoping, and the platform-wide lookup of a live capability by its external account.

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::connectors::OAuthCallback;
use jt_app::ports::{
    EventOrder, EventQuery, OAuthPendingId, OAuthPendingRow, ProbeRun, ProbeRunId, UnitOfWork,
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_pg::{PgUnitOfWork, PlatformTx, TenantTx};
use jt_tenancy::{UserId, WorkspaceId};
use jt_testkit::TestDb;
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

fn uow(db: &TestDb) -> PgUnitOfWork {
    PgUnitOfWork::new(db.pool.clone())
}

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

/// A declared capability of `kind` in `ws` holding the external account `external_id`.
fn capability(ws: WorkspaceId, kind: &str, external_id: &str, at: OffsetDateTime) -> Capability {
    Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {external_id}"),
            external_id: Some(external_id.into()),
            connector_public: json!({ "name": "Kahve Dükkanı" }),
            ..NewCapability::default()
        },
        at,
    )
    .unwrap()
}

async fn insert_capability(uow: &PgUnitOfWork, c: &Capability) {
    let mut t = uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
}

/// A pending event of `provider` in `ws` with the provider's id `external_id`.
fn event(
    ws: WorkspaceId,
    provider: Provider,
    external_id: &str,
    capability: Option<CapabilityId>,
    received_at: OffsetDateTime,
) -> InboundEvent {
    InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws,
        provider,
        capability_id: capability,
        external_id: external_id.into(),
        kind: EventKind::Message,
        payload: json!({ "text": "Merhaba", "from": "905550000000" }),
        received_at,
        processed_at: None,
    }
}

fn pending(
    ws: WorkspaceId,
    user: UserId,
    state_hash: &str,
    expires_at: OffsetDateTime,
) -> OAuthPendingRow {
    OAuthPendingRow {
        id: OAuthPendingId::new_v7(),
        workspace_id: ws,
        provider: Provider::X,
        kind_key: "x".into(),
        app: OAuthCallback::X,
        state_hash: state_hash.into(),
        started_by: user,
        capability_id: None,
        pkce_verifier_sealed: Some(b"sealed-verifier".to_vec()),
        assets_sealed: None,
        assets_public: json!([]),
        expires_at,
        created_at: expires_at - Duration::minutes(10),
    }
}

fn probe_run(c: &Capability, at: OffsetDateTime, ok: bool) -> ProbeRun {
    ProbeRun {
        id: ProbeRunId::new_v7(),
        workspace_id: c.workspace_id,
        capability_id: c.id,
        at,
        ok,
        error_kind: (!ok).then(|| "auth".to_owned()),
        latency_ms: 120,
        facts: if ok {
            json!({ "name": "Kahve Dükkanı" })
        } else {
            json!({})
        },
    }
}

/// Waits until another backend of this database waits for a lock; panics after ten seconds.
async fn wait_for_a_lock_waiter(db: &TestDb) {
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() \
             and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("no backend ever waited for a lock");
}

// ---------------------------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_inbound_event_is_ignored() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let wa = capability(a, "whatsapp_cloud", "phone-1", T0);
    insert_capability(&uow, &wa).await;

    let first = event(a, Provider::Meta, "wamid.1", Some(wa.id), T0);
    let mut t = uow.tenant(a).await.unwrap();
    let stored = t
        .inbound_events()
        .insert_if_new(first.clone(), Some(b"{\"raw\":1}".to_vec()))
        .await
        .unwrap();
    assert_eq!(stored, Some(first.id));
    t.commit().await.unwrap();

    // The same delivery again (a new id, the same provider and provider id): nothing is written,
    // and the bundle stays usable.
    let replay = event(
        a,
        Provider::Meta,
        "wamid.1",
        Some(wa.id),
        T0 + Duration::seconds(5),
    );
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events()
            .insert_if_new(replay, Some(b"{\"raw\":2}".to_vec()))
            .await
            .unwrap(),
        None
    );
    // The same provider id from another provider, or in another workspace, is another event.
    let sms = event(
        a,
        Provider::Netgsm,
        "wamid.1",
        None,
        T0 + Duration::seconds(6),
    );
    assert_eq!(
        t.inbound_events()
            .insert_if_new(sms.clone(), None)
            .await
            .unwrap(),
        Some(sms.id)
    );
    t.commit().await.unwrap();
    let theirs = event(b, Provider::Meta, "wamid.1", None, T0);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.inbound_events()
            .insert_if_new(theirs.clone(), None)
            .await
            .unwrap(),
        Some(theirs.id)
    );
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![first.clone(), sms.clone()]
    );
    drop(t);

    // Two deliveries racing: the second waits for the first and then writes nothing.
    let racing = event(
        a,
        Provider::Meta,
        "wamid.2",
        None,
        T0 + Duration::minutes(1),
    );
    let mut winner = uow.tenant(a).await.unwrap();
    assert_eq!(
        winner
            .inbound_events()
            .insert_if_new(racing.clone(), None)
            .await
            .unwrap(),
        Some(racing.id)
    );
    let loser = {
        let uow = uow.clone();
        let late = event(
            a,
            Provider::Meta,
            "wamid.2",
            None,
            T0 + Duration::minutes(1),
        );
        tokio::spawn(async move {
            let mut t = uow.tenant(a).await.unwrap();
            let stored = t.inbound_events().insert_if_new(late, None).await.unwrap();
            t.commit().await.unwrap();
            stored
        })
    };
    wait_for_a_lock_waiter(&db).await;
    assert!(!loser.is_finished(), "the second delivery did not wait");
    winner.commit().await.unwrap();
    assert_eq!(loser.await.unwrap(), None);
    let n: i64 = {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        sqlx::query_scalar(
            "select count(*) from inbound_events where workspace_id = $1 and external_id = $2",
        )
        .bind(a.as_uuid())
        .bind("wamid.2")
        .fetch_one(tx.conn())
        .await
        .unwrap()
    };
    assert_eq!(n, 1);

    // A taken id is a conflict, not a duplicate; another workspace's capability is not found.
    let mut t = uow.tenant(a).await.unwrap();
    let taken = InboundEvent {
        external_id: "wamid.3".into(),
        ..first.clone()
    };
    assert_eq!(
        code(t.inbound_events().insert_if_new(taken, None).await),
        ErrorCode::Conflict
    );
    let foreign = capability(b, "whatsapp_cloud", "phone-9", T0);
    insert_capability(&uow, &foreign).await;
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.inbound_events()
                .insert_if_new(
                    event(a, Provider::Meta, "wamid.4", Some(foreign.id), T0),
                    None
                )
                .await
        ),
        ErrorCode::NotFound
    );
    // An event for another workspace is a programming error.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.inbound_events()
                .insert_if_new(event(b, Provider::Meta, "wamid.5", None, T0), None)
                .await
        ),
        ErrorCode::Internal
    );
}

#[tokio::test]
async fn pending_events_are_listed_oldest_first_and_marked_processed_once() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let late = event(a, Provider::Meta, "mid.2", None, T0 + Duration::minutes(2));
    let early = event(a, Provider::Meta, "mid.1", None, T0);
    let unknown_kind = InboundEvent {
        kind: EventKind::Unknown("reaction".into()),
        ..event(a, Provider::X, "x.1", None, T0 + Duration::minutes(1))
    };
    let mut t = uow.tenant(a).await.unwrap();
    for e in [&late, &early, &unknown_kind] {
        t.inbound_events()
            .insert_if_new(e.clone(), None)
            .await
            .unwrap();
    }
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![early.clone(), unknown_kind.clone(), late.clone()]
    );
    assert_eq!(
        t.inbound_events().list_pending(1).await.unwrap(),
        vec![early.clone()]
    );
    // A limit of 0 reads as 1.
    assert_eq!(t.inbound_events().list_pending(0).await.unwrap().len(), 1);

    let at = T0 + Duration::hours(1);
    assert!(
        t.inbound_events()
            .mark_processed(early.id, at)
            .await
            .unwrap()
    );
    // Marking again keeps the first time.
    assert!(
        !t.inbound_events()
            .mark_processed(early.id, at + Duration::hours(1))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![unknown_kind, late]
    );
    let processed_at: Option<OffsetDateTime> = {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        sqlx::query_scalar(
            "select processed_at from inbound_events where workspace_id = $1 and id = $2",
        )
        .bind(a.as_uuid())
        .bind(early.id.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap()
    };
    assert_eq!(processed_at, Some(at));
    assert_eq!(
        code(
            t.inbound_events()
                .mark_processed(InboundEventId::new_v7(), at)
                .await
        ),
        ErrorCode::NotFound
    );
}

/// The ids of `events`, in order.
fn ids(events: &[InboundEvent]) -> Vec<InboundEventId> {
    events.iter().map(|e| e.id).collect()
}

/// An event query over every event, oldest first, at most 50.
fn query(order: EventOrder) -> EventQuery {
    EventQuery {
        pending_only: false,
        provider: None,
        kind: None,
        order,
        limit: 50,
    }
}

const OLDEST: EventOrder = EventOrder::OldestFirst { after: None };
const NEWEST: EventOrder = EventOrder::NewestFirst { before: None };

#[tokio::test]
async fn events_are_listed_by_query_in_either_order_and_counted() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let e1 = event(a, Provider::Meta, "mid.1", None, T0);
    let e2 = InboundEvent {
        kind: EventKind::Consent,
        ..event(
            a,
            Provider::Netgsm,
            "netgsm-iys:1",
            None,
            T0 + Duration::minutes(1),
        )
    };
    let e3 = InboundEvent {
        kind: EventKind::Status,
        ..event(
            a,
            Provider::Meta,
            "mid.1:delivered",
            None,
            T0 + Duration::minutes(2),
        )
    };
    let e4 = InboundEvent {
        kind: EventKind::Unknown("reaction".into()),
        ..event(
            a,
            Provider::Meta,
            "reaction.1",
            None,
            T0 + Duration::minutes(3),
        )
    };
    // Two events at one instant: the id breaks the tie, in both orders and at a cursor.
    let mut twins = [
        event(a, Provider::X, "x.1", None, T0 + Duration::minutes(5)),
        event(a, Provider::X, "x.2", None, T0 + Duration::minutes(5)),
    ];
    twins.sort_by_key(|e| e.id);
    let [t1, t2] = twins.clone();
    let mut t = uow.tenant(a).await.unwrap();
    for e in [&e4, &e1, &t2, &e3, &e2, &t1] {
        t.inbound_events()
            .insert_if_new(e.clone(), Some(b"raw".to_vec()))
            .await
            .unwrap();
    }
    t.inbound_events()
        .mark_processed(e2.id, T0 + Duration::hours(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.inbound_events()
        .insert_if_new(event(b, Provider::Meta, "mid.b", None, T0), None)
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let mut list = async |q: EventQuery| ids(&t.inbound_events().list(q).await.unwrap());
    assert_eq!(
        list(query(OLDEST)).await,
        [e1.id, e2.id, e3.id, e4.id, t1.id, t2.id]
    );
    assert_eq!(
        list(query(NEWEST)).await,
        [t2.id, t1.id, e4.id, e3.id, e2.id, e1.id]
    );
    assert_eq!(
        list(EventQuery {
            pending_only: true,
            ..query(OLDEST)
        })
        .await,
        [e1.id, e3.id, e4.id, t1.id, t2.id]
    );
    // Key-set cursors, ties included.
    assert_eq!(
        list(EventQuery {
            pending_only: true,
            ..query(EventOrder::OldestFirst {
                after: Some((e1.received_at, e1.id))
            })
        })
        .await,
        [e3.id, e4.id, t1.id, t2.id]
    );
    assert_eq!(
        list(query(EventOrder::OldestFirst {
            after: Some((t1.received_at, t1.id))
        }))
        .await,
        [t2.id]
    );
    assert_eq!(
        list(query(EventOrder::NewestFirst {
            before: Some((t2.received_at, t2.id))
        }))
        .await,
        [t1.id, e4.id, e3.id, e2.id, e1.id]
    );
    assert_eq!(
        list(query(EventOrder::NewestFirst {
            before: Some((e3.received_at, e3.id))
        }))
        .await,
        [e2.id, e1.id]
    );
    // Filters and limits.
    assert_eq!(
        list(EventQuery {
            provider: Some(Provider::Netgsm),
            ..query(NEWEST)
        })
        .await,
        [e2.id]
    );
    assert_eq!(
        list(EventQuery {
            kind: Some(EventKind::Status),
            ..query(NEWEST)
        })
        .await,
        [e3.id]
    );
    assert_eq!(
        list(EventQuery {
            kind: Some(EventKind::Unknown("reaction".into())),
            ..query(NEWEST)
        })
        .await,
        [e4.id]
    );
    assert_eq!(
        list(EventQuery {
            limit: 2,
            ..query(NEWEST)
        })
        .await,
        [t2.id, t1.id]
    );
    assert_eq!(
        list(EventQuery {
            limit: 0,
            ..query(OLDEST)
        })
        .await,
        [e1.id]
    );
    // What a listing reads is the stored event, its processing time included.
    let read = t.inbound_events().list(query(OLDEST)).await.unwrap();
    assert_eq!(read[0], e1);
    assert_eq!(read[1].processed_at, Some(T0 + Duration::hours(1)));

    // Counting stops at its cap and sees only this workspace's pending events.
    assert_eq!(t.inbound_events().count_pending(1_000).await.unwrap(), 5);
    assert_eq!(t.inbound_events().count_pending(3).await.unwrap(), 3);
    assert_eq!(t.inbound_events().count_pending(0).await.unwrap(), 0);
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.inbound_events().count_pending(1_000).await.unwrap(), 1);
}

#[tokio::test]
async fn raw_purge_touches_only_raw_column() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let old = event(a, Provider::Netgsm, "netgsm-mo:1", None, T0);
    let old_without_raw = event(a, Provider::Netgsm, "netgsm-mo:2", None, T0);
    let fresh = event(
        a,
        Provider::Netgsm,
        "netgsm-mo:3",
        None,
        T0 + Duration::days(40),
    );
    let theirs = event(b, Provider::Netgsm, "netgsm-mo:1", None, T0);
    let mut t = uow.tenant(a).await.unwrap();
    t.inbound_events()
        .insert_if_new(old.clone(), Some(b"old body".to_vec()))
        .await
        .unwrap();
    t.inbound_events()
        .insert_if_new(old_without_raw.clone(), None)
        .await
        .unwrap();
    t.inbound_events()
        .insert_if_new(fresh.clone(), Some(b"fresh body".to_vec()))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.inbound_events()
        .insert_if_new(theirs.clone(), Some(b"their body".to_vec()))
        .await
        .unwrap();
    t.commit().await.unwrap();

    // 30 days after the fresh one arrived: only `old` still has a body to remove, and only in
    // this workspace.
    let cutoff = T0 + Duration::days(10);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().purge_raw_before(cutoff).await.unwrap(),
        1
    );
    assert_eq!(
        t.inbound_events().purge_raw_before(cutoff).await.unwrap(),
        0
    );
    t.commit().await.unwrap();

    let raw = |ws: WorkspaceId, id: InboundEventId| {
        let pool = db.pool.clone();
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let raw: Option<Vec<u8>> = sqlx::query_scalar(
                "select raw from inbound_events where workspace_id = $1 and id = $2",
            )
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
            raw
        }
    };
    assert_eq!(raw(a, old.id).await, None);
    assert_eq!(raw(a, fresh.id).await, Some(b"fresh body".to_vec()));
    assert_eq!(raw(b, theirs.id).await, Some(b"their body".to_vec()));
    // The rest of the purged row is as it was.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![old.clone(), old_without_raw.clone(), fresh.clone()]
    );
    drop(t);

    // Every other column is guarded, even against its own workspace, by the trigger itself (its
    // own message, not row-level security or a key); the processing time may be set, and the raw
    // body may only be removed.
    const FROZEN: &str = "inbound_events is append-only: only raw and processed_at may change";
    for (statement, message) in [
        (
            "update inbound_events set id = gen_random_uuid() where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set payload = '{}' where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set kind = 'status' where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set external_id = 'other' where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set provider = 'x' where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set received_at = now() where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set capability_id = id where workspace_id = $1 and id = $2",
            FROZEN,
        ),
        (
            "update inbound_events set raw = 'replaced'::bytea where workspace_id = $1 and id = $2",
            "inbound_events.raw may only be removed",
        ),
        (
            "delete from inbound_events where workspace_id = $1 and id = $2",
            "inbound_events rows are never deleted",
        ),
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .bind(fresh.id.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains(message), "{statement}: {err}");
        tx.rollback().await.unwrap();
    }
    // Platform-wide, where row-level security lets any workspace through, the trigger alone keeps
    // an event in its workspace.
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query(
        "update inbound_events set workspace_id = $3 where workspace_id = $1 and id = $2",
    )
    .bind(a.as_uuid())
    .bind(fresh.id.as_uuid())
    .bind(b.as_uuid())
    .execute(p.conn())
    .await
    .unwrap_err();
    assert!(err.to_string().contains(FROZEN), "{err}");
    p.rollback().await.unwrap();
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let done = sqlx::query(
        "update inbound_events set processed_at = now(), raw = null \
         where workspace_id = $1 and id = $2",
    )
    .bind(a.as_uuid())
    .bind(fresh.id.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap();
    assert_eq!(done.rows_affected(), 1);
    tx.rollback().await.unwrap();
}

// ---------------------------------------------------------------------------------------------
// Pending OAuth flows
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn oauth_pending_state_hash_is_unique_and_purgeable() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner_a) = db.seed_workspace("a").await;
    let (b, owner_b) = db.seed_workspace("b").await;

    let soon = pending(a, owner_a, "hash-soon", T0 + Duration::minutes(10));
    let later = pending(a, owner_a, "hash-later", T0 + Duration::minutes(30));
    let theirs = pending(b, owner_b, "hash-theirs", T0 + Duration::minutes(10));
    let mut t = uow.tenant(a).await.unwrap();
    t.oauth_pending().insert(soon.clone()).await.unwrap();
    t.oauth_pending().insert(later.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.oauth_pending().insert(theirs.clone()).await.unwrap();
    t.commit().await.unwrap();

    // Found by its hash, sealed verifier included; never across workspaces.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-soon")
            .await
            .unwrap(),
        Some(soon.clone())
    );
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-theirs")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-none")
            .await
            .unwrap(),
        None
    );
    drop(t);

    // A state hash is unique across every workspace, and so is the id.
    for row in [
        OAuthPendingRow {
            id: OAuthPendingId::new_v7(),
            ..soon.clone()
        },
        OAuthPendingRow {
            id: OAuthPendingId::new_v7(),
            workspace_id: a,
            started_by: owner_a,
            ..theirs.clone()
        },
        OAuthPendingRow {
            state_hash: "hash-fresh".into(),
            ..soon.clone()
        },
    ] {
        let mut t = uow.tenant(a).await.unwrap();
        assert_eq!(
            code(t.oauth_pending().insert(row).await),
            ErrorCode::Conflict
        );
    }
    // A taken state hash is a conflict even when the starter is unknown too (the clash is found
    // before the foreign key is checked).
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .insert(OAuthPendingRow {
                    id: OAuthPendingId::new_v7(),
                    started_by: UserId::new_v7(),
                    ..soon.clone()
                })
                .await
        ),
        ErrorCode::Conflict
    );
    // A row for another workspace is a programming error; an unknown starter is not found.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .insert(pending(b, owner_b, "hash-x", T0))
                .await
        ),
        ErrorCode::Internal
    );
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .insert(pending(a, UserId::new_v7(), "hash-y", T0))
                .await
        ),
        ErrorCode::NotFound
    );

    // The assets of a completed flow are stored with it.
    let mut t = uow.tenant(a).await.unwrap();
    let public = json!([{ "kind_key": "x", "external_id": "u-1", "name": "@kahve" }]);
    t.oauth_pending()
        .set_assets(soon.id, b"sealed-assets".to_vec(), public.clone())
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    let completed = t
        .oauth_pending()
        .find_by_state_hash("hash-soon")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.assets_sealed, Some(b"sealed-assets".to_vec()));
    assert_eq!(completed.assets_public, public);
    assert_eq!(
        completed.pkce_verifier_sealed,
        Some(b"sealed-verifier".to_vec())
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .set_assets(soon.id, b"x".to_vec(), json!([]))
                .await
        ),
        ErrorCode::NotFound
    );

    // Purging at the expiry keeps the row (the state is still accepted at that instant); after
    // it, the row goes, in this workspace only.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .purge_expired(T0 + Duration::minutes(10))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        t.oauth_pending()
            .purge_expired(T0 + Duration::minutes(11))
            .await
            .unwrap(),
        1
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-soon")
            .await
            .unwrap(),
        None
    );
    assert!(
        t.oauth_pending()
            .find_by_state_hash("hash-later")
            .await
            .unwrap()
            .is_some()
    );
    // Deleting removes it once; the second time it is not found.
    t.oauth_pending().delete(later.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.oauth_pending().delete(later.id).await),
        ErrorCode::NotFound
    );
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-theirs")
            .await
            .unwrap(),
        Some(theirs)
    );
}

/// `0013_social_providers`: TikTok and LinkedIn flows are stored under their own provider and
/// app; its down keeps the widened checks while such a flow remains, and narrows them once none
/// does.
#[tokio::test]
async fn tiktok_and_linkedin_flows_are_stored_and_survive_a_rollback() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let tiktok = OAuthPendingRow {
        provider: Provider::Tiktok,
        kind_key: "tiktok".into(),
        app: OAuthCallback::Tiktok,
        pkce_verifier_sealed: None,
        ..pending(a, owner, "hash-tiktok", T0 + Duration::minutes(30))
    };
    let linkedin = OAuthPendingRow {
        provider: Provider::Linkedin,
        kind_key: "linkedin_page".into(),
        app: OAuthCallback::Linkedin,
        pkce_verifier_sealed: None,
        ..pending(a, owner, "hash-linkedin", T0 + Duration::minutes(30))
    };
    let mut t = uow.tenant(a).await.unwrap();
    t.oauth_pending().insert(tiktok.clone()).await.unwrap();
    t.oauth_pending().insert(linkedin.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    for row in [&tiktok, &linkedin] {
        assert_eq!(
            t.oauth_pending()
                .find_by_state_hash(&row.state_hash)
                .await
                .unwrap()
                .as_ref(),
            Some(row)
        );
    }
    drop(t);

    let down = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../migrations/0013_social_providers.down.sql"),
    )
    .unwrap();
    let constraint = |name: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "select pg_get_constraintdef(oid) from pg_constraint where conname = $1",
            )
            .bind(name)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    // With flows of the new providers pending, the down keeps the widened checks.
    sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
    assert!(
        constraint("oauth_pending_provider_check")
            .await
            .contains("tiktok")
    );
    assert!(
        constraint("oauth_pending_app_check")
            .await
            .contains("linkedin")
    );
    // Once none remains, it narrows them back.
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    sqlx::query("delete from oauth_pending where provider in ('tiktok', 'linkedin')")
        .execute(p.conn())
        .await
        .unwrap();
    p.commit().await.unwrap();
    sqlx::raw_sql(&down).execute(&db.pool).await.unwrap();
    assert!(
        !constraint("oauth_pending_provider_check")
            .await
            .contains("tiktok")
    );
    assert!(
        !constraint("oauth_pending_app_check")
            .await
            .contains("linkedin")
    );
}

#[tokio::test]
async fn oauth_pending_lock_waits_and_a_reconnection_names_its_own_capability() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner_a) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let page = capability(a, "facebook_page", "page-1", T0);
    let theirs = capability(b, "facebook_page", "page-1", T0);
    insert_capability(&uow, &page).await;
    insert_capability(&uow, &theirs).await;

    let renewal = OAuthPendingRow {
        capability_id: Some(page.id),
        ..pending(a, owner_a, "hash-renew", T0 + Duration::minutes(10))
    };
    let mut t = uow.tenant(a).await.unwrap();
    t.oauth_pending().insert(renewal.clone()).await.unwrap();
    t.commit().await.unwrap();

    // Read back by its id, the capability included; never across workspaces.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending().lock(renewal.id).await.unwrap(),
        Some(renewal.clone())
    );
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-renew")
            .await
            .unwrap(),
        Some(renewal.clone())
    );
    assert_eq!(
        t.oauth_pending()
            .lock(OAuthPendingId::new_v7())
            .await
            .unwrap(),
        None
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.oauth_pending().lock(renewal.id).await.unwrap(), None);
    drop(t);

    // Another workspace's capability, or none at all, is NOT_FOUND, before the composite key
    // would refuse it.
    for capability in [theirs.id, CapabilityId::new_v7()] {
        let mut t = uow.tenant(a).await.unwrap();
        let row = OAuthPendingRow {
            capability_id: Some(capability),
            ..pending(a, owner_a, "hash-other", T0)
        };
        assert_eq!(
            code(t.oauth_pending().insert(row).await),
            ErrorCode::NotFound
        );
    }

    // A second `lock` waits for the bundle holding the first, then sees what it committed:
    // nothing, once it deleted the flow.
    let mut holder = uow.tenant(a).await.unwrap();
    assert!(
        holder
            .oauth_pending()
            .lock(renewal.id)
            .await
            .unwrap()
            .is_some()
    );
    let waiter = {
        let uow = uow.clone();
        let id = renewal.id;
        tokio::spawn(async move {
            let mut t = uow.tenant(a).await.unwrap();
            t.oauth_pending().lock(id).await.unwrap()
        })
    };
    wait_for_a_lock_waiter(&db).await;
    assert!(!waiter.is_finished(), "the second lock did not wait");
    holder.oauth_pending().delete(renewal.id).await.unwrap();
    holder.commit().await.unwrap();
    assert_eq!(waiter.await.unwrap(), None);
}

// ---------------------------------------------------------------------------------------------
// Probe runs
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_runs_append_only() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let page = capability(a, "facebook_page", "page-1", T0);
    let other = capability(a, "instagram", "ig-1", T0);
    let theirs = capability(b, "facebook_page", "page-1", T0);
    for c in [&page, &other, &theirs] {
        insert_capability(&uow, c).await;
    }

    let first = probe_run(&page, T0 + Duration::minutes(1), true);
    let second = probe_run(&page, T0 + Duration::minutes(2), false);
    let elsewhere = probe_run(&other, T0 + Duration::minutes(3), true);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.probe_runs().latest(page.id).await.unwrap(), None);
    // Appended out of order: reads order by time.
    for run in [&second, &first, &elsewhere] {
        assert_eq!(t.probe_runs().append(run.clone()).await.unwrap(), run.id);
    }
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.probe_runs().latest(page.id).await.unwrap(),
        Some(second.clone())
    );
    assert_eq!(
        t.probe_runs().list(page.id, 10).await.unwrap(),
        vec![second.clone(), first.clone()]
    );
    assert_eq!(
        t.probe_runs().list(page.id, 1).await.unwrap(),
        vec![second.clone()]
    );
    assert_eq!(
        t.probe_runs()
            .list(CapabilityId::new_v7(), 10)
            .await
            .unwrap(),
        vec![]
    );
    // A taken id is a conflict; another workspace's capability is not found.
    assert_eq!(
        code(t.probe_runs().append(first.clone()).await),
        ErrorCode::Conflict
    );
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.probe_runs()
                .append(ProbeRun {
                    workspace_id: a,
                    ..probe_run(&theirs, T0, true)
                })
                .await
        ),
        ErrorCode::NotFound
    );
    // A bad error kind on a taken id breaks the check constraint first.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.probe_runs()
                .append(ProbeRun {
                    error_kind: Some("oops".into()),
                    ..first.clone()
                })
                .await
        ),
        ErrorCode::Internal
    );
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.probe_runs().latest(page.id).await.unwrap(), None);
    drop(t);

    // The log is never changed or deleted, even by its own workspace.
    for statement in [
        "update probe_runs set ok = true where workspace_id = $1",
        "delete from probe_runs where workspace_id = $1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    // An error kind off the taxonomy and a negative latency break check constraints.
    for statement in [
        "insert into probe_runs (id, workspace_id, capability_id, at, ok, error_kind, \
         latency_ms, facts) values ($1, $2, $3, now(), false, 'oops', 1, '{}')",
        "insert into probe_runs (id, workspace_id, capability_id, at, ok, error_kind, \
         latency_ms, facts) values ($1, $2, $3, now(), true, null, -1, '{}')",
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(Uuid::now_v7())
            .bind(a.as_uuid())
            .bind(page.id.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(
            db_err.code().as_deref(),
            Some("23514"),
            "{statement}: {db_err}"
        );
        tx.rollback().await.unwrap();
    }
}

// ---------------------------------------------------------------------------------------------
// The schema and row-level security
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn connector_rows_reference_capabilities_of_their_own_workspace() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let theirs = capability(b, "facebook_page", "page-1", T0);
    insert_capability(&uow, &theirs).await;

    // Even platform-wide, where row-level security lets any workspace through, a row of `a`
    // cannot reference a capability of `b`.
    for statement in [
        "insert into inbound_events (id, workspace_id, provider, capability_id, external_id, \
         kind, payload, received_at) values ($1, $2, 'meta', $3, 'mid.1', 'message', '{}', now())",
        "insert into probe_runs (id, workspace_id, capability_id, at, ok, latency_ms, facts) \
         values ($1, $2, $3, now(), true, 1, '{}')",
    ] {
        let mut p = PlatformTx::begin(&db.pool).await.unwrap();
        let err = sqlx::query(statement)
            .bind(Uuid::now_v7())
            .bind(a.as_uuid())
            .bind(theirs.id.as_uuid())
            .execute(p.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(
            db_err.code().as_deref(),
            Some("23503"),
            "{statement}: {db_err}"
        );
        p.rollback().await.unwrap();
    }
    // A provider off the list is refused.
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query(
        "insert into inbound_events (id, workspace_id, provider, external_id, kind, payload, \
         received_at) values ($1, $2, 'myspace', 'mid.1', 'message', '{}', now())",
    )
    .bind(Uuid::now_v7())
    .bind(a.as_uuid())
    .execute(p.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("23514"), "{db_err}");
    p.rollback().await.unwrap();
}

#[tokio::test]
async fn connector_tables_are_hidden_without_their_workspace_in_scope() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, owner) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let page = capability(a, "facebook_page", "page-1", T0);
    insert_capability(&uow, &page).await;
    let mut t = uow.tenant(a).await.unwrap();
    t.inbound_events()
        .insert_if_new(
            event(a, Provider::Meta, "mid.1", Some(page.id), T0),
            Some(b"raw".to_vec()),
        )
        .await
        .unwrap();
    t.oauth_pending()
        .insert(pending(a, owner, "hash-a", T0 + Duration::minutes(10)))
        .await
        .unwrap();
    t.probe_runs()
        .append(probe_run(&page, T0, true))
        .await
        .unwrap();
    t.commit().await.unwrap();

    for table in ["inbound_events", "oauth_pending", "probe_runs"] {
        let count = format!("select count(*) from {table}");
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is visible without a workspace in scope");

        let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} shows another workspace's rows");
        tx.rollback().await.unwrap();

        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 1, "{table} hides its own workspace's rows");
        tx.rollback().await.unwrap();
    }

    // Workspace `b`'s repos see none of `a`'s rows either.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.inbound_events().list_pending(10).await.unwrap(), vec![]);
    assert_eq!(
        t.inbound_events()
            .purge_raw_before(T0 + Duration::days(1))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-a")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        t.oauth_pending()
            .purge_expired(T0 + Duration::days(1))
            .await
            .unwrap(),
        0
    );
    assert_eq!(t.probe_runs().latest(page.id).await.unwrap(), None);
    assert_eq!(t.probe_runs().list(page.id, 10).await.unwrap(), vec![]);
}

// ---------------------------------------------------------------------------------------------
// Platform-wide lookup by external account
// ---------------------------------------------------------------------------------------------

/// Inserts `c` with sealed credentials and, when `verify`, marks it verified by a probe (status
/// `Verified`, `last_verified_at` set): a capability connected through the provider.
async fn connect(uow: &PgUnitOfWork, c: &Capability, verify: bool) {
    let mut t = uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities()
        .insert(c.clone(), Some(b"sealed-credential".to_vec()))
        .await
        .unwrap();
    if verify {
        // As a probe that proved the account leaves it: verified, with a verification time.
        t.capabilities()
            .update(Capability {
                status: StoredStatus::Verified,
                last_verified_at: Some(c.created_at),
                ..c.clone()
            })
            .await
            .unwrap();
    }
    t.commit().await.unwrap();
}

async fn set_status(uow: &PgUnitOfWork, c: &Capability, status: StoredStatus) {
    let mut t = uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities()
        .set_status(c.id, status, c.created_at + Duration::hours(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
}

/// The id of the capability the platform-wide lookup answers.
async fn routed(uow: &PgUnitOfWork, kinds: &[&str], external_id: &str) -> Option<CapabilityId> {
    let mut p = uow.platform().await.unwrap();
    p.capability_by_external(kinds, external_id)
        .await
        .unwrap()
        .map(|c| c.id)
}

#[tokio::test]
async fn capability_by_external_finds_live_capability_across_workspaces() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let meta: &[&str] = Provider::Meta.kinds();

    // `a` connected page-1 through the provider: sealed credentials, verified.
    let victim = capability(a, "facebook_page", "page-1", T0);
    connect(&uow, &victim, true).await;
    let mut p = uow.platform().await.unwrap();
    let found = p
        .capability_by_external(meta, "page-1")
        .await
        .unwrap()
        .expect("a's connected capability");
    assert_eq!((found.id, found.workspace_id), (victim.id, a));
    assert!(found.has_sealed_config);
    drop(p);

    // Newer holders in `b` that never proved control take nothing: one declared only (page ids
    // are public), one sealed but not verified, one verified on an agent's word alone (no
    // credentials).
    let declared = capability(b, "facebook_page", "page-1", T0 + Duration::days(1));
    insert_capability(&uow, &declared).await;
    let unverified = capability(b, "messenger", "page-1", T0 + Duration::days(2));
    connect(&uow, &unverified, false).await;
    let attested = capability(b, "instagram_dm", "page-1", T0 + Duration::days(3));
    insert_capability(&uow, &attested).await;
    set_status(&uow, &attested, StoredStatus::Verified).await;
    assert_eq!(routed(&uow, meta, "page-1").await, Some(victim.id));

    // A declared-only holder alone is no holder.
    let lonely = capability(b, "facebook_page", "page-2", T0);
    insert_capability(&uow, &lonely).await;
    assert_eq!(routed(&uow, meta, "page-2").await, None);

    // Only the kinds asked for: a connected NetGSM line holding the same id is not a Meta one.
    let sms = capability(a, "sms_line", "page-1", T0 + Duration::days(4));
    connect(&uow, &sms, true).await;
    assert_eq!(routed(&uow, &["sms_line"], "page-1").await, Some(sms.id));
    assert_eq!(routed(&uow, &["x"], "page-1").await, None);
    assert_eq!(routed(&uow, &[], "page-1").await, None);
    assert_eq!(routed(&uow, meta, "page-9").await, None);

    // An unreachable connection (an expired token) keeps its events, so they are there when the
    // owner reconnects; once retired, nobody holds the account: an event for it is routed
    // nowhere, not to `b`.
    set_status(&uow, &victim, StoredStatus::Unreachable).await;
    assert_eq!(routed(&uow, meta, "page-1").await, Some(victim.id));
    set_status(&uow, &victim, StoredStatus::Retired).await;
    assert_eq!(routed(&uow, meta, "page-1").await, None);

    // A verified connection wins over an unreachable one, even an older one; among holders of the
    // same standing the newest answers.
    let healthy = capability(a, "facebook_page", "page-4", T0);
    let expired = capability(b, "facebook_page", "page-4", T0 + Duration::days(1));
    connect(&uow, &healthy, true).await;
    connect(&uow, &expired, true).await;
    set_status(&uow, &expired, StoredStatus::Unreachable).await;
    assert_eq!(routed(&uow, meta, "page-4").await, Some(healthy.id));
    set_status(&uow, &healthy, StoredStatus::Unreachable).await;
    assert_eq!(routed(&uow, meta, "page-4").await, Some(expired.id));

    // Two workspaces that both connected the account: the most recently connected one answers.
    let first = capability(a, "facebook_page", "page-3", T0);
    let second = capability(b, "facebook_page", "page-3", T0 + Duration::minutes(5));
    connect(&uow, &second, true).await;
    connect(&uow, &first, true).await;
    assert_eq!(routed(&uow, meta, "page-3").await, Some(second.id));
}

/// Only a binding proven at least once routes events: a credential pasted for someone else's
/// account (sealed, its probe failed or reached another account, so `unreachable` and never
/// verified) takes nothing, while a connection verified once and unreachable since keeps its
/// events.
#[tokio::test]
async fn capability_by_external_needs_an_account_proven_once() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let meta: &[&str] = Provider::Meta.kinds();

    let pasted = capability(b, "facebook_page", "page-5", T0 + Duration::days(1));
    connect(&uow, &pasted, false).await;
    set_status(&uow, &pasted, StoredStatus::Unreachable).await;
    assert_eq!(routed(&uow, meta, "page-5").await, None);
    // Nor does a stored status of verified without a verification time.
    let stamped = capability(b, "messenger", "page-5", T0 + Duration::days(2));
    connect(&uow, &stamped, false).await;
    set_status(&uow, &stamped, StoredStatus::Verified).await;
    assert_eq!(routed(&uow, meta, "page-5").await, None);

    // The owner's connection, verified once and unreachable since, is the one that answers,
    // although the others are newer.
    let owned = capability(a, "facebook_page", "page-5", T0);
    connect(&uow, &owned, true).await;
    set_status(&uow, &owned, StoredStatus::Unreachable).await;
    assert_eq!(routed(&uow, meta, "page-5").await, Some(owned.id));
}
