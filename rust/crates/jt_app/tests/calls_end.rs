//! Ending a rep's call (V0-T2): the outcome goes to the person's journey as `CallMade`, the
//! summary becomes a note, the follow-up a task, and a known duration is charged once.
mod support;

use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::SendReceipt;
use jt_app::usecases::budget::{self, BudgetItemInput};
use jt_app::usecases::calls::{self, EndInput, PlaceInput, PolicyInput};
use jt_app::usecases::inbox::people;
use jt_calls::{CallId, CallPolicy, CallState};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::{
    Channel, Consent, ConsentId, ConsentKind, ConsentSource, JourneyEventKind, SyncState,
};
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use support::*;
use time::Duration;

struct Rig {
    w: World,
    pbx: CapabilityId,
    person: jt_inbox::PersonId,
}

/// A placed, answered rep's call (the PBX's answer is written into the session as its call
/// events would), with a tariff of 150 a started minute and a currency budget on the PBX.
async fn answered_call() -> (Rig, CallId) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(netgsm.clone()));
    let p = people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Ada",
            "identities": [{ "channel": "phone", "value": "05321234567" }],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "netgsm_pbx".into(),
            name: "Santral".into(),
            external_id: Some("santral".into()),
            connector_public: json!({ "provider": "netgsm" }),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    let cred = Credential::NetgsmPbx {
        username: "santral".into(),
        password: "pbx-private".into(),
        trunk: Some("8508401234".into()),
        pbxnum: None,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let pbx = cap.id;
    let item = budget::create_item(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value::<BudgetItemInput>(json!({
            "name": "Santral dakikaları",
            "kind": "cash",
            "unit": { "kind": "currency", "value": "TRY" },
            "cap": 100_000,
            "period": "monthly",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .item
    .id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.budget().link(pbx, item).await.unwrap();
    r.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: p.id,
            channel: Channel::Phone,
            kind: ConsentKind::Explicit,
            source: ConsentSource::IysSync,
            at: now - Duration::days(1),
            sync_state: SyncState::Sent,
            attempts: 0,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let policy = CallPolicy {
        estimated_minor_per_minute: 150,
        ..CallPolicy::default()
    };
    calls::policy_set(&w.deps, &w.owner_ctx, PolicyInput::from(policy))
        .await
        .unwrap();
    netgsm.push_click_to_call(Ok(SendReceipt {
        provider_id: "crm-1".into(),
        cost_minor: None,
    }));
    let placed = calls::place(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value::<PlaceInput>(json!({
            "person_id": p.id,
            "purpose": "commercial",
            "mode": "human",
            "rep_extension": "101",
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let id: CallId = serde_json::from_value(placed.call["id"].clone()).unwrap();
    w.uow.edit(|s| {
        let session = s.calls.sessions.iter_mut().find(|c| c.id == id).unwrap();
        session.state = CallState::Live;
        session.answered_at = Some(now + Duration::seconds(10));
    });
    (
        Rig {
            w,
            pbx,
            person: p.id,
        },
        id,
    )
}

fn ended(outcome: &str) -> EndInput {
    serde_json::from_value(json!({
        "outcome": outcome,
        "summary": "Randevu istedi, perşembe 14:00.",
        "follow_up_task": { "title": "Perşembe randevusunu teyit et", "due_at": "2030-01-02T09:00:00Z" },
    }))
    .unwrap()
}

#[tokio::test]
async fn end_writes_call_made_note_and_spend() {
    let (r, id) = answered_call().await;
    // Ended 95 s after the answer: two started minutes, 300 at 150 a minute.
    let ctx = at(&r.w.owner_ctx, r.w.owner_ctx.now + Duration::seconds(105));
    let out = calls::end(&r.w.deps, &ctx, id, ended("connected"))
        .await
        .unwrap();
    assert_eq!(out.call["state"], "ended");
    assert_eq!(out.call["outcome"], "connected");
    assert_eq!(out.call["duration_s"], 95);
    assert_eq!(out.call["cost_minor"], 300);
    let snapshot = r.w.uow.snapshot();
    let journey = snapshot
        .inbox
        .journeys
        .iter()
        .find(|j| j.person_id == r.person)
        .unwrap();
    let events: Vec<_> = snapshot
        .inbox
        .events
        .iter()
        .filter(|e| e.journey_id == journey.id)
        .collect();
    assert!(
        events
            .iter()
            .any(|e| e.kind == JourneyEventKind::CallMade { connected: true }
                && e.idempotency_key == format!("calls:{id}")),
        "{events:?}"
    );
    assert!(
        snapshot
            .inbox
            .notes
            .iter()
            .any(|n| n.journey_id == journey.id && n.text == "Randevu istedi, perşembe 14:00.")
    );
    assert!(
        snapshot
            .inbox
            .tasks
            .iter()
            .any(|t| t.journey_id == journey.id && t.title == "Perşembe randevusunu teyit et")
    );
    let spend: Vec<_> = snapshot
        .budget_spend
        .iter()
        .filter(|s| s.workspace_id == r.w.ws)
        .collect();
    assert_eq!(spend.len(), 1);
    assert_eq!(spend[0].amount, 300);
    assert_eq!(
        spend[0].reference.as_deref(),
        Some(format!("call:{id}").as_str())
    );
    let ended = r.w.entries("calls.ended");
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].payload["outcome"], "connected");
    assert!(!ended[0].payload.to_string().contains("5321234567"));
    let _ = r.pbx;
}

#[tokio::test]
async fn end_twice_is_idempotent() {
    let (r, id) = answered_call().await;
    let ctx = at(&r.w.owner_ctx, r.w.owner_ctx.now + Duration::seconds(70));
    let first = calls::end(&r.w.deps, &ctx, id, ended("no_answer"))
        .await
        .unwrap();
    let later = at(&ctx, ctx.now + Duration::minutes(5));
    let second = calls::end(&r.w.deps, &later, id, ended("connected"))
        .await
        .unwrap();
    assert_eq!(second.call, first.call);
    let snapshot = r.w.uow.snapshot();
    assert_eq!(snapshot.inbox.notes.len(), 1);
    assert_eq!(
        snapshot
            .budget_spend
            .iter()
            .filter(|s| s.workspace_id == r.w.ws)
            .count(),
        1
    );
    assert_eq!(r.w.entries("calls.ended").len(), 1);
    // A no-answer outcome is a call that did not connect.
    let call_made: Vec<_> = snapshot
        .inbox
        .events
        .iter()
        .filter(|e| matches!(e.kind, JourneyEventKind::CallMade { .. }))
        .collect();
    assert_eq!(call_made.len(), 1);
    assert_eq!(
        call_made[0].kind,
        JourneyEventKind::CallMade { connected: false }
    );
}
