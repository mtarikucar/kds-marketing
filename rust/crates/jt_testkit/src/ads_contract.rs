//! The ad campaign store (`ads_campaigns`), the same for the PostgreSQL and the in-memory
//! repository: a campaign is stored at its next revision or not at all, the open ones are
//! listed by start time and the closed ones newest first, 50 a page, the closed ones that still
//! wind down at the provider are found, and a workspace sees and writes only its own.
use crate::fakes::FIXED_NOW;
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, ads::*},
};
use jt_tenancy::{UserId, WorkspaceId};
use time::Duration;
use uuid::Uuid;

fn campaign(ws: WorkspaceId, start_minutes: i64) -> AdCampaign {
    AdCampaign {
        id: Uuid::now_v7(),
        workspace_id: ws,
        revision: 1,
        title: "Campaign".into(),
        goal: "A goal".into(),
        budget_minor: 1_000,
        currency: "TRY".into(),
        start_at: FIXED_NOW + Duration::minutes(start_minutes),
        end_at: None,
        account_hint: None,
        opened_by: CampaignOpenedBy::Human {
            user: UserId::new_v7(),
        },
        approval: None,
        declined: None,
        reason: None,
        claim: None,
        refused: 0,
        refusal: None,
        plan: None,
        built: None,
        moves: Vec::new(),
        stop: None,
        ended: None,
        results: Vec::new(),
        recorded_spend_minor: 0,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        state: None,
        totals: None,
    }
}

/// `other` is another workspace.
pub async fn exercise(uow: &dyn UnitOfWork, ws: WorkspaceId, other: WorkspaceId) {
    let mut r = uow.tenant(ws).await.unwrap();
    assert!(
        r.ads()
            .list_campaigns(CampaignScope::Open, None)
            .await
            .unwrap()
            .is_empty()
    );
    // Open campaigns by start time, whatever order they were stored in.
    let (late, early) = (campaign(ws, 30), campaign(ws, 10));
    for c in [&late, &early] {
        r.ads().save_campaign(c.clone(), None, None).await.unwrap();
    }
    let open = r
        .ads()
        .list_campaigns(CampaignScope::Open, None)
        .await
        .unwrap();
    assert_eq!(
        open.iter().map(|c| c.id).collect::<Vec<_>>(),
        [early.id, late.id]
    );
    assert_eq!(
        r.ads().get_campaign(early.id).await.unwrap(),
        Some(early.clone())
    );
    assert_eq!(
        r.ads().lock_campaign(late.id).await.unwrap(),
        Some(late.clone())
    );
    assert_eq!(r.ads().get_campaign(Uuid::now_v7()).await.unwrap(), None);
    r.commit().await.unwrap();

    // A campaign is stored at its next revision: a taken id, a stale or a skipped revision are
    // refused, each in a transaction of its own (a refused write ends it).
    let mut again = early.clone();
    again.title = "Twice".into();
    let mut stale = early.clone();
    stale.revision = 2;
    let mut skipped = early.clone();
    skipped.revision = 3;
    for (c, expected) in [(again, None), (stale, Some(7)), (skipped, Some(1))] {
        let mut r = uow.tenant(ws).await.unwrap();
        let e = r.ads().save_campaign(c, expected, None).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    }
    let mut r = uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.ads().get_campaign(early.id).await.unwrap(),
        Some(early.clone())
    );
    // The projections of an answer are not stored.
    let mut next = early.clone().present(FIXED_NOW);
    next.revision = 2;
    next.title = "Renamed".into();
    r.ads().save_campaign(next, Some(1), None).await.unwrap();
    let stored = r.ads().get_campaign(early.id).await.unwrap().unwrap();
    assert_eq!((stored.revision, stored.title.as_str()), (2, "Renamed"));
    assert_eq!((stored.state, stored.totals), (None, None));

    // Closed campaigns leave the open list and are listed newest first, 50 a page and one more
    // to say there is another page.
    for n in 0..52 {
        let c = campaign(ws, 100 + n);
        r.ads()
            .save_campaign(c, None, Some(FIXED_NOW + Duration::minutes(n)))
            .await
            .unwrap();
    }
    let mut closing = late.clone();
    closing.revision = 2;
    r.ads()
        .save_campaign(closing, Some(1), Some(FIXED_NOW + Duration::hours(5)))
        .await
        .unwrap();
    let open = r
        .ads()
        .list_campaigns(CampaignScope::Open, None)
        .await
        .unwrap();
    assert_eq!(open.iter().map(|c| c.id).collect::<Vec<_>>(), [early.id]);
    let closed = r
        .ads()
        .list_campaigns(CampaignScope::Closed, None)
        .await
        .unwrap();
    assert_eq!(closed.len(), 51);
    assert_eq!(closed[0].id, late.id);
    let rest = r
        .ads()
        .list_campaigns(
            CampaignScope::Closed,
            Some(FIXED_NOW + Duration::minutes(2)),
        )
        .await
        .unwrap();
    assert_eq!(rest.len(), 2, "those closed before the cursor");

    // The closed campaigns the watch still follows: activated at the provider, and either
    // closed after `since` or not confirmed paused there. Never one that was not activated.
    let built = |activated: bool, paused: bool| Built {
        account: jt_capability::CapabilityId::new_v7(),
        campaign_id: Some("c".into()),
        adset_id: None,
        form_id: None,
        ads: Vec::new(),
        activated_at: activated.then_some(FIXED_NOW),
        failed: None,
        watched_at: None,
        provider_paused: paused,
    };
    let mut ids = Vec::new();
    for (n, (activated, paused, closed_hours)) in [
        (true, false, 1),   // old, still running there: followed
        (true, true, 1),    // old and quiet: left alone
        (true, true, 20),   // quiet, closed lately: still read
        (false, false, 21), // never activated: nothing to follow
    ]
    .into_iter()
    .enumerate()
    {
        let mut c = campaign(ws, 500 + n as i64);
        c.built = Some(built(activated, paused));
        ids.push(c.id);
        r.ads()
            .save_campaign(c, None, Some(FIXED_NOW + Duration::hours(closed_hours)))
            .await
            .unwrap();
    }
    let winding = r
        .ads()
        .list_winding_down(FIXED_NOW + Duration::hours(10))
        .await
        .unwrap();
    assert_eq!(
        winding.iter().map(|c| c.id).collect::<Vec<_>>(),
        [ids[0], ids[2]],
        "the ones closed first first"
    );
    r.commit().await.unwrap();

    // Another workspace sees none of it and cannot write into it.
    let mut o = uow.tenant(other).await.unwrap();
    assert_eq!(o.ads().get_campaign(early.id).await.unwrap(), None);
    assert!(
        o.ads()
            .list_campaigns(CampaignScope::Closed, None)
            .await
            .unwrap()
            .is_empty()
    );
    let e = o
        .ads()
        .save_campaign(campaign(ws, 0), None, None)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal, "{e:?}");
}
