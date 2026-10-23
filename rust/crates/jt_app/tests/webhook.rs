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
    RAW_RETENTION,
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{EventKind, InboundEvent, NetgsmPurpose, Provider, netgsm_hook_token};
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{FIXED_NOW, FakeAppConfig, StoredInboundEvent};
use jt_testkit::flows::activate_workspace;
use serde_json::json;
use std::sync::Arc;
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

    let first = webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(), body)
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
    let replay = webhook::receive_for_accounts(&w.deps, Provider::Meta, delivery(), body)
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
        b"{}",
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
        b"{}",
    )
    .await
    .unwrap();
    assert_eq!(out, [Delivery::Unrouted; 5]);
    assert!(stored(&w).is_empty());
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
        b"{}",
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
        b"{}",
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

/// A delivery's raw body is kept once per workspace: beside the first event it newly stores
/// there; its other events, in that workspace, keep none. A redelivery that brings one new event
/// keeps the body beside that one.
#[tokio::test]
async fn a_delivery_keeps_its_raw_body_once_per_workspace() {
    let w = world().await;
    let (beta, _) = w.other_workspace().await;
    connected(&w, w.ws, "whatsapp_cloud", "1").await;
    connected(&w, beta, "whatsapp_cloud", "2").await;
    let delivery = |ids: &[&str]| {
        ids.iter()
            .map(|id| {
                let account = if id.starts_with("b.") { "2" } else { "1" };
                for_account(WHATSAPP, account, draft(id, EventKind::Message))
            })
            .collect::<Vec<_>>()
    };
    webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        delivery(&["wamid.3", "wamid.1", "b.1", "wamid.2"]),
        b"one delivery",
    )
    .await
    .unwrap();
    let raws = |ws: WorkspaceId| -> Vec<(String, bool)> {
        stored(&w)
            .into_iter()
            .filter(|s| s.event.workspace_id == ws)
            .map(|s| (s.event.external_id, s.raw.is_some()))
            .collect()
    };
    // Stored in the order of their ids, the body beside the first one only.
    assert_eq!(
        raws(w.ws),
        [
            ("wamid.1".to_owned(), true),
            ("wamid.2".to_owned(), false),
            ("wamid.3".to_owned(), false)
        ]
    );
    assert_eq!(raws(beta), [("b.1".to_owned(), true)]);

    let out = webhook::receive_for_accounts(
        &w.deps,
        Provider::Meta,
        delivery(&["wamid.1", "wamid.4", "wamid.2"]),
        b"the redelivery",
    )
    .await
    .unwrap();
    assert!(matches!(
        out[..],
        [
            Delivery::Duplicate,
            Delivery::Stored(_),
            Delivery::Duplicate
        ]
    ));
    let fourth = stored(&w)
        .into_iter()
        .find(|s| s.event.external_id == "wamid.4")
        .unwrap();
    assert_eq!(fourth.raw.as_deref(), Some(&b"the redelivery"[..]));
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
        b"{}",
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
async fn a_netgsm_hook_opens_only_with_its_token_for_an_active_workspace() {
    let w = world().await;
    let mo = webhook::netgsm_hook_token(&w.deps, w.ws, NetgsmPurpose::Mo).unwrap();
    // A new workspace awaits payment: closed whatever the token.
    assert!(
        !webhook::netgsm_hook_open(&w.deps, w.ws, NetgsmPurpose::Mo, &mo)
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
        b"body",
    )
    .await
    .unwrap();
    assert_eq!(RAW_RETENTION, Duration::days(30));
    // Nothing is older than the cutoff yet.
    assert_eq!(webhook::purge_raw(&w.deps, FIXED_NOW).await.unwrap(), 0);
    let later = FIXED_NOW + RAW_RETENTION + Duration::seconds(1);
    assert_eq!(
        webhook::purge_raw(&w.deps, webhook::raw_cutoff(later))
            .await
            .unwrap(),
        2
    );
    assert!(stored(&w).iter().all(|s| s.raw.is_none()));
    // The events stay.
    assert_eq!(stored(&w).len(), 2);
    assert_eq!(webhook::purge_raw(&w.deps, later).await.unwrap(), 0);
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
        public_base_url: "https://jeeta.example/panel/".parse().unwrap(),
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
