//! The email facts from the inbox side (owner report 2026-11-21): a one-to-one email needs the
//! sender identity and, for a business, the business-recipient basis, but neither the campaigns
//! module nor an outreach permission. Whoever may write to people fills the sender identity in;
//! the basis stays a human owner's act with the counsel's confirmation; every check of a
//! commercial email still holds.

#[path = "support/outreach.rs"]
mod outreach_support;
mod support;

use jt_app::error::ErrorCode;
use jt_app::usecases::inbox::email_settings::{
    EmailSettingsInput, email_settings_get, email_settings_set,
};
use jt_app::usecases::inbox::{consent, replies};
use jt_app::usecases::outreach;
use outreach_support::*;
use serde_json::json;
use support::*;

fn input(v: serde_json::Value) -> EmailSettingsInput {
    serde_json::from_value(v).unwrap()
}

fn send_input(key: &str) -> replies::SendInput {
    serde_json::from_value(json!({
        "channel": "email", "text": "Merhaba, kısa bir tanışma.", "intent": "commercial",
        "request_key": key,
    }))
    .unwrap()
}

/// Clears the sender identity, as a workspace that never entered it.
async fn no_identity(w: &World) {
    email_settings_set(
        &w.deps,
        &w.owner_ctx,
        input(json!({"sender_company": "", "sender_address": "", "privacy_notice_url": ""})),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_member_without_outreach_permissions_fills_the_sender_in_and_writes_one_email() {
    let o = outreach_world().await;
    let w = &o.w;
    no_identity(w).await;
    let rep = w.member("rep").await;
    assert!(
        !rep.permissions
            .contains(&jt_tenancy::Permission::OutreachWork)
    );
    // The campaigns' settings stay the campaigns' permission.
    assert_forbidden(
        &err(outreach::settings_get(&w.deps, &rep).await),
        "outreach.work",
    );
    let read = email_settings_get(&w.deps, &rep).await.unwrap();
    assert!(!read.sender_identity_complete);
    // Without the identity the email is refused, never sent bare.
    let ada = consented(w).await;
    let e = err(replies::send(&w.deps, &rep, ada, send_input("e1")).await);
    assert_eq!(e.message, "sender_identity_missing");
    let saved = email_settings_set(
        &w.deps,
        &rep,
        input(json!({
            "sender_company": "Acme Yazılım A.Ş.",
            "sender_address": "Örnek Mah. Deneme Sk. No 1, İstanbul",
            "privacy_notice_url": "https://acme.example.invalid/kvkk",
        })),
    )
    .await
    .unwrap();
    assert!(saved.sender_identity_complete);
    // The same store the campaigns read.
    let campaigns = outreach::settings_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert!(campaigns.sender_identity_complete);
    assert_eq!(campaigns.policy.sender_company, "Acme Yazılım A.Ş.");
    o.mail.push_mail(accepted("e2"));
    let out = replies::send(&w.deps, &rep, ada, send_input("e2"))
        .await
        .unwrap();
    assert_eq!(out.state, "sent");
    let mail = sent_mail(&o.mail).pop().unwrap();
    assert!(mail.list_unsubscribe.is_some(), "one-click unsubscribe");
    assert!(
        mail.text
            .contains("Acme Yazılım A.Ş. · Örnek Mah. Deneme Sk. No 1, İstanbul"),
        "{}",
        mail.text
    );
    // A suppressed address is refused whoever writes.
    consent::add_suppression(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({"channel": "email", "reason": "manual"})).unwrap(),
    )
    .await
    .unwrap();
    let e = err(replies::send(&w.deps, &rep, ada, send_input("e3")).await);
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert_eq!(sent_mail(&o.mail).len(), 1);
    // The settings writes are on the ledger as before.
    assert!(!w.entries("outreach.settings_set").is_empty());
}

#[tokio::test]
async fn the_business_basis_stays_the_owners_act_with_the_counsels_confirmation() {
    let o = outreach_world().await;
    let w = &o.w;
    let bora = person(w, "Bora", "bora@example.invalid").await;
    business(w, bora).await;
    // No basis: a first email to a business has no permission.
    let e = err(replies::send(&w.deps, &w.owner_ctx, bora, send_input("b1")).await);
    assert_eq!(e.message, "IZIN_YOK");
    let open = json!({
        "b2b_basis": ["email"],
        "legal_ack": {"counsel_confirmed": true, "note": "Avukat görüşü"},
    });
    // A member who may write but not manage cannot touch the basis at all.
    let rep = w.member("rep").await;
    assert_forbidden(
        &err(email_settings_set(&w.deps, &rep, input(open.clone())).await),
        "inbox.manage",
    );
    assert_forbidden(
        &err(email_settings_set(&w.deps, &rep, input(json!({"b2b_basis": []}))).await),
        "inbox.manage",
    );
    // A manager is no owner; an agent never opens it.
    let manager = w.member("manager").await;
    let e = err(email_settings_set(&w.deps, &manager, input(open.clone())).await);
    assert_eq!(e.details["reason"], "owner_required");
    let agent = w.agent(&["inbox.work", "inbox.manage"]).await;
    let e = err(email_settings_set(&w.deps, &agent, input(open.clone())).await);
    assert_eq!(e.details["reason"], "human_only");
    // The owner without the counsel's confirmation is refused.
    let e = err(email_settings_set(
        &w.deps,
        &w.owner_ctx,
        input(json!({"b2b_basis": ["email"]})),
    )
    .await);
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["reason"], "counsel_confirmation_required");
    // With it, the basis counts, and the email goes with the public-data footer.
    let saved = email_settings_set(&w.deps, &w.owner_ctx, input(open))
        .await
        .unwrap();
    assert_eq!(saved.b2b_channels_in_force, vec![jt_inbox::Channel::Email]);
    assert!(saved.legal_ack.is_some());
    o.mail.push_mail(accepted("b2"));
    replies::send(&w.deps, &w.owner_ctx, bora, send_input("b2"))
        .await
        .unwrap();
    assert!(
        sent_mail(&o.mail)[0]
            .text
            .contains("herkese açık iletişim bilgileri"),
        "the business basis's footer line"
    );
    assert_eq!(w.entries("outreach.b2b_basis_set").len(), 1);
    // A manager narrows it again.
    email_settings_set(&w.deps, &manager, input(json!({"b2b_basis": []})))
        .await
        .unwrap();
    let e = err(replies::send(&w.deps, &w.owner_ctx, bora, send_input("b3")).await);
    assert_eq!(e.message, "IZIN_YOK");
}

#[tokio::test]
async fn the_email_settings_take_no_campaign_keys() {
    let o = outreach_world().await;
    let w = &o.w;
    for key in [
        "requires_approval",
        "warmup",
        "frequency",
        "click_tracking_default",
    ] {
        let raw = json!({ key: true });
        assert!(
            serde_json::from_value::<EmailSettingsInput>(raw).is_err(),
            "{key} is the campaigns'"
        );
    }
    // A key outside the bounds is refused as through the campaigns' settings.
    let e = err(email_settings_set(
        &w.deps,
        &w.owner_ctx,
        input(json!({"privacy_notice_url": "ftp://acme.example.invalid"})),
    )
    .await);
    assert_invalid(&e, "privacy_notice_url");
}

#[tokio::test]
async fn only_a_person_changes_the_sender_details_and_replacing_a_value_is_a_managers() {
    use jt_app::usecases::outreach;
    let o = outreach_world().await;
    let w = &o.w;
    let rep = w.member("rep").await;
    // An agent reads them, never writes them, whatever its key holds.
    let agent = w.agent(&["inbox.work", "inbox.manage"]).await;
    assert!(
        email_settings_get(&w.deps, &agent)
            .await
            .unwrap()
            .sender_identity_complete
    );
    for change in [
        json!({"sender_company": "Başka A.Ş."}),
        json!({"sender_address": ""}),
        json!({"privacy_notice_url": "https://acme.example.invalid/yeni"}),
    ] {
        let e = err(email_settings_set(&w.deps, &agent, input(change.clone())).await);
        assert_eq!(e.code, ErrorCode::Forbidden, "{change}");
        assert_eq!(e.details["reason"], "human_only", "{change}");
        // A member who writes to people may not replace or empty a value.
        assert_forbidden(
            &err(email_settings_set(&w.deps, &rep, input(change.clone())).await),
            "inbox.manage",
        );
    }
    let kept = outreach::settings_get(&w.deps, &w.owner_ctx).await.unwrap();
    assert_eq!(kept.policy.sender_company, "Acme Yazılım A.Ş.");
    assert!(kept.sender_identity_complete);
    // The same value again changes nothing anyone may not change.
    email_settings_set(
        &w.deps,
        &rep,
        input(json!({"sender_company": "Acme Yazılım A.Ş."})),
    )
    .await
    .unwrap();
    // An empty field is filled in by the member; a manager replaces a value.
    email_settings_set(&w.deps, &w.owner_ctx, input(json!({"sender_address": ""})))
        .await
        .unwrap();
    email_settings_set(
        &w.deps,
        &rep,
        input(json!({"sender_address": "Deneme Sk. 2, İzmir"})),
    )
    .await
    .unwrap();
    let manager = w.member("manager").await;
    let out = email_settings_set(
        &w.deps,
        &manager,
        input(json!({"sender_address": "Deneme Sk. 3, İzmir"})),
    )
    .await
    .unwrap();
    assert_eq!(out.sender_address, "Deneme Sk. 3, İzmir");
}
