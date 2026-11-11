//! The outreach settings (spec §3.10, §3.12, §3.13; §7.1 `outreach.settings_get`,
//! `settings_set`): the footer's sender identity and privacy notice, approval, warm-up,
//! frequency, click tracking, and the business-recipient basis with its İYS lookup, kept in the
//! workspace's leads policy (`outreach`) and written key by key.
//!
//! **The business-recipient basis stays off unless a human owner opens it** (D17): giving
//! `b2b_basis` channels, or turning `require_iys_lookup` off, needs a person whose role is
//! `owner` and a `legal_ack {counsel_confirmed: true, note}` in the same call; recording a
//! `legal_ack` at all is the owner's. Narrowing (no channels, the lookup on again) needs only
//! `outreach.manage`. Whatever is stored, the basis counts only while the platform switch is on
//! (D53).

use jt_inbox::Channel;
use jt_ledger::Actor;
use jt_outreach::{
    B2B_BASIS_CHANNELS, LegalAck, MAILBOX_DAY_CEILING, MAX_LINK_CHARS, MAX_SENDER_ADDRESS_CHARS,
    MAX_SENDER_COMPANY_CHARS, OutreachPolicy,
};
use jt_tenancy::{Permission, SystemRole};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{outreach_policy, record, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::usecases::{Deps, invalid, nothing_to_change};

/// The longest legal acknowledgement note, in characters.
pub const MAX_LEGAL_NOTE_CHARS: usize = 500;
/// The most days between two outreach emails to one person a workspace may ask for.
pub const MAX_MIN_GAP_DAYS: u16 = 30;
/// The most outreach emails to one person in 30 days a workspace may allow.
pub const MAX_PER_30_DAYS: u16 = 30;
/// The largest daily step of the warm-up.
pub const MAX_WARMUP_STEP: u16 = 100;

/// What `outreach.settings_get` answers: the stored policy (defaults for what was never set),
/// and what counts now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SettingsOut {
    #[serde(flatten)]
    pub policy: OutreachPolicy,
    /// Whether the footer's sender identity and privacy notice are configured (a launch and
    /// every commercial email need them).
    pub sender_identity_complete: bool,
    /// The platform switch `JEETA_OUTREACH_ENABLED`.
    pub platform_enabled: bool,
    /// The channels the business-recipient basis covers now: none while the platform switch is
    /// off or the counsel's confirmation is not recorded.
    pub b2b_channels_in_force: Vec<Channel>,
}

/// A human owner's record that the workspace's counsel confirmed the business-recipient basis.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegalAckInput {
    pub counsel_confirmed: bool,
    /// `1..=MAX_LEGAL_NOTE_CHARS` characters: who confirmed what, when.
    pub note: String,
}

/// The warm-up keys to change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WarmupInput {
    #[serde(default)]
    pub enabled: Option<bool>,
    /// `1..=500`.
    #[serde(default)]
    pub start: Option<u16>,
    /// `0..=100`.
    #[serde(default)]
    pub step: Option<u16>,
    /// `1..=500`, not below `start`.
    #[serde(default)]
    pub max: Option<u16>,
}

/// The frequency keys to change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyInput {
    /// `0..=30`.
    #[serde(default)]
    pub min_gap_days: Option<u16>,
    /// `1..=30`.
    #[serde(default)]
    pub max_per_30_days: Option<u16>,
}

/// `jeeta.outreach.settings_set`'s input: the keys to change, each within its bounds. An empty
/// `sender_company`, `sender_address` or `privacy_notice_url` clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInput {
    #[serde(default)]
    pub requires_approval: Option<bool>,
    /// Messaging channels only (`B2B_BASIS_CHANNELS`); channels need the owner and `legal_ack`.
    #[serde(default)]
    pub b2b_basis: Option<Vec<Channel>>,
    /// Turning it off needs the owner and `legal_ack`.
    #[serde(default)]
    pub require_iys_lookup: Option<bool>,
    #[serde(default)]
    pub legal_ack: Option<LegalAckInput>,
    #[serde(default)]
    pub sender_company: Option<String>,
    #[serde(default)]
    pub sender_address: Option<String>,
    #[serde(default)]
    pub privacy_notice_url: Option<String>,
    #[serde(default)]
    pub warmup: Option<WarmupInput>,
    #[serde(default)]
    pub frequency: Option<FrequencyInput>,
    #[serde(default)]
    pub click_tracking_default: Option<bool>,
}

const FIELDS: &[&str] = &[
    "requires_approval",
    "b2b_basis",
    "require_iys_lookup",
    "legal_ack",
    "sender_company",
    "sender_address",
    "privacy_notice_url",
    "warmup",
    "frequency",
    "click_tracking_default",
];

fn settings_out(deps: &Deps, policy: OutreachPolicy) -> SettingsOut {
    let platform_enabled = deps.apps.outreach_enabled();
    SettingsOut {
        sender_identity_complete: policy.sender_identity_complete(),
        platform_enabled,
        b2b_channels_in_force: if platform_enabled {
            policy.b2b_channels()
        } else {
            Vec::new()
        },
        policy,
    }
}

/// `jeeta.outreach.settings_get`.
pub async fn settings_get(deps: &Deps, ctx: &Ctx) -> Result<SettingsOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = outreach_policy(r.as_mut()).await?;
    Ok(settings_out(deps, policy))
}

/// Whether the caller is a person whose role is `owner`.
fn human_owner(ctx: &Ctx) -> bool {
    matches!(ctx.actor, Actor::Human { .. })
        && ctx.role_key.as_deref() == Some(SystemRole::Owner.key())
}

fn within(field: &str, v: Option<u16>, min: u16, max: u16) -> Result<(), AppError> {
    match v {
        Some(v) if !(min..=max).contains(&v) => {
            Err(invalid(field, &format!("{field} is {min}..={max}")))
        }
        _ => Ok(()),
    }
}

/// A one-line text of `1..=max` characters, or empty (cleared).
fn line_or_empty(field: &str, v: &str, max: usize) -> Result<String, AppError> {
    let t = v.trim();
    if t.chars().any(char::is_control) || t.chars().count() > max {
        return Err(invalid(
            field,
            &format!("{field} is one line of at most {max} characters"),
        ));
    }
    Ok(t.to_owned())
}

/// `jeeta.outreach.settings_set`: stores the keys given and only those (every other key keeps
/// following its default), after checking who may open the business-recipient basis (see the
/// module docs). Ledger `outreach.settings_set {fields}`, and `outreach.b2b_basis_set` when the
/// basis, the İYS lookup or the acknowledgement changed.
pub async fn settings_set(
    deps: &Deps,
    ctx: &Ctx,
    input: SettingsInput,
) -> Result<SettingsOut, AppError> {
    ctx.require(Permission::OutreachManage)?;
    let given = [
        input.requires_approval.is_some(),
        input.b2b_basis.is_some(),
        input.require_iys_lookup.is_some(),
        input.legal_ack.is_some(),
        input.sender_company.is_some(),
        input.sender_address.is_some(),
        input.privacy_notice_url.is_some(),
        input.warmup.is_some(),
        input.frequency.is_some(),
        input.click_tracking_default.is_some(),
    ];
    let changed: Vec<&str> = given
        .into_iter()
        .zip(FIELDS)
        .filter_map(|(g, f)| g.then_some(*f))
        .collect();
    if changed.is_empty() {
        return Err(nothing_to_change(FIELDS));
    }
    // The business-recipient basis: messaging channels only, opened by a human owner with the
    // counsel's confirmation recorded in the same call.
    if let Some(channels) = &input.b2b_basis
        && channels.iter().any(|c| !B2B_BASIS_CHANNELS.contains(c))
    {
        return Err(AppError::validation(
            "the business-recipient basis covers messaging channels only",
            json!({ "field": "b2b_basis", "reason": "channel_not_allowed" }),
        ));
    }
    let widens = input.b2b_basis.as_ref().is_some_and(|c| !c.is_empty())
        || input.require_iys_lookup == Some(false);
    if (widens || input.legal_ack.is_some()) && !human_owner(ctx) {
        return Err(refused(
            ErrorCode::Forbidden,
            "owner_required",
            "only a person whose role is owner opens the business-recipient basis or records the \
             counsel's confirmation",
            json!({}),
        ));
    }
    if let Some(ack) = &input.legal_ack {
        let note = ack.note.trim();
        if note.is_empty() || note.chars().count() > MAX_LEGAL_NOTE_CHARS {
            return Err(AppError::validation(
                "legal_ack.note says who confirmed what",
                json!({ "field": "legal_ack.note", "reason": "length" }),
            ));
        }
    }
    if widens
        && !input
            .legal_ack
            .as_ref()
            .is_some_and(|a| a.counsel_confirmed)
    {
        return Err(AppError::validation(
            "opening the business-recipient basis needs legal_ack {counsel_confirmed: true, note}",
            json!({ "field": "legal_ack", "reason": "counsel_confirmation_required" }),
        ));
    }
    let mut patch = Map::new();
    let mut put = |key: &str, value: Value| {
        patch.insert(key.to_owned(), value);
    };
    if let Some(v) = input.requires_approval {
        put("requires_approval", v.into());
    }
    if let Some(v) = &input.b2b_basis {
        let mut channels: Vec<Channel> = Vec::new();
        for c in v {
            if !channels.contains(c) {
                channels.push(*c);
            }
        }
        put("b2b_basis", serde_json::to_value(channels)?);
    }
    if let Some(v) = input.require_iys_lookup {
        put("require_iys_lookup", v.into());
    }
    if let Some(ack) = &input.legal_ack {
        let Actor::Human { user_id } = ctx.actor else {
            return Err(AppError::internal("the owner is a person"));
        };
        put(
            "legal_ack",
            serde_json::to_value(LegalAck {
                counsel_confirmed: ack.counsel_confirmed,
                note: ack.note.trim().to_owned(),
                by: user_id,
                at: ctx.now,
            })?,
        );
    }
    if let Some(v) = &input.sender_company {
        put(
            "sender_company",
            line_or_empty("sender_company", v, MAX_SENDER_COMPANY_CHARS)?.into(),
        );
    }
    if let Some(v) = &input.sender_address {
        put(
            "sender_address",
            line_or_empty("sender_address", v, MAX_SENDER_ADDRESS_CHARS)?.into(),
        );
    }
    if let Some(v) = &input.privacy_notice_url {
        let url = v.trim();
        if !url.is_empty() {
            let ok = url.chars().count() <= MAX_LINK_CHARS
                && !url.chars().any(char::is_control)
                && url::Url::parse(url).is_ok_and(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.host_str().is_some_and(|h| !h.is_empty())
                });
            if !ok {
                return Err(invalid(
                    "privacy_notice_url",
                    "privacy_notice_url is an http(s) link to the privacy notice",
                ));
            }
        }
        put("privacy_notice_url", url.into());
    }
    if let Some(w) = input.warmup {
        let ceiling = u16::try_from(MAILBOX_DAY_CEILING).unwrap_or(u16::MAX);
        within("warmup.start", w.start, 1, ceiling)?;
        within("warmup.step", w.step, 0, MAX_WARMUP_STEP)?;
        within("warmup.max", w.max, 1, ceiling)?;
        let mut m = Map::new();
        if let Some(v) = w.enabled {
            m.insert("enabled".into(), v.into());
        }
        for (k, v) in [("start", w.start), ("step", w.step), ("max", w.max)] {
            if let Some(v) = v {
                m.insert(k.into(), v.into());
            }
        }
        put("warmup", m.into());
    }
    if let Some(f) = input.frequency {
        within(
            "frequency.min_gap_days",
            f.min_gap_days,
            0,
            MAX_MIN_GAP_DAYS,
        )?;
        within(
            "frequency.max_per_30_days",
            f.max_per_30_days,
            1,
            MAX_PER_30_DAYS,
        )?;
        let mut m = Map::new();
        if let Some(v) = f.min_gap_days {
            m.insert("min_gap_days".into(), v.into());
        }
        if let Some(v) = f.max_per_30_days {
            m.insert("max_per_30_days".into(), v.into());
        }
        put("frequency", m.into());
    }
    if let Some(v) = input.click_tracking_default {
        put("click_tracking_default", v.into());
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let before = outreach_policy(r.as_mut()).await?;
    let leads = r
        .workspace_policy()
        .patch_leads(json!({ "outreach": patch }), ctx.now)
        .await?;
    let policy = leads.outreach;
    // The stored result is checked, not only the keys given (a new start above the stored max).
    if policy.warmup.start > policy.warmup.max {
        return Err(AppError::validation(
            "the warm-up starts at or below its maximum",
            json!({ "field": "warmup.max", "reason": "below_start" }),
        ));
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.settings_set",
        "outreach_settings",
        ctx.workspace_id,
        json!({ "fields": changed }),
    )
    .await?;
    if before.b2b_basis != policy.b2b_basis
        || before.require_iys_lookup != policy.require_iys_lookup
        || input.legal_ack.is_some()
    {
        record(
            r.as_mut(),
            ctx,
            "outreach.b2b_basis_set",
            "outreach_settings",
            ctx.workspace_id,
            json!({
                "channels": policy.b2b_basis,
                "require_iys_lookup": policy.require_iys_lookup,
                "counsel_confirmed": policy.legal_ack.as_ref().map(|a| a.counsel_confirmed),
            }),
        )
        .await?;
    }
    r.commit().await?;
    Ok(settings_out(deps, policy))
}
