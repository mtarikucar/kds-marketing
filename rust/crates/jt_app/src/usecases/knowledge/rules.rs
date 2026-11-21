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
//! What enforces them, in the same transaction as the save:
//!
//! - **The caps** are mirrored into the frame's lanes (`frame::apply`, cause `rules`; design
//!   §4.6.2, §4.6.4): the paid lane is `ad_cap` while it is above 0, the organic lane is
//!   `message_cap`. A mirror that does not validate (a bug) ledgers `strategy.frame_skipped` and
//!   the owner's save still commits; the next `knowledge_settle` tick writes it.
//! - **The general ad budget** follows `ad_cap` (`cap` = its amount, in its period; created as
//!   "Reklam bütçesi" when there is none; cap 0 for "Reklam yok"), as the person's own write, so
//!   a lowering binds through `check_money`'s general check at once. `budget::check_general` holds
//!   that item at or below `ad_cap`, and in its currency, for everyone (`above_rules_cap`,
//!   `rules_cap_currency`): only a person in person with `budget.manage`, here, raises the
//!   ceiling (D2). The ceiling keeps its currency: a save never takes another from the general
//!   item, so no edit in Bütçe can turn the owner's number into another currency's.
//! - **A lowering** runs the ads watch right after the commit (`ads::watch`), so a running
//!   campaign whose period spend already reached the new cap stops now, not at the job's next
//!   pass; the answer says how many (`stopped_campaigns`).
//! - **Post approval** is read by the effective post gate (`social::approval`, §3.10.1).
//!
//! Locks, in the order of design §4.10.13 (D35): the draft, the execution frame, the settings,
//! then (in the mirror's transition hook) the studio control, then the general budget item.
//!
//! Refusals: `VALIDATION` per field, `CONFLICT` `rules_changed` / `goals_changed` (the box moved
//! past `expected_revision`, with its `revision`), `FORBIDDEN` naming `budget.manage`, `FORBIDDEN`
//! `owner_or_manager`, `CONFLICT` `post_approval_all` (an account taken off the list while the
//! switch holds every post), `NOT_FOUND` (an account put into the list that is not a live social
//! account of the workspace; one listed already, retired since, stays and can be taken out).

use std::collections::BTreeSet;

use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, CapabilityId, NewBudgetItem, StoredStatus, Unit,
};
use jt_knowledge::frame::{FrameCause, FrameParts};
use jt_knowledge::seed::AD_BUDGET_NAME;
use jt_knowledge::{
    AUTO_QUOTE_VALID_DAYS, AUTO_REPLY_KINDS, AutoReply, AutoReplyInput, Cap, CapInput, Card, Cause,
    KnowledgeCardId, KnowledgeSettings, MAX_LIVE_CARDS, MAX_POST_APPROVAL_ACCOUNTS, PriceRange,
    REPLY_STANDARD, Subject, validate_auto_reply, validate_cap, validate_goals,
    validate_prohibitions,
};
use jt_strategy::Period;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::{Change, FrameWrite, editor, frame, invalid, lock, person, refused, seed};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::ads::watch;
use crate::usecases::studio::chain::ORGANIC_KINDS;
use crate::usecases::{Deps, ledger_entry};

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
    /// The inbox's automatic replies: the numbers they answer on and their price range; none:
    /// unchanged. The first time any number is listed, the "Standart iş ve fiyat" card is created
    /// for the owner to fill.
    #[serde(default)]
    pub auto_reply: Option<AutoReplyInput>,
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
    /// The inbox's automatic replies as stored.
    pub auto_reply: Option<AutoReply>,
    /// `rules_save` only: how many running ad campaigns a lowered ad budget stopped at once.
    pub stopped_campaigns: u32,
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
            auto_reply: s.auto_reply.clone(),
            stopped_campaigns: 0,
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
    let ad_cap = match (&input.ad_budget, &now.ad_cap) {
        (None, _) => None,
        (Some(c), Some(current)) => Some(cap(c, Some(current), None)),
        (Some(c), None) => Some(cap(c, None, general_currency(r.as_mut()).await?)),
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
    let auto_reply = match &input.auto_reply {
        Some(a) => auto_reply_of(r.as_mut(), a, now.auto_reply.as_ref()).await?,
        None => now.auto_reply.clone(),
    };
    let unchanged = prohibitions == now.prohibitions
        && ad_cap == now.ad_cap
        && message_cap == now.message_cap
        && input.post_approval == now.post_approval
        && accounts == now.post_approval_accounts
        && auto_reply == now.auto_reply;
    if unchanged {
        return Ok(RulesOut::of(&kb.settings));
    }
    let before_ad = now.ad_cap.clone();
    let caps_moved = ad_cap != now.ad_cap || message_cap != now.message_cap;
    let s = &mut kb.settings;
    s.prohibitions = prohibitions;
    s.ad_cap = ad_cap;
    s.message_cap = message_cap;
    s.post_approval = input.post_approval;
    s.post_approval_accounts = accounts;
    let turned_on = auto_reply
        .as_ref()
        .is_some_and(|a| !a.capability_ids.is_empty());
    s.auto_reply = auto_reply;
    s.rules_revision += 1;
    kb.record(r.as_mut(), deps, ctx, change(Subject::Rules, person))
        .await?;
    if turned_on {
        standard_card(deps, ctx, r.as_mut(), &mut kb, person).await?;
    }
    if caps_moved {
        // The mirror (design §4.6.2): the lanes from the caps, as a person's action. Nothing to
        // mirror into before the first frame (the bootstrap takes the caps from the settings).
        if kb.frame.is_some() {
            frame::apply_locked(
                deps,
                ctx,
                r.as_mut(),
                &mut kb.settings,
                frame::Request {
                    cause: FrameCause::Rules,
                    next: &FrameParts::default(),
                    approver: Some(person),
                    waking: frame::Waking::InPerson,
                },
            )
            .await?;
        }
        if kb.settings.ad_cap != before_ad {
            follow_general(deps, ctx, r.as_mut(), kb.settings.ad_cap.as_ref()).await?;
        }
    }
    kb.save(r.as_mut()).await?;
    let mut out = RulesOut::of(&kb.settings);
    r.commit().await?;
    if lowered_cap(before_ad.as_ref(), out.ad_cap.as_ref()) {
        // Best effort: the `studio_control` job's next pass stops what this one did not.
        match watch::watch_counted(deps, ctx.workspace_id, ctx.now).await {
            Ok(w) => out.stopped_campaigns = w.stopped,
            Err(e) => {
                tracing::warn!(error = %e.message, "the ads watch after a lowered ad budget");
            }
        }
    }
    Ok(out)
}

/// The automatic replies `input` sets over `stored`: each listed capability a live one of
/// [`AUTO_REPLY_KINDS`] (`NOT_FOUND` otherwise), the range validated ([`validate_auto_reply`]),
/// the stored range and validity kept where the input gives none. Its currency is the stored
/// range's, else TRY.
async fn auto_reply_of(
    r: &mut dyn TenantRepos,
    input: &AutoReplyInput,
    stored: Option<&AutoReply>,
) -> Result<Option<AutoReply>, AppError> {
    let stored_price = stored.and_then(|a| a.price.as_ref());
    let range = validate_auto_reply(input, stored_price).map_err(invalid)?;
    for (i, id) in input.capability_ids.iter().enumerate() {
        let ok = r
            .capabilities()
            .find(CapabilityId(*id))
            .await?
            .is_some_and(|c| {
                c.status != StoredStatus::Retired && AUTO_REPLY_KINDS.contains(&c.kind_key.as_str())
            });
        if !ok {
            return Err(refused(
                ErrorCode::NotFound,
                "no_such_number",
                "a listed number is not a live WhatsApp number of the workspace",
                json!({ "field": format!("auto_reply.capability_ids[{i}]") }),
            ));
        }
    }
    let price = match range {
        Some((min_minor, max_minor)) => Some(PriceRange {
            min_minor,
            max_minor,
            currency: stored_price.map_or_else(|| "TRY".to_owned(), |p| p.currency.clone()),
        }),
        None => stored_price.cloned(),
    };
    if input.capability_ids.is_empty() && price.is_none() && stored.is_none() {
        return Ok(None);
    }
    Ok(Some(AutoReply {
        capability_ids: input.capability_ids.clone(),
        price,
        quote_valid_days: stored.map_or(AUTO_QUOTE_VALID_DAYS, |a| a.quote_valid_days),
    }))
}

/// Creates the "Standart iş ve fiyat" card (empty, after every live card) when the workspace has
/// no card of its key yet, live or removed, and room for one: where the owner writes the standard
/// work and how its price is placed in the range.
async fn standard_card(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    kb: &mut super::Locked,
    person: jt_tenancy::UserId,
) -> Result<(), AppError> {
    let cards = r.knowledge().cards().await?;
    if cards
        .iter()
        .any(|c| c.key.as_deref() == Some(REPLY_STANDARD.0))
        || super::cards::live(&cards) >= MAX_LIVE_CARDS
    {
        return Ok(());
    }
    let card = Card {
        id: KnowledgeCardId(deps.ids.uuid()),
        key: Some(REPLY_STANDARD.0.to_owned()),
        title: REPLY_STANDARD.1.to_owned(),
        body: String::new(),
        attachments: Vec::new(),
        position: super::cards::next_position(&cards),
        revision: 1,
        created_at: ctx.now,
        created_by: ctx.actor.clone(),
        updated_at: ctx.now,
        updated_by: ctx.actor.clone(),
        archived_at: None,
    };
    r.knowledge().insert_card(&card).await?;
    kb.record(
        r,
        deps,
        ctx,
        Change {
            subject: Subject::Card,
            card: Some(&card),
            cause: Cause::Owner,
            source_id: None,
            person: Some(person),
            posting: false,
            prospecting: false,
        },
    )
    .await?;
    Ok(())
}

/// Whether the ad budget went down: removed, or a lower rate (per day) than before.
fn lowered_cap(before: Option<&Cap>, after: Option<&Cap>) -> bool {
    match (before, after) {
        (Some(_), None) => true,
        (Some(b), Some(a)) => {
            b.currency != a.currency
                || i128::from(a.amount_minor) * seed::lane_days(b.period)
                    < i128::from(b.amount_minor) * seed::lane_days(a.period)
        }
        _ => false,
    }
}

/// The reason the general ad budget's changes made by a rules save carry.
const RULES_REASON: &str = "knowledge_rules";

/// The live general ad budget follows the ad budget of the rules (design §4.6.2), as the
/// person's write: its cap is the amount, in its period; with none, one is created ("Reklam
/// bütçesi"); with no ad budget, its cap becomes 0 (it is kept, with its history). A general item
/// in another currency than the ad budget's is left as it is: nothing is spent through it (the
/// paid lane is in the ad budget's currency, and `check_money` takes the lane of the item's),
/// and following it would put the owner's amount into another currency. Locks the item: the
/// last lock of design §4.10.13. Ledgered `budget.items.update` / `budget.items.create` with the
/// reason `knowledge_rules`.
async fn follow_general(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: Option<&Cap>,
) -> Result<(), AppError> {
    let live = |i: &BudgetItem| i.general && i.retired_at.is_none();
    let found = r.budget().list_items().await?.into_iter().find(live);
    let in_force = r
        .strategy()
        .current_approved()
        .await?
        .map(|v| v.id.as_uuid());
    let Some(found) = found else {
        let Some(cap) = cap.filter(|c| c.amount_minor > 0) else {
            return Ok(());
        };
        let mut item = BudgetItem::new(
            BudgetItemId(deps.ids.uuid()),
            ctx.workspace_id,
            NewBudgetItem {
                name: AD_BUDGET_NAME.to_owned(),
                kind: BudgetKind::AdBudget,
                unit: Unit::Currency(cap.currency.clone()),
                cap: cap.amount_minor,
                unit_cost_minor: None,
                period: seed::item_period(cap.period),
            },
            ctx.now,
        )
        .map_err(|e| AppError::internal(e.to_string()))?;
        item.general = true;
        item.strategy_version_id = in_force;
        r.budget().insert_item(item.clone()).await?;
        let mut entry = ledger_entry(
            ctx,
            "budget.items.create",
            "budget_item",
            item.id,
            json!({
                "name": item.name,
                "kind": item.kind,
                "unit": item.unit,
                "cap": item.cap,
                "unit_cost_minor": item.unit_cost_minor,
                "period": item.period,
                "general": true,
                "reason": RULES_REASON,
            }),
        )?;
        entry.strategy_version_id = in_force;
        r.ledger().append(entry).await?;
        return Ok(());
    };
    let mut item = r
        .budget()
        .lock_item(found.id)
        .await?
        .filter(live)
        .ok_or_else(|| AppError::conflict("the general ad budget changed meanwhile"))?;
    let (amount, period) = match cap {
        Some(c) if item.unit != Unit::Currency(c.currency.clone()) => return Ok(()),
        Some(c) => (c.amount_minor, seed::item_period(c.period)),
        None => (0, item.period),
    };
    if item.cap == amount && item.period == period {
        return Ok(());
    }
    let previous = json!({ "cap": item.cap, "period": item.period });
    item.cap = amount;
    item.period = period;
    r.budget().update_item(item).await?;
    let mut entry = ledger_entry(
        ctx,
        "budget.items.update",
        "budget_item",
        found.id,
        json!({
            "cap": amount,
            "period": period,
            "previous": previous,
            "reason": RULES_REASON,
        }),
    )?;
    entry.strategy_version_id = in_force;
    r.ledger().append(entry).await?;
    Ok(())
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

/// The knowledge base locked for `capability.set_policy` (see [`lock_for_policy`]), with the
/// person acting.
pub(crate) struct PolicyLock {
    kb: super::Locked,
    person: jt_tenancy::UserId,
}

/// Before `capability.set_policy` locks its capability (the settings come before the
/// capabilities, design §4.10.13): the knowledge base, locked, for a person acting in person on
/// a workspace whose post gate is seeded; none otherwise (before the seed the stored flag is
/// still the gate, and an agent's policy write never moves post approval, §3.10.1).
pub(crate) async fn lock_for_policy(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
) -> Result<Option<PolicyLock>, AppError> {
    let Ok(person) = person(ctx) else {
        return Ok(None);
    };
    let frame = r.strategy().current_approved().await?;
    let Some(settings) = r.knowledge().lock_settings().await? else {
        return Ok(None);
    };
    if settings.post_gate_seeded_at.is_none() {
        return Ok(None);
    }
    Ok(Some(PolicyLock {
        kb: super::Locked {
            revisions_at_lock: (settings.posting_revision, settings.prospecting_revision),
            settings,
            frame: frame.map(|v| v.id),
            bumped: false,
        },
        person,
    }))
}

/// A person's `capability.set_policy` turning `c`'s stored flag to `required` (`c` as it was
/// before), under `lock` (design §3.10.1, D1): post approval is the knowledge base's, so the
/// policy dialog's "every action waits for a person" moves a social account into the approval
/// list, and out of it when the person is an owner or a manager and the switch is off (as
/// `post_approval_set` allows; otherwise its posts keep waiting, which errs safe). The flag
/// itself keeps holding the account's comment replies. A `rules` revision row and
/// `strategy.rules_changed`, in the caller's bundle. Nothing else changes anything here.
pub(crate) async fn follow_policy(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    lock: PolicyLock,
    c: &jt_capability::Capability,
    required: bool,
) -> Result<(), AppError> {
    let PolicyLock { mut kb, person } = lock;
    if !ORGANIC_KINDS.contains(&c.kind_key.as_str()) || c.policy.requires_human_approval == required
    {
        return Ok(());
    }
    let id = c.id.as_uuid();
    let s = &mut kb.settings;
    let listed = s.post_approval_accounts.contains(&id);
    if required && !listed {
        if s.post_approval_accounts.len() >= MAX_POST_APPROVAL_ACCOUNTS {
            return Err(AppError::validation(
                format!(
                    "at most {MAX_POST_APPROVAL_ACCOUNTS} accounts wait for approval one by one:                      switch approval on for every post in Kurallar instead"
                ),
                json!({ "field": "requires_human_approval", "reason": "too_many" }),
            ));
        }
        s.post_approval_accounts.push(id);
    } else if !required && listed && !s.post_approval && ctx.is_owner_or_manager() {
        s.post_approval_accounts.retain(|a| *a != id);
    } else {
        return Ok(());
    }
    s.rules_revision += 1;
    record(deps, ctx, r, &mut kb, Subject::Rules, person).await
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
    kb.record(r, deps, ctx, change(subject, person)).await?;
    kb.save(r).await
}

/// The change record of an owner's write of the rules or the goals.
fn change(subject: Subject, person: jt_tenancy::UserId) -> Change<'static> {
    Change {
        subject,
        card: None,
        cause: Cause::Owner,
        source_id: None,
        person: Some(person),
        posting: false,
        prospecting: false,
    }
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
/// force, else monthly), and the currency of the one in force; a new one's is `unit` (the ad
/// cap's: the live general ad budget's, design §4.6.2), else `TRY`. A save never changes a
/// ceiling's currency.
fn cap(input: &CapInput, current: Option<&Cap>, unit: Option<String>) -> Cap {
    Cap {
        amount_minor: input.amount_minor,
        period: input
            .period
            .or(current.map(|c| c.period))
            .unwrap_or(Period::Monthly),
        currency: current
            .map(|c| c.currency.clone())
            .or(unit)
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
