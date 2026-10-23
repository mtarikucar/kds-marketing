//! The inbound-event use cases over the in-memory fakes: `events.pending` (unprocessed, oldest
//! first, paging forward), `events.list` (newest first, paging back, filters), `events.ack`
//! (marks processed, ledgered) and what their outputs never carry (the raw body). One test per
//! rule.

mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::events::{
    self, Ack, AfterCursor, BeforeCursor, DEFAULT_EVENT_LIMIT, InboundEventOut, List, MAX_ACK_IDS,
    MAX_EVENT_LIMIT, Pending,
};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_ledger::Subject;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

/// The body every stored event keeps beside it; no output may carry it.
const RAW: &[u8] = b"RAW-BODY-NEVER-SHOWN {\"token\":\"t-123\"}";

fn event(
    ws: WorkspaceId,
    provider: Provider,
    external_id: &str,
    kind: EventKind,
    at: OffsetDateTime,
) -> InboundEvent {
    InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws,
        provider,
        capability_id: None,
        external_id: external_id.into(),
        kind,
        payload: json!({ "message": { "text": external_id } }),
        received_at: at,
        processed_at: None,
    }
}

/// Stores `events` (each with [`RAW`]) in their workspaces, committed.
async fn store(w: &World, events: &[InboundEvent]) {
    for e in events {
        let mut t = w.uow.tenant(e.workspace_id).await.unwrap();
        t.inbound_events()
            .insert_if_new(e.clone(), Some(RAW.to_vec()))
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
}

/// `n` message events of Meta in the world's workspace, a minute apart from the fixed time.
fn messages(w: &World, n: usize) -> Vec<InboundEvent> {
    (0..n)
        .map(|i| {
            event(
                w.ws,
                Provider::Meta,
                &format!("mid.{i}"),
                EventKind::Message,
                FIXED_NOW + Duration::minutes(i as i64),
            )
        })
        .collect()
}

fn ids(events: &[InboundEventOut]) -> Vec<InboundEventId> {
    events.iter().map(|e| e.id).collect()
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap()
}

fn pending_after(limit: Option<u32>, after: Option<&InboundEventOut>) -> Pending {
    Pending {
        limit,
        after_at: after.map(|e| rfc3339(e.received_at)),
        after_id: after.map(|e| e.id),
    }
}

fn list(limit: Option<u32>) -> List {
    List {
        limit,
        ..List::default()
    }
}

// ---------------------------------------------------------------------------------------------
// events.pending
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn pending_lists_unprocessed_events_oldest_first_and_pages_forward() {
    let w = world().await;
    let all = messages(&w, 4);
    store(&w, &all).await;
    events::ack(
        &w.deps,
        &w.owner_ctx,
        Ack {
            ids: vec![all[1].id],
        },
    )
    .await
    .unwrap();

    let first = events::pending(&w.deps, &w.owner_ctx, pending_after(Some(2), None))
        .await
        .unwrap();
    assert_eq!(ids(&first.events), [all[0].id, all[2].id]);
    let last = &first.events[1];
    assert_eq!(
        first.next,
        Some(AfterCursor {
            after_at: last.received_at,
            after_id: last.id,
        })
    );
    let second = events::pending(&w.deps, &w.owner_ctx, pending_after(Some(2), Some(last)))
        .await
        .unwrap();
    assert_eq!(ids(&second.events), [all[3].id]);
    assert_eq!(second.next, None);

    // An event as it is read: its fields, never the raw body.
    let out = &first.events[0];
    assert_eq!(out.provider, Provider::Meta);
    assert_eq!(out.external_id, "mid.0");
    assert_eq!(out.kind, EventKind::Message);
    assert_eq!(out.payload, json!({ "message": { "text": "mid.0" } }));
    assert_eq!(out.received_at, FIXED_NOW);
    assert_eq!(out.processed_at, None);
    let wire = serde_json::to_value(out).unwrap();
    let mut keys: Vec<&str> = wire
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "capability_id",
            "external_id",
            "id",
            "kind",
            "payload",
            "processed_at",
            "provider",
            "received_at"
        ]
    );
    assert_eq!(wire["kind"], "message");
    assert_eq!(wire["provider"], "meta");
}

#[tokio::test]
async fn pending_and_list_take_50_by_default_and_at_most_200() {
    let w = world().await;
    store(&w, &messages(&w, 205)).await;
    let page = |limit| events::pending(&w.deps, &w.owner_ctx, pending_after(limit, None));
    assert_eq!(
        page(None).await.unwrap().events.len(),
        DEFAULT_EVENT_LIMIT as usize
    );
    assert_eq!(
        page(Some(500)).await.unwrap().events.len(),
        MAX_EVENT_LIMIT as usize
    );
    assert_eq!(page(Some(0)).await.unwrap().events.len(), 1);
    let listed = |limit| events::list(&w.deps, &w.owner_ctx, list(limit));
    assert_eq!(listed(None).await.unwrap().events.len(), 50);
    assert_eq!(listed(Some(1_000)).await.unwrap().events.len(), 200);
    assert_eq!(DEFAULT_EVENT_LIMIT, 50);
    assert_eq!(MAX_EVENT_LIMIT, 200);
}

#[tokio::test]
async fn pending_sees_only_its_own_workspace() {
    let w = world().await;
    let (beta, beta_ctx) = w.other_workspace().await;
    store(
        &w,
        &[event(
            beta,
            Provider::Netgsm,
            "netgsm-mo:1",
            EventKind::Message,
            FIXED_NOW,
        )],
    )
    .await;
    let mine = events::pending(&w.deps, &w.owner_ctx, Pending::default())
        .await
        .unwrap();
    assert!(mine.events.is_empty());
    let theirs = events::pending(&w.deps, &beta_ctx, Pending::default())
        .await
        .unwrap();
    assert_eq!(theirs.events.len(), 1);
}

#[tokio::test]
async fn a_cursor_comes_in_both_halves_and_its_time_must_parse() {
    let w = world().await;
    let half = Pending {
        after_at: Some(rfc3339(FIXED_NOW)),
        ..Pending::default()
    };
    assert_invalid(
        &err(events::pending(&w.deps, &w.owner_ctx, half).await),
        "after_id",
    );
    let half = Pending {
        after_id: Some(InboundEventId::new_v7()),
        ..Pending::default()
    };
    assert_invalid(
        &err(events::pending(&w.deps, &w.owner_ctx, half).await),
        "after_at",
    );
    let unparsed = Pending {
        after_at: Some("yesterday".into()),
        after_id: Some(InboundEventId::new_v7()),
        ..Pending::default()
    };
    assert_invalid(
        &err(events::pending(&w.deps, &w.owner_ctx, unparsed).await),
        "after_at",
    );
    let half = List {
        before_id: Some(InboundEventId::new_v7()),
        ..List::default()
    };
    assert_invalid(
        &err(events::list(&w.deps, &w.owner_ctx, half).await),
        "before_at",
    );
}

// ---------------------------------------------------------------------------------------------
// events.list
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_reads_newest_first_with_processed_ones_and_filters() {
    let w = world().await;
    let message = event(
        w.ws,
        Provider::Meta,
        "wamid.1",
        EventKind::Message,
        FIXED_NOW,
    );
    let consent = event(
        w.ws,
        Provider::Netgsm,
        "netgsm-iys:1",
        EventKind::Consent,
        FIXED_NOW + Duration::minutes(1),
    );
    let status = event(
        w.ws,
        Provider::Meta,
        "wamid.1:read",
        EventKind::Status,
        FIXED_NOW + Duration::minutes(2),
    );
    store(&w, &[message.clone(), consent.clone(), status.clone()]).await;
    events::ack(
        &w.deps,
        &w.owner_ctx,
        Ack {
            ids: vec![consent.id],
        },
    )
    .await
    .unwrap();

    // Processed ones included unless asked otherwise.
    let all = events::list(&w.deps, &w.owner_ctx, List::default())
        .await
        .unwrap();
    assert_eq!(ids(&all.events), [status.id, consent.id, message.id]);
    assert_eq!(all.events[1].processed_at, Some(FIXED_NOW));
    assert_eq!(all.next, None);
    let unprocessed = List {
        include_processed: Some(false),
        ..List::default()
    };
    assert_eq!(
        ids(&events::list(&w.deps, &w.owner_ctx, unprocessed)
            .await
            .unwrap()
            .events),
        [status.id, message.id]
    );
    let of = |provider: Option<Provider>, kind: Option<EventKind>| List {
        provider,
        kind,
        ..List::default()
    };
    assert_eq!(
        ids(
            &events::list(&w.deps, &w.owner_ctx, of(Some(Provider::Netgsm), None))
                .await
                .unwrap()
                .events
        ),
        [consent.id]
    );
    assert_eq!(
        ids(
            &events::list(&w.deps, &w.owner_ctx, of(None, Some(EventKind::Status)))
                .await
                .unwrap()
                .events
        ),
        [status.id]
    );

    // Paging back from the previous page's last event.
    let first = events::list(&w.deps, &w.owner_ctx, list(Some(2)))
        .await
        .unwrap();
    assert_eq!(ids(&first.events), [status.id, consent.id]);
    let last = &first.events[1];
    assert_eq!(
        first.next,
        Some(BeforeCursor {
            before_at: last.received_at,
            before_id: last.id,
        })
    );
    let next = List {
        limit: Some(2),
        before_at: Some(rfc3339(last.received_at)),
        before_id: Some(last.id),
        ..List::default()
    };
    let second = events::list(&w.deps, &w.owner_ctx, next).await.unwrap();
    assert_eq!(ids(&second.events), [message.id]);
    assert_eq!(second.next, None);
}

#[tokio::test]
async fn reading_events_needs_workspace_read() {
    let w = world().await;
    let mut nobody = w.owner_ctx.clone();
    nobody.permissions.clear();
    assert_forbidden(
        &err(events::pending(&w.deps, &nobody, Pending::default()).await),
        "workspace.read",
    );
    assert_forbidden(
        &err(events::list(&w.deps, &nobody, List::default()).await),
        "workspace.read",
    );
    // A rep reads them.
    let rep = w.member("rep").await;
    events::pending(&w.deps, &rep, Pending::default())
        .await
        .unwrap();
    events::list(&w.deps, &rep, List::default()).await.unwrap();
}

// ---------------------------------------------------------------------------------------------
// events.ack
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn ack_marks_events_processed_once_and_ledgers_how_many() {
    let w = world().await;
    let all = messages(&w, 3);
    store(&w, &all).await;
    let version = w.approve_strategy().await;

    let out = events::ack(
        &w.deps,
        &w.owner_ctx,
        Ack {
            ids: vec![all[0].id, all[2].id, all[0].id],
        },
    )
    .await
    .unwrap();
    assert_eq!(out.acked, 2);
    assert_eq!(serde_json::to_value(out).unwrap(), json!({ "acked": 2 }));
    let pending = events::pending(&w.deps, &w.owner_ctx, Pending::default())
        .await
        .unwrap();
    assert_eq!(ids(&pending.events), [all[1].id]);
    let entries = w.entries("events.acked");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload, json!({ "n": 2 }));
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "inbound_events".into(),
            id: w.ws.to_string(),
        })
    );
    assert_eq!(entries[0].strategy_version_id, Some(version.as_uuid()));

    // Acknowledging again changes nothing and writes nothing.
    let again = events::ack(
        &w.deps,
        &w.owner_ctx,
        Ack {
            ids: vec![all[0].id],
        },
    )
    .await
    .unwrap();
    assert_eq!(again.acked, 0);
    assert_eq!(w.entries("events.acked").len(), 1);
}

#[tokio::test]
async fn ack_takes_one_to_two_hundred_ids() {
    let w = world().await;
    assert_invalid(
        &err(events::ack(&w.deps, &w.owner_ctx, Ack { ids: vec![] }).await),
        "ids",
    );
    let many = (0..=MAX_ACK_IDS)
        .map(|_| InboundEventId::new_v7())
        .collect();
    assert_invalid(
        &err(events::ack(&w.deps, &w.owner_ctx, Ack { ids: many }).await),
        "ids",
    );
    assert_eq!(MAX_ACK_IDS, 200);
}

#[tokio::test]
async fn ack_of_an_unknown_or_foreign_event_is_not_found_and_acks_nothing() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    let mine = messages(&w, 1);
    let foreign = event(beta, Provider::Meta, "mid.b", EventKind::Message, FIXED_NOW);
    store(&w, &[mine[0].clone(), foreign.clone()]).await;
    for stranger in [foreign.id, InboundEventId::new_v7()] {
        let e = err(events::ack(
            &w.deps,
            &w.owner_ctx,
            Ack {
                ids: vec![mine[0].id, stranger],
            },
        )
        .await);
        assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
        assert_eq!(e.details["id"], json!(stranger.to_string()));
    }
    let pending = events::pending(&w.deps, &w.owner_ctx, Pending::default())
        .await
        .unwrap();
    assert_eq!(pending.events.len(), 1);
    assert!(w.entries("events.acked").is_empty());
}

/// Acknowledging is a change of the workspace's records: `capabilities.manage`, the permission
/// that governs the connections the events arrive through (there is no lighter write permission;
/// `workspace.read` alone only reads them).
#[tokio::test]
async fn ack_needs_capabilities_manage() {
    let w = world().await;
    let all = messages(&w, 1);
    store(&w, &all).await;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(events::ack(
            &w.deps,
            &rep,
            Ack {
                ids: vec![all[0].id],
            },
        )
        .await),
        "capabilities.manage",
    );
    let agent = w.agent(&["capabilities.manage"]).await;
    let out = events::ack(
        &w.deps,
        &agent,
        Ack {
            ids: vec![all[0].id],
        },
    )
    .await
    .unwrap();
    assert_eq!(out.acked, 1);
}

// ---------------------------------------------------------------------------------------------
// Never the raw body
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn events_outputs_never_contain_raw() {
    let w = world().await;
    let all = messages(&w, 2);
    store(&w, &all).await;
    // The body is stored beside the events...
    assert!(
        w.uow
            .snapshot()
            .inbound_events
            .iter()
            .all(|s| s.raw.as_deref() == Some(RAW))
    );
    // ...and no answer carries it.
    let pending = events::pending(&w.deps, &w.owner_ctx, Pending::default())
        .await
        .unwrap();
    let listed = events::list(&w.deps, &w.owner_ctx, List::default())
        .await
        .unwrap();
    let acked = events::ack(
        &w.deps,
        &w.owner_ctx,
        Ack {
            ids: vec![all[0].id],
        },
    )
    .await
    .unwrap();
    for text in [wire(&pending), wire(&listed), wire(&acked)] {
        assert!(!text.contains("RAW-BODY"), "{text}");
        assert!(!text.contains("t-123"), "{text}");
        assert!(!text.contains("\"raw\""), "{text}");
    }
    for entry in w.ledger("events.") {
        assert!(!wire(&entry).contains("RAW-BODY"));
    }
}
