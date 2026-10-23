//! The work use cases over the in-memory fakes (B11): what is pending for the workspace
//! (`work.pending`), an agent's check-in (`work.checkin`), the check-in interval
//! (`work.set_checkin_interval`) and the overdue flag of the agents list. One test per rule.

mod support;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::{DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES, UnitOfWork, WorkspacePolicy};
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::capabilities::{self, CapabilityQuery};
use jt_app::usecases::events;
use jt_app::usecases::strategy;
use jt_app::usecases::work::{self, AgentState, PendingOut, StrategyState, WorkItem, WorkKind};
use jt_capability::{CapabilityId, EffectiveStatus, Evidence, StoredStatus};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_ledger::{Actor, Subject};
use jt_strategy::{Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::AgentConnectionId;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// The world, its workspace active: every item's use case runs (see
/// `a_workspace_awaiting_payment_lists_only_what_it_can_act_on` for the others).
async fn active_world() -> World {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w
}

/// An agent of the owner acting through a new key with `scopes`, whose client `client` first
/// connected at `seen_at`; its context at the fixed time.
async fn connected(w: &World, scopes: &[&str], client: &str, seen_at: OffsetDateTime) -> Ctx {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: format!("{client} key"),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    let principal = api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap();
    let connection = agents::register_initialize(
        &w.deps,
        &principal,
        ClientInfo {
            name: client.into(),
            version: "1.0".into(),
            protocol_version: "2025-06-18".into(),
        },
        seen_at,
    )
    .await
    .unwrap();
    api_keys::ctx_for_agent(&principal, connection, FIXED_NOW)
}

/// The connection an agent's context acts through.
fn connection(ctx: &Ctx) -> AgentConnectionId {
    ctx.agent_connection_id.unwrap()
}

/// Writes a draft version numbered `number`, submitted when `submitted`, straight to the repos;
/// returns its id.
async fn draft(w: &World, number: i32, submitted: bool) -> StrategyVersionId {
    let id = StrategyVersionId::new_v7();
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    t.strategy()
        .insert(StrategyVersion {
            id,
            workspace_id: w.ws,
            number,
            status: VersionStatus::Draft,
            sections: Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: w.owner },
            submitted_at: submitted.then_some(FIXED_NOW),
            approved_at: None,
            approved_by: None,
            archived_at: None,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    id
}

fn evidence(text: &str) -> Evidence {
    Evidence {
        text: text.into(),
        refs: Vec::new(),
    }
}

/// The kinds of the items, in order.
fn kinds(out: &PendingOut) -> Vec<WorkKind> {
    out.items.iter().map(|i| i.kind.clone()).collect()
}

/// The item of this kind.
fn item<'a>(out: &'a PendingOut, kind: &WorkKind) -> &'a WorkItem {
    out.items
        .iter()
        .find(|i| &i.kind == kind)
        .unwrap_or_else(|| panic!("no {kind:?} in {:?}", out.items))
}

async fn pending(w: &World, ctx: &Ctx) -> PendingOut {
    work::pending(&w.deps, ctx).await.unwrap()
}

// ---------------------------------------------------------------------------------------------
// work.pending: the strategy
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn pending_needs_workspace_read() {
    let w = active_world().await;
    let auditor = w.agent(&["ledger.read"]).await;
    assert_forbidden(
        &err(work::pending(&w.deps, &auditor).await),
        "workspace.read",
    );
}

#[tokio::test]
async fn pending_lists_consult_when_no_strategy() {
    let w = active_world().await;
    let rep = w.member("rep").await;
    let out = pending(&w, &rep).await;

    assert_eq!(out.strategy, StrategyState::Missing);
    // Highest priority first: the consultation, then the first capability.
    assert_eq!(
        kinds(&out),
        [WorkKind::ConsultStrategy, WorkKind::DeclareFirstCapability]
    );
    let consult = item(&out, &WorkKind::ConsultStrategy);
    assert_eq!(consult.priority, 1);
    assert!(
        consult.hint.contains("jeeta.strategy.start_consultation"),
        "{}",
        consult.hint
    );
    let declare = item(&out, &WorkKind::DeclareFirstCapability);
    assert_eq!(declare.priority, 3);
    assert!(
        declare.hint.contains("jeeta.capability.declare"),
        "{}",
        declare.hint
    );
    for i in &out.items {
        assert!(i.hint.is_ascii() && !i.hint.is_empty(), "{i:?}");
    }

    // On the wire: the strategy state as a word, each item's kind beside its fields.
    let wire = serde_json::to_value(&out).unwrap();
    assert_eq!(wire["strategy"], "missing");
    assert_eq!(wire["items"][0]["kind"], "consult_strategy");
    assert_eq!(wire["items"][0]["priority"], 1);
    assert_eq!(wire["items"][1]["kind"], "declare_first_capability");
    assert_eq!(
        wire["agent"],
        json!({ "last_seen_at": null, "interval_minutes": 1440, "overdue": true })
    );
}

#[tokio::test]
async fn an_open_draft_asks_to_continue_the_consultation_with_its_gaps() {
    let w = active_world().await;
    strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let out = pending(&w, &w.owner_ctx).await;

    let gaps = strategy::get(&w.deps, &w.owner_ctx).await.unwrap().gaps;
    assert!(!gaps.is_empty());
    assert_eq!(out.strategy, StrategyState::DraftOpen { gaps });
    let consult = item(&out, &WorkKind::ConsultStrategy);
    assert_eq!(consult.priority, 1);
    assert!(
        consult.hint.contains("continue the consultation"),
        "{}",
        consult.hint
    );
    let wire = serde_json::to_value(&out).unwrap();
    assert!(wire["strategy"]["draft_open"]["gaps"].is_array(), "{wire}");
}

#[tokio::test]
async fn a_submitted_draft_is_listed_for_approval_only_to_who_may_approve() {
    let w = active_world().await;
    let id = draft(&w, 1, true).await;
    let submitted = StrategyState::Submitted {
        version_id: id,
        submitted_at: FIXED_NOW,
    };

    // An owner and a manager may approve: the approval is their top item.
    let manager = w.member("manager").await;
    for ctx in [&w.owner_ctx, &manager] {
        let out = pending(&w, ctx).await;
        assert_eq!(out.strategy, submitted);
        let approve = item(&out, &WorkKind::ApproveStrategy);
        assert_eq!(approve.priority, 1);
        assert!(
            approve.hint.contains("jeeta.strategy.approve"),
            "{}",
            approve.hint
        );
        assert!(!kinds(&out).contains(&WorkKind::ConsultStrategy));
    }

    // A rep, and an owner's key without team.manage, may not: nothing about the strategy.
    let rep = w.member("rep").await;
    let narrowed = w.agent(&["workspace.read"]).await;
    for ctx in [&rep, &narrowed] {
        let out = pending(&w, ctx).await;
        assert_eq!(out.strategy, submitted);
        assert_eq!(kinds(&out), [WorkKind::DeclareFirstCapability]);
    }
    // On the wire, the draft as approving it names it.
    assert_eq!(
        serde_json::to_value(pending(&w, &rep).await).unwrap()["strategy"],
        json!({ "submitted": {
            "version_id": id,
            "submitted_at": FIXED_NOW.format(&Rfc3339).unwrap(),
        } })
    );
}

#[tokio::test]
async fn an_approved_strategy_leaves_nothing_to_do_about_it() {
    let w = active_world().await;
    w.approve_strategy().await;
    let out = pending(&w, &w.owner_ctx).await;
    assert_eq!(out.strategy, StrategyState::Approved { number: 1 });
    assert_eq!(kinds(&out), [WorkKind::DeclareFirstCapability]);
    assert_eq!(
        serde_json::to_value(&out).unwrap()["strategy"],
        json!({ "approved": { "number": 1 } })
    );

    // A new draft beside it is the pending work.
    draft(&w, 2, false).await;
    let out = pending(&w, &w.owner_ctx).await;
    assert!(
        matches!(out.strategy, StrategyState::DraftOpen { .. }),
        "{:?}",
        out.strategy
    );
    assert_eq!(item(&out, &WorkKind::ConsultStrategy).priority, 1);
}

// ---------------------------------------------------------------------------------------------
// work.pending: the capabilities
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn pending_lists_stale_devices() {
    let w = active_world().await;
    // Verified 40 days ago under the default 30-day policy: stale.
    let phone = w.declare("phone", "Saha telefonu").await.capability.id;
    capabilities::verify(
        &w.deps,
        &at(&w.owner_ctx, days_later(-40)),
        phone,
        evidence("adb devices listed it"),
    )
    .await
    .unwrap();
    // Declared, never verified.
    let printer = w.declare("printer", "Ofis yazıcısı").await.capability.id;
    // Verified today: nothing to do.
    let shell = w.declare("shell", "Kabuk").await.capability.id;
    capabilities::verify(&w.deps, &w.owner_ctx, shell, evidence("ran uname"))
        .await
        .unwrap();
    // Unreachable and retired ones are not asked for.
    let camera = w.declare("camera", "Kamera").await.capability.id;
    capabilities::mark_unreachable(&w.deps, &w.owner_ctx, camera, "kapalı".into())
        .await
        .unwrap();
    let scanner = w.declare("scanner", "Tarayıcı").await.capability.id;
    capabilities::retire(&w.deps, &w.owner_ctx, scanner, true)
        .await
        .unwrap();

    // The list agrees: the phone reads as stale, not verified.
    let listed = capabilities::list(&w.deps, &w.owner_ctx, CapabilityQuery::default())
        .await
        .unwrap();
    let phone_out = listed.iter().find(|c| c.capability.id == phone).unwrap();
    assert_eq!(phone_out.effective_status, EffectiveStatus::Stale);
    assert_eq!(phone_out.capability.status, StoredStatus::Verified);

    let out = pending(&w, &w.owner_ctx).await;
    assert_eq!(
        kinds(&out),
        [
            WorkKind::ConsultStrategy,
            WorkKind::VerifyCapability {
                capability_id: phone,
                name: "Saha telefonu".into(),
                stale: true,
            },
            WorkKind::VerifyCapability {
                capability_id: printer,
                name: "Ofis yazıcısı".into(),
                stale: false,
            },
        ]
    );
    for i in &out.items[1..] {
        assert_eq!(i.priority, 2);
        assert!(i.hint.contains("jeeta.capability.verify"), "{}", i.hint);
    }
    assert_ne!(
        out.items[1].hint, out.items[2].hint,
        "stale reads differently"
    );

    let wire = serde_json::to_value(&out).unwrap();
    assert_eq!(
        wire["items"][1],
        json!({
            "kind": "verify_capability",
            "capability_id": phone,
            "name": "Saha telefonu",
            "stale": true,
            "priority": 2,
            "hint": out.items[1].hint,
        })
    );

    // Verified again, the phone drops off the list.
    capabilities::verify(&w.deps, &w.owner_ctx, phone, evidence("adb devices again"))
        .await
        .unwrap();
    let out = pending(&w, &w.owner_ctx).await;
    assert!(
        out.items
            .iter()
            .all(|i| !matches!(&i.kind, WorkKind::VerifyCapability { capability_id, .. } if *capability_id == phone)),
        "{:?}",
        out.items
    );
}

#[tokio::test]
async fn pending_lists_connect_connector_for_declared_connector_kinds() {
    let w = active_world().await;
    let declared = w.declare("mailbox", "Destek").await.capability.id;
    // Probed already (as a connector will in M1b): connected.
    let probed = w.declare("instagram", "Marka").await.capability.id;
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.capabilities()
            .set_status(probed, StoredStatus::Verified, FIXED_NOW)
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let broken = w.declare("sms_line", "Hat").await.capability.id;
    capabilities::mark_unreachable(&w.deps, &w.owner_ctx, broken, "hat kapalı".into())
        .await
        .unwrap();
    let retired = w.declare("x", "Eski hesap").await.capability.id;
    capabilities::retire(&w.deps, &w.owner_ctx, retired, true)
        .await
        .unwrap();

    let out = pending(&w, &w.owner_ctx).await;
    assert_eq!(
        kinds(&out),
        [
            WorkKind::ConsultStrategy,
            WorkKind::ConnectConnector {
                capability_id: declared,
                name: "Destek".to_owned(),
            },
        ]
    );
    let connect = &out.items[1];
    assert_eq!(connect.priority, 2);
    assert!(!connect.hint.is_empty());
    let wire = serde_json::to_value(connect).unwrap();
    assert_eq!(wire["kind"], "connect_connector");
    assert_eq!(wire["name"], "Destek");
}

/// While the workspace awaits payment, only the items it can act on are listed: the strategy's
/// (`strategy.*` runs then). Verifying, declaring, connecting and the inbound events wait for
/// the payment (their use cases answer `WORKSPACE_INACTIVE`), though the events are stored
/// meanwhile and listed once the workspace is active. Each item names the use case that clears
/// it, and is listed exactly when the workspace's status lets that use case run.
#[tokio::test]
async fn a_workspace_awaiting_payment_lists_only_what_it_can_act_on() {
    let w = world().await;
    let device = w.declare("shell", "Kabuk").await.capability.id;
    let mailbox = w.declare("mailbox", "Destek").await.capability.id;
    inbound(&w, 2).await;
    assert_eq!(
        kinds(&pending(&w, &w.owner_ctx).await),
        [WorkKind::ConsultStrategy]
    );

    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let out = pending(&w, &w.owner_ctx).await;
    for kind in [
        WorkKind::ConsultStrategy,
        WorkKind::VerifyCapability {
            capability_id: device,
            name: "Kabuk".to_owned(),
            stale: false,
        },
        WorkKind::ConnectConnector {
            capability_id: mailbox,
            name: "Destek".to_owned(),
        },
        WorkKind::InboundEvents { count: 2 },
    ] {
        item(&out, &kind);
    }
    for kind in kinds(&out) {
        let exemption = jt_app::catalog::status_exemption(kind.cleared_by());
        assert!(
            exemption.allows(jt_tenancy::WorkspaceStatus::Active),
            "{kind:?}"
        );
        // Strategy items alone run while the workspace awaits payment.
        let strategy = kind.cleared_by().starts_with("strategy.");
        assert_eq!(
            exemption.allows(jt_tenancy::WorkspaceStatus::PendingPayment),
            strategy,
            "{kind:?}"
        );
    }
    // Every item's use case is a catalogued one.
    for kind in [
        WorkKind::ConsultStrategy,
        WorkKind::ApproveStrategy,
        WorkKind::DeclareFirstCapability,
        WorkKind::InboundEvents { count: 1 },
    ] {
        assert!(
            jt_app::catalog::find(kind.cleared_by()).is_some(),
            "{kind:?}"
        );
    }
}

#[tokio::test]
async fn declare_first_capability_until_a_live_one_exists() {
    let w = active_world().await;
    assert!(kinds(&pending(&w, &w.owner_ctx).await).contains(&WorkKind::DeclareFirstCapability));

    let shell = w.declare("shell", "Kabuk").await.capability.id;
    capabilities::verify(&w.deps, &w.owner_ctx, shell, evidence("ran uname"))
        .await
        .unwrap();
    assert!(!kinds(&pending(&w, &w.owner_ctx).await).contains(&WorkKind::DeclareFirstCapability));

    // Once every capability is retired, the workspace has none to act through again.
    capabilities::retire(&w.deps, &w.owner_ctx, shell, true)
        .await
        .unwrap();
    assert!(kinds(&pending(&w, &w.owner_ctx).await).contains(&WorkKind::DeclareFirstCapability));
}

/// Stores `n` pending inbound events in the world's workspace, a second apart.
async fn inbound(w: &World, n: usize) -> Vec<InboundEventId> {
    let mut t = w.uow.tenant(w.ws).await.unwrap();
    let mut ids = Vec::new();
    for i in 0..n {
        let id = InboundEventId::new_v7();
        t.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id,
                    workspace_id: w.ws,
                    provider: Provider::Netgsm,
                    capability_id: None,
                    external_id: format!("netgsm-mo:{i}"),
                    kind: EventKind::Message,
                    payload: json!({ "text": "Merhaba" }),
                    received_at: FIXED_NOW + Duration::seconds(i as i64),
                    processed_at: None,
                },
                None,
            )
            .await
            .unwrap();
        ids.push(id);
    }
    t.commit().await.unwrap();
    ids
}

#[tokio::test]
async fn pending_lists_inbound_events_while_some_are_unprocessed() {
    let w = active_world().await;
    assert!(
        !kinds(&pending(&w, &w.owner_ctx).await)
            .iter()
            .any(|k| matches!(k, WorkKind::InboundEvents { .. }))
    );
    let ids = inbound(&w, 3).await;
    let out = pending(&w, &w.owner_ctx).await;
    let item = item(&out, &WorkKind::InboundEvents { count: 3 });
    assert_eq!(item.priority, 2);
    assert!(item.hint.contains("jeeta.events.pending"), "{}", item.hint);
    assert!(item.hint.contains("jeeta.events.ack"), "{}", item.hint);
    let wire = serde_json::to_value(item).unwrap();
    assert_eq!(wire["kind"], "inbound_events");
    assert_eq!(wire["count"], 3);
    // Only who may acknowledge them is asked to: a rep, or a key without capabilities.manage,
    // sees no item it could never clear.
    let rep = w.member("rep").await;
    let reader = w.agent(&["workspace.read"]).await;
    for ctx in [&rep, &reader] {
        assert!(
            !kinds(&pending(&w, ctx).await)
                .iter()
                .any(|k| matches!(k, WorkKind::InboundEvents { .. }))
        );
    }
    let acker = w.agent(&["workspace.read", "capabilities.manage"]).await;
    assert!(kinds(&pending(&w, &acker).await).contains(&WorkKind::InboundEvents { count: 3 }));

    events::ack(
        &w.deps,
        &w.owner_ctx,
        events::Ack {
            ids: ids[..2].to_vec(),
        },
    )
    .await
    .unwrap();
    assert!(
        kinds(&pending(&w, &w.owner_ctx).await).contains(&WorkKind::InboundEvents { count: 1 })
    );
    events::ack(
        &w.deps,
        &w.owner_ctx,
        events::Ack {
            ids: ids[2..].to_vec(),
        },
    )
    .await
    .unwrap();
    assert!(
        !kinds(&pending(&w, &w.owner_ctx).await)
            .iter()
            .any(|k| matches!(k, WorkKind::InboundEvents { .. }))
    );
}

/// The count stops at [`work::INBOUND_EVENTS_COUNT_CAP`]: past it the item says "at least".
#[tokio::test]
async fn the_inbound_events_count_stops_at_its_cap() {
    let w = active_world().await;
    assert_eq!(work::INBOUND_EVENTS_COUNT_CAP, 1_000);
    inbound(&w, 1_001).await;
    let out = pending(&w, &w.owner_ctx).await;
    assert!(kinds(&out).contains(&WorkKind::InboundEvents { count: 1_000 }));
}

// ---------------------------------------------------------------------------------------------
// The agent's check-in
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn overdue_when_no_connection_or_all_late() {
    let w = active_world().await;
    let day = i64::from(DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES);

    // No agent has ever connected.
    let out = pending(&w, &w.owner_ctx).await;
    assert_eq!(
        out.agent,
        AgentState {
            last_seen_at: None,
            interval_minutes: DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES,
            overdue: true,
        }
    );

    // One agent seen two hours ago, one 30 hours ago: the latest counts, and it is in time.
    let early = FIXED_NOW - Duration::hours(30);
    let recent = FIXED_NOW - Duration::hours(2);
    connected(&w, &[], "old-agent", early).await;
    let agent = connected(&w, &[], "new-agent", recent).await;
    let out = pending(&w, &w.owner_ctx).await;
    assert_eq!(out.agent.last_seen_at, Some(recent));
    assert!(!out.agent.overdue);

    // Exactly one interval after: still in time; a minute later: overdue.
    let edge = recent + Duration::minutes(day);
    assert!(!pending(&w, &at(&w.owner_ctx, edge)).await.agent.overdue);
    let late = pending(&w, &at(&w.owner_ctx, edge + Duration::minutes(1))).await;
    assert!(late.agent.overdue);
    assert_eq!(late.agent.last_seen_at, Some(recent));

    // A call from the agent moves its last sight, and with it the warning.
    agents::touch_tool_call(&w.deps, w.ws, connection(&agent), edge)
        .await
        .unwrap();
    let back = pending(&w, &at(&w.owner_ctx, edge + Duration::minutes(1))).await;
    assert_eq!(back.agent.last_seen_at, Some(edge));
    assert!(!back.agent.overdue);

    // A shorter interval makes the same sight late.
    work::set_checkin_interval(&w.deps, &w.owner_ctx, 60)
        .await
        .unwrap();
    let out = pending(&w, &at(&w.owner_ctx, edge + Duration::minutes(61))).await;
    assert_eq!(out.agent.interval_minutes, 60);
    assert!(out.agent.overdue);
}

#[tokio::test]
async fn overdue_flag_on_agents_list() {
    let w = active_world().await;
    let late = connected(&w, &[], "late-agent", FIXED_NOW - Duration::hours(25)).await;
    let fresh = connected(&w, &[], "fresh-agent", FIXED_NOW - Duration::hours(1)).await;

    let listed = agents::list(&w.deps, &w.owner_ctx).await.unwrap();
    let overdue = |id: AgentConnectionId| listed.iter().find(|c| c.id == id).unwrap().overdue;
    assert!(overdue(connection(&late)));
    assert!(!overdue(connection(&fresh)));
    assert_eq!(
        serde_json::to_value(&listed[0]).unwrap()["overdue"],
        true,
        "the flag is on the wire"
    );

    // Under a week-long interval neither is late.
    work::set_checkin_interval(&w.deps, &w.owner_ctx, 10_080)
        .await
        .unwrap();
    let listed = agents::list(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(listed.iter().all(|c| !c.overdue), "{listed:?}");
}

#[tokio::test]
async fn checkin_is_agent_only_and_ledgers_at_most_hourly() {
    let w = active_world().await;

    // A person cannot check in.
    let e = err(work::checkin(&w.deps, &w.owner_ctx).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details, json!({ "reason": "agents_only" }));

    // An agent checks in and gets what is pending.
    let agent = connected(&w, &["workspace.read"], "acme-agent", FIXED_NOW).await;
    let out = work::checkin(&w.deps, &agent).await.unwrap();
    assert_eq!(out, pending(&w, &agent).await);
    assert_eq!(out.strategy, StrategyState::Missing);
    let entries = w.entries("work.checkin");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].actor, agent.actor);
    assert_eq!(entries[0].at, FIXED_NOW);
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "agent_connection".into(),
            id: connection(&agent).to_string(),
        })
    );

    // Within the hour the check-in answers but is not ledgered again; after it, it is.
    let minutes = |m: i64| FIXED_NOW + Duration::minutes(m);
    work::checkin(&w.deps, &at(&agent, minutes(59)))
        .await
        .unwrap();
    assert_eq!(w.entries("work.checkin").len(), 1);
    work::checkin(&w.deps, &at(&agent, minutes(60)))
        .await
        .unwrap();
    assert_eq!(w.entries("work.checkin").len(), 2);
    work::checkin(&w.deps, &at(&agent, minutes(61)))
        .await
        .unwrap();
    assert_eq!(w.entries("work.checkin").len(), 2);

    // The hour is per connection: another agent's check-in is its own.
    let other = connected(&w, &["workspace.read"], "other-agent", FIXED_NOW).await;
    work::checkin(&w.deps, &at(&other, minutes(61)))
        .await
        .unwrap();
    let entries = w.entries("work.checkin");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2].actor, other.actor);

    // An agent that may not read the workspace is refused, and nothing is ledgered.
    let blind = connected(&w, &["ledger.read"], "blind-agent", FIXED_NOW).await;
    assert_forbidden(&err(work::checkin(&w.deps, &blind).await), "workspace.read");
    assert_eq!(w.entries("work.checkin").len(), 3);
}

#[tokio::test]
async fn checkin_ledgers_the_strategy_version_in_force() {
    let w = active_world().await;
    let version = w.approve_strategy().await;
    let agent = connected(&w, &[], "acme-agent", FIXED_NOW).await;
    work::checkin(&w.deps, &agent).await.unwrap();
    let entries = w.entries("work.checkin");
    assert_eq!(entries[0].strategy_version_id, Some(version.as_uuid()));
    assert_eq!(entries[0].payload, json!({}));
}

#[tokio::test]
async fn late_agent_checking_in_is_not_overdue() {
    let w = active_world().await;
    let seen = FIXED_NOW - Duration::hours(30);
    let agent = connected(&w, &["workspace.read"], "late-agent", seen).await;

    // Asked plainly, the agent is overdue: its connection was last seen 30 hours ago.
    let before = pending(&w, &agent).await;
    assert_eq!(before.agent.last_seen_at, Some(seen));
    assert!(before.agent.overdue);

    // Its check-in counts it as seen now, whatever the connection row says yet.
    let out = work::checkin(&w.deps, &agent).await.unwrap();
    assert_eq!(
        out.agent,
        AgentState {
            last_seen_at: Some(FIXED_NOW),
            interval_minutes: DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES,
            overdue: false,
        }
    );
    assert_eq!(out.items, before.items);

    // A sighting later than the call stays the latest.
    let later = FIXED_NOW + Duration::minutes(5);
    agents::touch_tool_call(&w.deps, w.ws, connection(&agent), later)
        .await
        .unwrap();
    let out = work::checkin(&w.deps, &agent).await.unwrap();
    assert_eq!(out.agent.last_seen_at, Some(later));
    assert!(!out.agent.overdue);
}

// ---------------------------------------------------------------------------------------------
// work.set_checkin_interval
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn set_checkin_interval_needs_team_manage() {
    let w = active_world().await;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(work::set_checkin_interval(&w.deps, &rep, 60).await),
        "team.manage",
    );
    let narrowed = w.agent(&["workspace.read"]).await;
    assert_forbidden(
        &err(work::set_checkin_interval(&w.deps, &narrowed, 60).await),
        "team.manage",
    );
    assert!(w.entries("work.set_checkin_interval").is_empty());
}

#[tokio::test]
async fn set_checkin_interval_takes_a_quarter_hour_to_a_week() {
    let w = active_world().await;
    for minutes in [0, 14, 10_081, u32::MAX] {
        assert_invalid(
            &err(work::set_checkin_interval(&w.deps, &w.owner_ctx, minutes).await),
            "minutes",
        );
    }
    assert!(w.entries("work.set_checkin_interval").is_empty());

    for minutes in [15, 10_080, 90] {
        let state = work::set_checkin_interval(&w.deps, &w.owner_ctx, minutes)
            .await
            .unwrap();
        assert_eq!(state.interval_minutes, minutes);
        assert_eq!(state, pending(&w, &w.owner_ctx).await.agent);
    }
    let stored = {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.workspace_policy().get().await.unwrap()
    };
    assert_eq!(
        stored,
        WorkspacePolicy {
            agent_checkin_interval_minutes: 90,
            ..WorkspacePolicy::default()
        }
    );

    let entries = w.entries("work.set_checkin_interval");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2].payload, json!({ "minutes": 90 }));
    assert_eq!(entries[2].actor, w.owner_ctx.actor);
    assert_eq!(
        entries[2].subject,
        Some(Subject {
            kind: "workspace_policy".into(),
            id: w.ws.to_string(),
        })
    );
    assert_eq!(entries[2].strategy_version_id, None);

    // An agent through a key holding team.manage may set it too; the entry names the version in
    // force.
    let version = w.approve_strategy().await;
    let agent = w.agent(&[]).await;
    work::set_checkin_interval(&w.deps, &agent, 30)
        .await
        .unwrap();
    let entries = w.entries("work.set_checkin_interval");
    assert_eq!(entries[3].strategy_version_id, Some(version.as_uuid()));
    assert_eq!(entries[3].actor, agent.actor);
}

#[tokio::test]
async fn capability_ids_in_items_are_the_capabilities() {
    // Guards the item's id field against a mix-up with another id.
    let w = active_world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let out = pending(&w, &w.owner_ctx).await;
    let ids: Vec<CapabilityId> = out
        .items
        .iter()
        .filter_map(|i| match &i.kind {
            WorkKind::VerifyCapability { capability_id, .. }
            | WorkKind::ConnectConnector { capability_id, .. } => Some(*capability_id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, [phone]);
}

#[tokio::test]
async fn work_pending_is_derived_and_preserves_status_gating() {
    use jt_app::usecases::inbox::{conversations, people};
    use jt_inbox::*;
    use jt_tenancy::WorkspaceStatus;
    let w = active_world().await;
    let p=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()).await.unwrap();
    let cap = w.declare("sms_line", "SMS").await;
    let id = ConversationId::new_v7();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: w.ws,
            person_id: p.person.id,
            capability_id: cap.capability.id,
            kind_key: "sms_line".into(),
            state: ConvState::Ours,
            executor: Executor::Human { user_id: None },
            executor_generation: 0,
            last_inbound_at: Some(w.owner_ctx.now),
            last_outbound_at: None,
            created_at: w.owner_ctx.now,
            updated_at: w.owner_ctx.now,
        })
        .await
        .unwrap();
    let j = r.journeys().open_for(p.person.id).await.unwrap().unwrap();
    let task_id = TaskId::new_v7();
    r.tasks()
        .insert(Task {
            id: task_id,
            workspace_id: w.ws,
            journey_id: j.id,
            title: "Follow up".into(),
            due_at: w.owner_ctx.now,
            assignee: None,
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let before = w.uow.snapshot().ledger.len();
    let first = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(first, work::pending(&w.deps, &w.owner_ctx).await.unwrap());
    assert_eq!(w.uow.snapshot().ledger.len(), before);
    assert!(matches!(first.items[0].kind, WorkKind::ConsultStrategy));
    assert!(first.items.iter().any(|i| i.kind
        == WorkKind::ReplyDue {
            conversation_id: id
        }
        && i.priority == 2));
    assert!(
        first
            .items
            .iter()
            .any(|i| i.kind == WorkKind::TaskDue { task_id } && i.priority == 3)
    );
    let other=people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Other","identities":[{"channel":"email","value":"merge@example.test"}],"source":"form"})).unwrap()).await.unwrap();
    let merge = people::add_identity(
        &w.deps,
        &w.owner_ctx,
        p.person.id,
        serde_json::from_value(json!({"channel":"email","value":"merge@example.test"})).unwrap(),
    )
    .await
    .unwrap();
    let merge_id: MergeId =
        serde_json::from_value(merge["merge_suggestion"]["id"].clone()).unwrap();
    assert_ne!(other.person.id, p.person.id);
    assert!(
        work::pending(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| i.kind == WorkKind::MergeSuggested { merge_id } && i.priority == 3)
    );
    jt_app::usecases::inbox::journeys::report(
        &w.deps,
        &w.owner_ctx,
        j.id,
        serde_json::from_value(
            json!({"kind":"lost","idempotency_key":"lost-work","payload":{"reason_key":"fiyat"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.conversations()
        .update_state(id, ConvState::Ours, None)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let lost = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(lost.items.iter().any(|i| i.kind
        == WorkKind::ReopenQuestion {
            conversation_id: id
        }
        && i.priority == 2));
    assert!(
        !lost
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ReplyDue { .. }))
    );
    conversations::close(&w.deps, &w.owner_ctx, id)
        .await
        .unwrap();
    assert!(
        !work::pending(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ReplyDue { .. }))
    );
    let mut p = w.uow.platform().await.unwrap();
    p.workspace_set_status(w.ws, WorkspaceStatus::PendingPayment)
        .await
        .unwrap();
    p.commit().await.unwrap();
    let held = work::pending(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(!held.items.iter().any(|i| matches!(
        i.kind,
        WorkKind::ReplyDue { .. }
            | WorkKind::ReopenQuestion { .. }
            | WorkKind::MergeSuggested { .. }
            | WorkKind::TaskDue { .. }
    )));
    assert!(
        held.items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::ConsultStrategy))
    );
}
