//! The webhook gate over Postgres: deliveries of the same Meta body racing store each event once
//! (Review Focus 2: the unique `(workspace, provider, external_id)` key; a second transaction
//! waits for the first), and the raw-body purge clears old bodies in every workspace while the
//! events stay.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use jt_app::ports::{EventOrder, EventQuery};
use jt_app::std_impls::{RandTokenGen, SystemClock, UuidV7Gen};
use jt_app::usecases::Deps;
use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
use jt_app::usecases::webhook;
use jt_capability::StoredStatus;
use jt_pg::PgUnitOfWork;
use jt_tenancy::WorkspaceId;
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
        archived_hook: Arc::new(NoopArchivedHook),
        hosts: Arc::new(RecordingTenantHosts::new()),
        apps: Arc::new(FakeAppConfig::with_all_apps()),
        connectors: Arc::new(ScriptedRegistry::new()),
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
    assert_eq!(webhook::purge_raw(&deps, far).await.unwrap(), 1);
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
            .unwrap(),
        0
    );
    let later = now + webhook::RAW_RETENTION + Duration::minutes(1);
    assert_eq!(
        webhook::purge_raw(&deps, webhook::raw_cutoff(later))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        webhook::purge_raw(&deps, webhook::raw_cutoff(later))
            .await
            .unwrap(),
        0
    );
    assert_eq!(external_ids(&deps, alpha).await.len(), 4);
    assert_eq!(external_ids(&deps, beta).await.len(), 1);
}
