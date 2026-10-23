//! The in-memory connector repos keep the contracts `jt_pg` keeps (a replayed event is ignored,
//! purges count what they removed, probe runs read newest first, a state hash is unique across
//! workspaces, the platform-wide lookup finds only live capabilities), and the scripted connector
//! fakes answer what they were scripted with, in order, recording every call.

use std::sync::Arc;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::connectors::{
    AdInsights, AdSet, Asset, ConsentRow, DeliveryState, DeliveryStatus, InboundEventDraft,
    OAuthApp, PostMetrics, PublishReceipt, PublishRequest, SendReceipt, Url, XApp,
};
use jt_app::ports::{
    EventOrder, EventQuery, OAuthPendingId, OAuthPendingRow, ProbeRun, ProbeRunId, SecretBox,
    UserRow,
};
use jt_app::usecases::Deps;
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{
    ConnectorError, Credential, EventKind, InboundEvent, InboundEventId, ProbeResult, Provider,
};
use jt_tenancy::{Email, UserId, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FakeAppConfig, InMemoryUow, OAuthCall, PlainSecretBox,
    ScriptedConnector, ScriptedOAuth, ScriptedRegistry, deps,
};
use serde_json::{Value, json};
use time::macros::date;
use time::{Duration, OffsetDateTime};

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn setup() -> (InMemoryUow, Deps) {
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    (uow, deps)
}

/// Creates a workspace and its user, committed.
async fn workspace(deps: &Deps, slug: &str) -> (WorkspaceId, UserId) {
    let (ws, user) = (WorkspaceId::new_v7(), UserId::new_v7());
    let mut u = deps.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{slug}@example.com")).unwrap(),
            password_hash: "plain:pw".into(),
            display_name: slug.into(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    u.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, FIXED_NOW)
        .await
        .unwrap();
    u.commit().await.unwrap();
    (ws, user)
}

fn capability(ws: WorkspaceId, kind: &str, external_id: &str, at: OffsetDateTime) -> Capability {
    Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {external_id}"),
            external_id: Some(external_id.into()),
            ..NewCapability::default()
        },
        at,
    )
    .unwrap()
}

async fn insert_capability(deps: &Deps, c: &Capability) {
    let mut t = deps.uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
}

fn event(
    ws: WorkspaceId,
    provider: Provider,
    external_id: &str,
    at: OffsetDateTime,
) -> InboundEvent {
    InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws,
        provider,
        capability_id: None,
        external_id: external_id.into(),
        kind: EventKind::Message,
        payload: json!({ "text": "Merhaba" }),
        received_at: at,
        processed_at: None,
    }
}

fn pending(
    ws: WorkspaceId,
    user: UserId,
    hash: &str,
    expires_at: OffsetDateTime,
) -> OAuthPendingRow {
    OAuthPendingRow {
        id: OAuthPendingId::new_v7(),
        workspace_id: ws,
        provider: Provider::Meta,
        kind_key: "facebook_page".into(),
        state_hash: hash.into(),
        started_by: user,
        capability_id: None,
        pkce_verifier_sealed: None,
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
        error_kind: (!ok).then(|| "transient".to_owned()),
        latency_ms: 80,
        facts: json!({}),
    }
}

fn token() -> Credential {
    Credential::OAuth {
        access_token: "tok-1".into(),
        refresh_token: Some("ref-1".into()),
        expires_at: None,
        scopes: vec!["tweet.write".into()],
    }
}

// ---------------------------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_inbound_event_is_ignored() {
    let (uow, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let first = event(a, Provider::Meta, "wamid.1", FIXED_NOW);
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events()
            .insert_if_new(first.clone(), Some(b"body".to_vec()))
            .await
            .unwrap(),
        Some(first.id)
    );
    // A replay in the same bundle is ignored, and the bundle still commits.
    let replay = event(
        a,
        Provider::Meta,
        "wamid.1",
        FIXED_NOW + Duration::seconds(1),
    );
    assert_eq!(
        t.inbound_events()
            .insert_if_new(replay, None)
            .await
            .unwrap(),
        None
    );
    let sms = event(a, Provider::Netgsm, "wamid.1", FIXED_NOW);
    assert_eq!(
        t.inbound_events()
            .insert_if_new(sms.clone(), None)
            .await
            .unwrap(),
        Some(sms.id)
    );
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(b).await.unwrap();
    let theirs = event(b, Provider::Meta, "wamid.1", FIXED_NOW);
    assert_eq!(
        t.inbound_events()
            .insert_if_new(theirs.clone(), None)
            .await
            .unwrap(),
        Some(theirs.id)
    );
    t.commit().await.unwrap();
    // A replay in a later bundle too.
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events()
            .insert_if_new(event(a, Provider::Meta, "wamid.1", FIXED_NOW), None)
            .await
            .unwrap(),
        None
    );
    t.commit().await.unwrap();
    assert_eq!(uow.snapshot().inbound_events.len(), 3);

    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.inbound_events().list_pending(10).await.unwrap(),
        vec![first.clone(), sms.clone()]
    );
    // A taken id is a conflict; another workspace's row a programming error; another
    // workspace's capability not found.
    assert_eq!(
        code(
            t.inbound_events()
                .insert_if_new(
                    InboundEvent {
                        external_id: "wamid.2".into(),
                        ..first.clone()
                    },
                    None
                )
                .await
        ),
        ErrorCode::Conflict
    );
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.inbound_events()
                .insert_if_new(event(b, Provider::Meta, "wamid.3", FIXED_NOW), None)
                .await
        ),
        ErrorCode::Internal
    );
    let foreign = capability(b, "whatsapp_cloud", "phone-9", FIXED_NOW);
    insert_capability(&deps, &foreign).await;
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.inbound_events()
                .insert_if_new(
                    InboundEvent {
                        capability_id: Some(foreign.id),
                        ..event(a, Provider::Meta, "wamid.4", FIXED_NOW)
                    },
                    None
                )
                .await
        ),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn pending_events_order_processing_and_raw_purge() {
    let (uow, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let late = event(a, Provider::Meta, "mid.2", FIXED_NOW + Duration::days(40));
    let early = event(a, Provider::Meta, "mid.1", FIXED_NOW);
    let bare = event(a, Provider::Meta, "mid.3", FIXED_NOW);
    let mut t = deps.uow.tenant(a).await.unwrap();
    t.inbound_events()
        .insert_if_new(late.clone(), Some(b"late".to_vec()))
        .await
        .unwrap();
    t.inbound_events()
        .insert_if_new(early.clone(), Some(b"early".to_vec()))
        .await
        .unwrap();
    t.inbound_events()
        .insert_if_new(bare.clone(), None)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(b).await.unwrap();
    t.inbound_events()
        .insert_if_new(
            event(b, Provider::Meta, "mid.1", FIXED_NOW),
            Some(b"b".to_vec()),
        )
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(a).await.unwrap();
    // Oldest first, then by id; a limit of 0 reads as 1.
    let mut same_instant = vec![early.clone(), bare.clone()];
    same_instant.sort_by_key(|e| e.id);
    let mut expected = same_instant.clone();
    expected.push(late.clone());
    assert_eq!(t.inbound_events().list_pending(10).await.unwrap(), expected);
    assert_eq!(t.inbound_events().list_pending(0).await.unwrap().len(), 1);

    let at = FIXED_NOW + Duration::hours(1);
    assert!(
        t.inbound_events()
            .mark_processed(early.id, at)
            .await
            .unwrap()
    );
    assert!(
        !t.inbound_events()
            .mark_processed(early.id, at + Duration::hours(1))
            .await
            .unwrap()
    );
    assert_eq!(
        t.inbound_events()
            .purge_raw_before(FIXED_NOW + Duration::days(10))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.inbound_events()
            .purge_raw_before(FIXED_NOW + Duration::days(10))
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();

    let state = uow.snapshot();
    let stored = |id: InboundEventId| {
        state
            .inbound_events
            .iter()
            .find(|s| s.event.id == id)
            .cloned()
            .expect("the event")
    };
    assert_eq!(stored(early.id).event.processed_at, Some(at));
    assert_eq!(stored(early.id).raw, None);
    assert_eq!(stored(late.id).raw, Some(b"late".to_vec()));
    // The other workspace's body stays.
    assert!(
        state
            .inbound_events
            .iter()
            .any(|s| s.event.workspace_id == b && s.raw.is_some())
    );
    let mut t = deps.uow.tenant(a).await.unwrap();
    let mut rest = vec![bare.clone(), late.clone()];
    rest.sort_by_key(|e| (e.received_at, e.id));
    assert_eq!(t.inbound_events().list_pending(10).await.unwrap(), rest);
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

/// An event query over every event in `order`, at most 50.
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

/// As `jt_pg`'s `events_are_listed_by_query_in_either_order_and_counted`.
#[tokio::test]
async fn events_are_listed_by_query_in_either_order_and_counted() {
    let (_, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let e1 = event(a, Provider::Meta, "mid.1", FIXED_NOW);
    let e2 = InboundEvent {
        kind: EventKind::Consent,
        ..event(
            a,
            Provider::Netgsm,
            "netgsm-iys:1",
            FIXED_NOW + Duration::minutes(1),
        )
    };
    let e3 = InboundEvent {
        kind: EventKind::Status,
        ..event(
            a,
            Provider::Meta,
            "mid.1:delivered",
            FIXED_NOW + Duration::minutes(2),
        )
    };
    let e4 = InboundEvent {
        kind: EventKind::Unknown("reaction".into()),
        ..event(
            a,
            Provider::Meta,
            "reaction.1",
            FIXED_NOW + Duration::minutes(3),
        )
    };
    let mut twins = [
        event(a, Provider::X, "x.1", FIXED_NOW + Duration::minutes(5)),
        event(a, Provider::X, "x.2", FIXED_NOW + Duration::minutes(5)),
    ];
    twins.sort_by_key(|e| e.id);
    let [t1, t2] = twins.clone();
    let mut t = deps.uow.tenant(a).await.unwrap();
    for e in [&e4, &e1, &t2, &e3, &e2, &t1] {
        t.inbound_events()
            .insert_if_new(e.clone(), Some(b"raw".to_vec()))
            .await
            .unwrap();
    }
    t.inbound_events()
        .mark_processed(e2.id, FIXED_NOW + Duration::hours(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(b).await.unwrap();
    t.inbound_events()
        .insert_if_new(event(b, Provider::Meta, "mid.b", FIXED_NOW), None)
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(a).await.unwrap();
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
    let read = t.inbound_events().list(query(OLDEST)).await.unwrap();
    assert_eq!(read[0], e1);
    assert_eq!(read[1].processed_at, Some(FIXED_NOW + Duration::hours(1)));

    assert_eq!(t.inbound_events().count_pending(1_000).await.unwrap(), 5);
    assert_eq!(t.inbound_events().count_pending(3).await.unwrap(), 3);
    assert_eq!(t.inbound_events().count_pending(0).await.unwrap(), 0);
    drop(t);
    let mut t = deps.uow.tenant(b).await.unwrap();
    assert_eq!(t.inbound_events().count_pending(1_000).await.unwrap(), 1);
}

#[tokio::test]
async fn oauth_pending_state_hash_is_unique_and_purgeable() {
    let (_, deps) = setup();
    let (a, owner_a) = workspace(&deps, "a").await;
    let (b, owner_b) = workspace(&deps, "b").await;
    let soon = pending(a, owner_a, "hash-soon", FIXED_NOW + Duration::minutes(10));
    let later = pending(a, owner_a, "hash-later", FIXED_NOW + Duration::minutes(30));
    let theirs = pending(b, owner_b, "hash-theirs", FIXED_NOW + Duration::minutes(10));
    let mut t = deps.uow.tenant(a).await.unwrap();
    t.oauth_pending().insert(soon.clone()).await.unwrap();
    t.oauth_pending().insert(later.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(b).await.unwrap();
    t.oauth_pending().insert(theirs.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(a).await.unwrap();
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
        let mut t = deps.uow.tenant(a).await.unwrap();
        assert_eq!(
            code(t.oauth_pending().insert(row).await),
            ErrorCode::Conflict
        );
    }
    // A taken state hash is a conflict even when the starter is unknown too, as in Postgres.
    let mut t = deps.uow.tenant(a).await.unwrap();
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
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .insert(pending(b, owner_b, "hash-x", FIXED_NOW))
                .await
        ),
        ErrorCode::Internal
    );
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .insert(pending(a, UserId::new_v7(), "hash-y", FIXED_NOW))
                .await
        ),
        ErrorCode::NotFound
    );

    let mut t = deps.uow.tenant(a).await.unwrap();
    t.oauth_pending()
        .set_assets(
            soon.id,
            b"sealed".to_vec(),
            json!([{ "external_id": "p-1" }]),
        )
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    let completed = t
        .oauth_pending()
        .find_by_state_hash("hash-soon")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.assets_sealed, Some(b"sealed".to_vec()));
    assert_eq!(completed.assets_public, json!([{ "external_id": "p-1" }]));
    let mut t = deps.uow.tenant(b).await.unwrap();
    assert_eq!(
        code(
            t.oauth_pending()
                .set_assets(soon.id, vec![], json!([]))
                .await
        ),
        ErrorCode::NotFound
    );

    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .purge_expired(FIXED_NOW + Duration::minutes(10))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        t.oauth_pending()
            .purge_expired(FIXED_NOW + Duration::minutes(11))
            .await
            .unwrap(),
        1
    );
    t.oauth_pending().delete(later.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.oauth_pending().delete(later.id).await),
        ErrorCode::NotFound
    );
    let mut t = deps.uow.tenant(b).await.unwrap();
    assert_eq!(
        t.oauth_pending()
            .find_by_state_hash("hash-theirs")
            .await
            .unwrap(),
        Some(theirs)
    );
}

#[tokio::test]
async fn oauth_pending_locks_by_id_and_binds_a_reconnection_to_its_own_capability() {
    let (_, deps) = setup();
    let (a, owner_a) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let page = capability(a, "facebook_page", "page-1", FIXED_NOW);
    let theirs = capability(b, "facebook_page", "page-1", FIXED_NOW);
    insert_capability(&deps, &page).await;
    insert_capability(&deps, &theirs).await;

    let renewal = OAuthPendingRow {
        capability_id: Some(page.id),
        ..pending(a, owner_a, "hash-renew", FIXED_NOW + Duration::minutes(10))
    };
    let mut t = deps.uow.tenant(a).await.unwrap();
    t.oauth_pending().insert(renewal.clone()).await.unwrap();
    t.commit().await.unwrap();

    // `lock` reads the flow by its id (the fakes run one bundle at a time, so it waits for no
    // one), and only in its own workspace.
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.oauth_pending().lock(renewal.id).await.unwrap(),
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
    let mut t = deps.uow.tenant(b).await.unwrap();
    assert_eq!(t.oauth_pending().lock(renewal.id).await.unwrap(), None);
    drop(t);

    // A reconnection names a capability of its own workspace, else NOT_FOUND.
    for capability in [theirs.id, CapabilityId::new_v7()] {
        let mut t = deps.uow.tenant(a).await.unwrap();
        let row = OAuthPendingRow {
            capability_id: Some(capability),
            ..pending(a, owner_a, "hash-other", FIXED_NOW)
        };
        assert_eq!(
            code(t.oauth_pending().insert(row).await),
            ErrorCode::NotFound
        );
    }
}

#[tokio::test]
async fn probe_runs_read_newest_first_and_stay_in_their_workspace() {
    let (_, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let page = capability(a, "facebook_page", "page-1", FIXED_NOW);
    let theirs = capability(b, "facebook_page", "page-1", FIXED_NOW);
    insert_capability(&deps, &page).await;
    insert_capability(&deps, &theirs).await;
    let first = probe_run(&page, FIXED_NOW + Duration::minutes(1), true);
    let second = probe_run(&page, FIXED_NOW + Duration::minutes(2), false);
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(t.probe_runs().latest(page.id).await.unwrap(), None);
    t.probe_runs().append(second.clone()).await.unwrap();
    assert_eq!(
        t.probe_runs().append(first.clone()).await.unwrap(),
        first.id
    );
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.probe_runs().latest(page.id).await.unwrap(),
        Some(second.clone())
    );
    assert_eq!(
        t.probe_runs().list(page.id, 10).await.unwrap(),
        vec![second.clone(), first.clone()]
    );
    assert_eq!(
        t.probe_runs().list(page.id, 0).await.unwrap(),
        vec![second.clone()]
    );
    assert_eq!(
        code(t.probe_runs().append(first.clone()).await),
        ErrorCode::Conflict
    );
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.probe_runs()
                .append(ProbeRun {
                    workspace_id: a,
                    ..probe_run(&theirs, FIXED_NOW, true)
                })
                .await
        ),
        ErrorCode::NotFound
    );
    // An error kind off the taxonomy breaks the check constraint, which Postgres checks before
    // it looks for a taken id.
    for run in [
        ProbeRun {
            error_kind: Some("oops".into()),
            ..probe_run(&page, FIXED_NOW, false)
        },
        ProbeRun {
            error_kind: Some("oops".into()),
            ..first.clone()
        },
    ] {
        let mut t = deps.uow.tenant(a).await.unwrap();
        assert_eq!(code(t.probe_runs().append(run).await), ErrorCode::Internal);
    }
    let mut t = deps.uow.tenant(b).await.unwrap();
    assert_eq!(t.probe_runs().latest(page.id).await.unwrap(), None);
}

/// Inserts `c` with sealed credentials and, when `verify`, sets its stored status to `Verified`.
async fn connect(deps: &Deps, c: &Capability, verify: bool) {
    let mut t = deps.uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities()
        .insert(c.clone(), Some(b"sealed".to_vec()))
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

async fn set_status(deps: &Deps, c: &Capability, status: StoredStatus) {
    let mut t = deps.uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities()
        .set_status(c.id, status, c.created_at)
        .await
        .unwrap();
    t.commit().await.unwrap();
}

async fn routed(deps: &Deps, kinds: &[&str], external_id: &str) -> Option<CapabilityId> {
    let mut p = deps.uow.platform().await.unwrap();
    p.capability_by_external(kinds, external_id)
        .await
        .unwrap()
        .map(|c| c.id)
}

#[tokio::test]
async fn capability_by_external_finds_live_capability_across_workspaces() {
    let (_, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let meta: &[&str] = Provider::Meta.kinds();

    let victim = capability(a, "facebook_page", "page-1", FIXED_NOW);
    connect(&deps, &victim, true).await;
    let mut p = deps.uow.platform().await.unwrap();
    let found = p
        .capability_by_external(meta, "page-1")
        .await
        .unwrap()
        .expect("a's connected capability");
    assert_eq!((found.id, found.workspace_id), (victim.id, a));
    assert!(found.has_sealed_config);
    drop(p);

    // Newer holders that never proved control take nothing.
    let declared = capability(b, "facebook_page", "page-1", FIXED_NOW + Duration::days(1));
    insert_capability(&deps, &declared).await;
    let unverified = capability(b, "messenger", "page-1", FIXED_NOW + Duration::days(2));
    connect(&deps, &unverified, false).await;
    let attested = capability(b, "instagram_dm", "page-1", FIXED_NOW + Duration::days(3));
    insert_capability(&deps, &attested).await;
    set_status(&deps, &attested, StoredStatus::Verified).await;
    assert_eq!(routed(&deps, meta, "page-1").await, Some(victim.id));

    let lonely = capability(b, "facebook_page", "page-2", FIXED_NOW);
    insert_capability(&deps, &lonely).await;
    assert_eq!(routed(&deps, meta, "page-2").await, None);

    let sms = capability(a, "sms_line", "page-1", FIXED_NOW + Duration::days(4));
    connect(&deps, &sms, true).await;
    assert_eq!(routed(&deps, &["sms_line"], "page-1").await, Some(sms.id));
    assert_eq!(routed(&deps, &["x"], "page-1").await, None);
    assert_eq!(routed(&deps, meta, "page-9").await, None);

    // Unreachable keeps its events; retired routes nowhere.
    set_status(&deps, &victim, StoredStatus::Unreachable).await;
    assert_eq!(routed(&deps, meta, "page-1").await, Some(victim.id));
    set_status(&deps, &victim, StoredStatus::Retired).await;
    assert_eq!(routed(&deps, meta, "page-1").await, None);

    // Verified wins over unreachable, even when older; then the newest.
    let healthy = capability(a, "facebook_page", "page-4", FIXED_NOW);
    let expired = capability(b, "facebook_page", "page-4", FIXED_NOW + Duration::days(1));
    connect(&deps, &healthy, true).await;
    connect(&deps, &expired, true).await;
    set_status(&deps, &expired, StoredStatus::Unreachable).await;
    assert_eq!(routed(&deps, meta, "page-4").await, Some(healthy.id));
    set_status(&deps, &healthy, StoredStatus::Unreachable).await;
    assert_eq!(routed(&deps, meta, "page-4").await, Some(expired.id));

    // Two connected holders: the most recently connected one answers.
    let first = capability(a, "facebook_page", "page-3", FIXED_NOW);
    let second = capability(
        b,
        "facebook_page",
        "page-3",
        FIXED_NOW + Duration::minutes(5),
    );
    connect(&deps, &second, true).await;
    connect(&deps, &first, true).await;
    assert_eq!(routed(&deps, meta, "page-3").await, Some(second.id));
}

/// Only a binding proven at least once routes events: a credential pasted for someone else's
/// account (sealed, its probe failed or reached another account, so `unreachable` and never
/// verified) takes nothing, while a connection verified once and unreachable since keeps its
/// events.
#[tokio::test]
async fn capability_by_external_needs_an_account_proven_once() {
    let (_, deps) = setup();
    let (a, _) = workspace(&deps, "a").await;
    let (b, _) = workspace(&deps, "b").await;
    let meta: &[&str] = Provider::Meta.kinds();

    let pasted = capability(b, "facebook_page", "page-5", FIXED_NOW + Duration::days(1));
    connect(&deps, &pasted, false).await;
    set_status(&deps, &pasted, StoredStatus::Unreachable).await;
    assert_eq!(routed(&deps, meta, "page-5").await, None);
    // Nor does a stored status of verified without a verification time.
    let stamped = capability(b, "messenger", "page-5", FIXED_NOW + Duration::days(2));
    connect(&deps, &stamped, false).await;
    set_status(&deps, &stamped, StoredStatus::Verified).await;
    assert_eq!(routed(&deps, meta, "page-5").await, None);

    // The owner's connection, verified once and unreachable since, is the one that answers,
    // although the others are newer.
    let owned = capability(a, "facebook_page", "page-5", FIXED_NOW);
    connect(&deps, &owned, true).await;
    set_status(&deps, &owned, StoredStatus::Unreachable).await;
    assert_eq!(routed(&deps, meta, "page-5").await, Some(owned.id));
}

// ---------------------------------------------------------------------------------------------
// Service fakes
// ---------------------------------------------------------------------------------------------

#[test]
fn plain_secret_box_hmac_key_is_purpose_and_workspace_bound() {
    let sb = PlainSecretBox;
    let (a, b) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
    let key = sb.hmac_key(a, "oauth-state").unwrap();
    assert_eq!(sb.hmac_key(a, "oauth-state").unwrap(), key);
    assert_ne!(sb.hmac_key(a, "netgsm-hook").unwrap(), key);
    assert_ne!(sb.hmac_key(b, "oauth-state").unwrap(), key);
}

#[test]
fn fake_app_config_defaults_to_no_apps_and_the_test_panel() {
    let config = FakeAppConfig::default();
    use jt_app::ports::connectors::PlatformAppConfig as _;
    assert_eq!(config.meta_app(), None);
    assert_eq!(config.instagram_app(), None);
    assert_eq!(config.x_app(), None);
    assert_eq!(
        config.public_base_url().unwrap().as_str(),
        "https://panel.test/"
    );

    let all = FakeAppConfig::with_all_apps();
    assert!(all.meta_app().is_some());
    assert!(all.instagram_app().is_some());
    assert_eq!(
        all.x_app(),
        Some(XApp {
            client_id: "x-client-id".into(),
            client_secret: "x-client-secret".into(),
        })
    );
}

#[tokio::test]
async fn scripted_connector_answers_in_order_and_records_calls() {
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    netgsm.push_probe(ProbeResult::success(12, json!({ "balance": 100 })));
    netgsm.push_probe(ProbeResult::failure(
        30,
        ConnectorError::auth("bad password"),
    ));
    netgsm.push_sms(Ok(SendReceipt {
        provider_id: "job-1".into(),
    }));
    netgsm.push_sms(Err(ConnectorError::throttle(None)));

    let registry = ScriptedRegistry::new().with_connector(netgsm.clone());
    use jt_app::ports::connectors::ConnectorRegistry as _;
    let connector = registry.connector(Provider::Netgsm).expect("netgsm");
    assert_eq!(connector.provider(), Provider::Netgsm);
    // It names no host unless given some.
    assert!(connector.hosts().is_empty());
    let hosted = ScriptedConnector::new(Provider::Netgsm).with_hosts(&["api.netgsm.test"]);
    use jt_app::ports::connectors::Connector as _;
    assert_eq!(hosted.hosts(), ["api.netgsm.test"]);
    let cred = Credential::NetgsmSms {
        usercode: "850".into(),
        password: "pw".into(),
        msgheader: "KAHVE".into(),
    };
    assert!(connector.probe(&cred, &json!({})).await.ok);
    assert!(!connector.probe(&cred, &json!({})).await.ok);
    let sms = registry.sms(Provider::Netgsm).expect("netgsm sends sms");
    assert_eq!(
        sms.send(&cred, "905550000000", "Merhaba", Some("ref-1"))
            .await
            .unwrap()
            .provider_id,
        "job-1"
    );
    assert_eq!(
        sms.send(&cred, "905550000001", "Selam", None).await,
        Err(ConnectorError::throttle(None))
    );
    assert_eq!(
        netgsm.calls(),
        vec![
            ConnectorCall::Probe {
                credential: cred.clone(),
                public: json!({}),
            },
            ConnectorCall::Probe {
                credential: cred.clone(),
                public: json!({}),
            },
            ConnectorCall::SendSms {
                credential: cred.clone(),
                to: "905550000000".into(),
                text: "Merhaba".into(),
                reference: Some("ref-1".into()),
            },
            ConnectorCall::SendSms {
                credential: cred.clone(),
                to: "905550000001".into(),
                text: "Selam".into(),
                reference: None,
            },
        ]
    );

    // The connection step answers what was queued, then `Null` once nothing is (as the trait's
    // default does), recording each call.
    netgsm.push_on_connected(Ok(json!({ "subscribed": true })));
    netgsm.push_on_connected(Err(ConnectorError::permission("no")));
    let public = json!({ "kind_key": "sms_line" });
    assert_eq!(
        connector.on_connected(&cred, &public).await,
        Ok(json!({ "subscribed": true }))
    );
    assert_eq!(
        connector.on_connected(&cred, &public).await,
        Err(ConnectorError::permission("no"))
    );
    assert_eq!(
        connector.on_connected(&cred, &public).await,
        Ok(Value::Null)
    );
    assert_eq!(
        netgsm.calls()[4..],
        vec![
            ConnectorCall::OnConnected {
                credential: cred.clone(),
                public: public.clone(),
            };
            3
        ][..]
    );

    // The registry offers each operation where the real adapters do; nothing for a provider it
    // was not given.
    assert!(registry.connector(Provider::Meta).is_none());
    assert!(registry.sms(Provider::Meta).is_none());
    assert!(registry.oauth(Provider::Netgsm).is_none());
    assert!(registry.telephony(Provider::Netgsm).is_some());
    assert!(registry.consent(Provider::Netgsm).is_some());
    assert!(registry.delivery_reports(Provider::Netgsm).is_some());
    assert!(registry.delivery_reports(Provider::Meta).is_none());
    assert!(registry.publisher(Provider::Netgsm).is_none());
}

#[tokio::test]
async fn scripted_connector_covers_every_operation() {
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
    let cred = token();
    meta.push_refresh(Ok(None));
    meta.push_publish(Ok(PublishReceipt {
        external_id: "post-1".into(),
        url: Some(Url::parse("https://facebook.test/post-1").unwrap()),
    }));
    meta.push_post_metrics(Ok(PostMetrics::default()));
    meta.push_account_metrics(Err(ConnectorError::permission("no insights")));
    meta.push_send_text(Ok(SendReceipt {
        provider_id: "mid.1".into(),
    }));
    meta.push_set_daily_budget(Ok(()));
    meta.push_list_adsets(Ok(vec![AdSet {
        id: "as-1".into(),
        name: "Kampanya".into(),
        status: "ACTIVE".into(),
        campaign_id: Some("c-1".into()),
        daily_budget_minor: Some(5_000),
        lifetime_budget_minor: None,
    }]));
    meta.push_insights(Ok(vec![AdInsights {
        campaign_id: "c-1".into(),
        campaign_name: Some("Kampanya".into()),
        date: date!(2026 - 10 - 21),
        spend_minor: 1_250,
        impressions: 900,
        clicks: 12,
    }]));
    meta.push_leadgen(Err(ConnectorError::permanent("deleted")));
    let registry = ScriptedRegistry::new().with_connector(meta.clone());
    use jt_app::ports::connectors::ConnectorRegistry as _;

    assert_eq!(
        registry
            .connector(Provider::Meta)
            .unwrap()
            .refresh(&cred)
            .await,
        Ok(None)
    );
    let request = PublishRequest {
        text: "Yeni menü".into(),
        media_urls: vec![Url::parse("https://cdn.test/a.jpg").unwrap()],
        link: None,
        media: vec![],
    };
    let publisher = registry.publisher(Provider::Meta).unwrap();
    assert_eq!(
        publisher
            .publish(&cred, &json!({}), &request)
            .await
            .unwrap()
            .external_id,
        "post-1"
    );
    let insights = registry.insights(Provider::Meta).unwrap();
    assert_eq!(
        insights.post_metrics(&cred, &json!({}), "post-1").await,
        Ok(PostMetrics::default())
    );
    assert!(insights.account_metrics(&cred, &json!({})).await.is_err());
    let messaging = registry.messaging(Provider::Meta).unwrap();
    assert!(
        messaging
            .send_text(&cred, &json!({}), "psid-1", "Merhaba")
            .await
            .is_ok()
    );
    let ads = registry.ads(Provider::Meta).unwrap();
    assert_eq!(ads.set_daily_budget(&cred, "as-1", 7_500).await, Ok(()));
    assert_eq!(ads.list_adsets(&cred, &json!({})).await.unwrap().len(), 1);
    assert_eq!(
        ads.insights(
            &cred,
            &json!({}),
            date!(2026 - 10 - 21),
            date!(2026 - 10 - 21)
        )
        .await
        .unwrap()[0]
            .spend_minor,
        1_250
    );
    let leadgen = registry.leadgen(Provider::Meta).unwrap();
    assert!(leadgen.fetch(&cred, "lead-1").await.is_err());
    assert!(registry.sms(Provider::Meta).is_none());
    assert!(registry.telephony(Provider::Meta).is_none());
    assert!(registry.delivery_reports(Provider::Meta).is_none());

    let calls = meta.calls();
    assert_eq!(calls.len(), 9);
    assert_eq!(
        calls[1],
        ConnectorCall::Publish {
            credential: cred.clone(),
            public: json!({}),
            request,
        }
    );
    assert_eq!(
        calls[5],
        ConnectorCall::SetDailyBudget {
            credential: cred.clone(),
            entity_id: "as-1".into(),
            minor: 7_500,
        }
    );

    // NetGSM's telephony and consent operations.
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    netgsm.push_click_to_call(Ok(SendReceipt {
        provider_id: "crm-1".into(),
    }));
    netgsm.push_hangup(Ok(()));
    netgsm.push_consent_add(Ok(SendReceipt {
        provider_id: "iys-1".into(),
    }));
    let delivered = DeliveryStatus {
        job_id: "job-1".into(),
        recipient: "905000000001".into(),
        status: DeliveryState::Delivered,
        at: Some(FIXED_NOW),
        raw_code: "1".into(),
    };
    netgsm.push_report(Ok(vec![delivered.clone()]));
    netgsm.push_report(Err(ConnectorError::throttle(None)));
    let mo = InboundEventDraft {
        external_id: "netgsm-mo:1".into(),
        kind: EventKind::Message,
        payload: json!({ "text": "Merhaba" }),
        occurred_at: None,
    };
    netgsm.push_inbox(Ok(vec![mo.clone()]));
    let registry = ScriptedRegistry::new().with_connector(netgsm.clone());
    let pbx = Credential::NetgsmPbx {
        username: "8501234567".into(),
        password: "pw".into(),
        trunk: None,
        pbxnum: None,
    };
    let telephony = registry.telephony(Provider::Netgsm).unwrap();
    let call_public = json!({ "kind_key": "netgsm_pbx", "recording_allowed": true });
    assert_eq!(
        telephony
            .click_to_call(&pbx, &call_public, "101", "905550000000")
            .await
            .unwrap()
            .provider_id,
        "crm-1"
    );
    assert_eq!(
        netgsm.calls()[0],
        ConnectorCall::ClickToCall {
            credential: pbx.clone(),
            public: call_public.clone(),
            from_ext: "101".into(),
            to: "905550000000".into(),
        }
    );
    assert_eq!(telephony.hangup(&pbx, "crm-1").await, Ok(()));
    let rows = vec![ConsentRow {
        recipient: "+905550000000".into(),
        channel: "MESAJ".into(),
        granted: true,
        source: "HS_WEB".into(),
        at: FIXED_NOW,
    }];
    assert!(
        registry
            .consent(Provider::Netgsm)
            .unwrap()
            .add(&pbx, &rows)
            .await
            .is_ok()
    );
    assert_eq!(
        netgsm.calls().last(),
        Some(&ConnectorCall::ConsentAdd {
            credential: pbx.clone(),
            rows,
        })
    );

    // The polled reports and the inbox backup.
    let sms = Credential::NetgsmSms {
        usercode: "8500000000".into(),
        password: "pw".into(),
        msgheader: "TESTHDR".into(),
    };
    let reports = registry.delivery_reports(Provider::Netgsm).unwrap();
    let jobs = vec!["job-1".to_owned(), "job-2".to_owned()];
    assert_eq!(reports.report(&sms, &jobs).await, Ok(vec![delivered]));
    assert_eq!(
        reports.report(&sms, &jobs[..1]).await,
        Err(ConnectorError::throttle(None))
    );
    let (from, to) = (FIXED_NOW - Duration::hours(2), FIXED_NOW);
    assert_eq!(reports.inbox(&sms, from, to).await, Ok(vec![mo]));
    let calls = netgsm.calls();
    assert_eq!(
        calls[calls.len() - 3..],
        [
            ConnectorCall::Report {
                credential: sms.clone(),
                job_ids: jobs.clone(),
            },
            ConnectorCall::Report {
                credential: sms.clone(),
                job_ids: jobs[..1].to_vec(),
            },
            ConnectorCall::Inbox {
                credential: sms.clone(),
                from,
                to,
            },
        ]
    );
}

#[tokio::test]
#[should_panic(expected = "no inbox result scripted")]
async fn an_unscripted_inbox_poll_panics() {
    let connector = ScriptedConnector::new(Provider::Netgsm);
    use jt_app::ports::connectors::DeliveryReports as _;
    let _ = connector.inbox(&token(), FIXED_NOW, FIXED_NOW).await;
}

#[tokio::test]
#[should_panic(expected = "no probe result scripted")]
async fn an_unscripted_call_panics() {
    let connector = ScriptedConnector::new(Provider::X);
    use jt_app::ports::connectors::Connector as _;
    let _ = connector.probe(&token(), &json!({})).await;
}

#[tokio::test]
async fn scripted_oauth_builds_urls_and_answers_exchanges_in_order() {
    let oauth = Arc::new(ScriptedOAuth::new(Provider::X));
    oauth.push_exchange(Ok(token()));
    oauth.push_exchange(Err(ConnectorError::auth("invalid_grant")));
    let asset = Asset {
        kind_key: "x".into(),
        external_id: "u-1".into(),
        name: "@kahve".into(),
        credential: token(),
        public: json!({ "username": "kahve" }),
    };
    oauth.push_assets(Ok(vec![asset.clone()]));
    let registry = ScriptedRegistry::new().with_oauth(oauth.clone());
    use jt_app::ports::connectors::ConnectorRegistry as _;
    let provider = registry.oauth(Provider::X).expect("x has oauth");
    assert!(registry.oauth(Provider::Meta).is_none());

    let app = OAuthApp::X(XApp {
        client_id: "cid".into(),
        client_secret: "secret".into(),
    });
    let redirect = Url::parse("https://panel.test/api/connectors/oauth/callback/x").unwrap();
    let url = provider
        .authorize_url(&app, &redirect, "state-1", Some("challenge-1"))
        .unwrap();
    assert_eq!(url.host_str(), Some("oauth.test"));
    let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    assert!(query.contains(&("client_id".into(), "cid".into())));
    assert!(query.contains(&("state".into(), "state-1".into())));
    assert!(query.contains(&("code_challenge".into(), "challenge-1".into())));
    assert!(query.contains(&("redirect_uri".into(), redirect.to_string())));
    assert!(!url.as_str().contains("secret"), "{url}");

    assert_eq!(
        provider
            .exchange(&app, &redirect, "code-1", Some("verifier-1"))
            .await,
        Ok(token())
    );
    assert!(
        provider
            .exchange(&app, &redirect, "code-2", None)
            .await
            .is_err()
    );
    assert_eq!(provider.list_assets(&token()).await, Ok(vec![asset]));
    assert_eq!(
        oauth.calls(),
        vec![
            OAuthCall::AuthorizeUrl {
                client_id: "cid".into(),
                redirect: redirect.clone(),
                state: "state-1".into(),
                pkce_challenge: Some("challenge-1".into()),
            },
            OAuthCall::Exchange {
                client_id: "cid".into(),
                redirect: redirect.clone(),
                code: "code-1".into(),
                pkce_verifier: Some("verifier-1".into()),
            },
            OAuthCall::Exchange {
                client_id: "cid".into(),
                redirect: redirect.clone(),
                code: "code-2".into(),
                pkce_verifier: None,
            },
            OAuthCall::ListAssets {
                credential: token(),
            },
        ]
    );
    // A queued refusal answers the next authorize URL, once (the call is still recorded).
    oauth.refuse_authorize(ConnectorError::permanent("pkce required"));
    assert_eq!(
        provider.authorize_url(&app, &redirect, "state-2", None),
        Err(ConnectorError::permanent("pkce required"))
    );
    assert!(
        provider
            .authorize_url(&app, &redirect, "state-3", Some("challenge-3"))
            .is_ok()
    );
    assert_eq!(oauth.calls().len(), 6);
}

#[test]
fn testkit_deps_have_no_apps_and_an_empty_scripted_registry() {
    let (_, deps) = setup();
    assert_eq!(deps.apps.meta_app(), None);
    assert_eq!(
        deps.apps.public_base_url().unwrap().as_str(),
        "https://panel.test/"
    );
    for provider in Provider::all() {
        assert!(
            deps.connectors.connector(*provider).is_none(),
            "{provider:?}"
        );
        assert!(deps.connectors.oauth(*provider).is_none(), "{provider:?}");
    }
}
