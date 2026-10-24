//! The webhook gate over Postgres: deliveries of the same Meta body racing store each event once
//! (Review Focus 2: the unique `(workspace, provider, external_id)` key; a second transaction
//! waits for the first), and the raw-body purge clears old bodies in every workspace while the
//! events stay.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use jt_app::ctx::Ctx;
use jt_app::ports::{EventOrder, EventQuery, LedgerFilter};
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::events::{self, Ack};
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_app::usecases::webhook;
use jt_capability::StoredStatus;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_ledger::Actor;
use jt_pg::PgUnitOfWork;
use jt_tenancy::{Permission, WorkspaceId};
use jt_testkit::TestDb;
use jt_testkit::fakes::{
    FakeAppConfig, PlainHasher, PlainSecretBox, RecordingTenantHosts, ScriptedRegistry,
};
use jt_webhook::{WebhookState, router};
use support::*;
use time::{Duration, OffsetDateTime};

fn deps(db: &TestDb) -> Deps {
    Deps {
        uow: Arc::new(PgUnitOfWork::new(db.pool.clone())),
        clock: Arc::new(SystemClock),
        ids: Arc::new(UuidV7Gen),
        tokens: Arc::new(RandTokenGen),
        hasher: Arc::new(PlainHasher),
        seal: Arc::new(PlainSecretBox),
        channels: Arc::new(NoChannelsYet),
        file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
        media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
        files: Arc::new(jt_app::ports::files::UnavailableFileStore),
        transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(RecordingTenantHosts::new()),
        apps: Arc::new(FakeAppConfig::with_all_apps()),
        connectors: Arc::new(ScriptedRegistry::new()),
        billing: jt_app::usecases::billing::BillingConfig {
            price_minor: 123,
            price_currency: "TRY".into(),
            bank_instructions: "Synthetic bank instructions".into(),
        },
        job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
    }
}

/// The external ids of `ws`'s events, oldest first.
async fn external_ids(deps: &Deps, ws: WorkspaceId) -> Vec<String> {
    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.inbound_events()
        .list(EventQuery {
            pending_only: false,
            provider: None,
            kind: None,
            order: EventOrder::OldestFirst { after: None },
            limit: 500,
        })
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.external_id)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_replays_store_one_row() {
    let db = TestDb::new().await;
    let deps = deps(&db);
    let (ws, _) = db.seed_workspace("alpha").await;
    capability(
        deps.uow.as_ref(),
        ws,
        "whatsapp_cloud",
        "5555555555",
        StoredStatus::Verified,
        true,
    )
    .await;
    let app = router(WebhookState {
        deps: Arc::new(deps.clone()),
    });
    let body = fixture("meta/whatsapp_messages.json");

    // Eight deliveries of one body at once, on four threads: every one answered 200, and each
    // message stored once.
    let deliveries: Vec<_> = (0..8)
        .map(|_| {
            let (app, body) = (app.clone(), body.clone());
            tokio::spawn(async move { answer(&app, signed(&body)).await })
        })
        .collect();
    for delivery in deliveries {
        let (status, text) = delivery.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(text, "EVENT_RECEIVED");
    }
    assert_eq!(external_ids(&deps, ws).await, WHATSAPP_IDS);
    // One raw body for the delivery, no more: the purge counts what it removes.
    let far = OffsetDateTime::now_utc() + Duration::days(365);
    assert_eq!(webhook::purge_raw(&deps, far).await.unwrap().removed, 1);
}

/// The ids of the WhatsApp fixture's first number, in the order they are written.
const WHATSAPP_IDS: [&str; 4] = [
    "wamid.TEST-BUTTON-1",
    "wamid.TEST-INTERACTIVE-1",
    "wamid.TEST-REFERRAL-1",
    "wamid.TEST-TEXT-1",
];

/// Deliveries of the same messages batched in opposite orders, racing: written in one order
/// (their ids), so no two transactions wait on each other in a circle; every delivery is answered
/// `200` and each message is stored once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deliveries_batched_in_opposite_orders_store_one_row_each_without_deadlock() {
    let db = TestDb::new().await;
    let deps = deps(&db);
    let (ws, _) = db.seed_workspace("alpha").await;
    capability(
        deps.uow.as_ref(),
        ws,
        "whatsapp_cloud",
        "5555555555",
        StoredStatus::Verified,
        true,
    )
    .await;
    let app = router(WebhookState {
        deps: Arc::new(deps.clone()),
    });
    let body = fixture("meta/whatsapp_messages.json");
    let mut reversed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let messages = reversed["entry"][0]["changes"][0]["value"]["messages"]
        .as_array_mut()
        .unwrap();
    messages.reverse();
    let reversed = serde_json::to_vec(&reversed).unwrap();

    let deliveries: Vec<_> = (0..12)
        .map(|i| {
            let app = app.clone();
            let body = if i % 2 == 0 {
                body.clone()
            } else {
                reversed.clone()
            };
            tokio::spawn(async move { answer(&app, signed(&body)).await })
        })
        .collect();
    for delivery in deliveries {
        let (status, text) = delivery.await.unwrap();
        assert_eq!((status, text.as_str()), (StatusCode::OK, "EVENT_RECEIVED"));
    }
    assert_eq!(external_ids(&deps, ws).await, WHATSAPP_IDS);
}

#[tokio::test]
async fn the_raw_purge_clears_old_bodies_in_every_workspace() {
    let db = TestDb::new().await;
    let deps = deps(&db);
    let (alpha, _) = db.seed_workspace("alpha").await;
    let (beta, _) = db.seed_workspace("beta").await;
    capability(
        deps.uow.as_ref(),
        alpha,
        "whatsapp_cloud",
        "5555555555",
        StoredStatus::Verified,
        true,
    )
    .await;
    capability(
        deps.uow.as_ref(),
        beta,
        "whatsapp_cloud",
        "5555555556",
        StoredStatus::Verified,
        true,
    )
    .await;
    let app = router(WebhookState {
        deps: Arc::new(deps.clone()),
    });
    let (status, _) = answer(&app, signed(&fixture("meta/whatsapp_messages.json"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(external_ids(&deps, alpha).await.len(), 4);
    assert_eq!(
        external_ids(&deps, beta).await,
        ["wamid.TEST-OTHER-NUMBER-1"]
    );

    // One body per workspace the delivery reached. Nothing is old enough yet; thirty days on,
    // every body goes and every event stays.
    let now = OffsetDateTime::now_utc();
    assert_eq!(
        webhook::purge_raw(&deps, webhook::raw_cutoff(now))
            .await
            .unwrap()
            .removed,
        0
    );
    let later = now + webhook::RAW_RETENTION + Duration::minutes(1);
    assert_eq!(
        webhook::purge_raw(&deps, webhook::raw_cutoff(later))
            .await
            .unwrap()
            .removed,
        2
    );
    assert_eq!(
        webhook::purge_raw(&deps, webhook::raw_cutoff(later))
            .await
            .unwrap()
            .removed,
        0
    );
    assert_eq!(external_ids(&deps, alpha).await.len(), 4);
    assert_eq!(external_ids(&deps, beta).await.len(), 1);
}

/// Two acknowledgements of the same events, given in opposite orders, racing (`events.ack`):
/// each marks its events in one order (their ids, sorted), so the two never wait on each other in
/// a circle (Postgres would abort one with a deadlock); between them every event is marked once,
/// and the ledger's `events.acked` entries count exactly the events marked.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn acks_in_opposite_orders_mark_each_event_once_without_deadlock() {
    let db = TestDb::new().await;
    let deps = deps(&db);
    let (ws, owner) = db.seed_workspace("alpha").await;
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: owner },
        permissions: [Permission::CapabilitiesManage, Permission::WorkspaceRead].into(),
        role_key: Some("owner".into()),
        now: OffsetDateTime::now_utc(),
        agent_connection_id: None,
    };
    const ROUNDS: usize = 4;
    const EVENTS: usize = 30;
    for round in 0..ROUNDS {
        let mut ids = Vec::new();
        let mut t = deps.uow.tenant(ws).await.unwrap();
        for i in 0..EVENTS {
            let event = InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: ws,
                provider: Provider::Meta,
                capability_id: None,
                external_id: format!("mid.{round}.{i:02}"),
                kind: EventKind::Message,
                payload: serde_json::json!({}),
                received_at: OffsetDateTime::now_utc(),
                processed_at: None,
            };
            ids.push(
                t.inbound_events()
                    .insert_if_new(event, None)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        t.commit().await.unwrap();

        // Two acknowledgements each way, at once.
        let acks: Vec<_> = (0..4)
            .map(|n| {
                let (deps, ctx) = (deps.clone(), ctx.clone());
                let mut ids = ids.clone();
                if n % 2 == 1 {
                    ids.reverse();
                }
                tokio::spawn(async move { events::ack(&deps, &ctx, Ack { ids }).await })
            })
            .collect();
        let mut marked = 0;
        for ack in acks {
            let out = ack.await.unwrap();
            let out = out.unwrap_or_else(|e| panic!("round {round}: {e:?}"));
            marked += out.acked;
        }
        assert_eq!(
            marked as usize, EVENTS,
            "round {round}: each event marked once"
        );
    }

    // Nothing is left pending, and the ledger counts every event marked, once.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert!(
        t.inbound_events()
            .list_pending(500)
            .await
            .unwrap()
            .is_empty()
    );
    let entries = t
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("events.acked".into()),
            actor_kind: None,
            agent_connection_id: None,
            limit: 500,
            before_id: None,
        })
        .await
        .unwrap();
    let total: u64 = entries
        .iter()
        .map(|row| row.entry.payload["n"].as_u64().unwrap())
        .sum();
    assert_eq!(total as usize, ROUNDS * EVENTS);
}
