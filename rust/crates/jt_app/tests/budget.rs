//! The budget use cases over the in-memory fakes: creating and listing budget items, recording
//! spend from them (over the cap too) and reading their spend. One test per rule.

mod support;

use jt_app::error::ErrorCode;
use jt_app::usecases::budget::{self, BudgetItemInput};
use jt_capability::{BudgetItemId, BudgetKind, BudgetSpendId, Period, SpendSource, Unit};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::Duration;

fn monthly(name: &str, cap: i64) -> BudgetItemInput {
    BudgetItemInput {
        name: name.into(),
        kind: BudgetKind::Cash,
        unit: Unit::Currency("TRY".into()),
        cap,
        period: Period::Monthly,
    }
}

async fn create(w: &World, input: BudgetItemInput) -> BudgetItemId {
    budget::create_item(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap()
        .item
        .id
}

#[tokio::test]
async fn create_item_needs_budget_manage_and_valid_fields() {
    let w = world().await;
    let rep = w.member("rep").await;
    let capability_manager = w.agent(&["workspace.read", "capabilities.manage"]).await;
    for ctx in [&rep, &capability_manager] {
        let e = err(budget::create_item(&w.deps, ctx, monthly("Kasa", 1_000)).await);
        assert_forbidden(&e, "budget.manage");
    }
    let cases = [
        (monthly("  ", 1_000), "name"),
        (monthly("Kasa", -1), "cap"),
        (
            BudgetItemInput {
                unit: Unit::Currency("try".into()),
                ..monthly("Kasa", 1_000)
            },
            "unit",
        ),
        (
            BudgetItemInput {
                unit: Unit::Count(String::new()),
                ..monthly("Kasa", 1_000)
            },
            "unit",
        ),
    ];
    for (input, field) in cases {
        assert_invalid(
            &err(budget::create_item(&w.deps, &w.owner_ctx, input).await),
            field,
        );
    }
    // From JSON, an unknown field is refused.
    let parsed: Result<BudgetItemInput, _> = serde_json::from_value(json!({
        "name": "Kasa", "kind": "cash", "unit": { "kind": "currency", "value": "TRY" },
        "cap": 1000, "period": "monthly", "rollover": true,
    }));
    assert!(parsed.is_err());
    assert!(w.uow.snapshot().budget_items.is_empty());
    assert!(w.ledger("budget.").is_empty());
}

#[tokio::test]
async fn create_item_starts_with_nothing_spent() {
    let w = world().await;
    let version = w.approve_strategy().await;
    let manager = w.member("manager").await;
    let out = budget::create_item(
        &w.deps,
        &manager,
        BudgetItemInput {
            name: " Filament ".into(),
            kind: BudgetKind::Consumable,
            unit: Unit::Count("makara".into()),
            cap: 4,
            period: Period::Weekly,
        },
    )
    .await
    .unwrap();
    assert_eq!(out.item.name, "Filament");
    assert_eq!(out.item.workspace_id, w.ws);
    assert_eq!(out.item.created_at, FIXED_NOW);
    assert_eq!(out.item.strategy_version_id, Some(version.as_uuid()));
    assert_eq!((out.spent_in_period, out.remaining), (0, 4));

    let entry = &w.entries("budget.items.create")[0];
    assert_eq!(
        entry.payload,
        json!({
            "name": "Filament",
            "kind": "consumable",
            "unit": { "kind": "count", "value": "makara" },
            "cap": 4,
            "period": "weekly",
        })
    );
    let subject = entry.subject.as_ref().unwrap();
    assert_eq!(
        (subject.kind.as_str(), subject.id.clone()),
        ("budget_item", out.item.id.to_string())
    );
    assert_eq!(entry.strategy_version_id, Some(version.as_uuid()));

    let listed = budget::list_items(&w.deps, &w.member("rep").await)
        .await
        .unwrap();
    assert_eq!(listed, [out]);
}

#[tokio::test]
async fn spend_is_recorded_by_agents_and_people_with_workspace_read() {
    let w = world().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    let agent = w.agent(&["workspace.read"]).await;
    let rep = w.member("rep").await;

    let by_agent = budget::record_spend(&w.deps, &agent, item, 2_500, Some(" fatura-17 ".into()))
        .await
        .unwrap();
    assert_eq!(by_agent.spend.source, SpendSource::Agent);
    assert_eq!(by_agent.spend.reference.as_deref(), Some("fatura-17"));
    assert_eq!(by_agent.spend.amount, 2_500);
    assert_eq!(by_agent.spend.at, FIXED_NOW);
    assert_eq!(by_agent.remaining, 7_500);

    let by_rep = budget::record_spend(&w.deps, &rep, item, 500, Some("   ".into()))
        .await
        .unwrap();
    assert_eq!(by_rep.spend.source, SpendSource::Human);
    assert_eq!(by_rep.spend.reference, None);
    assert_eq!(by_rep.remaining, 7_000);

    let entries = w.entries("budget.spend.record");
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].payload,
        json!({
            "item_id": item.to_string(),
            "amount": 2_500,
            "source": "agent",
            "reference": "fatura-17",
        })
    );
    assert_eq!(
        entries[1].payload,
        json!({ "item_id": item.to_string(), "amount": 500, "source": "human" })
    );
    assert_eq!(entries[0].subject.as_ref().unwrap().kind, "budget_spend");
    assert_eq!(
        entries[0].subject.as_ref().unwrap().id,
        by_agent.spend.id.to_string()
    );
    assert_eq!(entries[0].actor, agent.actor);
    assert!(w.entries("budget.over_cap").is_empty());

    let auditor = w.agent(&["ledger.read"]).await;
    assert_forbidden(
        &err(budget::record_spend(&w.deps, &auditor, item, 1, None).await),
        "workspace.read",
    );
}

#[tokio::test]
async fn amount_must_be_positive_and_the_reference_bounded() {
    let w = world().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    for amount in [0, -5] {
        assert_invalid(
            &err(budget::record_spend(&w.deps, &w.owner_ctx, item, amount, None).await),
            "amount",
        );
    }
    assert_invalid(
        &err(budget::record_spend(&w.deps, &w.owner_ctx, item, 1, Some("x".repeat(257))).await),
        "reference",
    );
    let e = err(budget::record_spend(&w.deps, &w.owner_ctx, BudgetItemId::new_v7(), 1, None).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(w.uow.snapshot().budget_spend.is_empty());
}

#[tokio::test]
async fn over_cap_spend_is_recorded_and_flagged() {
    let w = world().await;
    let version = w.approve_strategy().await;
    let item = create(&w, monthly("Kasa", 1_000)).await;
    let first = budget::record_spend(&w.deps, &w.owner_ctx, item, 800, None)
        .await
        .unwrap();
    assert_eq!(first.remaining, 200);
    assert!(w.entries("budget.over_cap").is_empty());

    let over = budget::record_spend(&w.deps, &w.owner_ctx, item, 500, None)
        .await
        .unwrap();
    assert_eq!(over.remaining, -300);
    assert_eq!(w.uow.snapshot().budget_spend.len(), 2, "recorded anyway");
    let flags = w.entries("budget.over_cap");
    assert_eq!(flags.len(), 1);
    assert_eq!(
        flags[0].payload,
        json!({ "item_id": item.to_string(), "remaining": -300 })
    );
    let subject = flags[0].subject.as_ref().unwrap();
    assert_eq!(
        (subject.kind.as_str(), subject.id.clone()),
        ("budget_item", item.to_string())
    );
    assert_eq!(flags[0].strategy_version_id, Some(version.as_uuid()));

    let listed = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(
        (listed[0].spent_in_period, listed[0].remaining),
        (1_300, -300)
    );
}

#[tokio::test]
async fn list_items_count_only_the_current_period() {
    let w = world().await;
    let monthly_item = create(&w, monthly("Aylık", 1_000)).await;
    let total_item = create(
        &w,
        BudgetItemInput {
            period: Period::Total,
            ..monthly("Toplam", 1_000)
        },
    )
    .await;
    // Spent last month and this month.
    let last_month = at(&w.owner_ctx, FIXED_NOW - Duration::days(31));
    for id in [monthly_item, total_item] {
        budget::record_spend(&w.deps, &last_month, id, 300, None)
            .await
            .unwrap();
        budget::record_spend(&w.deps, &w.owner_ctx, id, 100, None)
            .await
            .unwrap();
    }
    let listed = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    let spent: Vec<(BudgetItemId, i64, i64)> = listed
        .iter()
        .map(|o| (o.item.id, o.spent_in_period, o.remaining))
        .collect();
    assert_eq!(spent, [(monthly_item, 100, 900), (total_item, 400, 600)]);
}

#[tokio::test]
async fn spend_pages_newest_first_by_keyset() {
    let w = world().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    let earlier = at(&w.owner_ctx, FIXED_NOW - Duration::hours(1));
    let old = budget::record_spend(&w.deps, &earlier, item, 1, None)
        .await
        .unwrap()
        .spend;
    let mut same_instant = Vec::new();
    for amount in [2, 3, 4] {
        same_instant.push(
            budget::record_spend(&w.deps, &w.owner_ctx, item, amount, None)
                .await
                .unwrap()
                .spend,
        );
    }
    let rep = w.member("rep").await;
    let first = budget::spend(&w.deps, &rep, item, 2, None).await.unwrap();
    let last = first.last().unwrap();
    let second = budget::spend(&w.deps, &rep, item, 2, Some((last.at, last.id)))
        .await
        .unwrap();
    let ids: Vec<BudgetSpendId> = first.iter().chain(&second).map(|s| s.id).collect();
    let mut expected: Vec<BudgetSpendId> = same_instant.iter().map(|s| s.id).collect();
    expected.sort();
    expected.reverse();
    expected.push(old.id);
    assert_eq!(ids, expected, "every entry once, newest first");

    let e = err(budget::spend(&w.deps, &rep, BudgetItemId::new_v7(), 10, None).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let auditor = w.agent(&["ledger.read"]).await;
    assert_forbidden(
        &err(budget::spend(&w.deps, &auditor, item, 10, None).await),
        "workspace.read",
    );
    assert_forbidden(
        &err(budget::list_items(&w.deps, &auditor).await),
        "workspace.read",
    );
}
