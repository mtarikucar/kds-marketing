//! A rep's click-to-call (V0-T2): the fence, run when the session is made and again right before
//! the PBX is asked, every refusal's stable reason and its single ledger entry, and numbers that
//! never leave unmasked.
mod support;

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::SendReceipt;
use jt_app::usecases::calls::{self, EndInput, PlaceInput};
use jt_app::usecases::inbox::people;
use jt_calls::{CallPolicy, CallState};
use jt_capability::{Capability, CapabilityId, Hours, NewCapability, Policy, StoredStatus};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_inbox::{
    Channel, Consent, ConsentId, ConsentKind, ConsentSource, Suppression, SuppressionReason,
    SyncState,
};
use jt_testkit::fakes::{ConnectorCall, ScriptedConnector, ScriptedRegistry};
use serde_json::{Value, json};
use support::*;

/// The number of the person called, as stored.
const E164: &str = "+905321234567";

struct Rig {
    w: World,
    netgsm: Arc<ScriptedConnector>,
    pbx: CapabilityId,
    person: jt_inbox::PersonId,
}

/// An active workspace with an approved strategy, a verified NetGSM PBX (recording allowed) and a
/// person with a phone number and İYS phone consent.
async fn rig_with(policy: Policy, consent: Option<ConsentKind>) -> Rig {
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
            connector_public: json!({ "provider": "netgsm", "recording_allowed": true }),
            policy,
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
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let pbx = cap.id;
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    if let Some(kind) = consent {
        r.consents()
            .insert(Consent {
                id: ConsentId::new_v7(),
                person_id: p.id,
                channel: Channel::Phone,
                kind,
                source: ConsentSource::IysSync,
                at: now - time::Duration::days(1),
                sync_state: SyncState::Sent,
                attempts: 0,
            })
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    Rig {
        w,
        netgsm,
        pbx,
        person: p.id,
    }
}

async fn rig() -> Rig {
    rig_with(Policy::default(), Some(ConsentKind::Explicit)).await
}

fn commercial(r: &Rig) -> PlaceInput {
    serde_json::from_value(json!({
        "person_id": r.person,
        "purpose": "commercial",
        "mode": "human",
        "rep_extension": "101",
    }))
    .unwrap()
}

fn accepted(r: &Rig, crm: &str) {
    r.netgsm.push_click_to_call(Ok(SendReceipt {
        provider_id: crm.into(),
        cost_minor: None,
    }));
}

/// The refusal reason of a call that must be refused.
fn reason<T: std::fmt::Debug>(result: Result<T, jt_app::error::AppError>) -> String {
    let e = result.expect_err("a refusal");
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    e.details["reason"].as_str().unwrap().to_owned()
}

fn clicks(r: &Rig) -> Vec<ConnectorCall> {
    r.netgsm
        .calls()
        .into_iter()
        .filter(|c| matches!(c, ConnectorCall::ClickToCall { .. }))
        .collect()
}

#[tokio::test]
async fn human_click_to_call_originates_rep_then_customer() {
    let r = rig().await;
    accepted(&r, "crm-1");
    let out = calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r))
        .await
        .unwrap();
    assert_eq!(out.call["state"], "dialing");
    assert_eq!(out.call["crm_id"], "crm-1");
    assert_eq!(
        out.call["mode"],
        json!({ "kind": "human", "rep_extension": "101" })
    );
    // The PBX rang the rep's extension, then the person's number, and was told the workspace's
    // recording policy (`connector.set_pbx_policy` writes it; the adapter reads it).
    match &clicks(&r)[..] {
        [
            ConnectorCall::ClickToCall {
                from_ext,
                to,
                public,
                ..
            },
        ] => {
            assert_eq!(from_ext, "101");
            assert_eq!(to, E164);
            assert_eq!(public["recording_allowed"], true);
            assert_eq!(public["kind_key"], "netgsm_pbx");
        }
        other => panic!("one click-to-call: {other:?}"),
    }
    // The call is in the log, with a ledger entry naming no number.
    let listed = calls::list(&r.w.deps, &r.w.owner_ctx, Default::default())
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    let placed = r.w.entries("calls.placed");
    assert_eq!(placed.len(), 1);
    assert!(!placed[0].payload.to_string().contains("5321234567"));
    assert_eq!(placed[0].payload["purpose"], "commercial");
    assert_eq!(placed[0].payload["capability_id"], json!(r.pbx));
}

#[tokio::test]
async fn fence_reevaluated_before_dial() {
    let r = rig().await;
    // A suppression lands right after the first fence passed (the session is being made): the
    // second fence, in the dial transaction, sees it and the PBX is never asked.
    let (person, ws) = (r.person, r.w.ws);
    r.w.uow.after_call_insert(move |s| {
        s.inbox.suppressions.push((
            ws,
            Suppression {
                person_id: person,
                channel: Channel::Phone,
                reason: SuppressionReason::Manual,
            },
        ))
    });
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "suppressed"
    );
    assert!(clicks(&r).is_empty());
    let sessions = r.w.uow.snapshot().calls.sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].state, CallState::Ended);
    assert_eq!(
        serde_json::to_value(&sessions[0].end_cause).unwrap(),
        json!({ "cause": "refused", "detail": "suppressed" })
    );
    let refused = r.w.entries("calls.refused");
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].payload["reason"], "suppressed");
    assert_eq!(refused[0].payload["call_id"], json!(sessions[0].id));
}

#[tokio::test]
async fn commercial_without_arama_consent_refused() {
    let r = rig_with(Policy::default(), None).await;
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "consent_missing"
    );
    // SMS consent is not phone (ARAMA) consent.
    let mut t = r.w.uow.tenant(r.w.ws).await.unwrap();
    t.consents()
        .insert(Consent {
            id: ConsentId::new_v7(),
            person_id: r.person,
            channel: Channel::Sms,
            kind: ConsentKind::Explicit,
            source: ConsentSource::IysSync,
            at: r.w.owner_ctx.now - time::Duration::days(1),
            sync_state: SyncState::Sent,
            attempts: 0,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "consent_missing"
    );
    assert!(clicks(&r).is_empty());
    assert!(r.w.uow.snapshot().calls.sessions.is_empty());
}

#[tokio::test]
async fn service_call_needs_relationship() {
    let r = rig_with(Policy::default(), None).await;
    let mut input = commercial(&r);
    input.purpose = jt_calls::CallPurpose::Service;
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, input).await),
        "no_relationship"
    );
}

#[tokio::test]
async fn callback_needs_recent_inbound() {
    let r = rig().await;
    let mut input = commercial(&r);
    input.purpose = jt_calls::CallPurpose::Callback;
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, input).await),
        "no_recent_inbound"
    );
}

#[tokio::test]
async fn outside_hours_refused() {
    // FIXED_NOW is a weekday morning in Istanbul; the PBX takes calls only on Sundays.
    let hours = Policy {
        active_hours: Some(Hours {
            tz: "Europe/Istanbul".into(),
            days: vec![7],
            from: 9,
            to: 17,
        }),
        ..Policy::default()
    };
    let r = rig_with(hours, Some(ConsentKind::Explicit)).await;
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "outside_work_hours"
    );
}

#[tokio::test]
async fn daily_cap_refused() {
    let r = rig_with(
        Policy {
            daily_ops_cap: Some(1),
            ..Policy::default()
        },
        Some(ConsentKind::Explicit),
    )
    .await;
    accepted(&r, "crm-1");
    let first = calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r))
        .await
        .unwrap();
    // The rep's line is free again once the first call ended.
    let id = serde_json::from_value(first.call["id"].clone()).unwrap();
    calls::end(
        &r.w.deps,
        &r.w.owner_ctx,
        id,
        serde_json::from_value::<EndInput>(json!({ "outcome": "no_answer" })).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "daily_ops_cap"
    );
    assert_eq!(clicks(&r).len(), 1);
}

#[tokio::test]
async fn budget_exhausted_refused() {
    let r = rig().await;
    let policy = CallPolicy {
        estimated_minor_per_minute: 150,
        ..CallPolicy::default()
    };
    calls::policy_set(&r.w.deps, &r.w.owner_ctx, calls::PolicyInput(policy))
        .await
        .unwrap();
    // A known tariff and no budget item linked to the PBX: nothing can pay for a minute.
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "budget_exhausted"
    );
}

#[tokio::test]
async fn lost_journey_refused() {
    let r = rig().await;
    let person = r.person;
    let mut found = false;
    r.w.uow.edit(|s| {
        for j in s
            .inbox
            .journeys
            .iter_mut()
            .filter(|j| j.person_id == person)
        {
            j.status = jt_inbox::JourneyStatus::Lost;
            found = true;
        }
    });
    assert!(found, "people::create opens a journey");
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await),
        "journey_lost"
    );
}

/// Every string anywhere in `value`.
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| strings(v, out)),
        _ => {}
    }
}

#[tokio::test]
async fn outputs_mask_e164() {
    let r = rig().await;
    accepted(&r, "crm-1");
    let agent = r.w.agent(&[]).await;
    let out = calls::place(&r.w.deps, &agent, commercial(&r))
        .await
        .unwrap();
    let id = serde_json::from_value(out.call["id"].clone()).unwrap();
    let mut seen = Vec::new();
    strings(&serde_json::to_value(&out).unwrap(), &mut seen);
    strings(
        &serde_json::to_value(calls::get(&r.w.deps, &agent, id).await.unwrap()).unwrap(),
        &mut seen,
    );
    for row in calls::list(&r.w.deps, &agent, Default::default())
        .await
        .unwrap()
    {
        strings(&row, &mut seen);
    }
    for entry in r.w.ledger("calls.") {
        strings(&entry.payload, &mut seen);
    }
    assert!(seen.iter().all(|s| !s.contains("5321234567")), "{seen:?}");
    assert_eq!(out.call["counterpart"], "+90 5** *** ** 67");
    // A person holding calls.manage sees the number in one call's view, an agent never does.
    let owner_view = calls::get(&r.w.deps, &r.w.owner_ctx, id).await.unwrap();
    assert_eq!(owner_view.call["counterpart_e164"], E164);
    let agent_view = calls::get(&r.w.deps, &agent, id).await.unwrap();
    assert!(agent_view.call.get("counterpart_e164").is_none());
}

#[tokio::test]
async fn refusal_is_ledgered_once() {
    let r = rig_with(Policy::default(), None).await;
    reason(calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r)).await);
    let refused = r.w.entries("calls.refused");
    assert_eq!(refused.len(), 1);
    assert_eq!(
        refused[0].payload,
        json!({ "reason": "consent_missing", "purpose": "commercial", "mode": "human" })
    );
    assert!(r.w.entries("calls.placed").is_empty());
}

#[tokio::test]
async fn provider_failure_ends_the_call_with_its_line() {
    let r = rig().await;
    r.netgsm.push_click_to_call(Err(ConnectorError::auth(
        "HTTP 401 Kullanici dogrulanamadi",
    )));
    let out = calls::place(&r.w.deps, &r.w.owner_ctx, commercial(&r))
        .await
        .unwrap();
    assert_eq!(out.call["state"], "ended");
    assert_eq!(
        out.call["end_cause"],
        json!({ "cause": "failed", "detail": "auth: netgsm: HTTP 401 Kullanici dogrulanamadi" })
    );
    assert_eq!(r.w.entries("calls.failed")[0].payload["error_kind"], "auth");
    assert!(!out.call.to_string().contains("pbx-private"));
}

#[tokio::test]
async fn agent_mode_waits_for_the_bridge_and_reps_need_calls_work() {
    let r = rig().await;
    let mut input = commercial(&r);
    input.mode = calls::PlaceMode::Agent;
    assert_eq!(
        reason(calls::place(&r.w.deps, &r.w.owner_ctx, input).await),
        "bridge_offline"
    );
    let reader = r.w.agent(&["workspace.read"]).await;
    assert_forbidden(
        &err(calls::place(&r.w.deps, &reader, commercial(&r)).await),
        "calls.work",
    );
    // A rep holds calls.work by default.
    let rep = r.w.member("rep").await;
    accepted(&r, "crm-rep");
    calls::place(&r.w.deps, &rep, commercial(&r)).await.unwrap();
}
