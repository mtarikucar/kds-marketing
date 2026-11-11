//! Ad campaigns in a TikTok ad account (design 2026-11-11 §3.3): the campaign that holds the
//! total budget, the ad group that says who sees the ads and when, the image, the music a
//! carousel needs, the ad, their switches, their review and their daily numbers. The crate docs
//! hold the calls and the choices made.

use std::time::Instant;

use jt_app::ports::connectors::{
    AdAccountLimits, AdDay, AdLevel, AdObjective, AdSetGoal, AdSetSpec, AdSpec, AdStatus, Asset,
    CallToAction, CampaignProviderState, CampaignSpec, CreativeAction, CreativeSpec, ProviderAd,
    ProviderAdStatus,
};
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use md5::{Digest, Md5};
use serde_json::{Value, json};
use time::{
    Date, Duration, OffsetDateTime, UtcOffset, format_description::FormatItem,
    macros::format_description,
};

use crate::business::Payload;
use crate::client::{Effect, missing, text};
use crate::{TiktokConnector, budgets};

/// The capability kind of a TikTok ad account.
pub(crate) const ADS_KIND: &str = "tiktok_ads";

/// What the creative step answers: a TikTok ad carries its own content, made by the ad step.
pub(crate) const INLINE: &str = "inline";

/// What marks a credential as an advertiser's (a TikTok for Business token), in its scopes: the
/// ids of the permissions TikTok granted, each behind this prefix. A Login Kit credential (an
/// account that posts) carries none.
pub(crate) const BUSINESS_SCOPE: &str = "tiktok_business:";

/// The most ad accounts of an authorization offered for connection, and asked about at once.
pub(crate) const MAX_AD_ACCOUNTS: usize = 50;

/// The most pages of one list read (campaigns, ad groups, ads or report rows by a filter).
pub(crate) const MAX_AD_PAGES: usize = 20;

/// The rows asked for per page of a list.
const PAGE_SIZE: &str = "100";

/// The most days one report with a row per day may span (TikTok: "the query time range cannot
/// exceed 30 days").
const REPORT_DAYS: i64 = 30;

/// The longest text of an ad, in characters (TikTok's `ad_text`).
pub(crate) const MAX_AD_TEXT_CHARS: usize = 100;

/// The status of an ad account that can run ads.
const ENABLED: &str = "STATUS_ENABLE";

/// The age groups an ad group is shown to: every one of 18 and over, named explicitly (an ad
/// group that names none may reach 13 to 17, which TikTok refuses in many markets).
const ADULTS: &[&str] = &[
    "AGE_18_24",
    "AGE_25_34",
    "AGE_35_44",
    "AGE_45_54",
    "AGE_55_100",
];

/// A time as TikTok takes a schedule: UTC, `YYYY-MM-DD HH:MM:SS`.
const MOMENT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");

/// A day as TikTok takes it in a report and gives it back (the start of `stat_time_day`).
const DAY: &[FormatItem<'static>] = format_description!("[year]-[month]-[day]");

/// Which object of an ad account an id names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entity {
    Campaign,
    AdGroup,
    Ad,
}

impl Entity {
    fn word(self) -> &'static str {
        match self {
            Entity::Campaign => "campaign",
            Entity::AdGroup => "adgroup",
            Entity::Ad => "ad",
        }
    }
}

/// Whether `text` is 1 to 20 ASCII digits.
fn digits(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// The id this adapter gives the object `number` of kind `entity` in ad account `advertiser`:
/// `tt:{advertiser}:{campaign|adgroup|ad}:{number}`. Every call of TikTok's names the ad account
/// beside the object, which the object's own id does not carry; the id carries both.
pub(crate) fn id_of(advertiser: &str, entity: Entity, number: &str) -> String {
    format!("tt:{advertiser}:{}:{number}", entity.word())
}

/// The ad account, the kind and the number of an id of [`id_of`]'s shape; `None` for anything
/// else, so that an id can never change the request it is put in.
pub(crate) fn parse(id: &str) -> Option<(&str, Entity, &str)> {
    let mut parts = id.split(':');
    let (Some("tt"), Some(advertiser), Some(word), Some(number), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    let entity = [Entity::Campaign, Entity::AdGroup, Entity::Ad]
        .into_iter()
        .find(|e| e.word() == word)?;
    (digits(advertiser) && digits(number)).then_some((advertiser, entity, number))
}

/// The number of `id` when it names an object of kind `entity` in ad account `advertiser`.
fn owned<'a>(id: &'a str, entity: Entity, advertiser: &str) -> Result<&'a str, ConnectorError> {
    match parse(id) {
        Some((owner, kind, number)) if kind == entity && owner == advertiser => Ok(number),
        Some((_, kind, _)) if kind == entity => Err(ConnectorError::permanent(
            "the object is of another TikTok ad account",
        )),
        _ => Err(ConnectorError::permanent(
            "not a TikTok ad object of the expected kind",
        )),
    }
}

/// The ad account of the capability whose public fields are `public`: its advertiser id, 1 to
/// 20 digits; `Permanent` for another kind or a malformed id.
pub(crate) fn advertiser_of(public: &Value) -> Result<String, ConnectorError> {
    match public["kind_key"].as_str() {
        Some(ADS_KIND) => {}
        Some(_) => return Err(ConnectorError::permanent("not a TikTok ad account")),
        None => return Err(ConnectorError::permanent(crate::credential::KIND_MISSING)),
    }
    public["external_id"]
        .as_str()
        .map(str::trim)
        .filter(|id| digits(id))
        .map(str::to_owned)
        .ok_or_else(|| ConnectorError::permanent("the TikTok ad account id is missing"))
}

/// The access token of an advertiser's credential; `Permanent` for a credential that is not one
/// (an account's posting credential cannot `what` an ad account).
pub(crate) fn token_of<'a>(cred: &'a Credential, what: &str) -> Result<&'a str, ConnectorError> {
    match cred {
        Credential::OAuth {
            access_token,
            scopes,
            ..
        } if is_business(scopes) => Ok(access_token),
        _ => Err(ConnectorError::permanent(format!(
            "this credential cannot {what} on TikTok's API for Business"
        ))),
    }
}

/// Whether `scopes` are those of an advertiser's credential ([`BUSINESS_SCOPE`]).
pub(crate) fn is_business(scopes: &[String]) -> bool {
    scopes.iter().any(|scope| scope.starts_with(BUSINESS_SCOPE))
}

/// `minor` minor units of a currency whose minor unit is 10^-`exponent` of it, as the number
/// TikTok takes for a budget.
fn amount(minor: i64, exponent: u8) -> Result<Value, ConnectorError> {
    if minor <= 0 || exponent > 6 {
        return Err(ConnectorError::permanent(
            "the campaign budget is not an amount",
        ));
    }
    let unit = 10i64.pow(u32::from(exponent));
    if minor % unit == 0 {
        return Ok(json!(minor / unit));
    }
    // A whole number of minor units is exact in a double well beyond any budget.
    #[allow(clippy::cast_precision_loss)]
    let value = minor as f64 / unit as f64;
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| ConnectorError::permanent("the campaign budget is not an amount"))
}

/// A decimal amount TikTok reports (a string such as `"12.3456"`, or a number) as minor units,
/// rounded to the nearest; `None` when it is not a plain non-negative decimal.
fn minor_of(value: &Value, exponent: u8) -> Option<i64> {
    let written = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let (whole, fraction) = written.split_once('.').unwrap_or((&written, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || exponent > 6
    {
        return None;
    }
    let places = usize::from(exponent);
    let mut kept: String = fraction.chars().take(places).collect();
    while kept.len() < places {
        kept.push('0');
    }
    let round_up = fraction.chars().nth(places).is_some_and(|next| next >= '5');
    let whole: i64 = whole.parse().ok()?;
    let part: i64 = if kept.is_empty() {
        0
    } else {
        kept.parse().ok()?
    };
    whole
        .checked_mul(10i64.pow(u32::from(exponent)))?
        .checked_add(part)?
        .checked_add(i64::from(round_up))
}

/// A count TikTok reports (a string such as `"1840"`, or a number); `None` when the row carries
/// none.
fn count(metrics: &Value, name: &str) -> Result<Option<i64>, ConnectorError> {
    let not_a_count = || ConnectorError::permanent(format!("TikTok's {name} is not a count"));
    match &metrics[name] {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() || s.trim() == "-" => Ok(None),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(not_a_count),
        value => value
            .as_i64()
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(not_a_count),
    }
}

/// The minor unit exponent of `currency`; `Permanent` for one the system does not count in.
fn exponent(currency: &str) -> Result<u8, ConnectorError> {
    jt_connector::currency_minor_exponent(currency)
        .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))
}

/// `value` as the JSON text a `GET` of TikTok's carries a list or an object in.
fn encoded(value: &Value) -> String {
    value.to_string()
}

/// What TikTok says of an ad account.
struct Advertiser {
    id: String,
    name: Option<String>,
    status: String,
    currency: String,
    /// The account's time zone as a zone name (`Europe/Istanbul`, or `Etc/GMT+8`).
    time_zone: String,
    country: Option<String>,
}

impl Advertiser {
    fn of(row: &Value) -> Option<Advertiser> {
        Some(Advertiser {
            id: text(&row["advertiser_id"]).filter(|id| digits(id))?,
            name: text(&row["name"]),
            status: text(&row["status"]).unwrap_or_default(),
            currency: text(&row["currency"])?,
            time_zone: text(&row["display_timezone"]).or_else(|| text(&row["timezone"]))?,
            country: text(&row["country"]),
        })
    }
}

impl TiktokConnector {
    /// A read of the API for Business: `segments` with `query`, as `token`.
    async fn business_get(
        &self,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
        secrets: &[&str],
    ) -> Result<Value, ConnectorError> {
        self.business(
            Method::GET,
            self.business_url(segments, query),
            Some(token),
            &Payload::None,
            Effect::Read,
            secrets,
        )
        .await
    }

    /// A write of the API for Business: `body` posted to `segments`, as `token`, once.
    async fn business_post(
        &self,
        token: &str,
        segments: &[&str],
        body: Value,
    ) -> Result<Value, ConnectorError> {
        self.business(
            Method::POST,
            self.business_url(segments, &[]),
            Some(token),
            &Payload::Json(body),
            Effect::Commit,
            &[],
        )
        .await
    }

    /// The ad accounts `ids`, as this token reads them (those TikTok answers for).
    async fn advertisers(
        &self,
        token: &str,
        ids: &[String],
    ) -> Result<Vec<Advertiser>, ConnectorError> {
        let mut found = Vec::new();
        for chunk in ids.chunks(MAX_AD_ACCOUNTS) {
            let data = self
                .business_get(
                    token,
                    &["advertiser", "info"],
                    &[("advertiser_ids", &encoded(&json!(chunk)))],
                    &[],
                )
                .await?;
            let rows = match &data["list"] {
                Value::Array(rows) => rows,
                Value::Null => continue,
                _ => return Err(missing("ad account list")),
            };
            found.extend(rows.iter().filter_map(Advertiser::of));
        }
        Ok(found)
    }

    /// The ad account `advertiser`, as this token reads it: the one that was asked for, never
    /// another.
    async fn advertiser(
        &self,
        token: &str,
        advertiser: &str,
    ) -> Result<Advertiser, ConnectorError> {
        self.advertisers(token, &[advertiser.to_owned()])
            .await?
            .into_iter()
            .find(|a| a.id == advertiser)
            .ok_or_else(|| ConnectorError::permission("TikTok does not show this ad account"))
    }

    /// Every row of the list at `segments` that `filtering` keeps, page by page (at most
    /// [`MAX_AD_PAGES`] pages; a list that still has more is refused, not cut short).
    async fn listed(
        &self,
        token: &str,
        advertiser: &str,
        segments: &[&str],
        more: &[(&str, String)],
    ) -> Result<Vec<Value>, ConnectorError> {
        let mut rows = Vec::new();
        for page in 1..=MAX_AD_PAGES {
            let page_text = page.to_string();
            let mut query: Vec<(&str, &str)> = vec![
                ("advertiser_id", advertiser),
                ("page", &page_text),
                ("page_size", PAGE_SIZE),
            ];
            query.extend(more.iter().map(|(name, value)| (*name, value.as_str())));
            let data = self.business_get(token, segments, &query, &[]).await?;
            match &data["list"] {
                Value::Array(list) => rows.extend(list.iter().cloned()),
                Value::Null => {}
                _ => return Err(missing("list")),
            }
            let pages = data["page_info"]["total_page"].as_u64().unwrap_or(1);
            if page as u64 >= pages {
                return Ok(rows);
            }
        }
        Err(ConnectorError::permanent(
            "TikTok's answer has more pages than are read",
        ))
    }
}

/// The ad accounts the authorization covers, with their currency and time zone: those TikTok
/// lists for the token and reports as enabled.
pub(crate) async fn list_assets(
    connector: &TiktokConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list ad accounts")?;
    let app = connector.tiktok_ads_app()?;
    // TikTok takes the app's id and secret in this call's query: the secret is kept out of
    // every reason.
    let data = connector
        .business_get(
            token,
            &["oauth2", "advertiser", "get"],
            &[("app_id", &app.app_id), ("secret", &app.secret)],
            &[&app.secret],
        )
        .await?;
    let ids: Vec<String> = data["list"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| text(&row["advertiser_id"]))
        .filter(|id| digits(id))
        .take(MAX_AD_ACCOUNTS)
        .collect();
    let accounts = connector.advertisers(token, &ids).await?;
    Ok(accounts
        .into_iter()
        .filter(|account| account.status == ENABLED)
        .map(|account| Asset {
            kind_key: ADS_KIND.to_owned(),
            name: account.name.clone().unwrap_or_else(|| account.id.clone()),
            external_id: account.id,
            credential: cred.clone(),
            public: json!({
                "currency": account.currency,
                "time_zone": account.time_zone,
                "country": account.country,
            }),
        })
        .collect())
}

/// The probe of an ad account capability (never fails: a failure is a failed probe).
pub(crate) async fn probe(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = async {
        let wanted = advertiser_of(public)?;
        let token = token_of(cred, "be probed")?;
        let account = connector.advertiser(token, &wanted).await?;
        if account.status != ENABLED {
            return Err(ConnectorError::permission(
                "the TikTok ad account is not enabled",
            ));
        }
        Ok(json!({
            "account_id": account.id,
            "name": account.name,
            "currency": account.currency,
            "time_zone": account.time_zone,
            "country": account.country,
        }))
    }
    .await;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

/// The least budgets of the account's currency, in minor units: an ad group's least daily
/// budget and a campaign's least budget (see `crate::budgets`).
fn minimums(currency: &str, exponent: u8) -> Result<(i64, i64), ConnectorError> {
    let ratio = budgets::ratio_of(currency).ok_or_else(|| {
        ConnectorError::permanent("TikTok lists no budget range for the ad account's currency")
    })?;
    let unit = 10i64.pow(u32::from(exponent));
    let of = |usd: i64| {
        usd.checked_mul(ratio)
            .and_then(|n| n.checked_mul(unit))
            .ok_or_else(|| ConnectorError::permanent("the least budget is out of range"))
    };
    Ok((of(budgets::ADGROUP_DAILY_USD)?, of(budgets::CAMPAIGN_USD)?))
}

pub(crate) async fn account_limits(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountLimits, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let token = token_of(cred, "read an ad account")?;
    let account = c.advertiser(token, &advertiser).await?;
    let exponent = exponent(&account.currency)?;
    let (min_daily_budget_minor, min_total_budget_minor) = minimums(&account.currency, exponent)?;
    Ok(AdAccountLimits {
        minor_unit_exponent: exponent,
        currency: account.currency,
        timezone: account.time_zone,
        min_daily_budget_minor,
        min_total_budget_minor,
    })
}

/// The one object named exactly `name` among `rows` (TikTok's name filter matches loosely), as
/// its id; `None` when there is none.
fn named(
    rows: &[Value],
    name_field: &str,
    id_field: &str,
    name: &str,
    advertiser: &str,
    entity: Entity,
) -> Result<Option<String>, ConnectorError> {
    let mut found = rows
        .iter()
        .filter(|row| row[name_field].as_str() == Some(name))
        .filter_map(|row| text(&row[id_field]))
        .filter(|id| digits(id));
    match (found.next(), found.next()) {
        (None, _) => Ok(None),
        (Some(id), None) => Ok(Some(id_of(advertiser, entity, &id))),
        _ => Err(ConnectorError::permanent(
            "more than one object of the account carries this name",
        )),
    }
}

/// The filter of a list by a name, leaving out what was deleted.
fn by_name(field: &str, name: &str) -> (&'static str, String) {
    (
        "filtering",
        encoded(&json!({field: name, "primary_status": "STATUS_NOT_DELETE"})),
    )
}

pub(crate) async fn find_by_name(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    level: AdLevel,
    name: &str,
) -> Result<Option<String>, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let (segments, name_field, id_field, entity): (&[&str], _, _, _) = match level {
        AdLevel::Campaign => (
            &["campaign", "get"],
            "campaign_name",
            "campaign_id",
            Entity::Campaign,
        ),
        AdLevel::AdSet => (
            &["adgroup", "get"],
            "adgroup_name",
            "adgroup_id",
            Entity::AdGroup,
        ),
        // A TikTok ad carries its own content: there is no creative to find. And TikTok's list
        // of ads has no filter by name: the ad step looks its ad up in its own ad group.
        AdLevel::Creative | AdLevel::Ad => return Ok(None),
    };
    let token = token_of(cred, "search an ad account")?;
    let rows = c
        .listed(token, &advertiser, segments, &[by_name(name_field, name)])
        .await?;
    named(&rows, name_field, id_field, name, &advertiser, entity)
}

/// The id TikTok gave what it just created, under `field` of its answer; `Unknown` without a
/// valid one (the object may well exist).
fn created(data: &Value, field: &str) -> Result<String, ConnectorError> {
    text(&data[field])
        .filter(|id| digits(id))
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid id"))
}

/// The campaign: a traffic campaign with the whole budget as its lifetime budget, switched off.
/// No `request_id` is sent: TikTok then refuses a second campaign of the same name by itself.
pub(crate) async fn create_campaign(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    spec: &CampaignSpec,
) -> Result<String, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    if spec.objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a TikTok campaign here brings visits to a website only",
        ));
    }
    let token = token_of(cred, "create a campaign")?;
    let account = c.advertiser(token, &advertiser).await?;
    let data = c
        .business_post(
            token,
            &["campaign", "create"],
            json!({
                "advertiser_id": advertiser,
                "campaign_name": spec.name,
                "objective_type": "TRAFFIC",
                "budget_mode": "BUDGET_MODE_TOTAL",
                "budget": amount(spec.lifetime_budget_minor, exponent(&account.currency)?)?,
                "operation_status": "DISABLE",
            }),
        )
        .await?;
    Ok(id_of(
        &advertiser,
        Entity::Campaign,
        &created(&data, "campaign_id")?,
    ))
}

/// TikTok's location ids of the countries `codes`, as it offers them to this ad account for a
/// traffic campaign on TikTok itself. A country it does not offer is a refusal.
async fn locations(
    c: &TiktokConnector,
    token: &str,
    advertiser: &str,
    codes: &[String],
) -> Result<Vec<String>, ConnectorError> {
    let data = c
        .business_get(
            token,
            &["tool", "region"],
            &[
                ("advertiser_id", advertiser),
                ("placements", &encoded(&json!(["PLACEMENT_TIKTOK"]))),
                ("objective_type", "TRAFFIC"),
                ("level_range", "TO_COUNTRY"),
            ],
            &[],
        )
        .await?;
    let offered = match &data["region_info"] {
        Value::Array(rows) => rows,
        _ => return Err(missing("locations")),
    };
    codes
        .iter()
        .map(|code| {
            let mut found = offered
                .iter()
                .filter(|row| row["level"].as_str() == Some("COUNTRY"))
                .filter(|row| row["region_code"].as_str() == Some(code.as_str()))
                .filter_map(|row| text(&row["location_id"]))
                .filter(|id| digits(id));
            match (found.next(), found.next()) {
                (Some(id), None) => Ok(id),
                _ => Err(ConnectorError::permanent(format!(
                    "TikTok offers this ad account no single location for the country {code}"
                ))),
            }
        })
        .collect()
}

/// `at` as TikTok takes a schedule's time.
fn moment(at: OffsetDateTime) -> Result<String, ConnectorError> {
    at.to_offset(UtcOffset::UTC)
        .format(MOMENT)
        .map_err(|_| ConnectorError::permanent("the campaign's time cannot be written"))
}

/// The ad group: who sees the ads (the countries, everyone of 18 and over), where (TikTok
/// itself), when, with the whole budget once more as its lifetime budget, switched off.
pub(crate) async fn create_adset(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSetSpec,
) -> Result<String, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let campaign = owned(&spec.campaign_id, Entity::Campaign, &advertiser)?;
    if spec.goal != AdSetGoal::LinkClicks {
        return Err(ConnectorError::permanent(
            "a TikTok campaign here brings visits to a website only",
        ));
    }
    if spec.audience.countries.is_empty() {
        return Err(ConnectorError::permanent(
            "a TikTok ad group needs its countries",
        ));
    }
    if spec.end_at <= spec.start_at {
        return Err(ConnectorError::permanent(
            "the campaign ends before it starts",
        ));
    }
    let token = token_of(cred, "create an ad group")?;
    let account = c.advertiser(token, &advertiser).await?;
    let location_ids = locations(c, token, &advertiser, &spec.audience.countries).await?;
    let data = c
        .business_post(
            token,
            &["adgroup", "create"],
            json!({
                "advertiser_id": advertiser,
                "campaign_id": campaign,
                "adgroup_name": spec.name,
                "promotion_type": "WEBSITE",
                // TikTok itself only: what was planned and checked is what runs.
                "placement_type": "PLACEMENT_TYPE_NORMAL",
                "placements": ["PLACEMENT_TIKTOK"],
                "location_ids": location_ids,
                "age_groups": ADULTS,
                "gender": "GENDER_UNLIMITED",
                "budget_mode": "BUDGET_MODE_TOTAL",
                "budget": amount(spec.budget_minor, exponent(&account.currency)?)?,
                "schedule_type": "SCHEDULE_START_END",
                "schedule_start_time": moment(spec.start_at)?,
                "schedule_end_time": moment(spec.end_at)?,
                "optimization_goal": "CLICK",
                "billing_event": "CPC",
                // TikTok bids by itself for the most clicks within the budget.
                "bid_type": "BID_TYPE_NO_BID",
                "pacing": "PACING_MODE_SMOOTH",
                "operation_status": "DISABLE",
            }),
        )
        .await?;
    Ok(id_of(
        &advertiser,
        Entity::AdGroup,
        &created(&data, "adgroup_id")?,
    ))
}

/// The media type of an image by its first bytes: JPG or PNG (what a TikTok carousel takes).
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        _ => None,
    }
}

/// The MD5 of `bytes`, as the hexadecimal text TikTok checks an upload against.
fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The ad's image, uploaded to the ad account's library. Its file name carries the image's own
/// digest: TikTok refuses a second file of the same name in an ad account, and the same image
/// uploaded again after a lost answer is found by that name.
pub(crate) async fn upload_image(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    bytes: &[u8],
    name: &str,
) -> Result<String, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let mime = image_mime(bytes)
        .ok_or_else(|| ConnectorError::permanent("a TikTok ad image is a JPG or a PNG"))?;
    let token = token_of(cred, "upload an ad image")?;
    let signature = md5_hex(bytes);
    let extension = if mime == "image/png" { "png" } else { "jpg" };
    let file_name = format!("{name}-{}.{extension}", &signature[..12]);
    let uploaded = c
        .business(
            Method::POST,
            c.business_url(&["file", "image", "ad", "upload"], &[]),
            Some(token),
            &Payload::File {
                fields: vec![
                    ("advertiser_id", advertiser.clone()),
                    ("upload_type", "UPLOAD_BY_FILE".to_owned()),
                    ("image_signature", signature.clone()),
                    ("file_name", file_name.clone()),
                ],
                part: "image_file",
                bytes,
                file_name: file_name.clone(),
                mime,
            },
            Effect::Commit,
            &[],
        )
        .await;
    match uploaded {
        Ok(data) => text(&data["image_id"])
            .ok_or_else(|| ConnectorError::unknown("accepted response lacks an image id")),
        // The name is taken: the image went up before (its answer was lost). It is found by
        // its digest among the account's images.
        Err(e) if e.kind() == "permanent" && e.reason().is_some_and(|r| r.contains(" 40911")) => {
            // TikTok's image search has no filter by digest: the ad account's images are read
            // (up to the pages a list is read to) and the digest is matched here. An account
            // with more images than that keeps TikTok's own refusal.
            let Ok(rows) = c
                .listed(token, &advertiser, &["file", "image", "ad", "search"], &[])
                .await
            else {
                return Err(e);
            };
            rows.iter()
                .filter(|row| row["signature"].as_str() == Some(signature.as_str()))
                .find_map(|row| text(&row["image_id"]))
                .ok_or(e)
        }
        Err(e) => Err(e),
    }
}

/// TikTok's value of a call to action.
fn label(action: CallToAction) -> &'static str {
    match action {
        CallToAction::LearnMore => "LEARN_MORE",
        CallToAction::SignUp => "SIGN_UP",
        CallToAction::ShopNow => "SHOP_NOW",
        CallToAction::ContactUs => "CONTACT_US",
        CallToAction::GetQuote => "GET_QUOTE",
        CallToAction::Subscribe => "SUBSCRIBE",
        CallToAction::ApplyNow => "APPLY_NOW",
        CallToAction::BookNow => "BOOK_NOW",
        CallToAction::Download => "DOWNLOAD_NOW",
    }
}

/// The length of an ad's text as TikTok counts it: "Each word in Chinese or Japanese counts as
/// two characters, while each letter in English counts as one character".
fn text_units(text: &str) -> usize {
    text.chars()
        .map(|c| match u32::from(c) {
            // CJK ideographs and their extensions, kana, CJK punctuation, fullwidth forms.
            0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF => 2,
            _ => 1,
        })
        .sum()
}

/// What a TikTok ad is made of, once its parts are held: the image, the text, the button and
/// the address.
struct Parts<'a> {
    image: &'a str,
    text: &'a str,
    action: &'static str,
    url: &'a str,
}

/// The parts of `spec` as a TikTok carousel ad takes them; `Permanent` for one it cannot show.
fn parts(spec: &CreativeSpec) -> Result<Parts<'_>, ConnectorError> {
    let image = spec
        .image
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| ConnectorError::permanent("a TikTok ad needs its image"))?;
    let CreativeAction::Link { url } = &spec.action else {
        return Err(ConnectorError::permanent(
            "a TikTok ad here leads to a website",
        ));
    };
    let action = spec
        .call_to_action
        .map(label)
        .ok_or_else(|| ConnectorError::permanent("a TikTok ad needs its call to action"))?;
    let text = spec.primary_text.trim();
    if text.is_empty() || text_units(text) > MAX_AD_TEXT_CHARS {
        return Err(ConnectorError::permanent(
            "a TikTok ad's text is 1 to 100 characters",
        ));
    }
    Ok(Parts {
        image,
        text,
        action,
        url: url.as_str(),
    })
}

/// The creative step: nothing is sent; the ad's parts are checked, and the ad step makes the ad.
pub(crate) fn create_creative(
    public: &Value,
    spec: &CreativeSpec,
) -> Result<String, ConnectorError> {
    advertiser_of(public)?;
    parts(spec)?;
    Ok(INLINE.to_owned())
}

/// The TikTok account the ad account's ads speak as: the one linked account that can show ads.
/// None, or several, is a refusal: an ad is never put under a guessed account.
async fn identity(
    c: &TiktokConnector,
    token: &str,
    advertiser: &str,
) -> Result<Value, ConnectorError> {
    // One page of every kind of identity (TikTok's paging of this list holds only for one kind
    // at a time; an ad account with more than a hundred identities is not one this serves).
    let data = c
        .business_get(
            token,
            &["identity", "get"],
            &[("advertiser_id", advertiser), ("page_size", PAGE_SIZE)],
            &[],
        )
        .await?;
    let rows = match &data["identity_list"] {
        Value::Array(rows) => rows.clone(),
        Value::Null => Vec::new(),
        _ => return Err(missing("identities")),
    };
    let mut usable = rows.into_iter().filter(|row| {
        matches!(
            row["identity_type"].as_str(),
            Some("TT_USER" | "BC_AUTH_TT")
        ) && row["available_status"]
            .as_str()
            .is_none_or(|status| status == "AVAILABLE")
            && row["can_push_video"].as_bool() != Some(false)
            // (TikTok: such an identity "cannot be used to create Spark Ads".)
            && row["is_gpppa"].as_bool() != Some(true)
            && text(&row["identity_id"]).is_some()
    });
    match (usable.next(), usable.next()) {
        (Some(one), None) => Ok(one),
        (None, _) => Err(ConnectorError::permanent(
            "the TikTok ad account has no linked TikTok account that can show ads",
        )),
        _ => Err(ConnectorError::permanent(
            "the TikTok ad account has more than one linked TikTok account",
        )),
    }
}

/// The keyword the music search falls back to when the ad account has neither liked nor used
/// any music: a plain instrumental.
const MUSIC_KEYWORD: &str = "background";

/// The music of a carousel ad (TikTok requires one). TikTok recommends music only for two
/// images or more, and an ad here shows one; so the piece is, in this order: the first the
/// advertiser marked as liked in TikTok's own tools (their choice), else the first the ad
/// account used before, else the first TikTok finds for [`MUSIC_KEYWORD`]. Every one of them is
/// music TikTok offers for carousel ads (`music_scene=CAROUSEL_ADS`).
async fn music(
    c: &TiktokConnector,
    token: &str,
    advertiser: &str,
    image_id: &str,
) -> Result<String, ConnectorError> {
    // The image must be one TikTok takes in a carousel: said here, not by a refused ad.
    let info = c
        .business_get(
            token,
            &["file", "image", "ad", "info"],
            &[
                ("advertiser_id", advertiser),
                ("image_ids", &encoded(&json!([image_id]))),
            ],
            &[],
        )
        .await?;
    let image = info["list"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["image_id"].as_str() == Some(image_id))
        .ok_or_else(|| ConnectorError::permanent("the ad's image is not in the ad account"))?;
    if image["is_carousel_usable"].as_bool() == Some(false) {
        return Err(ConnectorError::permanent(
            "TikTok does not take this image in a carousel ad",
        ));
    }
    let searches: [(&str, Option<String>); 3] = [
        ("SEARCH_BY_LIKED", None),
        ("SEARCH_BY_HISTORY", None),
        (
            "SEARCH_BY_KEYWORD",
            Some(encoded(&json!({ "keyword": MUSIC_KEYWORD }))),
        ),
    ];
    for (search_type, filtering) in searches {
        let mut query = vec![
            ("advertiser_id", advertiser),
            ("music_scene", "CAROUSEL_ADS"),
            ("search_type", search_type),
        ];
        if let Some(filtering) = &filtering {
            query.push(("filtering", filtering.as_str()));
        }
        let data = c
            .business_get(token, &["file", "music", "get"], &query, &[])
            .await?;
        let found = data["musics"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|row| text(&row["music_id"]));
        if let Some(music_id) = found {
            return Ok(music_id);
        }
    }
    Err(ConnectorError::permanent(
        "TikTok offers the ad account no music for a carousel ad",
    ))
}

/// The ad: a one-image carousel under the ad account's linked TikTok account, with the music
/// TikTok recommends, switched off. An ad of the ad group that already carries the name is
/// adopted: after a lost answer no second one is made.
pub(crate) async fn create_ad(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSpec,
) -> Result<String, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let adgroup = owned(&spec.adset_id, Entity::AdGroup, &advertiser)?;
    let parts = parts(&spec.creative)?;
    let token = token_of(cred, "create an ad")?;
    let existing = c
        .listed(
            token,
            &advertiser,
            &["ad", "get"],
            // TikTok's list of ads has no filter by name: the ad group's ads are read, and
            // the name is matched here.
            &[(
                "filtering",
                encoded(&json!({"adgroup_ids": [adgroup],
                    "primary_status": "STATUS_NOT_DELETE"})),
            )],
        )
        .await?;
    if let Some(found) = named(
        &existing,
        "ad_name",
        "ad_id",
        &spec.name,
        &advertiser,
        Entity::Ad,
    )? {
        return Ok(found);
    }
    let speaker = identity(c, token, &advertiser).await?;
    let music_id = music(c, token, &advertiser, parts.image).await?;
    let mut creative = json!({
        "ad_name": spec.name,
        "ad_format": "CAROUSEL_ADS",
        "ad_text": parts.text,
        "call_to_action": parts.action,
        "image_ids": [parts.image],
        "music_id": music_id,
        "identity_type": speaker["identity_type"],
        "identity_id": speaker["identity_id"],
        "landing_page_url": parts.url,
        "operation_status": "DISABLE",
    });
    if let Some(center) = text(&speaker["identity_authorized_bc_id"]) {
        creative["identity_authorized_bc_id"] = json!(center);
    }
    let data = c
        .business_post(
            token,
            &["ad", "create"],
            json!({"advertiser_id": advertiser, "adgroup_id": adgroup, "creatives": [creative]}),
        )
        .await?;
    let ad = data["ad_ids"]
        .as_array()
        .and_then(|ids| ids.first())
        .and_then(text)
        .or_else(|| text(&data["creatives"][0]["ad_id"]))
        .filter(|id| digits(id))
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid id"))?;
    Ok(id_of(&advertiser, Entity::Ad, &ad))
}

/// Switches the campaign, the ad group or the ad `entity_id` names on or off.
pub(crate) async fn set_status(
    c: &TiktokConnector,
    cred: &Credential,
    entity_id: &str,
    status: AdStatus,
) -> Result<(), ConnectorError> {
    let (advertiser, entity, number) = parse(entity_id)
        .ok_or_else(|| ConnectorError::permanent("not a TikTok ad object of the expected kind"))?;
    let (segments, field): (&[&str], _) = match entity {
        Entity::Campaign => (&["campaign", "status", "update"], "campaign_ids"),
        Entity::AdGroup => (&["adgroup", "status", "update"], "adgroup_ids"),
        Entity::Ad => (&["ad", "status", "update"], "ad_ids"),
    };
    let token = token_of(cred, "change an ad's status")?;
    c.business_post(
        token,
        segments,
        json!({
            "advertiser_id": advertiser,
            field: [number],
            "operation_status": match status {
                AdStatus::Active => "ENABLE",
                AdStatus::Paused => "DISABLE",
            },
        }),
    )
    .await
    .map(|_| ())
}

/// How an ad stands, from its switch and what TikTok says of it (`secondary_status`). A review
/// that failed is that whatever the switch says; then a switch that is off; then the review
/// that is not over; then what keeps an enabled ad from running.
fn ad_status(row: &Value) -> ProviderAdStatus {
    let secondary = row["secondary_status"].as_str().unwrap_or_default();
    match secondary {
        "AD_STATUS_AUDIT_DENY"
        | "AD_STATUS_ADGROUP_AUDIT_DENY"
        | "AD_STATUS_REVIEW_PARTIALLY_APPROVED"
        | "AD_STATUS_ADVERTISER_AUDIT_DENY" => return ProviderAdStatus::Disapproved,
        "AD_STATUS_DELETE"
        | "AD_STATUS_ADGROUP_DELETE"
        | "AD_STATUS_CAMPAIGN_DELETE"
        | "AD_STATUS_DONE" => return ProviderAdStatus::Archived,
        _ => {}
    }
    match row["operation_status"].as_str().unwrap_or_default() {
        "DISABLE" => return ProviderAdStatus::Paused,
        "FROZEN" => return ProviderAdStatus::Archived,
        _ => {}
    }
    match secondary {
        "AD_STATUS_AUDIT"
        | "AD_STATUS_REAUDIT"
        | "AD_STATUS_AD_PRE_ONLINE"
        | "AD_STATUS_PARTIAL_AUDIT_NO_DELIVERY"
        | "AD_STATUS_ADGROUP_PARTIAL_AUDIT_NO_DELIVERY"
        | "AD_STATUS_PROCESS_AUDIO" => ProviderAdStatus::InReview,
        "AD_STATUS_DELIVERY_OK" | "AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK" | "AD_STATUS_NOT_START" => {
            ProviderAdStatus::Active
        }
        "AD_STATUS_DISABLE" | "AD_STATUS_ADGROUP_DISABLE" | "AD_STATUS_CAMPAIGN_DISABLE" => {
            ProviderAdStatus::Paused
        }
        // The sandbox answers no secondary status: the switch is all there is.
        "" => ProviderAdStatus::Active,
        other => ProviderAdStatus::Other(other.to_owned()),
    }
}

/// What TikTok's review says of the ads `ids`, by ad: its rejection reasons and its
/// suggestion, for a person to act on. Best effort: an ad it says nothing of has none.
async fn review(
    c: &TiktokConnector,
    token: &str,
    advertiser: &str,
    ids: &[String],
) -> Result<Vec<(String, String)>, ConnectorError> {
    let mut out = Vec::new();
    for chunk in ids.chunks(100) {
        let data = c
            .business_get(
                token,
                &["ad", "review_info"],
                &[
                    ("advertiser_id", advertiser),
                    ("ad_ids", &encoded(&json!(chunk))),
                ],
                &[],
            )
            .await?;
        let Some(map) = data["ad_review_map"].as_object() else {
            continue;
        };
        for (ad, info) in map {
            let mut said: Vec<String> = Vec::new();
            for rejection in info["reject_info"].as_array().into_iter().flatten() {
                said.extend(
                    rejection["reasons"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(text),
                );
                said.extend(text(&rejection["suggestion"]));
            }
            if !said.is_empty() {
                out.push((ad.clone(), said.join(" ")));
            }
        }
    }
    Ok(out)
}

pub(crate) async fn campaign_state(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
) -> Result<CampaignProviderState, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let campaign = owned(campaign_id, Entity::Campaign, &advertiser)?;
    let token = token_of(cred, "read a campaign")?;
    let of_campaign = (
        "filtering",
        encoded(&json!({"campaign_ids": [campaign], "primary_status": "STATUS_ALL"})),
    );
    let campaigns = c
        .listed(
            token,
            &advertiser,
            &["campaign", "get"],
            std::slice::from_ref(&of_campaign),
        )
        .await?;
    let row = campaigns
        .iter()
        .find(|row| text(&row["campaign_id"]).as_deref() == Some(campaign))
        .ok_or_else(|| missing("campaign"))?;
    let status = match (
        row["operation_status"].as_str().unwrap_or_default(),
        row["secondary_status"].as_str().unwrap_or_default(),
    ) {
        (_, "CAMPAIGN_STATUS_DELETE") => ProviderAdStatus::Archived,
        ("ENABLE", _) => ProviderAdStatus::Active,
        ("DISABLE", _) => ProviderAdStatus::Paused,
        (other, _) => ProviderAdStatus::Other(other.to_owned()),
    };
    let rows = c
        .listed(
            token,
            &advertiser,
            &["ad", "get"],
            &[(
                "filtering",
                encoded(&json!({"campaign_ids": [campaign],
                    "primary_status": "STATUS_NOT_DELETE"})),
            )],
        )
        .await?;
    let mut ads = Vec::new();
    for row in &rows {
        let ad = text(&row["ad_id"])
            .filter(|id| digits(id))
            .ok_or_else(|| missing("ad id"))?;
        ads.push((
            ad,
            text(&row["ad_name"]).unwrap_or_default(),
            ad_status(row),
        ));
    }
    let denied: Vec<String> = ads
        .iter()
        .filter(|(_, _, status)| *status == ProviderAdStatus::Disapproved)
        .map(|(id, _, _)| id.clone())
        .collect();
    // What the review said is for a person to read: a failure to read it does not hide the
    // state itself.
    let reasons = if denied.is_empty() {
        Vec::new()
    } else {
        review(c, token, &advertiser, &denied)
            .await
            .unwrap_or_default()
    };
    Ok(CampaignProviderState {
        campaign: status,
        ads: ads
            .into_iter()
            .map(|(ad, name, status)| ProviderAd {
                feedback: reasons
                    .iter()
                    .find(|(id, _)| *id == ad)
                    .map(|(_, said)| said.clone()),
                ad_id: id_of(&advertiser, Entity::Ad, &ad),
                name,
                status,
            })
            .collect(),
    })
}

pub(crate) async fn ad_days(
    c: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
    objective: AdObjective,
    since: Date,
    until: Date,
) -> Result<Vec<AdDay>, ConnectorError> {
    let advertiser = advertiser_of(public)?;
    let campaign = owned(campaign_id, Entity::Campaign, &advertiser)?;
    if objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a TikTok campaign here brings visits to a website only",
        ));
    }
    let day = |date: Date| {
        date.format(DAY)
            .map_err(|_| ConnectorError::permanent("the day cannot be written"))
    };
    let token = token_of(cred, "read a campaign's numbers")?;
    let account = c.advertiser(token, &advertiser).await?;
    let exponent = exponent(&account.currency)?;
    // A report by day spans at most [`REPORT_DAYS`] days: a longer range is read in pieces.
    let mut rows = Vec::new();
    let mut from = since;
    while from <= until {
        let to = from
            .checked_add(Duration::days(REPORT_DAYS - 1))
            .map_or(until, |end| end.min(until));
        rows.extend(
            c.listed(
                token,
                &advertiser,
                &["report", "integrated", "get"],
                &[
                    ("service_type", "AUCTION".to_owned()),
                    ("report_type", "BASIC".to_owned()),
                    ("data_level", "AUCTION_AD".to_owned()),
                    ("dimensions", encoded(&json!(["ad_id", "stat_time_day"]))),
                    (
                        "metrics",
                        encoded(&json!(["spend", "impressions", "clicks"])),
                    ),
                    ("start_date", day(from)?),
                    ("end_date", day(to)?),
                    (
                        "filtering",
                        encoded(&json!([{"field_name": "campaign_ids", "filter_type": "IN",
                            "filter_value": encoded(&json!([campaign]))}])),
                    ),
                ],
            )
            .await?,
        );
        match to.next_day() {
            Some(next) => from = next,
            None => break,
        }
    }
    rows.iter()
        .map(|row| {
            let ad = text(&row["dimensions"]["ad_id"])
                .filter(|id| digits(id))
                .ok_or_else(|| missing("ad id"))?;
            let day = row["dimensions"]["stat_time_day"]
                .as_str()
                .and_then(|at| at.get(..10))
                .and_then(|date| Date::parse(date, DAY).ok())
                .ok_or_else(|| missing("day"))?;
            let metrics = &row["metrics"];
            let spend_minor =
                match &metrics["spend"] {
                    Value::Null => None,
                    value => Some(minor_of(value, exponent).ok_or_else(|| {
                        ConnectorError::permanent("TikTok's spend is not an amount")
                    })?),
                };
            let clicks = count(metrics, "clicks")?;
            Ok(AdDay {
                ad_id: id_of(&advertiser, Entity::Ad, &ad),
                day,
                spend_minor,
                impressions: count(metrics, "impressions")?,
                clicks,
                // What the campaign is for here is the visit: a click on the ad.
                results: clicks,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_their_ad_account_and_kind_or_are_nothing() {
        assert_eq!(id_of("7001", Entity::AdGroup, "42"), "tt:7001:adgroup:42");
        assert_eq!(
            parse("tt:7001:campaign:9"),
            Some(("7001", Entity::Campaign, "9"))
        );
        assert_eq!(
            parse("tt:7001:ad:1800000000000001"),
            Some(("7001", Entity::Ad, "1800000000000001"))
        );
        for bad in [
            "",
            "7001",
            "tt:7001:ad",
            "tt:7001:ad:1:x",
            "tt:70a1:ad:1",
            "tt:7001:creative:1",
            "tt:7001:ad:-1",
            "li:7001:campaign:1",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(
            owned("tt:7001:campaign:9", Entity::Campaign, "7001").unwrap(),
            "9"
        );
        assert_eq!(
            owned("tt:9999:campaign:9", Entity::Campaign, "7001")
                .unwrap_err()
                .reason(),
            Some("the object is of another TikTok ad account")
        );
        assert!(owned("tt:7001:adgroup:9", Entity::Campaign, "7001").is_err());
    }

    #[test]
    fn budgets_go_out_as_numbers_and_spend_comes_back_as_minor_units() {
        assert_eq!(amount(50_000, 2).unwrap(), json!(500));
        assert_eq!(amount(50_050, 2).unwrap(), json!(500.5));
        assert_eq!(amount(1_500, 0).unwrap(), json!(1500));
        assert!(amount(0, 2).is_err());
        assert_eq!(minor_of(&json!("142.00"), 2), Some(14_200));
        assert_eq!(minor_of(&json!("12.3456"), 2), Some(1_235));
        assert_eq!(minor_of(&json!(7), 2), Some(700));
        assert_eq!(minor_of(&json!("7.5"), 0), Some(8));
        assert_eq!(minor_of(&json!("-1"), 2), None);
        assert_eq!(minor_of(&json!("1e3"), 2), None);
        assert_eq!(minor_of(&json!(null), 2), None);
    }

    #[test]
    fn the_least_budgets_follow_the_currencys_ratio() {
        // 20 and 50 US dollars; ten times that in Turkish lira; a hundred times in yen.
        assert_eq!(minimums("USD", 2).unwrap(), (2_000, 5_000));
        assert_eq!(minimums("TRY", 2).unwrap(), (20_000, 50_000));
        assert_eq!(minimums("JPY", 0).unwrap(), (2_000, 5_000));
        assert_eq!(
            minimums("XXX", 2).unwrap_err().reason(),
            Some("TikTok lists no budget range for the ad account's currency")
        );
    }

    #[test]
    fn an_ads_state_is_the_review_first_then_its_switch() {
        let ad = |operation: &str, secondary: &str| json!({"operation_status": operation, "secondary_status": secondary});
        for (operation, secondary, expected) in [
            ("ENABLE", "AD_STATUS_DELIVERY_OK", ProviderAdStatus::Active),
            ("ENABLE", "AD_STATUS_NOT_START", ProviderAdStatus::Active),
            ("ENABLE", "AD_STATUS_AUDIT", ProviderAdStatus::InReview),
            (
                "ENABLE",
                "AD_STATUS_AUDIT_DENY",
                ProviderAdStatus::Disapproved,
            ),
            (
                "DISABLE",
                "AD_STATUS_AUDIT_DENY",
                ProviderAdStatus::Disapproved,
            ),
            ("DISABLE", "AD_STATUS_AUDIT", ProviderAdStatus::Paused),
            ("DISABLE", "AD_STATUS_DISABLE", ProviderAdStatus::Paused),
            (
                "ENABLE",
                "AD_STATUS_CAMPAIGN_DISABLE",
                ProviderAdStatus::Paused,
            ),
            ("ENABLE", "AD_STATUS_DELETE", ProviderAdStatus::Archived),
            ("FROZEN", "", ProviderAdStatus::Archived),
            ("ENABLE", "", ProviderAdStatus::Active),
            (
                "ENABLE",
                "AD_STATUS_BALANCE_EXCEED",
                ProviderAdStatus::Other("AD_STATUS_BALANCE_EXCEED".into()),
            ),
        ] {
            assert_eq!(
                ad_status(&ad(operation, secondary)),
                expected,
                "{operation} {secondary}"
            );
        }
    }

    #[test]
    fn an_image_is_known_by_its_first_bytes_and_named_by_its_digest() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_mime(b"GIF89a"), None);
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn a_text_is_counted_as_tiktok_counts_it() {
        assert_eq!(text_units("Yeni sezon kayıtları açıldı"), 27);
        // Chinese and Japanese characters count twice.
        assert_eq!(text_units("新しい季節"), 10);
        assert_eq!(text_units("新 season"), 9);
    }

    #[test]
    fn a_moment_is_written_in_utc_as_tiktok_takes_it() {
        let at = time::macros::datetime!(2026-11-12 01:30:05 +03:00);
        assert_eq!(moment(at).unwrap(), "2026-11-11 22:30:05");
    }

    #[test]
    fn only_an_advertisers_credential_reaches_an_ad_account() {
        let cred = |scopes: &[&str]| Credential::OAuth {
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        };
        assert_eq!(token_of(&cred(&["tiktok_business:2"]), "x").unwrap(), "t");
        assert!(token_of(&cred(&["video.publish"]), "x").is_err());
        assert!(token_of(&cred(&[]), "x").is_err());
    }
}
