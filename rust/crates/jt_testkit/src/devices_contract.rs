//! The device command queue's contracts, exercised by both adapters: the in-memory fake and
//! PostgreSQL. Races between bundles are not covered here: the fake does not model them, and
//! `jt_pg`'s own tests cover them.
use crate::{fakes::FIXED_NOW, inbox_contract::Fixture};
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    ports::devices::{
        CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceCommandRow, ExpiredCommand,
        FailReason, Finish, Finished, MAX_DETAIL_CHARS, NewDeviceCommand, REDELIVER_AFTER,
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
pub fn at(s: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::seconds(s)
}

/// A new phone of workspace `ws`.
pub async fn phone(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId) -> CapabilityId {
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
pub fn tap(cap: CapabilityId, n: u32, expires_at: OffsetDateTime) -> NewDeviceCommand {
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
pub async fn enqueue(
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

/// A bridge's poll of phones `caps` at `now`, in one bundle: picks what is due (redelivering
/// leases older than `REDELIVER_AFTER`) and marks all of it leased.
pub async fn lease(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    caps: &[CapabilityId],
    now: OffsetDateTime,
    limit: u32,
) -> Vec<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    let picked = t
        .device_commands()
        .pick_due(caps, now, now - REDELIVER_AFTER, limit)
        .await
        .unwrap();
    let leased = t
        .device_commands()
        .mark_leased(&ids(&picked), now)
        .await
        .unwrap();
    assert_eq!(ids(&leased), ids(&picked));
    t.commit().await.unwrap();
    leased
}

/// A bridge of phones `caps` reports `outcome` for command `id` at `now`, in one bundle.
pub async fn finish(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    caps: &[CapabilityId],
    id: Uuid,
    outcome: Finish,
    now: OffsetDateTime,
) -> Finished {
    let mut t = uow.tenant(ws).await.unwrap();
    let answer = t
        .device_commands()
        .finish(caps, id, outcome, now)
        .await
        .unwrap();
    t.commit().await.unwrap();
    answer
}

pub async fn get(uow: &Arc<dyn UnitOfWork>, ws: WorkspaceId, id: Uuid) -> Option<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    t.device_commands().get(id).await.unwrap()
}

async fn expire_due(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Vec<ExpiredCommand> {
    let mut t = uow.tenant(ws).await.unwrap();
    let expired = t.device_commands().expire_due(now).await.unwrap();
    t.commit().await.unwrap();
    expired
}

async fn fail_pending(
    uow: &Arc<dyn UnitOfWork>,
    ws: WorkspaceId,
    ids: &[Uuid],
    detail: &str,
    now: OffsetDateTime,
) -> Vec<DeviceCommandRow> {
    let mut t = uow.tenant(ws).await.unwrap();
    let failed = t
        .device_commands()
        .fail_pending(ids, FailReason::UnsupportedByBridge, detail, now)
        .await
        .unwrap();
    t.commit().await.unwrap();
    failed
}

pub fn ids(rows: &[DeviceCommandRow]) -> Vec<Uuid> {
    rows.iter().map(|r| r.id).collect()
}

fn expired_ids(rows: &[ExpiredCommand]) -> Vec<Uuid> {
    rows.iter().map(|r| r.id).collect()
}

pub fn done() -> Finish {
    Finish::Done {
        result: json!({"kind": "done"}),
    }
}

fn failed(detail: &str) -> Finish {
    Finish::failed(FailReason::AdbError, detail)
}

/// The row of an applied result; panics on any other answer.
fn applied(answer: Finished) -> DeviceCommandRow {
    match answer {
        Finished::Applied(row) => *row,
        other => panic!("the result was not applied: {other:?}"),
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
    applied(finish(&uow, f.ws, &[p], c, done(), at(16)).await);
    applied(finish(&uow, f.ws, &[p], d, failed("adb"), at(16)).await);
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

/// A pick hands out what is due, at most `limit`, as it stands: nothing is marked, and the same
/// commands are picked again by the next bundle.
pub async fn pick_due_does_not_mark(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, expires), tap(p, 2, expires)]).await;
    lease(&uow, f.ws, &[p], at(1), 1).await;
    let stale = get(&uow, f.ws, rows[0].id).await.unwrap();

    for _ in 0..2 {
        let mut t = uow.tenant(f.ws).await.unwrap();
        let commands = t.device_commands();
        // A lease nobody answered and a queued command, as they stand.
        let picked = commands.pick_due(&[p], at(20), at(10), 10).await.unwrap();
        assert_eq!(picked, vec![stale.clone(), rows[1].clone()]);
        assert_eq!(
            commands.pick_due(&[p], at(20), at(10), 1).await.unwrap(),
            vec![stale.clone()]
        );
        assert!(
            commands
                .pick_due(&[], at(20), at(10), 10)
                .await
                .unwrap()
                .is_empty()
        );
        t.commit().await.unwrap();
    }
    assert_eq!(get(&uow, f.ws, rows[1].id).await.as_ref(), Some(&rows[1]));
}

/// Marking leases only the given commands that are still queued or leased, at its time with one
/// more attempt; ended, unknown and other workspaces' ids are passed over.
pub async fn mark_leased_marks_only_still_pending(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (p, their_phone) = (phone(&uow, f.ws).await, phone(&uow, f.other).await);
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(
        &uow,
        f.ws,
        vec![
            tap(p, 1, expires),
            tap(p, 2, expires),
            tap(p, 3, expires),
            tap(p, 4, expires),
            tap(p, 5, at(5)),
        ],
    )
    .await;
    let [leased, done_id, failed_id, queued, expired] = [0, 1, 2, 3, 4].map(|i| rows[i].id);
    lease(&uow, f.ws, &[p], at(1), 2).await;
    applied(finish(&uow, f.ws, &[p], done_id, done(), at(2)).await);
    fail_pending(&uow, f.ws, &[failed_id], "refused", at(2)).await;
    expire_due(&uow, f.ws, at(6)).await;
    let theirs = enqueue(&uow, f.other, vec![tap(their_phone, 6, expires)]).await[0].clone();
    let mut before = Vec::new();
    for id in [done_id, failed_id, expired] {
        before.push(get(&uow, f.ws, id).await.unwrap());
    }

    let mut t = uow.tenant(f.ws).await.unwrap();
    let marked = t
        .device_commands()
        .mark_leased(
            &[
                queued,
                expired,
                theirs.id,
                done_id,
                Uuid::now_v7(),
                failed_id,
                leased,
            ],
            at(20),
        )
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(ids(&marked), vec![leased, queued]);
    assert_eq!(
        marked
            .iter()
            .map(|r| (r.status, r.attempts, r.leased_at))
            .collect::<Vec<_>>(),
        vec![
            (CommandStatus::Leased, 2, Some(at(20))),
            (CommandStatus::Leased, 1, Some(at(20)))
        ]
    );
    for row in marked.iter().chain(&before) {
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert_eq!(get(&uow, f.other, theirs.id).await.as_ref(), Some(&theirs));
}

/// A failure the server decides ends the given commands that are still queued or leased, with
/// the reason and the detail cut to 300 characters, and leaves their lease time and attempts as
/// they were: a refused command is never marked leased. Ended, unknown and other workspaces' ids
/// are passed over, and a bridge's result for a command failed in the queue is unknown.
pub async fn fail_pending_never_sets_leased_at_and_skips_finished(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (p, their_phone) = (phone(&uow, f.ws).await, phone(&uow, f.other).await);
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(
        &uow,
        f.ws,
        vec![
            tap(p, 1, expires),
            tap(p, 2, expires),
            tap(p, 3, expires),
            tap(p, 4, at(5)),
        ],
    )
    .await;
    let [leased, done_id, queued, expired] = [0, 1, 2, 3].map(|i| rows[i].id);
    lease(&uow, f.ws, &[p], at(1), 2).await;
    applied(finish(&uow, f.ws, &[p], done_id, done(), at(2)).await);
    expire_due(&uow, f.ws, at(6)).await;
    let theirs = enqueue(&uow, f.other, vec![tap(their_phone, 5, expires)]).await[0].clone();
    let untouched = [
        get(&uow, f.ws, done_id).await.unwrap(),
        get(&uow, f.ws, expired).await.unwrap(),
    ];
    let before_lease = get(&uow, f.ws, leased).await.unwrap();

    let long = "ş".repeat(MAX_DETAIL_CHARS + 10);
    let ended = fail_pending(
        &uow,
        f.ws,
        &[done_id, theirs.id, queued, Uuid::now_v7(), expired, leased],
        &long,
        at(7),
    )
    .await;
    assert_eq!(ids(&ended), vec![leased, queued]);
    for (row, before) in ended.iter().zip([&before_lease, &rows[2]]) {
        assert_eq!(
            row,
            &DeviceCommandRow {
                status: CommandStatus::Failed,
                reason: Some(FailReason::UnsupportedByBridge),
                detail: Some("ş".repeat(MAX_DETAIL_CHARS)),
                done_at: Some(at(7)),
                ..before.clone()
            }
        );
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert_eq!(ended[1].leased_at, None);
    assert_eq!(ended[1].attempts, 0);
    for row in &untouched {
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert_eq!(get(&uow, f.other, theirs.id).await.as_ref(), Some(&theirs));
    // Ended once: not again, not picked, and no bridge's result is applied to it.
    assert!(
        fail_pending(&uow, f.ws, &[queued, leased], "again", at(8))
            .await
            .is_empty()
    );
    assert!(lease(&uow, f.ws, &[p], at(60), 10).await.is_empty());
    assert_eq!(
        finish(&uow, f.ws, &[p], queued, done(), at(9)).await,
        Finished::Unknown
    );
    assert_eq!(
        finish(&uow, f.ws, &[p], leased, done(), at(9)).await,
        Finished::Duplicate
    );
}

/// The first result for a leased command is applied and written (the result, or the reason with
/// the detail cut to 300 characters, and the time) and answered with the row as it now stands;
/// any later one is a duplicate and changes nothing.
pub async fn finish_is_idempotent(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, expires), tap(p, 2, expires)]).await;
    let (c, d) = (rows[0].id, rows[1].id);
    lease(&uow, f.ws, &[p], at(1), 10).await;

    let finished = applied(finish(&uow, f.ws, &[p], c, done(), at(2)).await);
    assert_eq!(get(&uow, f.ws, c).await.as_ref(), Some(&finished));
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

    // A detail longer than the table keeps is cut, by the constructor or else by the store.
    let long = "ş".repeat(MAX_DETAIL_CHARS + 10);
    assert_eq!(
        failed(&long),
        Finish::Failed {
            reason: FailReason::AdbError,
            detail: "ş".repeat(MAX_DETAIL_CHARS),
        }
    );
    let uncut = Finish::Failed {
        reason: FailReason::AdbError,
        detail: long,
    };
    let failed_row = applied(finish(&uow, f.ws, &[p], d, uncut, at(3)).await);
    assert_eq!(get(&uow, f.ws, d).await.as_ref(), Some(&failed_row));
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
    assert_eq!(failed_row.detail, Some("ş".repeat(MAX_DETAIL_CHARS)));

    for (id, row) in [(c, &finished), (d, &failed_row)] {
        for outcome in [
            Finish::Done {
                result: json!({"kind": "done", "again": true}),
            },
            failed("again"),
        ] {
            assert_eq!(
                finish(&uow, f.ws, &[p], id, outcome, at(4)).await,
                Finished::Duplicate
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
                .finish(&[p], Uuid::now_v7(), outcome, at(1))
                .await
                .unwrap(),
            Finished::Unknown
        );
    }
    assert!(t.device_commands().list(p, 10).await.unwrap().is_empty());
    t.commit().await.unwrap();
}

/// A result for a command of a phone the reporting bridge does not have is unknown and changes
/// nothing, though the command is of the same workspace; the bridge that has the phone has its
/// result applied.
pub async fn finish_for_another_bridges_command_is_unknown(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (mine, other) = (phone(&uow, f.ws).await, phone(&uow, f.ws).await);
    let id = enqueue(
        &uow,
        f.ws,
        vec![tap(mine, 1, FIXED_NOW + DEFAULT_EXPIRES_IN)],
    )
    .await[0]
        .id;
    let leased = lease(&uow, f.ws, &[mine], at(1), 10).await.remove(0);

    let none: &[CapabilityId] = &[];
    for caps in [&[other][..], none] {
        assert_eq!(
            finish(&uow, f.ws, caps, id, done(), at(2)).await,
            Finished::Unknown
        );
        assert_eq!(get(&uow, f.ws, id).await.as_ref(), Some(&leased));
    }
    let row = applied(finish(&uow, f.ws, &[other, mine], id, done(), at(3)).await);
    assert_eq!(row.status, CommandStatus::Done);
}

/// A result that arrives after a leased command expired replaces `expired`: the bridge's result
/// is the truth. A second result is then a duplicate.
pub async fn finish_replaces_expired_after_lease(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let p = phone(&uow, f.ws).await;
    let rows = enqueue(&uow, f.ws, vec![tap(p, 1, at(5)), tap(p, 2, at(5))]).await;
    let (c, d) = (rows[0].id, rows[1].id);
    lease(&uow, f.ws, &[p], at(1), 10).await;
    assert_eq!(
        expire_due(&uow, f.ws, at(6)).await,
        rows.iter()
            .map(|r| ExpiredCommand {
                id: r.id,
                capability_id: p,
                seq: r.seq,
                kind: "tap".into(),
                created_at: FIXED_NOW,
                leased_at: Some(at(1)),
            })
            .collect::<Vec<_>>()
    );
    for id in [c, d] {
        let row = get(&uow, f.ws, id).await.unwrap();
        assert_eq!(
            (row.status, row.done_at),
            (CommandStatus::Expired, Some(at(6)))
        );
    }

    let late = applied(finish(&uow, f.ws, &[p], c, done(), at(7)).await);
    assert_eq!(
        (late.status, late.result.clone(), late.done_at),
        (
            CommandStatus::Done,
            Some(json!({"kind": "done"})),
            Some(at(7))
        )
    );
    let late = applied(finish(&uow, f.ws, &[p], d, failed("late"), at(8)).await);
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
        finish(&uow, f.ws, &[p], c, done(), at(9)).await,
        Finished::Duplicate
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
    assert_eq!(
        expired_ids(&expire_due(&uow, f.ws, at(6)).await),
        vec![lapsed]
    );
    let lapsed = get(&uow, f.ws, lapsed).await.unwrap();

    for row in [&queued, &lapsed] {
        for outcome in [done(), failed("never leased")] {
            assert_eq!(
                finish(&uow, f.ws, &[p], row.id, outcome, at(7)).await,
                Finished::Unknown
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
    applied(finish(&uow, f.ws, &[p], done_past, done(), at(2)).await);
    applied(finish(&uow, f.ws, &[p], failed_past, failed("gone"), at(2)).await);
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
        expired_ids(&expired),
        vec![leased_past, queued_past, queued_at_sweep]
    );
    assert_eq!(
        expired
            .iter()
            .map(|e| (e.kind.as_str(), e.leased_at))
            .collect::<Vec<_>>(),
        vec![("tap", Some(at(1))), ("tap", None), ("tap", None)]
    );
    for e in &expired {
        let row = get(&uow, f.ws, e.id).await.unwrap();
        assert_eq!(
            (row.status, row.done_at, row.seq, row.leased_at),
            (CommandStatus::Expired, Some(at(10)), e.seq, e.leased_at)
        );
    }
    for row in &untouched {
        assert_eq!(get(&uow, f.ws, row.id).await.as_ref(), Some(row));
    }
    assert!(expire_due(&uow, f.ws, at(11)).await.is_empty());
    assert_eq!(
        get(&uow, f.ws, leased_past).await.unwrap().done_at,
        Some(at(10))
    );
}

/// A phone's log is its most recent commands, newest first, at most `limit` (at least one): no
/// other phone's.
pub async fn list_is_newest_first_and_bounded(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (a, b) = (phone(&uow, f.ws).await, phone(&uow, f.ws).await);
    let expires = FIXED_NOW + DEFAULT_EXPIRES_IN;
    let rows = enqueue(
        &uow,
        f.ws,
        vec![
            tap(a, 1, expires),
            tap(b, 2, expires),
            tap(a, 3, expires),
            tap(a, 4, expires),
        ],
    )
    .await;
    let (first, of_b, second, third) = (&rows[0], &rows[1], &rows[2], &rows[3]);

    let mut t = uow.tenant(f.ws).await.unwrap();
    let commands = t.device_commands();
    assert_eq!(
        commands.list(a, 2).await.unwrap(),
        vec![third.clone(), second.clone()]
    );
    assert_eq!(commands.list(a, 0).await.unwrap(), vec![third.clone()]);
    assert_eq!(
        ids(&commands.list(a, 10).await.unwrap()),
        vec![third.id, second.id, first.id]
    );
    assert_eq!(commands.list(b, 10).await.unwrap(), vec![of_b.clone()]);
}

/// Every read and write sees only the bundle's workspace: another workspace's commands are not
/// read, picked, marked, failed, finished or expired, its phones take no command from this one,
/// and an id is taken across workspaces.
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
            .pick_due(&[mine_phone, their_phone], at(1), at(-9), 10)
            .await
            .unwrap()),
        vec![mine.id]
    );
    assert_eq!(
        ids(&commands
            .mark_leased(&[mine.id, theirs.id], at(1))
            .await
            .unwrap()),
        vec![mine.id]
    );
    assert!(
        commands
            .fail_pending(&[theirs.id], FailReason::DeviceOffline, "", at(2))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        commands
            .finish(&[mine_phone, their_phone], theirs.id, done(), at(2))
            .await
            .unwrap(),
        Finished::Unknown
    );
    assert_eq!(
        expired_ids(&commands.expire_due(at(10)).await.unwrap()),
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
