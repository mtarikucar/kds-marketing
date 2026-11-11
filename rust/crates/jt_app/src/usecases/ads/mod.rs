//! Reklam yönetimi (design 2026-11-10 §8): from a goal and a budget to a running ad that an
//! agent watches and improves, with money that never passes its limits.
//!
//! A person opens a campaign (a goal, a budget, a start time), or an agent proposes one and a
//! person approves it. An agent plans it ([`plan`]); Jeeta checks the plan, holds the campaign's
//! whole budget against every limit and builds the campaign at the provider itself, paused
//! first ([`build`]); then it watches what the provider reports, records what was spent and
//! applies the agent's moves ([`watch`]).
//!
//! **Money (P4).** A campaign's budget is a total. From the moment a campaign is opened (or a
//! proposal approved) its unspent budget is committed, and everything that could spend on ads
//! is checked against the same sums (`check_money`): the general ad budget's remainder in its
//! period, the strategy's paid cap, the ad account's own cap. The provider gets the budget as
//! the campaign's lifetime budget (B32): it cannot spend more than that whatever Jeeta does.
pub mod build;
pub mod plan;
pub mod watch;

use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, ads::*},
    usecases::{
        Deps, hash_token, ledger_entry,
        studio::{chain, control::human_approver, files, library, projects},
    },
};
use jt_capability::{BudgetItem, Capability, CapabilityId, StoredStatus, Unit, period_window};
use jt_strategy::LaneKind;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub use plan::{PlanInput, plan_submit};
pub use watch::{MoveInput, PreviewInput, PreviewOut, ad_preview, campaign_move};

/// A refusal with its reason (`CONFLICT`).
pub(crate) fn refuse(reason: &str, message: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: message.into(),
        details: json!({ "reason": reason }),
    }
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field": field, "reason": reason}))
}

/// A tenant bundle for a campaign use case: the caller holds `permission` and the workspace is
/// active.
pub(crate) async fn open_tx(
    d: &Deps,
    ctx: &Ctx,
    permission: Permission,
) -> Result<Box<dyn TenantRepos>, AppError> {
    ctx.require(permission)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    Ok(r)
}

/// The campaign, locked; `NOT_FOUND` when it is not the workspace's, `CONFLICT` when
/// `expected` is given and the campaign moved.
pub(crate) async fn load(
    r: &mut dyn TenantRepos,
    id: Uuid,
    expected: Option<u64>,
) -> Result<AdCampaign, AppError> {
    let c = r
        .ads()
        .lock_campaign(id)
        .await?
        .ok_or_else(|| AppError::not_found("ad campaign"))?;
    if expected.is_some_and(|e| e != c.revision) {
        return Err(AppError::conflict("ad campaign revision changed"));
    }
    Ok(c)
}

/// When a campaign that is over closed: its end, its decline, or the day its proposal ran out.
pub(crate) fn closed_time(c: &AdCampaign, now: OffsetDateTime) -> Option<OffsetDateTime> {
    if let Some(ended) = &c.ended {
        return Some(ended.at);
    }
    if let Some(declined) = &c.declined {
        return Some(declined.at);
    }
    (c.state_at(now) == CampaignState::Expired)
        .then(|| c.created_at + Duration::days(PROPOSAL_DAYS))
}

/// Stores `c` as its next revision (the first, for a campaign that is not stored yet) with
/// `action` in the ledger, and answers it as an answer carries it.
pub(crate) async fn save(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    mut c: AdCampaign,
    action: &str,
) -> Result<AdCampaign, AppError> {
    let previous = c.revision;
    c.revision = previous
        .checked_add(1)
        .ok_or_else(|| AppError::conflict("ad campaign revision overflow"))?;
    c.updated_at = ctx.now;
    if c.moves.len() > MAX_MOVES {
        let extra = c.moves.len() - MAX_MOVES;
        c.moves.drain(..extra);
    }
    let closed = closed_time(&c, ctx.now);
    r.ads()
        .save_campaign(c.clone(), (previous > 0).then_some(previous), closed)
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            action,
            "ad_campaign",
            c.id,
            json!({"revision": c.revision, "state": c.state_at(ctx.now)}),
        )?)
        .await?;
    Ok(c.present(ctx.now))
}

/// The workspace's general ad budget, locked: what ad campaigns draw from (B37). `CONFLICT`
/// (`no_general_ad_budget`) when the workspace has none.
pub(crate) async fn general_budget(r: &mut dyn TenantRepos) -> Result<BudgetItem, AppError> {
    let id = r
        .budget()
        .list_items()
        .await?
        .into_iter()
        .find(|i| i.general && i.retired_at.is_none())
        .map(|i| i.id)
        .ok_or_else(|| {
            refuse(
                "no_general_ad_budget",
                "the workspace has no general ad budget: set one on the budget page",
            )
        })?;
    r.budget()
        .lock_item(id)
        .await?
        .filter(|i| i.general && i.retired_at.is_none())
        .ok_or_else(|| refuse("no_general_ad_budget", "the general ad budget is gone"))
}

fn currency_of(item: &BudgetItem) -> Result<String, AppError> {
    match &item.unit {
        Unit::Currency(code) => Ok(code.clone()),
        _ => Err(AppError::internal("the general ad budget has no currency")),
    }
}

/// What every open campaign but `except` still commits, in `currency`: on `account` alone when
/// one is given.
pub(crate) async fn committed(
    r: &mut dyn TenantRepos,
    currency: &str,
    except: Option<Uuid>,
    account: Option<CapabilityId>,
    now: OffsetDateTime,
) -> Result<i128, AppError> {
    let mut rows = r.ads().list_campaigns(CampaignScope::Open, None).await?;
    // A campaign that ended and is not confirmed paused at the provider still holds what is
    // left of it: the provider may still spend it.
    rows.extend(r.ads().list_winding_down(now - SETTLE_WINDOW).await?);
    Ok(rows
        .iter()
        .filter(|c| c.currency == currency && Some(c.id) != except)
        .filter(|c| account.is_none_or(|a| c.built.as_ref().map(|b| b.account) == Some(a)))
        .map(|c| i128::from(c.committed_minor(now)))
        .sum())
}

/// The limits a campaign's budget is held against (P4), in one transaction, before anything is
/// committed or sent: a person's stop, the general ad budget's remainder in its period, the
/// strategy's paid cap, and the ad account's own cap when the account is known. `amount` is
/// what campaign `id` would commit. Each refusal names its limit and what is left.
pub(crate) async fn check_money(
    r: &mut dyn TenantRepos,
    id: Uuid,
    amount: i64,
    account: Option<&Capability>,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let version = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let control = r.studio_control().lock_control().await?;
    if control.is_braked(LaneKind::Paid) || control.spend_stopped.stops("ads") {
        return Err(chain::refuse("spend_stopped"));
    }
    let general = general_budget(r).await?;
    let currency = currency_of(&general)?;
    let lane = version
        .sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == LaneKind::Paid && l.currency == currency)
        .filter(|_| version.sections.paid_enabled)
        .ok_or_else(|| {
            refuse(
                "no_paid_lane",
                "the approved strategy has no paid lane in the ad budget's currency",
            )
        })?;
    let others = committed(r, &currency, Some(id), None, now).await?;
    let over = |limit: &str, cap: i128, used: i128| -> Result<(), AppError> {
        if used + i128::from(amount) > cap {
            return Err(AppError {
                code: ErrorCode::Conflict,
                message: "the campaign's budget passes a limit".into(),
                details: json!({"reason": limit, "left": (cap - used).max(0) as i64}),
            });
        }
        Ok(())
    };
    // The general ad budget: what was spent in its period, and what open campaigns still hold.
    let (from, until) = period_window(general.period, now);
    let spent = i128::from(r.budget().spent_between(general.id, from, until).await?);
    over(
        "above_general_budget",
        i128::from(general.cap),
        spent + others,
    )?;
    // The strategy's paid cap: the same sums against the lane's own period.
    let lane_period = match lane.period {
        jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
        jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
    };
    let (from, until) = period_window(lane_period, now);
    let spent = i128::from(r.budget().spent_between(general.id, from, until).await?);
    over(
        "above_strategy_cap",
        i128::from(lane.cap_minor),
        spent + others,
    )?;
    // The ad account's own cap, for what runs on that account.
    if let Some(account) = account
        && let Some(cap) = account.policy.spend_cap_minor
    {
        let held = committed(r, &currency, Some(id), Some(account.id), now).await?;
        over("above_account_cap", i128::from(cap), held)?;
    }
    Ok(())
}

fn instant(value: &str, field: &str) -> Result<OffsetDateTime, AppError> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| invalid(field, "rfc3339"))
}

/// The start and end of a campaign as a person or an agent gives them: a start that passed
/// reads as now, at most a year ahead; an end, when given, 24 hours to 90 days after the start.
fn times(
    start_at: &str,
    end_at: Option<&str>,
    now: OffsetDateTime,
) -> Result<(OffsetDateTime, Option<OffsetDateTime>), AppError> {
    let start = instant(start_at, "start_at")?.max(now);
    if start > now + Duration::days(365) {
        return Err(invalid("start_at", "at_most_a_year_ahead"));
    }
    let end = end_at.map(|v| instant(v, "end_at")).transpose()?;
    if let Some(end) = end
        && (end - start < MIN_RUN || end - start > MAX_RUN)
    {
        return Err(invalid("end_at", "24_hours_to_90_days_after_the_start"));
    }
    Ok((start, end))
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    /// `open` (the default): campaigns that are not over, by start time; `closed`: the ones
    /// that are (ended, declined, expired), newest first, 50 a page.
    #[serde(default)]
    pub scope: Option<CampaignScope>,
    /// For `closed`: the previous page's `next_before`.
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CampaignList {
    pub campaigns: Vec<AdCampaign>,
    pub next_before: Option<String>,
}

/// `ads.campaigns_list`.
pub async fn campaigns_list(d: &Deps, ctx: &Ctx, q: ListQuery) -> Result<CampaignList, AppError> {
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let scope = q.scope.unwrap_or(CampaignScope::Open);
    let before = q
        .before
        .as_deref()
        .map(|v| instant(v, "before"))
        .transpose()?;
    let mut rows = r.ads().list_campaigns(scope, before).await?;
    let mut next_before = None;
    match scope {
        // A proposal that ran out is over, whether or not the watch has marked it yet.
        CampaignScope::Open => rows.retain(|c| !c.closed_at(ctx.now)),
        CampaignScope::Closed => {
            if rows.len() > 50 {
                rows.truncate(50);
                next_before = rows
                    .last()
                    .and_then(|c| closed_time(c, ctx.now))
                    .and_then(|at| at.format(&Rfc3339).ok());
            }
        }
    }
    Ok(CampaignList {
        campaigns: rows.into_iter().map(|c| c.present(ctx.now)).collect(),
        next_before,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignIdInput {
    pub campaign_id: Uuid,
}

#[derive(Clone, Debug, Serialize)]
pub struct CampaignDetail {
    pub campaign: AdCampaign,
    /// The daily numbers per ad, oldest first.
    pub days: Vec<AdDayRow>,
    /// The materials the plan's ads show.
    pub materials: Vec<jt_studio::Material>,
}

pub(crate) async fn detail(
    r: &mut dyn TenantRepos,
    c: AdCampaign,
    now: OffsetDateTime,
) -> Result<CampaignDetail, AppError> {
    let mut days = c.results.clone();
    days.sort_by_key(|d| (d.day, d.ad));
    let mut materials = Vec::new();
    for ad in c.plan.iter().flat_map(|p| &p.ads) {
        for id in &ad.material_ids {
            if !materials.iter().any(|m: &jt_studio::Material| m.id == *id)
                && let Some(m) = r.studio_materials().get_material(*id).await?
            {
                materials.push(m);
            }
        }
    }
    Ok(CampaignDetail {
        campaign: c.present(now),
        days,
        materials,
    })
}

/// `ads.campaign_get`.
pub async fn campaign_get(
    d: &Deps,
    ctx: &Ctx,
    i: CampaignIdInput,
) -> Result<CampaignDetail, AppError> {
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let c = r
        .ads()
        .get_campaign(i.campaign_id)
        .await?
        .ok_or_else(|| AppError::not_found("ad campaign"))?;
    detail(r.as_mut(), c, ctx.now).await
}

// ---------------------------------------------------------------------------------------------
// Opening, proposing, deciding
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenInput {
    pub request_key: String,
    /// What the campaign is for, in the person's words.
    pub goal: String,
    /// The campaign's whole budget, in minor units of the general ad budget's currency.
    pub budget_minor: i64,
    pub start_at: String,
    #[serde(default)]
    pub title: Option<String>,
    /// The ad account, when the person chose one.
    #[serde(default)]
    pub account: Option<CapabilityId>,
    #[serde(default)]
    pub end_at: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn new_campaign(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    opened_by: CampaignOpenedBy,
    i: &OpenInput,
    reason: Option<String>,
    currency: String,
) -> Result<AdCampaign, AppError> {
    let goal = projects::text(&i.goal, "goal", MAX_TEXT_CHARS, true)?;
    if i.budget_minor <= 0 {
        return Err(invalid("budget_minor", "positive"));
    }
    let (start_at, end_at) = times(&i.start_at, i.end_at.as_deref(), ctx.now)?;
    let title = match i.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(title) => projects::text(title, "title", 160, true)?,
        None => projects::goal_title(&goal),
    };
    if let Some(account) = i.account {
        let found = r.capabilities().find(account).await?;
        if !found.is_some_and(|c| c.kind_key == "meta_ads" && c.status != StoredStatus::Retired) {
            return Err(invalid("account", "not_a_live_ad_account"));
        }
    }
    Ok(AdCampaign {
        id: d.ids.uuid(),
        workspace_id: ctx.workspace_id,
        revision: 0,
        title,
        goal,
        budget_minor: i.budget_minor,
        currency,
        start_at,
        end_at,
        account_hint: i.account,
        opened_by,
        approval: None,
        declined: None,
        reason,
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
        created_at: ctx.now,
        updated_at: ctx.now,
        state: None,
        totals: None,
    })
}

/// The campaign a request key already made, if any.
async fn replayed(
    r: &mut dyn TenantRepos,
    action: &str,
    key: &str,
    payload: &Value,
    now: OffsetDateTime,
) -> Result<Option<AdCampaign>, AppError> {
    files::key(key)?;
    let Some(saved) = r.studio().request_replay(action, key, payload).await? else {
        return Ok(None);
    };
    let id: Uuid =
        serde_json::from_value(saved).map_err(|_| AppError::internal("stored campaign receipt"))?;
    Ok(r.ads().get_campaign(id).await?.map(|c| c.present(now)))
}

/// `ads.campaign_open`: a person opens a campaign with a goal, a budget and a start time; it
/// needs nobody's approval (S20). Panel-only. Refused without a general ad budget, without a
/// paid lane in the approved strategy, and when the budget is more than the general ad budget
/// has left (`above_general_budget`, with what is left).
pub async fn campaign_open(d: &Deps, ctx: &Ctx, i: OpenInput) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    let user =
        library::person(ctx).ok_or_else(|| AppError::forbidden("a person opens a campaign"))?;
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let payload = serde_json::to_value(&i)?;
    if let Some(c) = replayed(
        r.as_mut(),
        "ads.campaign_open",
        &i.request_key,
        &payload,
        ctx.now,
    )
    .await?
    {
        return Ok(c);
    }
    let currency = currency_of(&general_budget(r.as_mut()).await?)?;
    let c = new_campaign(
        d,
        r.as_mut(),
        ctx,
        CampaignOpenedBy::Human { user },
        &i,
        None,
        currency,
    )
    .await?;
    check_money(r.as_mut(), c.id, c.budget_minor, None, ctx.now).await?;
    let id = c.id;
    let out = save(r.as_mut(), ctx, c, "ads.campaign.opened").await?;
    r.studio()
        .request_receipt("ads.campaign_open", &i.request_key, &payload, &json!(id))
        .await?;
    r.commit().await?;
    Ok(out)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposeInput {
    pub request_key: String,
    pub goal: String,
    pub budget_minor: i64,
    pub start_at: String,
    #[serde(default)]
    pub end_at: Option<String>,
    /// Why the agent thinks this campaign is worth its budget.
    pub reason: String,
}

/// `ads.campaign_propose`: an agent proposes a campaign; it spends nothing until a person
/// approves it (S24), and closes by itself after seven days (B16). At most one proposal a week.
pub async fn campaign_propose(
    d: &Deps,
    ctx: &Ctx,
    i: ProposeInput,
) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsWork)?;
    let agent = ctx
        .agent_connection_id
        .ok_or_else(|| AppError::forbidden("an agent proposes a campaign"))?;
    let reason = projects::text(&i.reason, "reason", MAX_TEXT_CHARS, true)?;
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    r.strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let payload = serde_json::to_value(&i)?;
    if let Some(c) = replayed(
        r.as_mut(),
        "ads.campaign_propose",
        &i.request_key,
        &payload,
        ctx.now,
    )
    .await?
    {
        return Ok(c);
    }
    let recent = |c: &AdCampaign| {
        matches!(c.opened_by, CampaignOpenedBy::System { .. })
            && ctx.now - c.created_at < Duration::days(PROPOSAL_DAYS)
    };
    let mut all = r.ads().list_campaigns(CampaignScope::Open, None).await?;
    all.extend(r.ads().list_campaigns(CampaignScope::Closed, None).await?);
    if all.iter().any(recent) {
        return Err(refuse(
            "proposal_limit",
            "one campaign proposal a week: an earlier one is less than seven days old",
        ));
    }
    let currency = currency_of(&general_budget(r.as_mut()).await?)?;
    let open = OpenInput {
        request_key: i.request_key.clone(),
        goal: i.goal.clone(),
        budget_minor: i.budget_minor,
        start_at: i.start_at.clone(),
        title: None,
        account: None,
        end_at: i.end_at.clone(),
    };
    let c = new_campaign(
        d,
        r.as_mut(),
        ctx,
        CampaignOpenedBy::System { agent },
        &open,
        Some(reason),
        currency,
    )
    .await?;
    let id = c.id;
    let out = save(r.as_mut(), ctx, c, "ads.campaign.proposed").await?;
    r.studio()
        .request_receipt("ads.campaign_propose", &i.request_key, &payload, &json!(id))
        .await?;
    r.commit().await?;
    Ok(out)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionInput {
    pub campaign_id: Uuid,
    pub expected_revision: u64,
    /// Why: required for a decline and a pause.
    #[serde(default)]
    pub reason: Option<String>,
}

/// `ads.campaign_approve`: a person approves a proposal; it is then a campaign like one a
/// person opened. Panel-only. A proposal older than seven days is over (`proposal_expired`).
pub async fn campaign_approve(
    d: &Deps,
    ctx: &Ctx,
    i: DecisionInput,
) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    let by = human_approver(ctx)?;
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    match c.state_at(ctx.now) {
        CampaignState::Proposed => {}
        CampaignState::Expired => {
            return Err(refuse(
                "proposal_expired",
                "the proposal is older than seven days",
            ));
        }
        _ => {
            return Err(refuse(
                "not_a_proposal",
                "the campaign is not waiting for approval",
            ));
        }
    }
    check_money(r.as_mut(), c.id, c.budget_minor, None, ctx.now).await?;
    c.approval = Some(CampaignApproval { by, at: ctx.now });
    // It starts when it was meant to, or now when that time passed while it waited.
    c.start_at = c.start_at.max(ctx.now);
    let out = save(r.as_mut(), ctx, c, "ads.campaign.approved").await?;
    r.commit().await?;
    Ok(out)
}

/// `ads.campaign_decline`: a person turns a proposal down, with why. Panel-only.
pub async fn campaign_decline(
    d: &Deps,
    ctx: &Ctx,
    i: DecisionInput,
) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    let by = human_approver(ctx)?;
    let reason = projects::text(
        i.reason.as_deref().unwrap_or(""),
        "reason",
        MAX_TEXT_CHARS,
        true,
    )?;
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    if c.state_at(ctx.now) != CampaignState::Proposed {
        return Err(refuse(
            "not_a_proposal",
            "the campaign is not waiting for approval",
        ));
    }
    c.declined = Some(CampaignDecline {
        by,
        at: ctx.now,
        reason,
    });
    let out = save(r.as_mut(), ctx, c, "ads.campaign.declined").await?;
    r.commit().await?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The agent's hold
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimInput {
    pub campaign_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClaimOut {
    pub campaign: AdCampaign,
    pub claim_token: String,
}

/// The agent connection calling: a campaign is planned by an agent, never by a person.
pub(crate) fn agent(ctx: &Ctx) -> Result<jt_tenancy::AgentConnectionId, AppError> {
    ctx.agent_connection_id
        .ok_or_else(|| AppError::forbidden("only an agent plans a campaign"))
}

/// The campaign's live claim when `token` is its bearer's and the caller is its agent.
pub(crate) fn live_claim(c: &AdCampaign, ctx: &Ctx, token: &str) -> Result<(), AppError> {
    let agent = agent(ctx)?;
    c.claim
        .as_ref()
        .filter(|k| {
            k.agent == agent && k.lease_until > ctx.now && k.token_hash == hash_token(token)
        })
        .map(|_| ())
        .ok_or_else(|| AppError::conflict("campaign claim is no longer live"))
}

/// `ads.campaign_claim`: an agent takes a campaign that waits for a plan (or whose ad the
/// provider turned down). One live claim per campaign.
pub async fn campaign_claim(d: &Deps, ctx: &Ctx, i: ClaimInput) -> Result<ClaimOut, AppError> {
    let agent = agent(ctx)?;
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    if !c.needs_agent(ctx.now) {
        return Err(AppError::conflict(
            "the campaign is not waiting for an agent",
        ));
    }
    let claim_token = d.tokens.token(32);
    c.claim = Some(CampaignClaim {
        agent,
        token_hash: hash_token(&claim_token),
        at: ctx.now,
        lease_until: ctx.now + CAMPAIGN_LEASE,
    });
    let campaign = save(r.as_mut(), ctx, c, "ads.campaign.claimed").await?;
    r.commit().await?;
    Ok(ClaimOut {
        campaign,
        claim_token,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseInput {
    pub campaign_id: Uuid,
    pub claim_token: String,
}

/// `ads.campaign_release`: the claim's agent lets the campaign go, for another to take.
pub async fn campaign_release(
    d: &Deps,
    ctx: &Ctx,
    i: ReleaseInput,
) -> Result<AdCampaign, AppError> {
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let mut c = load(r.as_mut(), i.campaign_id, None).await?;
    live_claim(&c, ctx, &i.claim_token)?;
    c.claim = None;
    let out = save(r.as_mut(), ctx, c, "ads.campaign.released").await?;
    r.commit().await?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Stopping, going on, ending, changing
// ---------------------------------------------------------------------------------------------

/// `ads.campaign_pause`: a person or an agent stops a campaign, with why (an agent may stop
/// what runs; only a person lets it go on). The campaign is paused at the provider at once.
pub async fn campaign_pause(d: &Deps, ctx: &Ctx, i: DecisionInput) -> Result<AdCampaign, AppError> {
    let reason = projects::text(
        i.reason.as_deref().unwrap_or(""),
        "reason",
        MAX_TEXT_CHARS,
        true,
    )?;
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    if c.closed_at(ctx.now) || c.state_at(ctx.now) == CampaignState::Proposed {
        return Err(refuse(
            "not_running",
            "the campaign is not one that can be stopped",
        ));
    }
    if c.stop.is_none() {
        c.stop = Some(CampaignStop {
            by: if library::person(ctx).is_some() {
                StopBy::Person
            } else {
                StopBy::Agent
            },
            at: ctx.now,
            reason,
        });
        let _ = save(r.as_mut(), ctx, c, "ads.campaign.paused").await?;
        r.commit().await?;
    } else {
        drop(r);
    }
    watch::follow(d, ctx.workspace_id, i.campaign_id).await
}

/// `ads.campaign_resume`: a person lets a stopped campaign go on. Panel-only. A campaign the
/// budget stopped goes on by itself when the budget allows it (`stopped_by_budget`).
pub async fn campaign_resume(
    d: &Deps,
    ctx: &Ctx,
    i: DecisionInput,
) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    human_approver(ctx)?;
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    match &c.stop {
        None => return Err(refuse("not_stopped", "the campaign is not stopped")),
        Some(stop) if stop.by == StopBy::Budget => {
            return Err(refuse(
                "stopped_by_budget",
                "the budget stopped this campaign: it goes on when the budget allows it",
            ));
        }
        Some(_) => {}
    }
    if c.closed_at(ctx.now) {
        return Err(refuse("not_running", "the campaign is over"));
    }
    let account = match c.built.as_ref().map(|b| b.account) {
        Some(id) => r.capabilities().find(id).await?,
        None => None,
    };
    let amount = c.committed_minor(ctx.now);
    check_money(r.as_mut(), c.id, amount, account.as_ref(), ctx.now).await?;
    c.stop = None;
    let _ = save(r.as_mut(), ctx, c, "ads.campaign.resumed").await?;
    r.commit().await?;
    watch::follow(d, ctx.workspace_id, i.campaign_id).await
}

/// `ads.campaign_end`: a person ends a campaign for good. Panel-only. What it has not spent is
/// free again; at the provider it is paused.
pub async fn campaign_end(d: &Deps, ctx: &Ctx, i: DecisionInput) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    human_approver(ctx)?;
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    if c.closed_at(ctx.now) {
        return Err(refuse("not_running", "the campaign is over"));
    }
    c.ended = Some(CampaignEnd {
        at: ctx.now,
        reason: EndReason::Person,
    });
    c.claim = None;
    let _ = save(r.as_mut(), ctx, c, "ads.campaign.ended").await?;
    r.commit().await?;
    watch::follow(d, ctx.workspace_id, i.campaign_id).await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateInput {
    pub campaign_id: Uuid,
    pub expected_revision: u64,
    #[serde(default)]
    pub budget_minor: Option<i64>,
    /// A new end time, or `null` to leave it to the plan.
    #[serde(default, deserialize_with = "double_option")]
    pub end_at: Option<Option<String>>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// `ads.campaign_update`: a person changes a campaign's budget or end date. Panel-only. Only
/// while nothing is built: what is at the provider carries the budget and the end it was built
/// with (`already_built`); end it and open another to change those.
pub async fn campaign_update(d: &Deps, ctx: &Ctx, i: UpdateInput) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsManage)?;
    human_approver(ctx)?;
    if i.budget_minor.is_none() && i.end_at.is_none() {
        return Err(crate::usecases::nothing_to_change(&[
            "budget_minor",
            "end_at",
        ]));
    }
    let mut r = open_tx(d, ctx, Permission::AdsManage).await?;
    let mut c = load(r.as_mut(), i.campaign_id, Some(i.expected_revision)).await?;
    if c.closed_at(ctx.now) {
        return Err(refuse("not_running", "the campaign is over"));
    }
    if c.built.is_some() {
        return Err(refuse(
            "already_built",
            "the campaign is built at the provider with its budget and end date",
        ));
    }
    if let Some(budget) = i.budget_minor {
        if budget <= 0 {
            return Err(invalid("budget_minor", "positive"));
        }
        c.budget_minor = budget;
    }
    if let Some(end) = i.end_at {
        // Judged against the campaign's own start, not against now.
        c.end_at = match end {
            None => None,
            Some(end) => {
                let end = instant(&end, "end_at")?;
                if end - c.start_at < MIN_RUN || end - c.start_at > MAX_RUN {
                    return Err(invalid("end_at", "24_hours_to_90_days_after_the_start"));
                }
                Some(end)
            }
        };
    }
    if c.state_at(ctx.now) != CampaignState::Proposed {
        check_money(r.as_mut(), c.id, c.budget_minor, None, ctx.now).await?;
    }
    let out = save(r.as_mut(), ctx, c, "ads.campaign.updated").await?;
    r.commit().await?;
    Ok(out)
}

/// The input schema of `ads.<name>`, as the MCP tool and the panel route take it.
pub fn schema(name: &str) -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    let time = json!({"type":"string","format":"date-time"});
    let revision = json!({"type":"integer","minimum":0});
    let text = |max: usize| json!({"type":"string","minLength":1,"maxLength":max});
    let (properties, required): (Value, Vec<&str>) = match name {
        "campaigns_list" => (
            json!({"scope":{"type":["string","null"],"enum":["open","closed",null]},
                   "before":{"type":["string","null"],"format":"date-time"}}),
            vec![],
        ),
        "campaign_get" => (json!({"campaign_id":uuid}), vec!["campaign_id"]),
        "campaign_propose" => (
            json!({"request_key":text(200),"goal":text(MAX_TEXT_CHARS),
                   "budget_minor":{"type":"integer","minimum":1,
                       "description":"The whole campaign budget, in minor units of the general ad budget's currency."},
                   "start_at":time,"end_at":{"type":["string","null"],"format":"date-time"},
                   "reason":text(MAX_TEXT_CHARS)}),
            vec!["request_key", "goal", "budget_minor", "start_at", "reason"],
        ),
        "campaign_claim" => (
            json!({"campaign_id":uuid,"expected_revision":revision}),
            vec!["campaign_id", "expected_revision"],
        ),
        "campaign_release" => (
            json!({"campaign_id":uuid,"claim_token":text(200)}),
            vec!["campaign_id", "claim_token"],
        ),
        "campaign_pause" => (
            json!({"campaign_id":uuid,"expected_revision":revision,"reason":text(MAX_TEXT_CHARS)}),
            vec!["campaign_id", "expected_revision", "reason"],
        ),
        "plan_submit" => (
            json!({"campaign_id":uuid,"claim_token":text(200),"request_key":text(200),
                   "plan":plan::plan_schema()}),
            vec!["campaign_id", "claim_token", "request_key", "plan"],
        ),
        "campaign_move" => (
            json!({"campaign_id":uuid,"request_key":text(200),"move":watch::move_schema()}),
            vec!["campaign_id", "request_key", "move"],
        ),
        "ad_preview" => (
            json!({"campaign_id":uuid,"index":{"type":"integer","minimum":0},
                   "placement":{"type":"string","enum":["facebook_feed","instagram_feed","instagram_story","instagram_reels"]}}),
            vec!["campaign_id", "index", "placement"],
        ),
        other => panic!("no schema for ads.{other}"),
    };
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
