//! Jeeta builds the campaign at the provider itself (design 2026-11-10 §8.5, B11): the
//! campaign with its total budget, the ad set, each ad's image, creative and ad, all paused, and
//! only then the activation.
//!
//! The build is deterministic and can be cut off anywhere. Every provider object carries a name
//! made of the campaign's id and its part (`jeeta:<campaign>:campaign`, `:adset`,
//! `:creative:<n>:<generation>`, `:ad:<n>:<generation>`); its provider id is recorded before the
//! next step; and before anything is created it is looked for by that name and adopted. An
//! answer that was lost therefore never makes a second object. A step the provider refuses for
//! good ends the build with what the provider said: what exists stays paused, for a person to
//! see. Any other failure leaves the build where it is: the next run goes on from there.
//!
//! Nothing is activated unless the campaign's budget still holds against every limit and
//! nobody stopped the spending; a build stopped half way activates nothing, and goes on when
//! the stop is lifted.
use super::{check_money, load, save};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        ads::*,
        connectors::{
            AdAudience, AdBudgetWriter, AdCampaignWriter, AdGender, AdInterest, AdLevel,
            AdObjective, AdPlacements, AdPlatform, AdSetGoal, AdSetSpec, AdSpec, AdStatus,
            CallToAction, CampaignSpec, CreativeAction, CreativeSpec, LeadFormSpec, LeadQuestion,
        },
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure,
    },
};
use jt_capability::Capability;
use jt_connector::{ConnectorError, Credential, Provider, provider_for_kind};
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

/// The system acting on a campaign: the builder and the watch.
pub(crate) fn system(ws: WorkspaceId, now: OffsetDateTime) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: jt_ledger::Actor::System {
            component: "ads.campaigns".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// Changes campaign `id` under its lock and stores it, as the system.
pub(crate) async fn record(
    d: &Deps,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
    action: &str,
    change: impl FnOnce(&mut AdCampaign) + Send,
) -> Result<(), AppError> {
    let mut r = d.uow.tenant(ws).await?;
    let mut c = load(r.as_mut(), id, None).await?;
    change(&mut c);
    save(r.as_mut(), &system(ws, now), c, action).await?;
    r.commit().await
}

/// The ad account of a built campaign with what a provider call needs.
pub(crate) struct Account {
    pub capability: Capability,
    pub credential: Credential,
    pub public: Value,
    pub provider: Provider,
    pub writer: Arc<dyn AdCampaignWriter>,
    pub status: Arc<dyn AdBudgetWriter>,
}

/// The account `c` is built on, usable now; `None` when it, its credential or its adapter is
/// not there (the next run asks again).
pub(crate) async fn account(d: &Deps, c: &AdCampaign) -> Result<Option<Account>, AppError> {
    let Some(built) = &c.built else {
        return Ok(None);
    };
    let mut r = d.uow.tenant(c.workspace_id).await?;
    let Some(capability) = r.capabilities().find(built.account).await? else {
        return Ok(None);
    };
    let Some(sealed) = r.capabilities().read_sealed(capability.id).await? else {
        return Ok(None);
    };
    let Some(provider) = provider_for_kind(&capability.kind_key) else {
        return Ok(None);
    };
    let (Some(writer), Some(status)) = (
        d.connectors.ad_campaigns(provider),
        d.connectors.ads(provider),
    ) else {
        return Ok(None);
    };
    let Ok(credential) = open_credential(d, c.workspace_id, &sealed) else {
        return Ok(None);
    };
    Ok(Some(Account {
        public: adapter_public(&capability),
        capability,
        credential,
        provider,
        writer,
        status,
    }))
}

fn call_to_action(value: &str) -> CallToAction {
    match value {
        "SIGN_UP" => CallToAction::SignUp,
        "SHOP_NOW" => CallToAction::ShopNow,
        "CONTACT_US" => CallToAction::ContactUs,
        "GET_QUOTE" => CallToAction::GetQuote,
        "SUBSCRIBE" => CallToAction::Subscribe,
        "APPLY_NOW" => CallToAction::ApplyNow,
        "BOOK_NOW" => CallToAction::BookNow,
        "DOWNLOAD" => CallToAction::Download,
        _ => CallToAction::LearnMore,
    }
}

/// The external id (the provider's own) of capability `id`, of the campaign's workspace.
async fn external_id(
    d: &Deps,
    ws: WorkspaceId,
    id: jt_capability::CapabilityId,
) -> Result<Option<String>, AppError> {
    let mut r = d.uow.tenant(ws).await?;
    Ok(r.capabilities().find(id).await?.and_then(|c| c.external_id))
}

/// The creative of the plan's `n`-th ad, once its image is at the provider: `None` while the
/// image, the page's id or (for a lead form) the form is not there yet.
pub(crate) async fn creative(
    d: &Deps,
    c: &AdCampaign,
    n: usize,
) -> Result<Option<CreativeSpec>, AppError> {
    let (Some(plan), Some(built)) = (&c.plan, &c.built) else {
        return Ok(None);
    };
    let (Some(ad), Some(made)) = (plan.ads.get(n), built.ads.get(n)) else {
        return Ok(None);
    };
    let Some(image_hash) = made.image_hash.clone() else {
        return Ok(None);
    };
    let Some(page_id) = external_id(d, c.workspace_id, ad.page).await? else {
        return Ok(None);
    };
    let instagram_user_id = match ad.instagram {
        Some(id) => external_id(d, c.workspace_id, id).await?,
        None => None,
    };
    let parse = |url: &str| url.parse::<url::Url>().ok();
    let action = match &plan.destination {
        Destination::Website { url } => match parse(url) {
            Some(url) => CreativeAction::Link { url },
            None => return Ok(None),
        },
        Destination::LeadForm {
            privacy_policy_url, ..
        } => match (built.form_id.clone(), parse(privacy_policy_url)) {
            (Some(form_id), Some(url)) => CreativeAction::LeadForm { form_id, url },
            _ => return Ok(None),
        },
    };
    Ok(Some(CreativeSpec {
        name: format!("jeeta:{}:creative:{n}:{}", c.id, made.generation),
        page_id,
        instagram_user_id,
        image_hash,
        primary_text: ad.primary_text.clone(),
        headline: ad.headline.clone(),
        description: ad.description.clone(),
        call_to_action: call_to_action(&ad.call_to_action),
        action,
    }))
}

/// What a provider failure means for the build: a refusal for good is recorded on the campaign
/// (it then waits for a person); anything else leaves the build for the next run.
async fn failed(
    d: &Deps,
    c: &AdCampaign,
    now: OffsetDateTime,
    provider: Provider,
    step: &str,
    e: ConnectorError,
) -> Result<(), AppError> {
    if matches!(
        e,
        ConnectorError::Permanent { .. }
            | ConnectorError::Permission { .. }
            | ConnectorError::Auth { .. }
    ) {
        let reason = format!("{step}: {}", failure::failure_reason(Some(provider), &e));
        record(
            d,
            c.workspace_id,
            c.id,
            now,
            "ads.campaign.build_failed",
            move |c| {
                if let Some(built) = &mut c.built {
                    built.failed = Some(reason);
                }
            },
        )
        .await?;
    }
    Ok(())
}

/// An object of `level` named `name`: the one already there, else a new one from `create`.
async fn found_or<F, Fut>(
    a: &Account,
    level: AdLevel,
    name: &str,
    create: F,
) -> Result<String, ConnectorError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, ConnectorError>>,
{
    match a
        .writer
        .find_by_name(&a.credential, &a.public, level, name)
        .await?
    {
        Some(id) => Ok(id),
        None => create().await,
    }
}

/// Whether the campaign should be running at the provider now: built, not stopped, not over.
pub(crate) fn runs(c: &AdCampaign, now: OffsetDateTime) -> bool {
    c.stop.is_none() && !c.closed_at(now) && c.built.as_ref().is_some_and(|b| b.failed.is_none())
}

/// Takes the build of campaign `id` as far as the provider lets it now (see the module docs).
pub async fn run(d: &Deps, ws: WorkspaceId, id: Uuid, now: OffsetDateTime) -> Result<(), AppError> {
    // Each pass does one step and reads the campaign afresh: what is recorded is what counts.
    for _ in 0..64 {
        let c = {
            let mut r = d.uow.tenant(ws).await?;
            match r.ads().get_campaign(id).await? {
                Some(c) => c,
                None => return Ok(()),
            }
        };
        let (Some(plan), Some(built)) = (c.plan.clone(), c.built.clone()) else {
            return Ok(());
        };
        if built.failed.is_some() || c.closed_at(now) {
            return Ok(());
        }
        let Some(a) = account(d, &c).await? else {
            return Ok(());
        };
        let step: Result<bool, (&str, ConnectorError)> = async {
            // 1. The campaign, with its total budget: the provider's own hard limit (B32).
            let Some(campaign_id) = built.campaign_id.clone() else {
                let spec = CampaignSpec {
                    name: format!("jeeta:{id}:campaign"),
                    objective: match plan.result {
                        AdResult::LinkClick => AdObjective::Traffic,
                        AdResult::LeadForm => AdObjective::Leads,
                    },
                    lifetime_budget_minor: c.budget_minor,
                };
                let made = found_or(&a, AdLevel::Campaign, &spec.name, || {
                    a.writer.create_campaign(&a.credential, &a.public, &spec)
                })
                .await
                .map_err(|e| ("campaign", e))?;
                record(d, ws, id, now, "ads.campaign.built_campaign", move |c| {
                    if let Some(b) = &mut c.built {
                        b.campaign_id = Some(made);
                    }
                })
                .await
                .map_err(|e| ("campaign", ConnectorError::transient(e.message)))?;
                return Ok(true);
            };
            // 2. A lead form, on its page, before anything refers to it.
            if let (
                Destination::LeadForm {
                    page,
                    name,
                    questions,
                    privacy_policy_url,
                    thank_you_url,
                },
                None,
            ) = (&plan.destination, &built.form_id)
            {
                let form = lead_form(
                    d,
                    &c,
                    *page,
                    name,
                    questions,
                    privacy_policy_url,
                    thank_you_url,
                    &plan,
                )
                .await
                .map_err(|e| ("lead form", e))?;
                record(d, ws, id, now, "ads.campaign.built_form", move |c| {
                    if let Some(b) = &mut c.built {
                        b.form_id = Some(form);
                    }
                })
                .await
                .map_err(|e| ("lead form", ConnectorError::transient(e.message)))?;
                return Ok(true);
            }
            // 3. The ad set: who sees it, where, from when to when.
            let Some(adset_id) = built.adset_id.clone() else {
                let goal = match &plan.destination {
                    Destination::Website { .. } => AdSetGoal::LinkClicks,
                    Destination::LeadForm { page, .. } => AdSetGoal::Leads {
                        page_id: external_id(d, ws, *page).await.ok().flatten().ok_or_else(
                            || {
                                (
                                    "ad set",
                                    ConnectorError::permanent("the form's page has no id"),
                                )
                            },
                        )?,
                    },
                };
                let spec = AdSetSpec {
                    name: format!("jeeta:{id}:adset"),
                    campaign_id,
                    goal,
                    audience: audience(&plan.audience),
                    placements: placements(&plan.placements),
                    start_at: c.start_at.max(now),
                    end_at: plan.end_at,
                };
                let made = found_or(&a, AdLevel::AdSet, &spec.name, || {
                    a.writer.create_adset(&a.credential, &a.public, &spec)
                })
                .await
                .map_err(|e| ("ad set", e))?;
                record(d, ws, id, now, "ads.campaign.built_adset", move |c| {
                    if let Some(b) = &mut c.built {
                        b.adset_id = Some(made);
                    }
                })
                .await
                .map_err(|e| ("ad set", ConnectorError::transient(e.message)))?;
                return Ok(true);
            };
            // 4. Each ad: its image, its creative, the ad itself, paused.
            for (n, made) in built.ads.iter().enumerate() {
                let Some(ad) = plan.ads.get(n) else { continue };
                if made.image_hash.is_none() {
                    let hash = image(d, &c, &a, ad, n).await.map_err(|e| ("image", e))?;
                    set_ad(d, ws, id, now, n, move |x| x.image_hash = Some(hash)).await?;
                    return Ok(true);
                }
                if made.creative_id.is_none() {
                    let spec = creative(d, &c, n).await.ok().flatten().ok_or_else(|| {
                        (
                            "creative",
                            ConnectorError::permanent("the ad's page has no id"),
                        )
                    })?;
                    let creative_id = found_or(&a, AdLevel::Creative, &spec.name, || {
                        a.writer.create_creative(&a.credential, &a.public, &spec)
                    })
                    .await
                    .map_err(|e| ("creative", e))?;
                    set_ad(d, ws, id, now, n, move |x| {
                        x.creative_id = Some(creative_id)
                    })
                    .await?;
                    return Ok(true);
                }
                if made.ad_id.is_none() {
                    let spec = AdSpec {
                        name: format!("jeeta:{id}:ad:{n}:{}", made.generation),
                        adset_id: adset_id.clone(),
                        creative_id: made.creative_id.clone().expect("checked above"),
                    };
                    let ad_id = found_or(&a, AdLevel::Ad, &spec.name, || {
                        a.writer.create_ad(&a.credential, &a.public, &spec)
                    })
                    .await
                    .map_err(|e| ("ad", e))?;
                    // An ad added to a campaign that already runs starts with it.
                    let live = built.activated_at.is_some() && runs(&c, now) && !made.held;
                    if live {
                        a.status
                            .set_status(&a.credential, &ad_id, AdStatus::Active)
                            .await
                            .map_err(|e| ("ad", e))?;
                    }
                    set_ad(d, ws, id, now, n, move |x| {
                        x.ad_id = Some(ad_id);
                        x.status = BuiltAdStatus::InReview;
                    })
                    .await?;
                    return Ok(true);
                }
            }
            Ok(false)
        }
        .await;
        match step {
            Ok(true) => continue,
            Ok(false) => break,
            Err((step, e)) => return failed(d, &c, now, a.provider, step, e).await,
        }
    }
    activate(d, ws, id, now).await
}

/// Changes the `n`-th built ad of campaign `id`.
async fn set_ad(
    d: &Deps,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
    n: usize,
    change: impl FnOnce(&mut BuiltAd) + Send,
) -> Result<(), (&'static str, ConnectorError)> {
    record(d, ws, id, now, "ads.campaign.built_ad", move |c| {
        if let Some(ad) = c.built.as_mut().and_then(|b| b.ads.get_mut(n)) {
            change(ad);
        }
    })
    .await
    .map_err(|e| ("ad", ConnectorError::transient(e.message)))
}

fn audience(a: &PlanAudience) -> AdAudience {
    AdAudience {
        countries: a.countries.clone(),
        regions: a.regions.clone(),
        cities: a.cities.clone(),
        age_min: a.age_min,
        age_max: a.age_max,
        genders: a
            .genders
            .iter()
            .map(|g| {
                if *g == 2 {
                    AdGender::Female
                } else {
                    AdGender::Male
                }
            })
            .collect(),
        interests: a
            .interests
            .iter()
            .map(|i| AdInterest {
                id: i.id.clone(),
                name: i.name.clone(),
            })
            .collect(),
        broad: a.broad,
    }
}

fn placements(p: &PlanPlacements) -> AdPlacements {
    match p {
        PlanPlacements::Automatic => AdPlacements::Automatic,
        PlanPlacements::Platforms { platforms } => AdPlacements::Platforms(
            platforms
                .iter()
                .map(|x| {
                    if x == "instagram" {
                        AdPlatform::Instagram
                    } else {
                        AdPlatform::Facebook
                    }
                })
                .collect(),
        ),
    }
}

/// The image of the plan's `n`-th ad, uploaded to the ad account: its hash there.
async fn image(
    d: &Deps,
    c: &AdCampaign,
    a: &Account,
    ad: &PlanAd,
    n: usize,
) -> Result<String, ConnectorError> {
    let gone = || ConnectorError::permanent("the ad's image is not in the library any more");
    let material = {
        let mut r = d
            .uow
            .tenant(c.workspace_id)
            .await
            .map_err(|e| ConnectorError::transient(e.message))?;
        let id = ad.material_ids.first().copied().ok_or_else(gone)?;
        r.studio_materials()
            .get_material(id)
            .await
            .map_err(|e| ConnectorError::transient(e.message))?
            .filter(|m| m.erased_at.is_none())
            .ok_or_else(gone)?
    };
    let file = d
        .files
        .read(c.workspace_id, material.file_id)
        .await
        .map_err(|_| gone())?;
    a.writer
        .upload_image(
            &a.credential,
            &a.public,
            &file.bytes,
            &format!("jeeta-{}-{n}", c.id),
        )
        .await
}

/// The campaign's lead form, made on its page with the page's own credential.
#[allow(clippy::too_many_arguments)]
async fn lead_form(
    d: &Deps,
    c: &AdCampaign,
    page: jt_capability::CapabilityId,
    name: &str,
    questions: &[String],
    privacy_policy_url: &str,
    thank_you_url: &str,
    plan: &CampaignPlan,
) -> Result<String, ConnectorError> {
    let unusable = || ConnectorError::permanent("the form's page cannot be used");
    let transient = |e: AppError| ConnectorError::transient(e.message);
    let (capability, sealed) = {
        let mut r = d.uow.tenant(c.workspace_id).await.map_err(transient)?;
        let capability = r
            .capabilities()
            .find(page)
            .await
            .map_err(transient)?
            .ok_or_else(unusable)?;
        let sealed = r
            .capabilities()
            .read_sealed(page)
            .await
            .map_err(transient)?
            .ok_or_else(unusable)?;
        (capability, sealed)
    };
    let writer = provider_for_kind(&capability.kind_key)
        .and_then(|p| d.connectors.ad_campaigns(p))
        .ok_or_else(unusable)?;
    let credential = open_credential(d, c.workspace_id, &sealed).map_err(|_| unusable())?;
    let parse = |url: &str| url.parse::<url::Url>().map_err(|_| unusable());
    let spec = LeadFormSpec {
        // A form's name is unique on its page: the campaign's id keeps it so.
        name: format!("{name} · {}", &c.id.simple().to_string()[..8]),
        questions: questions
            .iter()
            .map(|q| match q.as_str() {
                "EMAIL" => LeadQuestion::Email,
                "PHONE" => LeadQuestion::Phone,
                _ => LeadQuestion::FullName,
            })
            .collect(),
        privacy_policy_url: parse(privacy_policy_url)?,
        thank_you_url: parse(thank_you_url)?,
        locale: if plan.audience.countries.iter().any(|c| c == "TR") {
            "tr_TR".into()
        } else {
            "en_US".into()
        },
    };
    writer
        .create_lead_form(&credential, &adapter_public(&capability), &spec)
        .await
}

/// Activates what was built, once and only when the money still holds: the campaign's unspent
/// budget against every limit, with nobody having stopped the spending (P4). Stopped, or over a
/// limit, it stays paused; the next run asks again.
pub(crate) async fn activate(
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
    let Some(built) = c.built.clone() else {
        return Ok(());
    };
    if built.activated_at.is_some() || !built.complete() || !runs(&c, now) {
        return Ok(());
    }
    let Some(a) = account(d, &c).await? else {
        return Ok(());
    };
    {
        let mut r = d.uow.tenant(ws).await?;
        let held = load(r.as_mut(), id, None).await?;
        if check_money(
            r.as_mut(),
            id,
            held.committed_minor(now),
            Some(&a.capability),
            now,
        )
        .await
        .is_err()
        {
            return Ok(());
        }
    }
    let mut ids: Vec<String> = built
        .ads
        .iter()
        .filter(|ad| !ad.held)
        .filter_map(|ad| ad.ad_id.clone())
        .collect();
    ids.extend(built.adset_id.clone());
    ids.extend(built.campaign_id.clone());
    // The ads first, the campaign last: nothing runs until the last switch.
    for entity in &ids {
        if let Err(e) = a
            .status
            .set_status(&a.credential, entity, AdStatus::Active)
            .await
        {
            return failed(d, &c, now, a.provider, "activation", e).await;
        }
    }
    record(d, ws, id, now, "ads.campaign.activated", move |c| {
        if let Some(b) = &mut c.built {
            b.activated_at = Some(now);
            b.provider_paused = false;
        }
    })
    .await
}
