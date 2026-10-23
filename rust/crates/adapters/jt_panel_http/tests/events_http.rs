//! The inbound events and the webhook addresses on the panel, end to end through Postgres:
//! `GET /api/events/pending`, `GET /api/events`, `POST /api/events/ack` and
//! `GET /api/connectors/hooks`, with their gates (an active workspace, the permissions) and their
//! strict queries and bodies. No answer carries an event's raw body.

use axum::http::{Method, StatusCode};
use jt_app::ports::UnitOfWork;
use jt_connector::{EventKind, InboundEvent, InboundEventId, NetgsmPurpose, Provider};
use jt_tenancy::WorkspaceId;
use jt_testkit::panel::{Panel, expect_error, ok_json, request, workspace_of};
use serde_json::{Value, json};
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

const RAW: &[u8] = b"RAW-BODY-NEVER-SHOWN";
const T0: OffsetDateTime = datetime!(2026-10-22 09:00 UTC);

/// Stores `n` Meta messages in `ws`, a minute apart from [`T0`], each with [`RAW`].
async fn store(p: &Panel, ws: WorkspaceId, n: usize) -> Vec<InboundEventId> {
    let mut t = p.uow.tenant(ws).await.unwrap();
    let mut ids = Vec::new();
    for i in 0..n {
        let id = InboundEventId::new_v7();
        t.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: ws,
                    provider: Provider::Meta,
                    capability_id: None,
                    external_id: format!("wamid.{i}"),
                    kind: EventKind::Message,
                    payload: json!({ "message": { "text": "Merhaba" } }),
                    received_at: T0 + Duration::minutes(i as i64),
                    processed_at: None,
                },
                Some(RAW.to_vec()),
            )
            .await
            .unwrap();
        ids.push(id);
    }
    t.commit().await.unwrap();
    ids
}

fn ids(page: &Value) -> Vec<String> {
    page["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn events_are_read_and_acknowledged_on_the_panel() {
    let p = Panel::new().await;
    let (cookie, me) = p.register("owner@alpha.example", "Alpha").await;
    let ws = workspace_of(&me);
    let stored = store(&p, ws, 3).await;
    let id = |i: usize| stored[i].to_string();

    // Pending: oldest first, a page at a time forward.
    let page = ok_json(p.get("/api/events/pending?limit=2", &cookie).await).await;
    assert_eq!(ids(&page), [id(0), id(1)]);
    assert_eq!(page["next"]["after_id"], json!(id(1)));
    assert_eq!(page["next"]["after_at"], "2026-10-22T09:01:00Z");
    let event = &page["events"][0];
    assert_eq!(event["provider"], "meta");
    assert_eq!(event["kind"], "message");
    assert_eq!(event["external_id"], "wamid.0");
    assert_eq!(
        event["payload"],
        json!({ "message": { "text": "Merhaba" } })
    );
    assert_eq!(event["received_at"], "2026-10-22T09:00:00Z");
    assert_eq!(event["processed_at"], Value::Null);
    let next = format!(
        "/api/events/pending?limit=2&after_at={}&after_id={}",
        "2026-10-22T09:01:00Z",
        id(1)
    );
    let page = ok_json(p.get(&next, &cookie).await).await;
    assert_eq!(ids(&page), [id(2)]);
    assert_eq!(page["next"], Value::Null);

    // Acknowledged: no longer pending, still listed.
    let resp = p
        .send(
            Method::POST,
            "/api/events/ack",
            Some(&cookie),
            Some(json!({ "ids": [id(0), id(2)] })),
        )
        .await;
    assert_eq!(ok_json(resp).await, json!({ "acked": 2 }));
    let page = ok_json(p.get("/api/events/pending", &cookie).await).await;
    assert_eq!(ids(&page), [id(1)]);
    let all = ok_json(p.get("/api/events", &cookie).await).await;
    assert_eq!(ids(&all), [id(2), id(1), id(0)]);
    assert!(all["events"][0]["processed_at"].is_string());
    let unprocessed = ok_json(p.get("/api/events?include_processed=false", &cookie).await).await;
    assert_eq!(ids(&unprocessed), [id(1)]);
    let filtered = ok_json(
        p.get("/api/events?provider=netgsm&kind=message", &cookie)
            .await,
    )
    .await;
    assert!(ids(&filtered).is_empty());
    let back = ok_json(
        p.get(
            &format!(
                "/api/events?limit=1&before_at=2026-10-22T09:02:00Z&before_id={}",
                id(2)
            ),
            &cookie,
        )
        .await,
    )
    .await;
    assert_eq!(ids(&back), [id(1)]);
    assert_eq!(back["next"]["before_id"], json!(id(1)));

    // The ack is in the ledger; no answer carries a raw body.
    let ledger = ok_json(p.get("/api/ledger?action_prefix=events.", &cookie).await).await;
    assert_eq!(ledger[0]["entry"]["action"], "events.acked");
    assert_eq!(ledger[0]["entry"]["payload"], json!({ "n": 2 }));
    for text in [page.to_string(), all.to_string(), ledger.to_string()] {
        assert!(!text.contains("RAW-BODY"), "{text}");
    }
}

#[tokio::test]
async fn events_routes_take_only_their_parameters() {
    let p = Panel::new().await;
    let (cookie, _) = p.register("owner@alpha.example", "Alpha").await;
    let refused = |path: &'static str| {
        let p = &p;
        let cookie = cookie.clone();
        async move {
            expect_error(
                p.get(path, &cookie).await,
                StatusCode::UNPROCESSABLE_ENTITY,
                "VALIDATION",
            )
            .await
        }
    };
    refused("/api/events/pending?before_at=2026-10-22T09:00:00Z").await;
    refused("/api/events/pending?after_at=2026-10-22T09:00:00Z").await;
    refused("/api/events?after_at=2026-10-22T09:00:00Z").await;
    refused("/api/events?provider=telegram").await;
    refused("/api/events?include_processed=maybe").await;
    let body =
        refused("/api/events?before_at=yesterday&before_id=018f0000-0000-7000-8000-000000000000")
            .await;
    assert_eq!(body["details"]["field"], "before_at");

    for bad in [
        json!({}),
        json!({ "ids": [] }),
        json!({ "ids": ["x"] }),
        json!({ "ids": [], "all": true }),
    ] {
        let resp = p
            .send(Method::POST, "/api/events/ack", Some(&cookie), Some(bad))
            .await;
        expect_error(resp, StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION").await;
    }
    // An unknown event is not found.
    let resp = p
        .send(
            Method::POST,
            "/api/events/ack",
            Some(&cookie),
            Some(json!({ "ids": [InboundEventId::new_v7()] })),
        )
        .await;
    expect_error(resp, StatusCode::NOT_FOUND, "NOT_FOUND").await;
    // Acknowledging is a mutation: the panel's request header is required.
    let resp = p
        .call(request(
            Method::POST,
            "/api/events/ack",
            Some(&cookie),
            false,
            Some(json!({ "ids": [InboundEventId::new_v7()] })),
        ))
        .await;
    expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
}

#[tokio::test]
async fn events_need_an_active_workspace_and_their_permissions() {
    let p = Panel::new().await;
    let (pending_cookie, _) = p.register_pending("owner@beta.example", "Beta").await;
    for path in [
        "/api/events/pending",
        "/api/events",
        "/api/connectors/hooks",
    ] {
        expect_error(
            p.get(path, &pending_cookie).await,
            StatusCode::LOCKED,
            "WORKSPACE_INACTIVE",
        )
        .await;
    }
    let (owner, _) = p.register("owner@alpha.example", "Alpha").await;
    let (rep, _) = p.join(&owner, "rep@alpha.example", "rep").await;
    // A rep reads the events but neither acknowledges them nor sees the hook tokens.
    ok_json(p.get("/api/events/pending", &rep).await).await;
    ok_json(p.get("/api/events", &rep).await).await;
    let resp = p
        .send(
            Method::POST,
            "/api/events/ack",
            Some(&rep),
            Some(json!({ "ids": [InboundEventId::new_v7()] })),
        )
        .await;
    let body = expect_error(resp, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    assert_eq!(body["details"]["permission"], "capabilities.manage");
    let body = expect_error(
        p.get("/api/connectors/hooks", &rep).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    assert_eq!(body["details"]["permission"], "capabilities.manage");
}

#[tokio::test]
async fn the_owner_reads_the_workspace_webhook_addresses() {
    let p = Panel::new().await;
    let (cookie, me) = p.register("owner@alpha.example", "Alpha").await;
    let ws = workspace_of(&me);
    let hooks = ok_json(p.get("/api/connectors/hooks", &cookie).await).await;
    // No Meta app is configured in this panel.
    assert_eq!(hooks["meta"], Value::Null);
    let netgsm = hooks["netgsm"].as_array().unwrap();
    assert_eq!(netgsm.len(), 5);
    for (hook, purpose) in netgsm.iter().zip(NetgsmPurpose::all()) {
        assert_eq!(hook["purpose"], purpose.key());
        let url = hook["url"].as_str().unwrap();
        let prefix = format!("https://panel.test/hooks/netgsm/{ws}/");
        let rest = url.strip_prefix(&prefix).unwrap_or_else(|| panic!("{url}"));
        let (token, tail) = rest.split_once('/').unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(tail, purpose.key());
    }
}
