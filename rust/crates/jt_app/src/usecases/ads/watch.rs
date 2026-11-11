//! Watching and improving a running campaign (design 2026-11-10 §8.6): the provider follows
//! what Jeeta decided (a stop pauses it there, letting it go on activates it), what the
//! provider reports is recorded (each ad's state and review feedback, its daily numbers, the
//! spend), an ad that is held and still runs there is paused again, a campaign ends at its end
//! date or when its budget is spent, every campaign stops
//! while the general ad budget's period is exhausted or a person stopped the spending, and the
//! agent's moves are applied and kept with their reasons.
//!
//! A number the provider does not give is absent, never zero.
use super::{
    build::{self, record, runs, system},
    general_budget, load, open_tx, plan, platform, refuse, save,
};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        ads::*,
        connectors::{AdObjective, AdPlacement, AdStatus, ProviderAdStatus},
    },
    usecases::{Deps, modules, studio::files},
};
use jt_capability::period_window;
use jt_strategy::LaneKind;
use jt_tenancy::{Permission, WorkspaceId, WorkspaceStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// How often the provider is asked how campaign `c` stands: its platform's interval (an hour;
/// shorter on a platform whose own budget limit is not a hard one, B67).
fn watch_every(c: &AdCampaign) -> Duration {
    let platform = c.built.as_ref().map(|b| b.platform).unwrap_or_default();
    Duration::minutes(platform::rules(platform).watch_minutes)
}

/// Makes the provider follow campaign `id` now (a stop pauses it, a release or a finished build
/// activates it) and answers the campaign as it then stands. A provider that cannot be reached
/// changes nothing here: the watch asks again.
pub(crate) async fn follow(d: &Deps, ws: WorkspaceId, id: Uuid) -> Result<AdCampaign, AppError> {
    let now = d.clock.now();
    let _ = follow_provider(d, ws, id, now).await;
    let mut r = d.uow.tenant(ws).await?;
    Ok(r.ads()
        .get_campaign(id)
        .await?
        .ok_or_else(|| AppError::not_found("ad campaign"))?
        .present(now))
}

async fn follow_provider(
    d: &Deps,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let c = {
        let mut r = d.uow.tenant(ws).await?;
        match r.ads().get_campaign(id).await? {
            Some(c) => c,
            None => return Ok(()),
        }
    };
    let Some(built) = &c.built else {
        return Ok(());
    };
    let running = runs(&c, now);
    if running && built.activated_at.is_none() {
        // Not activated yet: the build goes on, and activates when the money holds.
        return build::run(d, ws, id, now).await;
    }
    let Some(campaign_id) = built.campaign_id.clone() else {
        return Ok(());
    };
    if built.activated_at.is_none() || built.provider_paused != running {
        // Already as it should be: paused and stopped, or running and not paused.
        return Ok(());
    }
    let Some(a) = build::account(d, &c).await? else {
        return Ok(());
    };
    let status = if running {
        AdStatus::Active
    } else {
        AdStatus::Paused
    };
    if a.status
        .set_status(&a.credential, &campaign_id, status)
        .await
        .is_ok()
    {
        record(d, ws, id, now, "ads.campaign.provider_followed", move |c| {
            if let Some(b) = &mut c.built {
                b.provider_paused = !running;
            }
        })
        .await?;
    }
    Ok(())
}

fn built_status(status: &ProviderAdStatus) -> BuiltAdStatus {
    match status {
        ProviderAdStatus::Active => BuiltAdStatus::Active,
        ProviderAdStatus::Paused | ProviderAdStatus::Archived => BuiltAdStatus::Paused,
        ProviderAdStatus::Disapproved => BuiltAdStatus::Disapproved,
        ProviderAdStatus::InReview | ProviderAdStatus::WithIssues | ProviderAdStatus::Other(_) => {
            BuiltAdStatus::InReview
        }
    }
}

/// Reads how campaign `c` stands at the provider and what it brought, and records it: each
/// ad's state and feedback, the daily numbers, the spend that is new, and its end when its end
/// date passed or its budget is spent.
async fn read(d: &Deps, c: &AdCampaign, now: OffsetDateTime) -> Result<bool, AppError> {
    let Some(built) = c.built.clone() else {
        return Ok(false);
    };
    let (Some(campaign_id), Some(a)) = (built.campaign_id.clone(), build::account(d, c).await?)
    else {
        return Ok(false);
    };
    let Ok(state) = a
        .writer
        .campaign_state(&a.credential, &a.public, &campaign_id)
        .await
    else {
        return Ok(false);
    };
    let days = a
        .writer
        .ad_days(
            &a.credential,
            &a.public,
            &campaign_id,
            // What counts as a result is what the campaign is for.
            match c.plan.as_ref().map(|p| p.result) {
                Some(AdResult::LeadForm) => AdObjective::Leads,
                _ => AdObjective::Traffic,
            },
            c.start_at.date(),
            now.date(),
        )
        .await
        .ok();
    let (ws, id) = (c.workspace_id, c.id);
    let mut r = d.uow.tenant(ws).await?;
    let mut c = load(r.as_mut(), id, None).await?;
    let Some(b) = &mut c.built else {
        return Ok(false);
    };
    // The ads that should be quiet and are not: one a move holds, or one a fix replaced, that
    // the provider still reports as running (its pause never arrived, or the provider could
    // not take it then). They are paused again after this reading is stored.
    let mut quiet: Vec<String> = Vec::new();
    for ad in &mut b.ads {
        for seen in &state.ads {
            // (An adapter that knows an ad by what it says may hand back, for a fix that says
            // what an earlier ad of this place said, that earlier ad: then it is the place's
            // own ad again, not one to keep quiet.)
            if seen.status == ProviderAdStatus::Active
                && ad.replaced_ad_ids.contains(&seen.ad_id)
                && ad.ad_id.as_ref() != Some(&seen.ad_id)
            {
                quiet.push(seen.ad_id.clone());
            }
        }
        let Some(seen) = state
            .ads
            .iter()
            .find(|p| Some(&p.ad_id) == ad.ad_id.as_ref())
        else {
            continue;
        };
        ad.status = built_status(&seen.status);
        ad.feedback = seen.feedback.clone();
        if ad.held && seen.status == ProviderAdStatus::Active {
            quiet.push(seen.ad_id.clone());
        }
    }
    b.watched_at = Some(now);
    if let Some(days) = days {
        for day in days {
            // An ad that was replaced keeps its place: its numbers stay the place's.
            let Some(index) = b
                .ads
                .iter()
                .find(|ad| {
                    ad.ad_id.as_ref() == Some(&day.ad_id) || ad.replaced_ad_ids.contains(&day.ad_id)
                })
                .map(|ad| ad.index)
            else {
                continue;
            };
            let row = AdDayRow {
                day: day.day,
                ad: index,
                spent_minor: day.spend_minor,
                impressions: day.impressions,
                clicks: day.clicks,
                results: day.results,
            };
            match c
                .results
                .iter_mut()
                .find(|x| x.day == row.day && x.ad == row.ad)
            {
                Some(old) => *old = row,
                None => c.results.push(row),
            }
        }
    }
    // What the provider reports as spent and is not in the budget's entries yet.
    let delta = c.spent_minor() - c.recorded_spend_minor;
    if delta > 0
        && let Ok(general) = general_budget(r.as_mut()).await
    {
        crate::usecases::budget::spend_in_for(
            d,
            &system(ws, now),
            r.as_mut(),
            general.id,
            delta,
            Some(format!("ads:{id}")),
            Some("ads"),
            Some(id),
        )
        .await?;
        c.recorded_spend_minor += delta;
    }
    let over = if c.spent_minor() >= c.budget_minor {
        Some(EndReason::BudgetSpent)
    } else if c.end_at.is_some_and(|end| end <= now) {
        Some(EndReason::EndDate)
    } else {
        None
    };
    // A campaign that is over already keeps the end it has: it is only read for its last spend.
    if let Some(reason) = over
        && c.ended.is_none()
    {
        c.ended = Some(CampaignEnd { at: now, reason });
        c.claim = None;
    }
    save(r.as_mut(), &system(ws, now), c, "ads.campaign.watched").await?;
    r.commit().await?;
    for ad_id in quiet {
        // Best effort: the next reading sees whether it held, and asks again.
        let _ = a
            .status
            .set_status(&a.credential, &ad_id, AdStatus::Paused)
            .await;
    }
    Ok(true)
}

/// The reason a stop of the budget carries while a person stopped the spending.
const SPEND_STOPPED: &str = "spend_stopped";
/// The reason a stop of the budget carries while the general ad budget's period is exhausted.
const BUDGET_EXHAUSTED: &str = "budget_exhausted";
/// The reason a stop of the budget carries while the ads module is not installed: with nobody
/// looking at the ads, nothing may run.
const MODULE_REMOVED: &str = "module_removed";
/// The reason a stop of the budget carries while the workspace is not active (not paid for, or
/// suspended): its panel is closed, so nobody could see the ads or stop them; nothing may run.
const WORKSPACE_INACTIVE: &str = "workspace_inactive";

/// One pass over the workspace's campaigns (the `studio_control` job): proposals that ran out
/// close; builds go on; every running campaign stops while a person stopped the spending or
/// the general ad budget's period is exhausted, and goes on when that is over (B31); the
/// provider follows; and once an hour each built campaign is read. In a workspace that is not
/// active, or without the ads module, nothing is built and what runs is stopped the same way
/// (B51, B52), and goes on when the workspace is active and the module installed again. Answers
/// how many campaigns changed.
pub async fn watch_all(d: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u32, AppError> {
    let (campaigns, closing, hold) = {
        let mut r = d.uow.tenant(ws).await?;
        let active = r.workspace().get().await?.status == WorkspaceStatus::Active;
        let campaigns = r.ads().list_campaigns(CampaignScope::Open, None).await?;
        let closing = r.ads().list_winding_down(now - SETTLE_WINDOW).await?;
        if campaigns.is_empty() && closing.is_empty() {
            return Ok(0);
        }
        let hold = if !active {
            Some(WORKSPACE_INACTIVE)
        } else if !modules::installed(r.as_mut(), modules::ADS).await? {
            Some(MODULE_REMOVED)
        } else {
            let control = r.studio_control().lock_control().await?;
            let stopped = control.is_braked(LaneKind::Paid) || control.spend_stopped.stops("ads");
            let exhausted = match general_budget(r.as_mut()).await {
                Ok(general) => {
                    let (from, until) = period_window(general.period, now);
                    r.budget().spent_between(general.id, from, until).await? >= general.cap
                }
                // No general ad budget any more: nothing may be spent on ads.
                Err(_) => true,
            };
            if stopped {
                Some(SPEND_STOPPED)
            } else if exhausted {
                Some(BUDGET_EXHAUSTED)
            } else {
                None
            }
        };
        (campaigns, closing, hold)
    };
    let mut changed = 0;
    for c in campaigns {
        let id = c.id;
        if c.state_at(now) == CampaignState::Expired {
            // Stored once more so that it carries its closed mark.
            record(d, ws, id, now, "ads.campaign.expired", |_| {}).await?;
            changed += 1;
            continue;
        }
        if c.built.is_none() || c.closed_at(now) {
            continue;
        }
        // The budget's own stop: set while it holds, lifted when it is over. A person's or an
        // agent's stop is theirs and is left alone.
        match (&c.stop, hold) {
            (None, Some(reason)) => {
                record(d, ws, id, now, "ads.campaign.stopped_by_budget", move |c| {
                    c.stop = Some(CampaignStop {
                        by: StopBy::Budget,
                        at: now,
                        reason: reason.into(),
                    });
                })
                .await?;
                changed += 1;
            }
            (Some(stop), None) if stop.by == StopBy::Budget => {
                record(d, ws, id, now, "ads.campaign.released_by_budget", |c| {
                    c.stop = None
                })
                .await?;
                changed += 1;
            }
            _ => {}
        }
        let _ = follow_provider(d, ws, id, now).await;
        let due = c.built.as_ref().is_some_and(|b| {
            b.activated_at.is_some() && b.watched_at.is_none_or(|at| now - at >= watch_every(&c))
        });
        if due && read(d, &c, now).await? {
            changed += 1;
            // A campaign that just ended is paused at the provider.
            let _ = follow_provider(d, ws, id, now).await;
        }
    }
    // A campaign that is over is followed until it is quiet at the provider: its pause is tried
    // again until the provider confirms it, and what the provider still reports as spent is
    // read for two days after its end, so that the last hours before the end are not lost.
    for c in closing {
        let _ = follow_provider(d, ws, c.id, now).await;
        let due = c
            .built
            .as_ref()
            .is_some_and(|b| b.watched_at.is_none_or(|at| now - at >= watch_every(&c)));
        if due && read(d, &c, now).await? {
            changed += 1;
        }
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------------------------
// The agent's moves
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Move {
    PauseAd {
        ad: usize,
        reason: String,
    },
    ResumeAd {
        ad: usize,
        reason: String,
    },
    AddAd {
        ad: PlanAd,
        reason: String,
    },
    /// Replaces the ad the provider turned down with a new one in its place.
    FixAd {
        ad: usize,
        with: PlanAd,
        reason: String,
    },
    /// Looked, changed nothing, and why.
    None {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveInput {
    pub campaign_id: Uuid,
    pub request_key: String,
    #[serde(rename = "move")]
    pub change: Move,
}

/// `ads.campaign_move`: an agent (or a person) changes a built campaign's ads, with why: pause
/// or resume one, add one (at most six), replace one the provider turned down, or record that
/// it looked and changed nothing. A new ad is checked as a plan's ad is; one that does not hold
/// is refused with its findings (`move_refused`), and the refusal is kept on the campaign. The
/// campaign's budget and end date are not a move's to change.
pub async fn campaign_move(d: &Deps, ctx: &Ctx, i: MoveInput) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsWork)?;
    files::key(&i.request_key)?;
    let payload = serde_json::to_value(&i)?;
    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let version = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    if r.studio()
        .request_replay("ads.campaign_move", &i.request_key, &payload)
        .await?
        .is_some()
    {
        let c = r.ads().get_campaign(i.campaign_id).await?;
        return Ok(c
            .ok_or_else(|| AppError::not_found("ad campaign"))?
            .present(ctx.now));
    }
    let mut c = load(r.as_mut(), i.campaign_id, None).await?;
    if c.closed_at(ctx.now) || c.built.is_none() || c.plan.is_none() {
        return Err(refuse(
            "not_built",
            "a move changes a campaign that is built and not over",
        ));
    }
    let (kind, ad, reason) = match &i.change {
        Move::PauseAd { ad, reason } => (MoveKind::PauseAd, Some(*ad), reason),
        Move::ResumeAd { ad, reason } => (MoveKind::ResumeAd, Some(*ad), reason),
        Move::AddAd { reason, .. } => (MoveKind::AddAd, None, reason),
        Move::FixAd { ad, reason, .. } => (MoveKind::FixAd, Some(*ad), reason),
        Move::None { reason } => (MoveKind::None, None, reason),
    };
    let reason =
        crate::usecases::studio::projects::text(reason, "move.reason", MAX_TEXT_CHARS, true)?;
    let count = c.built.as_ref().map_or(0, |b| b.ads.len());
    if ad.is_some_and(|n| n >= count) {
        return Err(AppError::validation(
            "no such ad",
            json!({"field": "move.ad", "reason": "no_such_ad"}),
        ));
    }
    let (account, rules) = c
        .built
        .as_ref()
        .map(|b| (b.account, platform::rules(b.platform)))
        .expect("built");
    let hypotheses = r.hypotheses().list(version.id).await?;
    // What the provider is asked afterwards: (ad id, paused).
    let mut provider: Vec<(String, bool)> = Vec::new();
    let mut held: Vec<Value> = Vec::new();
    match &i.change {
        Move::PauseAd { ad, .. } | Move::ResumeAd { ad, .. } => {
            let paused = matches!(i.change, Move::PauseAd { .. });
            let b = c.built.as_mut().expect("built");
            b.ads[*ad].held = paused;
            if let Some(id) = b.ads[*ad].ad_id.clone() {
                provider.push((id, paused));
            }
        }
        Move::AddAd { ad, .. } => {
            plan::ad_shape(ad, "move.ad", rules)?;
            plan::distinct(ad, &c.plan.as_ref().expect("planned").ads, "move.ad", rules)?;
            if count >= MAX_ADS {
                held.push(json!({"field": "move.ad", "reason": "six_ads_at_most"}));
            } else {
                held = plan::ad_findings(
                    r.as_mut(),
                    ad,
                    "move.ad",
                    account,
                    rules,
                    &hypotheses,
                    ctx.now,
                )
                .await?;
            }
            if held.is_empty() {
                c.plan.as_mut().expect("planned").ads.push(ad.clone());
                c.built.as_mut().expect("built").ads.push(BuiltAd {
                    index: count,
                    status: BuiltAdStatus::InReview,
                    feedback: None,
                    image_hash: None,
                    creative_id: None,
                    ad_id: None,
                    held: false,
                    generation: 0,
                    replaced_ad_ids: Vec::new(),
                });
            }
        }
        Move::FixAd { ad, with, .. } => {
            plan::ad_shape(with, "move.with", rules)?;
            // The ad it replaces included: a fix that says the same again fixes nothing.
            plan::distinct(
                with,
                &c.plan.as_ref().expect("planned").ads,
                "move.with",
                rules,
            )?;
            held = plan::ad_findings(
                r.as_mut(),
                with,
                "move.with",
                account,
                rules,
                &hypotheses,
                ctx.now,
            )
            .await?;
            if held.is_empty() {
                c.plan.as_mut().expect("planned").ads[*ad] = with.clone();
                let made = &mut c.built.as_mut().expect("built").ads[*ad];
                // The ad it replaces stays paused; the new one is built in its place.
                if let Some(old) = made.ad_id.take() {
                    provider.push((old.clone(), true));
                    made.replaced_ad_ids.push(old);
                }
                made.image_hash = None;
                made.creative_id = None;
                made.generation += 1;
                made.status = BuiltAdStatus::InReview;
                made.feedback = None;
                made.held = false;
            }
        }
        Move::None { .. } => {}
    }
    let refused = !held.is_empty();
    c.moves.push(CampaignMove {
        at: ctx.now,
        kind,
        ad,
        reason,
        outcome: if refused {
            MoveOutcome::Refused
        } else {
            MoveOutcome::Done
        },
        detail: held
            .first()
            .and_then(|f| f["reason"].as_str())
            .map(str::to_owned),
    });
    let running = runs(&c, ctx.now);
    let id = c.id;
    save(r.as_mut(), ctx, c, "ads.campaign.move").await?;
    r.studio()
        .request_receipt("ads.campaign_move", &i.request_key, &payload, &json!(id))
        .await?;
    r.commit().await?;
    if refused {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "the move is refused: each finding names its field".into(),
            details: json!({"reason": "move_refused", "findings": held}),
        });
    }
    // The provider follows: the one ad paused or resumed, a new ad built.
    let fresh = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        r.ads().get_campaign(id).await?
    };
    if let Some(fresh) = fresh
        && let Some(a) = build::account(d, &fresh).await?
    {
        for (ad_id, paused) in provider {
            let status = if paused || !running {
                AdStatus::Paused
            } else {
                AdStatus::Active
            };
            let _ = a.status.set_status(&a.credential, &ad_id, status).await;
        }
    }
    let _ = build::run(d, ctx.workspace_id, id, ctx.now).await;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    Ok(r.ads()
        .get_campaign(id)
        .await?
        .ok_or_else(|| AppError::not_found("ad campaign"))?
        .present(ctx.now))
}

/// The JSON Schema of a move.
pub(crate) fn move_schema() -> Value {
    let reason = json!({"type":"string","minLength":1,"maxLength":MAX_TEXT_CHARS,
        "description":"Why: kept on the campaign for the person who reads it."});
    let index =
        json!({"type":"integer","minimum":0,"description":"The ad's place in the plan's ads."});
    let one = |kind: &str, properties: Value, required: Vec<&str>| {
        let mut p = properties;
        p["kind"] = json!({"const": kind});
        p["reason"] = reason.clone();
        let mut needed = vec!["kind", "reason"];
        needed.extend(required);
        json!({"type":"object","additionalProperties":false,"properties":p,"required":needed})
    };
    json!({"oneOf":[
        one("pause_ad", json!({"ad":index}), vec!["ad"]),
        one("resume_ad", json!({"ad":index}), vec!["ad"]),
        one("add_ad", json!({"ad":plan::ad_schema()}), vec!["ad"]),
        one("fix_ad", json!({"ad":index,"with":plan::ad_schema()}), vec!["ad","with"]),
        one("none", json!({}), vec![]),
    ]})
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewInput {
    pub campaign_id: Uuid,
    /// The ad's place in the plan's ads.
    pub index: usize,
    pub placement: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewOut {
    /// The provider's own preview frame: short-lived, to be shown in a sandboxed frame.
    pub html: String,
}

/// `ads.ad_preview`: how the provider shows one ad of a built campaign in a placement. Asked of
/// the provider each time; an ad whose image is not at the provider yet has none (`not_built`),
/// and neither has an ad on a platform that shows no preview (`no_preview_on_this_platform`).
pub async fn ad_preview(d: &Deps, ctx: &Ctx, i: PreviewInput) -> Result<PreviewOut, AppError> {
    let placement = match i.placement.as_str() {
        "facebook_feed" => AdPlacement::FacebookFeed,
        "instagram_feed" => AdPlacement::InstagramFeed,
        "instagram_story" => AdPlacement::InstagramStory,
        "instagram_reels" => AdPlacement::InstagramReels,
        _ => {
            return Err(AppError::validation(
                "a listed placement",
                json!({"field": "placement", "reason": "a_listed_placement"}),
            ));
        }
    };
    let c = {
        let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
        r.ads()
            .get_campaign(i.campaign_id)
            .await?
            .ok_or_else(|| AppError::not_found("ad campaign"))?
    };
    let platform = c.built.as_ref().map(|b| b.platform).unwrap_or_default();
    if !platform::rules(platform).preview {
        return Err(refuse(
            "no_preview_on_this_platform",
            "this ad platform shows no preview: the plan's texts are what the ad says",
        ));
    }
    let not_built = || refuse("not_built", "the ad is not at the provider yet");
    let spec = build::creative(d, &c, i.index)
        .await?
        .ok_or_else(not_built)?;
    let a = build::account(d, &c).await?.ok_or_else(not_built)?;
    let html = a
        .writer
        .preview(&a.credential, &a.public, &spec, placement)
        .await
        .map_err(|e| AppError {
            code: ErrorCode::UpstreamUnavailable,
            message: "the provider gave no preview".into(),
            details: json!({"provider_error": e.kind()}),
        })?;
    Ok(PreviewOut { html })
}
