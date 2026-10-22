//! Inbound events, pending OAuth flows and probe runs against a real database: the repos'
//! contracts, deduplication of replayed webhooks (Review Focus 2), the append-only probe log, the
//! column guard on inbound events (only the raw body and the processing time change), workspace
//! scoping, and the platform-wide lookup of a live capability by its external account.

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{OAuthPendingId, OAuthPendingRow, ProbeRun, ProbeRunId, UnitOfWork};
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
        state_hash: state_hash.into(),
        started_by: user,
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

    // Every other column is guarded, even against its own workspace; the processing time may be
    // set, and the raw body may only be removed.
    for statement in [
        "update inbound_events set payload = '{}' where workspace_id = $1 and id = $2",
        "update inbound_events set kind = 'status' where workspace_id = $1 and id = $2",
        "update inbound_events set external_id = 'other' where workspace_id = $1 and id = $2",
        "update inbound_events set provider = 'x' where workspace_id = $1 and id = $2",
        "update inbound_events set received_at = now() where workspace_id = $1 and id = $2",
        "update inbound_events set capability_id = id where workspace_id = $1 and id = $2",
        "update inbound_events set raw = 'replaced'::bytea where workspace_id = $1 and id = $2",
        "delete from inbound_events where workspace_id = $1 and id = $2",
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .bind(fresh.id.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("inbound_events"),
            "{statement}: {err}"
        );
        tx.rollback().await.unwrap();
    }
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

#[tokio::test]
async fn capability_by_external_finds_live_capability_across_workspaces() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let meta_kinds: &[&str] = Provider::Meta.kinds();

    // `a` held page-1 and retired it; `b` connected it later and holds it live.
    let retired = capability(a, "facebook_page", "page-1", T0);
    let live = capability(b, "messenger", "page-1", T0 + Duration::days(1));
    let wa = capability(a, "whatsapp_cloud", "phone-1", T0);
    let sms = capability(a, "sms_line", "page-1", T0 + Duration::days(2));
    for c in [&retired, &live, &wa, &sms] {
        insert_capability(&uow, c).await;
    }
    let mut t = uow.tenant(a).await.unwrap();
    t.capabilities()
        .set_status(retired.id, StoredStatus::Retired, T0 + Duration::hours(1))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut p = uow.platform().await.unwrap();
    let found = p
        .capability_by_external(meta_kinds, "page-1")
        .await
        .unwrap()
        .expect("b's live capability");
    assert_eq!(found.id, live.id);
    assert_eq!(found.workspace_id, b);
    assert_eq!(
        p.capability_by_external(meta_kinds, "phone-1")
            .await
            .unwrap()
            .map(|c| c.id),
        Some(wa.id)
    );
    // Only the kinds asked for: NetGSM's capability holding the same id is not a Meta one.
    assert_eq!(
        p.capability_by_external(&["sms_line"], "page-1")
            .await
            .unwrap()
            .map(|c| c.id),
        Some(sms.id)
    );
    assert_eq!(
        p.capability_by_external(&["x"], "page-1").await.unwrap(),
        None
    );
    assert_eq!(p.capability_by_external(&[], "page-1").await.unwrap(), None);
    assert_eq!(
        p.capability_by_external(meta_kinds, "page-2")
            .await
            .unwrap(),
        None
    );
    drop(p);

    // Once `b` retires it too, nobody holds it: an event for it is routed nowhere.
    let mut t = uow.tenant(b).await.unwrap();
    t.capabilities()
        .set_status(live.id, StoredStatus::Retired, T0 + Duration::days(3))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.capability_by_external(meta_kinds, "page-1")
            .await
            .unwrap(),
        None
    );
    drop(p);

    // Two workspaces holding the same account live: the most recently connected one answers.
    let first = capability(a, "facebook_page", "page-3", T0);
    let second = capability(b, "facebook_page", "page-3", T0 + Duration::minutes(5));
    insert_capability(&uow, &second).await;
    insert_capability(&uow, &first).await;
    let mut p = uow.platform().await.unwrap();
    assert_eq!(
        p.capability_by_external(meta_kinds, "page-3")
            .await
            .unwrap()
            .map(|c| c.id),
        Some(second.id)
    );
}
