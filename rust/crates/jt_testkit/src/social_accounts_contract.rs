//! The social accounts' daily snapshots (`social_account_days`), the same for the PostgreSQL and
//! the in-memory repository: the first read of a day stands, a period is read oldest first, the
//! latest snapshot of each account is found, old ones are forgotten, and a workspace sees and
//! writes only its own.
use crate::fakes::FIXED_NOW;
use jt_app::{
    error::ErrorCode,
    ports::{
        UnitOfWork,
        posts::{AccountDay, AccountNumbers},
    },
};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use time::{Date, macros::date};

fn snapshot(ws: WorkspaceId, account: CapabilityId, day: Date, followers: i64) -> AccountDay {
    AccountDay {
        workspace_id: ws,
        capability_id: account,
        day,
        numbers: AccountNumbers {
            followers: Some(followers),
            ..Default::default()
        },
        raw: [("followers_count".to_owned(), followers)].into(),
        read_at: FIXED_NOW,
    }
}

/// `first` and `second` are two accounts of `ws`; `foreign` is an account of `other`, another
/// workspace.
pub async fn exercise(
    uow: &dyn UnitOfWork,
    ws: WorkspaceId,
    [first, second]: [CapabilityId; 2],
    other: WorkspaceId,
    foreign: CapabilityId,
) {
    let mut r = uow.tenant(ws).await.unwrap();
    assert!(
        r.studio_posts()
            .latest_account_days()
            .await
            .unwrap()
            .is_empty()
    );

    // One snapshot per account and day: the first stands, the second read of the day is not
    // stored and changes nothing.
    let d1 = date!(2026 - 10 - 20);
    let d2 = date!(2026 - 10 - 21);
    let d3 = date!(2026 - 10 - 22);
    let stored = snapshot(ws, first, d2, 120);
    assert!(
        r.studio_posts()
            .insert_account_day(stored.clone())
            .await
            .unwrap()
    );
    assert!(
        !r.studio_posts()
            .insert_account_day(snapshot(ws, first, d2, 999))
            .await
            .unwrap()
    );
    for day in [snapshot(ws, first, d1, 110), snapshot(ws, first, d3, 130)] {
        assert!(r.studio_posts().insert_account_day(day).await.unwrap());
    }
    assert!(
        r.studio_posts()
            .insert_account_day(snapshot(ws, second, d1, 7))
            .await
            .unwrap()
    );
    // A snapshot is whole: the numbers with their gaps and the raw counters come back as stored.
    let days = r.studio_posts().account_days(first, d1, d3).await.unwrap();
    assert_eq!(days.iter().map(|d| d.day).collect::<Vec<_>>(), [d1, d2, d3]);
    assert_eq!(days[1], stored);
    assert_eq!(days[1].numbers.reach, None);
    // The period's ends are included; nothing outside it and nothing of another account.
    let days = r.studio_posts().account_days(first, d2, d2).await.unwrap();
    assert_eq!(days, std::slice::from_ref(&stored));
    assert!(
        r.studio_posts()
            .account_days(first, date!(2026 - 11 - 01), date!(2026 - 11 - 30))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        r.studio_posts()
            .account_days(second, d1, d3)
            .await
            .unwrap()
            .len(),
        1
    );
    // The latest of each account.
    let mut latest = r.studio_posts().latest_account_days().await.unwrap();
    latest.sort_by_key(|d| d.day);
    assert_eq!(
        latest
            .iter()
            .map(|d| (d.capability_id, d.day))
            .collect::<Vec<_>>(),
        [(second, d1), (first, d3)]
    );

    r.commit().await.unwrap();

    // A snapshot of another workspace, or of an account that is not this workspace's, is refused
    // (each in a transaction of its own: a refused write ends it).
    for refused in [snapshot(other, first, d3, 1), snapshot(ws, foreign, d3, 1)] {
        let mut r = uow.tenant(ws).await.unwrap();
        let e = r
            .studio_posts()
            .insert_account_day(refused)
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal, "{e:?}");
    }

    // The other workspace sees none of it, and its purge takes none of it.
    let mut o = uow.tenant(other).await.unwrap();
    assert!(
        o.studio_posts()
            .latest_account_days()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        o.studio_posts()
            .account_days(first, d1, d3)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        o.studio_posts()
            .insert_account_day(snapshot(other, foreign, d1, 5))
            .await
            .unwrap()
    );
    assert_eq!(
        o.studio_posts()
            .purge_account_days(date!(2027 - 01 - 01))
            .await
            .unwrap(),
        1
    );
    o.commit().await.unwrap();

    // Forgetting: the days before the given one go, that day and the later ones stay.
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(r.studio_posts().purge_account_days(d2).await.unwrap(), 2);
    assert_eq!(r.studio_posts().purge_account_days(d2).await.unwrap(), 0);
    let days = r.studio_posts().account_days(first, d1, d3).await.unwrap();
    assert_eq!(days.iter().map(|d| d.day).collect::<Vec<_>>(), [d2, d3]);
    assert!(
        r.studio_posts()
            .account_days(second, d1, d3)
            .await
            .unwrap()
            .is_empty()
    );
    r.commit().await.unwrap();
}
