//! The device bridge's flows (`jt_app::usecases::devices::bridge`) over a unit of work, run
//! against the in-memory fake and PostgreSQL: a bridge that registers many phones and leaves one
//! out, two bridges that see one phone, and results from the bridge a command was leased to. The
//! bridges call as their use cases see them ([`bridge_at`]): a key id and the bridge's context.
use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::ports::UnitOfWork;
use jt_app::ports::devices::{
    CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceCommandRow, NewDeviceCommand,
};
use jt_app::usecases::Deps;
use jt_app::usecases::devices::bridge::{
    self, BridgeCaller, CommandsQuery, DEVICE_BRIDGE, HELD_FOR, RegisterIn, RegisterOut, ResultsIn,
    ResultsOut,
};
use jt_capability::{Capability, CapabilityId};
use jt_device_protocol::{
    CommandResult, FailReason, Outcome, PHONE_HELD_BY_ANOTHER_BRIDGE, PhoneReport, Platform,
    RefusedPhone, ResultIn,
};
use jt_ledger::Actor;
use jt_tenancy::{ApiKeyId, Permission, WorkspaceId};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::fakes::{FIXED_NOW, deps};
use crate::inbox_contract::Fixture;

/// `FIXED_NOW` plus `s` seconds.
fn at(s: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(s)
}

/// The device bridge with key `bridge` calling in workspace `ws` at `now`.
pub fn bridge_at(ws: WorkspaceId, bridge: ApiKeyId, now: OffsetDateTime) -> BridgeCaller {
    BridgeCaller {
        ctx: Ctx {
            workspace_id: ws,
            actor: Actor::System {
                component: DEVICE_BRIDGE.component.into(),
            },
            permissions: BTreeSet::from([Permission::DevicesBridge]),
            role_key: None,
            now,
            agent_connection_id: None,
        },
        bridge,
    }
}

/// An Android phone with serial `serial` that taps.
fn phone(serial: &str) -> PhoneReport {
    PhoneReport {
        platform: Platform::Android,
        serial: serial.into(),
        model: Some("Pixel".into()),
        os_version: Some("14".into()),
        screen: None,
        features: vec!["tap".into()],
    }
}

/// A registration of `serials` by `b`, which must succeed.
async fn register(d: &Deps, b: &BridgeCaller, serials: &[&str]) -> RegisterOut {
    let input = RegisterIn {
        bridge_id: "PC".into(),
        version: "0.1.0".into(),
        protocol: 1,
        phones: serials.iter().map(|s| phone(s)).collect(),
        instance: None,
    };
    bridge::register(d, b, input).await.unwrap()
}

fn serials(out: &RegisterOut) -> Vec<&str> {
    out.phones.iter().map(|p| p.serial.as_str()).collect()
}

fn caps(out: &RegisterOut) -> Vec<CapabilityId> {
    out.phones
        .iter()
        .map(|p| CapabilityId(p.capability_id))
        .collect()
}

/// A tap queued for `phone` at `FIXED_NOW`; its id.
async fn enqueue(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, phone: CapabilityId) -> Uuid {
    let id = Uuid::now_v7();
    let mut t = uow.tenant(ws).await.unwrap();
    t.device_commands()
        .enqueue(NewDeviceCommand {
            id,
            capability_id: phone,
            command: DeviceCommand::Tap { x: 1, y: 1 },
            requested_by: Actor::System {
                component: "devices_bridge_contract".into(),
            },
            created_at: FIXED_NOW,
            expires_at: FIXED_NOW + DEFAULT_EXPIRES_IN,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    id
}

/// The ids `b`'s poll that does not wait hands out.
async fn poll(d: &Deps, b: &BridgeCaller) -> Vec<Uuid> {
    let query = CommandsQuery {
        wait_s: 0,
        limit: 20,
        instance: None,
    };
    let out = bridge::commands(d, b, query).await.unwrap();
    out.commands.iter().map(|c| c.id).collect()
}

/// `b` reports command `id` done (`ok`) or failed.
async fn report(d: &Deps, b: &BridgeCaller, id: Uuid, ok: bool) -> ResultsOut {
    let outcome = if ok {
        Outcome::Done {
            result: CommandResult::Done {},
        }
    } else {
        Outcome::failed(FailReason::AdbError, "stale")
    };
    let results = vec![ResultIn {
        command_id: id,
        outcome,
        duration_ms: 1,
    }];
    bridge::results(d, b, ResultsIn { results }).await.unwrap()
}

fn counted(applied: u32, duplicates: u32, unknown: u32) -> ResultsOut {
    ResultsOut {
        applied,
        duplicates,
        unknown,
    }
}

async fn row(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: Uuid) -> DeviceCommandRow {
    let mut t = uow.tenant(ws).await.unwrap();
    t.device_commands().get(id).await.unwrap().unwrap()
}

async fn capability(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: CapabilityId) -> Capability {
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().find(id).await.unwrap().unwrap()
}

/// Phone `id`'s `connector_public.device.{key}`.
async fn device(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: CapabilityId, key: &str) -> Value {
    capability(uow, ws, id).await.connector_public["device"][key].clone()
}

fn held(serial: &str) -> RefusedPhone {
    RefusedPhone {
        platform: Platform::Android,
        serial: serial.into(),
        reason: PHONE_HELD_BY_ANOTHER_BRIDGE.into(),
    }
}

/// A bridge registers three phones; the commands of all three are its. Leaving one out, it is
/// leased nothing for that one from the next poll on, while the others are; listing it again, it
/// is. A result for a command it was leased counts though it left the phone out since.
pub async fn many_phones_register_lease_and_one_is_left_out(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let d = deps(uow.clone());
    let a = ApiKeyId::new_v7();
    let out = register(&d, &bridge_at(f.ws, a, at(0)), &["SER1", "SER2", "SER3"]).await;
    assert_eq!(serials(&out), ["SER1", "SER2", "SER3"]);
    assert!(out.refused.is_empty());
    let [one, two, three] = caps(&out).try_into().unwrap();
    let (c1, c2, c3) = (
        enqueue(&uow, f.ws, one).await,
        enqueue(&uow, f.ws, two).await,
        enqueue(&uow, f.ws, three).await,
    );

    register(&d, &bridge_at(f.ws, a, at(15)), &["SER1", "SER3"]).await;
    for (id, listed) in [(one, true), (two, false), (three, true)] {
        assert_eq!(device(&uow, f.ws, id, "listed").await, listed, "{id}");
        assert_eq!(device(&uow, f.ws, id, "listed_by").await, a.to_string());
    }
    assert_eq!(poll(&d, &bridge_at(f.ws, a, at(16))).await, [c1, c3]);
    assert_eq!(row(&uow, f.ws, c2).await.status, CommandStatus::Queued);
    for id in [c1, c3] {
        let answered = report(&d, &bridge_at(f.ws, a, at(17)), id, true).await;
        assert_eq!(answered, counted(1, 0, 0));
    }

    register(&d, &bridge_at(f.ws, a, at(30)), &["SER1", "SER2", "SER3"]).await;
    assert_eq!(poll(&d, &bridge_at(f.ws, a, at(31))).await, [c2]);
    register(&d, &bridge_at(f.ws, a, at(45)), &["SER1", "SER3"]).await;
    let answered = report(&d, &bridge_at(f.ws, a, at(46)), c2, true).await;
    assert_eq!(answered, counted(1, 0, 0));
    assert_eq!(row(&uow, f.ws, c2).await.status, CommandStatus::Done);
}

/// Two bridges see a phone of one serial: the one that registered it first holds it, the other is
/// refused it and leases nothing for it. Once the holder leaves it out, the other takes it over on
/// its next registration; once the holder stops registering for longer than `HELD_FOR`, too.
pub async fn two_bridges_never_hold_one_phone(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let d = deps(uow.clone());
    let (a, b) = (ApiKeyId::new_v7(), ApiKeyId::new_v7());
    let out = register(&d, &bridge_at(f.ws, a, at(0)), &["emulator-5554"]).await;
    let p = caps(&out)[0];

    let refused = register(&d, &bridge_at(f.ws, b, at(1)), &["emulator-5554"]).await;
    assert!(refused.phones.is_empty());
    assert_eq!(refused.refused, [held("emulator-5554")]);
    assert_eq!(device(&uow, f.ws, p, "listed_by").await, a.to_string());
    let id = enqueue(&uow, f.ws, p).await;
    assert!(poll(&d, &bridge_at(f.ws, b, at(2))).await.is_empty());
    assert_eq!(poll(&d, &bridge_at(f.ws, a, at(2))).await, [id]);
    report(&d, &bridge_at(f.ws, a, at(3)), id, true).await;

    // The holder leaves it out: the other bridge's next registration takes it over.
    register(&d, &bridge_at(f.ws, a, at(15)), &[]).await;
    let taken = register(&d, &bridge_at(f.ws, b, at(16)), &["emulator-5554"]).await;
    assert_eq!(caps(&taken), [p]);
    assert_eq!(device(&uow, f.ws, p, "listed_by").await, b.to_string());
    assert_eq!(device(&uow, f.ws, p, "listed").await, true);

    // The first cannot take it back while the new holder registers it...
    let back = register(&d, &bridge_at(f.ws, a, at(30)), &["emulator-5554"]).await;
    assert_eq!(back.refused, [held("emulator-5554")]);
    // ...but can once it has not registered it for longer than `HELD_FOR`.
    let silent = 16 + HELD_FOR.whole_seconds() + 1;
    let back = register(&d, &bridge_at(f.ws, a, at(silent)), &["emulator-5554"]).await;
    assert_eq!(caps(&back), [p]);
    assert_eq!(device(&uow, f.ws, p, "listed_by").await, a.to_string());
}

/// A bridge reports for the commands it was leased; for any other only when it holds the
/// command's phone now (its key was replaced). An old bridge's stale result for a command
/// redelivered to the phone's new bridge is unknown, and the new bridge's real one is applied.
pub async fn a_result_counts_from_the_lease_holder_or_the_phones_bridge(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let d = deps(uow.clone());
    let (old, new, stranger) = (ApiKeyId::new_v7(), ApiKeyId::new_v7(), ApiKeyId::new_v7());
    let p = caps(&register(&d, &bridge_at(f.ws, old, at(0)), &["SER1"]).await)[0];
    let id = enqueue(&uow, f.ws, p).await;
    assert_eq!(poll(&d, &bridge_at(f.ws, old, at(1))).await, [id]);

    // The old PC leaves the phone out (its worker is stuck); the new one takes it over and is
    // handed the command again.
    register(&d, &bridge_at(f.ws, old, at(15)), &[]).await;
    register(&d, &bridge_at(f.ws, new, at(16)), &["SER1"]).await;
    assert_eq!(poll(&d, &bridge_at(f.ws, new, at(17))).await, [id]);
    assert_eq!(row(&uow, f.ws, id).await.leased_by, Some(new));

    // The old PC's stale failure, and a stranger's result, are unknown; the new PC's counts.
    for (by, ok) in [(old, false), (stranger, true)] {
        let answered = report(&d, &bridge_at(f.ws, by, at(18)), id, ok).await;
        assert_eq!(answered, counted(0, 0, 1));
    }
    assert_eq!(row(&uow, f.ws, id).await.status, CommandStatus::Leased);
    let answered = report(&d, &bridge_at(f.ws, new, at(19)), id, true).await;
    assert_eq!(answered, counted(1, 0, 0));
    assert_eq!(row(&uow, f.ws, id).await.status, CommandStatus::Done);

    // The new bridge's key is replaced: the bridge with the new key holds the phone after the
    // old key leaves it out, and reports for a lease of the old key.
    let next = enqueue(&uow, f.ws, p).await;
    assert_eq!(poll(&d, &bridge_at(f.ws, new, at(20))).await, [next]);
    let replaced = ApiKeyId::new_v7();
    register(&d, &bridge_at(f.ws, new, at(21)), &[]).await;
    register(&d, &bridge_at(f.ws, replaced, at(22)), &["SER1"]).await;
    let answered = report(&d, &bridge_at(f.ws, replaced, at(23)), next, true).await;
    assert_eq!(answered, counted(1, 0, 0));
}
