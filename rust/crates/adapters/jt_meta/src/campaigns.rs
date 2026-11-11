//! Paused campaign creation and provider reads. One-time writes never retry blindly;
//! ambiguous outcomes must be reconciled by name by the caller.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jt_app::ports::connectors::*;
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};
use time::Date;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;

use crate::MetaConnector;
use crate::ads::{account_context, act, ads_token, optional_counter, optional_money};
use crate::credential::{MetaCred, account_of};
use crate::graph::{missing, node, strip_secrets, text};

pub(crate) async fn account_limits(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountLimits, ConnectorError> {
    let account = act(public)?;
    let app = c.ads_app()?;
    let row = c
        .graph_get(
            &app,
            ads_token(cred)?,
            &[&account],
            &[(
                "fields",
                "account_id,currency,timezone_name,min_daily_budget",
            )],
        )
        .await?;
    let account_id = text(&row["account_id"]).ok_or_else(|| missing("account id"))?;
    if format!("act_{account_id}") != account {
        return Err(ConnectorError::permanent(
            "ad account does not match capability",
        ));
    }
    let currency = text(&row["currency"]).ok_or_else(|| missing("currency"))?;
    Ok(AdAccountLimits {
        minor_unit_exponent: jt_connector::currency_minor_exponent(&currency)
            .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))?,
        currency,
        timezone: text(&row["timezone_name"])
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| missing("account timezone"))?,
        min_daily_budget_minor: optional_counter(&row["min_daily_budget"])?
            .ok_or_else(|| missing("minimum daily budget"))?,
        // Meta names a least daily budget only: the least total is that times the days.
        min_total_budget_minor: 0,
    })
}

pub(crate) async fn find_by_name(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    level: AdLevel,
    name: &str,
) -> Result<Option<String>, ConnectorError> {
    let edge = match level {
        AdLevel::Campaign => "campaigns",
        AdLevel::AdSet => "adsets",
        AdLevel::Ad => "ads",
        AdLevel::Creative => "adcreatives",
    };
    let app = c.ads_app()?;
    let token = ads_token(cred)?;
    let filtering = json!([{"field":"name", "operator":"EQUAL", "value":name}]).to_string();
    let rows = c
        .graph_pages_checked(
            &app,
            token,
            &[&act(public)?, edge],
            &[("fields", "id,name"), ("filtering", &filtering)],
        )
        .await?;
    let mut ids = Vec::new();
    for row in rows {
        let found_name = row["name"].as_str().ok_or_else(|| missing("object name"))?;
        if found_name == name {
            let id = text(&row["id"]).ok_or_else(|| missing("object id"))?;
            node(&id)?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    match ids.len() {
        0 => Ok(None),
        1 => Ok(ids.pop()),
        _ => Err(ConnectorError::permanent(strip_secrets(
            &format!("duplicate Meta objects: {}", ids.join(", ")),
            &[token.to_owned(), app.secret.clone()],
        ))),
    }
}

/// Every created object needs a returned id before its next build step can run.
async fn create(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    edge: &str,
    body: Value,
) -> Result<String, ConnectorError> {
    let app = c.ads_app()?;
    let row = c
        .graph_post_once(&app, ads_token(cred)?, &[&act(public)?, edge], &[], body)
        .await?;
    created_id(&row)
}
fn created_id(row: &Value) -> Result<String, ConnectorError> {
    text(&row["id"])
        .filter(|id| node(id).is_ok())
        .ok_or_else(|| ConnectorError::unknown("Meta creation returned no valid object id"))
}

pub(crate) async fn create_campaign(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    spec: &CampaignSpec,
) -> Result<String, ConnectorError> {
    if spec.lifetime_budget_minor <= 0 {
        return Err(ConnectorError::permanent(
            "campaign lifetime budget must be positive",
        ));
    }
    create(c, cred, public, "campaigns", json!({
        "name":spec.name, "objective":match spec.objective { AdObjective::Traffic => "OUTCOME_TRAFFIC", AdObjective::Leads => "OUTCOME_LEADS" },
        "status":"PAUSED", "special_ad_categories":[], "lifetime_budget":spec.lifetime_budget_minor, "bid_strategy":"LOWEST_COST_WITHOUT_CAP"
    })).await
}

pub(crate) async fn create_adset(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSetSpec,
) -> Result<String, ConnectorError> {
    node(&spec.campaign_id)?;
    if spec.end_at <= spec.start_at {
        return Err(ConnectorError::permanent("ad set end must follow start"));
    }
    let audience = &spec.audience;
    let mut geo = json!({});
    if !audience.countries.is_empty() {
        geo["countries"] = json!(audience.countries);
    }
    if !audience.regions.is_empty() {
        geo["regions"] = json!(
            audience
                .regions
                .iter()
                .map(|key| json!({"key":key}))
                .collect::<Vec<_>>()
        );
    }
    if !audience.cities.is_empty() {
        geo["cities"] = json!(
            audience
                .cities
                .iter()
                .map(|key| json!({"key":key}))
                .collect::<Vec<_>>()
        );
    }
    let mut targeting = json!({"geo_locations":geo,"age_min":audience.age_min,"targeting_automation":{"advantage_audience":u8::from(audience.broad)}});
    // With Advantage+ audience on, Meta fixes the upper age at 65 and takes no `age_max` (and a
    // lower age of 18 to 25 only): <https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-expansion/advantage-audience/>.
    if audience.broad {
        if audience.age_min > 25 || audience.age_max != 65 {
            return Err(ConnectorError::permanent(
                "a broad audience takes a lower age of 18 to 25 and no upper age below 65",
            ));
        }
    } else {
        targeting["age_max"] = json!(audience.age_max);
    }
    let male = audience.genders.contains(&AdGender::Male);
    let female = audience.genders.contains(&AdGender::Female);
    if male != female {
        targeting["genders"] = json!([if male { 1 } else { 2 }]);
    }
    if !audience.interests.is_empty() {
        targeting["flexible_spec"] = json!([{"interests":audience.interests}]);
    }
    if let AdPlacements::Platforms(platforms) = &spec.placements {
        targeting["publisher_platforms"] = json!(
            platforms
                .iter()
                .map(|p| match p {
                    AdPlatform::Facebook => "facebook",
                    AdPlatform::Instagram => "instagram",
                })
                .collect::<Vec<_>>()
        );
    }
    let mut body = json!({"name":spec.name,"campaign_id":spec.campaign_id,"status":"PAUSED","billing_event":"IMPRESSIONS","targeting":targeting,
        "start_time":spec.start_at.format(&Rfc3339).map_err(|_| ConnectorError::permanent("invalid ad set start time"))?,
        "end_time":spec.end_at.format(&Rfc3339).map_err(|_| ConnectorError::permanent("invalid ad set end time"))?});
    match &spec.goal {
        AdSetGoal::LinkClicks => body["optimization_goal"] = json!("LINK_CLICKS"),
        AdSetGoal::Leads { page_id } => {
            node(page_id)?;
            body["optimization_goal"] = json!("LEAD_GENERATION");
            body["destination_type"] = json!("ON_AD");
            body["promoted_object"] = json!({"page_id":page_id});
        }
    }
    create(c, cred, public, "adsets", body).await
}

pub(crate) async fn upload_image(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    bytes: &[u8],
    name: &str,
) -> Result<String, ConnectorError> {
    if bytes.is_empty() {
        return Err(ConnectorError::permanent("ad image is empty"));
    }
    let app = c.ads_app()?;
    let row = c
        .graph_post_once(
            &app,
            ads_token(cred)?,
            &[&act(public)?, "adimages"],
            &[],
            json!({"name":name,"bytes":STANDARD.encode(bytes)}),
        )
        .await?;
    let images = row["images"]
        .as_object()
        .filter(|images| images.len() == 1)
        .ok_or_else(|| ConnectorError::unknown("image upload returned no unique image"))?;
    images
        .values()
        .next()
        .and_then(|image| text(&image["hash"]))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ConnectorError::unknown("image upload returned no hash"))
}

pub(crate) async fn create_lead_form(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    spec: &LeadFormSpec,
) -> Result<String, ConnectorError> {
    let MetaCred::Page { page_id, token } = MetaCred::of(cred, "create lead form")? else {
        return Err(ConnectorError::permanent(
            "lead forms require a Page credential",
        ));
    };
    if account_of(public) != Some(page_id) {
        return Err(ConnectorError::permanent(
            "lead form page does not match credential",
        ));
    }
    let app = c.ads_app()?;
    let row=c.graph_post_once(&app,token,&[node(page_id)?,"leadgen_forms"],&[],json!({"name":spec.name,
        "questions":spec.questions.iter().map(|q| json!({"type":match q {LeadQuestion::FullName=>"FULL_NAME",LeadQuestion::Email=>"EMAIL",LeadQuestion::Phone=>"PHONE_NUMBER"}})).collect::<Vec<_>>(),
        "privacy_policy":{"url":spec.privacy_policy_url},"follow_up_action_url":spec.thank_you_url,"locale":spec.locale})).await?;
    created_id(&row)
}

fn object_story(spec: &CreativeSpec) -> Result<Value, ConnectorError> {
    // A Meta ad speaks as a Page, shows one image and carries a call to action.
    let page_id = spec
        .identity_id
        .as_deref()
        .ok_or_else(|| ConnectorError::permanent("a Meta ad needs its page"))?;
    let image_hash = spec
        .image
        .as_deref()
        .ok_or_else(|| ConnectorError::permanent("a Meta ad needs its image"))?;
    let call_to_action = spec
        .call_to_action
        .ok_or_else(|| ConnectorError::permanent("a Meta ad needs its call to action"))?;
    node(page_id)?;
    let (url, value) = match &spec.action {
        CreativeAction::Link { url } => (url, json!({"link":url})),
        CreativeAction::LeadForm { form_id, url } => {
            node(form_id)?;
            (url, json!({"lead_gen_form_id":form_id}))
        }
    };
    let cta = match call_to_action {
        CallToAction::LearnMore => "LEARN_MORE",
        CallToAction::SignUp => "SIGN_UP",
        CallToAction::ShopNow => "SHOP_NOW",
        CallToAction::ContactUs => "CONTACT_US",
        CallToAction::GetQuote => "GET_QUOTE",
        CallToAction::Subscribe => "SUBSCRIBE",
        CallToAction::ApplyNow => "APPLY_NOW",
        CallToAction::BookNow => "BOOK_NOW",
        CallToAction::Download => "DOWNLOAD",
    };
    let mut story = json!({"page_id":page_id,"link_data":{"link":url,"message":spec.primary_text,"name":spec.headline,"image_hash":image_hash,"call_to_action":{"type":cta,"value":value}}});
    if let Some(id) = &spec.instagram_user_id {
        node(id)?;
        story["instagram_user_id"] = json!(id);
    }
    if let Some(description) = &spec.description {
        story["link_data"]["description"] = json!(description);
    }
    Ok(story)
}

pub(crate) async fn create_creative(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    spec: &CreativeSpec,
) -> Result<String, ConnectorError> {
    // The ad that runs is the one that was planned and checked: Meta's Product showcase, which
    // from v27.0 Meta may turn on by itself for a creative that says nothing about it (products
    // of the account's catalog shown with the ad), is declined (design 2026-11-10 B55).
    create(
        c,
        cred,
        public,
        "adcreatives",
        json!({"name":spec.name,"object_story_spec":object_story(spec)?,
            "degrees_of_freedom_spec":{"creative_features_spec":{"product_extensions":{
                "enroll_status":"OPT_OUT","action_metadata":{"type":"MANUAL"}}}}}),
    )
    .await
}
pub(crate) async fn create_ad(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSpec,
) -> Result<String, ConnectorError> {
    node(&spec.adset_id)?;
    node(&spec.creative_id)?;
    create(c,cred,public,"ads",json!({"name":spec.name,"adset_id":spec.adset_id,"creative":{"creative_id":spec.creative_id},"status":"PAUSED"})).await
}

fn provider_status(value: &Value) -> Result<ProviderAdStatus, ConnectorError> {
    let status = value.as_str().ok_or_else(|| missing("effective status"))?;
    Ok(match status {
        "ACTIVE" => ProviderAdStatus::Active,
        "PAUSED" | "CAMPAIGN_PAUSED" | "ADSET_PAUSED" => ProviderAdStatus::Paused,
        "PENDING_REVIEW" | "IN_PROCESS" | "PREAPPROVED" => ProviderAdStatus::InReview,
        "DISAPPROVED" => ProviderAdStatus::Disapproved,
        "WITH_ISSUES" => ProviderAdStatus::WithIssues,
        "ARCHIVED" | "DELETED" => ProviderAdStatus::Archived,
        other => ProviderAdStatus::Other(other.to_owned()),
    })
}
fn feedback(value: &Value, reasons: &mut Vec<String>) {
    match value {
        Value::String(s) if !s.trim().is_empty() => reasons.push(s.clone()),
        Value::Array(values) => {
            for v in values {
                feedback(v, reasons);
            }
        }
        Value::Object(values) => {
            for v in values.values() {
                feedback(v, reasons);
            }
        }
        _ => {}
    }
}

fn check_campaign_account(row: &Value, account: &str) -> Result<(), ConnectorError> {
    let account_id = text(&row["account_id"]).ok_or_else(|| missing("campaign account id"))?;
    if format!("act_{account_id}") != account {
        return Err(ConnectorError::permanent(
            "campaign belongs to another account",
        ));
    }
    Ok(())
}

pub(crate) async fn campaign_state(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
) -> Result<CampaignProviderState, ConnectorError> {
    let account = act(public)?;
    let app = c.ads_app()?;
    let token = ads_token(cred)?;
    let row = c
        .graph_get(
            &app,
            token,
            &[node(campaign_id)?],
            &[("fields", "account_id,effective_status")],
        )
        .await?;
    check_campaign_account(&row, &account)?;
    let campaign = provider_status(&row["effective_status"])?;
    let rows = c
        .graph_pages_checked(
            &app,
            token,
            &[node(campaign_id)?, "ads"],
            &[("fields", "id,name,effective_status,ad_review_feedback")],
        )
        .await?;
    let ads = rows
        .iter()
        .map(|row| {
            let mut reasons = Vec::new();
            feedback(&row["ad_review_feedback"], &mut reasons);
            Ok(ProviderAd {
                ad_id: text(&row["id"]).ok_or_else(|| missing("ad id"))?,
                name: text(&row["name"]).ok_or_else(|| missing("ad name"))?,
                status: provider_status(&row["effective_status"])?,
                feedback: (!reasons.is_empty()).then(|| {
                    strip_secrets(&reasons.join("; "), &[token.to_owned(), app.secret.clone()])
                }),
            })
        })
        .collect::<Result<_, ConnectorError>>()?;
    Ok(CampaignProviderState { campaign, ads })
}

pub(crate) async fn ad_days(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
    objective: AdObjective,
    since: Date,
    until: Date,
) -> Result<Vec<AdDay>, ConnectorError> {
    node(campaign_id)?;
    // What the campaign is for, and nothing else: a traffic campaign's page may also record
    // leads, which are not this campaign's result.
    let result_kind = match objective {
        AdObjective::Leads => "lead",
        AdObjective::Traffic => "link_click",
    };
    if since > until {
        return Err(ConnectorError::permanent("insight date range is reversed"));
    }
    let context = account_context(c, cred, public).await?;
    let app = c.ads_app()?;
    let campaign = c
        .graph_get(
            &app,
            ads_token(cred)?,
            &[campaign_id],
            &[("fields", "account_id")],
        )
        .await?;
    check_campaign_account(&campaign, &format!("act_{}", context.account_id))?;
    let range = json!({"since":since.to_string(),"until":until.to_string()}).to_string();
    let rows = c
        .graph_pages_checked(
            &app,
            ads_token(cred)?,
            &[campaign_id, "insights"],
            &[
                ("level", "ad"),
                ("time_increment", "1"),
                ("time_range", &range),
                (
                    "fields",
                    "ad_id,date_start,spend,impressions,clicks,actions",
                ),
            ],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let day = row["date_start"]
                .as_str()
                .and_then(|s| Date::parse(s, &format_description!("[year]-[month]-[day]")).ok())
                .ok_or_else(|| missing("result date"))?;
            if day < since || day > until {
                return Err(ConnectorError::permanent(
                    "insight date outside requested range",
                ));
            }
            let results = match row["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|a| a["action_type"] == result_kind)
            {
                Some(action) => optional_counter(&action["value"])?,
                None => None,
            };
            Ok(AdDay {
                ad_id: text(&row["ad_id"]).ok_or_else(|| missing("ad id"))?,
                day,
                spend_minor: optional_money(&row["spend"], context.minor_unit_exponent)?,
                impressions: optional_counter(&row["impressions"])?,
                clicks: optional_counter(&row["clicks"])?,
                results,
            })
        })
        .collect()
}

pub(crate) async fn preview(
    c: &MetaConnector,
    cred: &Credential,
    public: &Value,
    creative: &CreativeSpec,
    placement: AdPlacement,
) -> Result<String, ConnectorError> {
    let app = c.ads_app()?;
    let format = match placement {
        AdPlacement::FacebookFeed => "MOBILE_FEED_STANDARD",
        AdPlacement::InstagramFeed => "INSTAGRAM_STANDARD",
        AdPlacement::InstagramStory => "INSTAGRAM_STORY",
        AdPlacement::InstagramReels => "INSTAGRAM_REELS",
    };
    let creative = json!({"object_story_spec":object_story(creative)?}).to_string();
    let row = c
        .graph_get(
            &app,
            ads_token(cred)?,
            &[&act(public)?, "generatepreviews"],
            &[("creative", &creative), ("ad_format", format)],
        )
        .await?;
    row["data"]
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(|row| row["body"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| missing("preview body"))
}
