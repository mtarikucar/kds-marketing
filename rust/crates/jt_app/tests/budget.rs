//! The budget use cases over the in-memory fakes: creating, listing, editing and retiring budget
//! items, recording spend from them (over the cap too) and reading their spend. One test per
//! rule.

mod support;

use jt_app::error::ErrorCode;
use jt_app::usecases::budget::{self, BudgetItemInput, UpdateBudgetItem};
use jt_app::usecases::capabilities;
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
async fn budget_item_unit_must_fit_its_kind() {
    let w = world().await;
    let item = |kind: BudgetKind, unit: Unit| BudgetItemInput {
        kind,
        unit,
        ..monthly("Kalem", 100)
    };
    let mismatches = [
        item(BudgetKind::Cash, Unit::Minutes),
        item(BudgetKind::AdBudget, Unit::Count("tıklama".into())),
        item(BudgetKind::SmsBudget, Unit::Minutes),
        item(BudgetKind::Consumable, Unit::Currency("TRY".into())),
        item(BudgetKind::AgentQuota, Unit::Minutes),
        item(BudgetKind::AgentHours, Unit::Currency("TRY".into())),
        item(BudgetKind::AgentHours, Unit::Count("saat".into())),
    ];
    for input in mismatches {
        let e = err(budget::create_item(&w.deps, &w.owner_ctx, input.clone()).await);
        assert_eq!(e.code, ErrorCode::Validation, "{input:?}");
        assert_eq!(e.details, json!({ "reason": "unit_mismatch" }), "{input:?}");
    }
    assert!(w.uow.snapshot().budget_items.is_empty());
    for input in [
        item(BudgetKind::SmsBudget, Unit::Currency("TRY".into())),
        item(BudgetKind::AgentQuota, Unit::Count("istek".into())),
        item(BudgetKind::AgentHours, Unit::Minutes),
    ] {
        budget::create_item(&w.deps, &w.owner_ctx, input)
            .await
            .unwrap();
    }
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

#[test]
fn spend_cursor_takes_both_halves_or_neither() {
    let id = BudgetSpendId::new_v7();
    assert_eq!(budget::spend_cursor(None, None).unwrap(), None);
    assert_eq!(
        budget::spend_cursor(Some("2026-10-22T09:00:00Z"), Some(id)).unwrap(),
        Some((FIXED_NOW, id))
    );
    for (at, id, field) in [
        (Some("2026-10-22T09:00:00Z"), None, "before_id"),
        (None, Some(id), "before_at"),
        (Some("yesterday"), Some(id), "before_at"),
    ] {
        let e = budget::spend_cursor(at, id).unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation);
        assert_eq!(e.details, json!({ "field": field }));
    }
}

// ---------------------------------------------------------------------------------------------
// Editing and retiring
// ---------------------------------------------------------------------------------------------

fn edit(name: Option<&str>, cap: Option<i64>, period: Option<Period>) -> UpdateBudgetItem {
    UpdateBudgetItem {
        name: name.map(Into::into),
        cap,
        period,
    }
}

#[tokio::test]
async fn budget_item_update_keeps_kind_unit_and_spend() {
    let w = world().await;
    let version = w.approve_strategy().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    budget::record_spend(&w.deps, &w.owner_ctx, item, 6_000, Some("fatura-1".into()))
        .await
        .unwrap();

    // A cap below what was already spent is allowed: the spend stays and the item reads over
    // its cap.
    let manager = w.member("manager").await;
    let out = budget::update_item(&w.deps, &manager, item, edit(None, Some(5_000), None))
        .await
        .unwrap();
    assert_eq!(out.item.cap, 5_000);
    assert_eq!(out.item.kind, BudgetKind::Cash);
    assert_eq!(out.item.unit, Unit::Currency("TRY".into()));
    assert_eq!(out.item.period, Period::Monthly);
    assert_eq!(out.item.name, "Kasa");
    assert_eq!(out.item.retired_at, None);
    assert_eq!((out.spent_in_period, out.remaining), (6_000, -1_000));
    let spend = budget::spend(&w.deps, &w.owner_ctx, item, 10, None)
        .await
        .unwrap();
    assert_eq!(spend.len(), 1);
    assert_eq!(spend[0].amount, 6_000);
    let entries = w.entries("budget.items.update");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({ "cap": 5_000, "previous": { "cap": 10_000 } })
    );
    let subject = entries[0].subject.as_ref().unwrap();
    assert_eq!(
        (subject.kind.as_str(), subject.id.clone()),
        ("budget_item", item.to_string())
    );
    assert_eq!(entries[0].strategy_version_id, Some(version.as_uuid()));
    assert_eq!(entries[0].actor, manager.actor);

    // The name (trimmed) and the period; only what changed is ledgered.
    let out = budget::update_item(
        &w.deps,
        &w.owner_ctx,
        item,
        edit(Some("  Kasa 2  "), Some(5_000), Some(Period::Weekly)),
    )
    .await
    .unwrap();
    assert_eq!(
        (out.item.name.as_str(), out.item.period),
        ("Kasa 2", Period::Weekly)
    );
    assert_eq!(
        w.entries("budget.items.update")[1].payload,
        json!({
            "name": "Kasa 2",
            "period": "weekly",
            "previous": { "name": "Kasa", "period": "monthly" },
        })
    );
    let listed = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(listed, std::slice::from_ref(&out));

    // Naming what it already is changes nothing and writes nothing.
    let same = budget::update_item(
        &w.deps,
        &w.owner_ctx,
        item,
        edit(Some("Kasa 2"), None, None),
    )
    .await
    .unwrap();
    assert_eq!(same, out);
    assert_eq!(w.entries("budget.items.update").len(), 2);

    // Nothing named, a bad name or a negative cap is VALIDATION; the kind and the unit are not
    // fields of an edit at all.
    let e = err(budget::update_item(&w.deps, &w.owner_ctx, item, edit(None, None, None)).await);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details, json!({ "fields": ["name", "cap", "period"] }));
    assert_invalid(
        &err(budget::update_item(&w.deps, &w.owner_ctx, item, edit(Some(" "), None, None)).await),
        "name",
    );
    assert_invalid(
        &err(budget::update_item(&w.deps, &w.owner_ctx, item, edit(None, Some(-1), None)).await),
        "cap",
    );
    for body in [
        json!({ "kind": "ad_budget" }),
        json!({ "unit": { "kind": "minutes" } }),
        json!({ "cap": 1, "retired_at": null }),
        json!({ "period": "yearly" }),
    ] {
        assert!(
            serde_json::from_value::<UpdateBudgetItem>(body.clone()).is_err(),
            "{body}"
        );
    }
    assert_eq!(
        serde_json::from_value::<UpdateBudgetItem>(json!({ "period": "daily" })).unwrap(),
        edit(None, None, Some(Period::Daily))
    );

    // Only budget.manage edits; an item not this workspace's is NOT_FOUND.
    let rep = w.member("rep").await;
    let capability_manager = w.agent(&["workspace.read", "capabilities.manage"]).await;
    for ctx in [&rep, &capability_manager] {
        assert_forbidden(
            &err(budget::update_item(&w.deps, ctx, item, edit(None, Some(1), None)).await),
            "budget.manage",
        );
    }
    let (_, beta) = w.other_workspace().await;
    for (ctx, id) in [(&w.owner_ctx, BudgetItemId::new_v7()), (&beta, item)] {
        let e = err(budget::update_item(&w.deps, ctx, id, edit(None, Some(1), None)).await);
        assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    }
    assert_eq!(w.entries("budget.items.update").len(), 2);
}

#[tokio::test]
async fn retired_budget_item_takes_no_links_or_spend() {
    let w = world().await;
    let item = create(&w, monthly("Saha kasası", 10_000)).await;
    let other = create(&w, monthly("Ofis kasası", 10_000)).await;
    let phone = w.declare("phone", "Saha telefonu").await.capability.id;
    let printer = w.declare("printer", "Yazıcı").await.capability.id;
    for capability in [phone, printer] {
        capabilities::link_budget(&w.deps, &w.owner_ctx, capability, item)
            .await
            .unwrap();
    }
    capabilities::link_budget(&w.deps, &w.owner_ctx, phone, other)
        .await
        .unwrap();
    budget::record_spend(&w.deps, &w.owner_ctx, item, 700, None)
        .await
        .unwrap();

    // Retired: its links go in the same transaction, its spend history stays.
    let later = at(&w.owner_ctx, days_later(1));
    let out = budget::retire_item(&w.deps, &later, item, true)
        .await
        .unwrap();
    assert_eq!(out.item.retired_at, Some(days_later(1)));
    assert_eq!(out.item.name, "Saha kasası");
    let entries = w.entries("budget.items.retire");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].payload, json!({ "links_removed": 2 }));
    assert_eq!(entries[0].subject.as_ref().unwrap().id, item.to_string());
    let phone_now = capabilities::get(&w.deps, &w.owner_ctx, phone)
        .await
        .unwrap();
    assert_eq!(phone_now.capability.budget_item_ids, [other]);
    let printer_now = capabilities::get(&w.deps, &w.owner_ctx, printer)
        .await
        .unwrap();
    assert!(printer_now.capability.budget_item_ids.is_empty());
    assert_eq!(
        budget::spend(&w.deps, &w.owner_ctx, item, 10, None)
            .await
            .unwrap()
            .len(),
        1
    );

    // The list still shows it, with its retirement.
    let listed = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    let shown = listed.iter().find(|o| o.item.id == item).unwrap();
    assert_eq!(shown.item.retired_at, Some(days_later(1)));
    assert_eq!(shown, &out);
    assert_eq!(
        serde_json::to_value(shown).unwrap()["item"]["retired_at"],
        json!("2026-10-23T09:00:00Z")
    );

    // It takes no spend and no link, from anyone; nothing is written.
    let agent = w.agent(&["workspace.read"]).await;
    for ctx in [&w.owner_ctx, &agent] {
        let e = err(budget::record_spend(&w.deps, ctx, item, 1, None).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
        assert_eq!(e.message, "budget item is retired");
    }
    let e = err(capabilities::link_budget(&w.deps, &w.owner_ctx, printer, item).await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.message, "budget item is retired");
    assert_eq!(w.uow.snapshot().budget_spend.len(), 1);
    assert_eq!(w.entries("budget.spend.record").len(), 1);
    assert_eq!(w.entries("capability.link_budget").len(), 3);

    // Retiring it again is CONFLICT; the other item still takes spend.
    let e = err(budget::retire_item(&w.deps, &w.owner_ctx, item, true).await);
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.message, "budget item is already retired");
    budget::record_spend(&w.deps, &w.owner_ctx, other, 1, None)
        .await
        .unwrap();
    assert_eq!(w.entries("budget.items.retire").len(), 1);
}

#[tokio::test]
async fn retire_requires_confirm() {
    let w = world().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    capabilities::link_budget(&w.deps, &w.owner_ctx, phone, item)
        .await
        .unwrap();

    // Without the confirmation: VALIDATION naming it, and nothing changes.
    assert_invalid(
        &err(budget::retire_item(&w.deps, &w.owner_ctx, item, false).await),
        "confirm",
    );
    let stored = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(stored[0].item.retired_at, None);
    let linked = capabilities::get(&w.deps, &w.owner_ctx, phone)
        .await
        .unwrap();
    assert_eq!(linked.capability.budget_item_ids, [item]);
    assert!(w.entries("budget.items.retire").is_empty());

    // Only budget.manage retires; an item not this workspace's is NOT_FOUND.
    let rep = w.member("rep").await;
    let capability_manager = w.agent(&["workspace.read", "capabilities.manage"]).await;
    for ctx in [&rep, &capability_manager] {
        assert_forbidden(
            &err(budget::retire_item(&w.deps, ctx, item, true).await),
            "budget.manage",
        );
    }
    let (_, beta) = w.other_workspace().await;
    for (ctx, id) in [(&w.owner_ctx, BudgetItemId::new_v7()), (&beta, item)] {
        let e = err(budget::retire_item(&w.deps, ctx, id, true).await);
        assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    }
    assert!(w.entries("budget.items.retire").is_empty());

    // Confirmed, a manager retires it.
    let manager = w.member("manager").await;
    let out = budget::retire_item(&w.deps, &manager, item, true)
        .await
        .unwrap();
    assert_eq!(out.item.retired_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn update_refuses_a_retired_budget_item() {
    let w = world().await;
    let item = create(&w, monthly("Kasa", 10_000)).await;
    budget::retire_item(&w.deps, &w.owner_ctx, item, true)
        .await
        .unwrap();
    for input in [
        edit(Some("Yeni"), None, None),
        edit(None, Some(1), None),
        edit(None, None, Some(Period::Total)),
    ] {
        let e = err(budget::update_item(&w.deps, &w.owner_ctx, item, input).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
        assert_eq!(e.message, "budget item is retired");
    }
    let listed = budget::list_items(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(
        (listed[0].item.name.as_str(), listed[0].item.cap),
        ("Kasa", 10_000)
    );
    assert!(w.entries("budget.items.update").is_empty());
}
