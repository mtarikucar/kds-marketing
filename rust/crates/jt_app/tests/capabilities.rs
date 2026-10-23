//! The capability and capability-group use cases over the in-memory fakes: declaring, listing,
//! verifying, marking unreachable, setting policies, linking budgets, retiring, grouping, the
//! tenant hosts a connector declares, and the channel catalog over the registry. One test per
//! rule.

mod support;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{ChannelCatalog, TenantHostRegistry, UnitOfWork};
use jt_app::usecases::budget::{self, BudgetItemInput};
use jt_app::usecases::capabilities::{
    self, CapabilityQuery, DeclareInput, UowChannelCatalog, parse_policy_strict,
};
use jt_app::usecases::groups;
use jt_app::usecases::strategy;
use jt_capability::{
    BudgetItemId, BudgetKind, CapabilityGroupId, CapabilityId, EffectiveStatus, Evidence, Hours,
    Period, Policy, Reach, StoredStatus, Unit,
};
use jt_ledger::Actor;
use jt_strategy::{ChannelChoice, Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{Permission, WorkspaceId};
use jt_testkit::fakes::{FIXED_NOW, HostCall, InMemoryUow, RecordingTenantHosts};
use serde_json::{Value, json};
use support::*;

fn evidence(text: &str, refs: &[&str]) -> Evidence {
    Evidence {
        text: text.into(),
        refs: refs.iter().map(|r| (*r).to_owned()).collect(),
    }
}

fn mailbox(name: &str, external_id: &str, hosts: &[&str]) -> DeclareInput {
    DeclareInput {
        external_id: Some(external_id.into()),
        connector_public: json!({ "hosts": hosts }),
        ..declaring("mailbox", name)
    }
}

fn item(name: &str, kind: BudgetKind) -> BudgetItemInput {
    BudgetItemInput {
        name: name.into(),
        kind,
        unit: Unit::Currency("TRY".into()),
        cap: 100_000,
        period: Period::Monthly,
    }
}

async fn create_item(w: &World, name: &str, kind: BudgetKind) -> BudgetItemId {
    budget::create_item(&w.deps, &w.owner_ctx, item(name, kind))
        .await
        .unwrap()
        .item
        .id
}

async fn retire(w: &World, id: CapabilityId) {
    capabilities::retire(&w.deps, &w.owner_ctx, id, true)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------------------------
// Declaring
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn declare_requires_capabilities_manage() {
    let w = world().await;
    let rep = w.member("rep").await;
    let reader = w.agent(&["workspace.read"]).await;
    for ctx in [&rep, &reader] {
        let e = err(capabilities::declare(&w.deps, ctx, declaring("phone", "Telefon")).await);
        assert_forbidden(&e, "capabilities.manage");
    }
    // A manager holds it, and so does an agent whose key carries it.
    let manager = w.member("manager").await;
    let agent = w.agent(&["capabilities.manage"]).await;
    for ctx in [&manager, &agent] {
        capabilities::declare(&w.deps, ctx, declaring("phone", "Telefon"))
            .await
            .unwrap();
    }
    assert_eq!(w.uow.snapshot().capabilities.len(), 2);
}

#[tokio::test]
async fn declare_gives_each_kind_its_reach_and_records_the_declaration() {
    let w = world().await;
    let agent = w.declare("claude_code", "Ofis Claude").await;
    let phone = w.declare("phone", "Satış telefonu").await;
    let inbox = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            external_id: Some("info@acme.example".into()),
            ..declaring("mailbox", "  Destek kutusu  ")
        },
    )
    .await
    .unwrap();

    for (out, reach) in [
        (&agent, Reach::Agent),
        (&phone, Reach::Device),
        (&inbox, Reach::Connector),
    ] {
        let c = &out.capability;
        assert_eq!(c.reach, reach, "{}", c.kind_key);
        assert_eq!(c.status, StoredStatus::Declared);
        assert_eq!(out.effective_status, EffectiveStatus::Declared);
        assert_eq!(c.workspace_id, w.ws);
        assert!(!c.has_sealed_config);
        assert_eq!(c.last_verified_at, None);
        assert_eq!(c.strategy_version_id, None);
        assert_eq!((c.created_at, c.updated_at), (FIXED_NOW, FIXED_NOW));
        assert_eq!(c.policy, Policy::default());
    }
    assert_eq!(inbox.capability.name, "Destek kutusu");

    let entries = w.entries("capability.declare");
    assert_eq!(entries.len(), 3);
    assert_eq!(
        entries[0].payload,
        json!({ "kind_key": "claude_code", "name": "Ofis Claude" })
    );
    assert_eq!(
        entries[2].payload,
        json!({
            "kind_key": "mailbox",
            "name": "Destek kutusu",
            "external_id": "info@acme.example",
        })
    );
    for (entry, out) in entries.iter().zip([&agent, &phone, &inbox]) {
        let subject = entry.subject.as_ref().unwrap();
        assert_eq!(subject.kind, "capability");
        assert_eq!(subject.id, out.capability.id.to_string());
        assert_eq!(entry.strategy_version_id, None);
        assert_eq!(entry.at, FIXED_NOW);
        assert_eq!(entry.actor, Actor::Human { user_id: w.owner });
    }

    // Under an approved strategy, the capability and the entry carry the version in force.
    let version = w.approve_strategy().await;
    let later = w.declare("printer", "Ofis yazıcısı").await;
    assert_eq!(
        later.capability.strategy_version_id,
        Some(version.as_uuid())
    );
    let entry = w.entries("capability.declare").pop().unwrap();
    assert_eq!(entry.strategy_version_id, Some(version.as_uuid()));
}

#[tokio::test]
async fn declare_refuses_unknown_kinds_and_bad_fields() {
    let w = world().await;
    let cases = [
        (declaring("fax", "Faks"), "kind_key"),
        (declaring("other", "Bir araç"), "key_detail"),
        (
            DeclareInput {
                key_detail: Some("Bad Detail".into()),
                ..declaring("other", "Bir araç")
            },
            "key_detail",
        ),
        (
            DeclareInput {
                key_detail: Some("airtable".into()),
                ..declaring("phone", "Telefon")
            },
            "key_detail",
        ),
        (declaring("phone", "   "), "name"),
        (declaring("phone", &"x".repeat(65)), "name"),
        (
            DeclareInput {
                description: "x".repeat(2_001),
                ..declaring("phone", "Telefon")
            },
            "description",
        ),
        (
            DeclareInput {
                external_id: Some("  ".into()),
                ..declaring("phone", "Telefon")
            },
            "external_id",
        ),
    ];
    for (input, field) in cases {
        let e = err(capabilities::declare(&w.deps, &w.owner_ctx, input).await);
        assert_invalid(&e, field);
    }
    // The third-party kind `other` takes a key_detail naming the tool.
    let other = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            key_detail: Some("airtable".into()),
            ..declaring("other", "Airtable")
        },
    )
    .await
    .unwrap();
    assert_eq!(other.capability.key_detail.as_deref(), Some("airtable"));
    assert_eq!(other.capability.reach, Reach::Agent);
    assert_eq!(w.uow.snapshot().capabilities.len(), 1);
}

#[tokio::test]
async fn declare_rejects_secret_looking_public_fields() {
    let w = world().await;
    let input = DeclareInput {
        connector_public: json!({
            "page": "Acme",
            "access_token": "EAAB...",
            "nested": [{ "Password": "hunter2" }],
        }),
        ..declaring("instagram", "Acme IG")
    };
    let e = err(capabilities::declare(&w.deps, &w.owner_ctx, input).await);
    assert_eq!(
        gap_fields(&e),
        [
            "connector_public.access_token",
            "connector_public.nested[0].Password"
        ]
    );
    assert!(!wire(&e).contains("hunter2") && !wire(&e).contains("EAAB"));

    let e = err(capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            connector_public: json!("page=Acme"),
            ..declaring("instagram", "Acme IG")
        },
    )
    .await);
    assert_eq!(gap_fields(&e), ["connector_public"]);
    assert!(w.uow.snapshot().capabilities.is_empty());
    assert!(w.entries("capability.declare").is_empty());
}

#[tokio::test]
async fn declare_validates_the_policy_and_reads_it_strictly() {
    let w = world().await;
    let overnight = Policy {
        active_hours: Some(Hours {
            tz: "Europe/Istanbul".into(),
            from: 22,
            to: 2,
            days: vec![5, 6],
        }),
        spend_cap_minor: Some(-1),
        ..Policy::default()
    };
    let e = err(capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        DeclareInput {
            policy: Some(overnight),
            ..declaring("phone", "Telefon")
        },
    )
    .await);
    assert_eq!(
        gap_fields(&e),
        ["policy.active_hours.to", "policy.spend_cap_minor"]
    );

    // From JSON, a misspelt field is refused rather than dropped: it could be the approval flag.
    let e = parse_policy_strict(&json!({ "requires_human_aproval": true })).unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let e = parse_policy_strict(&json!({
        "active_hours": { "tz": "UTC", "from": 9, "to": 18, "days": [1], "weekends": true },
    }))
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    let policy = parse_policy_strict(&json!({ "requires_human_approval": true })).unwrap();
    assert_eq!(
        policy,
        Policy {
            requires_human_approval: true,
            ..Policy::default()
        }
    );
    let input: Result<DeclareInput, _> = serde_json::from_value(json!({
        "kind_key": "phone",
        "name": "Telefon",
        "policy": { "requires_human_aproval": true },
    }));
    assert!(input.is_err());
    let input: Result<DeclareInput, _> = serde_json::from_value(json!({
        "kind_key": "phone",
        "name": "Telefon",
        "colour": "red",
    }));
    assert!(input.is_err());
    let input: DeclareInput = serde_json::from_value(json!({
        "kind_key": "phone",
        "name": "Telefon",
        "policy": {
            "daily_ops_cap": 20,
            "active_hours": { "tz": "UTC", "from": 9, "to": 18, "days": [1, 2] },
        },
    }))
    .unwrap();
    let out = capabilities::declare(&w.deps, &w.owner_ctx, input)
        .await
        .unwrap();
    assert_eq!(out.capability.policy.daily_ops_cap, Some(20));
    assert_eq!(out.capability.policy.verify_max_age_days, 30);
}

#[tokio::test]
async fn the_same_external_account_is_held_once_until_retired() {
    let w = world().await;
    let first = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox("Destek", "info@acme.example", &[]),
    )
    .await
    .unwrap();
    let e = err(capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox("Destek 2", "info@acme.example", &[]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    retire(&w, first.capability.id).await;
    capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox("Destek 2", "info@acme.example", &[]),
    )
    .await
    .unwrap();
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn list_and_get_compute_the_effective_status() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    capabilities::verify(
        &w.deps,
        &w.owner_ctx,
        phone,
        evidence("adb devices listed it", &[]),
    )
    .await
    .unwrap();

    let rep = w.member("rep").await;
    let now = capabilities::get(&w.deps, &rep, phone).await.unwrap();
    assert_eq!(now.effective_status, EffectiveStatus::Verified);
    // 30 days later still fresh, 31 days later stale; the stored status stays `verified`.
    let fresh = capabilities::get(&w.deps, &at(&rep, days_later(30)), phone)
        .await
        .unwrap();
    assert_eq!(fresh.effective_status, EffectiveStatus::Verified);
    let stale = capabilities::list(
        &w.deps,
        &at(&rep, days_later(31)),
        CapabilityQuery::default(),
    )
    .await
    .unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].effective_status, EffectiveStatus::Stale);
    assert_eq!(stale[0].capability.status, StoredStatus::Verified);

    let e = err(capabilities::get(&w.deps, &rep, CapabilityId::new_v7()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let auditor = w.agent(&["ledger.read"]).await;
    assert_forbidden(
        &err(capabilities::get(&w.deps, &auditor, phone).await),
        "workspace.read",
    );
    assert_forbidden(
        &err(capabilities::list(&w.deps, &auditor, CapabilityQuery::default()).await),
        "workspace.read",
    );
}

#[tokio::test]
async fn list_filters_by_group_kind_status_and_capability_group() {
    let w = world().await;
    let ig = w.declare("instagram", "Acme IG").await.capability.id;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let inbox = w.declare("mailbox", "Destek").await.capability.id;
    capabilities::verify(&w.deps, &w.owner_ctx, phone, evidence("ok", &[]))
        .await
        .unwrap();
    let group = groups::create(&w.deps, &w.owner_ctx, "Marka A".into(), None)
        .await
        .unwrap()
        .group
        .id;
    groups::add_member(&w.deps, &w.owner_ctx, group, ig)
        .await
        .unwrap();

    let ids = |query: CapabilityQuery| {
        let deps = w.deps.clone();
        let ctx = w.owner_ctx.clone();
        async move {
            capabilities::list(&deps, &ctx, query)
                .await
                .unwrap()
                .into_iter()
                .map(|c| c.capability.id)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(ids(CapabilityQuery::default()).await, [ig, phone, inbox]);
    let by = |group: Option<&str>, kind: Option<&str>, status: Option<&str>| CapabilityQuery {
        group: group.map(str::to_owned),
        kind: kind.map(str::to_owned),
        status: status.map(str::to_owned),
        group_id: None,
    };
    assert_eq!(ids(by(None, Some("phone"), None)).await, [phone]);
    assert_eq!(ids(by(Some("messaging"), None, None)).await, [inbox]);
    assert_eq!(ids(by(None, None, Some("verified"))).await, [phone]);
    assert_eq!(
        ids(by(Some("social_account"), None, Some("declared"))).await,
        [ig]
    );
    assert_eq!(
        ids(CapabilityQuery {
            group_id: Some(group),
            ..CapabilityQuery::default()
        })
        .await,
        [ig]
    );
    assert!(
        ids(CapabilityQuery {
            group_id: Some(CapabilityGroupId::new_v7()),
            ..CapabilityQuery::default()
        })
        .await
        .is_empty()
    );

    for (query, field) in [
        (by(None, Some("fax"), None), "kind"),
        (by(Some("pets"), None, None), "group"),
        (by(None, None, Some("stale")), "status"),
    ] {
        let e = err(capabilities::list(&w.deps, &w.owner_ctx, query).await);
        assert_invalid(&e, field);
    }
}

// ---------------------------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn agent_can_verify_only_what_its_connection_declared() {
    let w = world().await;
    // The agent declares its own phone and shell through its connection ...
    let declarer = w.agent(&["workspace.read", "capabilities.manage"]).await;
    let declare = |kind, name| capabilities::declare(&w.deps, &declarer, declaring(kind, name));
    let phone = declare("phone", "Satış telefonu").await.unwrap().capability;
    let shell = declare("shell", "Kabuk").await.unwrap().capability;
    assert_eq!(phone.declared_by_connection, declarer.agent_connection_id);
    assert!(declarer.agent_connection_id.is_some());
    // ... and a person's declaration names no connection.
    let printer = w.declare("printer", "Yazıcı").await.capability;
    assert_eq!(printer.declared_by_connection, None);

    // Through the same connection, reading the workspace is enough to verify them.
    let agent = Ctx {
        permissions: BTreeSet::from([Permission::WorkspaceRead]),
        ..declarer.clone()
    };
    for id in [phone.id, shell.id] {
        let out = capabilities::verify(
            &w.deps,
            &agent,
            id,
            evidence("serial R58M123 answered adb", &["R58M123", "shot-17"]),
        )
        .await
        .unwrap();
        let c = &out.capability;
        assert_eq!(c.status, StoredStatus::Verified);
        assert_eq!(out.effective_status, EffectiveStatus::Verified);
        assert_eq!(c.last_verified_at, Some(FIXED_NOW));
        assert_eq!(c.declared_by_connection, agent.agent_connection_id);
        assert_eq!(
            c.evidence,
            Some(evidence(
                "serial R58M123 answered adb",
                &["R58M123", "shot-17"]
            ))
        );
    }
    let entries = w.entries("capability.verify");
    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert_eq!(entry.payload, json!({ "evidence_refs": 2 }));
        assert_eq!(entry.actor, agent.actor);
        assert_eq!(entry.subject.as_ref().unwrap().kind, "capability");
        assert!(!wire(entry).contains("answered adb"));
    }

    // What a person declared is not the agent's own: reading is not enough.
    assert_forbidden(
        &err(capabilities::verify(&w.deps, &agent, printer.id, evidence("x", &[])).await),
        "capabilities.manage",
    );

    // Without workspace.read, an agent may not even claim its own.
    let auditor = Ctx {
        permissions: BTreeSet::from([Permission::LedgerRead]),
        ..declarer.clone()
    };
    assert_forbidden(
        &err(capabilities::verify(&w.deps, &auditor, phone.id, evidence("x", &[])).await),
        "workspace.read",
    );
    assert_eq!(w.entries("capability.verify").len(), 2);
}

#[tokio::test]
async fn another_agent_connection_needs_capabilities_manage() {
    let w = world().await;
    let declarer = w.agent(&["workspace.read", "capabilities.manage"]).await;
    let phone = capabilities::declare(&w.deps, &declarer, declaring("phone", "Telefon"))
        .await
        .unwrap()
        .capability
        .id;

    // Another connection reading the workspace only: refused, nothing written.
    let other = w.agent(&["workspace.read"]).await;
    assert_ne!(other.agent_connection_id, declarer.agent_connection_id);
    assert_forbidden(
        &err(capabilities::verify(&w.deps, &other, phone, evidence("bende", &[])).await),
        "capabilities.manage",
    );
    assert!(w.entries("capability.verify").is_empty());
    let c = capabilities::get(&w.deps, &w.owner_ctx, phone)
        .await
        .unwrap();
    assert_eq!(c.capability.status, StoredStatus::Declared);

    // Another connection holding capabilities.manage may, as a person holding it may.
    let manager = w.agent(&["workspace.read", "capabilities.manage"]).await;
    let out = capabilities::verify(&w.deps, &manager, phone, evidence("bende", &[]))
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Verified);
    assert_eq!(
        out.capability.declared_by_connection,
        declarer.agent_connection_id
    );
    assert_eq!(w.entries("capability.verify")[0].actor, manager.actor);
}

#[tokio::test]
async fn a_person_verifies_only_with_capabilities_manage() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(capabilities::verify(&w.deps, &rep, phone, evidence("bende", &[])).await),
        "capabilities.manage",
    );
    let manager = w.member("manager").await;
    let out = capabilities::verify(&w.deps, &manager, phone, evidence("bende", &[]))
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Verified);
    assert_eq!(
        w.entries("capability.verify")[0].payload,
        json!({ "evidence_refs": 0 })
    );
}

#[tokio::test]
async fn connector_kind_cannot_be_verified_by_claim() {
    let w = world().await;
    let inbox = w.declare("mailbox", "Destek").await.capability.id;
    let reader = w.agent(&["workspace.read"]).await;
    let manager_agent = w.agent(&["workspace.read", "capabilities.manage"]).await;
    for ctx in [&w.owner_ctx, &reader, &manager_agent] {
        let e = err(capabilities::verify(&w.deps, ctx, inbox, evidence("works", &[])).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
        assert_eq!(
            e.message,
            "connector capabilities are verified by their probe"
        );
    }
    let c = capabilities::get(&w.deps, &w.owner_ctx, inbox)
        .await
        .unwrap();
    assert_eq!(c.capability.status, StoredStatus::Declared);
    assert!(w.entries("capability.verify").is_empty());
}

#[tokio::test]
async fn verify_checks_the_evidence_and_refuses_a_retired_capability() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let e = err(capabilities::verify(&w.deps, &w.owner_ctx, phone, evidence("  ", &["  "])).await);
    assert_eq!(gap_fields(&e), ["evidence.text", "evidence.refs[0]"]);
    retire(&w, phone).await;
    let e = err(capabilities::verify(&w.deps, &w.owner_ctx, phone, evidence("ok", &[])).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.message, "capability is retired");
    let e = err(capabilities::verify(
        &w.deps,
        &w.owner_ctx,
        CapabilityId::new_v7(),
        evidence("ok", &[]),
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
}

// ---------------------------------------------------------------------------------------------
// Unreachable, policies
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn mark_unreachable_records_why() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(capabilities::mark_unreachable(&w.deps, &rep, phone, "kayıp".into()).await),
        "capabilities.manage",
    );
    let e = err(capabilities::mark_unreachable(&w.deps, &w.owner_ctx, phone, "  ".into()).await);
    assert_invalid(&e, "reason");
    let e =
        err(capabilities::mark_unreachable(&w.deps, &w.owner_ctx, phone, "x".repeat(501)).await);
    assert_invalid(&e, "reason");

    let out = capabilities::mark_unreachable(&w.deps, &w.owner_ctx, phone, "  şarj bitti  ".into())
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Unreachable);
    assert_eq!(out.effective_status, EffectiveStatus::Unreachable);
    assert_eq!(
        w.entries("capability.mark_unreachable")[0].payload,
        json!({ "reason": "şarj bitti" })
    );

    retire(&w, phone).await;
    let e = err(capabilities::mark_unreachable(&w.deps, &w.owner_ctx, phone, "x".into()).await);
    assert_eq!(e.code, ErrorCode::Conflict);
}

#[tokio::test]
async fn set_policy_validates_and_replaces_the_policy() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(capabilities::set_policy(&w.deps, &rep, phone, Policy::default()).await),
        "capabilities.manage",
    );
    let bad = Policy {
        active_hours: Some(Hours {
            tz: "Mars/Olympus Mons 1".into(),
            from: 9,
            to: 18,
            days: vec![],
        }),
        ..Policy::default()
    };
    let e = err(capabilities::set_policy(&w.deps, &w.owner_ctx, phone, bad).await);
    assert_eq!(
        gap_fields(&e),
        ["policy.active_hours.tz", "policy.active_hours.days"]
    );

    let version = w.approve_strategy().await;
    let policy = Policy {
        active_hours: Some(Hours {
            tz: "Europe/Istanbul".into(),
            from: 18,
            to: 24,
            days: vec![1, 2, 3, 4, 5],
        }),
        daily_ops_cap: Some(40),
        spend_cap_minor: Some(5_000),
        requires_human_approval: true,
        verify_max_age_days: 7,
    };
    let out = capabilities::set_policy(&w.deps, &w.owner_ctx, phone, policy.clone())
        .await
        .unwrap();
    assert_eq!(out.capability.policy, policy);
    assert_eq!(out.capability.strategy_version_id, Some(version.as_uuid()));
    let entry = w.entries("capability.set_policy").pop().unwrap();
    assert_eq!(entry.payload["policy"]["daily_ops_cap"], 40);
    assert_eq!(entry.strategy_version_id, Some(version.as_uuid()));

    retire(&w, phone).await;
    let e = err(capabilities::set_policy(&w.deps, &w.owner_ctx, phone, Policy::default()).await);
    assert_eq!(e.code, ErrorCode::Conflict);
}

// ---------------------------------------------------------------------------------------------
// Budget links
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn link_budget_follows_the_kind_rules() {
    let w = world().await;
    let ads = w.declare("meta_ads", "Meta reklam").await.capability.id;
    let claude = w.declare("claude_code", "Ofis Claude").await.capability.id;
    let ad_budget = create_item(&w, "Reklam bütçesi", BudgetKind::AdBudget).await;
    let cash = create_item(&w, "Kasa", BudgetKind::Cash).await;

    let rep = w.member("rep").await;
    assert_forbidden(
        &err(capabilities::link_budget(&w.deps, &rep, ads, ad_budget).await),
        "capabilities.manage",
    );
    let out = capabilities::link_budget(&w.deps, &w.owner_ctx, ads, ad_budget)
        .await
        .unwrap();
    assert_eq!(out.capability.budget_item_ids, [ad_budget]);
    // Linking again changes nothing.
    capabilities::link_budget(&w.deps, &w.owner_ctx, ads, ad_budget)
        .await
        .unwrap();
    let out = capabilities::link_budget(&w.deps, &w.owner_ctx, ads, cash)
        .await
        .unwrap();
    assert_eq!(out.capability.budget_item_ids.len(), 2);

    // An agent connection never spends cash.
    let e = err(capabilities::link_budget(&w.deps, &w.owner_ctx, claude, cash).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details, json!({ "reason": "kind_mismatch" }));

    let out = capabilities::unlink_budget(&w.deps, &w.owner_ctx, ads, cash)
        .await
        .unwrap();
    assert_eq!(out.capability.budget_item_ids, [ad_budget]);
    let e = err(capabilities::unlink_budget(&w.deps, &w.owner_ctx, ads, cash).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    for e in [
        err(capabilities::link_budget(&w.deps, &w.owner_ctx, ads, BudgetItemId::new_v7()).await),
        err(capabilities::link_budget(&w.deps, &w.owner_ctx, CapabilityId::new_v7(), cash).await),
    ] {
        assert_eq!(e.code, ErrorCode::NotFound);
    }

    let links = w.entries("capability.link_budget");
    assert_eq!(links.len(), 3);
    assert_eq!(
        links[0].payload,
        json!({ "budget_item_id": ad_budget.to_string() })
    );
    assert_eq!(links[0].subject.as_ref().unwrap().id, ads.to_string());
    assert_eq!(w.entries("capability.unlink_budget").len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Retiring
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn retire_requires_confirmation_and_capabilities_manage() {
    let w = world().await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(capabilities::retire(&w.deps, &rep, phone, true).await),
        "capabilities.manage",
    );
    let e = err(capabilities::retire(&w.deps, &w.owner_ctx, phone, false).await);
    assert_invalid(&e, "confirm");
    let out = capabilities::retire(&w.deps, &w.owner_ctx, phone, true)
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Retired);
    assert_eq!(out.effective_status, EffectiveStatus::Retired);
    let e = err(capabilities::retire(&w.deps, &w.owner_ctx, phone, true).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(w.entries("capability.retire").len(), 1);
}

#[tokio::test]
async fn retire_revokes_tenant_hosts_and_detaches() {
    let w = world().await;
    let a = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox(
            "Destek",
            "info@acme.example",
            &["imap.acme.example", "smtp.acme.example:465"],
        ),
    )
    .await
    .unwrap()
    .capability
    .id;
    // Another live mailbox on the same IMAP server keeps that host reachable.
    capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox("Satış", "sales@acme.example", &["imap.acme.example"]),
    )
    .await
    .unwrap();
    let group = groups::create(&w.deps, &w.owner_ctx, "Destek".into(), None)
        .await
        .unwrap()
        .group
        .id;
    groups::add_member(&w.deps, &w.owner_ctx, group, a)
        .await
        .unwrap();
    let cash = create_item(&w, "Kasa", BudgetKind::Cash).await;
    capabilities::link_budget(&w.deps, &w.owner_ctx, a, cash)
        .await
        .unwrap();
    let allowed = w.hosts.calls().len();

    let out = capabilities::retire(&w.deps, &w.owner_ctx, a, true)
        .await
        .unwrap();
    assert_eq!(out.capability.status, StoredStatus::Retired);
    assert!(out.capability.budget_item_ids.is_empty());
    let snapshot = w.uow.snapshot();
    assert!(snapshot.capability_group_members.is_empty());
    assert!(snapshot.capability_budget_links.is_empty());
    assert_eq!(snapshot.capability_groups.len(), 1, "the group stays");
    assert_eq!(snapshot.budget_items.len(), 1, "the budget item stays");
    assert_eq!(
        w.hosts.calls()[allowed..],
        [HostCall::Revoke(w.ws, "smtp.acme.example:465".into())]
    );
    assert_eq!(
        w.entries("capability.retire")[0].payload,
        json!({ "budget_links": 1, "groups": 1, "hosts_revoked": 1 })
    );
}

#[tokio::test]
async fn retired_capability_cannot_be_grouped_or_linked() {
    let w = world().await;
    let ads = w.declare("meta_ads", "Meta reklam").await.capability.id;
    let cash = create_item(&w, "Kasa", BudgetKind::Cash).await;
    let group = groups::create(&w.deps, &w.owner_ctx, "Reklam".into(), None)
        .await
        .unwrap()
        .group
        .id;
    retire(&w, ads).await;
    for e in [
        err(groups::add_member(&w.deps, &w.owner_ctx, group, ads).await),
        err(capabilities::link_budget(&w.deps, &w.owner_ctx, ads, cash).await),
    ] {
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(e.message, "capability is retired");
    }
    let snapshot = w.uow.snapshot();
    assert!(snapshot.capability_group_members.is_empty());
    assert!(snapshot.capability_budget_links.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Tenant hosts
// ---------------------------------------------------------------------------------------------

/// What a host registry saw: each call, and whether a live capability declaring the host was
/// committed at that moment.
#[derive(Clone)]
struct CommitWatch {
    uow: InMemoryUow,
    inner: RecordingTenantHosts,
    seen: Arc<Mutex<Vec<(HostCall, bool)>>>,
}

impl CommitWatch {
    fn committed(&self, host: &str) -> bool {
        self.uow.snapshot().capabilities.iter().any(|s| {
            s.capability.status != StoredStatus::Retired
                && s.capability.connector_public["hosts"]
                    .as_array()
                    .is_some_and(|hosts| hosts.iter().any(|h| h == host))
        })
    }
}

impl TenantHostRegistry for CommitWatch {
    fn check(&self, host: &str) -> Result<(), AppError> {
        self.inner.check(host)
    }

    fn allow(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError> {
        let call = HostCall::Allow(ws, host.to_owned());
        self.seen.lock().unwrap().push((call, self.committed(host)));
        self.inner.allow(ws, host)
    }

    fn revoke(&self, ws: WorkspaceId, host: &str) -> Result<(), AppError> {
        let call = HostCall::Revoke(ws, host.to_owned());
        self.seen.lock().unwrap().push((call, self.committed(host)));
        self.inner.revoke(ws, host)
    }

    fn rebuild_from(&self, ws: WorkspaceId, hosts: Vec<String>) -> Result<usize, AppError> {
        self.inner.rebuild_from(ws, hosts)
    }
}

#[tokio::test]
async fn declare_allows_hosts_after_commit_and_retire_revokes_them() {
    let w = world().await;
    let watch = CommitWatch {
        uow: w.uow.clone(),
        inner: RecordingTenantHosts::new(),
        seen: Arc::default(),
    };
    let mut deps = w.deps.clone();
    deps.hosts = Arc::new(watch.clone());

    let inbox = capabilities::declare(
        &deps,
        &w.owner_ctx,
        mailbox(
            "Destek",
            "info@acme.example",
            &["imap.acme.example", "smtp.acme.example"],
        ),
    )
    .await
    .unwrap()
    .capability
    .id;
    // Hosts in the public fields of a capability the system does not reach are not its to allow.
    capabilities::declare(
        &deps,
        &w.owner_ctx,
        DeclareInput {
            connector_public: json!({ "hosts": ["api.notion.example"] }),
            ..declaring("notion", "Notion")
        },
    )
    .await
    .unwrap();
    assert_eq!(
        *watch.seen.lock().unwrap(),
        [
            (HostCall::Allow(w.ws, "imap.acme.example".into()), true),
            (HostCall::Allow(w.ws, "smtp.acme.example".into()), true),
        ],
        "each host is allowed once the capability is committed"
    );

    capabilities::retire(&deps, &w.owner_ctx, inbox, true)
        .await
        .unwrap();
    assert_eq!(
        watch.seen.lock().unwrap()[2..],
        [
            (HostCall::Revoke(w.ws, "imap.acme.example".into()), false),
            (HostCall::Revoke(w.ws, "smtp.acme.example".into()), false),
        ],
        "each host is revoked once the retirement is committed"
    );
}

/// A registry that accepts every host when checking but fails every change, as a tier that could
/// not be reached would.
struct FailingHosts;

impl TenantHostRegistry for FailingHosts {
    fn check(&self, _host: &str) -> Result<(), AppError> {
        Ok(())
    }

    fn allow(&self, _ws: WorkspaceId, _host: &str) -> Result<(), AppError> {
        Err(AppError::internal("the tenant tier is unreachable"))
    }

    fn revoke(&self, _ws: WorkspaceId, _host: &str) -> Result<(), AppError> {
        Err(AppError::internal("the tenant tier is unreachable"))
    }

    fn rebuild_from(&self, _ws: WorkspaceId, _hosts: Vec<String>) -> Result<usize, AppError> {
        Err(AppError::internal("the tenant tier is unreachable"))
    }
}

#[tokio::test]
async fn a_host_change_failing_after_commit_does_not_fail_the_committed_change() {
    let w = world().await;
    let mut deps = w.deps.clone();
    deps.hosts = Arc::new(FailingHosts);
    let inbox = capabilities::declare(
        &deps,
        &w.owner_ctx,
        mailbox("Destek", "info@acme.example", &["imap.acme.example"]),
    )
    .await
    .expect("the declaration is committed and answered");
    let retired = capabilities::retire(&deps, &w.owner_ctx, inbox.capability.id, true)
        .await
        .expect("the retirement is committed and answered");
    assert_eq!(retired.capability.status, StoredStatus::Retired);
    assert_eq!(w.entries("capability.declare").len(), 1);
    assert_eq!(w.entries("capability.retire").len(), 1);
}

#[tokio::test]
async fn declare_refuses_a_non_public_host_and_writes_nothing() {
    let w = world()
        .await
        .with_hosts(RecordingTenantHosts::refusing(&["10.0.0.1"]));
    let e = err(capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox(
            "Destek",
            "info@acme.example",
            &["imap.acme.example", "10.0.0.1"],
        ),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.message, "host is not public");
    assert_eq!(e.details["host"], "10.0.0.1");

    for (hosts, field) in [
        (json!("imap.acme.example"), "connector_public.hosts"),
        (
            json!(["imap.acme.example", 993]),
            "connector_public.hosts[1]",
        ),
        (json!(["  "]), "connector_public.hosts[0]"),
        (
            Value::Array(
                (0..21)
                    .map(|i| json!(format!("h{i}.acme.example")))
                    .collect(),
            ),
            "connector_public.hosts",
        ),
    ] {
        let e = err(capabilities::declare(
            &w.deps,
            &w.owner_ctx,
            DeclareInput {
                connector_public: json!({ "hosts": hosts }),
                ..declaring("mailbox", "Destek")
            },
        )
        .await);
        assert_eq!(gap_fields(&e), [field]);
    }
    assert!(w.uow.snapshot().capabilities.is_empty());
    assert!(w.hosts.calls().is_empty());
    assert!(w.entries("capability.declare").is_empty());
}

// ---------------------------------------------------------------------------------------------
// Across workspaces, secrets, the channel catalog
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn cross_workspace_group_member_and_budget_link_are_not_found() {
    let w = world().await;
    let mine = w.declare("meta_ads", "Meta reklam").await.capability.id;
    let my_group = groups::create(&w.deps, &w.owner_ctx, "Marka A".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let my_item = create_item(&w, "Kasa", BudgetKind::Cash).await;

    let (beta, beta_ctx) = w.other_workspace().await;
    let theirs = capabilities::declare(&w.deps, &beta_ctx, declaring("meta_ads", "Beta reklam"))
        .await
        .unwrap()
        .capability
        .id;
    let their_group = groups::create(&w.deps, &beta_ctx, "Marka B".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let their_item = budget::create_item(&w.deps, &beta_ctx, item("Kasa", BudgetKind::Cash))
        .await
        .unwrap()
        .item
        .id;
    let before = w.uow.snapshot();

    let o = &w.owner_ctx;
    let d = &w.deps;
    let refusals = [
        err(groups::add_member(d, o, my_group, theirs).await),
        err(groups::add_member(d, o, their_group, mine).await),
        err(groups::remove_member(d, o, their_group, mine).await),
        err(groups::rename(d, o, their_group, "Bizim".into()).await),
        err(groups::delete(d, o, their_group).await),
        err(capabilities::link_budget(d, o, mine, their_item).await),
        err(capabilities::link_budget(d, o, theirs, my_item).await),
        err(capabilities::unlink_budget(d, o, theirs, my_item).await),
        err(capabilities::get(d, o, theirs).await),
        err(capabilities::retire(d, o, theirs, true).await),
        err(capabilities::verify(d, o, theirs, evidence("ok", &[])).await),
        err(budget::record_spend(d, o, their_item, 100, None).await),
        err(budget::spend(d, o, their_item, 10, None).await),
    ];
    for e in refusals {
        assert_eq!(e.code, ErrorCode::NotFound, "{e:?}");
    }
    let after = w.uow.snapshot();
    assert_eq!(after.capabilities, before.capabilities);
    assert_eq!(after.capability_groups, before.capability_groups);
    assert_eq!(
        after.capability_group_members,
        before.capability_group_members
    );
    assert_eq!(
        after.capability_budget_links,
        before.capability_budget_links
    );
    assert_eq!(after.budget_spend, before.budget_spend);
    // Neither workspace lists the other's.
    let listed = capabilities::list(d, o, CapabilityQuery::default())
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        groups::list(d, &beta_ctx).await.unwrap()[0]
            .group
            .workspace_id,
        beta
    );
}

#[tokio::test]
async fn outputs_and_ledger_never_contain_sealed_bytes() {
    let w = world().await;
    let secret = b"s3cr3t-imap-password";
    let inbox = capabilities::declare(
        &w.deps,
        &w.owner_ctx,
        mailbox("Destek", "info@acme.example", &["imap.acme.example"]),
    )
    .await
    .unwrap()
    .capability
    .id;
    let sealed = w.deps.seal.seal(w.ws, secret).unwrap();
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.capabilities()
            .set_sealed(inbox, Some(sealed.clone()), FIXED_NOW)
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let cash = create_item(&w, "Kasa", BudgetKind::Cash).await;
    let group = groups::create(&w.deps, &w.owner_ctx, "Destek".into(), None)
        .await
        .unwrap()
        .group
        .id;

    let (d, o) = (&w.deps, &w.owner_ctx);
    let got = capabilities::get(d, o, inbox).await.unwrap();
    assert!(got.capability.has_sealed_config);
    let outputs = [
        wire(&got),
        wire(
            &capabilities::list(d, o, CapabilityQuery::default())
                .await
                .unwrap(),
        ),
        wire(&groups::add_member(d, o, group, inbox).await.unwrap()),
        wire(&groups::list(d, o).await.unwrap()),
        wire(
            &capabilities::set_policy(d, o, inbox, Policy::default())
                .await
                .unwrap(),
        ),
        wire(&capabilities::link_budget(d, o, inbox, cash).await.unwrap()),
        wire(
            &capabilities::unlink_budget(d, o, inbox, cash)
                .await
                .unwrap(),
        ),
        wire(
            &capabilities::mark_unreachable(d, o, inbox, "probe failed".into())
                .await
                .unwrap(),
        ),
        wire(&capabilities::retire(d, o, inbox, true).await.unwrap()),
    ];
    let ledger = w.ledger("");
    assert!(ledger.len() > outputs.len());
    let mut texts = outputs.to_vec();
    texts.extend(ledger.iter().map(wire));
    let secret_text = std::str::from_utf8(secret).unwrap();
    let sealed_text = String::from_utf8_lossy(&sealed).into_owned();
    for text in &texts {
        assert!(!text.contains(secret_text), "{text}");
        assert!(!text.contains(&sealed_text), "{text}");
        assert!(!text.contains("plain:"), "{text}");
    }
    // Nor do the entries carry the public connector fields.
    for entry in w.ledger("capability.") {
        assert!(!wire(&entry).contains("imap.acme.example"), "{entry:?}");
    }
}

#[tokio::test]
async fn uow_channel_catalog_lists_non_retired_kinds() {
    let w = world().await;
    let catalog = UowChannelCatalog {
        uow: Arc::new(w.uow.clone()),
    };
    assert!(catalog.kinds_in_use(w.ws).await.unwrap().is_empty());
    w.declare("instagram", "Acme IG").await;
    w.declare("instagram", "Acme IG 2").await;
    w.declare("mailbox", "Destek").await;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    retire(&w, phone).await;
    let expected: BTreeSet<String> = ["instagram", "mailbox"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    assert_eq!(catalog.kinds_in_use(w.ws).await.unwrap(), expected);
    let (beta, _) = w.other_workspace().await;
    assert!(catalog.kinds_in_use(beta).await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn groups_are_named_uniquely_and_deleting_detaches_members() {
    let w = world().await;
    let (d, o) = (&w.deps, &w.owner_ctx);
    let a = groups::create(d, o, "  Marka A  ".into(), Some("Ana marka".into()))
        .await
        .unwrap();
    assert_eq!(a.group.name, "Marka A");
    assert_eq!(a.group.purpose.as_deref(), Some("Ana marka"));
    assert!(a.members.is_empty());
    let b = groups::create(d, o, "Marka B".into(), Some("   ".into()))
        .await
        .unwrap();
    assert_eq!(b.group.purpose, None);

    for name in ["marka a", "MARKA A"] {
        let e = err(groups::create(d, o, name.into(), None).await);
        assert_eq!(e.code, ErrorCode::Conflict, "{name}");
    }
    assert_invalid(&err(groups::create(d, o, "  ".into(), None).await), "name");
    assert_invalid(
        &err(groups::create(d, o, "x".repeat(65), None).await),
        "name",
    );
    assert_invalid(
        &err(groups::create(d, o, "Marka C".into(), Some("x".repeat(2_001))).await),
        "purpose",
    );

    // Renaming: to a free name, to its own name in another case, never to another's.
    let renamed = groups::rename(d, o, b.group.id, "Marka Bee".into())
        .await
        .unwrap();
    assert_eq!(renamed.group.name, "Marka Bee");
    groups::rename(d, o, b.group.id, "MARKA BEE".into())
        .await
        .unwrap();
    let e = err(groups::rename(d, o, b.group.id, "marka a".into()).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = err(groups::rename(d, o, CapabilityGroupId::new_v7(), "Yeni".into()).await);
    assert_eq!(e.code, ErrorCode::NotFound);

    let phone = w.declare("phone", "Telefon").await.capability.id;
    groups::add_member(d, o, a.group.id, phone).await.unwrap();
    groups::delete(d, o, a.group.id).await.unwrap();
    let snapshot = w.uow.snapshot();
    assert!(snapshot.capability_group_members.is_empty());
    assert_eq!(snapshot.capabilities.len(), 1, "the capability stays");
    let e = err(groups::delete(d, o, a.group.id).await);
    assert_eq!(e.code, ErrorCode::NotFound);

    let actions: Vec<String> = w
        .ledger("capability.groups.")
        .iter()
        .map(|e| e.action.as_str().to_owned())
        .collect();
    assert_eq!(
        actions,
        [
            "capability.groups.create",
            "capability.groups.create",
            "capability.groups.rename",
            "capability.groups.rename",
            "capability.groups.add_member",
            "capability.groups.delete",
        ]
    );
    for entry in w.ledger("capability.groups.") {
        assert_eq!(entry.subject.as_ref().unwrap().kind, "capability_group");
    }
    assert_eq!(
        w.entries("capability.groups.delete")[0].payload,
        json!({ "name": "Marka A", "members": 1 })
    );
}

#[tokio::test]
async fn group_members_come_with_their_effective_status() {
    let w = world().await;
    let (d, o) = (&w.deps, &w.owner_ctx);
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let ig = w.declare("instagram", "Acme IG").await.capability.id;
    capabilities::verify(d, o, phone, evidence("ok", &[]))
        .await
        .unwrap();
    let group = groups::create(d, o, "Saha".into(), None)
        .await
        .unwrap()
        .group
        .id;
    groups::add_member(d, o, group, phone).await.unwrap();
    let out = groups::add_member(d, o, group, ig).await.unwrap();
    assert_eq!(out.members.len(), 2);
    // Adding again changes nothing.
    groups::add_member(d, o, group, ig).await.unwrap();

    let later = at(o, days_later(40));
    let listed = groups::list(d, &later).await.unwrap();
    assert_eq!(listed.len(), 1);
    let statuses: Vec<(CapabilityId, EffectiveStatus)> = listed[0]
        .members
        .iter()
        .map(|m| (m.capability.id, m.effective_status))
        .collect();
    let mut expected = vec![
        (phone, EffectiveStatus::Stale),
        (ig, EffectiveStatus::Declared),
    ];
    expected.sort();
    assert_eq!(statuses, expected);

    let out = groups::remove_member(d, o, group, ig).await.unwrap();
    assert_eq!(out.members.len(), 1);
    let e = err(groups::remove_member(d, o, group, ig).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    let e = err(groups::add_member(d, o, group, CapabilityId::new_v7()).await);
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(
        w.entries("capability.groups.remove_member")[0].payload,
        json!({ "capability_id": ig.to_string() })
    );
}

#[tokio::test]
async fn groups_need_capabilities_manage_to_change_and_workspace_read_to_list() {
    let w = world().await;
    let group = groups::create(&w.deps, &w.owner_ctx, "Saha".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let rep = w.member("rep").await;
    let d = &w.deps;
    for e in [
        err(groups::create(d, &rep, "Yeni".into(), None).await),
        err(groups::rename(d, &rep, group, "Yeni".into()).await),
        err(groups::delete(d, &rep, group).await),
        err(groups::add_member(d, &rep, group, phone).await),
        err(groups::remove_member(d, &rep, group, phone).await),
    ] {
        assert_forbidden(&e, "capabilities.manage");
    }
    assert_eq!(groups::list(d, &rep).await.unwrap().len(), 1);
    let auditor = w.agent(&["ledger.read"]).await;
    assert_forbidden(&err(groups::list(d, &auditor).await), "workspace.read");
}

#[tokio::test]
async fn group_referenced_by_strategy_cannot_be_deleted() {
    let w = world().await;
    let (d, o) = (&w.deps, &w.owner_ctx);
    let brand = groups::create(d, o, "Marka A".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let spare = groups::create(d, o, "Yedek".into(), None)
        .await
        .unwrap()
        .group
        .id;
    let narrowed_to = |group: Option<CapabilityGroupId>| Sections {
        channels: vec![ChannelChoice {
            channel: "any".into(),
            rationale: "her yerde".into(),
            group_id: group.map(|g| g.as_uuid()),
        }],
        ..Sections::default()
    };

    // The approved version narrows its channel to the brand's group; the draft opened from it
    // copies the choice.
    let approved = StrategyVersionId::new_v7();
    {
        let mut t = w.uow.tenant(w.ws).await.unwrap();
        t.strategy()
            .insert(StrategyVersion {
                id: approved,
                workspace_id: w.ws,
                number: 1,
                status: VersionStatus::Approved,
                sections: narrowed_to(Some(brand)),
                created_at: FIXED_NOW,
                created_by: Actor::Human { user_id: w.owner },
                submitted_at: Some(FIXED_NOW),
                approved_at: Some(FIXED_NOW),
                approved_by: Some(w.owner),
                archived_at: None,
            })
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let draft = strategy::start_consultation(d, o).await.unwrap().id;
    let e = err(groups::delete(d, o, brand).await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.message, "group is referenced by the strategy");
    assert_eq!(e.details, json!({ "version_ids": [approved, draft] }));

    // The draft drops the group; the approved version still names it.
    let channels = json!([{ "channel": "any", "rationale": "her yerde" }]);
    strategy::write_section(d, o, "channels".into(), channels)
        .await
        .unwrap();
    let e = err(groups::delete(d, o, brand).await);
    assert_eq!(e.details, json!({ "version_ids": [approved] }));
    assert_eq!(groups::list(d, o).await.unwrap().len(), 2);
    assert!(w.entries("capability.groups.delete").is_empty());

    // A group nothing refers to is deleted as before.
    groups::delete(d, o, spare).await.unwrap();
    assert_eq!(w.entries("capability.groups.delete").len(), 1);
}
