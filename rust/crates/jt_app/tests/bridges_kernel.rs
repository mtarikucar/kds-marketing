//! The bridge kernel (`usecases::bridges::kernel`): only a bridge's own key, holding its one
//! permission alone, acts as the bridge; a heartbeat verifies a capability and merges what it
//! reported, and never a retired one; a silent capability reads stale, then is marked
//! unreachable by the clock, and its next heartbeat brings it back; a long-poll watches before it
//! reads, wakes on its own signal and ends within its wait.
//!
//! The tests use a bridge spec of their own, not the voice bridge's: what the kernel does for it,
//! it does for every bridge. Its capabilities are `voice_bridge`s, a kind with a heartbeat; a
//! `printer` stands for a kind without one.
mod support;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::UnitOfWork;
use jt_app::ports::bridges::{BridgeSignals, SignalKey};
use jt_app::std_impls::LocalBridgeSignals;
use jt_app::usecases::api_keys::{self, AgentPrincipal, CreateKey};
use jt_app::usecases::bridges::kernel::{self, Beat, BridgeSpec, FALLBACK_TICK, FactsMerge, Held};
use jt_app::usecases::capabilities;
use jt_capability::{Capability, CapabilityId, EffectiveStatus, StoredStatus, effective_status};
use jt_ledger::{Actor, Subject};
use jt_tenancy::{Permission, WorkspaceId};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

/// A bridge of the tests' own.
const SPEC: BridgeSpec = BridgeSpec {
    component: "test_bridge",
    name: "test bridge",
    permission: Permission::CallsBridge,
    heartbeat_s: 15,
    online_action: "test.bridge.online",
    offline_action: "test.bridge.offline",
    redeliver_after: Duration::seconds(10),
    merge: FactsMerge::Replace,
};

/// The kind of the capabilities the test bridge keeps alive: a kind with a heartbeat.
const KIND: &str = "voice_bridge";
/// A kind no bridge reports, so without a heartbeat.
const NO_HEARTBEAT: &str = "printer";

/// A key the owner issues with `scopes`, as the API resolves it.
async fn key_with(w: &World, scopes: &[&str]) -> AgentPrincipal {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: format!("key {}", scopes.join(" ")),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    api_keys::authenticate(&w.deps, &key.plaintext)
        .await
        .unwrap()
}

/// An active workspace and the test bridge calling at the fixed time with its own key, issued
/// with `calls.bridge` alone.
async fn rig() -> (World, Ctx) {
    let w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let key = key_with(&w, &["calls.bridge"]).await;
    let ctx = kernel::ctx_for(&SPEC, &key, FIXED_NOW);
    (w, ctx)
}

/// What a heartbeat of capability `id` writes when it brings it back.
fn online(id: CapabilityId) -> Value {
    json!({ "capability_id": id, "note": "back" })
}

/// A heartbeat by `ctx` of capability `id` reporting `facts` (an object), in a bundle of its own.
async fn beat(
    w: &World,
    ctx: &Ctx,
    id: CapabilityId,
    facts: Value,
) -> Result<Capability, AppError> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let out = kernel::heartbeat(
        r.as_mut(),
        ctx,
        &SPEC,
        None,
        Beat {
            capability_id: id,
            facts: facts.as_object().unwrap().clone(),
            online: online(id),
        },
    )
    .await?;
    r.commit().await.unwrap();
    Ok(out)
}

/// Capability `id` as stored.
async fn stored(w: &World, id: CapabilityId) -> Capability {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().find(id).await.unwrap().unwrap()
}

/// The workspace's capabilities of `kind` that went silent before `now`.
async fn silent(w: &World, kind: &'static str, now: OffsetDateTime) -> Vec<CapabilityId> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    kernel::silent(r.as_mut(), kind, now).await.unwrap()
}

/// A health job's context in the workspace at `now`.
fn job_at(w: &World, now: OffsetDateTime) -> Ctx {
    Ctx {
        workspace_id: w.ws,
        actor: Actor::System {
            component: "scheduler:test_bridge_health".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// Asserts `FORBIDDEN` with `details.reason = "bridge_key_only"`.
fn assert_bridge_key_only(e: &AppError) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(e.details, json!({ "reason": "bridge_key_only" }), "{e:?}");
}

#[tokio::test]
async fn exact_permission_set_only() {
    let (w, ctx) = rig().await;
    // The bridge's own key: the bridge's component in the key's workspace, its one permission,
    // no role, no agent connection.
    assert_eq!(ctx.workspace_id, w.ws);
    assert_eq!(
        ctx.actor,
        Actor::System {
            component: "test_bridge".into()
        }
    );
    assert_eq!(ctx.permissions, [Permission::CallsBridge].into());
    assert_eq!(ctx.role_key, None);
    assert_eq!(ctx.agent_connection_id, None);
    assert_eq!(ctx.now, FIXED_NOW);
    kernel::require_bridge(&SPEC, &ctx).unwrap();

    // A key holding one permission more is not the bridge's.
    let wider = key_with(&w, &["calls.bridge", "workspace.read"]).await;
    let wider = kernel::ctx_for(&SPEC, &wider, FIXED_NOW);
    assert_bridge_key_only(&err(kernel::require_bridge(&SPEC, &wider)));

    // The bridge's context is no other bridge's, though their permission is the same; the
    // refusal names the bridge it is about.
    let other = BridgeSpec {
        component: "other_bridge",
        name: "other bridge",
        ..SPEC
    };
    let e = err(kernel::require_bridge(&other, &ctx));
    assert_bridge_key_only(&e);
    assert_eq!(
        e.message,
        "only the other bridge's own key, holding calls.bridge alone, reaches the bridge"
    );

    // Nor is a person or an agent holding every permission, the bridge's among them.
    let agent = w.agent(&[]).await;
    for who in [&w.owner_ctx, &agent] {
        assert!(who.permissions.contains(&Permission::CallsBridge));
        assert_bridge_key_only(&err(kernel::require_bridge(&SPEC, who)));
    }
}

#[tokio::test]
async fn other_permission_refused() {
    let (w, bridge) = rig().await;
    // A key without the bridge's permission is refused naming it, as the bridge's component too.
    let key = key_with(&w, &["calls.work"]).await;
    let ctx = kernel::ctx_for(&SPEC, &key, FIXED_NOW);
    assert_forbidden(&err(kernel::require_bridge(&SPEC, &ctx)), "calls.bridge");

    // The permission checked is the spec's: a key holding `calls.bridge` is not a bridge whose
    // permission is another.
    let elsewhere = BridgeSpec {
        permission: Permission::CallsWork,
        ..SPEC
    };
    assert_forbidden(
        &err(kernel::require_bridge(&elsewhere, &bridge)),
        "calls.work",
    );

    // A heartbeat in a context that is not the bridge's verifies nothing and writes nothing.
    let id = w.declare(KIND, "Köprü").await.capability.id;
    let e = err(beat(&w, &ctx, id, json!({ "bridge": { "version": "1" } })).await);
    assert_forbidden(&e, "calls.bridge");
    let e = err(beat(&w, &w.owner_ctx, id, json!({})).await);
    assert_bridge_key_only(&e);
    let c = stored(&w, id).await;
    assert_eq!(c.status, StoredStatus::Declared);
    assert_eq!(c.last_verified_at, None);
    assert!(w.entries(SPEC.online_action).is_empty());
}

#[tokio::test]
async fn heartbeat_verifies_and_merges_facts() {
    let (w, ctx) = rig().await;
    let id = w.declare(KIND, "Köprü").await.capability.id;

    // The first heartbeat verifies it now and keeps what it reported; it read declared until
    // now, so it came online.
    let c = beat(
        &w,
        &ctx,
        id,
        json!({ "bridge": { "version": "1" }, "lines": 2 }),
    )
    .await
    .unwrap();
    assert_eq!(c.status, StoredStatus::Verified);
    assert_eq!(c.last_verified_at, Some(FIXED_NOW));
    assert_eq!(c.updated_at, FIXED_NOW);
    assert_eq!(c.connector_public["bridge"], json!({ "version": "1" }));
    assert_eq!(c.connector_public["lines"], 2);
    assert_eq!(stored(&w, id).await, c);
    assert_eq!(effective_status(&c, FIXED_NOW), EffectiveStatus::Verified);
    let entries = w.entries(SPEC.online_action);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload, online(id));
    assert_eq!(entries[0].actor, ctx.actor);
    assert_eq!(
        entries[0].subject,
        Some(Subject {
            kind: "capability".into(),
            id: id.to_string(),
        })
    );

    // The next one replaces only what it reports, keeps the rest, and moves the time; the
    // capability read verified already, so nothing is written.
    let later = FIXED_NOW + Duration::seconds(15);
    let c = beat(
        &w,
        &at(&ctx, later),
        id,
        json!({ "bridge": { "version": "2" } }),
    )
    .await
    .unwrap();
    assert_eq!(c.connector_public["bridge"], json!({ "version": "2" }));
    assert_eq!(c.connector_public["lines"], 2);
    assert_eq!(c.last_verified_at, Some(later));
    assert_eq!(w.entries(SPEC.online_action).len(), 1);

    // An unknown capability is not found.
    let e = err(beat(&w, &ctx, CapabilityId::new_v7(), json!({})).await);
    assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
}

#[tokio::test]
async fn heartbeat_refuses_a_retired_capability() {
    let (w, ctx) = rig().await;
    let id = w.declare(KIND, "Köprü").await.capability.id;
    beat(&w, &ctx, id, json!({ "bridge": { "version": "1" } }))
        .await
        .unwrap();
    capabilities::retire(&w.deps, &w.owner_ctx, id, true)
        .await
        .unwrap();
    let retired = stored(&w, id).await;
    assert_eq!(retired.status, StoredStatus::Retired);

    // A heartbeat after the retirement is refused, as every write to a retired capability: it
    // stays retired, its last heartbeat and facts as they were, and nothing reads it online.
    let later = FIXED_NOW + Duration::seconds(15);
    let e = err(beat(
        &w,
        &at(&ctx, later),
        id,
        json!({ "bridge": { "version": "2" } }),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.message, "capability is retired");
    assert_eq!(stored(&w, id).await, retired);
    assert_eq!(w.entries(SPEC.online_action).len(), 1);
}

#[tokio::test]
async fn stale_then_unreachable_by_clock() {
    let (w, ctx) = rig().await;
    let id = w.declare(KIND, "Köprü").await.capability.id;
    let c = beat(&w, &ctx, id, json!({})).await.unwrap();
    let clock = c.kind().unwrap().heartbeat().unwrap();

    // Stale once its heartbeat is older than the kind's `stale_after`, with nothing written.
    let stale_after = FIXED_NOW + clock.stale_after;
    assert_eq!(effective_status(&c, stale_after), EffectiveStatus::Verified);
    let one_more = Duration::seconds(1);
    assert_eq!(
        effective_status(&c, stale_after + one_more),
        EffectiveStatus::Stale
    );

    // Silent only once it is older than the kind's `unreachable_after`; then marked
    // unreachable once, its last heartbeat kept as when it was last heard.
    let unreachable_after = FIXED_NOW + clock.unreachable_after;
    assert!(silent(&w, KIND, unreachable_after).await.is_empty());
    let late = unreachable_after + one_more;
    assert_eq!(silent(&w, KIND, late).await, [id]);
    let job = job_at(&w, late);
    assert!(
        kernel::mark_unreachable(&w.deps, &job, &SPEC, KIND, id)
            .await
            .unwrap()
    );
    let c = stored(&w, id).await;
    assert_eq!(c.status, StoredStatus::Unreachable);
    assert_eq!(c.last_verified_at, Some(FIXED_NOW));
    let entries = w.entries(SPEC.offline_action);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({ "capability_id": id, "last_seen_at": FIXED_NOW.format(&Rfc3339).unwrap() })
    );
    assert_eq!(entries[0].actor, job.actor);
    assert!(silent(&w, KIND, late).await.is_empty());
    assert!(
        !kernel::mark_unreachable(&w.deps, &job, &SPEC, KIND, id)
            .await
            .unwrap()
    );
    assert_eq!(w.entries(SPEC.offline_action).len(), 1);

    // A silent capability is marked only as its own kind, and one that registered meanwhile is
    // left alone.
    let second = w.declare(KIND, "İkinci köprü").await.capability.id;
    beat(&w, &ctx, second, json!({})).await.unwrap();
    assert_eq!(silent(&w, KIND, late).await, [second]);
    assert!(
        !kernel::mark_unreachable(&w.deps, &job, &SPEC, NO_HEARTBEAT, second)
            .await
            .unwrap()
    );
    beat(&w, &at(&ctx, late), second, json!({})).await.unwrap();
    assert!(
        !kernel::mark_unreachable(&w.deps, &job, &SPEC, KIND, second)
            .await
            .unwrap()
    );
    assert_eq!(stored(&w, second).await.status, StoredStatus::Verified);
    assert_eq!(w.entries(SPEC.offline_action).len(), 1);

    // A kind without a heartbeat never goes silent, however old its verification.
    let printer = w.declare(NO_HEARTBEAT, "Yazıcı").await.capability.id;
    beat(&w, &ctx, printer, json!({})).await.unwrap();
    assert!(
        silent(&w, NO_HEARTBEAT, FIXED_NOW + Duration::days(400))
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn online_after_unreachable_writes_ledger() {
    let (w, ctx) = rig().await;
    let id = w.declare(KIND, "Köprü").await.capability.id;
    beat(&w, &ctx, id, json!({ "bridge": { "version": "1" } }))
        .await
        .unwrap();
    let c = stored(&w, id).await;
    let clock = c.kind().unwrap().heartbeat().unwrap();
    let late = FIXED_NOW + clock.unreachable_after + Duration::seconds(1);
    assert!(
        kernel::mark_unreachable(&w.deps, &job_at(&w, late), &SPEC, KIND, id)
            .await
            .unwrap()
    );
    assert_eq!(w.entries(SPEC.online_action).len(), 1);

    // Its next heartbeat brings it back: verified, its time moved, and the online entry the
    // bridge's, with what the heartbeat gave it.
    let back = late + Duration::seconds(30);
    let c = beat(
        &w,
        &at(&ctx, back),
        id,
        json!({ "bridge": { "version": "2" } }),
    )
    .await
    .unwrap();
    assert_eq!(c.status, StoredStatus::Verified);
    assert_eq!(c.last_verified_at, Some(back));
    assert_eq!(effective_status(&c, back), EffectiveStatus::Verified);
    assert_eq!(c.connector_public["bridge"]["version"], "2");
    let entries = w.entries(SPEC.online_action);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].payload, online(id));
    assert_eq!(entries[1].actor, ctx.actor);
    assert_eq!(entries[1].at, back);

    // A heartbeat while it reads verified writes nothing; one after it went stale does.
    let next = back + Duration::seconds(15);
    beat(&w, &at(&ctx, next), id, json!({})).await.unwrap();
    assert_eq!(w.entries(SPEC.online_action).len(), 2);
    let stale = next + clock.stale_after + Duration::seconds(1);
    beat(&w, &at(&ctx, stale), id, json!({})).await.unwrap();
    assert_eq!(w.entries(SPEC.online_action).len(), 3);
}

#[tokio::test]
async fn wait_for_wakes_on_signal() {
    let signals = Arc::new(LocalBridgeSignals::default());
    let ws = WorkspaceId::new_v7();
    let key = SignalKey {
        workspace_id: ws,
        topic: "test",
    };
    let ready = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicU32::new(0));
    let waiting = {
        let (signals, ready, reads) = (signals.clone(), ready.clone(), reads.clone());
        tokio::spawn(async move {
            let started = Instant::now();
            let found = kernel::wait_for(&*signals, key, StdDuration::from_secs(20), |_| {
                let (ready, reads) = (ready.clone(), reads.clone());
                Box::pin(async move {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, AppError>(ready.load(Ordering::SeqCst).then_some("found"))
                })
            })
            .await
            .unwrap();
            (found, started.elapsed())
        })
    };
    // The first read finds nothing, and the wait begins.
    let begun = Instant::now();
    while reads.load(Ordering::SeqCst) == 0 {
        assert!(begun.elapsed() < StdDuration::from_secs(5), "never read");
        tokio::time::sleep(StdDuration::from_millis(5)).await;
    }
    // A signal of another topic, or of another workspace, wakes nothing.
    signals.notify(SignalKey {
        workspace_id: ws,
        topic: "other",
    });
    signals.notify(SignalKey {
        workspace_id: WorkspaceId::new_v7(),
        topic: "test",
    });
    tokio::time::sleep(StdDuration::from_millis(100)).await;
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    // Its own key's signal wakes it at once, well within the fallback tick, and the read that
    // follows finds what was committed.
    ready.store(true, Ordering::SeqCst);
    signals.notify(key);
    let (found, waited) = waiting.await.unwrap();
    assert_eq!(found, Some("found"));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(waited < FALLBACK_TICK, "{waited:?}");
}

#[tokio::test]
async fn wait_for_watches_before_it_reads() {
    let signals = LocalBridgeSignals::default();
    let key = SignalKey {
        workspace_id: WorkspaceId::new_v7(),
        topic: "test",
    };
    // What is committed while the first read runs is signalled during it, before the wait: a
    // watch begun only after the read would miss it and sleep a whole fallback tick.
    let reads = AtomicU32::new(0);
    let started = Instant::now();
    let found = kernel::wait_for(&signals, key, StdDuration::from_secs(20), |_| {
        let read = reads.fetch_add(1, Ordering::SeqCst);
        let signals = &signals;
        Box::pin(async move {
            if read == 0 {
                signals.notify(key);
                return Ok::<_, AppError>(None);
            }
            Ok(Some(read))
        })
    })
    .await
    .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(found, Some(1));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(elapsed < FALLBACK_TICK / 2, "{elapsed:?}");
}

#[tokio::test]
async fn wait_for_times_out_within_wait_plus_one() {
    let signals = LocalBridgeSignals::default();
    let key = SignalKey {
        workspace_id: WorkspaceId::new_v7(),
        topic: "test",
    };

    // A wait of zero reads once and answers at once.
    let reads = AtomicU32::new(0);
    let started = Instant::now();
    let found: Option<()> = kernel::wait_for(&signals, key, StdDuration::ZERO, |_| {
        reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok::<_, AppError>(None) })
    })
    .await
    .unwrap();
    assert_eq!(found, None);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(started.elapsed() < StdDuration::from_millis(500));

    // A wait of a second that finds nothing answers `None` once the second is over, within a
    // second more; it read again meanwhile, each read told how long it had waited.
    let waits = Mutex::new(Vec::new());
    let started = Instant::now();
    let found: Option<()> = kernel::wait_for(&signals, key, StdDuration::from_secs(1), |waited| {
        waits.lock().unwrap().push(waited);
        Box::pin(async { Ok::<_, AppError>(None) })
    })
    .await
    .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(found, None);
    assert!(elapsed >= StdDuration::from_secs(1), "{elapsed:?}");
    assert!(elapsed < StdDuration::from_secs(2), "{elapsed:?}");
    let waits = waits.into_inner().unwrap();
    assert!(waits.len() >= 2, "{waits:?}");
    assert!(waits[0] < StdDuration::from_millis(500), "{waits:?}");
    assert!(waits.windows(2).all(|w| w[0] <= w[1]), "{waits:?}");
    assert!(
        *waits.last().unwrap() >= StdDuration::from_secs(1),
        "{waits:?}"
    );

    // A read's error ends the wait at once, with it.
    let started = Instant::now();
    let failed: Result<Option<()>, AppError> =
        kernel::wait_for(&signals, key, StdDuration::from_secs(5), |_| {
            Box::pin(async { Err(AppError::conflict("busy")) })
        })
        .await;
    assert_eq!(err(failed).code, ErrorCode::Conflict);
    assert!(started.elapsed() < StdDuration::from_millis(500));
}

#[tokio::test]
async fn lease_reads_at_its_time_and_commits_what_it_took() {
    let (w, ctx) = rig().await;
    // A read three seconds into the wait leases as of then, redelivering what was handed out ten
    // seconds before that, and is given the bridge's context at that time.
    let waited = StdDuration::from_secs(3);
    let id = CapabilityId::new_v7();
    let taken = kernel::lease(&w.deps, &ctx, &SPEC, waited, move |r, at_ctx, lease| {
        Box::pin(async move {
            let c = Capability::new(
                id,
                at_ctx.workspace_id,
                jt_capability::NewCapability {
                    kind_key: KIND.into(),
                    name: "Köprü".into(),
                    ..jt_capability::NewCapability::default()
                },
                at_ctx.now,
            )
            .unwrap();
            r.capabilities().insert(c, None).await?;
            Ok(vec![(lease, at_ctx.now, at_ctx.actor.clone())])
        })
    })
    .await
    .unwrap()
    .unwrap();
    let now = FIXED_NOW + Duration::seconds(3);
    assert_eq!(
        taken,
        [(
            kernel::Lease {
                now,
                redeliver_before: now - Duration::seconds(10),
            },
            now,
            ctx.actor.clone(),
        )]
    );
    // What it wrote was committed.
    assert_eq!(stored(&w, id).await.created_at, now);

    // Taking nothing is `None`.
    let none = kernel::lease(&w.deps, &ctx, &SPEC, StdDuration::ZERO, |_, _, _| {
        Box::pin(async { Ok(Vec::<()>::new()) })
    })
    .await
    .unwrap();
    assert_eq!(none, None);

    // An error ends the read with nothing committed.
    let lost = CapabilityId::new_v7();
    let failed = kernel::lease(
        &w.deps,
        &ctx,
        &SPEC,
        StdDuration::ZERO,
        move |r, at_ctx, _| {
            Box::pin(async move {
                let c = Capability::new(
                    lost,
                    at_ctx.workspace_id,
                    jt_capability::NewCapability {
                        kind_key: KIND.into(),
                        name: "Köprü".into(),
                        ..jt_capability::NewCapability::default()
                    },
                    at_ctx.now,
                )
                .unwrap();
                r.capabilities().insert(c, None).await?;
                Err::<Vec<()>, _>(AppError::conflict("busy"))
            })
        },
    )
    .await;
    assert_eq!(err(failed).code, ErrorCode::Conflict);
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(r.capabilities().find(lost).await.unwrap().is_none());
    drop(r);

    // Only the bridge's own context leases; the read is not made.
    let refused = kernel::lease(
        &w.deps,
        &w.owner_ctx,
        &SPEC,
        StdDuration::ZERO,
        |_, _, _| Box::pin(async { panic!("a context that is not the bridge's never reads") }),
    )
    .await;
    assert_bridge_key_only(&err::<Option<Vec<()>>>(refused));
}

#[tokio::test]
async fn declare_and_held_find_what_the_workspace_holds() {
    let (w, ctx) = rig().await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert!(kernel::of_kind(r.as_mut(), KIND).await.unwrap().is_empty());
    let id = kernel::declare(
        r.as_mut(),
        &ctx,
        w.deps.ids.as_ref(),
        KIND,
        "Köprü 7",
        "7",
        None,
    )
    .await
    .unwrap();
    r.commit().await.unwrap();

    // Declared as `capability.declare` would, by the bridge.
    let c = stored(&w, id).await;
    assert_eq!(
        (
            c.kind_key.as_str(),
            c.name.as_str(),
            c.external_id.as_deref()
        ),
        (KIND, "Köprü 7", Some("7"))
    );
    assert_eq!(c.status, StoredStatus::Declared);
    let entries = w.entries("capability.declare");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({ "kind_key": KIND, "name": "Köprü 7", "external_id": "7" })
    );
    assert_eq!(entries[0].actor, ctx.actor);

    // Held live under its external id; nothing under another.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let all = kernel::of_kind(r.as_mut(), KIND).await.unwrap();
    drop(r);
    assert!(matches!(kernel::held(&all, "7"), Held::Live(c) if c.id == id));
    assert_eq!(kernel::held(&all, "8"), Held::Missing);

    // Retired, it is held as retired only, never as live.
    capabilities::retire(&w.deps, &w.owner_ctx, id, true)
        .await
        .unwrap();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let all = kernel::of_kind(r.as_mut(), KIND).await.unwrap();
    drop(r);
    assert_eq!(all.len(), 1, "a retired capability is still of its kind");
    assert_eq!(kernel::held(&all, "7"), Held::Retired);
}

#[tokio::test]
async fn deep_merge_keeps_what_a_heartbeat_leaves_out() {
    let (w, ctx) = rig().await;
    let deep = BridgeSpec {
        merge: FactsMerge::Deep,
        ..SPEC
    };
    let id = w.declare(KIND, "Köprü").await.capability.id;
    let beat_deep = |facts: Value, now: OffsetDateTime| {
        let (w, ctx) = (&w, &ctx);
        async move {
            let mut r = w.uow.tenant(w.ws).await.unwrap();
            let c = kernel::heartbeat(
                r.as_mut(),
                &at(ctx, now),
                &deep,
                None,
                Beat {
                    capability_id: id,
                    facts: facts.as_object().unwrap().clone(),
                    online: online(id),
                },
            )
            .await
            .unwrap();
            r.commit().await.unwrap();
            c
        }
    };
    beat_deep(
        json!({ "device": { "model": "A", "screen": { "w": 1, "h": 2 }, "features": ["a", "b"] }, "lines": 1 }),
        FIXED_NOW,
    )
    .await;
    // What the next one reports changes, key by key and as deep as both are objects; what it
    // leaves out is kept; an array is replaced whole.
    let c = beat_deep(
        json!({ "device": { "screen": { "w": 3 }, "features": ["c"], "os": "13" }, "lines": 2 }),
        FIXED_NOW + Duration::seconds(15),
    )
    .await;
    assert_eq!(
        c.connector_public,
        json!({
            "device": { "model": "A", "screen": { "w": 3, "h": 2 }, "features": ["c"], "os": "13" },
            "lines": 2,
        })
    );

    // Replacing, as the voice bridge does, replaces each fact whole.
    let mut kept = json!({ "bridge": { "version": "1", "codecs": ["PCMA"] }, "lines": 1 });
    kernel::merge_facts(
        &mut kept,
        json!({ "bridge": { "version": "2" } })
            .as_object()
            .unwrap()
            .clone(),
        FactsMerge::Replace,
    );
    assert_eq!(kept, json!({ "bridge": { "version": "2" }, "lines": 1 }));
    // Facts over something that is not an object become the facts.
    let mut kept = Value::Null;
    kernel::merge_facts(
        &mut kept,
        json!({ "lines": 1 }).as_object().unwrap().clone(),
        FactsMerge::Deep,
    );
    assert_eq!(kept, json!({ "lines": 1 }));
}
