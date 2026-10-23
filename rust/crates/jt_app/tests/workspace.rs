//! `workspace.info` over the in-memory fakes: the caller's workspace with their role and
//! permissions there.

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::workspace;
use jt_ledger::Actor;
use jt_tenancy::{
    AgentConnectionId, MembershipId, Permission, SystemRole, UserId, WorkspaceStatus,
};
use jt_testkit::fakes::{FIXED_NOW, FixedTokenGen, InMemoryUow, deps};
use time::OffsetDateTime;

/// The instant the clock of `fakes::deps` reads.
const T0: OffsetDateTime = FIXED_NOW;

fn world(tokens: &[&str]) -> (InMemoryUow, Deps) {
    let uow = InMemoryUow::new();
    let deps = Deps {
        tokens: Arc::new(FixedTokenGen::new(tokens.iter().copied())),
        ..deps(Arc::new(uow.clone()))
    };
    (uow, deps)
}

fn input(email: &str, workspace_name: &str) -> RegisterInput {
    RegisterInput {
        email: email.into(),
        password: "correct horse battery".into(),
        display_name: "Owner".into(),
        workspace_name: workspace_name.into(),
    }
}

#[tokio::test]
async fn info_shows_the_workspace_with_the_callers_role_and_permissions() {
    let (uow, deps) = world(&["aaaa", "a1", "bbbb", "b1"]);
    let a = auth::register(&deps, input("owner@a.example", "Alpha Ajans"))
        .await
        .unwrap();
    let b = auth::register(&deps, input("owner@b.example", "Beta"))
        .await
        .unwrap();
    let (ws_a, ws_b) = (
        a.me.current_workspace.unwrap(),
        b.me.current_workspace.unwrap(),
    );

    // The owner of Alpha.
    let principal = auth::resolve_session(&deps, "a1").await.unwrap();
    let ctx = auth::ctx_for(&principal, ws_a, T0).unwrap();
    let out = workspace::info(&deps, &ctx).await.unwrap();
    assert_eq!(out.id, ws_a);
    assert_eq!(out.name, "Alpha Ajans");
    assert_eq!(out.slug, "alpha-ajans-aaaa");
    assert_eq!(out.status, WorkspaceStatus::PendingPayment);
    assert_eq!(out.my_role, "owner");
    assert_eq!(out.my_permissions, SystemRole::Owner.permissions());

    // Alpha's owner joins Beta as a rep and sees Beta through a rep's eyes.
    let rep = {
        let mut t = uow.tenant(ws_b).await.unwrap();
        t.roles().find_by_key("rep").await.unwrap().unwrap()
    };
    let mut u = uow.user().await.unwrap();
    u.memberships_insert_active(MembershipId::new_v7(), ws_b, a.me.user_id, rep.id, T0)
        .await
        .unwrap();
    u.commit().await.unwrap();
    let principal = auth::resolve_session(&deps, "a1").await.unwrap();
    let ctx = auth::ctx_for(&principal, ws_b, T0).unwrap();
    let out = workspace::info(&deps, &ctx).await.unwrap();
    assert_eq!(out.id, ws_b);
    assert_eq!(out.name, "Beta");
    assert_eq!(out.my_role, "rep");
    assert_eq!(
        out.my_permissions,
        BTreeSet::from([Permission::WorkspaceRead, Permission::InboxWork])
    );

    // Serialised as the panel and agents receive it.
    let json = serde_json::to_value(&out).unwrap();
    assert_eq!(json["id"], serde_json::json!(ws_b));
    assert_eq!(json["status"], "pending_payment");
    assert_eq!(json["my_role"], "rep");
    assert_eq!(
        json["my_permissions"],
        serde_json::json!(["workspace.read", "inbox.work"])
    );
}

#[tokio::test]
async fn info_needs_workspace_read_and_a_membership() {
    let (_uow, deps) = world(&["aaaa", "a1"]);
    let a = auth::register(&deps, input("owner@a.example", "Alpha"))
        .await
        .unwrap();
    let ws = a.me.current_workspace.unwrap();
    let principal = auth::resolve_session(&deps, "a1").await.unwrap();

    // An agent key without `workspace.read`.
    let mut ctx = auth::ctx_for(&principal, ws, T0).unwrap();
    ctx.permissions.remove(&Permission::WorkspaceRead);
    let e = workspace::info(&deps, &ctx).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);

    // An agent acting for the owner sees the owner's role.
    let mut ctx = auth::ctx_for(&principal, ws, T0).unwrap();
    ctx.actor = Actor::Agent {
        connection_id: AgentConnectionId::new_v7(),
        user_id: a.me.user_id,
    };
    assert_eq!(workspace::info(&deps, &ctx).await.unwrap().my_role, "owner");

    // A caller who is not a member of the workspace.
    let mut ctx = auth::ctx_for(&principal, ws, T0).unwrap();
    ctx.actor = Actor::Human {
        user_id: UserId::new_v7(),
    };
    let e = workspace::info(&deps, &ctx).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
}
