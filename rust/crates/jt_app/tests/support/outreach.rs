//! The outreach tests' world (spec 2026-10-30-leads-pool-outreach-design.md §3.10–§3.14): the
//! active workspace "Acme" with an approved strategy, a verified mailbox the scripted mail
//! connector answers for, the footer's sender identity configured, and people to reach. Included
//! with `#[path = "support/outreach.rs"] mod outreach_support;` after `mod support;`.

#![allow(dead_code)]

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{MailMessage, SendReceipt};
use jt_app::usecases::inbox::{consent, people};
use jt_app::usecases::outreach::{self, CampaignOut, CampaignSaveInput, TemplateSaveInput};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_inbox::PersonId;
use jt_outreach::{CampaignId, Definition, TemplateId};
use jt_testkit::fakes::{ConnectorCall, FakeAppConfig, ScriptedConnector, ScriptedRegistry};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;

use crate::support::{World, sender_identity, world};

/// The mailbox's sending address.
pub const FROM: &str = "satis@acme.example.invalid";

pub struct Outreach {
    pub w: World,
    pub mailbox: CapabilityId,
    pub mail: Arc<ScriptedConnector>,
    /// NetGSM's scripted adapter: İYS lookups (`ConsentSync::search`).
    pub netgsm: Arc<ScriptedConnector>,
}

/// The platform switch `JEETA_OUTREACH_ENABLED` of `w`.
pub fn platform(w: &mut World, on: bool) {
    w.deps.apps = Arc::new(FakeAppConfig {
        outreach_enabled: on,
        ..FakeAppConfig::default()
    });
}

/// A verified mailbox capability sending from `from`, sealed, added to `w`.
pub async fn add_mailbox(
    w: &World,
    name: &str,
    from: &str,
    requires_human_approval: bool,
) -> CapabilityId {
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "mailbox".into(),
            name: name.into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    cap.external_id = Some(from.into());
    cap.policy.requires_human_approval = requires_human_approval;
    let cred = Credential::Mailbox {
        smtp_host: "smtp.example.invalid".into(),
        smtp_port: 465,
        imap_host: "imap.example.invalid".into(),
        imap_port: 993,
        username: from.into(),
        password: "private-mail".into(),
        from_address: from.into(),
        tls: jt_connector::MailTls::Implicit,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    id
}

/// The outreach world: an active workspace with an approved strategy, one verified mailbox,
/// the sender identity configured and the platform switch on (`platform(.., false)` locks it).
pub async fn outreach_world() -> Outreach {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let mail = Arc::new(ScriptedConnector::new(Provider::Mail));
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(mail.clone())
            .with_connector(netgsm.clone()),
    );
    platform(&mut w, true);
    sender_identity(&w).await;
    let mailbox = add_mailbox(&w, "Satış", FROM, false).await;
    Outreach {
        w,
        mailbox,
        mail,
        netgsm,
    }
}

/// A NetGSM SMS line with an İYS slot (brand `brand-42`): the workspace's İYS capability.
pub async fn add_iys(o: &Outreach) {
    let w = &o.w;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "Hat".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    let cred = Credential::NetgsmSms {
        usercode: "user".into(),
        password: "private-sms".into(),
        msgheader: "ACME".into(),
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    jt_app::usecases::connector::set_credentials(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({"capability_id": id, "credential": {
            "kind": "netgsm_iys", "usercode": "user", "password": "iys-secret", "brand_code": "brand-42",
        }}))
        .unwrap(),
    )
    .await
    .unwrap();
}

/// The owner opens the business-recipient basis on email, the counsel's confirmation recorded,
/// without the İYS lookup unless `iys`.
pub async fn open_b2b(w: &World, iys: bool) {
    outreach::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "b2b_basis": ["email"], "require_iys_lookup": iys,
            "legal_ack": {"counsel_confirmed": true, "note": "Avukat görüşü"},
        }))
        .unwrap(),
    )
    .await
    .unwrap();
}

/// `person` is a business recipient.
pub async fn business(w: &World, person: PersonId) {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.people()
        .set_recipient_kind(person, jt_inbox::RecipientKind::Business, w.owner_ctx.now)
        .await
        .unwrap();
    r.commit().await.unwrap();
}

/// A draft of `definition` saved and launched by the owner: running, its audience enrolled.
pub async fn running(o: &Outreach, definition: Definition) -> CampaignOut {
    let c = campaign(&o.w, &o.w.owner_ctx, o.mailbox, definition).await;
    launch(&o.w, &o.w.owner_ctx, c.campaign.id, 1)
        .await
        .unwrap()
}

/// One run of the `outreach_dispatch` job at `now`.
pub async fn dispatch(w: &World, now: time::OffsetDateTime) -> jt_app::usecases::jobs::JobReport {
    jt_app::usecases::jobs::run_outreach_dispatch(&w.deps, now).await
}

/// The enrollments of campaign `id`, oldest id first.
pub fn enrollments(w: &World, id: CampaignId) -> Vec<jt_app::ports::outreach::EnrollmentRow> {
    let mut rows: Vec<_> = w
        .uow
        .snapshot()
        .outreach
        .enrollments
        .into_iter()
        .filter(|(_, e)| e.campaign_id == id)
        .map(|(_, e)| e)
        .collect();
    rows.sort_by_key(|e| e.id);
    rows
}

/// The outreach send rows, in creation order.
pub fn sends(w: &World) -> Vec<jt_app::ports::outreach::SendRow> {
    w.uow
        .snapshot()
        .outreach
        .sends
        .into_iter()
        .map(|(_, s)| s)
        .collect()
}

/// A person with one email identity, created by the owner from a form.
pub async fn person(w: &World, name: &str, email: &str) -> PersonId {
    people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": name,
            "identities": [{"channel": "email", "value": email}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id
}

/// An explicit email consent of `person`, recorded now.
pub async fn consent_email(w: &World, person: PersonId) {
    consent::record_consent(
        &w.deps,
        &w.owner_ctx,
        person,
        serde_json::from_value(json!({
            "channel": "email", "kind": "explicit", "source": "agent",
            "at": w.owner_ctx.now.format(&Rfc3339).unwrap(),
        }))
        .unwrap(),
    )
    .await
    .unwrap();
}

/// A consented person (`ada@example.invalid`).
pub async fn consented(w: &World) -> PersonId {
    let p = person(w, "Ada", "ada@example.invalid").await;
    consent_email(w, p).await;
    p
}

/// A template saved by `ctx`.
pub async fn template(w: &World, ctx: &Ctx, subject: &str, body: &str) -> TemplateId {
    outreach::templates_save(
        &w.deps,
        ctx,
        TemplateSaveInput {
            template_id: None,
            expected_revision: None,
            name: "Tanışma".into(),
            language: jt_outreach::Lang::Tr,
            subject: subject.into(),
            body: body.into(),
            request_key: None,
        },
    )
    .await
    .unwrap()
    .template
    .id
}

/// A one-step definition from `template` reaching `audience`, sending any hour of any day.
pub fn definition(template: TemplateId, audience: Value) -> Definition {
    definition_steps(&[(template, 0)], audience)
}

/// A definition of `steps` (template, delay in days) reaching `audience`.
pub fn definition_steps(steps: &[(TemplateId, u16)], audience: Value) -> Definition {
    let steps: Vec<Value> = steps
        .iter()
        .map(|(t, d)| json!({"template_id": t, "delay_days": d}))
        .collect();
    serde_json::from_value(json!({
        "sender_name": "Acme Satış",
        "steps": steps,
        "audience": audience,
        "schedule": {"window": {"tz": "Europe/Istanbul", "from": 0, "to": 24, "days": [1,2,3,4,5,6,7]}},
        "throttle": {"per_hour": 60, "per_day": 500},
    }))
    .unwrap()
}

/// A new draft campaign of `definition` from `mailbox`, saved by `ctx`.
pub async fn campaign(
    w: &World,
    ctx: &Ctx,
    mailbox: CapabilityId,
    definition: Definition,
) -> CampaignOut {
    outreach::campaigns_save(
        &w.deps,
        ctx,
        CampaignSaveInput {
            campaign_id: None,
            expected_revision: None,
            name: "Ekim tanışma".into(),
            mailbox_id: mailbox,
            definition,
            request_key: None,
        },
    )
    .await
    .unwrap()
}

/// Launches `id` at `revision` as `ctx`.
pub async fn launch(
    w: &World,
    ctx: &Ctx,
    id: CampaignId,
    revision: u32,
) -> Result<CampaignOut, jt_app::error::AppError> {
    outreach::campaigns_launch(
        &w.deps,
        ctx,
        id,
        outreach::LaunchInput {
            expected_revision: revision,
        },
    )
    .await
}

/// A provider's acceptance under `id`.
pub fn accepted(id: &str) -> Result<SendReceipt, ConnectorError> {
    Ok(SendReceipt {
        provider_id: id.into(),
        cost_minor: None,
    })
}

/// The mail that reached the scripted connector, in order.
pub fn sent_mail(c: &ScriptedConnector) -> Vec<MailMessage> {
    c.calls()
        .into_iter()
        .filter_map(|call| match call {
            ConnectorCall::SendMail { message, .. } => Some(message),
            _ => None,
        })
        .collect()
}
