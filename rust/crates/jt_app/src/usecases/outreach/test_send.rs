//! A campaign's test email (spec §7.1 `outreach.test_send`): one step rendered as a recipient
//! would get it, sent **to the calling member's own login address only**, through the path
//! every outreach email takes (`replies::enqueue_in`), so it carries the footer and the
//! one-click unsubscribe (D62) and meets the inbox fence.
//!
//! - **Locked** like every send: refused while the platform switch `JEETA_OUTREACH_ENABLED` is
//!   off, and without the footer's sender identity (`launch_fence`: F2, then F10); the claim
//!   checks the switch again.
//! - **Whom**: the member the caller acts for (a person, or the member who issued an agent's
//!   key), at the login address of their membership here; a `to` naming any other address is
//!   refused (`FORBIDDEN not_a_members_login_address`), and so is a recipient that is not that
//!   address when the email is queued or claimed.
//! - **As whom in the inbox**: the inbox person holding that address, or one made for it without
//!   a journey (so no funnel, owner or report counts it). The email rests on the member's own
//!   request (basis `consent`, D72); a suppression of the address (the member unsubscribed from
//!   an earlier test) still refuses it. No consent row is written (nothing for İYS).
//! - **What**: the step's snapshot (a draft's template as it is now), the member's name as the
//!   recipient's, the sender's values, and `[variable]` for any other value it lacks; links are
//!   not rewritten. No journey event is recorded for it.

use jt_inbox::{IdentityChannel, MessageId, PersonId, SendIntent, Source};
use jt_outreach::{CampaignId, RenderError, RenderVars, StepSnapshot, launch_fence, render_body};
use jt_tenancy::{Email, MembershipStatus, Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::campaigns::no_such_campaign;
use super::{fenced, outreach_policy, record, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::usecases::inbox::people::{CreateInput, IdentityInput, match_or_create_with};
use crate::usecases::inbox::replies::{self, Enqueued, Purpose, ReplyInput, Target, TestSend};
use crate::usecases::{Deps, acting_user};

/// `jeeta.outreach.test_send`'s input: the step (1 unless given) and, optionally, the address,
/// which must be the caller's own login address.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestSendInput {
    #[serde(default)]
    pub step: Option<u8>,
    #[serde(default)]
    pub to: Option<String>,
}

/// What a test email did: the address, the step, its message and its outbox state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TestSendOut {
    pub to: String,
    pub step: u8,
    pub message_id: MessageId,
    pub state: String,
}

fn not_the_members_address() -> AppError {
    refused(
        ErrorCode::Forbidden,
        "not_a_members_login_address",
        "a test email goes to your own login address only",
        json!({}),
    )
}

/// The login address of member `user` of the workspace (an active membership), lowercased.
pub(crate) async fn login_address(
    r: &mut dyn TenantRepos,
    user: UserId,
) -> Result<Option<(String, Option<String>)>, AppError> {
    Ok(r.memberships()
        .list()
        .await?
        .into_iter()
        .find(|m| m.user_id == Some(user) && m.status == MembershipStatus::Active)
        .map(|m| (m.email.as_str().to_lowercase(), m.display_name)))
}

/// A test's subject and text: the step with the member as the recipient and the sender's
/// values; a variable left without a value or a fallback reads `[key]`.
fn render_test(
    snapshot: &StepSnapshot,
    member: &str,
    sender_name: &str,
    sender_company: &str,
) -> Result<jt_outreach::Rendered, AppError> {
    let mut v = RenderVars::default();
    let mut put = |k: &str, value: &str| {
        if !value.trim().is_empty() {
            v.values.insert(k.to_owned(), value.to_owned());
        }
    };
    put("contact_name", member);
    put(
        "first_name",
        member.split_whitespace().next().unwrap_or_default(),
    );
    put("sender_name", sender_name);
    put("sender_company", sender_company);
    // Each missing value is named once; a step has at most a few dozen variables.
    for _ in 0..=64 {
        match render_body(snapshot, &v, None) {
            Ok(rendered) => return Ok(rendered),
            Err(RenderError::MissingVariable(key)) => {
                v.values.insert(key.clone(), format!("[{key}]"));
            }
            Err(e) => {
                return Err(AppError::validation(
                    format!("step: {e}"),
                    json!({ "field": "step", "reason": e.to_string() }),
                ));
            }
        }
    }
    Err(AppError::internal("a step names too many variables"))
}

/// `jeeta.outreach.test_send` (see the module docs). Needs `outreach.work`.
pub async fn test_send(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
    input: TestSendInput,
) -> Result<TestSendOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let Some(user) = acting_user(&ctx.actor) else {
        return Err(refused(
            ErrorCode::Forbidden,
            "members_only",
            "a test email goes to a member",
            json!({}),
        ));
    };
    let (policy, campaign, member) = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let policy = outreach_policy(r.as_mut()).await?;
        let campaign = r
            .outreach_campaigns()
            .get(id)
            .await?
            .ok_or_else(no_such_campaign)?;
        (policy, campaign, login_address(r.as_mut(), user).await?)
    };
    launch_fence(
        deps.apps.outreach_enabled(),
        policy.sender_identity_complete(),
    )
    .map_err(fenced)?;
    let Some((login, member_name)) = member else {
        return Err(not_the_members_address());
    };
    if let Some(to) = input.to.as_deref()
        && Email::parse(to).map(|e| e.as_str().to_owned()).ok() != Some(login.clone())
    {
        return Err(not_the_members_address());
    }
    let step = input.step.unwrap_or(1);
    let Some(s) = campaign
        .definition
        .steps
        .get(usize::from(step).wrapping_sub(1))
    else {
        return Err(AppError::validation(
            "step: not_a_step",
            json!({ "field": "step", "reason": "not_a_step" }),
        ));
    };
    let template_id = s.template_id;
    let mut snapshot = s.snapshot.clone();
    let sender = {
        let mut c = ctx.clone();
        c.permissions.insert(Permission::InboxWork);
        c
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if snapshot.is_none() {
        let t = r
            .outreach_templates()
            .get(template_id)
            .await?
            .ok_or_else(|| AppError::not_found("no such template"))?
            .template;
        let facts = jt_outreach::validate_template(&t.subject, &t.body)
            .map_err(|_| AppError::internal("a stored template no longer parses"))?;
        snapshot = Some(StepSnapshot {
            template_revision: t.revision,
            subject: t.subject,
            body: t.body,
            links: facts.links,
            language: t.language,
        });
    }
    let snapshot = snapshot.ok_or_else(|| AppError::internal("a step without a snapshot"))?;
    let name = member_name.unwrap_or_default();
    let rendered = render_test(
        &snapshot,
        &name,
        &campaign.definition.sender_name,
        &policy.sender_company,
    )?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let person: PersonId = match r
        .people()
        .find_by_identity(IdentityChannel::Email, &login)
        .await?
    {
        Some(p) => p.id,
        None => {
            match_or_create_with(
                deps,
                &sender,
                r.as_mut(),
                CreateInput {
                    display_name: if name.trim().is_empty() {
                        login.clone()
                    } else {
                        name.clone()
                    },
                    identities: vec![IdentityInput {
                        channel: IdentityChannel::Email,
                        value: login.clone(),
                        capability_id: None,
                    }],
                    source: Source::Channel(jt_inbox::Channel::Email),
                },
                None,
                None,
                false,
            )
            .await?
            .person
            .id
        }
    };
    let test = TestSend {
        to: login.clone(),
        user_id: user,
        campaign_id: id,
        step,
        from_name: campaign.definition.sender_name.clone(),
        language: snapshot.language,
    };
    let queued = replies::enqueue_in(
        deps,
        &sender,
        r.as_mut(),
        Target::PersonVia(person, campaign.mailbox_id),
        ReplyInput {
            text: rendered.text,
            intent: SendIntent::Commercial,
            request_key: None,
            subject: Some(rendered.subject),
            in_reply_to: None,
            references: Vec::new(),
            item_id: None,
            visibility: None,
            // A test shows what recipients get: no file (spec D12).
            attachments: Vec::new(),
        },
        Purpose::TestSend(&test),
    )
    .await;
    let outbox = match queued {
        Ok(Enqueued::New(outbox)) => outbox,
        Ok(Enqueued::Existing(_)) => return Err(AppError::internal("a test email has no key")),
        Err(e) => {
            // A refusal is ledgered in the bundle (`inbox.send.refused`); keep it.
            if e.code == ErrorCode::Forbidden {
                r.commit().await?;
            }
            return Err(e);
        }
    };
    record(
        r.as_mut(),
        ctx,
        "outreach.test_sent",
        "outreach_campaign",
        id,
        json!({ "campaign_id": id, "step": step }),
    )
    .await?;
    r.commit().await?;
    let out = replies::send_step(deps, &sender, outbox).await?;
    Ok(TestSendOut {
        to: login,
        step,
        message_id: out.message_id,
        state: out.state,
    })
}

/// The claim's check of a test email (from the intent's `outreach_test {user_id, to}` and its
/// `mail.to`): the platform switch on, and the address still the login address of that member.
/// `Err` with the refusal's key.
pub(crate) async fn claim_check(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    test: &Value,
    mail_to: Option<&str>,
) -> Result<Result<(), String>, AppError> {
    if !deps.apps.outreach_enabled() {
        return Ok(Err(
            jt_outreach::OutreachRefusal::OutreachDisabledOnPlatform
                .key()
                .to_owned(),
        ));
    }
    let user = test
        .get("user_id")
        .and_then(|v| serde_json::from_value::<UserId>(v.clone()).ok());
    let login = match user {
        Some(user) => login_address(r, user).await?.map(|(login, _)| login),
        None => None,
    };
    let to = mail_to.map(str::to_lowercase);
    Ok(if login.is_some() && login == to {
        Ok(())
    } else {
        Err("not_a_members_login_address".to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_values_read_as_their_variable() {
        let s = StepSnapshot {
            template_revision: 1,
            subject: "Merhaba {{company}}".into(),
            body: "{{first_name}}, {{custom.opener}} {{city|şehriniz}}".into(),
            links: vec![],
            language: jt_outreach::Lang::Tr,
        };
        let out = render_test(&s, "Ada Yılmaz", "Acme Satış", "Acme").unwrap();
        assert_eq!(out.subject, "Merhaba [company]");
        assert_eq!(out.text, "Ada, [custom.opener] şehriniz");
    }
}
