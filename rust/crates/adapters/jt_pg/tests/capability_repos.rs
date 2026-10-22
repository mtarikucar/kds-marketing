//! Capabilities, groups, budget items, the spend ledger and workspace policies against a real
//! database: the repos' contracts, the partial unique index behind "one live capability per
//! external account", cross-workspace references refused (Review Focus 3), the append-only spend
//! ledger, and workspace scoping.

use std::collections::BTreeSet;

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{
    CapabilityFilter, DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES, UnitOfWork, WorkspacePolicy,
};
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, Capability, CapabilityGroup,
    CapabilityGroupId, CapabilityId, END_OF_TIME, Evidence, Hours, KindGroup, NewBudgetItem,
    NewBudgetSpend, NewCapability, Period, Policy, SpendSource, StoredStatus, Unit, period_window,
};
use jt_pg::{PgUnitOfWork, PlatformTx, TenantTx};
use jt_tenancy::WorkspaceId;
use jt_testkit::TestDb;
use serde_json::json;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const T0: OffsetDateTime = datetime!(2030-01-01 09:00 UTC);

fn uow(db: &TestDb) -> PgUnitOfWork {
    PgUnitOfWork::new(db.pool.clone())
}

/// The code of a result that must be an error.
fn code<T: std::fmt::Debug>(r: Result<T, AppError>) -> ErrorCode {
    r.expect_err("expected an error").code
}

/// A declared capability of `kind` in `ws`, created at `at`.
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
            key_detail: (kind == "other").then(|| "zapier".into()),
            name: format!("{kind} {}", external_id.unwrap_or("-")),
            external_id: external_id.map(Into::into),
            connector_public: json!({ "handle": "@kahve", "scopes": ["publish"] }),
            ..NewCapability::default()
        },
        at,
    )
    .unwrap()
}

fn group(ws: WorkspaceId, name: &str) -> CapabilityGroup {
    CapabilityGroup::new(
        CapabilityGroupId::new_v7(),
        ws,
        name.into(),
        Some("Marka A hesapları".into()),
    )
    .unwrap()
}

fn budget_item(ws: WorkspaceId, name: &str, kind: BudgetKind, at: OffsetDateTime) -> BudgetItem {
    BudgetItem::new(
        BudgetItemId::new_v7(),
        ws,
        NewBudgetItem {
            name: name.into(),
            kind,
            unit: Unit::Currency("TRY".into()),
            cap: 100_000,
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
            source: SpendSource::Connector("meta_ads".into()),
            reference: Some(format!("fatura-{amount}")),
        },
        at,
    )
    .unwrap()
}

/// Inserts and commits `c` with `sealed`.
async fn insert(uow: &PgUnitOfWork, c: &Capability, sealed: Option<Vec<u8>>) {
    let mut t = uow.tenant(c.workspace_id).await.unwrap();
    t.capabilities().insert(c.clone(), sealed).await.unwrap();
    t.commit().await.unwrap();
}

async fn find(uow: &PgUnitOfWork, ws: WorkspaceId, id: CapabilityId) -> Capability {
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities()
        .find(id)
        .await
        .unwrap()
        .expect("the capability")
}

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn capability_insert_find_list_update_and_sealed_round_trip() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let instagram = capability(a, "instagram", Some("ig-1"), T0);
    let phone = capability(a, "phone", None, T0 + Duration::minutes(1));
    let other = capability(a, "other", None, T0 + Duration::minutes(2));
    let sealed = b"v1-nonce-and-ciphertext".to_vec();
    insert(&uow, &instagram, Some(sealed.clone())).await;
    insert(&uow, &phone, None).await;
    insert(&uow, &other, None).await;

    // `find` reports only that sealed credentials exist; the bytes come only from `read_sealed`.
    let found = find(&uow, a, instagram.id).await;
    assert_eq!(
        found,
        Capability {
            has_sealed_config: true,
            ..instagram.clone()
        }
    );
    assert_eq!(find(&uow, a, phone.id).await, phone);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().read_sealed(instagram.id).await.unwrap(),
        Some(sealed.clone())
    );
    assert_eq!(t.capabilities().read_sealed(phone.id).await.unwrap(), None);
    assert_eq!(
        code(t.capabilities().read_sealed(CapabilityId::new_v7()).await),
        ErrorCode::NotFound
    );
    drop(t);

    // Listing: oldest first, narrowed by kind group, kind and status.
    let mut t = uow.tenant(a).await.unwrap();
    let ids = |cs: Vec<Capability>| cs.into_iter().map(|c| c.id).collect::<Vec<_>>();
    let all = t
        .capabilities()
        .list(CapabilityFilter::default())
        .await
        .unwrap();
    assert_eq!(ids(all), vec![instagram.id, phone.id, other.id]);
    let social = CapabilityFilter {
        group: Some(KindGroup::SocialAccount),
        ..CapabilityFilter::default()
    };
    assert_eq!(
        ids(t.capabilities().list(social).await.unwrap()),
        vec![instagram.id]
    );
    let phones = CapabilityFilter {
        kind: Some("phone"),
        ..CapabilityFilter::default()
    };
    assert_eq!(
        ids(t.capabilities().list(phones).await.unwrap()),
        vec![phone.id]
    );
    let verified = CapabilityFilter {
        status: Some(StoredStatus::Verified),
        ..CapabilityFilter::default()
    };
    assert_eq!(t.capabilities().list(verified).await.unwrap(), vec![]);
    let mismatched = CapabilityFilter {
        group: Some(KindGroup::Device),
        kind: Some("instagram"),
        ..CapabilityFilter::default()
    };
    assert_eq!(t.capabilities().list(mismatched).await.unwrap(), vec![]);
    drop(t);

    // `update` writes the mutable fields and leaves the sealed blob, the kind and the creation
    // time as stored.
    let t1 = T0 + Duration::hours(1);
    let mut verified_phone = phone.clone();
    verified_phone.name = "Ofis telefonu".into();
    verified_phone.description = "Tezgâhtaki Android".into();
    verified_phone.status = StoredStatus::Verified;
    verified_phone.last_verified_at = Some(t1);
    verified_phone.evidence = Some(Evidence {
        text: "adb devices listed the serial".into(),
        refs: vec!["serial:R58M".into(), "file:shot-1".into()],
    });
    verified_phone.policy = Policy {
        active_hours: Some(Hours {
            tz: "Europe/Istanbul".into(),
            from: 9,
            to: 24,
            days: vec![1, 2, 3, 4, 5],
        }),
        daily_ops_cap: Some(40),
        spend_cap_minor: None,
        requires_human_approval: true,
        verify_max_age_days: 7,
    };
    verified_phone.connector_public = json!({ "model": "Pixel" });
    verified_phone.strategy_version_id = Some(Uuid::now_v7());
    verified_phone.updated_at = t1;
    let mut t = uow.tenant(a).await.unwrap();
    t.capabilities()
        .update(Capability {
            kind_key: "camera".into(),
            created_at: t1,
            has_sealed_config: true,
            ..verified_phone.clone()
        })
        .await
        .unwrap();
    // An update that says "no sealed config" does not drop the stored blob.
    t.capabilities()
        .update(Capability {
            has_sealed_config: false,
            updated_at: t1,
            ..found.clone()
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert_eq!(find(&uow, a, phone.id).await, verified_phone);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().read_sealed(instagram.id).await.unwrap(),
        Some(sealed.clone())
    );
    assert_eq!(
        ids(t.capabilities().list(verified).await.unwrap()),
        vec![phone.id]
    );
    drop(t);

    // The sealed blob changes only through `set_sealed`.
    let mut t = uow.tenant(a).await.unwrap();
    t.capabilities()
        .set_sealed(instagram.id, None)
        .await
        .unwrap();
    t.capabilities()
        .set_sealed(phone.id, Some(b"v1-other".to_vec()))
        .await
        .unwrap();
    t.commit().await.unwrap();
    assert!(!find(&uow, a, instagram.id).await.has_sealed_config);
    assert!(find(&uow, a, phone.id).await.has_sealed_config);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().read_sealed(instagram.id).await.unwrap(),
        None
    );
    assert_eq!(
        t.capabilities().read_sealed(phone.id).await.unwrap(),
        Some(b"v1-other".to_vec())
    );
    drop(t);

    // `set_status` stamps `updated_at`; a retired capability's kind is no longer in use.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().kinds_in_use().await.unwrap(),
        BTreeSet::from(["instagram".into(), "other".into(), "phone".into()])
    );
    let t2 = T0 + Duration::hours(2);
    t.capabilities()
        .set_status(other.id, StoredStatus::Retired, t2)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let retired = find(&uow, a, other.id).await;
    assert_eq!(
        (retired.status, retired.updated_at),
        (StoredStatus::Retired, t2)
    );
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().kinds_in_use().await.unwrap(),
        BTreeSet::from(["instagram".into(), "phone".into()])
    );
    drop(t);

    // Unknown ids are NOT_FOUND for every mutation.
    let unknown = capability(a, "x", None, T0);
    for attempt in 0..3 {
        let mut t = uow.tenant(a).await.unwrap();
        let r = match attempt {
            0 => t.capabilities().update(unknown.clone()).await,
            1 => t.capabilities().set_sealed(unknown.id, None).await,
            _ => {
                t.capabilities()
                    .set_status(unknown.id, StoredStatus::Verified, T0)
                    .await
            }
        };
        assert_eq!(code(r), ErrorCode::NotFound, "attempt {attempt}");
    }

    // Another workspace sees and touches none of it.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.capabilities().find(instagram.id).await.unwrap(), None);
    assert_eq!(
        t.capabilities()
            .list(CapabilityFilter::default())
            .await
            .unwrap(),
        vec![]
    );
    assert_eq!(
        t.capabilities().kinds_in_use().await.unwrap(),
        BTreeSet::new()
    );
    assert_eq!(
        code(t.capabilities().read_sealed(phone.id).await),
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        code(
            t.capabilities()
                .set_status(phone.id, StoredStatus::Retired, T0)
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);
    // A row for another workspace is a programming error.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        code(t.capabilities().update(phone.clone()).await),
        ErrorCode::Internal
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        code(
            t.capabilities()
                .insert(capability(a, "x", None, T0), None)
                .await
        ),
        ErrorCode::Internal
    );
    drop(t);
    assert_eq!(find(&uow, a, phone.id).await.status, StoredStatus::Verified);

    // A taken id is CONFLICT.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.capabilities().insert(phone.clone(), None).await),
        ErrorCode::Conflict
    );
}

#[tokio::test]
async fn same_external_account_twice_is_conflict_until_retired() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let first = capability(a, "instagram", Some("ig-1"), T0);
    insert(&uow, &first, None).await;

    // Many capabilities of one kind are fine (B10): another account, no account at all twice,
    // the same account id under another kind, the same account in another workspace.
    for c in [
        capability(a, "instagram", Some("ig-2"), T0),
        capability(a, "instagram", None, T0),
        capability(a, "instagram", None, T0),
        capability(a, "facebook_page", Some("ig-1"), T0),
        capability(b, "instagram", Some("ig-1"), T0),
    ] {
        insert(&uow, &c, None).await;
    }

    // The same external account twice is not.
    let twin = capability(a, "instagram", Some("ig-1"), T0);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.capabilities().insert(twin.clone(), None).await),
        ErrorCode::Conflict
    );
    drop(t);

    // Nor is moving another capability onto it.
    let second = capability(a, "instagram", Some("ig-3"), T0);
    insert(&uow, &second, None).await;
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .capabilities()
        .update(Capability {
            external_id: Some("ig-1".into()),
            ..second.clone()
        })
        .await;
    assert_eq!(code(r), ErrorCode::Conflict);
    drop(t);

    // The refusal is the partial unique index's, not a check in the repo.
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let err = sqlx::query(
        "insert into capabilities (id, workspace_id, kind_key, name, reach, status, \
         external_id, created_at, updated_at) \
         values ($1, $2, 'instagram', 'n', 'connector', 'declared', 'ig-1', $3, $3)",
    )
    .bind(Uuid::now_v7())
    .bind(a.as_uuid())
    .bind(T0)
    .execute(tx.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("23505"), "{db_err}");
    assert_eq!(
        db_err.constraint(),
        Some("capabilities_live_external_account")
    );
    tx.rollback().await.unwrap();

    // Once the first is retired the account may be declared again ...
    let mut t = uow.tenant(a).await.unwrap();
    t.capabilities()
        .set_status(first.id, StoredStatus::Retired, T0 + Duration::hours(1))
        .await
        .unwrap();
    t.capabilities().insert(twin.clone(), None).await.unwrap();
    t.commit().await.unwrap();

    // ... and the retired one cannot come back while the new one holds it.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capabilities()
                .set_status(first.id, StoredStatus::Declared, T0 + Duration::hours(2))
                .await
        ),
        ErrorCode::Conflict
    );
    drop(t);
    assert_eq!(find(&uow, a, first.id).await.status, StoredStatus::Retired);
}

/// Waits until another backend of this database waits for a lock; panics after ten seconds.
async fn wait_for_a_lock_waiter(db: &TestDb) {
    for _ in 0..500 {
        let waiting: i64 = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() \
             and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("no backend ever waited for a lock");
}

#[tokio::test]
async fn capability_lock_blocks_a_second_locker_until_commit() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let ads = capability(a, "meta_ads", Some("act-1"), T0);
    insert(&uow, &ads, Some(b"sealed".to_vec())).await;
    let item = budget_item(a, "Reklam", BudgetKind::AdBudget, T0);
    {
        let mut t = uow.tenant(a).await.unwrap();
        t.budget().insert_item(item.clone()).await.unwrap();
        t.commit().await.unwrap();
    }

    // A locks the capability, verifies it and links a budget item; B's lock waits for A and then
    // reads all of A's work, the link (another table) included.
    let mut first = uow.tenant(a).await.unwrap();
    let locked = first.capabilities().lock(ads.id).await.unwrap();
    assert_eq!(locked, Some(find(&uow, a, ads.id).await));
    first
        .capabilities()
        .set_status(ads.id, StoredStatus::Verified, T0 + Duration::minutes(1))
        .await
        .unwrap();
    first.budget().link(ads.id, item.id).await.unwrap();
    let second = {
        let uow = uow.clone();
        let id = ads.id;
        tokio::spawn(async move {
            let mut t = uow.tenant(a).await.unwrap();
            let seen = t.capabilities().lock(id).await.unwrap();
            t.commit().await.unwrap();
            seen
        })
    };
    wait_for_a_lock_waiter(&db).await;
    assert!(!second.is_finished(), "the second locker did not wait");
    first.commit().await.unwrap();
    let seen = second.await.unwrap().expect("the capability");
    assert_eq!(seen.status, StoredStatus::Verified);
    assert_eq!(seen.updated_at, T0 + Duration::minutes(1));
    assert_eq!(seen.budget_item_ids, [item.id]);
    assert!(seen.has_sealed_config);

    // A lock reads as `find` does: nothing for an unknown id or another workspace's capability.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capabilities().lock(CapabilityId::new_v7()).await.unwrap(),
        None
    );
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(t.capabilities().lock(ads.id).await.unwrap(), None);
}

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn groups_insert_list_rename_and_delete() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let brand = group(a, "Marka A");
    let branch = CapabilityGroup::new(CapabilityGroupId::new_v7(), a, "Şube".into(), None).unwrap();
    let ig = capability(a, "instagram", Some("ig-1"), T0);
    let phone = capability(a, "phone", None, T0);
    insert(&uow, &ig, None).await;
    insert(&uow, &phone, None).await;

    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups()
        .insert(brand.clone(), T0)
        .await
        .unwrap();
    t.capability_groups()
        .insert(branch.clone(), T0 + Duration::minutes(1))
        .await
        .unwrap();
    t.capability_groups()
        .add_member(brand.id, phone.id)
        .await
        .unwrap();
    t.capability_groups()
        .add_member(brand.id, ig.id)
        .await
        .unwrap();
    t.commit().await.unwrap();

    // Oldest group first, members in id order.
    let mut members = vec![ig.id, phone.id];
    members.sort();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capability_groups().list().await.unwrap(),
        vec![(brand.clone(), members.clone()), (branch.clone(), vec![])]
    );
    assert_eq!(
        t.capability_groups().find(brand.id).await.unwrap(),
        Some((brand.clone(), members.clone()))
    );
    assert_eq!(
        t.capability_groups()
            .find(CapabilityGroupId::new_v7())
            .await
            .unwrap(),
        None
    );
    // The capability list narrows to a group's members.
    let in_brand = CapabilityFilter {
        group_id: Some(brand.id),
        ..CapabilityFilter::default()
    };
    let listed: BTreeSet<CapabilityId> = t
        .capabilities()
        .list(in_brand)
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(listed, BTreeSet::from([ig.id, phone.id]));
    drop(t);

    // A taken name or id is CONFLICT; the same name in another workspace is fine.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.capability_groups().insert(group(a, "Marka A"), T0).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.capability_groups().insert(brand.clone(), T0).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    t.capability_groups()
        .insert(group(b, "Marka A"), T0)
        .await
        .unwrap();
    t.commit().await.unwrap();
    // A group for another workspace is a programming error.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        code(t.capability_groups().insert(group(a, "Başka"), T0).await),
        ErrorCode::Internal
    );
    drop(t);

    // Renaming: to a taken name is CONFLICT, an unknown group NOT_FOUND.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.capability_groups().rename(branch.id, "Marka A").await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capability_groups()
                .rename(CapabilityGroupId::new_v7(), "Yeni")
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups()
        .rename(branch.id, "Merkez şube")
        .await
        .unwrap();
    t.commit().await.unwrap();

    // Removing a member, then one that is not in the group.
    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups()
        .remove_member(brand.id, phone.id)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capability_groups()
                .remove_member(brand.id, phone.id)
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);

    // Deleting a group detaches its members and keeps the capabilities.
    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups().delete(brand.id).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    let renamed = CapabilityGroup {
        name: "Merkez şube".into(),
        ..branch.clone()
    };
    assert_eq!(
        t.capability_groups().list().await.unwrap(),
        vec![(renamed, vec![])]
    );
    let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
    let left: i64 =
        sqlx::query_scalar("select count(*) from capability_group_members where workspace_id = $1")
            .bind(a.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(left, 0);
    assert_eq!(
        t.capabilities()
            .list(CapabilityFilter::default())
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        code(t.capability_groups().delete(brand.id).await),
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn group_member_from_another_workspace_is_not_found() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let ours = group(a, "Marka A");
    let our_cap = capability(a, "instagram", Some("ig-a"), T0);
    let theirs = group(b, "Marka B");
    let their_cap = capability(b, "instagram", Some("ig-b"), T0);
    insert(&uow, &our_cap, None).await;
    insert(&uow, &their_cap, None).await;
    for g in [&ours, &theirs] {
        let mut t = uow.tenant(g.workspace_id).await.unwrap();
        t.capability_groups().insert(g.clone(), T0).await.unwrap();
        t.commit().await.unwrap();
    }

    // Their capability into our group, our capability into their group, their capability into
    // their group from our bundle: each is NOT_FOUND, never a cross-tenant row.
    for (g, c) in [
        (ours.id, their_cap.id),
        (theirs.id, our_cap.id),
        (theirs.id, their_cap.id),
    ] {
        let mut t = uow.tenant(a).await.unwrap();
        assert_eq!(
            code(t.capability_groups().add_member(g, c).await),
            ErrorCode::NotFound,
            "group {g}, capability {c}"
        );
    }
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(
            t.capability_groups()
                .remove_member(theirs.id, their_cap.id)
                .await
        ),
        ErrorCode::NotFound
    );
    drop(t);

    // Adding a member is idempotent.
    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups()
        .add_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.capability_groups()
        .add_member(ours.id, our_cap.id)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.capability_groups().list().await.unwrap(),
        vec![(ours.clone(), vec![our_cap.id])]
    );
    drop(t);
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.capability_groups().list().await.unwrap(),
        vec![(theirs.clone(), vec![])]
    );
    assert_eq!(t.capability_groups().find(ours.id).await.unwrap(), None);
}

// ---------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn budget_link_and_spend_window_sum() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    let ads = capability(a, "meta_ads", Some("act-1"), T0);
    let their_cap = capability(b, "meta_ads", Some("act-9"), T0);
    insert(&uow, &ads, None).await;
    insert(&uow, &their_cap, None).await;
    let ad_budget = budget_item(a, "Meta reklam", BudgetKind::AdBudget, T0);
    let cash = budget_item(a, "Nakit", BudgetKind::Cash, T0 + Duration::minutes(1));
    let theirs = budget_item(b, "Onların", BudgetKind::AdBudget, T0);

    let mut t = uow.tenant(a).await.unwrap();
    t.budget().insert_item(ad_budget.clone()).await.unwrap();
    t.budget().insert_item(cash.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.budget().insert_item(theirs.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.budget().list_items().await.unwrap(),
        vec![ad_budget.clone(), cash.clone()]
    );
    assert_eq!(
        t.budget().find_item(ad_budget.id).await.unwrap(),
        Some(ad_budget.clone())
    );
    assert_eq!(t.budget().find_item(theirs.id).await.unwrap(), None);
    drop(t);
    // A taken id is CONFLICT; an item for another workspace INTERNAL.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().insert_item(ad_budget.clone()).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().insert_item(theirs.clone()).await),
        ErrorCode::Internal
    );
    drop(t);

    // Links: idempotent, read back on the capability, never across workspaces.
    let mut t = uow.tenant(a).await.unwrap();
    t.budget().link(ads.id, ad_budget.id).await.unwrap();
    t.budget().link(ads.id, ad_budget.id).await.unwrap();
    t.budget().link(ads.id, cash.id).await.unwrap();
    t.commit().await.unwrap();
    let mut linked = vec![ad_budget.id, cash.id];
    linked.sort();
    assert_eq!(find(&uow, a, ads.id).await.budget_item_ids, linked);
    for (c, item) in [
        (ads.id, theirs.id),
        (their_cap.id, ad_budget.id),
        (their_cap.id, theirs.id),
        (CapabilityId::new_v7(), cash.id),
    ] {
        let mut t = uow.tenant(a).await.unwrap();
        assert_eq!(
            code(t.budget().link(c, item).await),
            ErrorCode::NotFound,
            "capability {c}, item {item}"
        );
    }
    let mut t = uow.tenant(a).await.unwrap();
    t.budget().unlink(ads.id, cash.id).await.unwrap();
    t.commit().await.unwrap();
    assert_eq!(
        find(&uow, a, ads.id).await.budget_item_ids,
        vec![ad_budget.id]
    );
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().unlink(ads.id, cash.id).await),
        ErrorCode::NotFound
    );
    drop(t);

    // Spend: three entries, the last one in the next month.
    let s1 = spend(&ad_budget, 100, T0);
    let s2 = spend(&ad_budget, 250, T0 + Duration::days(1));
    let s3 = spend(&ad_budget, 400, T0 + Duration::days(31));
    let mut t = uow.tenant(a).await.unwrap();
    for s in [&s1, &s2, &s3] {
        assert_eq!(t.budget().append_spend(s.clone()).await.unwrap(), s.id);
    }
    t.budget().append_spend(spend(&cash, 7, T0)).await.unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(a).await.unwrap();
    let budget = t.budget();
    // Windows are half-open: `from` counts, `to` does not.
    let day = Duration::days(1);
    assert_eq!(
        budget
            .spent_between(ad_budget.id, T0, T0 + day)
            .await
            .unwrap(),
        100
    );
    assert_eq!(
        budget
            .spent_between(ad_budget.id, T0, T0 + day + Duration::seconds(1))
            .await
            .unwrap(),
        350
    );
    assert_eq!(
        budget
            .spent_between(ad_budget.id, T0 + Duration::seconds(1), T0 + day)
            .await
            .unwrap(),
        0
    );
    let (month_start, month_end) = period_window(Period::Monthly, T0);
    assert_eq!(
        budget
            .spent_between(ad_budget.id, month_start, month_end)
            .await
            .unwrap(),
        350
    );
    assert_eq!(
        budget
            .spent_between(ad_budget.id, OffsetDateTime::UNIX_EPOCH, END_OF_TIME)
            .await
            .unwrap(),
        750
    );
    assert_eq!(
        budget.spent_between(cash.id, T0, T0 + day).await.unwrap(),
        7
    );
    assert_eq!(
        budget
            .spent_between(BudgetItemId::new_v7(), T0, T0 + day)
            .await
            .unwrap(),
        0
    );

    // Listing: newest first, keyset paging, the limit clamped to at least one.
    assert_eq!(
        budget.list_spend(ad_budget.id, 10, None).await.unwrap(),
        vec![s3.clone(), s2.clone(), s1.clone()]
    );
    assert_eq!(
        budget.list_spend(ad_budget.id, 2, None).await.unwrap(),
        vec![s3.clone(), s2.clone()]
    );
    assert_eq!(
        budget
            .list_spend(ad_budget.id, 10, Some((s2.at, s2.id)))
            .await
            .unwrap(),
        vec![s1.clone()]
    );
    assert_eq!(
        budget.list_spend(ad_budget.id, 0, None).await.unwrap(),
        vec![s3.clone()]
    );
    drop(t);

    // Spending from another workspace's item is NOT_FOUND; a taken id CONFLICT; a spend row
    // for another workspace INTERNAL.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .budget()
        .append_spend(BudgetSpend {
            workspace_id: a,
            ..spend(&theirs, 5, T0)
        })
        .await;
    assert_eq!(code(r), ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().append_spend(s1.clone()).await),
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        code(t.budget().append_spend(spend(&theirs, 5, T0)).await),
        ErrorCode::Internal
    );
    drop(t);
    // An amount that is not positive breaks the check constraint: callers build spend with
    // `BudgetSpend::new`, which refuses it.
    let mut t = uow.tenant(a).await.unwrap();
    let r = t
        .budget()
        .append_spend(BudgetSpend {
            amount: 0,
            ..spend(&ad_budget, 1, T0)
        })
        .await;
    assert_eq!(code(r), ErrorCode::Internal);
    drop(t);

    // Another workspace sees none of it.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.budget().list_spend(ad_budget.id, 10, None).await.unwrap(),
        vec![]
    );
    assert_eq!(
        t.budget()
            .spent_between(ad_budget.id, OffsetDateTime::UNIX_EPOCH, END_OF_TIME)
            .await
            .unwrap(),
        0
    );
    assert_eq!(t.budget().list_items().await.unwrap(), vec![theirs.clone()]);
}

#[tokio::test]
async fn spend_entries_are_append_only() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let item = budget_item(a, "Nakit", BudgetKind::Cash, T0);
    let entry = spend(&item, 120, T0);
    let mut t = uow.tenant(a).await.unwrap();
    t.budget().insert_item(item.clone()).await.unwrap();
    t.budget().append_spend(entry.clone()).await.unwrap();
    t.commit().await.unwrap();

    // The ledger cannot be changed or deleted, even by its own workspace.
    for statement in [
        "update budget_spend_entries set amount = 1 where workspace_id = $1",
        "delete from budget_spend_entries where workspace_id = $1",
    ] {
        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .execute(tx.conn())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("append-only"), "{err}");
        tx.rollback().await.unwrap();
    }
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.budget().list_spend(item.id, 10, None).await.unwrap(),
        vec![entry]
    );
}

// ---------------------------------------------------------------------------------------------
// Workspace policies
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn workspace_policy_defaults() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;

    // No row yet: the defaults.
    let mut t = uow.tenant(a).await.unwrap();
    assert_eq!(
        t.workspace_policy().get().await.unwrap(),
        WorkspacePolicy::default()
    );
    assert_eq!(
        WorkspacePolicy::default().agent_checkin_interval_minutes,
        DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES
    );
    assert_eq!(DEFAULT_AGENT_CHECKIN_INTERVAL_MINUTES, 1440);
    drop(t);

    // `set` inserts, then updates.
    for minutes in [60, 15, 10_080] {
        let mut t = uow.tenant(a).await.unwrap();
        t.workspace_policy()
            .set(
                WorkspacePolicy {
                    agent_checkin_interval_minutes: minutes,
                },
                T0,
            )
            .await
            .unwrap();
        t.commit().await.unwrap();
        let mut t = uow.tenant(a).await.unwrap();
        assert_eq!(
            t.workspace_policy()
                .get()
                .await
                .unwrap()
                .agent_checkin_interval_minutes,
            minutes
        );
    }

    // Another workspace keeps its defaults.
    let mut t = uow.tenant(b).await.unwrap();
    assert_eq!(
        t.workspace_policy().get().await.unwrap(),
        WorkspacePolicy::default()
    );
    drop(t);

    // Outside 15..=10080 breaks the check constraint: callers validate first.
    for minutes in [14, 10_081] {
        let mut t = uow.tenant(a).await.unwrap();
        let r = t
            .workspace_policy()
            .set(
                WorkspacePolicy {
                    agent_checkin_interval_minutes: minutes,
                },
                T0,
            )
            .await;
        assert_eq!(code(r), ErrorCode::Internal, "{minutes}");
    }
}

// ---------------------------------------------------------------------------------------------
// The schema and row-level security
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_schema_ties_members_links_and_spend_to_rows_of_their_own_workspace() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let our_cap = capability(a, "phone", None, T0);
    let their_cap = capability(b, "phone", None, T0);
    let our_group = group(a, "g");
    let our_item = budget_item(a, "i", BudgetKind::Cash, T0);
    let their_item = budget_item(b, "i", BudgetKind::Cash, T0);
    insert(&uow, &our_cap, None).await;
    insert(&uow, &their_cap, None).await;
    let mut t = uow.tenant(a).await.unwrap();
    t.capability_groups()
        .insert(our_group.clone(), T0)
        .await
        .unwrap();
    t.budget().insert_item(our_item.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(b).await.unwrap();
    t.budget().insert_item(their_item.clone()).await.unwrap();
    t.commit().await.unwrap();

    // Even platform-wide, where row-level security lets any workspace through, a row of `a`
    // cannot tie in a row of `b`.
    let statements: [(&str, Uuid, Uuid); 4] = [
        (
            "insert into capability_group_members (workspace_id, group_id, capability_id) \
             values ($1, $2, $3)",
            our_group.id.as_uuid(),
            their_cap.id.as_uuid(),
        ),
        (
            "insert into capability_budget_links (workspace_id, capability_id, budget_item_id) \
             values ($1, $2, $3)",
            our_cap.id.as_uuid(),
            their_item.id.as_uuid(),
        ),
        (
            "insert into capability_budget_links (workspace_id, capability_id, budget_item_id) \
             values ($1, $2, $3)",
            their_cap.id.as_uuid(),
            our_item.id.as_uuid(),
        ),
        (
            "insert into budget_spend_entries (workspace_id, budget_item_id, id, at, amount, \
             source) values ($1, $2, $3, now(), 1, '{\"kind\": \"agent\"}')",
            their_item.id.as_uuid(),
            Uuid::now_v7(),
        ),
    ];
    for (statement, x, y) in statements {
        let mut p = PlatformTx::begin(&db.pool).await.unwrap();
        let err = sqlx::query(statement)
            .bind(a.as_uuid())
            .bind(x)
            .bind(y)
            .execute(p.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(
            db_err.code().as_deref(),
            Some("23503"),
            "{statement}: {db_err}"
        );
        p.rollback().await.unwrap();
    }

    // Reach, status, budget kind, period, cap and amount outside their rules are refused.
    let checks = [
        "insert into capabilities (id, workspace_id, kind_key, name, reach, status, created_at, \
         updated_at) values ($1, $2, 'phone', 'n', 'telepathy', 'declared', now(), now())",
        "insert into capabilities (id, workspace_id, kind_key, name, reach, status, created_at, \
         updated_at) values ($1, $2, 'phone', 'n', 'device', 'lost', now(), now())",
        "insert into budget_items (id, workspace_id, name, kind, unit, cap, period, created_at) \
         values ($1, $2, 'n', 'gold', '{\"kind\": \"minutes\"}', 1, 'daily', now())",
        "insert into budget_items (id, workspace_id, name, kind, unit, cap, period, created_at) \
         values ($1, $2, 'n', 'cash', '{\"kind\": \"minutes\"}', 1, 'hourly', now())",
        "insert into budget_items (id, workspace_id, name, kind, unit, cap, period, created_at) \
         values ($1, $2, 'n', 'cash', '{\"kind\": \"minutes\"}', -1, 'daily', now())",
    ];
    for statement in checks {
        let mut p = PlatformTx::begin(&db.pool).await.unwrap();
        let err = sqlx::query(statement)
            .bind(Uuid::now_v7())
            .bind(a.as_uuid())
            .execute(p.conn())
            .await
            .unwrap_err();
        let db_err = err.as_database_error().expect("a database error");
        assert_eq!(
            db_err.code().as_deref(),
            Some("23514"),
            "{statement}: {db_err}"
        );
        p.rollback().await.unwrap();
    }
    let mut p = PlatformTx::begin(&db.pool).await.unwrap();
    let err = sqlx::query(
        "insert into budget_spend_entries (workspace_id, budget_item_id, id, at, amount, source) \
         values ($1, $2, $3, now(), 0, '{\"kind\": \"agent\"}')",
    )
    .bind(b.as_uuid())
    .bind(their_item.id.as_uuid())
    .bind(Uuid::now_v7())
    .execute(p.conn())
    .await
    .unwrap_err();
    let db_err = err.as_database_error().expect("a database error");
    assert_eq!(db_err.code().as_deref(), Some("23514"), "{db_err}");
    p.rollback().await.unwrap();
}

#[tokio::test]
async fn capability_tables_are_hidden_without_their_workspace_in_scope() {
    let db = TestDb::new().await;
    let uow = uow(&db);
    let (a, _) = db.seed_workspace("a").await;
    let (b, _) = db.seed_workspace("b").await;
    let cap = capability(a, "phone", None, T0);
    let g = group(a, "g");
    let item = budget_item(a, "i", BudgetKind::Cash, T0);
    let mut t = uow.tenant(a).await.unwrap();
    t.capabilities().insert(cap.clone(), None).await.unwrap();
    t.capability_groups().insert(g.clone(), T0).await.unwrap();
    t.capability_groups()
        .add_member(g.id, cap.id)
        .await
        .unwrap();
    t.budget().insert_item(item.clone()).await.unwrap();
    t.budget().link(cap.id, item.id).await.unwrap();
    t.budget().append_spend(spend(&item, 3, T0)).await.unwrap();
    t.workspace_policy()
        .set(
            WorkspacePolicy {
                agent_checkin_interval_minutes: 30,
            },
            T0,
        )
        .await
        .unwrap();
    t.commit().await.unwrap();

    for table in [
        "capabilities",
        "capability_groups",
        "capability_group_members",
        "budget_items",
        "capability_budget_links",
        "budget_spend_entries",
        "workspace_policies",
    ] {
        let count = format!("select count(*) from {table}");
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is visible without a workspace in scope");

        let mut tx = TenantTx::begin(&db.pool, b).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} shows another workspace's rows");
        tx.rollback().await.unwrap();

        let mut tx = TenantTx::begin(&db.pool, a).await.unwrap();
        let n: i64 = sqlx::query_scalar(&count)
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 1, "{table} hides its own workspace's rows");
        tx.rollback().await.unwrap();
    }
}
