//! Building a search campaign in a Google Ads account: the total budget and the campaign, the ad
//! group with its countries and keywords, the responsive search ads, and switching each of them
//! on and off (the crate docs hold the calls and the choices made).

use jt_app::ports::connectors::{
    AdAccountLimits, AdLevel, AdObjective, AdSetGoal, AdSetSpec, AdSpec, AdStatus, CampaignSpec,
    CreativeAction, CreativeSpec,
};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::account::account_of;
use crate::client::{Auth, Body, Endpoint, missing, text};
use crate::{GoogleConnector, INLINE};

/// Which object a resource name is of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entity {
    Campaign,
    AdGroup,
    Ad,
}

impl Entity {
    /// The collection segment of its resource names.
    fn collection(self) -> &'static str {
        match self {
            Entity::Campaign => "campaigns",
            Entity::AdGroup => "adGroups",
            Entity::Ad => "adGroupAds",
        }
    }
}

/// Whether `text` is 1 to 20 ASCII digits.
fn digits(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// The customer and the kind of the resource name `name`, when it is one this adapter makes:
/// `customers/{digits}/campaigns/{digits}`, `.../adGroups/{digits}` or
/// `.../adGroupAds/{digits}~{digits}`. Anything else is `None`, so that an id can never change
/// the request it is put in.
pub(crate) fn resource(name: &str) -> Option<(&str, Entity)> {
    let mut parts = name.split('/');
    let (Some("customers"), Some(customer), Some(collection), Some(id), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    if !digits(customer) || customer.len() > 12 {
        return None;
    }
    let entity = [Entity::Campaign, Entity::AdGroup, Entity::Ad]
        .into_iter()
        .find(|e| e.collection() == collection)?;
    let well_formed = match entity {
        Entity::Campaign | Entity::AdGroup => digits(id),
        Entity::Ad => id
            .split_once('~')
            .is_some_and(|(group, ad)| digits(group) && digits(ad)),
    };
    well_formed.then_some((customer, entity))
}

/// `name` as a resource name of `entity` in account `customer`; `Permanent` otherwise.
pub(crate) fn owned<'a>(
    name: &'a str,
    entity: Entity,
    customer: &str,
) -> Result<&'a str, ConnectorError> {
    match resource(name) {
        Some((owner, kind)) if kind == entity && owner == customer => Ok(name),
        Some((_, kind)) if kind == entity => Err(ConnectorError::permanent(
            "the object is of another Google Ads account",
        )),
        _ => Err(ConnectorError::permanent(
            "not a Google Ads resource name of the expected kind",
        )),
    }
}

/// `name` when it can be written into a query as it is: Jeeta's own object names
/// (`jeeta:<campaign>:campaign`), letters, digits, `:`, `-` and `_`.
fn plain_name(name: &str) -> Result<&str, ConnectorError> {
    let plain = !name.is_empty()
        && name.len() <= 200
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_'));
    plain
        .then_some(name)
        .ok_or_else(|| ConnectorError::permanent("the object's name cannot be searched for"))
}

/// The micros per minor unit of a currency whose minor unit is 10^-`exponent` of it.
fn unit(exponent: u8) -> Result<i64, ConnectorError> {
    6u32.checked_sub(u32::from(exponent))
        .map(|power| 10i64.pow(power))
        .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))
}

/// `minor` minor units as micros.
pub(crate) fn micros(minor: i64, exponent: u8) -> Result<i64, ConnectorError> {
    minor
        .checked_mul(unit(exponent)?)
        .filter(|m| *m > 0)
        .ok_or_else(|| ConnectorError::permanent("the campaign budget is not an amount"))
}

/// `micros` as minor units, rounded to the nearest.
pub(crate) fn minor(micros: i64, exponent: u8) -> Result<i64, ConnectorError> {
    let unit = unit(exponent)?;
    Ok(micros.saturating_add(unit / 2).div_euclid(unit))
}

/// The minor unit exponent of `currency`; `Permanent` for one the system does not count in.
pub(crate) fn exponent(currency: &str) -> Result<u8, ConnectorError> {
    jt_connector::currency_minor_exponent(currency)
        .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))
}

/// The calendar day of `at` in the time zone `zone` (an IANA name), as `YYYY-MM-DD`.
fn local_day(zone: &str, at: OffsetDateTime) -> Result<String, ConnectorError> {
    use chrono::TimeZone;
    let tz: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| ConnectorError::permanent("the ad account's time zone is not known"))?;
    let utc = chrono::DateTime::from_timestamp(at.unix_timestamp(), 0)
        .ok_or_else(|| ConnectorError::permanent("the campaign's time is out of range"))?;
    Ok(tz
        .from_utc_datetime(&utc.naive_utc())
        .format("%Y-%m-%d")
        .to_string())
}

/// The resource name the `n`-th operation of a mutate made, under its result key `result`.
fn made(answer: &Value, result: &str) -> Result<String, ConnectorError> {
    answer["mutateOperationResponses"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|response| text(&response[result]["resourceName"]))
        // The mutate was accepted, but what it made is not named: never created again blindly.
        .ok_or_else(|| ConnectorError::unknown("Google's answer does not name what was created"))
}

impl GoogleConnector {
    /// One transaction of `operations` on customer `customer`.
    async fn mutate(
        &self,
        token: &str,
        customer: &str,
        operations: Vec<Value>,
    ) -> Result<Value, ConnectorError> {
        self.call(
            Method::POST,
            self.api_url(&["customers", customer, "googleAds:mutate"]),
            Auth::Bearer(token),
            &Body::Json(json!({ "mutateOperations": operations })),
            Endpoint::Write,
        )
        .await
    }
}

pub(crate) async fn account_limits(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountLimits, ConnectorError> {
    let customer = account_of(public)?;
    let token = c.access_token(cred).await?;
    let facts = c.customer(&token, &customer).await?;
    Ok(AdAccountLimits {
        minor_unit_exponent: exponent(&facts.currency)?,
        currency: facts.currency,
        timezone: facts.time_zone,
        // Google names no least budget for a search campaign.
        min_daily_budget_minor: 0,
        min_total_budget_minor: 0,
    })
}

pub(crate) async fn find_by_name(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    level: AdLevel,
    name: &str,
) -> Result<Option<String>, ConnectorError> {
    let customer = account_of(public)?;
    let (resource, entity, key) = match level {
        AdLevel::Campaign => ("campaign", Entity::Campaign, "campaign"),
        AdLevel::AdSet => ("ad_group", Entity::AdGroup, "adGroup"),
        // A search ad has no creative object, and an ad no name: the ad step itself looks for
        // an ad that already says the same (see the crate docs).
        AdLevel::Creative | AdLevel::Ad => return Ok(None),
    };
    let name = plain_name(name)?;
    let token = c.access_token(cred).await?;
    let rows = c
        .search(
            &token,
            &customer,
            &format!(
                "SELECT {resource}.resource_name FROM {resource} WHERE {resource}.name = '{name}' \
                 AND {resource}.status != 'REMOVED'"
            ),
        )
        .await?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => {
            let found = text(&row[key]["resourceName"]).ok_or_else(|| missing("resource name"))?;
            owned(&found, entity, &customer)?;
            Ok(Some(found))
        }
        _ => Err(ConnectorError::permanent(
            "more than one object of the account carries this name",
        )),
    }
}

pub(crate) async fn create_campaign(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    spec: &CampaignSpec,
) -> Result<String, ConnectorError> {
    let customer = account_of(public)?;
    if spec.objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a Google search campaign brings visits to a website only",
        ));
    }
    if spec.end_at <= spec.start_at {
        return Err(ConnectorError::permanent(
            "the campaign ends before it starts",
        ));
    }
    plain_name(&spec.name)?;
    let token = c.access_token(cred).await?;
    // The budget is in the account's currency and the days in its time zone.
    let facts = c.customer(&token, &customer).await?;
    let total = micros(spec.lifetime_budget_minor, exponent(&facts.currency)?)?;
    let start = local_day(&facts.time_zone, spec.start_at)?;
    let end = local_day(&facts.time_zone, spec.end_at)?;
    let budget = format!("customers/{customer}/campaignBudgets/-1");
    let answer = c
        .mutate(
            &token,
            &customer,
            vec![
                // The whole budget as Google's own total (design 2026-11-10 B32): spent over the
                // campaign's days, never more.
                json!({"campaignBudgetOperation": {"create": {
                    "resourceName": budget,
                    "period": "CUSTOM_PERIOD",
                    "totalAmountMicros": total.to_string(),
                    "explicitlyShared": false,
                    "deliveryMethod": "STANDARD",
                }}}),
                json!({"campaignOperation": {"create": {
                    "name": spec.name,
                    "status": "PAUSED",
                    "advertisingChannelType": "SEARCH",
                    "campaignBudget": budget,
                    "targetSpend": {},
                    "networkSettings": {
                        "targetGoogleSearch": true,
                        "targetSearchNetwork": false,
                        "targetContentNetwork": false,
                        "targetPartnerSearchNetwork": false,
                    },
                    "geoTargetTypeSetting": {"positiveGeoTargetType": "PRESENCE"},
                    "startDateTime": format!("{start} 00:00:00"),
                    "endDateTime": format!("{end} 23:59:59"),
                    "containsEuPoliticalAdvertising":
                        "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                }}}),
            ],
        )
        .await?;
    let campaign = made(&answer, "campaignResult")?;
    owned(&campaign, Entity::Campaign, &customer)
        .map_err(|_| ConnectorError::unknown("Google's answer names an unexpected campaign"))?;
    Ok(campaign)
}

/// The geo target constants of `countries` (two-letter codes), in their order.
async fn countries(
    c: &GoogleConnector,
    token: &str,
    customer: &str,
    countries: &[String],
) -> Result<Vec<String>, ConnectorError> {
    if countries.is_empty()
        || countries
            .iter()
            .any(|code| code.len() != 2 || !code.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return Err(ConnectorError::permanent(
            "a search campaign needs its countries as two-letter codes",
        ));
    }
    let list = countries
        .iter()
        .map(|code| format!("'{code}'"))
        .collect::<Vec<_>>()
        .join(", ");
    let rows = c
        .search(
            token,
            customer,
            &format!(
                "SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM \
                 geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND \
                 geo_target_constant.status = 'ENABLED' AND geo_target_constant.country_code IN \
                 ({list})"
            ),
        )
        .await?;
    countries
        .iter()
        .map(|code| {
            let mut found = rows.iter().filter_map(|row| {
                let constant = &row["geoTargetConstant"];
                (constant["countryCode"].as_str() == Some(code.as_str()))
                    .then(|| text(&constant["resourceName"]))
                    .flatten()
            });
            match (found.next(), found.next()) {
                (Some(name), None)
                    if name.strip_prefix("geoTargetConstants/").is_some_and(digits) =>
                {
                    Ok(name)
                }
                _ => Err(ConnectorError::permanent(format!(
                    "Google names no single target for the country {code}"
                ))),
            }
        })
        .collect()
}

pub(crate) async fn create_adset(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSetSpec,
) -> Result<String, ConnectorError> {
    let customer = account_of(public)?;
    let campaign = owned(&spec.campaign_id, Entity::Campaign, &customer)?;
    if spec.goal != AdSetGoal::LinkClicks {
        return Err(ConnectorError::permanent(
            "a Google search campaign brings visits to a website only",
        ));
    }
    if spec.keywords.is_empty() {
        return Err(ConnectorError::permanent(
            "a search campaign needs the searches it answers",
        ));
    }
    plain_name(&spec.name)?;
    let token = c.access_token(cred).await?;
    let targets = countries(c, &token, &customer, &spec.audience.countries).await?;
    let group = format!("customers/{customer}/adGroups/-1");
    let mut operations = vec![json!({"adGroupOperation": {"create": {
        "resourceName": group,
        "name": spec.name,
        "campaign": campaign,
        "status": "PAUSED",
        "type": "SEARCH_STANDARD",
    }}})];
    // Who sees the ads: people in these countries. In the same transaction as the ad group, so
    // that no ad group of ours ever exists in a campaign shown to the whole world.
    operations.extend(targets.iter().map(|target| {
        json!({"campaignCriterionOperation": {"create": {
            "campaign": campaign,
            "location": {"geoTargetConstant": target},
        }}})
    }));
    operations.extend(spec.keywords.iter().map(|keyword| {
        json!({"adGroupCriterionOperation": {"create": {
            "adGroup": group,
            "status": "ENABLED",
            "keyword": {"text": keyword.trim(), "matchType": "PHRASE"},
        }}})
    }));
    let answer = c.mutate(&token, &customer, operations).await?;
    let made = made(&answer, "adGroupResult")?;
    owned(&made, Entity::AdGroup, &customer)
        .map_err(|_| ConnectorError::unknown("Google's answer names an unexpected ad group"))?;
    Ok(made)
}

/// What a search ad says: its address, its headlines and its descriptions, each trimmed.
#[derive(Debug, PartialEq, Eq)]
struct SearchAd {
    url: String,
    headlines: Vec<String>,
    descriptions: Vec<String>,
}

/// The search ad of `spec`; `Permanent` when the creative is not one (the core hands a search
/// ad its headlines and descriptions and nothing of an image ad).
fn search_ad(spec: &CreativeSpec) -> Result<SearchAd, ConnectorError> {
    let CreativeAction::Link { url } = &spec.action else {
        return Err(ConnectorError::permanent(
            "a Google search ad leads to a website",
        ));
    };
    let trimmed = |texts: &[String]| -> Vec<String> {
        texts
            .iter()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
            .collect()
    };
    let (headlines, descriptions) = (trimmed(&spec.headlines), trimmed(&spec.descriptions));
    if !(3..=15).contains(&headlines.len()) || !(2..=4).contains(&descriptions.len()) {
        return Err(ConnectorError::permanent(
            "a Google search ad carries 3 to 15 headlines and 2 to 4 descriptions",
        ));
    }
    if spec.image.is_some() || spec.identity_id.is_some() {
        return Err(ConnectorError::permanent(
            "a Google search ad has no image and no page",
        ));
    }
    Ok(SearchAd {
        url: url.to_string(),
        headlines,
        descriptions,
    })
}

/// The creative step: a search ad has no creative object, so nothing is sent; the creative is
/// checked, and the ad step builds the ad from it.
pub(crate) fn create_creative(
    public: &Value,
    spec: &CreativeSpec,
) -> Result<String, ConnectorError> {
    account_of(public)?;
    search_ad(spec)?;
    Ok(INLINE.to_owned())
}

/// The texts of a list of text assets, as Google answers them.
fn asset_texts(assets: &Value) -> Vec<String> {
    assets
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|asset| asset["text"].as_str())
        .map(|text| text.trim().to_owned())
        .collect()
}

pub(crate) async fn create_ad(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSpec,
) -> Result<String, ConnectorError> {
    let customer = account_of(public)?;
    let group = owned(&spec.adset_id, Entity::AdGroup, &customer)?;
    let ad = search_ad(&spec.creative)?;
    let token = c.access_token(cred).await?;
    // An ad has no name at Google. Before one is made, the ad group is looked through for an ad
    // that already says exactly this: after a lost answer it is adopted, not made again.
    let rows = c
        .search(
            &token,
            &customer,
            &format!(
                "SELECT ad_group_ad.resource_name, ad_group_ad.ad.final_urls, \
                 ad_group_ad.ad.responsive_search_ad.headlines, \
                 ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE \
                 ad_group.resource_name = '{group}' AND ad_group_ad.status != 'REMOVED'"
            ),
        )
        .await?;
    for row in &rows {
        let existing = &row["adGroupAd"];
        let same = SearchAd {
            url: existing["ad"]["finalUrls"][0]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            headlines: asset_texts(&existing["ad"]["responsiveSearchAd"]["headlines"]),
            descriptions: asset_texts(&existing["ad"]["responsiveSearchAd"]["descriptions"]),
        } == ad;
        if same && let Some(name) = text(&existing["resourceName"]) {
            owned(&name, Entity::Ad, &customer)?;
            return Ok(name);
        }
    }
    let texts = |list: &[String]| -> Vec<Value> {
        list.iter().map(|text| json!({ "text": text })).collect()
    };
    let answer = c
        .mutate(
            &token,
            &customer,
            vec![json!({"adGroupAdOperation": {"create": {
                "adGroup": group,
                "status": "PAUSED",
                "ad": {
                    "finalUrls": [ad.url],
                    "responsiveSearchAd": {
                        "headlines": texts(&ad.headlines),
                        "descriptions": texts(&ad.descriptions),
                    },
                },
            }}})],
        )
        .await?;
    let made = made(&answer, "adGroupAdResult")?;
    owned(&made, Entity::Ad, &customer)
        .map_err(|_| ConnectorError::unknown("Google's answer names an unexpected ad"))?;
    Ok(made)
}

/// Switches the campaign, the ad group or the ad `entity_id` names on or off.
pub(crate) async fn set_status(
    c: &GoogleConnector,
    cred: &Credential,
    entity_id: &str,
    status: AdStatus,
) -> Result<(), ConnectorError> {
    let (customer, entity) = resource(entity_id).ok_or_else(|| {
        ConnectorError::permanent("not a Google Ads resource name of the expected kind")
    })?;
    let operation = match entity {
        Entity::Campaign => "campaignOperation",
        Entity::AdGroup => "adGroupOperation",
        Entity::Ad => "adGroupAdOperation",
    };
    let status = match status {
        AdStatus::Active => "ENABLED",
        AdStatus::Paused => "PAUSED",
    };
    let token = c.access_token(cred).await?;
    c.mutate(
        &token,
        customer,
        vec![json!({operation: {
            "update": {"resourceName": entity_id, "status": status},
            "updateMask": "status",
        }})],
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn resource_names_are_ours_or_nothing() {
        assert_eq!(
            resource("customers/123/campaigns/45"),
            Some(("123", Entity::Campaign))
        );
        assert_eq!(
            resource("customers/123/adGroups/45"),
            Some(("123", Entity::AdGroup))
        );
        assert_eq!(
            resource("customers/123/adGroupAds/45~678"),
            Some(("123", Entity::Ad))
        );
        for bad in [
            "",
            "customers/123/campaigns/-1",
            "customers/123/campaigns/45/x",
            "customers/12a/campaigns/45",
            "customers/123/adGroupAds/45",
            "customers/123/adGroupAds/45~",
            "customers/123/campaignBudgets/45",
            "customers/123/campaigns/45' OR campaign.id > 0",
            "customers/1234567890123/campaigns/1",
        ] {
            assert_eq!(resource(bad), None, "{bad}");
        }
        assert!(owned("customers/123/campaigns/45", Entity::Campaign, "123").is_ok());
        assert_eq!(
            owned("customers/999/campaigns/45", Entity::Campaign, "123")
                .unwrap_err()
                .reason(),
            Some("the object is of another Google Ads account")
        );
        assert!(owned("customers/123/adGroups/45", Entity::Campaign, "123").is_err());
    }

    #[test]
    fn money_goes_to_micros_and_back_by_the_currencys_minor_unit() {
        // 500,00 TRY is 50 000 kuruş and 500 000 000 micros.
        assert_eq!(micros(50_000, 2).unwrap(), 500_000_000);
        // A currency without a minor unit, and one with three decimals.
        assert_eq!(micros(1_500, 0).unwrap(), 1_500_000_000);
        assert_eq!(micros(1_500, 3).unwrap(), 1_500_000);
        assert!(micros(0, 2).is_err());
        assert!(micros(i64::MAX, 2).is_err());
        assert!(micros(1, 7).is_err());
        // A cost is rounded to the nearest minor unit.
        assert_eq!(minor(123_456, 2).unwrap(), 12);
        assert_eq!(minor(125_000, 2).unwrap(), 13);
        assert_eq!(minor(0, 2).unwrap(), 0);
        assert_eq!(minor(2_000_000, 0).unwrap(), 2);
    }

    #[test]
    fn a_time_is_a_day_in_the_accounts_own_zone() {
        // 22:30 UTC is already the next day in Istanbul (UTC+3) and still the day before in
        // Los Angeles.
        let at = datetime!(2026-11-11 22:30 UTC);
        assert_eq!(local_day("Europe/Istanbul", at).unwrap(), "2026-11-12");
        assert_eq!(local_day("America/Los_Angeles", at).unwrap(), "2026-11-11");
        assert_eq!(local_day("UTC", at).unwrap(), "2026-11-11");
        assert!(local_day("Mars/Olympus", at).is_err());
    }

    #[test]
    fn only_our_own_names_are_searched_for() {
        assert!(plain_name("jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:campaign").is_ok());
        for bad in ["", "a b", "x' OR 1=1", "a\"b", &"n".repeat(201)] {
            assert!(plain_name(bad).is_err(), "{bad}");
        }
    }
}
