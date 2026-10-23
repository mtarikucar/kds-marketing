//! The webhook use cases over the in-memory fakes: routing an event by its provider account to
//! the one workspace that holds the account connected (Review Focus 1: never anywhere else),
//! deduplication of replays (Review Focus 2), NetGSM's per-workspace hook tokens and their
//! events' capability, the raw-body purge, and the hook addresses shown to the owner
//! (`connector.hooks`). One test per rule.

mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::InboundEventDraft;
use jt_app::usecases::connector::{self, HooksOut, MetaHook, NetgsmHook, VERIFY_TOKEN_HINT};
use jt_app::usecases::webhook::{
    self, AccountEvent, Delivery, META_HOOK_PATH, NETGSM_HOOK_PATH, NETGSM_HOOK_PURPOSE,
    RAW_RETENTION, RawPurge,
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{EventKind, InboundEvent, NetgsmPurpose, Provider, netgsm_hook_token};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, StoredInboundEvent};
use jt_testkit::flows::activate_workspace;
use serde_json::json;
use std::sync::{Arc, Mutex};
use support::*;
use time::Duration;

const WHATSAPP: &[&str] = &["whatsapp_cloud"];
const PAGE: &[&str] = &["facebook_page", "messenger"];

/// A capability of `kind` holding `external_id` in `ws`, with sealed credentials and the given
/// stored status; verified once by a probe when `verified_once`.
async fn capability(
    w: &World,
    ws: WorkspaceId,
    kind: &str,
    external_id: &str,
    status: StoredStatus,
    verified_once: bool,
) -> CapabilityId {
    let mut c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: format!("{kind} {external_id}"),
            external_id: Some(external_id.into()),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = status;
    c.last_verified_at = verified_once.then_some(FIXED_NOW);
    let mut t = w.uow.tenant(ws).await.unwrap();
    t.capabilities()
        .insert(c.clone(), Some(b"sealed".to_vec()))
        .await
        .unwrap();
    t.commit().await.unwrap();
    c.id
}

/// A connected capability: sealed, verified by a probe.
async fn connected(w: &World, ws: WorkspaceId, kind: &str, external_id: &str) -> CapabilityId {
    capability(w, ws, kind, external_id, StoredStatus::Verified, true).await
}

/// A raw body kept whole, whichever of a delivery's events it is asked for. (What the gate keeps
/// of a real body for one workspace is cut by the provider's adapter: see `jt_meta::scoped_body`
/// and `jt_webhook`'s tests.)
fn whole(raw: &'static [u8]) -> impl Fn(&[usize]) -> Option<Vec<u8>> + Sync {
    move |_| Some(raw.to_vec())
}

fn draft(external_id: &str, kind: EventKind) -> InboundEventDraft {
    InboundEventDraft {
        external_id: external_id.into(),
        kind,
        payload: json!({ "message": { "id": external_id } }),
        occurred_at: None,
    }
}

fn for_account(
    kinds: &'static [&'static str],
    account: &str,
    draft: InboundEventDraft,
) -> AccountEvent {
    AccountEvent {
        kind_keys: kinds,
        external_account_id: account.into(),
        draft,
    }
}

/// Every stored event, in every workspace.
fn stored(w: &World) -> Vec<StoredInboundEvent> {
    w.uow.snapshot().inbound_events
}

fn events_of(w: &World, ws: WorkspaceId) -> Vec<InboundEvent> {
    stored(w)
        .into_iter()
        .map(|s| s.event)
        .filter(|e| e.workspace_id == ws)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Routing by account
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_event_for_a_connected_account_is_stored_once_in_its_workspace() {
    let w = world().await;
    let number = connected(&w, w.ws, "whatsapp_cloud", "5555555555").await;
    let body = b"{\"object\":\"whatsapp_business_account\"}";
    let delivery = || {
        vec![for_account(
            WHATSAPP,
            "5555555555",
            draft("wamid.1", EventKind::Message),
        )]
    };

    let first = webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(), &whole(body))
        .await
        .unwrap();
    let [Delivery::Stored(id)] = first[..] else {
        panic!("stored once: {first:?}");
    };
    let events = events_of(&w, w.ws);
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.id, id);
    assert_eq!(e.provider, Provider::Meta);
    assert_eq!(e.capability_id, Some(number));
    assert_eq!(e.external_id, "wamid.1");
    assert_eq!(e.kind, EventKind::Message);
    assert_eq!(e.payload, json!({ "message": { "id": "wamid.1" } }));
    assert_eq!(e.received_at, FIXED_NOW);
    assert_eq!(e.processed_at, None);
    // The raw body is kept beside it.
    assert_eq!(stored(&w)[0].raw.as_deref(), Some(&body[..]));

    // A replayed delivery is acknowledged and ignored (Review Focus 2).
    let replay = webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(), &whole(body))
        .await
        .unwrap();
    assert_eq!(replay, [Delivery::Duplicate]);
    assert_eq!(stored(&w).len(), 1);
}

#[tokio::test]
async fn events_route_to_the_workspace_that_holds_each_account() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    let alpha_page = connected(&w, w.ws, "facebook_page", "1111").await;
    let beta_messenger = connected(&w, beta, "messenger", "2222").await;
    let out = webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        vec![
            for_account(PAGE, "1111", draft("mid.a", EventKind::Message)),
            for_account(PAGE, "2222", draft("mid.b", EventKind::Message)),
            for_account(PAGE, "1111", draft("mid.c", EventKind::MessageEcho)),
        ],
        &whole(b"{}"),
    )
    .await
    .unwrap();
    assert!(
        out.iter().all(|d| matches!(d, Delivery::Stored(_))),
        "{out:?}"
    );
    let alpha: Vec<_> = events_of(&w, w.ws)
        .into_iter()
        .map(|e| (e.external_id, e.capability_id))
        .collect();
    assert_eq!(
        alpha,
        [
            ("mid.a".to_owned(), Some(alpha_page)),
            ("mid.c".to_owned(), Some(alpha_page))
        ]
    );
    let beta_events: Vec<_> = events_of(&w, beta)
        .into_iter()
        .map(|e| (e.external_id, e.capability_id))
        .collect();
    assert_eq!(beta_events, [("mid.b".to_owned(), Some(beta_messenger))]);
}

/// Review Focus 1: an event whose account no workspace holds connected (unknown, only declared,
/// sealed but never verified, retired, or held under a kind the event cannot be for) is dropped:
/// no workspace gets a row, whatever another workspace holds.
#[tokio::test]
async fn an_event_for_an_account_no_workspace_holds_connected_writes_nothing() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    // Declared only: anyone can type a public id.
    capability(
        &w,
        w.ws,
        "whatsapp_cloud",
        "3333",
        StoredStatus::Declared,
        false,
    )
    .await;
    // Sealed, never proved (a pasted token for someone else's number).
    capability(
        &w,
        beta,
        "whatsapp_cloud",
        "4444",
        StoredStatus::Unreachable,
        false,
    )
    .await;
    // Retired: the account is no longer the workspace's.
    capability(
        &w,
        beta,
        "whatsapp_cloud",
        "5555",
        StoredStatus::Retired,
        true,
    )
    .await;
    // Connected, but as a page: a WhatsApp event is not for it.
    connected(&w, beta, "facebook_page", "6666").await;

    let out = webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        ["0000", "3333", "4444", "5555", "6666"]
            .into_iter()
            .map(|account| {
                for_account(
                    WHATSAPP,
                    account,
                    draft(&format!("wamid.{account}"), EventKind::Message),
                )
            })
            .collect(),
        &whole(b"{}"),
    )
    .await
    .unwrap();
    assert_eq!(out, [Delivery::Unrouted; 5]);
    assert!(stored(&w).is_empty());
}

/// Sets workspace `ws`'s status, as the platform operator would.
async fn set_status(w: &World, ws: WorkspaceId, status: WorkspaceStatus) {
    let mut platform = w.uow.platform().await.unwrap();
    platform.workspace_set_status(ws, status).await.unwrap();
    platform.commit().await.unwrap();
}

/// A Meta event reaches the workspace that holds its account while that workspace is active or
/// awaits payment; while it is suspended the event is dropped (`Delivery::Inactive`): nothing is
/// stored there, and nothing anywhere else either. Another workspace's events in the same
/// delivery are not held back.
#[tokio::test]
async fn meta_events_for_a_suspended_workspace_are_dropped() {
    let w = world().await;
    let number = connected(&w, w.ws, "whatsapp_cloud", "5555").await;
    let event = |id: &str| vec![for_account(WHATSAPP, "5555", draft(id, EventKind::Message))];
    let body = whole(b"{}");
    let receive = |events| webhook::receive_for_accounts(&w.deps, Provider::Meta, events, &body);

    // A new workspace awaits payment: its events are kept.
    let out = receive(event("wamid.pending")).await.unwrap();
    assert!(matches!(out[..], [Delivery::Stored(_)]), "{out:?}");
    set_status(&w, w.ws, WorkspaceStatus::Active).await;
    let out = receive(event("wamid.active")).await.unwrap();
    assert!(matches!(out[..], [Delivery::Stored(_)]), "{out:?}");
    assert_eq!(events_of(&w, w.ws).len(), 2);

    // Suspended: dropped, nothing written.
    set_status(&w, w.ws, WorkspaceStatus::Suspended).await;
    let out = receive(event("wamid.suspended")).await.unwrap();
    assert_eq!(out, [Delivery::Inactive]);
    assert_eq!(stored(&w).len(), 2);

    // In one delivery, a suspended workspace's event is dropped and an active one's stored.
    let (beta, _) = w.other_workspace().await;
    activate_workspace(&w.deps, beta).await;
    let theirs = connected(&w, beta, "whatsapp_cloud", "6666").await;
    let out = receive(vec![
        for_account(WHATSAPP, "5555", draft("wamid.s2", EventKind::Message)),
        for_account(WHATSAPP, "6666", draft("wamid.b1", EventKind::Message)),
    ])
    .await
    .unwrap();
    assert!(
        matches!(out[..], [Delivery::Inactive, Delivery::Stored(_)]),
        "{out:?}"
    );
    let beta_events = events_of(&w, beta);
    assert_eq!(beta_events.len(), 1);
    assert_eq!(beta_events[0].capability_id, Some(theirs));
    assert!(
        events_of(&w, w.ws)
            .iter()
            .all(|e| e.capability_id == Some(number) && e.external_id != "wamid.s2")
    );

    // Active again, its events come in again.
    set_status(&w, w.ws, WorkspaceStatus::Active).await;
    let out = receive(event("wamid.back")).await.unwrap();
    assert!(matches!(out[..], [Delivery::Stored(_)]), "{out:?}");
}

/// A connection whose token expired (unreachable, verified once) keeps its events.
#[tokio::test]
async fn an_unreachable_connection_proved_once_keeps_its_events() {
    let w = world().await;
    let page = capability(
        &w,
        w.ws,
        "facebook_page",
        "7777",
        StoredStatus::Unreachable,
        true,
    )
    .await;
    let out = webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        vec![for_account(
            PAGE,
            "7777",
            draft("mid.7", EventKind::Message),
        )],
        &whole(b"{}"),
    )
    .await
    .unwrap();
    assert!(matches!(out[..], [Delivery::Stored(_)]));
    assert_eq!(events_of(&w, w.ws)[0].capability_id, Some(page));
}

#[tokio::test]
async fn the_time_an_event_happened_is_kept_in_its_payload() {
    let w = world().await;
    connected(&w, w.ws, "whatsapp_cloud", "5555").await;
    let at = FIXED_NOW - Duration::minutes(3);
    let mut timed = draft("wamid.t", EventKind::Message);
    timed.occurred_at = Some(at);
    // A payload that names the key already keeps its own value; one that is not an object is
    // kept as it is.
    let mut own = draft("wamid.o", EventKind::Message);
    own.payload = json!({ "occurred_at": "provider's own" });
    own.occurred_at = Some(at);
    let mut bare = draft("wamid.b", EventKind::Status);
    bare.payload = json!("delivered");
    bare.occurred_at = Some(at);
    webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        vec![
            for_account(WHATSAPP, "5555", timed),
            for_account(WHATSAPP, "5555", own),
            for_account(WHATSAPP, "5555", bare),
        ],
        &whole(b"{}"),
    )
    .await
    .unwrap();
    let payload = |id: &str| {
        events_of(&w, w.ws)
            .into_iter()
            .find(|e| e.external_id == id)
            .unwrap()
            .payload
    };
    assert_eq!(
        payload("wamid.t"),
        json!({ "message": { "id": "wamid.t" }, "occurred_at": "2026-10-22T08:57:00Z" })
    );
    assert_eq!(
        payload("wamid.o"),
        json!({ "occurred_at": "provider's own" })
    );
    assert_eq!(payload("wamid.b"), json!("delivered"));
}

/// The raw body a delivery keeps in a workspace is that workspace's own: it is asked for with
/// exactly the indexes of the events routed there (once per workspace and delivery), never with
/// another workspace's, nor with an event no workspace took (an account no workspace holds, or a
/// suspended workspace's); and it is kept once, beside the first event newly stored there. So a
/// body naming its events by id (as the gate's cut of a real body names its items) keeps none of
/// another workspace's identifiers. A redelivery that brings one new event keeps its body beside
/// that one.
#[tokio::test]
async fn a_delivery_keeps_its_raw_body_once_per_workspace() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    connected(&w, w.ws, "whatsapp_cloud", "1").await;
    connected(&w, beta, "whatsapp_cloud", "2").await;
    // Each event's id and account; `b.` events are beta's, `u.` events no workspace's.
    let delivery = |ids: &[&'static str]| {
        ids.iter()
            .map(|id| {
                let account = match id.split('.').next() {
                    Some("b") => "2",
                    Some("u") => "9",
                    _ => "1",
                };
                for_account(WHATSAPP, account, draft(id, EventKind::Message))
            })
            .collect::<Vec<_>>()
    };
    // A body naming the events it is asked for, and every ask recorded.
    let asks: Arc<Mutex<Vec<Vec<usize>>>> = Arc::default();
    let naming = |ids: &'static [&'static str]| {
        let asks = asks.clone();
        move |own: &[usize]| {
            asks.lock().unwrap().push(own.to_vec());
            let named: Vec<&str> = own.iter().map(|&i| ids[i]).collect();
            Some(named.join(",").into_bytes())
        }
    };
    const FIRST: &[&str] = &["wamid.3", "wamid.1", "b.1", "u.1", "wamid.2"];
    let out =
        webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(FIRST), &naming(FIRST))
            .await
            .unwrap();
    assert_eq!(out[3], Delivery::Unrouted);
    let mut asked = asks.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, [vec![0, 1, 4], vec![2]]);
    let raws = |ws: WorkspaceId| -> Vec<(String, Option<String>)> {
        stored(&w)
            .into_iter()
            .filter(|s| s.event.workspace_id == ws)
            .map(|s| {
                let raw = s.raw.map(|r| String::from_utf8(r).unwrap());
                (s.event.external_id, raw)
            })
            .collect()
    };
    // Stored in the order of their ids, the workspace's own body beside the first one only.
    assert_eq!(
        raws(w.ws),
        [
            (
                "wamid.1".to_owned(),
                Some("wamid.3,wamid.1,wamid.2".to_owned())
            ),
            ("wamid.2".to_owned(), None),
            ("wamid.3".to_owned(), None)
        ]
    );
    assert_eq!(raws(beta), [("b.1".to_owned(), Some("b.1".to_owned()))]);
    // No workspace's body names another's event, nor the one no workspace took.
    for s in stored(&w) {
        let raw = String::from_utf8(s.raw.unwrap_or_default()).unwrap();
        for id in FIRST {
            let theirs = events_of(&w, s.event.workspace_id)
                .iter()
                .all(|e| e.external_id != *id);
            if theirs {
                assert!(
                    !raw.contains(id),
                    "{} keeps {id}: {raw}",
                    s.event.workspace_id
                );
            }
        }
    }

    // A redelivery bringing one new event in each workspace, beta now suspended: beta's event is
    // dropped and never asked for; the active workspace keeps its own body beside its new one.
    set_status(&w, beta, WorkspaceStatus::Suspended).await;
    asks.lock().unwrap().clear();
    const SECOND: &[&str] = &["wamid.1", "b.2", "wamid.4", "wamid.2"];
    let out =
        webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(SECOND), &naming(SECOND))
            .await
            .unwrap();
    assert!(matches!(
        out[..],
        [
            Delivery::Duplicate,
            Delivery::Inactive,
            Delivery::Stored(_),
            Delivery::Duplicate
        ]
    ));
    assert_eq!(*asks.lock().unwrap(), [vec![0, 2, 3]]);
    let fourth = stored(&w)
        .into_iter()
        .find(|s| s.event.external_id == "wamid.4")
        .unwrap();
    assert_eq!(fourth.raw.as_deref(), Some(&b"wamid.1,wamid.4,wamid.2"[..]));
    assert_eq!(stored(&w).iter().filter(|s| s.raw.is_some()).count(), 3);
}

/// Within a workspace, a delivery's events are written in the order of their provider ids,
/// whatever their order in the body, so two deliveries of the same events lock them in the same
/// order; the answers keep the body's order.
#[tokio::test]
async fn a_delivery_is_written_in_the_order_of_its_event_ids() {
    let w = world().await;
    connected(&w, w.ws, "whatsapp_cloud", "1").await;
    let out = webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        ["wamid.c", "wamid.a", "wamid.b"]
            .into_iter()
            .map(|id| for_account(WHATSAPP, "1", draft(id, EventKind::Message)))
            .collect(),
        &whole(b"{}"),
    )
    .await
    .unwrap();
    let written: Vec<_> = events_of(&w, w.ws)
        .into_iter()
        .map(|e| (e.external_id, e.id))
        .collect();
    assert_eq!(
        written
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["wamid.a", "wamid.b", "wamid.c"]
    );
    let by_id = |external: &str| written.iter().find(|(id, _)| id == external).unwrap().1;
    assert_eq!(
        out,
        [
            Delivery::Stored(by_id("wamid.c")),
            Delivery::Stored(by_id("wamid.a")),
            Delivery::Stored(by_id("wamid.b"))
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// NetGSM
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn netgsm_hook_tokens_are_per_workspace_and_purpose() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    let key = jt_app::ports::SecretBox::hmac_key(w.deps.seal.as_ref(), w.ws, NETGSM_HOOK_PURPOSE)
        .unwrap();
    let mo = webhook::netgsm_hook_token(&w.deps, w.ws, NetgsmPurpose::Mo).unwrap();
    assert_eq!(mo, netgsm_hook_token(&key, w.ws, "mo"));
    assert_eq!(mo.len(), 64);
    assert_ne!(
        mo,
        webhook::netgsm_hook_token(&w.deps, w.ws, NetgsmPurpose::Iys).unwrap()
    );
    assert_ne!(
        mo,
        webhook::netgsm_hook_token(&w.deps, beta, NetgsmPurpose::Mo).unwrap()
    );
    assert_eq!(NETGSM_HOOK_PURPOSE, "netgsm-hook");
}

#[tokio::test]
async fn a_netgsm_hook_opens_with_its_token_while_active_or_pending_payment() {
    let w = world().await;
    let mo = webhook::netgsm_hook_token(&w.deps, w.ws, NetgsmPurpose::Mo).unwrap();
    // A new workspace awaits payment: its hook is already open.
    assert!(
        webhook::netgsm_hook_open(&w.deps, w.ws, NetgsmPurpose::Mo, &mo)
            .await
            .unwrap()
    );
    activate_workspace(&w.deps, w.ws).await;
    assert!(
        webhook::netgsm_hook_open(&w.deps, w.ws, NetgsmPurpose::Mo, &mo)
            .await
            .unwrap()
    );
    // Another purpose's token, a changed token, an empty one, another workspace's.
    let iys = webhook::netgsm_hook_token(&w.deps, w.ws, NetgsmPurpose::Iys).unwrap();
    let mut changed = mo.clone();
    changed.replace_range(0..1, if mo.starts_with('a') { "b" } else { "a" });
    for wrong in [iys.as_str(), changed.as_str(), "", "0"] {
        assert!(
            !webhook::netgsm_hook_open(&w.deps, w.ws, NetgsmPurpose::Mo, wrong)
                .await
                .unwrap(),
            "{wrong}"
        );
    }
    set_status(&w, w.ws, WorkspaceStatus::Suspended).await;
    assert!(
        !webhook::netgsm_hook_open(&w.deps, w.ws, NetgsmPurpose::Mo, &mo)
            .await
            .unwrap()
    );
    assert!(stored(&w).is_empty());
    let stranger = WorkspaceId::new_v7();
    let theirs = webhook::netgsm_hook_token(&w.deps, stranger, NetgsmPurpose::Mo).unwrap();
    assert!(
        !webhook::netgsm_hook_open(&w.deps, stranger, NetgsmPurpose::Mo, &theirs)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn netgsm_events_attach_to_the_single_live_capability_of_their_purpose() {
    let w = world().await;
    let line = connected(&w, w.ws, "sms_line", "JEETA").await;
    capability(&w, w.ws, "sms_line", "OLD", StoredStatus::Retired, true).await;
    let raw = b"{\"mesaj\":\"Merhaba\"}";
    let out = webhook::receive_netgsm(
        &w.deps,
        w.ws,
        NetgsmPurpose::Mo,
        vec![
            draft("netgsm-mo:1", EventKind::Message),
            draft("netgsm-mo:1", EventKind::Message),
        ],
        raw,
    )
    .await
    .unwrap();
    assert!(matches!(
        out[..],
        [Delivery::Stored(_), Delivery::Duplicate]
    ));
    let events = events_of(&w, w.ws);
    assert_eq!(events.len(), 1);
    // A three-item callback keeps its body once, beside the first of its ids.
    webhook::receive_netgsm(
        &w.deps,
        w.ws,
        NetgsmPurpose::Mo,
        vec![
            draft("netgsm-mo:4", EventKind::Message),
            draft("netgsm-mo:2", EventKind::Message),
            draft("netgsm-mo:3", EventKind::Message),
        ],
        b"three",
    )
    .await
    .unwrap();
    let three: Vec<(String, bool)> = stored(&w)
        .into_iter()
        .filter(|s| s.event.external_id != "netgsm-mo:1")
        .map(|s| (s.event.external_id, s.raw.is_some()))
        .collect();
    assert_eq!(
        three,
        [
            ("netgsm-mo:2".to_owned(), true),
            ("netgsm-mo:3".to_owned(), false),
            ("netgsm-mo:4".to_owned(), false)
        ]
    );
    assert_eq!(events[0].provider, Provider::Netgsm);
    assert_eq!(events[0].capability_id, Some(line));
    assert_eq!(stored(&w)[0].raw.as_deref(), Some(&raw[..]));

    // Call events belong to the PBX; there is none, so no capability.
    webhook::receive_netgsm(
        &w.deps,
        w.ws,
        NetgsmPurpose::Events,
        vec![draft("netgsm-call:1:Answer", EventKind::CallEvent)],
        b"{}",
    )
    .await
    .unwrap();
    // Two live lines: which one is unknown, so none.
    connected(&w, w.ws, "sms_line", "OTHER").await;
    webhook::receive_netgsm(
        &w.deps,
        w.ws,
        NetgsmPurpose::Iys,
        vec![draft("netgsm-iys:1", EventKind::Consent)],
        b"{}",
    )
    .await
    .unwrap();
    let pbx = connected(&w, w.ws, "netgsm_pbx", "santral").await;
    for purpose in [NetgsmPurpose::VoiceReport, NetgsmPurpose::AutocallReport] {
        webhook::receive_netgsm(
            &w.deps,
            w.ws,
            purpose,
            vec![draft(
                &format!("netgsm-{}:1", purpose.key()),
                EventKind::Status,
            )],
            b"{}",
        )
        .await
        .unwrap();
    }
    let by_id = |id: &str| {
        events_of(&w, w.ws)
            .into_iter()
            .find(|e| e.external_id == id)
            .unwrap()
            .capability_id
    };
    assert_eq!(by_id("netgsm-call:1:Answer"), None);
    assert_eq!(by_id("netgsm-iys:1"), None);
    assert_eq!(by_id("netgsm-voice-report:1"), Some(pbx));
    assert_eq!(by_id("netgsm-autocall-report:1"), Some(pbx));
}

// ---------------------------------------------------------------------------------------------
// The raw-body purge
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn purge_raw_clears_old_bodies_in_every_workspace() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    connected(&w, w.ws, "whatsapp_cloud", "1").await;
    connected(&w, beta, "whatsapp_cloud", "2").await;
    webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        vec![
            for_account(WHATSAPP, "1", draft("wamid.a", EventKind::Message)),
            for_account(WHATSAPP, "2", draft("wamid.b", EventKind::Message)),
        ],
        &whole(b"body"),
    )
    .await
    .unwrap();
    assert_eq!(RAW_RETENTION, Duration::days(30));
    // Nothing is older than the cutoff yet.
    assert_eq!(
        webhook::purge_raw(&w.deps, FIXED_NOW).await.unwrap(),
        RawPurge::default()
    );
    let later = FIXED_NOW + RAW_RETENTION + Duration::seconds(1);
    assert_eq!(
        webhook::purge_raw(&w.deps, webhook::raw_cutoff(later))
            .await
            .unwrap(),
        RawPurge {
            removed: 2,
            failed: 0
        }
    );
    assert!(stored(&w).iter().all(|s| s.raw.is_none()));
    // The events stay.
    assert_eq!(stored(&w).len(), 2);
    assert_eq!(
        webhook::purge_raw(&w.deps, later).await.unwrap(),
        RawPurge::default()
    );
}

// ---------------------------------------------------------------------------------------------
// connector.hooks
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hooks_urls_use_public_base_and_per_purpose_tokens() {
    let mut w = world().await;
    // Without a Meta app there is no Meta hook to show.
    let out = connector::hooks(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(out.meta, None);

    w.deps.apps = Arc::new(FakeAppConfig {
        public_base_url: Some("https://jeeta.example/panel/".parse().unwrap()),
        ..FakeAppConfig::with_all_apps()
    });
    let out = connector::hooks(&w.deps, &w.owner_ctx).await.unwrap();
    let token = |purpose| webhook::netgsm_hook_token(&w.deps, w.ws, purpose).unwrap();
    let netgsm: Vec<NetgsmHook> = NetgsmPurpose::all()
        .iter()
        .map(|&purpose| NetgsmHook {
            purpose: purpose.key().to_owned(),
            url: format!(
                "https://jeeta.example/panel/hooks/netgsm/{}/{}/{}",
                w.ws,
                token(purpose),
                purpose.key()
            ),
        })
        .collect();
    assert_eq!(
        out,
        HooksOut {
            meta: Some(MetaHook {
                url: "https://jeeta.example/panel/hooks/meta".into(),
                verify_token_hint: VERIFY_TOKEN_HINT.into(),
            }),
            netgsm,
        }
    );
    assert_eq!(out.netgsm.len(), 5);
    assert_eq!(
        out.netgsm
            .iter()
            .map(|h| h.purpose.as_str())
            .collect::<Vec<_>>(),
        ["mo", "events", "iys", "voice-report", "autocall-report"]
    );
    assert_eq!(META_HOOK_PATH, "/hooks/meta");
    assert_eq!(NETGSM_HOOK_PATH, "/hooks/netgsm");
    // The verify token itself is never shown.
    assert!(!wire(&out).contains("meta-verify-token"));
    assert!(!wire(&out).contains("meta-app-secret"));
    assert_eq!(VERIFY_TOKEN_HINT, "set in the Meta app dashboard");

    // Another workspace's addresses carry its own tokens.
    let (beta, beta_ctx) = w.other_workspace().await;
    let theirs = connector::hooks(&w.deps, &beta_ctx).await.unwrap();
    assert!(theirs.netgsm[0].url.contains(&beta.to_string()));
    assert_ne!(theirs.netgsm[0].url, out.netgsm[0].url);
}

/// The tokens are capabilities of the URLs: only who may manage capabilities sees them.
#[tokio::test]
async fn hooks_need_capabilities_manage() {
    let w = world().await;
    let rep = w.member("rep").await;
    let e = err(connector::hooks(&w.deps, &rep).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_forbidden(&e, "capabilities.manage");
}
