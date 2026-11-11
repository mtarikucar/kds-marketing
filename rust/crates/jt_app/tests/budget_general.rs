//! Bütçe (design 2026-11-10 §9): the one general ad budget (B37), spend shown by module and ad
//! campaign (S6), and the stop switches (S7, B36).
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::UnitOfWork,
    usecases::{
        budget::{self, BudgetItemInput, UpdateBudgetItem},
        spending::{self, BreakdownQuery, StopInput},
        studio::budget::{reserve_metered_for, settle_metered},
    },
};
use jt_capability::{
    BudgetItemId, BudgetSpend, BudgetSpendId, NewBudgetSpend, Period, SpendSource,
};
use jt_ledger::Actor;
use jt_tenancy::AgentConnectionId;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::*;
use uuid::Uuid;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn agent(w: &World) -> Ctx {
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            user_id,
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

fn ad_budget(name: &str, cap: i64, period: &str, general: bool) -> BudgetItemInput {
    input(
        json!({"name":name,"kind":"ad_budget","unit":{"kind":"currency","value":"TRY"},
        "cap":cap,"period":period,"general":general}),
    )
}

fn general(patch: Option<bool>) -> UpdateBudgetItem {
    UpdateBudgetItem {
        general: patch,
        ..Default::default()
    }
}

/// The world's strategy caps the paid lane at 100.000 (minor) TRY a month.
#[tokio::test]
async fn the_general_ad_budget_is_one_periodic_ad_budget_within_the_strategy_cap() {
    let w = world().await;
    // Only an ad budget in a currency with a period that is not `total`.
    for refused in [
        input::<BudgetItemInput>(json!({"name":"Kasa","kind":"cash",
            "unit":{"kind":"currency","value":"TRY"},"cap":100,"period":"monthly","general":true})),
        ad_budget("Toplam", 100, "total", true),
    ] {
        let e = budget::create_item(&w.d, &w.ctx, refused)
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
        assert_eq!(e.details["field"], "general");
    }
    // Not above the strategy's paid cap, both brought to the item's period: a month of 100.000
    // is 23.333 a week and 3.333 a day.
    for (period, most) in [("monthly", 100_000), ("weekly", 23_333), ("daily", 3_333)] {
        let e = budget::create_item(&w.d, &w.ctx, ad_budget("Reklam", most + 1, period, true))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{period}: {e:?}");
        assert_eq!(e.details["reason"], "above_strategy_cap", "{period}");
        assert_eq!(e.details["cap"], most, "{period}");
    }
    assert!(w.uow.snapshot().budget_items.iter().all(|i| !i.general));

    let first = budget::create_item(&w.d, &w.ctx, ad_budget("Reklam", 100_000, "monthly", true))
        .await
        .unwrap()
        .item;
    assert!(first.general);
    // One per workspace: a second is refused, on creation and on edit.
    let e = budget::create_item(&w.d, &w.ctx, ad_budget("İkinci", 50_000, "monthly", true))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["reason"], "general_exists");
    let second = budget::create_item(&w.d, &w.ctx, ad_budget("İkinci", 50_000, "monthly", false))
        .await
        .unwrap()
        .item;
    let e = budget::update_item(&w.d, &w.ctx, second.id, general(Some(true)))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "general_exists");

    // The general budget keeps its rules through its edits: its cap, its period.
    let e = budget::update_item(
        &w.d,
        &w.ctx,
        first.id,
        UpdateBudgetItem {
            cap: Some(100_001),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "above_strategy_cap");
    let e = budget::update_item(
        &w.d,
        &w.ctx,
        first.id,
        UpdateBudgetItem {
            period: Some(Period::Total),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["field"], "general");
    // An ordinary ad budget is not held to the strategy's cap.
    budget::update_item(
        &w.d,
        &w.ctx,
        second.id,
        UpdateBudgetItem {
            cap: Some(900_000),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // The mark moves: off the first, on to the second once its cap fits.
    let off = budget::update_item(&w.d, &w.ctx, first.id, general(Some(false)))
        .await
        .unwrap();
    assert!(!off.item.general);
    let e = budget::update_item(&w.d, &w.ctx, second.id, general(Some(true)))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "above_strategy_cap");
    let on = budget::update_item(
        &w.d,
        &w.ctx,
        second.id,
        UpdateBudgetItem {
            cap: Some(80_000),
            general: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(on.item.general);
    // A retired general budget leaves room for another.
    budget::retire_item(&w.d, &w.ctx, second.id, true)
        .await
        .unwrap();
    let again = budget::update_item(&w.d, &w.ctx, first.id, general(Some(true)))
        .await
        .unwrap();
    assert!(again.item.general);
    let listed = budget::list_items(&w.d, &w.ctx).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .filter(|i| i.item.general && i.item.retired_at.is_none())
            .count(),
        1
    );
}

/// A cash item with a unit price, linked to the world's X account: its sends are metered.
async fn metered(w: &World) -> BudgetItemId {
    let item = budget::create_item(
        &w.d,
        &w.ctx,
        input(
            json!({"name":"Mesaj","kind":"cash","unit":{"kind":"currency","value":"TRY"},
            "cap":1000,"period":"monthly","unit_cost_minor":3}),
        ),
    )
    .await
    .unwrap()
    .item
    .id;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.budget().link(w.f.slot.capability_id, item).await.unwrap();
    r.commit().await.unwrap();
    item
}

/// Reserves `units` metered sends of `module` and settles them at their price, or answers the
/// refusal's reason.
async fn send(w: &World, key: &str, module: &str, units: u64) -> Result<(), String> {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let cap = r
        .capabilities()
        .find(w.f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    let spend = reserve_metered_for(
        r.as_mut(),
        &cap,
        None,
        Some(units),
        key.into(),
        FIXED_NOW,
        Some(module),
    )
    .await
    .map_err(|e| e.details["reason"].as_str().unwrap_or("?").to_owned())?
    .expect("a metered send reserves");
    let actual = spend.request.amount_minor;
    settle_metered(r.as_mut(), spend, Ok(Some(actual)))
        .await
        .unwrap();
    r.commit().await.unwrap();
    Ok(())
}

async fn record(
    w: &World,
    item: BudgetItemId,
    amount: i64,
    module: Option<&str>,
    campaign: Option<Uuid>,
) {
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.budget()
        .append_spend(
            BudgetSpend::new(
                BudgetSpendId(Uuid::now_v7()),
                w.f.ws,
                item,
                NewBudgetSpend {
                    amount,
                    source: SpendSource::Agent,
                    reference: None,
                    module: module.map(str::to_owned),
                    campaign_id: campaign,
                },
                FIXED_NOW,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
}

async fn read(w: &World, ctx: &Ctx) -> spending::Breakdown {
    spending::breakdown(&w.d, ctx, BreakdownQuery::default())
        .await
        .unwrap()
}

#[tokio::test]
async fn spend_is_shown_by_module_and_campaign_and_spend_by_hand_apart() {
    let w = world().await;
    let item = metered(&w).await;
    let campaign = Uuid::now_v7();
    // Two messages through the inbox and one of a campaign's steps, at 3 each; a call's cost; an
    // ad campaign's spend; and an invoice a person typed in.
    send(&w, "outbox:1", "inbox", 2).await.unwrap();
    send(&w, "outbox:2", "outreach", 1).await.unwrap();
    record(&w, item, 40, Some("calls"), None).await;
    record(&w, item, 700, Some("ads"), Some(campaign)).await;
    record(&w, item, 55, Some("ads"), None).await;
    budget::record_spend(&w.d, &w.ctx, item, 9, Some("fatura".into()))
        .await
        .unwrap();

    let out = read(&w, &agent(&w)).await;
    let mine = out.items.iter().find(|i| i.item_id == item).unwrap();
    assert_eq!(
        serde_json::to_value(mine).unwrap(),
        json!({"item_id": item,
               "modules": [
                 {"module":"ads","spent_minor":755,
                  "campaigns":[{"campaign_id":campaign,"title":"","spent_minor":700}]},
                 {"module":"inbox","spent_minor":6,"campaigns":[]},
                 {"module":"outreach","spent_minor":3,"campaigns":[]},
                 {"module":"calls","spent_minor":40,"campaigns":[]}],
               "unattributed_minor": 9})
    );
    // A module named by nobody that spends is not stored as one.
    record(&w, item, 5, Some("strategy"), Some(campaign)).await;
    let out = read(&w, &w.ctx).await;
    let mine = out.items.iter().find(|i| i.item_id == item).unwrap();
    assert_eq!(mine.unattributed_minor, 14);
    assert_eq!(mine.modules.len(), 4);

    // A period before the spend holds none of it; a period the wrong way round is refused.
    let earlier = spending::breakdown(
        &w.d,
        &w.ctx,
        input(json!({"from":"2026-09-01T00:00:00Z","until":"2026-10-01T00:00:00Z"})),
    )
    .await
    .unwrap();
    let mine = earlier.items.iter().find(|i| i.item_id == item).unwrap();
    assert!(mine.modules.is_empty());
    assert_eq!(mine.unattributed_minor, 0);
    for q in [
        json!({"from":"2026-10-22T00:00:00Z","until":"2026-10-21T00:00:00Z"}),
        json!({"from":"2024-01-01T00:00:00Z","until":"2026-10-21T00:00:00Z"}),
        json!({"from":"dün"}),
    ] {
        let e = spending::breakdown(&w.d, &w.ctx, input(q))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    }
    // Whoever neither manages the budget nor works in a module does not read it.
    let mut bare = agent(&w);
    bare.permissions = [jt_tenancy::Permission::WorkspaceRead].into();
    assert_eq!(
        spending::breakdown(&w.d, &bare, BreakdownQuery::default())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
}

fn stop(scope: Value, stopped: bool, revision: u64) -> StopInput {
    input(json!({"scope":scope,"stopped":stopped,"expected_revision":revision}))
}

#[tokio::test]
async fn stopping_spending_is_a_persons_and_refuses_the_module_at_the_gate() {
    let w = world().await;
    metered(&w).await;
    let start = read(&w, &w.ctx).await.stop;
    assert_eq!((start.all, start.modules.len()), (false, 0));

    // Only a person, in person, against the control as it stands, and only a module that spends.
    let e = spending::stop(&w.d, &agent(&w), stop(json!("all"), true, start.revision))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    let e = spending::stop(&w.d, &w.ctx, stop(json!("all"), true, start.revision + 7))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    let e = spending::stop(
        &w.d,
        &w.ctx,
        stop(json!({"module":"strategy"}), true, start.revision),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(read(&w, &w.ctx).await.stop, start);

    // The inbox stopped: its sends are refused at the gate, a campaign's step still goes.
    let state = spending::stop(
        &w.d,
        &w.ctx,
        stop(json!({"module":"inbox"}), true, start.revision),
    )
    .await
    .unwrap();
    assert_eq!(state.modules, ["inbox"]);
    assert!(!state.all);
    assert_eq!(
        send(&w, "outbox:1", "inbox", 1).await.unwrap_err(),
        "spend_stopped"
    );
    send(&w, "outbox:2", "outreach", 1).await.unwrap();

    // Advertising stopped: that is the paid lane's brake.
    let state = spending::stop(
        &w.d,
        &w.ctx,
        stop(json!({"module":"ads"}), true, state.revision),
    )
    .await
    .unwrap();
    assert_eq!(state.modules, ["ads", "inbox"]);
    assert!(w.uow.snapshot().studio.controls[0].brake_engaged_for(jt_strategy::LaneKind::Paid));
    let state = spending::stop(
        &w.d,
        &w.ctx,
        stop(json!({"module":"ads"}), false, state.revision),
    )
    .await
    .unwrap();
    assert_eq!(state.modules, ["inbox"]);

    // All spending stopped: every module is refused, and advertising is braked.
    let state = spending::stop(&w.d, &w.ctx, stop(json!("all"), true, state.revision))
        .await
        .unwrap();
    assert!(state.all);
    assert_eq!(state.modules, ["ads", "inbox"]);
    for module in ["inbox", "outreach", "social"] {
        assert_eq!(
            send(&w, &format!("outbox:all-{module}"), module, 1)
                .await
                .unwrap_err(),
            "spend_stopped",
            "{module}"
        );
    }
    // Let go on: what was stopped on its own stays stopped, the rest flows.
    let state = spending::stop(&w.d, &w.ctx, stop(json!("all"), false, state.revision))
        .await
        .unwrap();
    assert!(!state.all);
    assert_eq!(state.modules, ["inbox"]);
    send(&w, "outbox:3", "outreach", 1).await.unwrap();
    assert_eq!(
        send(&w, "outbox:4", "inbox", 1).await.unwrap_err(),
        "spend_stopped"
    );
    let state = spending::stop(
        &w.d,
        &w.ctx,
        stop(json!({"module":"inbox"}), false, state.revision),
    )
    .await
    .unwrap();
    assert!(state.modules.is_empty());
    send(&w, "outbox:4", "inbox", 1).await.unwrap();

    // The workspace-wide brake reads as "all", and letting all spending go on releases it.
    let control = w.brake(true, None, state.revision).await;
    let stopped = read(&w, &w.ctx).await.stop;
    assert!(stopped.all);
    let state = spending::stop(&w.d, &w.ctx, stop(json!("all"), false, control.revision))
        .await
        .unwrap();
    assert!(!state.all);
    assert!(!w.uow.snapshot().studio.controls[0].brake_engaged);

    // Every change is in the ledger.
    let stops = w
        .uow
        .snapshot()
        .ledger
        .iter()
        .filter(|l| l.entry.action.as_str() == "budget.stop")
        .count();
    assert_eq!(stops, 7);
}
