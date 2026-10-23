//! The in-memory capability, group, budget and workspace-policy repos keep the contracts `jt_pg`
//! keeps: the sealed blob only through `read_sealed`, one live capability per external account
//! (`CONFLICT`), members and links only within the bundle's workspace (`NOT_FOUND`, Review Focus
//! 3), half-open spend windows, newest-first spend pages, and policy defaults.

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{CapabilityFilter, UserRow, WorkspacePolicy};
use jt_app::usecases::Deps;
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, Capability, CapabilityGroup,
    CapabilityGroupId, CapabilityId, END_OF_TIME, KindGroup, NewBudgetItem, NewBudgetSpend,
    NewCapability, Period, SpendSource, StoredStatus, Unit,
};
use jt_tenancy::{Email, UserId, WorkspaceId, WorkspaceStatus};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps};
use serde_json::json;
use time::{Duration, OffsetDateTime};

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

fn setup() -> (InMemoryUow, Deps) {
    let uow = InMemoryUow::new();
    let deps = deps(Arc::new(uow.clone()));
    (uow, deps)
}

/// Creates a workspace and a user, committed.
async fn workspace(deps: &Deps, slug: &str) -> WorkspaceId {
    let (ws, user) = (WorkspaceId::new_v7(), UserId::new_v7());
    let mut u = deps.uow.user().await.unwrap();
    u.users()
        .insert(UserRow {
            id: user,
            email: Email::parse(&format!("{slug}@example.com")).unwrap(),
            password_hash: "plain:pw".into(),
            display_name: slug.into(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    u.workspaces_create(ws, slug, slug, WorkspaceStatus::Active, FIXED_NOW)
        .await
        .unwrap();
    u.commit().await.unwrap();
    ws
}

fn capability(
    ws: WorkspaceId,
    kind: &str,
    external_id: Option<&str>,
    at: OffsetDateTime,
) -> Capability {
    Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: kind.into(),
            external_id: external_id.map(Into::into),
            connector_public: json!({ "handle": "@kahve" }),
            ..NewCapability::default()
        },
        at,
    )
    .unwrap()
}

fn group(ws: WorkspaceId, name: &str) -> CapabilityGroup {
    CapabilityGroup::new(CapabilityGroupId::new_v7(), ws, name.into(), None).unwrap()
}

fn item(ws: WorkspaceId, at: OffsetDateTime) -> BudgetItem {
    BudgetItem::new(
        BudgetItemId::new_v7(),
        ws,
        NewBudgetItem {
            name: "Reklam".into(),
            kind: BudgetKind::AdBudget,
            unit: Unit::Currency("TRY".into()),
            cap: 1_000,
            period: Period::Monthly,
        },
        at,
    )
    .unwrap()
}

fn spend(item: &BudgetItem, amount: i64, at: OffsetDateTime) -> BudgetSpend {
    BudgetSpend::new(
        BudgetSpendId::new_v7(),
        item.workspace_id,
        item.id,
        NewBudgetSpend {
            amount,
            source: SpendSource::Agent,
            reference: None,
        },
        at,
    )
    .unwrap()
}

async fn insert(deps: &Deps, c: &Capability, sealed: Option<Vec<u8>>) {
    let mut t = deps.uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities().insert(c.clone(), sealed).await.unwrap();
    t.commit().await.unwrap();
}

#[tokio::test]
async fn capability_round_trip_keeps_the_sealed_blob_behind_read_sealed() {
    let (_, deps) = setup();
    let ws = workspace(&deps, "a").await;
    let other = workspace(&deps, "b").await;
    let ig = capability(ws, "instagram", Some("ig-1"), FIXED_NOW);
    let phone = capability(ws, "phone", None, FIXED_NOW + Duration::minutes(1));
    insert(&deps, &ig, Some(b"sealed".to_vec())).await;
    insert(&deps, &phone, None).await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let c = t.capabilities();
    assert_eq!(
        c.find(ig.id).await.unwrap(),
        Some(Capability {
            has_sealed_config: true,
            ..ig.clone()
        })
    );
    assert_eq!(
        c.read_sealed(ig.id).await.unwrap(),
        Some(b"sealed".to_vec())
    );
    assert_eq!(c.read_sealed(phone.id).await.unwrap(), None);
    // `lock` reads as `find` does (the fakes run one bundle at a time, so there is no one to wait
    // for), including nothing for an unknown id.
    assert_eq!(c.lock(ig.id).await.unwrap(), c.find(ig.id).await.unwrap());
    assert_eq!(c.lock(CapabilityId::new_v7()).await.unwrap(), None);
    let listed: Vec<CapabilityId> = c
        .list(CapabilityFilter::default())
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(listed, vec![ig.id, phone.id]);
    let devices = CapabilityFilter {
        group: Some(KindGroup::Device),
        ..CapabilityFilter::default()
    };
    assert_eq!(c.list(devices).await.unwrap(), vec![phone.clone()]);

    // `update` leaves the sealed blob, the kind and the creation time as stored.
    let at = FIXED_NOW + Duration::hours(1);
    c.update(Capability {
        kind_key: "camera".into(),
        name: "Telefon".into(),
        status: StoredStatus::Verified,
        last_verified_at: Some(at),
        has_sealed_config: true,
        created_at: at,
        updated_at: at,
        ..phone.clone()
    })
    .await
    .unwrap();
    c.update(Capability {
        has_sealed_config: false,
        ..ig.clone()
    })
    .await
    .unwrap();
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let c = t.capabilities();
    let updated = c.find(phone.id).await.unwrap().unwrap();
    assert_eq!(
        updated,
        Capability {
            name: "Telefon".into(),
            status: StoredStatus::Verified,
            last_verified_at: Some(at),
            updated_at: at,
            ..phone.clone()
        }
    );
    assert_eq!(
        c.read_sealed(ig.id).await.unwrap(),
        Some(b"sealed".to_vec())
    );
    c.set_sealed(ig.id, None, at).await.unwrap();
    c.set_status(phone.id, StoredStatus::Retired, at)
        .await
        .unwrap();
    assert!(!c.find(ig.id).await.unwrap().unwrap().has_sealed_config);
    assert_eq!(
        c.kinds_in_use().await.unwrap(),
        BTreeSet::from(["instagram".to_owned()])
    );
    t.commit().await.unwrap();

    // Unknown ids are NOT_FOUND, and the failed call spoils the bundle.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(t.capabilities().read_sealed(CapabilityId::new_v7()).await),
        ErrorCode::NotFound
    );
    assert_eq!(code(t.commit().await), ErrorCode::Internal);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(
            t.capabilities()
                .set_status(CapabilityId::new_v7(), StoredStatus::Verified, at)
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);

    // Another workspace sees none of it, and a row for another workspace is INTERNAL.
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(
        code(t.capabilities().set_sealed(ig.id, None, at).await),
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(t.capabilities().find(ig.id).await.unwrap(), None);
    assert_eq!(
        code(t.capabilities().read_sealed(ig.id).await),
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(
        code(t.capabilities().update(ig.clone()).await),
        ErrorCode::Internal
    );
}

/// The repo contract `jt_pg` keeps too: a credential change shows in the capability's update
/// time, and nothing else about the capability moves.
#[tokio::test]
async fn set_sealed_stamps_updated_at() {
    let (_, deps) = setup();
    let ws = workspace(&deps, "a").await;
    let ig = capability(ws, "instagram", Some("ig-1"), FIXED_NOW);
    insert(&deps, &ig, None).await;

    let sealed_at = FIXED_NOW + Duration::hours(1);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.capabilities()
        .set_sealed(ig.id, Some(b"v1-sealed".to_vec()), sealed_at)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.capabilities().find(ig.id).await.unwrap(),
        Some(Capability {
            has_sealed_config: true,
            updated_at: sealed_at,
            ..ig.clone()
        })
    );
    drop(t);

    let cleared_at = sealed_at + Duration::hours(1);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.capabilities()
        .set_sealed(ig.id, None, cleared_at)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.capabilities().find(ig.id).await.unwrap(),
        Some(Capability {
            updated_at: cleared_at,
            ..ig.clone()
        })
    );
    assert_eq!(t.capabilities().read_sealed(ig.id).await.unwrap(), None);
}
#[tokio::test]
async fn same_external_account_twice_is_conflict_until_retired() {
    let (_, deps) = setup();
    let ws = workspace(&deps, "a").await;
    let other = workspace(&deps, "b").await;
    let first = capability(ws, "instagram", Some("ig-1"), FIXED_NOW);
    insert(&deps, &first, None).await;
    for c in [
        capability(ws, "instagram", Some("ig-2"), FIXED_NOW),
        capability(ws, "instagram", None, FIXED_NOW),
        capability(ws, "instagram", None, FIXED_NOW),
        capability(ws, "facebook_page", Some("ig-1"), FIXED_NOW),
        capability(other, "instagram", Some("ig-1"), FIXED_NOW),
    ] {
        insert(&deps, &c, None).await;
    }

    let twin = capability(ws, "instagram", Some("ig-1"), FIXED_NOW);
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(t.capabilities().insert(twin.clone(), None).await),
        ErrorCode::Conflict
    );
    drop(t);
    // A taken id is CONFLICT too.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(t.capabilities().insert(first.clone(), None).await),
        ErrorCode::Conflict
    );
    drop(t);

    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.capabilities()
        .set_status(first.id, StoredStatus::Retired, FIXED_NOW)
        .await
        .unwrap();
    t.capabilities().insert(twin.clone(), None).await.unwrap();
    t.commit().await.unwrap();

    // The retired one cannot come back, nor can another move onto the account.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(
            t.capabilities()
                .set_status(first.id, StoredStatus::Declared, FIXED_NOW)
                .await
        ),
        ErrorCode::Conflict
    );
    drop(t);
    let second = capability(ws, "instagram", Some("ig-3"), FIXED_NOW);
    insert(&deps, &second, None).await;
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .capabilities()
        .update(Capability {
            external_id: Some("ig-1".into()),
            ..second
        })
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
}

#[tokio::test]
async fn cross_workspace_group_member_and_budget_link_are_not_found() {
    let (_, deps) = setup();
    let a = workspace(&deps, "a").await;
    let b = workspace(&deps, "b").await;
    let (ours, theirs) = (group(a, "Marka"), group(b, "Marka"));
    let (our_cap, their_cap) = (
        capability(a, "phone", None, FIXED_NOW),
        capability(b, "phone", None, FIXED_NOW),
    );
    let (our_item, their_item) = (item(a, FIXED_NOW), item(b, FIXED_NOW));
    for (ws, g, c, i) in [
        (a, &ours, &our_cap, &our_item),
        (b, &theirs, &their_cap, &their_item),
    ] {
        let mut t = deps.uow.tenant(ws).await.unwrap();
        t.capability_groups()
            .insert(g.clone(), FIXED_NOW)
            .await
            .unwrap();
        t.capabilities().insert(c.clone(), None).await.unwrap();
        t.budget().insert_item(i.clone()).await.unwrap();
        t.commit().await.unwrap();
    }

    for (g, c) in [
        (ours.id, their_cap.id),
        (theirs.id, our_cap.id),
        (theirs.id, their_cap.id),
    ] {
        let mut t = deps.uow.tenant(a).await.unwrap();
        assert_eq!(
            code(t.capability_groups().add_member(g, c).await),
            ErrorCode::NotFound
        );
    }
    for (c, i) in [
        (our_cap.id, their_item.id),
        (their_cap.id, our_item.id),
        (their_cap.id, their_item.id),
    ] {
        let mut t = deps.uow.tenant(a).await.unwrap();
        assert_eq!(code(t.budget().link(c, i).await), ErrorCode::NotFound);
    }
    let mut t = deps.uow.tenant(a).await.unwrap();
    let r = t
        .budget()
        .append_spend(BudgetSpend {
            workspace_id: a,
            ..spend(&their_item, 5, FIXED_NOW)
        })
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);

    // Within the workspace: idempotent adds and links, NOT_FOUND removals of what is not there.
    let mut t = deps.uow.tenant(a).await.unwrap();
    t.capability_groups()
        .add_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.capability_groups()
        .add_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.budget().link(our_cap.id, our_item.id).await.unwrap();
    t.budget().link(our_cap.id, our_item.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capability_groups().list().await.unwrap(),
        vec![(ours.clone(), vec![our_cap.id])]
    );
    assert_eq!(
        t.capabilities()
            .find(our_cap.id)
            .await
            .unwrap()
            .unwrap()
            .budget_item_ids,
        vec![our_item.id]
    );
    let in_group = CapabilityFilter {
        group_id: Some(ours.id),
        ..CapabilityFilter::default()
    };
    assert_eq!(t.capabilities().list(in_group).await.unwrap().len(), 1);
    t.capability_groups()
        .remove_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.budget().unlink(our_cap.id, our_item.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capability_groups()
                .remove_member(ours.id, our_cap.id)
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().unlink(our_cap.id, our_item.id).await),
        ErrorCode::NotFound
    );
    drop(t);

    // Groups: a taken name is CONFLICT; deleting detaches members; unknown ids NOT_FOUND.
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capability_groups()
                .insert(group(a, "Marka"), FIXED_NOW)
                .await
        ),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = deps.uow.tenant(a).await.unwrap();
    t.capability_groups()
        .add_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.capability_groups()
        .rename(ours.id, "Marka A")
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    let (renamed, _) = t.capability_groups().find(ours.id).await.unwrap().unwrap();
    assert_eq!(renamed.name, "Marka A");
    t.capability_groups().delete(ours.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = deps.uow.tenant(a).await.unwrap();
    assert_eq!(t.capability_groups().list().await.unwrap(), vec![]);
    assert_eq!(
        code(t.capability_groups().rename(ours.id, "x").await),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn spend_windows_are_half_open_and_pages_newest_first() {
    let (uow, deps) = setup();
    let ws = workspace(&deps, "a").await;
    let other = workspace(&deps, "b").await;
    let budget = item(ws, FIXED_NOW);
    let s1 = spend(&budget, 100, FIXED_NOW);
    let s2 = spend(&budget, 250, FIXED_NOW + Duration::days(1));
    let s3 = spend(&budget, 400, FIXED_NOW + Duration::days(31));
    let mut t = deps.uow.tenant(ws).await.unwrap();
    t.budget().insert_item(budget.clone()).await.unwrap();
    for s in [&s1, &s2, &s3] {
        assert_eq!(t.budget().append_spend(s.clone()).await.unwrap(), s.id);
    }
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    let b = t.budget();
    let day = Duration::days(1);
    assert_eq!(
        b.spent_between(budget.id, FIXED_NOW, FIXED_NOW + day)
            .await
            .unwrap(),
        100
    );
    assert_eq!(
        b.spent_between(budget.id, OffsetDateTime::UNIX_EPOCH, END_OF_TIME)
            .await
            .unwrap(),
        750
    );
    assert_eq!(
        b.list_spend(budget.id, 10, None).await.unwrap(),
        vec![s3.clone(), s2.clone(), s1.clone()]
    );
    assert_eq!(
        b.list_spend(budget.id, 10, Some((s2.at, s2.id)))
            .await
            .unwrap(),
        vec![s1.clone()]
    );
    assert_eq!(
        b.list_spend(budget.id, 0, None).await.unwrap(),
        vec![s3.clone()]
    );
    assert_eq!(b.list_items().await.unwrap(), vec![budget.clone()]);
    drop(t);

    // A taken spend id is CONFLICT; nothing changes a recorded spend.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        code(t.budget().append_spend(s1.clone()).await),
        ErrorCode::Conflict
    );
    drop(t);
    // An amount that is not positive breaks the check constraint (`INTERNAL`), as in `jt_pg`.
    let mut t = deps.uow.tenant(ws).await.unwrap();
    let r = t
        .budget()
        .append_spend(BudgetSpend {
            amount: 0,
            ..spend(&budget, 1, FIXED_NOW)
        })
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
    drop(t);
    assert_eq!(uow.snapshot().budget_spend.len(), 3);

    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(t.budget().find_item(budget.id).await.unwrap(), None);
    assert_eq!(
        t.budget()
            .spent_between(budget.id, OffsetDateTime::UNIX_EPOCH, END_OF_TIME)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn workspace_policy_defaults_and_bounds() {
    let (_, deps) = setup();
    let ws = workspace(&deps, "a").await;
    let other = workspace(&deps, "b").await;

    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.workspace_policy().get().await.unwrap(),
        WorkspacePolicy::default()
    );
    t.workspace_policy()
        .set(
            WorkspacePolicy {
                agent_checkin_interval_minutes: 30,
            },
            FIXED_NOW,
        )
        .await
        .unwrap();
    t.workspace_policy()
        .set(
            WorkspacePolicy {
                agent_checkin_interval_minutes: 45,
            },
            FIXED_NOW,
        )
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        t.workspace_policy()
            .get()
            .await
            .unwrap()
            .agent_checkin_interval_minutes,
        45
    );
    drop(t);
    let mut t = deps.uow.tenant(other).await.unwrap();
    assert_eq!(
        t.workspace_policy().get().await.unwrap(),
        WorkspacePolicy::default()
    );
    drop(t);

    // Outside 15..=10080 is INTERNAL, as the check constraint answers.
    for minutes in [14, 10_081] {
        let mut t = deps.uow.tenant(ws).await.unwrap();
        let r = t
            .workspace_policy()
            .set(
                WorkspacePolicy {
                    agent_checkin_interval_minutes: minutes,
                },
                FIXED_NOW,
            )
            .await;
        assert_eq!(code(r), ErrorCode::Internal);
    }
}
