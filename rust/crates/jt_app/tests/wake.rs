//! Waking an agent when a person gives it work (`usecases::wake`): who is woken, when, how often,
//! what each answer does, and that the token never leaves its seal.
mod support;

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::wake::{WakeAnswer, WakeOutcome, WakeReason};
use jt_app::usecases::agents::{self, ClientInfo};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::jobs;
use jt_app::usecases::studio::projects;
use jt_app::usecases::wake::{self, NeedWake, SetWake, WakeKind};
use jt_app::usecases::work;
use jt_ledger::Actor;
use jt_tenancy::ApiKeyId;
use jt_testkit::fakes::{
    FIXED_NOW, RecordingTenantHosts, ScriptedRegistry, ScriptedWaker, WakeCall,
};
use serde_json::json;
use support::{World, at, world};
use time::{Duration, OffsetDateTime};

const TOKEN: &str = "sk-ant-oat01-SECRET-routine-token";

struct Rig {
    w: World,
    waker: Arc<ScriptedWaker>,
}

async fn rig() -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    jt_testkit::studio_contract::install_all_modules(&w.uow, w.ws).await;
    let waker = ScriptedWaker::new();
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_waker(waker.clone()));
    Rig { w, waker }
}

/// A key with `scopes` whose agent connected at `FIXED_NOW`: its id and the agent's context.
async fn agent(w: &World, name: &str, scopes: &[&str]) -> (ApiKeyId, Ctx) {
    let key = api_keys::create(
        &w.deps,
        &w.owner_ctx,
        CreateKey {
            name: name.into(),
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
            name: "claude-code".into(),
            version: "2.1".into(),
            protocol_version: "2025-06-18".into(),
        },
        FIXED_NOW - Duration::hours(1),
    )
    .await
    .unwrap();
    (
        key.id,
        api_keys::ctx_for_agent(&principal, connection, FIXED_NOW),
    )
}

async fn routine(w: &World, key: ApiKeyId) {
    wake::set(
        &w.deps,
        &w.owner_ctx,
        SetWake {
            api_key_id: key,
            kind: WakeKind::ClaudeRoutine,
            routine_id: Some("trig_01Content".into()),
            token: Some(TOKEN.into()),
            url: None,
            secret: None,
        },
    )
    .await
    .unwrap();
}

async fn create_area(w: &World, ctx: &Ctx, key: &str) {
    projects::project_create(
        &w.deps,
        ctx,
        serde_json::from_value(json!({"request_key": key, "brief": "Show our workshop"})).unwrap(),
    )
    .await
    .unwrap();
}

async fn state(w: &World, now: OffsetDateTime) -> wake::WakesOut {
    wake::list(&w.deps, &at(&w.owner_ctx, now)).await.unwrap()
}

fn pending_of(out: &wake::WakesOut, key: ApiKeyId) -> Option<wake::PendingOut> {
    out.agents
        .iter()
        .find(|a| a.api_key_id == key)
        .and_then(|a| a.pending.clone())
}

#[tokio::test]
async fn a_persons_request_wakes_only_the_agents_that_can_take_it_once_it_settles() {
    let r = rig().await;
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    let (materials, _) = agent(&r.w, "materials", &["workspace.read", "materials.work"]).await;
    routine(&r.w, content).await;
    routine(&r.w, materials).await;

    // Two requests in a row: one pending wake, 45 s after the last.
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    create_area(
        &r.w,
        &at(&r.w.owner_ctx, FIXED_NOW + Duration::seconds(20)),
        "b",
    )
    .await;
    let out = state(&r.w, FIXED_NOW + Duration::seconds(20)).await;
    let p = pending_of(&out, content).unwrap();
    assert_eq!(p.due_at, FIXED_NOW + Duration::seconds(65));
    assert_eq!(p.reasons, [WakeReason::ContentRequested]);
    assert!(
        pending_of(&out, materials).is_none(),
        "a materials agent takes no area"
    );
    assert!(matches!(out.needs["content"], NeedWake::Calling { .. }));

    // Before it settles nothing goes out; after, one fire with the neutral text.
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::seconds(60)).await;
    assert!(r.waker.calls().is_empty());
    let report = jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::seconds(65)).await;
    assert_eq!((report.touched, report.changed), (1, 1));
    assert_eq!(
        r.waker.calls(),
        [WakeCall::Routine {
            routine_id: "trig_01Content".into(),
            token: TOKEN.into(),
            text: "A person asked for a new content. Check in now with jeeta.work.checkin and \
                   do the pending work."
                .into(),
        }]
    );
    // Ledgered with who caused it and the session, never the token.
    let entries = r.w.entries("agent.wake");
    assert_eq!(entries.len(), 1);
    let payload = &entries[0].payload;
    assert_eq!(payload["outcome"], "fired");
    assert_eq!(payload["reasons"], json!(["content_requested"]));
    assert_eq!(payload["caused_by"], json!([r.w.owner]));
    assert_eq!(
        payload["session_url"],
        "https://claude.ai/code/session_scripted"
    );
    // The panel now says the agent was called.
    let out = state(&r.w, FIXED_NOW + Duration::seconds(70)).await;
    assert!(matches!(out.needs["content"], NeedWake::Called { .. }));
}

#[tokio::test]
async fn an_agents_own_action_or_a_later_start_wakes_nobody() {
    let r = rig().await;
    let (content, agent_ctx) = agent(
        &r.w,
        "content",
        &["workspace.read", "content.work", "content.manage"],
    )
    .await;
    routine(&r.w, content).await;
    create_area(&r.w, &agent_ctx, "by-agent").await;
    projects::project_create(
        &r.w.deps,
        &r.w.owner_ctx,
        serde_json::from_value(json!({
            "request_key": "later", "brief": "Next week",
            "start_at": "2026-11-30T09:00:00Z"
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(pending_of(&state(&r.w, FIXED_NOW).await, content).is_none());
}

#[tokio::test]
async fn a_check_in_after_the_request_drops_the_wake_and_a_later_request_stands() {
    let r = rig().await;
    let (content, agent_ctx) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    // The agent checks in on its own 10 s later: it read the area, so the wake is not needed.
    work::checkin(
        &r.w.deps,
        &at(&agent_ctx, FIXED_NOW + Duration::seconds(10)),
    )
    .await
    .unwrap();
    assert!(
        pending_of(
            &state(&r.w, FIXED_NOW + Duration::seconds(10)).await,
            content
        )
        .is_none()
    );
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::minutes(5)).await;
    assert!(r.waker.calls().is_empty());
    // A request after that check-in is sent: the agent has not seen it.
    create_area(
        &r.w,
        &at(&r.w.owner_ctx, FIXED_NOW + Duration::seconds(30)),
        "b",
    )
    .await;
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::seconds(75)).await;
    assert_eq!(r.waker.calls().len(), 1);
}

#[tokio::test]
async fn the_rate_limits_hold_wakes_back_and_a_manual_wake_says_until_when() {
    let r = rig().await;
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    let fired = FIXED_NOW + Duration::seconds(45);
    jobs::run_agent_wake(&r.w.deps, fired).await;
    // Pressed a minute after a fire: refused until three minutes after it.
    let pressed = at(&r.w.owner_ctx, fired + Duration::minutes(1));
    let e = wake::wake_now(&r.w.deps, &pressed, content)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "rate_limited");
    assert_eq!(e.details["retry_at"], "2026-10-22T09:03:45Z");
    // A person's request meanwhile waits for the rate, and the panel says so.
    create_area(&r.w, &pressed, "b").await;
    let p = pending_of(&state(&r.w, pressed.now).await, content).unwrap();
    assert_eq!(p.due_at, fired + Duration::minutes(3));
    assert_eq!(p.waiting_for, jt_app::ports::wake::WaitingFor::Rate);
    jobs::run_agent_wake(&r.w.deps, fired + Duration::minutes(2)).await;
    assert_eq!(r.waker.calls().len(), 1);
    jobs::run_agent_wake(&r.w.deps, fired + Duration::minutes(3)).await;
    assert_eq!(r.waker.calls().len(), 2);
}

#[tokio::test]
async fn each_failure_class_does_what_it_should() {
    let r = rig().await;
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    let t = FIXED_NOW + Duration::seconds(45);
    // 429: tried again after its Retry-After.
    r.waker.answer(WakeAnswer::RateLimited {
        retry_after: Some(Duration::seconds(120)),
    });
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    jobs::run_agent_wake(&r.w.deps, t).await;
    let p = pending_of(&state(&r.w, t).await, content).unwrap();
    assert_eq!(p.due_at, t + Duration::seconds(120));
    // 503: backoff from 30 s.
    r.waker
        .answer(WakeAnswer::Unavailable { status: Some(503) });
    jobs::run_agent_wake(&r.w.deps, t + Duration::seconds(120)).await;
    let p = pending_of(&state(&r.w, t + Duration::seconds(120)).await, content).unwrap();
    assert_eq!(p.due_at, t + Duration::seconds(150));
    // 401: the address is refused, one ledger entry says so, nothing more is sent.
    r.waker.answer(WakeAnswer::Refused { status: Some(401) });
    jobs::run_agent_wake(&r.w.deps, t + Duration::seconds(150)).await;
    let out = state(&r.w, t + Duration::seconds(150)).await;
    let a = out.agents.iter().find(|a| a.api_key_id == content).unwrap();
    assert!(a.address.as_ref().unwrap().refused_at.is_some());
    assert!(matches!(out.needs["content"], NeedWake::Refused { .. }));
    let outcomes: Vec<_> =
        r.w.entries("agent.wake")
            .iter()
            .map(|e| e.payload["outcome"].clone())
            .collect();
    assert_eq!(
        outcomes,
        [
            json!("rate_limited"),
            json!("unavailable"),
            json!("refused")
        ]
    );
    create_area(&r.w, &at(&r.w.owner_ctx, t + Duration::minutes(5)), "b").await;
    jobs::run_agent_wake(&r.w.deps, t + Duration::minutes(10)).await;
    assert_eq!(r.waker.calls().len(), 3);
    let e = wake::wake_now(
        &r.w.deps,
        &at(&r.w.owner_ctx, t + Duration::minutes(10)),
        content,
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "wake_refused");
    // Setting the address again clears the refusal.
    routine(&r.w, content).await;
    assert!(
        state(&r.w, t + Duration::minutes(10)).await.agents[0]
            .address
            .as_ref()
            .unwrap()
            .refused_at
            .is_none()
    );
}

#[tokio::test]
async fn a_network_failure_is_given_up_after_thirty_minutes() {
    let r = rig().await;
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    let mut t = FIXED_NOW + Duration::seconds(45);
    for _ in 0..20 {
        r.waker.answer(WakeAnswer::Unavailable { status: None });
    }
    while let Some(p) = pending_of(&state(&r.w, t).await, content) {
        t = p.due_at;
        jobs::run_agent_wake(&r.w.deps, t).await;
        assert!(t - FIXED_NOW < Duration::minutes(45), "never given up");
    }
    let last = r.w.entries("agent.wake").last().unwrap().payload.clone();
    assert_eq!(last["outcome"], "gave_up");
    let out = state(&r.w, t).await;
    assert!(matches!(
        out.needs["content"],
        NeedWake::Schedule {
            failed_at: Some(_),
            has_address: true,
            ..
        }
    ));
}

#[tokio::test]
async fn the_token_never_appears_in_reads_rows_or_the_ledger() {
    let r = rig().await;
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::minutes(1)).await;
    let read = serde_json::to_string(&state(&r.w, FIXED_NOW).await).unwrap();
    assert!(!read.contains(TOKEN) && !read.contains("SECRET"), "{read}");
    assert!(read.contains("trig_01Content"));
    let snapshot = r.w.uow.snapshot();
    for entry in &snapshot.ledger {
        let text = serde_json::to_string(&entry.entry.payload).unwrap();
        assert!(!text.contains("SECRET"), "{text}");
    }
    for stored in &snapshot.agent_wakes {
        let text = serde_json::to_string(&stored.row).unwrap();
        assert!(!text.contains("SECRET"), "{text}");
    }
    // The input's Debug masks it too.
    let input = SetWake {
        api_key_id: content,
        kind: WakeKind::ClaudeRoutine,
        routine_id: Some("trig_1".into()),
        token: Some(TOKEN.into()),
        url: None,
        secret: None,
    };
    assert!(!format!("{input:?}").contains("SECRET"));
}

#[tokio::test]
async fn only_a_person_with_team_manage_sets_an_address_and_an_agent_never_reads_one() {
    let r = rig().await;
    let (content, agent_ctx) = agent(
        &r.w,
        "content",
        &["workspace.read", "content.work", "team.manage"],
    )
    .await;
    let set = |ctx: Ctx| {
        let deps = r.w.deps.clone();
        async move {
            wake::set(
                &deps,
                &ctx,
                SetWake {
                    api_key_id: content,
                    kind: WakeKind::ClaudeRoutine,
                    routine_id: Some("trig_1".into()),
                    token: Some(TOKEN.into()),
                    url: None,
                    secret: None,
                },
            )
            .await
        }
    };
    let e = set(agent_ctx.clone()).await.unwrap_err();
    assert_eq!(
        (e.code, e.details["reason"].clone()),
        (ErrorCode::Forbidden, json!("people_only"))
    );
    assert_eq!(
        wake::list(&r.w.deps, &agent_ctx).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    let member = r.w.member("rep").await;
    assert_eq!(set(member).await.unwrap_err().code, ErrorCode::Forbidden);
    set(r.w.owner_ctx.clone()).await.unwrap();
    // A malformed routine id or a missing token is refused by field.
    let bad = wake::set(
        &r.w.deps,
        &r.w.owner_ctx,
        SetWake {
            api_key_id: content,
            kind: WakeKind::ClaudeRoutine,
            routine_id: Some("routine_1".into()),
            token: Some(TOKEN.into()),
            url: None,
            secret: None,
        },
    )
    .await
    .unwrap_err();
    support::assert_invalid(&bad, "routine_id");
    // A login e-mail in the id, a saved password in the token (what a browser's password manager
    // fills in): refused at the field, nothing sealed.
    for (routine_id, token, field) in [
        ("owner@acme.example", TOKEN, "routine_id"),
        ("trig_1", "correct horse battery", "token"),
        ("trig_1", "Hunter2!", "token"),
    ] {
        let bad = wake::set(
            &r.w.deps,
            &r.w.owner_ctx,
            SetWake {
                api_key_id: content,
                kind: WakeKind::ClaudeRoutine,
                routine_id: Some(routine_id.into()),
                token: Some(token.into()),
                url: None,
                secret: None,
            },
        )
        .await
        .unwrap_err();
        support::assert_invalid(&bad, field);
    }
}

#[tokio::test]
async fn a_webhook_must_be_https_on_a_public_host_and_carries_no_content() {
    let mut r = rig().await;
    let hosts = RecordingTenantHosts::refusing(&["10.0.0.5"]);
    r.w = r.w.with_hosts(hosts);
    r.w.deps.connectors = Arc::new(ScriptedRegistry::new().with_waker(r.waker.clone()));
    let (content, _) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    let hook = |url: &str| SetWake {
        api_key_id: content,
        kind: WakeKind::Webhook,
        routine_id: None,
        token: None,
        url: Some(url.into()),
        secret: Some("hook-SECRET".into()),
    };
    for refused in [
        "http://agents.example.com/wake",
        "https://10.0.0.5/wake",
        "https://user:pw@agents.example.com/",
    ] {
        let e = wake::set(&r.w.deps, &r.w.owner_ctx, hook(refused))
            .await
            .unwrap_err();
        support::assert_invalid(&e, "url");
    }
    let out = wake::set(
        &r.w.deps,
        &r.w.owner_ctx,
        hook("https://agents.example.com/wake?k=1"),
    )
    .await
    .unwrap();
    // Reads show the host only.
    assert_eq!(
        out.agents[0].address.as_ref().unwrap().target,
        "agents.example.com"
    );
    create_area(&r.w, &r.w.owner_ctx, "a").await;
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW + Duration::minutes(1)).await;
    let calls = r.waker.calls();
    assert_eq!(calls.len(), 1);
    let WakeCall::Webhook { url, secret, body } = calls[0].clone() else {
        panic!("one webhook call");
    };
    assert_eq!(url, "https://agents.example.com/wake?k=1");
    assert_eq!(secret.as_deref(), Some("hook-SECRET"));
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["agent_id", "at", "reasons", "workspace_id"]);
    assert_eq!(body["reasons"], json!(["content_requested"]));
}

#[tokio::test]
async fn a_manual_wake_needs_team_manage_or_the_works_manage_permission() {
    let r = rig().await;
    let (content, agent_ctx) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    routine(&r.w, content).await;
    // An agent may not, nor a member who manages neither the team nor the content.
    assert_eq!(
        wake::wake_now(&r.w.deps, &agent_ctx, content)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    let mut viewer = r.w.member("rep").await;
    viewer.permissions.retain(|p| p.key() == "workspace.read");
    assert_eq!(
        wake::wake_now(&r.w.deps, &viewer, content)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    // Who manages the content may: the wake goes out at once, without the settle time.
    let mut editor = viewer.clone();
    editor
        .permissions
        .insert(jt_tenancy::Permission::ContentManage);
    let out = wake::wake_now(&r.w.deps, &editor, content).await.unwrap();
    assert_eq!(pending_of(&out, content).unwrap().due_at, FIXED_NOW);
    assert_eq!(r.w.entries("agents.wake_now").len(), 1);
    jobs::run_agent_wake(&r.w.deps, FIXED_NOW).await;
    let entry = r.w.entries("agent.wake").pop().unwrap();
    assert_eq!(entry.payload["manual"], true);
    assert!(matches!(entry.actor, Actor::System { .. }));
    assert_eq!(entry.payload["outcome"], json!(WakeOutcome::Fired.key()));
}

#[tokio::test]
async fn the_interval_is_learned_from_the_agents_own_check_ins() {
    let r = rig().await;
    let (content, agent_ctx) = agent(&r.w, "content", &["workspace.read", "content.work"]).await;
    // Before any check-in: the workspace's day.
    let a = state(&r.w, FIXED_NOW)
        .await
        .agents
        .into_iter()
        .find(|a| a.api_key_id == content)
        .unwrap();
    assert_eq!((a.interval_minutes, a.interval_learned), (1440, false));
    for h in 0..4 {
        work::checkin(&r.w.deps, &at(&agent_ctx, FIXED_NOW + Duration::hours(h)))
            .await
            .unwrap();
    }
    let now = FIXED_NOW + Duration::hours(3) + Duration::minutes(10);
    let a = state(&r.w, now)
        .await
        .agents
        .into_iter()
        .find(|a| a.api_key_id == content)
        .unwrap();
    assert_eq!((a.interval_minutes, a.interval_learned), (60, true));
    assert_eq!(a.next_expected_at, Some(FIXED_NOW + Duration::hours(4)));
    // Lateness follows it: seventy minutes without a sight is overdue for an hourly agent.
    let late = at(
        &r.w.owner_ctx,
        FIXED_NOW + Duration::hours(3) + Duration::minutes(70),
    );
    let listed = agents::list(&r.w.deps, &late).await.unwrap();
    assert!(listed.iter().all(|c| c.overdue));
    let pending = work::pending(&r.w.deps, &late).await.unwrap();
    assert_eq!(pending.agent.interval_minutes, 60);
}
