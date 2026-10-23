//! `ledger.list` over the in-memory fakes: the permission it needs, redaction of secret payload
//! keys, filters, and paging with its limits.

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::{LedgerFilter, UnitOfWork};
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::ledger::{self, DEFAULT_LIMIT, MAX_LIMIT};
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_tenancy::{AgentConnectionId, Permission, WorkspaceId};
use jt_testkit::fakes::{FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, SeqIdGen};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::macros::datetime;

const T0: OffsetDateTime = datetime!(2026-10-22 09:00 UTC);

/// A registered workspace and its owner's context.
async fn owner() -> (InMemoryUow, Deps, Ctx) {
    let uow = InMemoryUow::new();
    let deps = Deps {
        uow: Arc::new(uow.clone()),
        clock: Arc::new(FixedClock(T0)),
        ids: Arc::new(SeqIdGen::new()),
        tokens: Arc::new(FixedTokenGen::new(["aaaa", "owner-session"])),
        hasher: Arc::new(PlainHasher),
    };
    let out = auth::register(
        &deps,
        RegisterInput {
            email: "owner@acme.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Acme".into(),
        },
    )
    .await
    .unwrap();
    let principal = auth::resolve_session(&deps, "owner-session").await.unwrap();
    let ctx = auth::ctx_for(&principal, out.me.current_workspace.unwrap(), T0).unwrap();
    (uow, deps, ctx)
}

fn filter(limit: u32) -> LedgerFilter {
    LedgerFilter {
        action_prefix: None,
        actor_kind: None,
        limit,
        before_id: None,
    }
}

/// Appends entries with these actions and payloads to `ws`, as a system actor.
async fn append(uow: &InMemoryUow, ws: WorkspaceId, entries: &[(&str, Value)]) {
    let mut t = uow.tenant(ws).await.unwrap();
    for (action, payload) in entries {
        t.ledger()
            .append(LedgerEntry::new(
                ws,
                Actor::System {
                    component: "test".into(),
                },
                Action::new(action).unwrap(),
                payload.clone(),
                T0,
            ))
            .await
            .unwrap();
    }
    t.commit().await.unwrap();
}

#[tokio::test]
async fn list_requires_ledger_read() {
    let (_uow, deps, owner) = owner().await;
    let ctx = Ctx {
        permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage]),
        ..owner
    };
    let err = ledger::list(&deps, &ctx, filter(10)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert_eq!(err.details, json!({ "permission": "ledger.read" }));
}

#[tokio::test]
async fn list_redacts_secret_keys() {
    let (uow, deps, ctx) = owner().await;
    append(
        &uow,
        ctx.workspace_id,
        &[(
            "test.secret",
            json!({ "name": "CI", "plaintext": "jt_live_x", "nested": [{ "Token": "t" }] }),
        )],
    )
    .await;
    let out = ledger::list(&deps, &ctx, filter(1)).await.unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].entry.action.as_str(), "test.secret");
    assert_eq!(
        out[0].entry.payload,
        json!({ "name": "CI", "plaintext": "***", "nested": [{ "Token": "***" }] })
    );
    // The stored entry itself is untouched.
    let stored = uow
        .snapshot()
        .ledger
        .into_iter()
        .find(|r| r.id == out[0].id)
        .unwrap();
    assert_eq!(stored.entry.payload["plaintext"], "jt_live_x");
}

#[tokio::test]
async fn list_paginates_with_before_id_and_caps_limit_at_500() {
    let (uow, deps, ctx) = owner().await;
    // Registration wrote one entry; add 600 more.
    let many: Vec<(&str, Value)> = (0..600).map(|i| ("test.many", json!({ "i": i }))).collect();
    append(&uow, ctx.workspace_id, &many).await;
    let total = uow.snapshot().ledger.len();
    assert_eq!(total, 601);

    let capped = ledger::list(&deps, &ctx, filter(10_000)).await.unwrap();
    assert_eq!(capped.len(), MAX_LIMIT as usize);
    assert_eq!(MAX_LIMIT, 500);
    let ids: Vec<i64> = capped.iter().map(|e| e.id).collect();
    assert!(ids.windows(2).all(|w| w[0] > w[1]), "newest first");

    // A limit of zero still returns one entry.
    assert_eq!(ledger::list(&deps, &ctx, filter(0)).await.unwrap().len(), 1);
    assert_eq!(DEFAULT_LIMIT, 50);

    // The next page starts below the last id of this one and holds the rest.
    let last = *ids.last().unwrap();
    let next = ledger::list(
        &deps,
        &ctx,
        LedgerFilter {
            before_id: Some(last),
            ..filter(MAX_LIMIT)
        },
    )
    .await
    .unwrap();
    assert_eq!(next.len(), total - MAX_LIMIT as usize);
    assert!(next.iter().all(|e| e.id < last));
}

#[tokio::test]
async fn list_filters_by_action_prefix_and_actor_kind() {
    let (uow, deps, ctx) = owner().await;
    append(
        &uow,
        ctx.workspace_id,
        &[("team.invite", json!({})), ("roles.create", json!({}))],
    )
    .await;
    let mut t = uow.tenant(ctx.workspace_id).await.unwrap();
    let agent = Actor::Agent {
        connection_id: AgentConnectionId::new_v7(),
        user_id: jt_tenancy::UserId::new_v7(),
    };
    t.ledger()
        .append(LedgerEntry::new(
            ctx.workspace_id,
            agent,
            Action::new("mcp.tool_call").unwrap(),
            json!({}),
            T0,
        ))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let actions = |rows: Vec<ledger::LedgerEntryOut>| -> Vec<String> {
        rows.into_iter()
            .map(|r| r.entry.action.as_str().to_owned())
            .collect()
    };
    let team = ledger::list(
        &deps,
        &ctx,
        LedgerFilter {
            action_prefix: Some("team.".into()),
            ..filter(DEFAULT_LIMIT)
        },
    )
    .await
    .unwrap();
    assert_eq!(actions(team), ["team.invite"]);
    let agents = ledger::list(
        &deps,
        &ctx,
        LedgerFilter {
            actor_kind: Some("agent".into()),
            ..filter(DEFAULT_LIMIT)
        },
    )
    .await
    .unwrap();
    assert_eq!(actions(agents), ["mcp.tool_call"]);
}

#[tokio::test]
async fn list_rejects_an_unknown_actor_kind() {
    let (_uow, deps, ctx) = owner().await;
    let err = ledger::list(
        &deps,
        &ctx,
        LedgerFilter {
            actor_kind: Some("robot".into()),
            ..filter(DEFAULT_LIMIT)
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.details, json!({ "field": "actor_kind" }));
}

#[tokio::test]
async fn entries_serialise_with_their_id_and_the_redacted_entry() {
    let (uow, deps, ctx) = owner().await;
    append(
        &uow,
        ctx.workspace_id,
        &[("test.x", json!({ "secret": "s" }))],
    )
    .await;
    let out = ledger::list(&deps, &ctx, filter(1)).await.unwrap();
    let v = serde_json::to_value(&out[0]).unwrap();
    assert_eq!(v["id"], json!(out[0].id));
    assert_eq!(v["entry"]["action"], "test.x");
    assert_eq!(v["entry"]["payload"], json!({ "secret": "***" }));
}
