//! The agent's plan (design 2026-11-10 §8.4): one structured decision, checked whole. A plan
//! that is not well formed is the caller's mistake (`VALIDATION`, naming the field) and counts
//! for nothing; a well-formed plan that breaks a rule is refused with every finding, counted,
//! and after the third in a row the campaign waits for a person.
use super::{build, check_money, live_claim, load, open_tx, refuse, save};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, ads::*, connectors::AdAccountLimits},
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        content::delivery::subject_of,
        modules,
        studio::{chain, files, materials},
    },
};
use jt_capability::{Capability, CapabilityId, StoredStatus};
use jt_connector::provider_for_kind;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) const CALLS_TO_ACTION: [&str; 9] = [
    "LEARN_MORE",
    "SIGN_UP",
    "SHOP_NOW",
    "CONTACT_US",
    "GET_QUOTE",
    "SUBSCRIBE",
    "APPLY_NOW",
    "BOOK_NOW",
    "DOWNLOAD",
];
const QUESTIONS: [&str; 3] = ["FULL_NAME", "EMAIL", "PHONE"];
/// Targeting a country of the European Union needs the payer and the beneficiary named (DSA):
/// not in this version.
const EU: [&str; 27] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
    "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];
/// The longest texts an ad carries here (within the provider's own limits).
pub const MAX_PRIMARY_TEXT: usize = 1000;
pub const MAX_HEADLINE: usize = 100;
pub const MAX_DESCRIPTION: usize = 100;
pub const MAX_AD_NAME: usize = 100;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanInput {
    pub campaign_id: Uuid,
    pub claim_token: String,
    pub request_key: String,
    pub plan: CampaignPlan,
}

fn malformed(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field": field, "reason": reason}))
}

fn https(url: &str, field: &str) -> Result<(), AppError> {
    match url::Url::parse(url) {
        Ok(u) if u.scheme() == "https" && u.host_str().is_some() => Ok(()),
        _ => Err(malformed(field, "an_https_address")),
    }
}

fn length(value: &str, field: &str, max: usize) -> Result<(), AppError> {
    let n = value.trim().chars().count();
    if n == 0 || n > max {
        return Err(malformed(field, &format!("1_to_{max}_characters")));
    }
    Ok(())
}

/// One ad's shape, as `ads[n]` or as the ad of a move.
pub(crate) fn ad_shape(ad: &PlanAd, at: &str) -> Result<(), AppError> {
    length(&ad.name, &format!("{at}.name"), MAX_AD_NAME)?;
    length(
        &ad.primary_text,
        &format!("{at}.primary_text"),
        MAX_PRIMARY_TEXT,
    )?;
    length(&ad.headline, &format!("{at}.headline"), MAX_HEADLINE)?;
    if let Some(description) = &ad.description {
        length(description, &format!("{at}.description"), MAX_DESCRIPTION)?;
    }
    if ad.material_ids.len() != 1 {
        return Err(malformed(&format!("{at}.material_ids"), "one_image"));
    }
    if !CALLS_TO_ACTION.contains(&ad.call_to_action.as_str()) {
        return Err(malformed(
            &format!("{at}.call_to_action"),
            "a_listed_call_to_action",
        ));
    }
    Ok(())
}

/// The plan's shape against the campaign it is for, before anything is read.
fn shape(c: &AdCampaign, p: &CampaignPlan) -> Result<(), AppError> {
    if p.ads.is_empty() || p.ads.len() > MAX_ADS {
        return Err(malformed("ads", "1_to_6_ads"));
    }
    for (n, ad) in p.ads.iter().enumerate() {
        ad_shape(ad, &format!("ads[{n}]"))?;
    }
    length(&p.summary, "summary", MAX_TEXT_CHARS)?;
    length(&p.audience_summary, "audience_summary", MAX_TEXT_CHARS)?;
    let a = &p.audience;
    if a.countries.is_empty()
        || a.countries.len() > 25
        || a.countries
            .iter()
            .any(|c| c.len() != 2 || !c.chars().all(|ch| ch.is_ascii_uppercase()))
    {
        return Err(malformed(
            "audience.countries",
            "1_to_25_two_letter_country_codes",
        ));
    }
    if a.age_min < 18 || a.age_max > 65 || a.age_min > a.age_max {
        return Err(malformed("audience.age_min", "18_to_65"));
    }
    // A broad audience (Meta's Advantage+ audience) takes a lower age of 18 to 25 and no upper
    // age below 65: the provider finds the people itself. A narrower age range is not broad.
    if a.broad && (a.age_min > 25 || a.age_max != 65) {
        return Err(malformed(
            "audience.broad",
            "a_broad_audience_is_18_to_25_and_up_to_65",
        ));
    }
    if a.genders.iter().any(|g| !matches!(g, 1 | 2)) || a.genders.len() > 2 {
        return Err(malformed("audience.genders", "1_men_2_women"));
    }
    if a.interests.len() > 25 || a.regions.len() > 50 || a.cities.len() > 50 {
        return Err(malformed("audience.interests", "too_many"));
    }
    if let PlanPlacements::Platforms { platforms } = &p.placements
        && (platforms.is_empty()
            || platforms
                .iter()
                .any(|x| !matches!(x.as_str(), "facebook" | "instagram")))
    {
        return Err(malformed("placements.platforms", "facebook_or_instagram"));
    }
    match (&p.result, &p.destination) {
        (AdResult::LinkClick, Destination::Website { url }) => https(url, "destination.url")?,
        (
            AdResult::LeadForm,
            Destination::LeadForm {
                name,
                questions,
                privacy_policy_url,
                thank_you_url,
                ..
            },
        ) => {
            length(name, "destination.name", MAX_AD_NAME)?;
            if questions.is_empty() || questions.iter().any(|q| !QUESTIONS.contains(&q.as_str())) {
                return Err(malformed("destination.questions", "full_name_email_phone"));
            }
            https(privacy_policy_url, "destination.privacy_policy_url")?;
            https(thank_you_url, "destination.thank_you_url")?;
        }
        _ => return Err(malformed("destination", "the_results_own_destination")),
    }
    let run = p.end_at - c.start_at;
    if run < MIN_RUN || run > MAX_RUN {
        return Err(malformed("end_at", "24_hours_to_90_days_after_the_start"));
    }
    if c.end_at.is_some_and(|end| end != p.end_at) {
        return Err(malformed("end_at", "the_campaigns_own_end"));
    }
    Ok(())
}

/// A live capability of `kind`, or the finding that it is not one.
async fn live(
    r: &mut dyn TenantRepos,
    id: CapabilityId,
    kind: &str,
    field: &str,
    findings: &mut Vec<Value>,
) -> Result<Option<Capability>, AppError> {
    match r.capabilities().find(id).await? {
        Some(c) if c.kind_key == kind && c.status != StoredStatus::Retired => Ok(Some(c)),
        _ => {
            findings.push(json!({"field": field, "reason": format!("not_a_live_{kind}")}));
            Ok(None)
        }
    }
}

/// What holds one ad of a plan: its page and Instagram account (live, and in a group of the ad
/// account when the account is in one), its hypothesis, its image (live, an image, free to be
/// shared) and its texts (the truth check), as for a post (B10).
pub(crate) async fn ad_findings(
    r: &mut dyn TenantRepos,
    ad: &PlanAd,
    at: &str,
    account: CapabilityId,
    hypotheses: &[jt_strategy::Hypothesis],
    now: OffsetDateTime,
) -> Result<Vec<Value>, AppError> {
    let mut findings = Vec::new();
    let groups: Vec<Vec<CapabilityId>> = r
        .capability_groups()
        .list()
        .await?
        .into_iter()
        .map(|(_, ids)| ids)
        .filter(|ids| ids.contains(&account))
        .collect();
    let grouped = |id: CapabilityId| groups.is_empty() || groups.iter().any(|g| g.contains(&id));
    let mut identities = vec![(ad.page, "facebook_page", format!("{at}.page"))];
    if let Some(instagram) = ad.instagram {
        identities.push((instagram, "instagram", format!("{at}.instagram")));
    }
    for (id, kind, field) in identities {
        if live(r, id, kind, &field, &mut findings).await?.is_some() && !grouped(id) {
            findings.push(json!({"field": field, "reason": "not_in_the_ad_accounts_group"}));
        }
    }
    if !hypotheses.iter().any(|h| h.id == ad.hypothesis_id) {
        findings.push(json!({"field": format!("{at}.hypothesis_id"),
            "reason": "hypothesis_not_in_approved_strategy"}));
    }
    let mut shown = Vec::new();
    for id in &ad.material_ids {
        match r.studio_materials().get_material(*id).await? {
            Some(m) if m.erased_at.is_none() && m.mime.starts_with("image/") => shown.push(m),
            Some(_) => findings.push(json!({"field": format!("{at}.material_ids"),
                "reason": "not_a_live_image", "material_id": id})),
            None => findings.push(json!({"field": format!("{at}.material_ids"),
                "reason": "material_not_found", "material_id": id})),
        }
    }
    if !shown.is_empty() {
        let subject = subject_of(&shown);
        let mut texts = vec![ad.primary_text.as_str(), ad.headline.as_str()];
        texts.extend(ad.description.as_deref());
        let (hard, truth) = materials::check_content(r, &shown, &subject, &texts, now).await?;
        findings.extend(hard.into_iter().map(|f| {
            json!({"field": format!("{at}.material_ids"), "kind": "material",
                   "reason": f.code, "material_id": f.material_id})
        }));
        findings.extend(truth.into_iter().map(|f| {
            json!({"field": format!("{at}.primary_text"), "kind": "text",
                   "reason": f.code.code(), "material_id": f.material_id,
                   "olay_id": f.olay_id, "matched": f.matched})
        }));
    }
    Ok(findings)
}

/// What the plan breaks, field by field; empty when it holds.
async fn findings(
    r: &mut dyn TenantRepos,
    c: &AdCampaign,
    p: &CampaignPlan,
    account: Option<&Capability>,
    limits: Option<&AdAccountLimits>,
    unusable: Option<&str>,
    now: OffsetDateTime,
) -> Result<Vec<Value>, AppError> {
    let mut out = Vec::new();
    if !p.special_ad_categories.is_empty() {
        out.push(json!({"field": "special_ad_categories",
            "reason": "special_category_not_supported"}));
    }
    if p.audience
        .countries
        .iter()
        .any(|c| EU.contains(&c.as_str()))
    {
        out.push(json!({"field": "audience.countries", "reason": "eu_targeting_needs_payer"}));
    }
    match account {
        // An ad account of the workspace that cannot be written to says why: a grant without
        // the scope names the scope, so that a person knows to reconnect and what to allow.
        None => out.push(match unusable {
            Some(chain::SCOPE_MISSING) => json!({"field": "ad_account",
                "reason": chain::SCOPE_MISSING, "needs": chain::write_scopes("meta_ads")}),
            Some(why) => json!({"field": "ad_account", "reason": why}),
            None => json!({"field": "ad_account", "reason": "not_a_usable_ad_account"}),
        }),
        Some(account) => {
            if c.account_hint.is_some_and(|hint| hint != account.id) {
                out.push(json!({"field": "ad_account", "reason": "not_the_campaigns_account"}));
            }
            match limits {
                None => out.push(json!({"field": "ad_account", "reason": "account_unreadable"})),
                Some(limits) => {
                    if limits.currency != c.currency {
                        out.push(json!({"field": "ad_account", "reason": "currency_mismatch",
                            "account_currency": limits.currency, "budget_currency": c.currency}));
                    }
                    let days = ((p.end_at - c.start_at).whole_hours() + 23) / 24;
                    let least = limits.min_daily_budget_minor.saturating_mul(days.max(1));
                    if c.budget_minor < least {
                        out.push(json!({"field": "budget_minor",
                            "reason": "below_the_accounts_minimum", "least": least}));
                    }
                }
            }
        }
    }
    if let Destination::LeadForm { page, .. } = &p.destination {
        if !modules::installed(r, "inbox").await? {
            out.push(json!({"field": "result", "reason": "lead_form_needs_the_inbox"}));
        }
        live(r, *page, "facebook_page", "destination.page", &mut out).await?;
    }
    let version = r
        .strategy()
        .current_approved()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    let hypotheses = r.hypotheses().list(version.id).await?;
    for (n, ad) in p.ads.iter().enumerate() {
        out.extend(ad_findings(r, ad, &format!("ads[{n}]"), p.ad_account, &hypotheses, now).await?);
    }
    Ok(out)
}

/// The ad account `id` when it can be written to now, its credential opened, and what the
/// provider says of it (currency, smallest daily budget); `None` wherever one is missing. The
/// third value is why an ad account of the workspace cannot be written to now (the refusal of
/// [`chain::capability_access`]); `None` when it can, or when `id` is no ad account at all.
pub(crate) async fn account_of(
    d: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
) -> Result<(Option<Capability>, Option<AdAccountLimits>, Option<String>), AppError> {
    const UNAVAILABLE: &str = "capability_unavailable";
    let (account, sealed) = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let Some(c) = r.capabilities().find(id).await? else {
            return Ok((None, None, None));
        };
        if c.kind_key != "meta_ads" {
            return Ok((None, None, None));
        }
        if let Err(e) = chain::capability_access(&c, ctx.now, true) {
            let why = e.details["reason"]
                .as_str()
                .unwrap_or(UNAVAILABLE)
                .to_owned();
            return Ok((None, None, Some(why)));
        }
        let sealed = r.capabilities().read_sealed(c.id).await?;
        (c, sealed)
    };
    let Some(sealed) = sealed else {
        return Ok((None, None, Some(UNAVAILABLE.to_owned())));
    };
    let Some(writer) =
        provider_for_kind(&account.kind_key).and_then(|p| d.connectors.ad_campaigns(p))
    else {
        return Ok((Some(account), None, None));
    };
    let Ok(credential) = open_credential(d, ctx.workspace_id, &sealed) else {
        return Ok((Some(account), None, None));
    };
    let limits = writer
        .account_limits(&credential, &adapter_public(&account))
        .await
        .ok();
    Ok((Some(account), limits, None))
}

/// `ads.plan_submit`: the claim's agent delivers the campaign's plan. A plan that holds is
/// stored, the campaign's whole budget is held against every limit, and the build starts; one
/// that does not is refused with every finding (`plan_refused`). One plan per campaign: of two
/// arriving together, one is refused (`plan_exists`).
pub async fn plan_submit(d: &Deps, ctx: &Ctx, i: PlanInput) -> Result<AdCampaign, AppError> {
    ctx.require(Permission::AdsWork)?;
    files::key(&i.request_key)?;
    let payload = serde_json::to_value(&i)?;
    {
        let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
        r.strategy()
            .lock_execution_frame()
            .await?
            .ok_or_else(AppError::strategy_required)?;
        if let Some(saved) = r
            .studio()
            .request_replay("ads.plan_submit", &i.request_key, &payload)
            .await?
        {
            let id: Uuid = serde_json::from_value(saved)
                .map_err(|_| AppError::internal("stored plan receipt"))?;
            if let Some(c) = r.ads().get_campaign(id).await? {
                return Ok(c.present(ctx.now));
            }
        }
        let c = r
            .ads()
            .get_campaign(i.campaign_id)
            .await?
            .ok_or_else(|| AppError::not_found("ad campaign"))?;
        live_claim(&c, ctx, &i.claim_token)?;
        shape(&c, &i.plan)?;
    }
    // What the provider says of the account: read with no transaction open.
    let (account, limits, unusable) = account_of(d, ctx, i.plan.ad_account).await?;

    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let mut c = load(r.as_mut(), i.campaign_id, None).await?;
    live_claim(&c, ctx, &i.claim_token)?;
    if c.plan.is_some() {
        return Err(refuse("plan_exists", "the campaign already has its plan"));
    }
    let held = findings(
        r.as_mut(),
        &c,
        &i.plan,
        account.as_ref(),
        limits.as_ref(),
        unusable.as_deref(),
        ctx.now,
    )
    .await?;
    if !held.is_empty() {
        c.refused = c.refused.saturating_add(1);
        c.refusal = Some(json!(held));
        if c.refused >= MAX_PLAN_REFUSALS {
            c.claim = None;
        }
        let refused = c.refused;
        save(r.as_mut(), ctx, c, "ads.campaign.plan_refused").await?;
        r.commit().await?;
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "the plan is refused: each finding names its field".into(),
            details: json!({"reason": "plan_refused", "findings": held, "refused": refused}),
        });
    }
    // The whole budget against every limit, then the plan is the campaign's.
    check_money(
        r.as_mut(),
        c.id,
        c.committed_minor(ctx.now),
        account.as_ref(),
        ctx.now,
    )
    .await?;
    c.built = Some(Built {
        account: i.plan.ad_account,
        campaign_id: None,
        adset_id: None,
        form_id: None,
        ads: (0..i.plan.ads.len())
            .map(|index| BuiltAd {
                index,
                status: BuiltAdStatus::InReview,
                feedback: None,
                image_hash: None,
                creative_id: None,
                ad_id: None,
                held: false,
                generation: 0,
                replaced_ad_ids: Vec::new(),
            })
            .collect(),
        activated_at: None,
        failed: None,
        watched_at: None,
        provider_paused: false,
    });
    c.end_at = Some(i.plan.end_at);
    c.plan = Some(i.plan.clone());
    c.claim = None;
    c.refused = 0;
    c.refusal = None;
    let id = c.id;
    save(r.as_mut(), ctx, c, "ads.campaign.planned").await?;
    r.studio()
        .request_receipt("ads.plan_submit", &i.request_key, &payload, &json!(id))
        .await?;
    r.commit().await?;
    // The build is Jeeta's: it goes as far as the provider lets it now, and on from there.
    let _ = build::run(d, ctx.workspace_id, id, ctx.now).await;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    Ok(r.ads()
        .get_campaign(id)
        .await?
        .ok_or_else(|| AppError::not_found("ad campaign"))?
        .present(ctx.now))
}

/// The JSON Schema of a plan's one ad.
pub(crate) fn ad_schema() -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    json!({"type":"object","additionalProperties":false,
        "required":["name","material_ids","primary_text","headline","call_to_action","page","hypothesis_id"],
        "properties":{
            "name":{"type":"string","minLength":1,"maxLength":MAX_AD_NAME},
            "material_ids":{"type":"array","items":uuid,"minItems":1,"maxItems":1,
                "description":"One image material of the library that may be shared."},
            "primary_text":{"type":"string","minLength":1,"maxLength":MAX_PRIMARY_TEXT},
            "headline":{"type":"string","minLength":1,"maxLength":MAX_HEADLINE},
            "description":{"type":["string","null"],"maxLength":MAX_DESCRIPTION},
            "call_to_action":{"type":"string","enum":CALLS_TO_ACTION},
            "page":{"type":"string","format":"uuid","description":"The Facebook Page capability the ad speaks as."},
            "instagram":{"type":["string","null"],"format":"uuid"},
            "hypothesis_id":uuid}})
}

/// The JSON Schema of a plan.
pub(crate) fn plan_schema() -> Value {
    let https = json!({"type":"string","format":"uri","pattern":"^https://"});
    json!({"type":"object","additionalProperties":false,
        "required":["ad_account","result","destination","audience","placements","end_at","ads","summary","audience_summary"],
        "properties":{
            "ad_account":{"type":"string","format":"uuid"},
            "result":{"type":"string","enum":["link_click","lead_form"]},
            "destination":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["kind","url"],
                 "properties":{"kind":{"const":"website"},"url":https}},
                {"type":"object","additionalProperties":false,
                 "required":["kind","page","name","questions","privacy_policy_url","thank_you_url"],
                 "properties":{"kind":{"const":"lead_form"},"page":{"type":"string","format":"uuid"},
                    "name":{"type":"string","minLength":1,"maxLength":MAX_AD_NAME},
                    "questions":{"type":"array","minItems":1,"items":{"type":"string","enum":QUESTIONS}},
                    "privacy_policy_url":https,"thank_you_url":https}}]},
            "special_ad_categories":{"type":"array","maxItems":0,
                "description":"Must be empty: a special ad category is not supported in this version."},
            "audience":{"type":"object","additionalProperties":false,
                "required":["countries","age_min","age_max"],
                "properties":{
                    "countries":{"type":"array","minItems":1,"maxItems":25,
                        "items":{"type":"string","pattern":"^[A-Z]{2}$"},
                        "description":"A country of the European Union is refused in this version."},
                    "regions":{"type":"array","items":{"type":"string"}},
                    "cities":{"type":"array","items":{"type":"string"}},
                    "age_min":{"type":"integer","minimum":18,"maximum":65},
                    "age_max":{"type":"integer","minimum":18,"maximum":65},
                    "genders":{"type":"array","items":{"type":"integer","enum":[1,2]}},
                    "interests":{"type":"array","maxItems":25,"items":{"type":"object",
                        "additionalProperties":false,"required":["id","name"],
                        "properties":{"id":{"type":"string"},"name":{"type":"string"}}}},
                    "broad":{"type":"boolean",
                        "description":"Let the ad platform find the people itself (Advantage+ audience). Then age_min is 18 to 25 and age_max is 65; for a narrower age range leave it false."}}},
            "placements":{"oneOf":[{"const":"automatic"},
                {"type":"object","additionalProperties":false,"required":["platforms"],
                 "properties":{"platforms":{"type":"array","minItems":1,
                    "items":{"type":"string","enum":["facebook","instagram"]}}}}]},
            "end_at":{"type":"string","format":"date-time",
                "description":"24 hours to 90 days after the campaign's start; the campaign's own end when a person set one."},
            "ads":{"type":"array","minItems":1,"maxItems":MAX_ADS,"items":ad_schema()},
            "summary":{"type":"string","minLength":1,"maxLength":MAX_TEXT_CHARS},
            "audience_summary":{"type":"string","minLength":1,"maxLength":MAX_TEXT_CHARS}}})
}
