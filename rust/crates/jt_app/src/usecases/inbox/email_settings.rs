//! The email facts a one-to-one commercial email needs, read and written from the inbox side
//! (`inbox.email_settings_get`, `inbox.email_settings_set`): the footer's sender identity
//! (company, postal address, privacy notice link) and the business-recipient basis with its
//! İYS lookup and the owner's record of the counsel's confirmation.
//!
//! They are the same stored facts the campaigns read (the workspace's leads policy,
//! `outreach`): writing one email to a person needs them as much as a campaign does, but it
//! needs neither the campaigns module nor an outreach permission. Whoever may write to people
//! (`inbox.work`) reads them and fills in the sender identity; narrowing the basis needs
//! `inbox.manage`; opening it, or turning the İYS lookup off, stays a human owner's act with the
//! counsel's confirmation in the same call, exactly as through `outreach.settings_set`.

use jt_inbox::Channel;
use jt_outreach::LegalAck;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::usecases::Deps;
use crate::usecases::outreach::settings::{self, LegalAckInput, SettingsInput};

/// What `inbox.email_settings_get` answers: the email facts as stored, and what counts now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EmailSettingsOut {
    pub sender_company: String,
    pub sender_address: String,
    pub privacy_notice_url: String,
    pub b2b_basis: Vec<Channel>,
    pub require_iys_lookup: bool,
    pub legal_ack: Option<LegalAck>,
    /// Whether the sender identity is complete (every commercial email needs it).
    pub sender_identity_complete: bool,
    /// The platform switch `JEETA_OUTREACH_ENABLED`, without which the basis counts nowhere.
    pub platform_enabled: bool,
    /// The channels the business-recipient basis covers now.
    pub b2b_channels_in_force: Vec<Channel>,
}

/// `inbox.email_settings_set`'s input: the keys to change. An empty text clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmailSettingsInput {
    #[serde(default)]
    pub sender_company: Option<String>,
    #[serde(default)]
    pub sender_address: Option<String>,
    #[serde(default)]
    pub privacy_notice_url: Option<String>,
    /// Messaging channels only; giving channels needs a human owner and `legal_ack`.
    #[serde(default)]
    pub b2b_basis: Option<Vec<Channel>>,
    /// Turning it off needs a human owner and `legal_ack`.
    #[serde(default)]
    pub require_iys_lookup: Option<bool>,
    #[serde(default)]
    pub legal_ack: Option<LegalAckInput>,
}

fn out(deps: &Deps, policy: jt_outreach::OutreachPolicy) -> EmailSettingsOut {
    let s = settings::settings_out(deps, policy);
    EmailSettingsOut {
        sender_company: s.policy.sender_company,
        sender_address: s.policy.sender_address,
        privacy_notice_url: s.policy.privacy_notice_url,
        b2b_basis: s.policy.b2b_basis,
        require_iys_lookup: s.policy.require_iys_lookup,
        legal_ack: s.policy.legal_ack,
        sender_identity_complete: s.sender_identity_complete,
        platform_enabled: s.platform_enabled,
        b2b_channels_in_force: s.b2b_channels_in_force,
    }
}

/// `jeeta.inbox.email_settings_get`.
pub async fn email_settings_get(deps: &Deps, ctx: &Ctx) -> Result<EmailSettingsOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = r.workspace_policy().read().await?.leads.outreach;
    Ok(out(deps, policy))
}

/// `jeeta.inbox.email_settings_set`: stores the keys given (the same store and ledger entries
/// as `outreach.settings_set`). The sender identity needs `inbox.work`; any key of the
/// business-recipient basis needs `inbox.manage`, and opening it a human owner with
/// `legal_ack {counsel_confirmed: true, note}` in the same call.
pub async fn email_settings_set(
    deps: &Deps,
    ctx: &Ctx,
    input: EmailSettingsInput,
) -> Result<EmailSettingsOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    if input.b2b_basis.is_some() || input.require_iys_lookup.is_some() || input.legal_ack.is_some()
    {
        ctx.require(Permission::InboxManage)?;
    }
    let EmailSettingsInput {
        sender_company,
        sender_address,
        privacy_notice_url,
        b2b_basis,
        require_iys_lookup,
        legal_ack,
    } = input;
    let policy = settings::apply(
        deps,
        ctx,
        SettingsInput {
            sender_company,
            sender_address,
            privacy_notice_url,
            b2b_basis,
            require_iys_lookup,
            legal_ack,
            ..SettingsInput::default()
        },
    )
    .await?;
    Ok(out(deps, policy))
}
