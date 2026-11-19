//! Kurallar and Hedefler (design §4.6, §4.7): `strategy.rules_save`, `strategy.post_approval_set`
//! and `strategy.goals_save`, the owner's page writes. Each needs `team.manage` (the account
//! switch: `social.manage` or `team.manage`) and a person in person.
//!
//! The rules are the knowledge base's own numbers, kept in its settings: the prohibitions (read
//! live by every agent, never checked by the server), the ad budget's ceiling (`ad_cap`), the paid
//! messages' limit (`message_cap`), and post approval: the workspace switch and the list of
//! accounts whose posts wait while it is off. Changing either cap needs `budget.manage`; switching
//! approval off or taking an account off the list needs the role owner or manager (an agent's key
//! never lowers it).
//!
//! This step stores them. What enforces them comes with the frame engine: the caps mirrored into
//! the frame's lanes and the general ad budget held to `ad_cap`, and the posting paths reading the
//! switch and the list. `rules_save` already takes the locks those need, in the order of design
//! §4.10.13 (the draft, the execution frame, the settings), so they add to it without reordering.
//!
//! Refusals: `VALIDATION` per field, `CONFLICT` `rules_changed` / `goals_changed` (the box moved
//! past `expected_revision`, with its `revision`), `FORBIDDEN` naming `budget.manage`, `FORBIDDEN`
//! `owner_or_manager`, `CONFLICT` `post_approval_all` (an account taken off the list while the
//! switch holds every post), `NOT_FOUND` (an account put into the list that is not a live social
//! account of the workspace; one listed already, retired since, stays and can be taken out).

use std::collections::BTreeSet;

use jt_capability::{CapabilityId, StoredStatus, Unit};
use jt_knowledge::{
    Cap, CapInput, Cause, KnowledgeSettings, MAX_POST_APPROVAL_ACCOUNTS, Subject, validate_cap,
    validate_goals, validate_prohibitions,
};
use jt_strategy::Period;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::{Change, FrameWrite, editor, invalid, lock, person, refused, seed};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::studio::chain::ORGANIC_KINDS;

/// `strategy.rules_save`'s input: the whole box.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulesInput {
    /// The rules' revision as read (`rules.revision`).
    pub expected_revision: u64,
    /// Trimmed, the empty lines dropped.
    pub prohibitions: Vec<String>,
    /// None: no ads ("Reklam yok").
    #[serde(default)]
    pub ad_budget: Option<CapInput>,
    /// None: paid messages have no limit of their own.
    #[serde(default)]
    pub message_budget: Option<CapInput>,
    /// "Her paylaşım onayıma gelsin".
    pub post_approval: bool,
    /// The accounts whose posts wait while the switch is off; none: unchanged.
    #[serde(default)]
    pub post_approval_accounts: Option<Vec<CapabilityId>>,
}

/// `strategy.post_approval_set`'s input: one account into (`required: true`) or out of the list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostApprovalInput {
    pub capability_id: CapabilityId,
    pub required: bool,
    /// The rules' revision as read.
    pub expected_revision: u64,
}

/// `strategy.goals_save`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalsInput {
    /// The goals' revision as read (`goals.revision`).
    pub expected_revision: u64,
    /// Trimmed, the empty lines dropped.
    pub items: Vec<String>,
}

/// The rules as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RulesOut {
    pub revision: u64,
    pub prohibitions: Vec<String>,
    pub ad_cap: Option<Cap>,
    pub message_cap: Option<Cap>,
    pub post_approval: bool,
    pub post_approval_accounts: Vec<CapabilityId>,
}

impl RulesOut {
    fn of(s: &KnowledgeSettings) -> RulesOut {
        RulesOut {
            revision: s.rules_revision,
            prohibitions: s.prohibitions.clone(),
            ad_cap: s.ad_cap.clone(),
            message_cap: s.message_cap.clone(),
            post_approval: s.post_approval,
            post_approval_accounts: s
                .post_approval_accounts
                .iter()
                .copied()
                .map(CapabilityId)
                .collect(),
        }
    }
}

/// The goals as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GoalsOut {
    pub revision: u64,
    pub items: Vec<String>,
}

/// Saves the rules box whole (see the module docs). A save that changes nothing writes nothing.
pub async fn rules_save(deps: &Deps, ctx: &Ctx, input: RulesInput) -> Result<RulesOut, AppError> {
    let person = editor(ctx)?;
    let prohibitions =
        validate_prohibitions("prohibitions", &input.prohibitions).map_err(invalid)?;
    for (field, cap) in [
        ("ad_budget", &input.ad_budget),
        ("message_budget", &input.message_budget),
    ] {
        if let Some(cap) = cap {
            validate_cap(field, cap).map_err(invalid)?;
        }
    }
    let accounts = input
        .post_approval_accounts
        .as_deref()
        .map(distinct_accounts)
        .transpose()?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::Always).await?;
    if kb.settings.rules_revision != input.expected_revision {
        return Err(rules_changed(&kb.settings));
    }
    let now = &kb.settings;
    let ad_cap = match &input.ad_budget {
        None => None,
        Some(c) => Some(cap(
            c,
            now.ad_cap.as_ref(),
            general_currency(r.as_mut()).await?,
        )),
    };
    let message_cap = input
        .message_budget
        .as_ref()
        .map(|c| cap(c, now.message_cap.as_ref(), None));
    if ad_cap != now.ad_cap || message_cap != now.message_cap {
        ctx.require(Permission::BudgetManage)?;
    }
    let accounts = match accounts {
        Some(list) => {
            // An account already listed stays listable after it is retired: the box read back
            // as it is saves, and leaving it out takes it off.
            social_accounts(
                r.as_mut(),
                &list,
                &now.post_approval_accounts,
                "post_approval_accounts",
            )
            .await?;
            list
        }
        None => now.post_approval_accounts.clone(),
    };
    let lowered = (now.post_approval && !input.post_approval)
        || now
            .post_approval_accounts
            .iter()
            .any(|a| !accounts.contains(a));
    if lowered {
        owner_or_manager(ctx)?;
    }
    let unchanged = prohibitions == now.prohibitions
        && ad_cap == now.ad_cap
        && message_cap == now.message_cap
        && input.post_approval == now.post_approval
        && accounts == now.post_approval_accounts;
    if unchanged {
        return Ok(RulesOut::of(&kb.settings));
    }
    let s = &mut kb.settings;
    s.prohibitions = prohibitions;
    s.ad_cap = ad_cap;
    s.message_cap = message_cap;
    s.post_approval = input.post_approval;
    s.post_approval_accounts = accounts;
    s.rules_revision += 1;
    record(deps, ctx, r.as_mut(), &mut kb, Subject::Rules, person).await?;
    let out = RulesOut::of(&kb.settings);
    r.commit().await?;
    Ok(out)
}

/// Puts one social account into the list of accounts whose posts wait for the owner, or takes it
/// out (Hesaplar' per-account switch). Needs `social.manage` or `team.manage` in person; taking an
/// account out needs the role owner or manager, and is `CONFLICT` `post_approval_all` while the
/// switch holds every post. Already as asked: answered as it is.
pub async fn post_approval_set(
    deps: &Deps,
    ctx: &Ctx,
    input: PostApprovalInput,
) -> Result<RulesOut, AppError> {
    ctx.require_any(&[Permission::SocialManage, Permission::TeamManage])?;
    let person = person(ctx)?;
    if !input.required {
        owner_or_manager(ctx)?;
    }
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::Never).await?;
    if kb.settings.rules_revision != input.expected_revision {
        return Err(rules_changed(&kb.settings));
    }
    let id = input.capability_id.as_uuid();
    // Only an account put into the list must be a live social account: any listed one, retired
    // since, can be taken out.
    if input.required {
        social_accounts(r.as_mut(), &[id], &[], "capability_id").await?;
    }
    if !input.required && kb.settings.post_approval {
        return Err(refused(
            ErrorCode::Conflict,
            "post_approval_all",
            "every post waits for approval: switch it off in Kurallar first",
            json!({}),
        ));
    }
    let listed = kb.settings.post_approval_accounts.contains(&id);
    if listed == input.required {
        return Ok(RulesOut::of(&kb.settings));
    }
    let s = &mut kb.settings;
    if input.required {
        if s.post_approval_accounts.len() >= MAX_POST_APPROVAL_ACCOUNTS {
            return Err(AppError::validation(
                format!("at most {MAX_POST_APPROVAL_ACCOUNTS} accounts"),
                json!({ "field": "capability_id", "reason": "too_many" }),
            ));
        }
        s.post_approval_accounts.push(id);
    } else {
        s.post_approval_accounts.retain(|a| *a != id);
    }
    s.rules_revision += 1;
    record(deps, ctx, r.as_mut(), &mut kb, Subject::Rules, person).await?;
    let out = RulesOut::of(&kb.settings);
    r.commit().await?;
    Ok(out)
}

/// Saves the goals whole: at most 20 lines of at most 300 characters. A knowledge change no
/// derivation reads. A save that changes nothing writes nothing.
pub async fn goals_save(deps: &Deps, ctx: &Ctx, input: GoalsInput) -> Result<GoalsOut, AppError> {
    let person = editor(ctx)?;
    let items = validate_goals("items", &input.items).map_err(invalid)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::Never).await?;
    if kb.settings.goals_revision != input.expected_revision {
        return Err(refused(
            ErrorCode::Conflict,
            "goals_changed",
            "the goals changed since they were read",
            json!({ "revision": kb.settings.goals_revision }),
        ));
    }
    if items == kb.settings.goals {
        return Ok(GoalsOut {
            revision: kb.settings.goals_revision,
            items,
        });
    }
    kb.settings.goals = items;
    kb.settings.goals_revision += 1;
    record(deps, ctx, r.as_mut(), &mut kb, Subject::Goals, person).await?;
    let out = GoalsOut {
        revision: kb.settings.goals_revision,
        items: kb.settings.goals.clone(),
    };
    r.commit().await?;
    Ok(out)
}

/// Records an owner's change of the rules or the goals and saves the settings.
async fn record(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    kb: &mut super::Locked,
    subject: Subject,
    person: jt_tenancy::UserId,
) -> Result<(), AppError> {
    kb.record(
        r,
        deps,
        ctx,
        Change {
            subject,
            card: None,
            cause: Cause::Owner,
            source_id: None,
            person: Some(person),
            posting: false,
            prospecting: false,
        },
    )
    .await?;
    kb.save(r).await
}

/// `CONFLICT` `rules_changed`, with the rules' revision.
fn rules_changed(s: &KnowledgeSettings) -> AppError {
    refused(
        ErrorCode::Conflict,
        "rules_changed",
        "the rules changed since they were read",
        json!({ "revision": s.rules_revision }),
    )
}

/// `FORBIDDEN` `owner_or_manager` unless the caller's role is owner or manager.
fn owner_or_manager(ctx: &Ctx) -> Result<(), AppError> {
    if ctx.is_owner_or_manager() {
        return Ok(());
    }
    Err(refused(
        ErrorCode::Forbidden,
        "owner_or_manager",
        "only an owner or a manager lowers post approval",
        json!({}),
    ))
}

/// A ceiling as stored from what was written: the amount, the period given (else the one in
/// force, else monthly), and the currency `unit` (the ad cap's: the live general ad budget's,
/// design §4.6.2), else the one in force, else `TRY`.
fn cap(input: &CapInput, current: Option<&Cap>, unit: Option<String>) -> Cap {
    Cap {
        amount_minor: input.amount_minor,
        period: input
            .period
            .or(current.map(|c| c.period))
            .unwrap_or(Period::Monthly),
        currency: unit
            .or_else(|| current.map(|c| c.currency.clone()))
            .unwrap_or_else(|| "TRY".to_owned()),
    }
}

/// The currency of the live general ad budget, if any.
async fn general_currency(r: &mut dyn TenantRepos) -> Result<Option<String>, AppError> {
    Ok(r.budget()
        .list_items()
        .await?
        .into_iter()
        .find(|i| i.general && i.retired_at.is_none())
        .and_then(|i| match i.unit {
            Unit::Currency(c) => Some(c),
            _ => None,
        }))
}

/// The accounts as written, each once, at most [`MAX_POST_APPROVAL_ACCOUNTS`].
fn distinct_accounts(raw: &[CapabilityId]) -> Result<Vec<Uuid>, AppError> {
    let mut seen = BTreeSet::new();
    let list: Vec<Uuid> = raw
        .iter()
        .map(|c| c.as_uuid())
        .filter(|id| seen.insert(*id))
        .collect();
    if list.len() > MAX_POST_APPROVAL_ACCOUNTS {
        return Err(AppError::validation(
            format!("at most {MAX_POST_APPROVAL_ACCOUNTS} accounts"),
            json!({ "field": "post_approval_accounts", "reason": "too_many" }),
        ));
    }
    Ok(list)
}

/// `NOT_FOUND` (naming `field`, with the index for a list) unless every id but those already
/// `listed` is a social account of the workspace (a kind posts go out on, not retired).
async fn social_accounts(
    r: &mut dyn TenantRepos,
    ids: &[Uuid],
    listed: &[Uuid],
    field: &str,
) -> Result<(), AppError> {
    if ids.iter().all(|id| listed.contains(id)) {
        return Ok(());
    }
    let social: BTreeSet<Uuid> = r
        .capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .filter(|c| {
            ORGANIC_KINDS.contains(&c.kind_key.as_str()) && c.status != StoredStatus::Retired
        })
        .map(|c| c.id.as_uuid())
        .collect();
    if let Some(i) = ids
        .iter()
        .position(|id| !listed.contains(id) && !social.contains(id))
    {
        return Err(refused(
            ErrorCode::NotFound,
            "not_a_social_account",
            "no such social account",
            json!({ "field": field, "index": i }),
        ));
    }
    Ok(())
}
