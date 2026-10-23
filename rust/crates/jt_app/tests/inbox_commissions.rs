mod support;
use jt_app::{
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::inbox::{journeys, people},
};
use jt_inbox::{CommissionState, JourneyId, JourneyStatus, Task, TaskId, TaskStatus};
use serde_json::json;
use support::*;

async fn setup(owner: bool) -> (World, JourneyId) {
    let w = world().await;
    let p = people::create(&w.deps, &w.owner_ctx, serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})).unwrap()).await.unwrap();
    let id = w
        .uow
        .tenant(w.ws)
        .await
        .unwrap()
        .journeys()
        .open_for(p.person.id)
        .await
        .unwrap()
        .unwrap()
        .id;
    if owner {
        journeys::assign_owner(
            &w.deps,
            &w.owner_ctx,
            id,
            journeys::AssignOwnerInput {
                user_id: Some(w.owner),
            },
        )
        .await
        .unwrap();
    }
    (w, id)
}
fn won(key: &str) -> journeys::ReportInput {
    serde_json::from_value(json!({"kind":"won","idempotency_key":key,"payload":{"product":"Plan","amount_minor":150,"currency":"TRY"}})).unwrap()
}
#[tokio::test]
async fn duplicate_won_one_commission() {
    let (w, j) = setup(true).await;
    let (a, b) = tokio::join!(
        journeys::report(&w.deps, &w.owner_ctx, j, won("won")),
        journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
    );
    assert_ne!(a.unwrap().duplicate, b.unwrap().duplicate);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.commissions.len(), 1);
    assert_eq!(s.inbox.events.len(), 1);
    assert_eq!(s.inbox.commissions[0].commission.payee, Some(w.owner));
    assert_eq!(
        s.inbox.commissions[0].commission.state,
        CommissionState::Pending
    );
}
#[tokio::test]
async fn different_key_on_won_terminal() {
    let (w, j) = setup(true).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("one"))
        .await
        .unwrap();
    let e = journeys::report(&w.deps, &w.owner_ctx, j, won("two"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "terminal");
    assert_eq!(w.uow.snapshot().inbox.commissions.len(), 1);
}
#[tokio::test]
async fn no_payee_unassigned_followup() {
    let (w, j) = setup(false).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.commissions.len(), 1);
    assert_eq!(
        s.inbox.commissions[0].commission.state,
        CommissionState::NoPayee
    );
    assert_eq!(s.inbox.commissions[0].commission.payee, None);
    assert_eq!(s.inbox.tasks.len(), 1);
    assert_eq!(s.inbox.tasks[0].journey_id, j);
    assert_eq!(s.inbox.tasks[0].assignee, None);
    assert_eq!(s.inbox.tasks[0].status, TaskStatus::Open);
    assert_eq!(s.inbox.tasks[0].due_at, w.owner_ctx.now);
}
#[tokio::test]
async fn commission_and_won_rollback_with_task_effect() {
    let (w, j) = setup(true).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.tasks()
        .insert(Task {
            id: TaskId::new_v7(),
            workspace_id: w.ws,
            journey_id: j,
            title: "Call".into(),
            due_at: w.owner_ctx.now,
            assignee: Some(w.owner),
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let before = w.uow.snapshot();
    w.uow.fail_inbox_task_status(1);
    assert_eq!(
        journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal
    );
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.journeys, before.inbox.journeys);
    assert_eq!(after.inbox.events, before.inbox.events);
    assert_eq!(after.inbox.tasks, before.inbox.tasks);
    assert_eq!(after.inbox.commissions, before.inbox.commissions);
    assert_eq!(after.ledger.len(), before.ledger.len());
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Won
    );
    assert_eq!(w.uow.snapshot().inbox.commissions.len(), 1);
}

use jt_app::usecases::inbox::commissions;
use jt_tenancy::{Permission, UserId};

async fn rate(w: &World, user_id: Option<UserId>, rate_bp: u16) {
    commissions::set_rate(
        &w.deps,
        &w.owner_ctx,
        commissions::RateInput { user_id, rate_bp },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn override_beats_default() {
    let (w, j) = setup(true).await;
    rate(&w, None, 1000).await;
    rate(&w, Some(w.owner), 100).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("one"))
        .await
        .unwrap();
    let original = w.uow.snapshot().inbox.commissions[0].clone();
    assert_eq!(original.commission.rate_bp, 100);
    assert_eq!(original.commission.amount_minor, 2); // 1.5 rounds to even.
    rate(&w, None, 9000).await;
    rate(&w, Some(w.owner), 0).await;
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j,
        journeys::AssignOwnerInput { user_id: None },
    )
    .await
    .unwrap();
    assert_eq!(w.uow.snapshot().inbox.commissions[0], original);
    let p = w.uow.snapshot().inbox.journeys[0].person_id;
    let next = journeys::open(&w.deps, &w.owner_ctx, p).await.unwrap();
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        next.id,
        journeys::AssignOwnerInput {
            user_id: Some(w.owner),
        },
    )
    .await
    .unwrap();
    journeys::report(&w.deps, &w.owner_ctx, next.id, won("two"))
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.commissions[1]
            .commission
            .amount_minor,
        0
    );
}
#[tokio::test]
async fn default_rate_and_even_rounding() {
    let (w, j) = setup(true).await;
    rate(&w, None, 100).await;
    let mut input = won("one");
    input.payload["amount_minor"] = json!(250);
    journeys::report(&w.deps, &w.owner_ctx, j, input)
        .await
        .unwrap();
    let row = &w.uow.snapshot().inbox.commissions[0];
    assert_eq!(row.commission.rate_bp, 100);
    assert_eq!(row.commission.amount_minor, 2); // 2.5 rounds to even.
    assert_eq!(row.commission.currency, "TRY");
}
#[tokio::test]
async fn approve_then_pay_order() {
    let (w, j) = setup(true).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    let id = w.uow.snapshot().inbox.commissions[0].id;
    assert_eq!(
        commissions::pay(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let manager = w.member("manager").await;
    assert_eq!(
        commissions::approve(&w.deps, &manager, id)
            .await
            .unwrap()
            .commission
            .state,
        CommissionState::Approved
    );
    assert_eq!(
        commissions::approve(&w.deps, &manager, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        commissions::pay(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap()
            .commission
            .state,
        CommissionState::Paid
    );
    for error in [
        commissions::approve(&w.deps, &manager, id)
            .await
            .unwrap_err(),
        commissions::pay(&w.deps, &manager, id).await.unwrap_err(),
    ] {
        assert_eq!(error.code, ErrorCode::Conflict);
    }
    let s = w.uow.snapshot();
    for action in ["inbox.commission.approved", "inbox.commission.paid"] {
        assert_eq!(
            s.ledger
                .iter()
                .filter(|e| e.entry.action.as_str() == action)
                .count(),
            1
        );
    }
}
#[tokio::test]
async fn no_payee_never_payable_even_after_assignment() {
    let (w, j) = setup(false).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j,
        journeys::AssignOwnerInput {
            user_id: Some(w.owner),
        },
    )
    .await
    .unwrap();
    let id = w.uow.snapshot().inbox.commissions[0].id;
    assert_eq!(
        commissions::approve(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        commissions::pay(&w.deps, &w.owner_ctx, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}
#[tokio::test]
async fn commissions_permissions_filters_and_tenant_isolation() {
    let (w, j) = setup(true).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    let id = w.uow.snapshot().inbox.commissions[0].id;
    let mut rep = w.member("rep").await;
    assert_eq!(
        commissions::list(&w.deps, &rep, Default::default())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        commissions::set_rate(
            &w.deps,
            &rep,
            commissions::RateInput {
                user_id: None,
                rate_bp: 200
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Forbidden
    );
    rep.permissions.insert(Permission::InboxManage);
    assert_eq!(
        commissions::approve(&w.deps, &rep, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    assert_eq!(
        commissions::pay(&w.deps, &rep, id).await.unwrap_err().code,
        ErrorCode::Forbidden
    );
    rep.permissions.remove(&Permission::InboxWork);
    assert_eq!(
        commissions::list(&w.deps, &rep, Default::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    for (state, payee, count) in [
        (Some(CommissionState::Pending), Some(w.owner), 1),
        (Some(CommissionState::Paid), Some(w.owner), 0),
        (None, Some(UserId::new_v7()), 0),
    ] {
        assert_eq!(
            commissions::list(
                &w.deps,
                &w.owner_ctx,
                commissions::ListInput { state, payee }
            )
            .await
            .unwrap()
            .len(),
            count
        );
    }
    let (_, other) = w.other_workspace().await;
    assert!(
        commissions::list(&w.deps, &other, Default::default())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        commissions::approve(&w.deps, &other, id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        commissions::set_rate(
            &w.deps,
            &other,
            commissions::RateInput {
                user_id: Some(w.owner),
                rate_bp: 100
            }
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
}
#[tokio::test]
async fn commission_overflow_rolls_back_won() {
    let (w, j) = setup(true).await;
    rate(&w, None, u16::MAX).await;
    let before = w.uow.snapshot();
    let mut input = won("overflow");
    input.payload["amount_minor"] = json!(i64::MAX);
    assert_eq!(
        journeys::report(&w.deps, &w.owner_ctx, j, input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.journeys, before.inbox.journeys);
    assert_eq!(after.inbox.events, before.inbox.events);
    assert!(after.inbox.commissions.is_empty());
    assert_eq!(after.ledger.len(), before.ledger.len());
}

#[test]
fn commissions_catalog_and_shared_schemas() {
    use jt_app::{
        catalog::{GateMode, Risk, find},
        usecases::inbox::schema,
    };
    for (action, method, path, risk) in [
        (
            "commissions.list",
            "GET",
            "/api/inbox/commissions",
            Risk::Read,
        ),
        (
            "commissions.approve",
            "POST",
            "/api/inbox/commissions/{id}/approve",
            Risk::Write,
        ),
        (
            "commissions.pay",
            "POST",
            "/api/inbox/commissions/{id}/pay",
            Risk::Write,
        ),
        (
            "commission_rates.set",
            "PUT",
            "/api/inbox/commission-rates",
            Risk::Write,
        ),
    ] {
        let row = find(&format!("inbox.{action}")).expect("commission twin registered");
        assert_eq!(row.panel_route, Some((method, path)));
        assert_eq!(
            row.mcp_tool,
            Some(format!("jeeta.inbox.{}", action.replace('.', "_")).as_str())
        );
        assert_eq!(row.gate, GateMode::Gated);
        assert_eq!(row.risk, risk);
        assert_eq!(schema::input(action)["additionalProperties"], false);
    }
    let rate = schema::input("commission_rates.set");
    assert_eq!(rate["required"], json!(["rate_bp"]));
    assert_eq!(rate["properties"]["rate_bp"]["maximum"], u16::MAX);
    assert_eq!(
        schema::tool("commissions.approve")["required"],
        json!(["commission_id"])
    );
}

#[tokio::test]
async fn agent_report_pays_journey_owner_not_actor_or_issuer() {
    let (w, j) = setup(false).await;
    let rep = w.member("rep").await;
    let jt_ledger::Actor::Human { user_id } = rep.actor else {
        panic!("human member")
    };
    journeys::assign_owner(
        &w.deps,
        &w.owner_ctx,
        j,
        journeys::AssignOwnerInput {
            user_id: Some(user_id),
        },
    )
    .await
    .unwrap();
    rate(&w, Some(user_id), 100).await;
    rate(&w, Some(w.owner), 500).await;
    let agent = w.agent(&["inbox.work"]).await;
    journeys::report(&w.deps, &agent, j, won("agent-win"))
        .await
        .unwrap();
    let row = &w.uow.snapshot().inbox.commissions[0];
    assert_eq!(row.commission.payee, Some(user_id));
    assert_eq!(row.commission.rate_bp, 100);
}
#[tokio::test]
async fn concurrent_approval_has_one_decision() {
    let (w, j) = setup(true).await;
    journeys::report(&w.deps, &w.owner_ctx, j, won("won"))
        .await
        .unwrap();
    let id = w.uow.snapshot().inbox.commissions[0].id;
    let (a, b) = tokio::join!(
        commissions::approve(&w.deps, &w.owner_ctx, id),
        commissions::approve(&w.deps, &w.owner_ctx, id)
    );
    let results = [a, b];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .next()
            .unwrap()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        w.uow
            .snapshot()
            .ledger
            .iter()
            .filter(|e| e.entry.action.as_str() == "inbox.commission.approved")
            .count(),
        1
    );
}
