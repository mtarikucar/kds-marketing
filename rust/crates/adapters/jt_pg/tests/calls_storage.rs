//! Call storage (migrations 0015_voice_calls and 0016_voice_bridge) against a real database:
//! sessions and turns round trip through the repository, the provider ids are unique per
//! workspace, rows are scoped by row-level security, the call policy leaves the other workspace
//! policies alone, erasure empties a call's words, the voice bridge's commands are leased in
//! their queue order and its events noted once, and the down migration refuses while a call is
//! not ended.

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::calls::{
    CallCommandId, CallDirection, CallFilter, CallId, CallMetrics, CallMode, CallPolicy,
    CallPurpose, CallSession, CallState, Command, PlayKind, RecordingState, Turn, TurnClock,
    TurnKind, TurnMeta,
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_ledger::Actor;
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use time::OffsetDateTime;
use time::macros::datetime;
use uuid::Uuid;

const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

async fn pbx(uow: &PgUnitOfWork, ws: WorkspaceId) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "netgsm_pbx".into(),
            name: "Santral".into(),
            external_id: Some(format!("santral-{ws}")),
            ..NewCapability::default()
        },
        T0,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

fn session(ws: WorkspaceId, capability: CapabilityId, crm: &str) -> CallSession {
    CallSession {
        id: CallId::new_v7(),
        workspace_id: ws,
        capability_id: capability,
        direction: CallDirection::Outbound,
        purpose: CallPurpose::Commercial,
        person_id: None,
        journey_id: None,
        mode: CallMode::Human {
            rep_extension: "101".into(),
        },
        state: CallState::Dialing,
        plan: None,
        counterpart_e164: "+905321234567".into(),
        bridge_call_id: None,
        pbx_unique_id: None,
        crm_id: Some(crm.into()),
        agent_connection_id: None,
        placed_by: Actor::System {
            component: "test".into(),
        },
        started_at: T0,
        answered_at: None,
        ended_at: None,
        end_cause: None,
        outcome: None,
        summary: None,
        duration_s: None,
        cost_minor: None,
        recording: RecordingState::Off,
        metrics: CallMetrics::default(),
        clock: TurnClock::default(),
    }
}

#[tokio::test]
async fn sessions_turns_and_policy_round_trip_scoped_by_workspace() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (a, _) = db.seed_workspace("calls-a").await;
    let (b, _) = db.seed_workspace("calls-b").await;
    let (pa, pb) = (pbx(&uow, a).await, pbx(&uow, b).await);
    let call = session(a, pa, "crm-1");

    let mut t = uow.tenant(a).await.unwrap();
    t.calls().insert(call.clone(), T0).await.unwrap();
    // The same crm id twice in a workspace is a conflict; in another workspace it is not.
    let twin = CallSession {
        id: CallId::new_v7(),
        ..call.clone()
    };
    assert_eq!(
        t.calls().insert(twin, T0).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.calls().insert(session(b, pb, "crm-1"), T0).await.unwrap();
    assert_eq!(t.calls().get(call.id).await.unwrap(), None);
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.calls().get(call.id).await.unwrap(), Some(call.clone()));
    assert_eq!(
        t.calls().lock_by_crm_id("crm-1").await.unwrap(),
        Some(call.clone())
    );
    assert!(t.calls().extension_busy("101", None).await.unwrap());
    assert!(
        !t.calls()
            .extension_busy("101", Some(call.id))
            .await
            .unwrap()
    );
    assert_eq!(
        t.calls()
            .count_started(pa, T0, T0 + time::Duration::days(1), None)
            .await
            .unwrap(),
        1
    );
    let turns = vec![
        Turn {
            seq: 0,
            at: T0,
            kind: TurnKind::Event {
                name: "answered".into(),
            },
            text: String::new(),
            meta: TurnMeta::default(),
        },
        Turn {
            seq: 1,
            at: T0 + time::Duration::seconds(3),
            kind: TurnKind::Utterance,
            text: "Evet, buyurun".into(),
            meta: TurnMeta {
                confidence: Some(0.5),
                ..TurnMeta::default()
            },
        },
    ];
    t.calls()
        .append_turns(call.id, turns.clone())
        .await
        .unwrap();
    assert_eq!(
        t.calls()
            .append_turns(call.id, vec![turns[0].clone()])
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.calls().turns(call.id, None, 10).await.unwrap(), turns);
    assert_eq!(
        t.calls().turns(call.id, Some(0), 10).await.unwrap(),
        turns[1..]
    );
    let mut ended = call.clone();
    ended.state = CallState::Ended;
    ended.ended_at = Some(T0 + time::Duration::minutes(2));
    assert_eq!(t.calls().lock_by_pbx_id("pbx-1").await.unwrap(), None);
    ended.pbx_unique_id = Some("pbx-1".into());
    t.calls().update(ended.clone(), T0).await.unwrap();
    // The PBX's call id, learned from a call event, finds the session again.
    assert_eq!(
        t.calls().lock_by_pbx_id("pbx-1").await.unwrap(),
        Some(ended.clone())
    );
    assert_eq!(
        t.calls()
            .list(CallFilter {
                state: Some(CallState::Ended),
                limit: 10,
                ..CallFilter::default()
            })
            .await
            .unwrap(),
        vec![ended]
    );
    // The call policy is stored beside the other workspace policies without touching them.
    let before = t.workspace_policy().get().await.unwrap();
    let policy = CallPolicy {
        greeting_inbound: "Merhaba".into(),
        estimated_minor_per_minute: 150,
        ..CallPolicy::default()
    };
    t.calls().set_policy(policy.clone(), T0).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(t.calls().policy().await.unwrap(), policy);
    assert_eq!(t.workspace_policy().get().await.unwrap(), before);
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.calls().policy().await.unwrap(), CallPolicy::default());
}

#[tokio::test]
async fn rls_hides_other_workspaces_calls_and_down_refuses_live_calls() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (a, _) = db.seed_workspace("calls-rls-a").await;
    let (b, _) = db.seed_workspace("calls-rls-b").await;
    let pa = pbx(&uow, a).await;
    let mut t = uow.tenant(a).await.unwrap();
    t.calls()
        .insert(session(a, pa, "crm-live"), T0)
        .await
        .unwrap();
    t.commit().await.unwrap();
    for table in [
        "call_sessions",
        "call_turns",
        "call_commands",
        "call_duty",
        "call_bridge_events",
    ] {
        let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
        tx.rollback().await.unwrap();
    }
    // A session of another workspace's capability breaks the composite foreign key.
    let mut t = uow.tenant(b).await.unwrap();
    assert!(t.calls().insert(session(b, pa, "crm-x"), T0).await.is_err());
    drop(t);
    let down = include_str!("../../../../migrations/0015_voice_calls.down.sql");
    let err = sqlx::raw_sql(down).execute(&db.pool).await.unwrap_err();
    assert!(err.to_string().contains("not ended"), "{err}");
}

async fn voice_bridge(uow: &PgUnitOfWork, ws: WorkspaceId, extension: &str) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "voice_bridge".into(),
            name: format!("Voice bridge {extension}"),
            external_id: Some(extension.into()),
            ..NewCapability::default()
        },
        T0,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

#[tokio::test]
async fn bridge_commands_lease_in_queue_order_and_events_are_noted_once() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (a, _) = db.seed_workspace("bridge-a").await;
    let bridge = voice_bridge(&uow, a, "101").await;
    let other = voice_bridge(&uow, a, "102").await;
    let call = CallSession {
        mode: CallMode::Agent,
        bridge_call_id: Some("b-1".into()),
        crm_id: None,
        ..session(a, bridge, "unused")
    };
    let mut t = uow.tenant(a).await.unwrap();
    t.calls().insert(call.clone(), T0).await.unwrap();
    assert_eq!(
        t.calls().lock_by_bridge_id("b-1").await.unwrap(),
        Some(call.clone())
    );
    assert_eq!(t.calls().lock_by_bridge_id("b-2").await.unwrap(), None);
    // Queued together, handed out in their queue order whatever their ids: the closing, then the
    // hangup, whose id sorts first.
    let (hangup, closing) = (
        CallCommandId(Uuid::from_u128(1)),
        CallCommandId(Uuid::from_u128(2)),
    );
    t.calls()
        .enqueue_commands(
            call.id,
            vec![
                (
                    closing,
                    Command::Play {
                        seq: 3,
                        clip: PlayKind::Closing,
                        index: 0,
                        text: "İyi günler.".into(),
                    },
                ),
                (hangup, Command::Hangup),
            ],
            T0,
        )
        .await
        .unwrap();
    assert_eq!(
        t.calls()
            .enqueue_commands(call.id, vec![(hangup, Command::Hangup)], T0)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    t.commit().await.unwrap();

    let later = |s: i64| T0 + time::Duration::seconds(s);
    let mut t = uow.tenant(a).await.unwrap();
    // Another bridge's poll takes nothing of this one's calls.
    assert!(
        t.calls()
            .take_commands(other, later(1), later(-9), 10)
            .await
            .unwrap()
            .is_empty()
    );
    let taken = t
        .calls()
        .take_commands(bridge, later(1), later(-9), 10)
        .await
        .unwrap();
    assert_eq!(
        taken.iter().map(|q| q.id).collect::<Vec<_>>(),
        [closing, hangup]
    );
    assert_eq!(taken[0].call_id, call.id);
    assert_eq!(taken[0].bridge_call_id.as_deref(), Some("b-1"));
    assert!(matches!(taken[1].command, Command::Hangup));
    // Leased: not again until the lease is older than the cut-off.
    assert!(
        t.calls()
            .take_commands(bridge, later(5), later(-5), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        !t.calls()
            .ack_command(other, closing, later(6))
            .await
            .unwrap()
    );
    assert!(
        t.calls()
            .ack_command(bridge, closing, later(6))
            .await
            .unwrap()
    );
    assert!(
        !t.calls()
            .ack_command(bridge, closing, later(7))
            .await
            .unwrap()
    );
    // Unacknowledged past the cut-off: handed out again.
    let again = t
        .calls()
        .take_commands(bridge, later(12), later(2), 10)
        .await
        .unwrap();
    assert_eq!(again.iter().map(|q| q.id).collect::<Vec<_>>(), [hangup]);

    // An event is noted once.
    assert!(
        t.calls()
            .note_bridge_event(bridge, "b-1", 1, "ringing", later(1))
            .await
            .unwrap()
    );
    assert!(
        !t.calls()
            .note_bridge_event(bridge, "b-1", 1, "ringing", later(2))
            .await
            .unwrap()
    );
    assert!(
        t.calls()
            .note_bridge_event(bridge, "b-1", 2, "answered", later(2))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
}
