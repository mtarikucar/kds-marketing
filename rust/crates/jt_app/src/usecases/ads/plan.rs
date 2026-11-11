//! The agent's plan (design 2026-11-10 §8.4): one structured decision, checked whole. A plan
//! that is not well formed is the caller's mistake (`VALIDATION`, naming the field) and counts
//! for nothing; a well-formed plan that breaks a rule is refused with every finding, counted,
//! and after the third in a row the campaign waits for a person.
use super::{
    build, check_money, live_claim, load, open_tx,
    platform::{self, MAX_KEYWORD_WORDS, PlatformRules, TextList},
    refuse, save,
};
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
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const QUESTIONS: [&str; 3] = ["FULL_NAME", "EMAIL", "PHONE"];
/// Targeting a country of the European Union needs the payer and the beneficiary named (DSA):
/// not in this version.
const EU: [&str; 27] = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
    "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];
/// The longest name of an ad. How long an ad's texts may be is its platform's
/// ([`platform::rules`]).
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

/// A field the platform does not take was given.
fn not_taken(field: &str) -> AppError {
    malformed(field, "field_not_for_this_platform")
}

/// A text the platform takes at most `rule` characters of, or does not take at all.
fn text(value: &str, field: &str, rule: Option<usize>) -> Result<(), AppError> {
    match rule {
        Some(max) => length(value, field, max),
        None if value.trim().is_empty() => Ok(()),
        None => Err(not_taken(field)),
    }
}

/// A list of texts the platform takes as `rule` says, or does not take at all. No text twice:
/// a platform that shows a few of them at a time refuses a list that repeats itself.
fn texts(values: &[String], field: &str, rule: Option<TextList>) -> Result<(), AppError> {
    let Some(rule) = rule else {
        return if values.is_empty() {
            Ok(())
        } else {
            Err(not_taken(field))
        };
    };
    if values.len() < rule.min || values.len() > rule.max {
        return Err(malformed(
            field,
            &format!("{}_to_{}_items", rule.min, rule.max),
        ));
    }
    for (n, value) in values.iter().enumerate() {
        length(value, &format!("{field}[{n}]"), rule.chars)?;
        let same = |other: &String| other.trim().to_lowercase() == value.trim().to_lowercase();
        if values[..n].iter().any(same) {
            return Err(malformed(&format!("{field}[{n}]"), "given_twice"));
        }
    }
    Ok(())
}

/// One ad's shape on its platform, as `ads[n]` or as the ad of a move.
pub(crate) fn ad_shape(ad: &PlanAd, at: &str, rules: &PlatformRules) -> Result<(), AppError> {
    length(&ad.name, &format!("{at}.name"), MAX_AD_NAME)?;
    text(
        &ad.primary_text,
        &format!("{at}.primary_text"),
        rules.primary_text,
    )?;
    if rules.no_emoji && platform::has_emoji(&ad.primary_text) {
        return Err(malformed(&format!("{at}.primary_text"), "no_emoji"));
    }
    text(&ad.headline, &format!("{at}.headline"), rules.headline)?;
    match (&ad.description, rules.description) {
        (Some(description), Some(max)) => {
            length(description, &format!("{at}.description"), max)?;
        }
        (Some(_), None) => return Err(not_taken(&format!("{at}.description"))),
        (None, _) => {}
    }
    if rules.image {
        if ad.material_ids.len() != 1 {
            return Err(malformed(&format!("{at}.material_ids"), "one_image"));
        }
    } else if !ad.material_ids.is_empty() {
        return Err(not_taken(&format!("{at}.material_ids")));
    }
    if rules.calls_to_action.is_empty() {
        if !ad.call_to_action.is_empty() {
            return Err(not_taken(&format!("{at}.call_to_action")));
        }
    } else if !rules.calls_to_action.contains(&ad.call_to_action.as_str()) {
        return Err(malformed(
            &format!("{at}.call_to_action"),
            "a_listed_call_to_action",
        ));
    }
    match (ad.page, rules.page_kind) {
        (None, Some(_)) => {
            return Err(malformed(
                &format!("{at}.page"),
                "required_on_this_platform",
            ));
        }
        (Some(_), None) => return Err(not_taken(&format!("{at}.page"))),
        _ => {}
    }
    if ad.instagram.is_some() && !rules.instagram {
        return Err(not_taken(&format!("{at}.instagram")));
    }
    texts(&ad.headlines, &format!("{at}.headlines"), rules.headlines)?;
    texts(
        &ad.descriptions,
        &format!("{at}.descriptions"),
        rules.descriptions,
    )
}

/// Whether two ads say the same: every text, the image, the account they speak as and the call
/// to action are equal (texts compared trimmed; names and hypotheses are not what an ad says).
fn says_the_same(a: &PlanAd, b: &PlanAd) -> bool {
    let trimmed = |list: &[String]| -> Vec<String> {
        list.iter().map(|text| text.trim().to_owned()).collect()
    };
    a.primary_text.trim() == b.primary_text.trim()
        && a.headline.trim() == b.headline.trim()
        && a.description.as_deref().map(str::trim) == b.description.as_deref().map(str::trim)
        && a.call_to_action == b.call_to_action
        && a.material_ids == b.material_ids
        && a.page == b.page
        && a.instagram == b.instagram
        && trimmed(&a.headlines) == trimmed(&b.headlines)
        && trimmed(&a.descriptions) == trimmed(&b.descriptions)
}

/// On a platform that knows an ad only by what it says ([`PlatformRules::distinct_ads`]), `ad`
/// (named `at`) must not say the same as any of `others`.
pub(crate) fn distinct<'a>(
    ad: &PlanAd,
    others: impl IntoIterator<Item = &'a PlanAd>,
    at: &str,
    rules: &PlatformRules,
) -> Result<(), AppError> {
    if rules.distinct_ads && others.into_iter().any(|other| says_the_same(ad, other)) {
        return Err(malformed(at, "same_as_another_ad"));
    }
    Ok(())
}

/// What of the plan itself its platform does not take.
fn platform_shape(p: &CampaignPlan, rules: &PlatformRules) -> Result<(), AppError> {
    let a = &p.audience;
    if !rules.audience_places_and_interests {
        for (given, field) in [
            (!a.regions.is_empty(), "audience.regions"),
            (!a.cities.is_empty(), "audience.cities"),
            (!a.interests.is_empty(), "audience.interests"),
        ] {
            if given {
                return Err(not_taken(field));
            }
        }
    }
    if a.broad && !rules.broad_audience {
        return Err(not_taken("audience.broad"));
    }
    if !rules.audience_age_and_gender {
        if a.age_min != 18 || a.age_max != 65 {
            return Err(not_taken("audience.age_min"));
        }
        if !a.genders.is_empty() {
            return Err(not_taken("audience.genders"));
        }
    }
    if p.placements != PlanPlacements::Automatic && !rules.placements {
        return Err(not_taken("placements"));
    }
    if p.result == AdResult::LeadForm && !rules.lead_form {
        return Err(not_taken("result"));
    }
    texts(&p.keywords, "keywords", rules.keywords)?;
    for (n, keyword) in p.keywords.iter().enumerate() {
        if keyword.split_whitespace().count() > MAX_KEYWORD_WORDS
            || keyword.chars().any(char::is_control)
        {
            return Err(malformed(
                &format!("keywords[{n}]"),
                "at_most_10_words_on_one_line",
            ));
        }
    }
    Ok(())
}

/// The plan's shape against the campaign it is for and the platform of its ad account (`rules`;
/// `None` when the plan names no ad account at all: then only what every platform shares is
/// looked at, and the account is what holds the plan), before anything is read.
fn shape(c: &AdCampaign, p: &CampaignPlan, rules: Option<&PlatformRules>) -> Result<(), AppError> {
    if p.ads.is_empty() || p.ads.len() > MAX_ADS {
        return Err(malformed("ads", "1_to_6_ads"));
    }
    if let Some(rules) = rules {
        for (n, ad) in p.ads.iter().enumerate() {
            let at = format!("ads[{n}]");
            ad_shape(ad, &at, rules)?;
            distinct(ad, &p.ads[..n], &at, rules)?;
        }
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
    rules.map_or(Ok(()), |rules| platform_shape(p, rules))
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

/// What holds one ad of a plan: the account it speaks as, where its platform's ad has one (live,
/// and in a group of the ad account when the account is in one), its hypothesis, its image
/// where it shows one (live, an image, free to be shared) and its texts (the truth check), as for
/// a post (B10). An ad without an image is checked on its texts alone.
pub(crate) async fn ad_findings(
    r: &mut dyn TenantRepos,
    ad: &PlanAd,
    at: &str,
    account: CapabilityId,
    rules: &PlatformRules,
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
    let mut identities = Vec::new();
    if let (Some(page), Some(kind)) = (ad.page, rules.page_kind) {
        identities.push((page, kind, format!("{at}.page")));
    }
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
            Some(m) if m.erased_at.is_none() && m.mime.starts_with("image/") => {
                // An image of a type the platform does not take would only be refused at the
                // build, after the plan was accepted.
                let mime = m.mime.trim().to_ascii_lowercase();
                if !rules.image_types.is_empty() && !rules.image_types.contains(&mime.as_str()) {
                    findings.push(json!({"field": format!("{at}.material_ids"),
                        "reason": "image_type_not_taken", "material_id": id,
                        "takes": rules.image_types}));
                }
                shown.push(m);
            }
            Some(_) => findings.push(json!({"field": format!("{at}.material_ids"),
                "reason": "not_a_live_image", "material_id": id})),
            None => findings.push(json!({"field": format!("{at}.material_ids"),
                "reason": "material_not_found", "material_id": id})),
        }
    }
    // Everything the ad says, wherever its platform puts it.
    let mut said: Vec<&str> = [ad.primary_text.as_str(), ad.headline.as_str()]
        .into_iter()
        .chain(ad.description.as_deref())
        .chain(ad.headlines.iter().map(String::as_str))
        .chain(ad.descriptions.iter().map(String::as_str))
        .collect();
    said.retain(|text| !text.trim().is_empty());
    let field = if rules.primary_text.is_some() {
        format!("{at}.primary_text")
    } else {
        format!("{at}.headlines")
    };
    let truth = if !shown.is_empty() {
        let subject = subject_of(&shown);
        let (hard, truth) = materials::check_content(r, &shown, &subject, &said, now).await?;
        findings.extend(hard.into_iter().map(|f| {
            json!({"field": format!("{at}.material_ids"), "kind": "material",
                   "reason": f.code, "material_id": f.material_id})
        }));
        truth
    } else if !rules.image {
        materials::check_texts(r, &said, now).await?
    } else {
        Vec::new()
    };
    findings.extend(truth.into_iter().map(|f| {
        json!({"field": field, "kind": "text",
               "reason": f.code.code(), "material_id": f.material_id,
               "olay_id": f.olay_id, "matched": f.matched})
    }));
    Ok(findings)
}

/// What the plan breaks, field by field; empty when it holds.
async fn findings(
    r: &mut dyn TenantRepos,
    c: &AdCampaign,
    p: &CampaignPlan,
    seen: &AccountView,
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
    match &seen.account {
        // An ad account of the workspace that cannot be written to says why: a grant without
        // the scope names the scope, so that a person knows to reconnect and what to allow.
        None => out.push(match (seen.unusable.as_deref(), seen.rules) {
            (Some(chain::SCOPE_MISSING), Some(rules)) => json!({"field": "ad_account",
                "reason": chain::SCOPE_MISSING,
                "needs": chain::write_scopes(rules.account_kind)}),
            (Some(why), _) => json!({"field": "ad_account", "reason": why}),
            (None, _) => json!({"field": "ad_account", "reason": "not_a_usable_ad_account"}),
        }),
        Some(account) => {
            if c.account_hint.is_some_and(|hint| hint != account.id) {
                out.push(json!({"field": "ad_account", "reason": "not_the_campaigns_account"}));
            }
            match &seen.limits {
                None => out.push(json!({"field": "ad_account", "reason": "account_unreadable"})),
                Some(limits) => {
                    if limits.currency != c.currency {
                        out.push(json!({"field": "ad_account", "reason": "currency_mismatch",
                            "account_currency": limits.currency, "budget_currency": c.currency}));
                    }
                    // The least the account takes: its least day times the days, and its least
                    // total whatever the length.
                    let days = ((p.end_at - c.start_at).whole_hours() + 23) / 24;
                    let least = limits
                        .min_daily_budget_minor
                        .saturating_mul(days.max(1))
                        .max(limits.min_total_budget_minor);
                    if c.budget_minor < least {
                        out.push(json!({"field": "budget_minor",
                            "reason": "below_the_accounts_minimum", "least": least}));
                    }
                }
            }
        }
    }
    let Some(rules) = seen.rules else {
        // No ad account, so no platform: what an ad may carry cannot be judged.
        return Ok(out);
    };
    // How long the platform lets a campaign run, from when it would really start.
    let run = p.end_at - c.start_at.max(now);
    if run < Duration::hours(rules.min_run_hours) || run > Duration::days(rules.max_run_days) {
        out.push(
            json!({"field": "end_at", "reason": "duration_not_supported",
            "least_hours": rules.min_run_hours, "most_days": rules.max_run_days}),
        );
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
        out.extend(
            ad_findings(
                r,
                ad,
                &format!("ads[{n}]"),
                p.ad_account,
                rules,
                &hypotheses,
                now,
            )
            .await?,
        );
    }
    Ok(out)
}

/// What is known of a plan's ad account.
pub(crate) struct AccountView {
    /// Its platform's rules, whenever it is an ad account of the workspace.
    pub rules: Option<&'static PlatformRules>,
    /// The account itself, when it can be written to now.
    pub account: Option<Capability>,
    /// What the provider says of it (currency, smallest budgets), when it answered.
    pub limits: Option<AdAccountLimits>,
    /// Why an ad account of the workspace cannot be written to now (the refusal of
    /// [`chain::capability_access`]).
    pub unusable: Option<String>,
}

/// The ad account `id` as a plan sees it: its platform, the account when it can be written to
/// now, and what the provider says of it. Something that is no ad account at all has none of
/// them.
pub(crate) async fn account_of(
    d: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
) -> Result<AccountView, AppError> {
    const UNAVAILABLE: &str = "capability_unavailable";
    let mut view = AccountView {
        rules: None,
        account: None,
        limits: None,
        unusable: None,
    };
    let (account, sealed) = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        let Some(c) = r.capabilities().find(id).await? else {
            return Ok(view);
        };
        view.rules = platform::rules_of_kind(&c.kind_key);
        if view.rules.is_none() {
            return Ok(view);
        }
        if let Err(e) = chain::capability_access(&c, ctx.now, true) {
            view.unusable = Some(
                e.details["reason"]
                    .as_str()
                    .unwrap_or(UNAVAILABLE)
                    .to_owned(),
            );
            return Ok(view);
        }
        let sealed = r.capabilities().read_sealed(c.id).await?;
        (c, sealed)
    };
    let Some(sealed) = sealed else {
        view.unusable = Some(UNAVAILABLE.to_owned());
        return Ok(view);
    };
    let writer = provider_for_kind(&account.kind_key).and_then(|p| d.connectors.ad_campaigns(p));
    if let (Some(writer), Ok(credential)) = (writer, open_credential(d, ctx.workspace_id, &sealed))
    {
        view.limits = writer
            .account_limits(&credential, &adapter_public(&account))
            .await
            .ok();
    }
    view.account = Some(account);
    Ok(view)
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
        let rules = r
            .capabilities()
            .find(i.plan.ad_account)
            .await?
            .and_then(|account| platform::rules_of_kind(&account.kind_key));
        shape(&c, &i.plan, rules)?;
    }
    // What the provider says of the account: read with no transaction open.
    let seen = account_of(d, ctx, i.plan.ad_account).await?;

    let mut r = open_tx(d, ctx, Permission::AdsWork).await?;
    let mut c = load(r.as_mut(), i.campaign_id, None).await?;
    live_claim(&c, ctx, &i.claim_token)?;
    if c.plan.is_some() {
        return Err(refuse("plan_exists", "the campaign already has its plan"));
    }
    let held = findings(r.as_mut(), &c, &i.plan, &seen, ctx.now).await?;
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
        seen.account.as_ref(),
        ctx.now,
    )
    .await?;
    c.built = Some(Built {
        account: i.plan.ad_account,
        platform: seen.rules.map(|rules| rules.platform).unwrap_or_default(),
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

/// The longest of each text any platform takes: the bound the schema states. The platform's own
/// bound is in its rules and is what a plan is held against.
fn longest(pick: fn(&PlatformRules) -> Option<usize>) -> usize {
    platform::all_rules()
        .into_iter()
        .filter_map(pick)
        .max()
        .unwrap_or(0)
}

/// The JSON Schema of a list of texts some platform takes.
fn list_schema(pick: fn(&PlatformRules) -> Option<TextList>, description: &str) -> Value {
    let rules: Vec<TextList> = platform::all_rules().into_iter().filter_map(pick).collect();
    json!({"type":"array",
        "maxItems": rules.iter().map(|r| r.max).max().unwrap_or(0),
        "items":{"type":"string","minLength":1,
            "maxLength": rules.iter().map(|r| r.chars).max().unwrap_or(0)},
        "description": description})
}

/// The JSON Schema of a plan's one ad.
pub(crate) fn ad_schema() -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    json!({"type":"object","additionalProperties":false,
        "required":["name","hypothesis_id"],
        "description":"What an ad carries is its platform's: the campaign's `platforms` (jeeta.ads.campaign_get) say which of these fields the platform of the plan's ad account takes and how long each may be. Leave out what it does not take: a field given anyway is refused (field_not_for_this_platform). Meta: page, material_ids, primary_text, headline, call_to_action (description and instagram optional). Google: headlines and descriptions only.",
        "properties":{
            "name":{"type":"string","minLength":1,"maxLength":MAX_AD_NAME},
            "material_ids":{"type":"array","items":uuid,"maxItems":1,
                "description":"One image material of the library that may be shared, on a platform whose ad shows an image."},
            "primary_text":{"type":"string","maxLength":longest(|r| r.primary_text)},
            "headline":{"type":"string","maxLength":longest(|r| r.headline)},
            "description":{"type":["string","null"],"maxLength":longest(|r| r.description)},
            "call_to_action":{"type":"string","enum":platform::META_CALLS_TO_ACTION},
            "page":{"type":["string","null"],"format":"uuid",
                "description":"The capability of the account the ad speaks as: a Facebook Page on Meta."},
            "instagram":{"type":["string","null"],"format":"uuid"},
            "headlines":list_schema(|r| r.headlines,
                "A search ad's headlines (Google: 3 to 15, each at most 30 characters, none twice); the platform shows a few at a time. No two ads of a Google campaign may say the same."),
            "descriptions":list_schema(|r| r.descriptions,
                "A search ad's descriptions (Google: 2 to 4, each at most 90 characters, none twice)."),
            "hypothesis_id":uuid}})
}

/// The JSON Schema of a plan.
pub(crate) fn plan_schema() -> Value {
    let https = json!({"type":"string","format":"uri","pattern":"^https://"});
    json!({"type":"object","additionalProperties":false,
        "required":["ad_account","result","destination","audience","end_at","ads","summary","audience_summary"],
        "properties":{
            "ad_account":{"type":"string","format":"uuid",
                "description":"The ad account capability the campaign runs on (jeeta.capability.list, group ads). Its kind is the campaign's platform: meta_ads, google_ads."},
            "result":{"type":"string","enum":["link_click","lead_form"],
                "description":"lead_form on Meta only."},
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
                "required":["countries"],
                "properties":{
                    "countries":{"type":"array","minItems":1,"maxItems":25,
                        "items":{"type":"string","pattern":"^[A-Z]{2}$"},
                        "description":"A country of the European Union is refused in this version."},
                    "regions":{"type":"array","items":{"type":"string"},"description":"Meta only."},
                    "cities":{"type":"array","items":{"type":"string"},"description":"Meta only."},
                    "age_min":{"type":"integer","minimum":18,"maximum":65,
                        "description":"18 when left out. Google search ads take no age range: leave it out."},
                    "age_max":{"type":"integer","minimum":18,"maximum":65,
                        "description":"65 when left out."},
                    "genders":{"type":"array","items":{"type":"integer","enum":[1,2]},
                        "description":"1 men, 2 women; empty: everybody. Not on Google."},
                    "interests":{"type":"array","maxItems":25,"description":"Meta only.","items":{"type":"object",
                        "additionalProperties":false,"required":["id","name"],
                        "properties":{"id":{"type":"string"},"name":{"type":"string"}}}},
                    "broad":{"type":"boolean",
                        "description":"Meta only. Let the ad platform find the people itself (Advantage+ audience). Then age_min is 18 to 25 and age_max is 65; for a narrower age range leave it false."}}},
            "placements":{"description":"automatic when left out; naming platforms is Meta's.","oneOf":[{"const":"automatic"},
                {"type":"object","additionalProperties":false,"required":["platforms"],
                 "properties":{"platforms":{"type":"array","minItems":1,
                    "items":{"type":"string","enum":["facebook","instagram"]}}}}]},
            "keywords":list_schema(|r| r.keywords,
                "Google only: the searches the ads answer, 1 to 20, each at most 80 characters and 10 words, none twice. Jeeta sets them as phrase match."),
            "end_at":{"type":"string","format":"date-time",
                "description":"24 hours to 90 days after the campaign's start (Google: 72 hours to 89 days after it really starts); the campaign's own end when a person set one."},
            "ads":{"type":"array","minItems":1,"maxItems":MAX_ADS,"items":ad_schema()},
            "summary":{"type":"string","minLength":1,"maxLength":MAX_TEXT_CHARS},
            "audience_summary":{"type":"string","minLength":1,"maxLength":MAX_TEXT_CHARS}}})
}
