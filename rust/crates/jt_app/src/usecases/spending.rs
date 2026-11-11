//! Bütçe's view of spending and its stop switches (design 2026-11-10 §9; S6, S7, B36).
//!
//! **What was spent, by module.** Three records hold spend, and the breakdown reads all three:
//! spend entries (`budget_spend_entries`: what a person, an agent or a job recorded, with the
//! module it belongs to when one spent it), settled spend reservations (a message or a post
//! whose provider cost is known) and the daily spend an ad platform reports for a bound ad set.
//! A spend no module made (one recorded by hand) is counted apart, never guessed into a module.
//!
//! **Stopping.** A person stops all spending, or one module's. Stopping stops spending only
//! (B36): what costs no money goes on. Advertising is stopped by the paid lane's brake, which
//! also pauses what runs at the ad platform; every other module is refused at the one spend
//! gate (`reserve_connector_spend`), and a call before it is placed.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::TenantRepos,
    usecases::{
        Deps, ledger_entry,
        studio::{chain, control::human_approver},
    },
};
use jt_capability::{BudgetItemId, SPEND_MODULES};
use jt_strategy::LaneKind;
use jt_studio::{SpendOutcome, SpendStop};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

/// `CONFLICT` (`spend_stopped`) when a person stopped the spending of `module`, or all spending.
/// A plain read: it holds no lock, so a stop takes effect on the next call.
pub(crate) async fn refuse_if_stopped(
    r: &mut dyn TenantRepos,
    module: &str,
) -> Result<(), AppError> {
    if r.studio_control().spend_stop().await?.stops(module) {
        return Err(chain::refuse("spend_stopped"));
    }
    Ok(())
}

/// What is stopped, and what a stop is still pausing at a provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StopState {
    /// The control's revision: a change names the one it saw.
    pub revision: u64,
    pub all: bool,
    /// The modules whose spending is stopped; `ads` while the paid lane's brake is engaged.
    pub modules: Vec<String>,
    pub paused: Vec<PausedSpend>,
}

/// One thing a stop pauses at its provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PausedSpend {
    pub module: String,
    pub title: String,
    /// `paused`: the provider confirmed it; `pausing`: asked, not confirmed yet.
    pub state: &'static str,
}

async fn stop_state(r: &mut dyn TenantRepos) -> Result<StopState, AppError> {
    let control = r.studio_control().lock_control().await?;
    let paid = control.brake_engaged_for(LaneKind::Paid);
    let mut modules: Vec<String> = control.spend_stopped.modules.iter().cloned().collect();
    let mut paused = Vec::new();
    if paid {
        modules.push("ads".into());
        for binding in r.studio().list_bindings().await? {
            let confirmed = r
                .studio_control()
                .binding_control(binding.id)
                .await?
                .is_some_and(|c| c.confirmed_paused());
            paused.push(PausedSpend {
                module: "ads".into(),
                title: binding.adset_id.clone(),
                state: if confirmed { "paused" } else { "pausing" },
            });
        }
        // The ad campaigns Jeeta built that were running: paused at the provider, or about to.
        for c in r
            .ads()
            .list_campaigns(crate::ports::ads::CampaignScope::Open, None)
            .await?
        {
            if let Some(built) = &c.built
                && built.activated_at.is_some()
            {
                paused.push(PausedSpend {
                    module: "ads".into(),
                    title: c.title.clone(),
                    state: if built.provider_paused {
                        "paused"
                    } else {
                        "pausing"
                    },
                });
            }
        }
    }
    modules.sort();
    Ok(StopState {
        revision: control.revision,
        // The workspace-wide brake (`studio.brake` without a lane) stops every spend that
        // passes the gate, as stopping all spending here does: both read as "all".
        all: control.spend_stopped.all || control.brake_engaged,
        modules,
        paused,
    })
}

/// A period to read spend in: both ends RFC 3339, `from` included and `until` not; left out, the
/// current calendar month so far.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BreakdownQuery {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CampaignSpend {
    pub campaign_id: Uuid,
    pub title: String,
    pub spent_minor: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModuleSpend {
    pub module: String,
    pub spent_minor: i64,
    /// For advertising: the ad campaigns Jeeta built, each with its share.
    pub campaigns: Vec<CampaignSpend>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ItemBreakdown {
    pub item_id: BudgetItemId,
    /// The modules that spent from the item in the period, in the order of [`SPEND_MODULES`].
    pub modules: Vec<ModuleSpend>,
    /// What no module spent: entries a person or an agent recorded by hand.
    pub unattributed_minor: i64,
    /// The general ad budget only: what open ad campaigns still hold of it (their unspent
    /// budgets), which no other campaign can take. Left out when nothing is held.
    #[serde(skip_serializing_if = "is_zero")]
    pub held_minor: i64,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Breakdown {
    pub items: Vec<ItemBreakdown>,
    pub stop: StopState,
}

fn instant(value: Option<&str>, field: &str) -> Result<Option<OffsetDateTime>, AppError> {
    value
        .map(|v| {
            OffsetDateTime::parse(v, &Rfc3339).map_err(|_| {
                AppError::validation(
                    "an RFC 3339 time",
                    json!({"field": field, "reason": "rfc3339"}),
                )
            })
        })
        .transpose()
}

/// `budget.breakdown`: what each live budget item spent in a period, by module and, for
/// advertising, by ad campaign; and what is stopped. For whoever manages the budget or works in
/// a module.
pub async fn breakdown(d: &Deps, ctx: &Ctx, q: BreakdownQuery) -> Result<Breakdown, AppError> {
    ctx.require_any(&[
        Permission::BudgetManage,
        Permission::AdsWork,
        Permission::SocialWork,
        Permission::ContentWork,
        Permission::InboxWork,
        Permission::CallsWork,
    ])?;
    // Left out, the period reaches up to and including this moment.
    let until =
        instant(q.until.as_deref(), "until")?.unwrap_or(ctx.now + time::Duration::nanoseconds(1));
    let from = match instant(q.from.as_deref(), "from")? {
        Some(from) => from,
        None => until
            .replace_day(1)
            .map_or(until, |d| d.replace_time(time::Time::MIDNIGHT)),
    };
    if from >= until || until - from > time::Duration::days(366) {
        return Err(AppError::validation(
            "a period of at most 366 days",
            json!({"field": "from", "reason": "period_of_at_most_366_days"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    // (item, module or none, campaign or none) → amount
    let mut sums: BTreeMap<(BudgetItemId, Option<String>, Option<Uuid>), i128> = BTreeMap::new();
    for slice in r.budget().spend_slices(from, until).await? {
        *sums
            .entry((slice.budget_item_id, slice.module, slice.campaign_id))
            .or_default() += i128::from(slice.amount);
    }
    // A message or a post whose provider cost is known.
    for (reservation, outcome) in r.studio_budget().list_reservations().await? {
        let Some(SpendOutcome::Settled { actual_minor, .. }) = outcome else {
            continue;
        };
        let request = &reservation.request;
        if actual_minor <= 0 || request.at < from || request.at >= until {
            continue;
        }
        for item in &request.budget_item_ids {
            *sums
                .entry((
                    *item,
                    Some(request.spending_module().to_owned()),
                    request.campaign_id,
                ))
                .or_default() += i128::from(actual_minor);
        }
    }
    // What an ad platform reports for a bound ad set, day by day: the latest reading of a day.
    let bindings = r.studio().list_bindings().await?;
    let mut days: BTreeMap<(jt_studio::AdSetBindingId, time::Date), &jt_studio::Measurement> =
        BTreeMap::new();
    let measurements = r.studio().list_measurements().await?;
    for m in &measurements {
        let (Some(binding), Some(day)) = (m.binding_id, m.date) else {
            continue;
        };
        if m.raw_metrics
            .get("spend_minor")
            .copied()
            .flatten()
            .is_none()
        {
            continue;
        }
        if days
            .get(&(binding, day))
            .is_none_or(|old| old.evidence_revision < m.evidence_revision)
        {
            days.insert((binding, day), m);
        }
    }
    for ((binding, day), m) in days {
        let at = day.midnight().assume_utc();
        let spent = m.raw_metrics["spend_minor"].unwrap_or(0);
        if spent <= 0 || at < from || at >= until {
            continue;
        }
        let Some(binding) = bindings.iter().find(|b| b.id == binding) else {
            continue;
        };
        let Some(capability) = r.capabilities().find(binding.capability_id).await? else {
            continue;
        };
        for item in &capability.budget_item_ids {
            *sums.entry((*item, Some("ads".into()), None)).or_default() += i128::from(spent);
        }
    }
    let amount = |n: i128| i64::try_from(n).unwrap_or(i64::MAX);
    let mut items = Vec::new();
    for item in r.budget().list_items().await? {
        if item.retired_at.is_some() {
            continue;
        }
        let of_item: Vec<_> = sums
            .iter()
            .filter(|((id, _, _), _)| *id == item.id)
            .collect();
        let mut modules = Vec::new();
        for module in SPEND_MODULES {
            let of_module: Vec<_> = of_item
                .iter()
                .filter(|((_, m, _), _)| m.as_deref() == Some(module))
                .collect();
            if of_module.is_empty() {
                continue;
            }
            let mut campaigns = Vec::new();
            for ((_, _, campaign), spent) in &of_module {
                if let Some(campaign_id) = campaign {
                    campaigns.push(CampaignSpend {
                        campaign_id: *campaign_id,
                        title: campaign_title(r.as_mut(), *campaign_id).await?,
                        spent_minor: amount(**spent),
                    });
                }
            }
            modules.push(ModuleSpend {
                module: module.to_owned(),
                spent_minor: amount(of_module.iter().map(|(_, n)| **n).sum()),
                campaigns,
            });
        }
        // Held now, whatever the period asked for: a commitment is not a spend of a day.
        let held_minor = match &item.unit {
            jt_capability::Unit::Currency(currency) if item.general => amount(
                crate::usecases::ads::committed(r.as_mut(), currency, None, None, ctx.now).await?,
            ),
            _ => 0,
        };
        items.push(ItemBreakdown {
            item_id: item.id,
            held_minor,
            modules,
            unattributed_minor: amount(
                of_item
                    .iter()
                    .filter(|((_, m, _), _)| m.is_none())
                    .map(|(_, n)| **n)
                    .sum(),
            ),
        });
    }
    let stop = stop_state(r.as_mut()).await?;
    Ok(Breakdown { items, stop })
}

/// The title of ad campaign `id`, empty when it is not there any more.
async fn campaign_title(r: &mut dyn TenantRepos, id: Uuid) -> Result<String, AppError> {
    Ok(r.ads()
        .get_campaign(id)
        .await?
        .map(|c| c.title)
        .unwrap_or_default())
}

/// What to stop or let go on: all spending, or one module's.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopScope {
    All,
    #[serde(untagged)]
    Module {
        module: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StopInput {
    pub scope: StopScope,
    pub stopped: bool,
    pub expected_revision: u64,
}

/// `budget.stop`: a person stops all spending or one module's, or lets it go on (S7). Panel-only
/// and a person's in person. Stopping advertising, or all spending, engages the paid lane's
/// brake, so what runs at the ad platform is paused there too; letting it go on releases it.
/// Answers the stop state.
pub async fn stop(d: &Deps, ctx: &Ctx, i: StopInput) -> Result<StopState, AppError> {
    ctx.require(Permission::BudgetManage)?;
    human_approver(ctx)?;
    if let StopScope::Module { module } = &i.scope
        && !SPEND_MODULES.contains(&module.as_str())
    {
        return Err(AppError::validation(
            "a module that spends",
            json!({"field": "scope", "reason": "not_a_spending_module", "modules": SPEND_MODULES}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    let control = r.studio_control().lock_control().await?;
    let mut next: SpendStop = control.spend_stopped.clone();
    let paid_brake = match &i.scope {
        StopScope::All => {
            next.all = i.stopped;
            Some(i.stopped)
        }
        StopScope::Module { module } if module == "ads" => Some(i.stopped),
        StopScope::Module { module } => {
            if i.stopped {
                next.modules.insert(module.clone());
            } else {
                next.modules.remove(module);
            }
            None
        }
    };
    // Letting all spending go on also releases a workspace-wide brake: nothing stays stopped.
    let release_workspace_brake = i.scope == StopScope::All && !i.stopped;
    r.studio_control()
        .set_spend_stop(
            i.expected_revision,
            next,
            paid_brake,
            release_workspace_brake,
        )
        .await?;
    let scope = match &i.scope {
        StopScope::All => json!("all"),
        StopScope::Module { module } => json!({ "module": module }),
    };
    r.ledger()
        .append(ledger_entry(
            ctx,
            "budget.stop",
            "studio_control",
            ctx.workspace_id,
            json!({"scope": scope, "stopped": i.stopped}),
        )?)
        .await?;
    r.commit().await?;
    // What runs at the ad platform follows the paid lane's brake; the scheduler asks again.
    if paid_brake.is_some() {
        let _ = crate::usecases::studio::control::reconcile_bindings(d, ctx.workspace_id).await;
        let _ = crate::usecases::ads::watch::watch_all(d, ctx.workspace_id, ctx.now).await;
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    stop_state(r.as_mut()).await
}
