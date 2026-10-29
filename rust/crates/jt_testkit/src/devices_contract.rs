//! The device command queue's contracts, exercised by both adapters: the in-memory fake and
//! PostgreSQL. Races between bundles are not covered here: the fake does not model them.
use crate::{fakes::FIXED_NOW, inbox_contract::Fixture};
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    ports::devices::{
        CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceCommandRow, FailReason, Finish,
        FinishOutcome, NewDeviceCommand, REDELIVER_AFTER,
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_ledger::Actor;
use jt_tenancy::WorkspaceId;
use serde_json::json;
use std::sync::Arc;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// `FIXED_NOW` plus `s` seconds.
fn at(s: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(s)
}

/// A phone of workspace `ws`.
async fn phone(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "phone".into(),
            name: "Phone".into(),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

/// A tap at `(n, n)` for phone `cap`, queued at `FIXED_NOW`, expiring at `expires_at`.
fn tap(cap: CapabilityId, n: u32, expires_at: OffsetDateTime) -> NewDeviceCommand {
    NewDeviceCommand {
        id: Uuid::now_v7(),
        capability_id: cap,
        command: DeviceCommand::Tap { x: n, y: n },
        requested_by: Actor::System {
            component: "devices_contract".into(),
        },
        created_at: FIXED_NOW,
        expires_at,
    }
}

/// Queues `rows` for workspace `ws` in one bundle; the stored rows.
async fn enqueue(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    rows: Vec<NewDeviceCommand>,
) -> Vec<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    let mut stored = Vec::new();
    for row in rows {
        stored.push(t.device_commands().enqueue(row).await.unwrap());
    }
    t.commit().await.unwrap();
    stored
}

/// Leases phone `caps`' commands at `now`, redelivering leases older than `REDELIVER_AFTER`.
async fn lease(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    caps: &[CapabilityId],
    now: OffsetDateTime,
    limit: u32,
) -> Vec<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    let leased = t
        .device_commands()
        .lease(caps, now, now - REDELIVER_AFTER, limit)
        .await
        .unwrap();
    t.commit().await.unwrap();
    leased
}

async fn finish(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    id: Uuid,
    outcome: Finish,
    now: OffsetDateTime,
) -> FinishOutcome {
    let mut t = uow.tenant(ws).await.unwrap();
    let answer = t.device_commands().finish(id, outcome, now).await.unwrap();
    t.commit().await.unwrap();
    answer
}

async fn get(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: Uuid) -> Option<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    t.device_commands().get(id).await.unwrap()
}

async fn expire_due(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Vec<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    let expired = t.device_commands().expire_due(now).await.unwrap();
    t.commit().await.unwrap();
    expired
}

fn ids(rows: &[DeviceCommandRow]) -> Vec<Uuid> {
    rows.iter().map(|r| r.id).collect()
}

fn done() -> Finish {
    Finish::Done {
        result: json!({"kind": "done"}),
    }
}

fn failed(detail: &str) -> Finish {
    Finish::Failed {
        reason: FailReason::AdbError,
        detail: detail.into(),
    }
}

/// Commands are stored as queued and leased in their queue order, whatever their ids and across
/// the phones asked for, at most `limit` at a time; a lease marks each `leased` at its time with
/// one more attempt, and a fresh lease is not handed out again.
pub async fn lease_returns_oldest_first(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (a, b) = (phone(&uow, f.ws).await, phone(&uow, f.ws).await);
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    // Ids that sort the other way round from the queue order.
    let base = Uuid::now_v7().as_u128();
    let [first, second, third] = [(a, 3), (b, 2), (a, 1)].map(|(cap, k)| NewDeviceCommand {
        id: Uuid::from_u128(base + k),
        ..tap(cap, k as u32, expires)
    });
    let queued = enqueue(&uow, f.ws, vec![first.clone(), second, third]).await;
    assert!(queued[0].seq < queued[1].seq && queued[1].seq < queued[2].seq);
    assert!(queued[0].id > queued[2].id);
    assert_eq!(
        queued[0],
        DeviceCommandRow {
            id: first.id,
            workspace_id: f.ws,
            capability_id: a,
            seq: queued[0].seq,
            command: first.command,
            status: CommandStatus::Queued,
            attempts: 0,
            leased_at: None,
            expires_at: expires,
            result: None,
            reason: None,
            detail: None,
            requested_by: first.requested_by,
            created_at: FIXED_NOW,
            done_at: None,
        }
    );
    assert_eq!(get(&uow, f.ws, first.id).await.as_ref(), Some(&queued[0]));

    // No phone asked for: nothing.
    assert!(lease(&uow, f.ws, &[], at(1), 10).await.is_empty());
    let leased = lease(&uow, f.ws, &[b, a], at(1), 2).await;
    assert_eq!(ids(&leased), ids(&queued[..2]));
    for (row, before) in leased.iter().zip(&queued) {
        assert_eq!(
            row,
            &DeviceCommandRow {
                status: CommandStatus::Leased,
                attempts: 1,
                leased_at: Some(at(1)),
                ..before.clone()
            }
        );
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    // The two just leased are not handed out again; the third is.
    assert_eq!(
        ids(&lease(&uow, f.ws, &[a, b], at(2), 10).await),
        ids(&queued[2..])
    );
    assert!(lease(&uow, f.ws, &[a, b], at(3), 10).await.is_empty());
}

/// A lease that went unanswered for less than `REDELIVER_AFTER` is skipped; at
/// `REDELIVER_AFTER` the command is leased again, with one more attempt. A command that ended
/// after a lease is never leased again.
pub async fn lease_skips_fresh_lease_and_redelivers_after_10s(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, expires), tap(p, 2, expires)]).await;
    let (c, d) = (rows[0].id, rows[1].id);
    assert_eq!(ids(&lease(&uow, f.ws, &[p], at(0), 10).await), vec![c, d]);
    assert!(lease(&uow, f.ws, &[p], at(9), 10).await.is_empty());

    let again = lease(&uow, f.ws, &[p], at(10), 10).await;
    assert_eq!(ids(&again), vec![c, d]);
    assert!(
        again
            .iter()
            .all(|r| r.attempts == 2 && r.leased_at == Some(at(10)))
    );
    assert!(lease(&uow, f.ws, &[p], at(15), 10).await.is_empty());

    // Once finished, neither is redelivered, however old its lease.
    assert_eq!(
        finish(&uow, f.ws, c, done(), at(16)).await,
        FinishOutcome::Applied
    );
    assert_eq!(
        finish(&uow, f.ws, d, failed("adb"), at(16)).await,
        FinishOutcome::Applied
    );
    assert!(lease(&uow, f.ws, &[p], at(60), 10).await.is_empty());
    let c = get(&uow, f.ws, c).await.unwrap();
    assert_eq!(
        (c.status, c.attempts, c.leased_at),
        (CommandStatus::Done, 2, Some(at(10)))
    );
}

/// A command is never leased from its expiry on, queued or with a lease nobody answered.
pub async fn lease_never_returns_expired(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, at(5)), tap(p, 2, at(30))]).await;
    let (short, long) = (rows[0].id, rows[1].id);
    assert_eq!(ids(&lease(&uow, f.ws, &[p], at(1), 1).await), vec![short]);
    let late = enqueue(&uow, f.ws, vec![tap(p, 3, at(5))]).await[0].id;
    // `short`'s lease went unanswered and `late` waits, but both expired at 5 s.
    assert_eq!(ids(&lease(&uow, f.ws, &[p], at(12), 10).await), vec![long]);
    // At its expiry exactly, `long` is not leased again either.
    assert!(lease(&uow, f.ws, &[p], at(30), 10).await.is_empty());
    assert_eq!(
        get(&uow, f.ws, late).await.unwrap().status,
        CommandStatus::Queued
    );
}

/// The first result for a leased command is applied and written (the result, or the reason with
/// the detail cut to 300 characters, and the time); any later one is a duplicate and changes
/// nothing.
pub async fn finish_is_idempotent(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, expires), tap(p, 2, expires)]).await;
    let (c, d) = (rows[0].id, rows[1].id);
    lease(&uow, f.ws, &[p], at(1), 10).await;

    assert_eq!(
        finish(&uow, f.ws, c, done(), at(2)).await,
        FinishOutcome::Applied
    );
    let finished = get(&uow, f.ws, c).await.unwrap();
    assert_eq!(
        (
            finished.status,
            finished.result.clone(),
            finished.reason,
            finished.detail.clone(),
            finished.done_at
        ),
        (
            CommandStatus::Done,
            Some(json!({"kind": "done"})),
            None,
            None,
            Some(at(2))
        )
    );

    let long = "ş".repeat(310);
    assert_eq!(
        finish(&uow, f.ws, d, failed(&long), at(3)).await,
        FinishOutcome::Applied
    );
    let failed_row = get(&uow, f.ws, d).await.unwrap();
    assert_eq!(
        (
            failed_row.status,
            failed_row.result.clone(),
            failed_row.reason,
            failed_row.done_at
        ),
        (
            CommandStatus::Failed,
            None,
            Some(FailReason::AdbError),
            Some(at(3))
        )
    );
    assert_eq!(failed_row.detail, Some("ş".repeat(300)));

    for (id, row) in [(c, &finished), (d, &failed_row)] {
        for outcome in [
            Finish::Done {
                result: json!({"kind": "done", "again": true}),
            },
            failed("again"),
        ] {
            assert_eq!(
                finish(&uow, f.ws, id, outcome, at(4)).await,
                FinishOutcome::Duplicate
            );
        }
        assert_eq!(get(&uow, f.ws, id).await.as_ref(), Some(row));
    }
}

/// A result for a command the workspace does not have is unknown, writes nothing, and leaves
/// the bundle fit to commit.
pub async fn finish_unknown_id(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    for outcome in [done(), failed("nobody")] {
        assert_eq!(
            t.device_commands()
                .finish(Uuid::now_v7(), outcome, at(1))
                .await
                .unwrap(),
            FinishOutcome::Unknown
        );
    }
    assert!(t.device_commands().list(p, 10).await.unwrap().is_empty());
    t.commit().await.unwrap();
}

/// A result that arrives after a leased command expired replaces `expired`: the bridge's result
/// is the truth. A second result is then a duplicate.
pub async fn finish_replaces_expired_after_lease(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, at(5)), tap(p, 2, at(5))]).await;
    let (c, d) = (rows[0].id, rows[1].id);
    lease(&uow, f.ws, &[p], at(1), 10).await;
    let expired = expire_due(&uow, f.ws, at(6)).await;
    assert_eq!(ids(&expired), vec![c, d]);
    assert!(
        expired
            .iter()
            .all(|r| r.status == CommandStatus::Expired && r.done_at == Some(at(6)))
    );

    assert_eq!(
        finish(&uow, f.ws, c, done(), at(7)).await,
        FinishOutcome::Applied
    );
    let late = get(&uow, f.ws, c).await.unwrap();
    assert_eq!(
        (late.status, late.result.clone(), late.done_at),
        (
            CommandStatus::Done,
            Some(json!({"kind": "done"})),
            Some(at(7))
        )
    );
    assert_eq!(
        finish(&uow, f.ws, d, failed("late"), at(8)).await,
        FinishOutcome::Applied
    );
    let late = get(&uow, f.ws, d).await.unwrap();
    assert_eq!(
        (late.status, late.reason, late.detail, late.done_at),
        (
            CommandStatus::Failed,
            Some(FailReason::AdbError),
            Some("late".into()),
            Some(at(8))
        )
    );
    assert_eq!(
        finish(&uow, f.ws, c, done(), at(9)).await,
        FinishOutcome::Duplicate
    );
    // Neither is leased again.
    assert!(lease(&uow, f.ws, &[p], at(20), 10).await.is_empty());
}

/// No bridge was ever handed a command still in the queue, or one that expired there: a result
/// for it is unknown, and the command stays as it was.
pub async fn finish_refuses_result_for_never_leased(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(
        &uow,
        f.ws,
        vec![tap(p, 1, FIXED_NOW + DEFAULT_EXPIRES_IN), tap(p, 2, at(5))],
    )
    .await;
    let (queued, lapsed) = (rows[0].clone(), rows[1].id);
    assert_eq!(ids(&expire_due(&uow, f.ws, at(6)).await), vec![lapsed]);
    let lapsed = get(&uow, f.ws, lapsed).await.unwrap();

    for row in [&queued, &lapsed] {
        for outcome in [done(), failed("never leased")] {
            assert_eq!(
                finish(&uow, f.ws, row.id, outcome, at(7)).await,
                FinishOutcome::Unknown
            );
        }
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
}

/// The expiry sweep ends, at its time, exactly the commands that are queued or leased and expire
/// at or before it; finished ones and ones that expire later are left as they are, and a second
/// sweep ends nothing.
pub async fn expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry(
    uow: Arc<dyn UnitOfWork>,
) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(
        &uow,
        f.ws,
        vec![
            tap(p, 1, at(5)),
            tap(p, 2, at(60)),
            tap(p, 3, at(5)),
            tap(p, 4, at(5)),
            tap(p, 5, at(5)),
            tap(p, 6, at(60)),
        ],
    )
    .await;
    let [
        leased_past,
        leased_later,
        done_past,
        failed_past,
        queued_past,
    ] = [0, 1, 2, 3, 4].map(|i| rows[i].id);
    assert_eq!(
        ids(&lease(&uow, f.ws, &[p], at(1), 4).await),
        vec![leased_past, leased_later, done_past, failed_past]
    );
    finish(&uow, f.ws, done_past, done(), at(2)).await;
    finish(&uow, f.ws, failed_past, failed("gone"), at(2)).await;
    // Expires at the sweep's time exactly.
    let queued_at_sweep = enqueue(&uow, f.ws, vec![tap(p, 7, at(10))]).await[0].id;
    let untouched = [
        get(&uow, f.ws, leased_later).await.unwrap(),
        get(&uow, f.ws, done_past).await.unwrap(),
        get(&uow, f.ws, failed_past).await.unwrap(),
        rows[5].clone(),
    ];

    let expired = expire_due(&uow, f.ws, at(10)).await;
    assert_eq!(
        ids(&expired),
        vec![leased_past, queued_past, queued_at_sweep]
    );
    for row in &expired {
        assert_eq!(row.status, CommandStatus::Expired);
        assert_eq!(row.done_at, Some(at(10)));
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert_eq!(expired[0].leased_at, Some(at(1)));
    assert_eq!(expired[1].leased_at, None);
    for row in &untouched {
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert!(expire_due(&uow, f.ws, at(11)).await.is_empty());
    assert_eq!(
        get(&uow, f.ws, leased_past).await.unwrap().done_at,
        Some(at(10))
    );
}

/// Every read and write sees only the bundle's workspace: another workspace's commands are not
/// read, leased, finished or expired, its phones take no command from this one, and an id is
/// taken across workspaces.
pub async fn rows_are_workspace_scoped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (mine_phone, their_phone) = (phone(&uow, f.ws).await, phone(&uow, f.other).await);
    let mine = enqueue(&uow, f.ws, vec![tap(mine_phone, 1, at(5))]).await[0].clone();
    let theirs = enqueue(&uow, f.other, vec![tap(their_phone, 2, at(5))]).await[0].clone();

    let mut t = uow.tenant(f.ws).await.unwrap();
    let commands = t.device_commands();
    assert_eq!(commands.get(theirs.id).await.unwrap(), None);
    assert!(commands.list(their_phone, 10).await.unwrap().is_empty());
    assert_eq!(
        ids(&commands.list(mine_phone, 10).await.unwrap()),
        vec![mine.id]
    );
    assert_eq!(
        ids(&commands
            .lease(&[mine_phone, their_phone], at(1), at(-9), 10)
            .await
            .unwrap()),
        vec![mine.id]
    );
    assert_eq!(
        commands.finish(theirs.id, done(), at(2)).await.unwrap(),
        FinishOutcome::Unknown
    );
    assert_eq!(
        ids(&commands.expire_due(at(10)).await.unwrap()),
        vec![mine.id]
    );
    t.commit().await.unwrap();
    assert_eq!(get(&uow, f.other, theirs.id).await.as_ref(), Some(&theirs));

    // Another workspace's phone is no phone of this one; an id is taken in every workspace.
    let mut t = uow.tenant(f.ws).await.unwrap();
    let err = t
        .device_commands()
        .enqueue(tap(their_phone, 3, at(60)))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    drop(t);
    let mut t = uow.tenant(f.other).await.unwrap();
    let err = t
        .device_commands()
        .enqueue(NewDeviceCommand {
            id: mine.id,
            ..tap(their_phone, 4, at(60))
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    drop(t);
    assert_eq!(
        ids(&lease(&uow, f.other, &[their_phone], at(1), 10).await),
        vec![theirs.id]
    );
}
