//! Cold email stays locked (owner rule; spec 2026-10-30-leads-pool-outreach-design.md D17, D24,
//! D53): with the platform switch `JEETA_OUTREACH_ENABLED` off, every path that could send
//! outreach email refuses. One file, so a path added later is added here.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::outreach::{self, ApproveInput, ControlAction, ControlInput};
use jt_outreach::CampaignStatus;
use outreach_support::*;
use serde_json::json;
use support::*;

#[tokio::test]
async fn launch_refused_when_platform_disabled() {
    let mut o = outreach_world().await;
    platform(&mut o.w, false);
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    // Whoever launches, the switch is checked first: before the sender identity, before approval.
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"sender_company": ""})).unwrap(),
    )
    .await
    .unwrap();
    for ctx in [w.owner_ctx.clone(), w.agent(&["outreach.work"]).await] {
        let e = err(launch(w, &ctx, c.campaign.id, 1).await);
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    }
    let stored = outreach::campaigns_get(&w.deps, &w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(stored.campaign.status, CampaignStatus::Draft);
    assert!(w.entries("outreach.campaign_launched").is_empty());
}

#[tokio::test]
async fn resume_and_approval_refused_when_platform_disabled() {
    let mut o = outreach_world().await;
    let t = template(&o.w, &o.w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        &o.w,
        &o.w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    let id = c.campaign.id;
    launch(&o.w, &o.w.owner_ctx, id, 1).await.unwrap();
    outreach::campaigns_control(
        &o.w.deps,
        &o.w.owner_ctx,
        id,
        ControlInput {
            action: ControlAction::Pause,
        },
    )
    .await
    .unwrap();
    // A second campaign waits for approval when the switch goes off.
    outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        serde_json::from_value(json!({"requires_approval": true})).unwrap(),
    )
    .await
    .unwrap();
    let agent = o.w.agent(&["outreach.work"]).await;
    let waiting = campaign(
        &o.w,
        &agent,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    launch(&o.w, &agent, waiting.campaign.id, 1).await.unwrap();
    platform(&mut o.w, false);
    let w = &o.w;
    let e = err(outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        id,
        ControlInput {
            action: ControlAction::Resume,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    let e = err(outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        waiting.campaign.id,
        ApproveInput {
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "outreach_disabled_on_platform");
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(
        r.outreach_campaigns()
            .get(id)
            .await
            .unwrap()
            .unwrap()
            .status,
        CampaignStatus::Paused
    );
    assert_eq!(
        r.outreach_campaigns()
            .get(waiting.campaign.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        CampaignStatus::AwaitingApproval
    );
}
