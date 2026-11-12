//! Outreach templates, campaigns, approval and settings (plan L4-T4; spec
//! 2026-10-30-leads-pool-outreach-design.md §3.10, §3.13, D17, D19, D24).

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::outreach::{
    self, ApproveInput, CampaignSaveInput, ControlAction, ControlInput, PreviewInput,
    SettingsInput, TemplateSaveInput,
};
use jt_outreach::{CampaignStatus, Lang};
use outreach_support::*;
use serde_json::json;
use support::*;

fn settings(v: serde_json::Value) -> SettingsInput {
    serde_json::from_value(v).unwrap()
}

fn save_template_input(
    id: Option<jt_outreach::TemplateId>,
    revision: Option<u32>,
    subject: &str,
    body: &str,
) -> TemplateSaveInput {
    TemplateSaveInput {
        template_id: id,
        expected_revision: revision,
        name: "Tanışma".into(),
        language: Lang::Tr,
        subject: subject.into(),
        body: body.into(),
        request_key: None,
    }
}

#[tokio::test]
async fn template_save_validates_and_versions() {
    let o = outreach_world().await;
    let w = &o.w;
    let saved = outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(
            None,
            None,
            "Merhaba {{company|}}",
            "Selam, https://acme.example.invalid/teklif",
        ),
    )
    .await;
    let e = err(saved);
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details["field"], "subject");
    let e = err(outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(None, None, "Merhaba", "{{unknown_var}} selam"),
    )
    .await);
    assert_eq!(e.details["reason"], "unknown_variable");
    assert_eq!(e.details["name"], "unknown_var");
    let first = outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(
            None,
            None,
            "Merhaba {{company|işletmeniz}}",
            "Selam {{contact_name|}}, https://acme.example.invalid/teklif",
        ),
    )
    .await;
    // An empty fallback is a grammar error, not a blank value.
    assert_eq!(err(first).code, ErrorCode::Validation);
    let first = outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(
            None,
            None,
            "Merhaba {{company|işletmeniz}}",
            "Selam {{custom.opener}}. Teklif: https://acme.example.invalid/teklif.",
        ),
    )
    .await
    .unwrap();
    assert_eq!(first.template.revision, 1);
    assert_eq!(first.facts.links, ["https://acme.example.invalid/teklif"]);
    let id = first.template.id;
    let next = outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(Some(id), Some(1), "Merhaba", "Yeni metin"),
    )
    .await
    .unwrap();
    assert_eq!(next.template.revision, 2);
    let e = err(outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(Some(id), Some(1), "Merhaba", "Bayat"),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "stale_revision");
    assert_eq!(e.details["revision"], 2);
    let archived = outreach::templates_archive(&w.deps, &w.owner_ctx, id)
        .await
        .unwrap();
    assert!(archived.template.archived);
    let e = err(outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(Some(id), Some(2), "Merhaba", "Arşivde"),
    )
    .await);
    assert_eq!(e.details["reason"], "archived");
    let listed = outreach::templates_list(&w.deps, &w.owner_ctx, Default::default())
        .await
        .unwrap();
    assert!(listed.items.is_empty(), "archived templates are hidden");
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(outreach::templates_list(&w.deps, &rep, Default::default()).await),
        "outreach.work",
    );
    // The ledger names ids and revisions, never the text.
    for e in w.ledger("outreach.template") {
        let text = e.payload.to_string();
        assert!(
            !text.contains("Merhaba") && !text.contains("acme.example"),
            "{text}"
        );
    }
}

#[tokio::test]
async fn campaign_save_bumps_revision_and_voids_approval() {
    let o = outreach_world().await;
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    assert_eq!(c.campaign.status, CampaignStatus::Draft);
    assert_eq!(c.campaign.revision, 1);
    // A paused campaign carries an approval of its revision; saving it voids that.
    {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        let mut row = r
            .outreach_campaigns()
            .get(c.campaign.id)
            .await
            .unwrap()
            .unwrap();
        row.status = CampaignStatus::Paused;
        row.pause_reason = Some(jt_outreach::PauseReason::Manual);
        row.launched_at = Some(w.owner_ctx.now);
        row.approval = Some(jt_outreach::Approval {
            revision: 1,
            by: w.owner,
            at: w.owner_ctx.now,
        });
        assert!(r.outreach_campaigns().update(&row, 1).await.unwrap());
        r.commit().await.unwrap();
    }
    let mut d = definition(t, json!({"people": {}}));
    d.steps[0].snapshot = Some(jt_outreach::StepSnapshot {
        template_revision: 9,
        subject: "Sahte".into(),
        body: "Sahte".into(),
        links: vec![],
        language: Lang::Tr,
    });
    let saved = outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: Some(c.campaign.id),
            expected_revision: Some(1),
            name: "Ekim tanışma 2".into(),
            mailbox_id: o.mailbox,
            definition: d,
            request_key: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.campaign.revision, 2);
    assert_eq!(saved.campaign.approval, None, "an edit voids the approval");
    assert_eq!(saved.campaign.status, CampaignStatus::Paused);
    assert!(
        saved.campaign.definition.steps[0].snapshot.is_none(),
        "a save never takes a snapshot from its input"
    );
    let e = err(outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: Some(c.campaign.id),
            expected_revision: Some(1),
            name: "Bayat".into(),
            mailbox_id: o.mailbox,
            definition: definition(t, json!({"people": {}})),
            request_key: None,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "stale_revision");
    assert_eq!(w.entries("outreach.campaign_saved").len(), 2);
}

#[tokio::test]
async fn save_refused_while_running() {
    let o = outreach_world().await;
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    let running = launch(w, &w.owner_ctx, c.campaign.id, 1).await.unwrap();
    assert_eq!(running.campaign.status, CampaignStatus::Running);
    let e = err(outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: Some(c.campaign.id),
            expected_revision: Some(1),
            name: "Değişiklik".into(),
            mailbox_id: o.mailbox,
            definition: definition(t, json!({"people": {}})),
            request_key: None,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "invalid_transition");
    assert_eq!(e.details["from"], "running");
}

#[tokio::test]
async fn mailbox_must_be_a_mailbox() {
    let o = outreach_world().await;
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let sms = w.declare("sms_line", "Hat").await;
    let e = err(outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: None,
            expected_revision: None,
            name: "SMS ile".into(),
            mailbox_id: sms.capability.id,
            definition: definition(t, json!({"people": {}})),
            request_key: None,
        },
    )
    .await);
    assert_invalid(&e, "mailbox_id");
    assert_eq!(e.details["reason"], "not_a_mailbox");
    let e = err(outreach::campaigns_save(
        &w.deps,
        &w.owner_ctx,
        CampaignSaveInput {
            campaign_id: None,
            expected_revision: None,
            name: "Yok".into(),
            mailbox_id: jt_capability::CapabilityId::new_v7(),
            definition: definition(t, json!({"people": {}})),
            request_key: None,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::NotFound);
    // A preview names its mailbox too.
    let e = err(outreach::audience_preview(
        &w.deps,
        &w.owner_ctx,
        PreviewInput {
            audience: serde_json::from_value(json!({"people": {}})).unwrap(),
            mailbox_id: sms.capability.id,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "not_a_mailbox");
}

#[tokio::test]
async fn launch_refused_without_sender_identity() {
    let o = outreach_world().await;
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", "Selam").await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"privacy_notice_url": ""})),
    )
    .await
    .unwrap();
    let e = err(launch(w, &w.owner_ctx, c.campaign.id, 1).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details["reason"], "sender_identity_missing");
    let stored = outreach::campaigns_get(&w.deps, &w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(stored.campaign.status, CampaignStatus::Draft);
}

#[tokio::test]
async fn launch_without_approval_runs() {
    let o = outreach_world().await;
    let w = &o.w;
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    let out = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::Running);
    assert!(!out.approval_required);
    assert_eq!(out.campaign.launched_at, Some(agent.now));
    assert_eq!(w.entries("outreach.campaign_launched").len(), 1);
    // A start ahead schedules it.
    let mut d = definition(t, json!({"people": {}}));
    d.schedule.start_at = Some(days_later(2));
    let c = campaign(w, &agent, o.mailbox, d).await;
    let out = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::Scheduled);
    // A stale revision launches nothing.
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    let e = err(launch(w, &agent, c.campaign.id, 7).await);
    assert_eq!(e.details["reason"], "stale_revision");
}

#[tokio::test]
async fn launch_with_policy_approval_waits() {
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"requires_approval": true})),
    )
    .await
    .unwrap();
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    let out = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::AwaitingApproval);
    assert!(out.approval_required);
    assert_eq!(out.campaign.approval, None);
    assert_eq!(
        out.campaign.launched_at, None,
        "not launched until approved"
    );
    let approved = outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        ApproveInput {
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    assert_eq!(approved.campaign.status, CampaignStatus::Running);
    assert_eq!(approved.campaign.approval.as_ref().unwrap().by, w.owner);
    assert_eq!(w.entries("outreach.campaign_approved").len(), 1);
}

#[tokio::test]
async fn manager_launch_approves_in_one_call() {
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"requires_approval": true})),
    )
    .await
    .unwrap();
    let manager = w.member("manager").await;
    let t = template(w, &manager, "Merhaba", "Selam").await;
    let c = campaign(w, &manager, o.mailbox, definition(t, json!({"people": {}}))).await;
    let out = launch(w, &manager, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::Running);
    let approval = out.campaign.approval.unwrap();
    assert_eq!(approval.revision, 1);
    assert_eq!(
        jt_ledger::Actor::Human {
            user_id: approval.by
        },
        manager.actor
    );
    assert_eq!(w.entries("outreach.campaign_approved").len(), 1);
}

#[tokio::test]
async fn mailbox_requires_human_approval_forces_approval() {
    let o = outreach_world().await;
    let w = &o.w;
    let held = add_mailbox(w, "Onaylı", "onay@acme.example.invalid", true).await;
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, held, definition(t, json!({"people": {}}))).await;
    assert!(c.approval_required);
    let out = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::AwaitingApproval);
}

#[tokio::test]
async fn agent_cannot_approve() {
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"requires_approval": true})),
    )
    .await
    .unwrap();
    let agent = w.agent(&["outreach.work", "outreach.manage"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    // An agent's launch never approves, whatever its scopes.
    let out = launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::AwaitingApproval);
    let e = err(outreach::campaigns_approve(
        &w.deps,
        &agent,
        c.campaign.id,
        ApproveInput {
            expected_revision: 1,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(e.details["reason"], "human_required");
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(outreach::campaigns_approve(
            &w.deps,
            &rep,
            c.campaign.id,
            ApproveInput {
                expected_revision: 1,
            },
        )
        .await),
        "outreach.manage",
    );
}

#[tokio::test]
async fn stale_revision_approval_refused() {
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"requires_approval": true})),
    )
    .await
    .unwrap();
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    launch(w, &agent, c.campaign.id, 1).await.unwrap();
    let e = err(outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        ApproveInput {
            expected_revision: 2,
        },
    )
    .await);
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "stale_revision");
}

#[tokio::test]
async fn resume_after_edit_needs_new_approval() {
    let o = outreach_world().await;
    let w = &o.w;
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"requires_approval": true})),
    )
    .await
    .unwrap();
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    let id = c.campaign.id;
    launch(w, &agent, id, 1).await.unwrap();
    outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        id,
        ApproveInput {
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let control = |action| ControlInput { action };
    let paused = outreach::campaigns_control(&w.deps, &agent, id, control(ControlAction::Pause))
        .await
        .unwrap();
    assert_eq!(paused.campaign.status, CampaignStatus::Paused);
    // Resumed unedited, the approval of revision 1 still holds.
    let resumed = outreach::campaigns_control(&w.deps, &agent, id, control(ControlAction::Resume))
        .await
        .unwrap();
    assert_eq!(resumed.campaign.status, CampaignStatus::Running);
    outreach::campaigns_control(&w.deps, &agent, id, control(ControlAction::Pause))
        .await
        .unwrap();
    outreach::campaigns_save(
        &w.deps,
        &agent,
        CampaignSaveInput {
            campaign_id: Some(id),
            expected_revision: Some(1),
            name: "Düzenlendi".into(),
            mailbox_id: o.mailbox,
            definition: definition(t, json!({"people": {}})),
            request_key: None,
        },
    )
    .await
    .unwrap();
    let resumed = outreach::campaigns_control(&w.deps, &agent, id, control(ControlAction::Resume))
        .await
        .unwrap();
    assert_eq!(resumed.campaign.status, CampaignStatus::AwaitingApproval);
    let approved = outreach::campaigns_approve(
        &w.deps,
        &w.owner_ctx,
        id,
        ApproveInput {
            expected_revision: 2,
        },
    )
    .await
    .unwrap();
    assert_eq!(approved.campaign.status, CampaignStatus::Running);
    assert!(
        approved.campaign.definition.steps[0].snapshot.is_some(),
        "the resume took the edited campaign's snapshots"
    );
}

#[tokio::test]
async fn snapshot_freezes_template_content() {
    let o = outreach_world().await;
    let w = &o.w;
    let t = template(
        w,
        &w.owner_ctx,
        "Merhaba {{company|işletmeniz}}",
        "İlk metin: https://acme.example.invalid/a",
    )
    .await;
    let c = campaign(
        w,
        &w.owner_ctx,
        o.mailbox,
        definition(t, json!({"people": {}})),
    )
    .await;
    let out = launch(w, &w.owner_ctx, c.campaign.id, 1).await.unwrap();
    let snap = out.campaign.definition.steps[0].snapshot.clone().unwrap();
    assert_eq!(snap.template_revision, 1);
    assert_eq!(snap.body, "İlk metin: https://acme.example.invalid/a");
    assert_eq!(snap.links, ["https://acme.example.invalid/a"]);
    assert_eq!(snap.language, Lang::Tr);
    outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        save_template_input(Some(t), Some(1), "Yeni konu", "İkinci metin"),
    )
    .await
    .unwrap();
    let after = outreach::campaigns_get(&w.deps, &w.owner_ctx, c.campaign.id)
        .await
        .unwrap();
    assert_eq!(after.campaign.definition.steps[0].snapshot, Some(snap));
}

#[tokio::test]
async fn cancel_needs_manage() {
    let o = outreach_world().await;
    let w = &o.w;
    let agent = w.agent(&["outreach.work"]).await;
    let t = template(w, &agent, "Merhaba", "Selam").await;
    let c = campaign(w, &agent, o.mailbox, definition(t, json!({"people": {}}))).await;
    launch(w, &agent, c.campaign.id, 1).await.unwrap();
    assert_forbidden(
        &err(outreach::campaigns_control(
            &w.deps,
            &agent,
            c.campaign.id,
            ControlInput {
                action: ControlAction::Cancel,
            },
        )
        .await),
        "outreach.manage",
    );
    let out = outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        ControlInput {
            action: ControlAction::Cancel,
        },
    )
    .await
    .unwrap();
    assert_eq!(out.campaign.status, CampaignStatus::Canceled);
    let e = err(outreach::campaigns_control(
        &w.deps,
        &w.owner_ctx,
        c.campaign.id,
        ControlInput {
            action: ControlAction::Resume,
        },
    )
    .await);
    assert_eq!(e.details["reason"], "invalid_transition");
}

#[tokio::test]
async fn b2b_basis_only_by_human_owner_with_ack() {
    let mut o = outreach_world().await;
    let open = |note: &str, confirmed: bool| {
        settings(
            json!({"b2b_basis": ["email"], "legal_ack": {"counsel_confirmed": confirmed, "note": note}}),
        )
    };
    let manager = o.w.member("manager").await;
    let agent = o.w.agent(&["outreach.work", "outreach.manage"]).await;
    for ctx in [&manager, &agent] {
        let e = err(outreach::settings_set(&o.w.deps, ctx, open("Avukat görüşü", true)).await);
        assert_eq!(e.code, ErrorCode::Forbidden);
        assert_eq!(e.details["reason"], "owner_required");
        let e = err(
            outreach::settings_set(
                &o.w.deps,
                ctx,
                settings(json!({"require_iys_lookup": false, "legal_ack": {"counsel_confirmed": true, "note": "x"}})),
            )
            .await,
        );
        assert_eq!(e.details["reason"], "owner_required");
    }
    let e = err(outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        settings(json!({"b2b_basis": ["email"]})),
    )
    .await);
    assert_invalid(&e, "legal_ack");
    let e =
        err(outreach::settings_set(&o.w.deps, &o.w.owner_ctx, open("Avukat görüşü", false)).await);
    assert_invalid(&e, "legal_ack");
    let e = err(outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        settings(
            json!({"b2b_basis": ["sms"], "legal_ack": {"counsel_confirmed": true, "note": "x"}}),
        ),
    )
    .await);
    assert_eq!(e.details["reason"], "channel_not_allowed");
    let out = outreach::settings_set(
        &o.w.deps,
        &o.w.owner_ctx,
        open("Avukat görüşü 2026-11", true),
    )
    .await
    .unwrap();
    assert_eq!(out.policy.b2b_basis, [jt_inbox::Channel::Email]);
    assert_eq!(out.policy.legal_ack.as_ref().unwrap().by, o.w.owner);
    assert_eq!(out.b2b_channels_in_force, [jt_inbox::Channel::Email]);
    // While the platform switch is off it counts for nothing (D53).
    platform(&mut o.w, false);
    let off = outreach::settings_get(&o.w.deps, &o.w.owner_ctx)
        .await
        .unwrap();
    assert!(off.b2b_channels_in_force.is_empty());
    assert!(!off.platform_enabled);
    // Narrowing needs only outreach.manage.
    let narrowed = outreach::settings_set(&o.w.deps, &manager, settings(json!({"b2b_basis": []})))
        .await
        .unwrap();
    assert!(narrowed.policy.b2b_basis.is_empty());
    let entries = o.w.entries("outreach.b2b_basis_set");
    assert_eq!(entries.len(), 2);
    for e in entries {
        assert!(!e.payload.to_string().contains("Avukat"), "{}", e.payload);
    }
}

#[tokio::test]
async fn settings_bounds_and_the_stored_warmup_are_checked() {
    let o = outreach_world().await;
    let w = &o.w;
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(
            outreach::settings_set(&w.deps, &rep, settings(json!({"requires_approval": true})))
                .await,
        ),
        "outreach.manage",
    );
    let e = err(outreach::settings_set(&w.deps, &w.owner_ctx, settings(json!({}))).await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert!(
        e.details["fields"]
            .as_array()
            .is_some_and(|f| !f.is_empty())
    );
    for (body, field) in [
        (json!({"warmup": {"start": 0}}), "warmup.start"),
        (json!({"warmup": {"max": 501}}), "warmup.max"),
        (
            json!({"frequency": {"max_per_30_days": 0}}),
            "frequency.max_per_30_days",
        ),
        (
            json!({"privacy_notice_url": "javascript:alert(1)"}),
            "privacy_notice_url",
        ),
        (json!({"sender_company": "Satır\nkırık"}), "sender_company"),
    ] {
        assert_invalid(
            &err(outreach::settings_set(&w.deps, &w.owner_ctx, settings(body)).await),
            field,
        );
    }
    // The stored result is checked: a start above the stored maximum (150) is refused, and so
    // nothing of that call is kept.
    let e = err(outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"warmup": {"start": 200}, "requires_approval": true})),
    )
    .await);
    assert_invalid(&e, "warmup.max");
    let kept = outreach::settings_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(!kept.policy.requires_approval);
    assert_eq!(kept.policy.warmup.start, 20);
    let out = outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        settings(json!({"warmup": {"enabled": false}, "frequency": {"min_gap_days": 5}})),
    )
    .await
    .unwrap();
    assert!(!out.policy.warmup.enabled);
    assert_eq!(out.policy.warmup.max, 150, "an unset key keeps its default");
    assert_eq!(out.policy.frequency.min_gap_days, 5);
    assert_eq!(out.policy.frequency.max_per_30_days, 4);
    assert!(out.sender_identity_complete);
}

#[tokio::test]
async fn preview_counts_by_skip_reason_and_basis() {
    let o = outreach_world().await;
    let w = &o.w;
    let consented = consented(w).await;
    let unconsented = person(w, "Bora", "bora@example.invalid").await;
    let suppressed = person(w, "Cem", "cem@example.invalid").await;
    consent_email(w, suppressed).await;
    jt_app::usecases::inbox::consent::add_suppression(
        &w.deps,
        &w.owner_ctx,
        suppressed,
        serde_json::from_value(json!({"channel": "email", "reason": "manual"})).unwrap(),
    )
    .await
    .unwrap();
    let preview = outreach::audience_preview(
        &w.deps,
        &w.owner_ctx,
        PreviewInput {
            audience: serde_json::from_value(
                json!({"explicit": [consented, unconsented, suppressed]}),
            )
            .unwrap(),
            mailbox_id: o.mailbox,
        },
    )
    .await
    .unwrap();
    assert_eq!(preview.eligible, 1);
    assert_eq!(preview.basis.consent, 1);
    assert_eq!(preview.basis.business_recipient, 0);
    assert_eq!(preview.by_skip_reason["no_basis"], 1);
    assert_eq!(preview.by_skip_reason["suppressed"], 1);
    assert!(!preview.business_basis_in_force);
    // The people filter reaches every open journey.
    let all = outreach::audience_preview(
        &w.deps,
        &w.owner_ctx,
        PreviewInput {
            audience: serde_json::from_value(json!({"people": {}})).unwrap(),
            mailbox_id: o.mailbox,
        },
    )
    .await
    .unwrap();
    assert_eq!(all.eligible + all.by_skip_reason.values().sum::<u32>(), 3);
    assert!(w.ledger("outreach.").is_empty(), "a preview writes nothing");
}
