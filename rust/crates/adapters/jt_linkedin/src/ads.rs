//! Ad campaigns in a LinkedIn ad account (design 2026-11-11 §3.2): the campaign group that
//! holds the total budget, the campaign that says who sees the ads and when, single-image
//! sponsored content created with its post in one call, their states, their review and their
//! daily numbers. An ad speaks as the company page its ad account advertises for. The crate docs
//! hold the calls and the choices made.

use std::time::Instant;

use jt_app::ports::connectors::{
    AdAccountLimits, AdDay, AdLevel, AdObjective, AdSetGoal, AdSetSpec, AdSpec, AdStatus, Asset,
    CallToAction, CampaignProviderState, CampaignSpec, CreativeAction, CreativeSpec, ProviderAd,
    ProviderAdStatus,
};
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::{Date, Duration, Month, OffsetDateTime};

use crate::client::{Auth, Body, Endpoint, missing, pct, text};
use crate::countries;
use crate::credential::{ORGANIZATION_URN, organization_of_urn, token_of};
use crate::{LinkedinConnector, MAX_AD_ACCOUNTS, MAX_AD_PAGES};

/// The capability kind of a LinkedIn ad account.
pub(crate) const ADS_KIND: &str = "linkedin_ads";

/// What the creative step answers: the post and the creative are made together, by the ad step.
pub(crate) const INLINE: &str = "inline";

const ACCOUNT_URN: &str = "urn:li:sponsoredAccount:";
const GROUP_URN: &str = "urn:li:sponsoredCampaignGroup:";
const CAMPAIGN_URN: &str = "urn:li:sponsoredCampaign:";
const CREATIVE_URN: &str = "urn:li:sponsoredCreative:";
const IMAGE_URN: &str = "urn:li:image:";
const GEO_URN: &str = "urn:li:geo:";

/// The Rest.li method header of a partial update, and of the creatives finder (LinkedIn: "The
/// header X-RestLi-Method must be included in the request and set to `FINDER`").
const PARTIAL_UPDATE: &str = "PARTIAL_UPDATE";
const FINDER: &str = "FINDER";

/// LinkedIn's facets of a campaign's audience: where its members are, and the language of their
/// LinkedIn interface.
const LOCATIONS_FACET: &str = "urn:li:adTargetingFacet:locations";
const LOCALES_FACET: &str = "urn:li:adTargetingFacet:interfaceLocales";

/// Why an ad account that advertises for a member, not for a company page, is not used.
pub(crate) const NO_PAGE: &str = "the LinkedIn ad account advertises for no company page";

/// The statuses of a campaign group or a campaign that is still there (not removed, cancelled
/// or being deleted).
const THERE: &str = "List(ACTIVE,DRAFT,PAUSED)";

/// The roles of an ad account that may create campaigns in it.
const CAMPAIGN_ROLES: &[&str] = &[
    "CAMPAIGN_MANAGER",
    "ACCOUNT_MANAGER",
    "ACCOUNT_BILLING_ADMIN",
];

/// How far ahead of now a campaign's start is put at least: LinkedIn refuses a start in the
/// past, and the call takes a moment to arrive.
const START_MARGIN: Duration = Duration::minutes(5);

/// The locales a campaign may carry
/// (<https://learn.microsoft.com/en-us/linkedin/shared/references/reference-tables/language-codes>),
/// as `(country, language)`.
const LOCALES: &[(&str, &str)] = &[
    ("US", "en"),
    ("AE", "ar"),
    ("CN", "zh"),
    ("TW", "zh"),
    ("CZ", "cs"),
    ("DK", "da"),
    ("ID", "in"),
    ("MY", "ms"),
    ("NL", "nl"),
    ("FR", "fr"),
    ("FI", "fi"),
    ("DE", "de"),
    ("IT", "it"),
    ("JP", "ja"),
    ("KR", "ko"),
    ("NO", "no"),
    ("PL", "pl"),
    ("BR", "pt"),
    ("RO", "ro"),
    ("RU", "ru"),
    ("ES", "es"),
    ("SE", "sv"),
    ("TH", "th"),
    ("PH", "tl"),
    ("TR", "tr"),
];

/// Which object of an ad account an id names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entity {
    Group,
    Campaign,
    Creative,
}

impl Entity {
    fn word(self) -> &'static str {
        match self {
            Entity::Group => "group",
            Entity::Campaign => "campaign",
            Entity::Creative => "creative",
        }
    }

    /// The prefix of its URNs.
    fn urn(self) -> &'static str {
        match self {
            Entity::Group => GROUP_URN,
            Entity::Campaign => CAMPAIGN_URN,
            Entity::Creative => CREATIVE_URN,
        }
    }
}

/// Whether `text` is 1 to 20 ASCII digits.
fn digits(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// The id this adapter gives the object `number` of kind `entity` in account `account`:
/// `li:{account}:{group|campaign|creative}:{number}`. A LinkedIn object is reached under its ad
/// account, which its own URN does not name; the id carries both.
pub(crate) fn id_of(account: &str, entity: Entity, number: &str) -> String {
    format!("li:{account}:{}:{number}", entity.word())
}

/// The account, the kind and the number of an id of [`id_of`]'s shape; `None` for anything else,
/// so that an id can never change the request it is put in.
pub(crate) fn parse(id: &str) -> Option<(&str, Entity, &str)> {
    let mut parts = id.split(':');
    let (Some("li"), Some(account), Some(word), Some(number), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    let entity = [Entity::Group, Entity::Campaign, Entity::Creative]
        .into_iter()
        .find(|e| e.word() == word)?;
    (digits(account) && digits(number)).then_some((account, entity, number))
}

/// The number of `id` when it names an object of kind `entity` in account `account`.
fn owned<'a>(id: &'a str, entity: Entity, account: &str) -> Result<&'a str, ConnectorError> {
    match parse(id) {
        Some((owner, kind, number)) if kind == entity && owner == account => Ok(number),
        Some((_, kind, _)) if kind == entity => Err(ConnectorError::permanent(
            "the object is of another LinkedIn ad account",
        )),
        _ => Err(ConnectorError::permanent(
            "not a LinkedIn ad object of the expected kind",
        )),
    }
}

/// The ad account of the capability whose public fields are `public`: its number, 1 to 20
/// digits; `Permanent` for another kind or a malformed id.
pub(crate) fn account_of(public: &Value) -> Result<String, ConnectorError> {
    match public["kind_key"].as_str() {
        Some(ADS_KIND) => {}
        Some(_) => return Err(ConnectorError::permanent("not a LinkedIn ad account")),
        None => return Err(ConnectorError::permanent(crate::credential::KIND_MISSING)),
    }
    public["external_id"]
        .as_str()
        .map(str::trim)
        .map(|id| id.strip_prefix(ACCOUNT_URN).unwrap_or(id))
        .filter(|id| digits(id))
        .map(str::to_owned)
        .ok_or_else(|| ConnectorError::permanent("the LinkedIn ad account id is missing"))
}

/// `minor` minor units of a currency whose minor unit is 10^-`exponent` of it, as the decimal
/// text LinkedIn takes for an amount (`50000`, 2 → `500.00`).
pub(crate) fn decimal(minor: i64, exponent: u8) -> Result<String, ConnectorError> {
    if minor <= 0 || exponent > 6 {
        return Err(ConnectorError::permanent(
            "the campaign budget is not an amount",
        ));
    }
    let unit = 10i64.pow(u32::from(exponent));
    Ok(match exponent {
        0 => minor.to_string(),
        digits => format!(
            "{}.{:0width$}",
            minor / unit,
            minor % unit,
            width = usize::from(digits)
        ),
    })
}

/// A decimal amount LinkedIn reports (`12.3456`) as minor units, rounded to the nearest; `None`
/// when it is not a plain non-negative decimal.
pub(crate) fn minor_of(amount: &str, exponent: u8) -> Option<i64> {
    let amount = amount.trim();
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
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

/// The number LinkedIn gave what it just created: the `x-restli-id` header, as it is or as the
/// URN with `prefix`. `Unknown` without a valid one (the object may well exist).
fn created(answer: &crate::client::Answer, prefix: &str) -> Result<String, ConnectorError> {
    answer
        .header("x-restli-id")
        .map(|id| id.strip_prefix(prefix).unwrap_or(id))
        .filter(|id| digits(id))
        .map(str::to_owned)
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid id"))
}

/// What LinkedIn says of an ad account.
struct Account {
    name: Option<String>,
    currency: String,
    status: String,
    /// The organization the account advertises for, when it is one.
    organization: Option<String>,
    test: bool,
}

impl Account {
    /// The company page the account's ads speak as: the organization it advertises for.
    fn page(&self) -> Result<&str, ConnectorError> {
        self.organization
            .as_deref()
            .ok_or_else(|| ConnectorError::permanent(NO_PAGE))
    }
}

impl LinkedinConnector {
    /// The ad account `account`, as this token reads it.
    async fn ad_account(&self, token: &str, account: &str) -> Result<Account, ConnectorError> {
        let answer = self
            .call(
                Method::GET,
                self.rest_url(&["adAccounts", account], None),
                Auth::Bearer(token),
                &Body::Empty,
                Endpoint::Rest,
            )
            .await?;
        let row = answer.json()?;
        // The account the token reads is the one that was asked for, never another.
        if text(&row["id"]).as_deref() != Some(account) {
            return Err(ConnectorError::permanent(
                "LinkedIn answered for another ad account",
            ));
        }
        Ok(Account {
            name: text(&row["name"]),
            currency: text(&row["currency"]).ok_or_else(|| missing("currency"))?,
            status: text(&row["status"]).unwrap_or_default(),
            organization: row["reference"]
                .as_str()
                .and_then(organization_of_urn)
                .map(str::to_owned),
            test: row["test"].as_bool().unwrap_or(false),
        })
    }

    /// Every element of a search under `segments` with the Rest.li `query`, page by page (at
    /// most [`MAX_AD_PAGES`] pages; an answer that still has more is refused, not cut short).
    /// `restli_method` names the call's Rest.li method where LinkedIn asks for it.
    async fn elements(
        &self,
        token: &str,
        segments: &[&str],
        query: &str,
        restli_method: Option<&'static str>,
    ) -> Result<Vec<Value>, ConnectorError> {
        let mut rows = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..MAX_AD_PAGES {
            let query = match &page {
                Some(next) => format!("{query}&pageToken={}", pct(next)),
                None => query.to_owned(),
            };
            let answer = self
                .call_as(
                    Method::GET,
                    self.rest_url(segments, Some(&query)),
                    Auth::Bearer(token),
                    &Body::Empty,
                    Endpoint::Rest,
                    restli_method,
                )
                .await?;
            let json = answer.json()?;
            match &json["elements"] {
                Value::Array(elements) => rows.extend(elements.iter().cloned()),
                Value::Null => {}
                _ => return Err(missing("elements")),
            }
            match text(&json["metadata"]["nextPageToken"]) {
                Some(next) => page = Some(next),
                None => return Ok(rows),
            }
        }
        Err(ConnectorError::permanent(
            "LinkedIn's answer has more pages than are read",
        ))
    }

    /// Sets `fields` on the object at `segments` (a partial update).
    async fn patch(
        &self,
        token: &str,
        segments: &[&str],
        fields: Value,
    ) -> Result<(), ConnectorError> {
        self.call_as(
            Method::POST,
            self.rest_url(segments, None),
            Auth::Bearer(token),
            &Body::Json(json!({ "patch": { "$set": fields } })),
            Endpoint::Rest,
            Some(PARTIAL_UPDATE),
        )
        .await
        .map(|_| ())
    }
}

/// The ad accounts the signed-in member may build campaigns in: those where their role is
/// campaign manager or above, that are active and advertise for a company page, with their
/// currency. An account whose facts cannot be read is left out.
pub(crate) async fn list_assets(
    connector: &LinkedinConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list ad accounts")?;
    // The finder answers a page and says how many there are in all (`paging.total`): the rest
    // is asked for by index, as LinkedIn's index-based finders are paged.
    let mut users: Vec<Value> = Vec::new();
    for _ in 0..MAX_AD_PAGES {
        let query = match users.len() {
            0 => "q=authenticatedUser".to_owned(),
            seen => format!("q=authenticatedUser&start={seen}"),
        };
        let answer = connector
            .call(
                Method::GET,
                connector.rest_url(&["adAccountUsers"], Some(&query)),
                Auth::Bearer(token),
                &Body::Empty,
                Endpoint::Rest,
            )
            .await?;
        let json = answer.json()?;
        let page = match &json["elements"] {
            Value::Array(page) => page.clone(),
            Value::Null => Vec::new(),
            _ => return Err(missing("elements")),
        };
        let total = json["paging"]["total"].as_u64().unwrap_or(0);
        let last = page.is_empty();
        users.extend(page);
        if last || users.len() as u64 >= total {
            break;
        }
    }
    let ids: Vec<String> = users
        .iter()
        .filter(|row| {
            row["role"]
                .as_str()
                .is_some_and(|role| CAMPAIGN_ROLES.contains(&role))
        })
        .filter_map(|row| row["account"].as_str()?.strip_prefix(ACCOUNT_URN))
        .filter(|id| digits(id))
        .map(str::to_owned)
        .take(MAX_AD_ACCOUNTS)
        .collect();
    let mut assets = Vec::new();
    for id in ids {
        let account = match connector.ad_account(token, &id).await {
            Ok(account) => account,
            Err(ConnectorError::Permission { .. } | ConnectorError::Permanent { .. }) => continue,
            Err(e) => return Err(e),
        };
        if account.status != "ACTIVE" || account.organization.is_none() {
            continue;
        }
        assets.push(Asset {
            kind_key: ADS_KIND.to_owned(),
            name: account.name.clone().unwrap_or_else(|| id.clone()),
            external_id: id,
            credential: cred.clone(),
            public: json!({
                "currency": account.currency,
                "organization_id": account.organization,
                "test_account": account.test,
            }),
        });
    }
    Ok(assets)
}

/// The probe of an ad account capability (never fails: a failure is a failed probe).
pub(crate) async fn probe(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = async {
        let wanted = account_of(public)?;
        let token = token_of(cred, "be probed")?;
        let account = connector.ad_account(token, &wanted).await?;
        if account.status != "ACTIVE" {
            return Err(ConnectorError::permission(
                "the LinkedIn ad account is not active",
            ));
        }
        account.page()?;
        Ok(json!({
            "account_id": wanted,
            "name": account.name,
            "currency": account.currency,
            "organization_id": account.organization,
            "test_account": account.test,
        }))
    }
    .await;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

pub(crate) async fn account_limits(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountLimits, ConnectorError> {
    let account = account_of(public)?;
    let token = token_of(cred, "read an ad account")?;
    let facts = c.ad_account(token, &account).await?;
    facts.page()?;
    Ok(AdAccountLimits {
        minor_unit_exponent: exponent(&facts.currency)?,
        currency: facts.currency,
        // LinkedIn counts an ad account's days in UTC.
        timezone: "UTC".into(),
        // LinkedIn names its least budget, which follows the length of the run, when it
        // refuses one ("will be displayed if the set budget is too low"), not ahead of it.
        min_daily_budget_minor: 0,
        min_total_budget_minor: 0,
    })
}

/// The minor unit exponent of `currency`; `Permanent` for one the system does not count in.
fn exponent(currency: &str) -> Result<u8, ConnectorError> {
    jt_connector::currency_minor_exponent(currency)
        .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))
}

/// The one object named exactly `name` among `rows`, as its id; `None` when there is none.
fn named(
    rows: &[Value],
    name: &str,
    account: &str,
    entity: Entity,
) -> Result<Option<String>, ConnectorError> {
    let mut found = rows
        .iter()
        .filter(|row| row["name"].as_str() == Some(name))
        .filter_map(|row| text(&row["id"]))
        .map(|id| id.strip_prefix(entity.urn()).unwrap_or(&id).to_owned())
        .filter(|id| digits(id));
    match (found.next(), found.next()) {
        (None, _) => Ok(None),
        (Some(id), None) => Ok(Some(id_of(account, entity, &id))),
        _ => Err(ConnectorError::permanent(
            "more than one object of the account carries this name",
        )),
    }
}

pub(crate) async fn find_by_name(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    level: AdLevel,
    name: &str,
) -> Result<Option<String>, ConnectorError> {
    let account = account_of(public)?;
    let (collection, entity) = match level {
        AdLevel::Campaign => ("adCampaignGroups", Entity::Group),
        AdLevel::AdSet => ("adCampaigns", Entity::Campaign),
        // The post and the creative are made in one call by the ad step, which looks the
        // creative up by its name in its own campaign.
        AdLevel::Creative | AdLevel::Ad => return Ok(None),
    };
    let token = token_of(cred, "search an ad account")?;
    let query = format!(
        "q=search&search=(name:(values:List({})),status:(values:{THERE}))",
        pct(name)
    );
    let rows = c
        .elements(token, &["adAccounts", &account, collection], &query, None)
        .await?;
    named(&rows, name, &account, entity)
}

/// `at` in milliseconds since the epoch, as LinkedIn takes a time.
fn millis(at: OffsetDateTime) -> i64 {
    at.unix_timestamp().saturating_mul(1000)
}

/// The start and the end of a run as LinkedIn takes them: the start at least [`START_MARGIN`]
/// from now.
fn schedule(start: OffsetDateTime, end: OffsetDateTime) -> Result<Value, ConnectorError> {
    let start = start.max(OffsetDateTime::now_utc() + START_MARGIN);
    if end <= start {
        return Err(ConnectorError::permanent(
            "the campaign ends before it starts",
        ));
    }
    Ok(json!({"start": millis(start), "end": millis(end)}))
}

/// The campaign group: the campaign's whole budget and its run. LinkedIn creates a group active
/// or as a draft; it is created active, and nothing under it is served while its one campaign
/// is paused and its creatives are drafts.
pub(crate) async fn create_campaign(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    spec: &CampaignSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    if spec.objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a LinkedIn campaign here brings visits to a website only",
        ));
    }
    let token = token_of(cred, "create a campaign group")?;
    let facts = c.ad_account(token, &account).await?;
    let answer = c
        .call(
            Method::POST,
            c.rest_url(&["adAccounts", &account, "adCampaignGroups"], None),
            Auth::Bearer(token),
            &Body::Json(json!({
                "account": format!("{ACCOUNT_URN}{account}"),
                "name": spec.name,
                "runSchedule": schedule(spec.start_at, spec.end_at)?,
                "status": "ACTIVE",
                "totalBudget": {
                    "amount": decimal(spec.lifetime_budget_minor, exponent(&facts.currency)?)?,
                    "currencyCode": facts.currency,
                },
            })),
            Endpoint::Rest,
        )
        .await?;
    Ok(id_of(
        &account,
        Entity::Group,
        &created(&answer, GROUP_URN)?,
    ))
}

/// LinkedIn's location entity of the country `code`: the one typeahead answer whose name is the
/// country's own (a sub-country entity carries its parent after a comma). None, or several, is
/// a refusal: a campaign is never aimed at a guessed place.
async fn country(c: &LinkedinConnector, token: &str, code: &str) -> Result<String, ConnectorError> {
    let name = countries::name_of(code).ok_or_else(|| {
        ConnectorError::permanent(format!("LinkedIn lists no country with the code {code}"))
    })?;
    let query = format!(
        "q=typeahead&queryVersion=QUERY_USES_URNS&facet={}&query={}&locale=(language:en,country:US)",
        pct("urn:li:adTargetingFacet:locations"),
        pct(name)
    );
    let answer = c
        .call(
            Method::GET,
            c.rest_url(&["adTargetingEntities"], Some(&query)),
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await?;
    let json = answer.json()?;
    let mut found = json["elements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["name"].as_str().map(str::trim) == Some(name))
        .filter_map(|row| row["urn"].as_str())
        .filter(|urn| urn.strip_prefix(GEO_URN).is_some_and(digits));
    match (found.next(), found.next()) {
        (Some(urn), None) => Ok(urn.to_owned()),
        _ => Err(ConnectorError::permanent(format!(
            "LinkedIn names no single location for the country {code}"
        ))),
    }
}

/// The campaign: who sees the ads (the countries), when, with the whole budget once more as its
/// own lifetime budget ("you spend no more than the full budget for the lifetime of the
/// campaign"), paused.
pub(crate) async fn create_adset(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSetSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let group = owned(&spec.campaign_id, Entity::Group, &account)?;
    if spec.goal != AdSetGoal::LinkClicks {
        return Err(ConnectorError::permanent(
            "a LinkedIn campaign here brings visits to a website only",
        ));
    }
    let codes = &spec.audience.countries;
    if codes.is_empty() {
        return Err(ConnectorError::permanent(
            "a LinkedIn campaign needs its countries",
        ));
    }
    let token = token_of(cred, "create a campaign")?;
    let facts = c.ad_account(token, &account).await?;
    let organization = facts.page()?.to_owned();
    let mut places = Vec::new();
    for code in codes {
        places.push(country(c, token, code).await?);
    }
    // The campaign's own language: the first country's, where LinkedIn lists one. LinkedIn's
    // website-visit campaigns name it in the audience too (the interface language of the members
    // who see the ads), as Campaign Manager's "profile language" does.
    let (locale_country, language) = LOCALES
        .iter()
        .find(|(listed, _)| *listed == codes[0].as_str())
        .copied()
        .unwrap_or(LOCALES[0]);
    let answer = c
        .call(
            Method::POST,
            c.rest_url(&["adAccounts", &account, "adCampaigns"], None),
            Auth::Bearer(token),
            &Body::Json(json!({
                "account": format!("{ACCOUNT_URN}{account}"),
                "campaignGroup": format!("{GROUP_URN}{group}"),
                "name": spec.name,
                "type": "SPONSORED_UPDATES",
                "format": "STANDARD_UPDATE",
                "objectiveType": "WEBSITE_VISIT",
                // LinkedIn bids by itself for the most clicks to the address.
                "optimizationTargetType": "MAX_CLICK",
                "costType": "CPM",
                "unitCost": {"amount": "0", "currencyCode": facts.currency},
                "locale": {"country": locale_country, "language": language},
                // The feed only: what was planned and checked is what runs.
                "offsiteDeliveryEnabled": false,
                "audienceExpansionEnabled": false,
                "creativeSelection": "OPTIMIZED",
                "associatedEntity": format!("{ORGANIZATION_URN}{organization}"),
                "politicalIntent": "NOT_POLITICAL",
                "pacingStrategy": "LIFETIME",
                "totalBudget": {
                    "amount": decimal(spec.budget_minor, exponent(&facts.currency)?)?,
                    "currencyCode": facts.currency,
                },
                "runSchedule": schedule(spec.start_at, spec.end_at)?,
                "targetingCriteria": {"include": {"and": [
                    {"or": {LOCALES_FACET: [
                        format!("urn:li:locale:{language}_{locale_country}")
                    ]}},
                    {"or": {LOCATIONS_FACET: places}}
                ]}},
                "status": "PAUSED",
            })),
            Endpoint::Rest,
        )
        .await?;
    Ok(id_of(
        &account,
        Entity::Campaign,
        &created(&answer, CAMPAIGN_URN)?,
    ))
}

/// The ad's image, uploaded as the company page the account advertises for.
pub(crate) async fn upload_image(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    bytes: &[u8],
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let mime = image_mime(bytes)
        .ok_or_else(|| ConnectorError::permanent("a LinkedIn ad image is a JPG, a PNG or a GIF"))?;
    let token = token_of(cred, "upload an ad image")?;
    let facts = c.ad_account(token, &account).await?;
    crate::publish::upload_image_bytes(
        c,
        token,
        &format!("{ORGANIZATION_URN}{}", facts.page()?),
        bytes,
        mime,
    )
    .await
}

/// The media type of an image by its first bytes: JPG, PNG or GIF (what LinkedIn takes).
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        _ => None,
    }
}

/// LinkedIn's label of a call to action; `None` for one LinkedIn has no button for.
fn label(action: CallToAction) -> Option<&'static str> {
    match action {
        CallToAction::LearnMore => Some("LEARN_MORE"),
        CallToAction::SignUp => Some("SIGN_UP"),
        CallToAction::ShopNow => Some("SHOP_NOW"),
        CallToAction::GetQuote => Some("VIEW_QUOTE"),
        CallToAction::Subscribe => Some("SUBSCRIBE"),
        CallToAction::ApplyNow => Some("APPLY"),
        CallToAction::Download => Some("DOWNLOAD"),
        CallToAction::ContactUs | CallToAction::BookNow => None,
    }
}

/// The post of a single-image ad: the company page `organization`'s, shown to nobody but
/// through the ad (`feedDistribution: NONE`), with its image, its headline, its address and its
/// button.
fn post(account: &str, organization: &str, spec: &CreativeSpec) -> Result<Value, ConnectorError> {
    let image = spec
        .image
        .as_deref()
        .filter(|urn| urn.starts_with(IMAGE_URN))
        .ok_or_else(|| ConnectorError::permanent("a LinkedIn ad needs its image"))?;
    let CreativeAction::Link { url } = &spec.action else {
        return Err(ConnectorError::permanent(
            "a LinkedIn ad here leads to a website",
        ));
    };
    let action = spec.call_to_action.and_then(label).ok_or_else(|| {
        ConnectorError::permanent("LinkedIn has no button for this call to action")
    })?;
    if spec.primary_text.trim().is_empty() || spec.headline.trim().is_empty() {
        return Err(ConnectorError::permanent(
            "a LinkedIn ad needs its text and its headline",
        ));
    }
    Ok(json!({
        "adContext": {
            "dscAdAccount": format!("{ACCOUNT_URN}{account}"),
            "dscStatus": "ACTIVE",
        },
        "author": format!("{ORGANIZATION_URN}{organization}"),
        "commentary": crate::publish::little_text(spec.primary_text.trim()),
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "NONE", "thirdPartyDistributionChannels": []},
        "content": {"media": {"title": spec.headline.trim(), "id": image}},
        "contentLandingPage": url.as_str(),
        "contentCallToActionLabel": action,
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": true,
    }))
}

/// The creative step: nothing is sent; the creative is checked, and the ad step makes the post
/// and the creative together.
pub(crate) fn create_creative(
    public: &Value,
    spec: &CreativeSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    // Whose post it will be is the ad step's to read; here only the ad's own parts are held.
    post(&account, "0", spec)?;
    Ok(INLINE.to_owned())
}

/// The creatives of campaign `campaign` (its number) in account `account`.
async fn creatives(
    c: &LinkedinConnector,
    token: &str,
    account: &str,
    campaign: &str,
) -> Result<Vec<Value>, ConnectorError> {
    let query = format!(
        "q=criteria&campaigns=List({})&sortOrder=ASCENDING",
        pct(&format!("{CAMPAIGN_URN}{campaign}"))
    );
    c.elements(
        token,
        &["adAccounts", account, "creatives"],
        &query,
        Some(FINDER),
    )
    .await
}

/// The ad: its post and its creative in one call, as a draft (LinkedIn's review starts when a
/// creative is activated). A creative of the campaign that already carries the ad's name is
/// adopted: after a lost answer no second one is made.
pub(crate) async fn create_ad(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let campaign = owned(&spec.adset_id, Entity::Campaign, &account)?;
    post(&account, "0", &spec.creative)?;
    let token = token_of(cred, "create an ad")?;
    let existing = creatives(c, token, &account, campaign).await?;
    if let Some(found) = named(&existing, &spec.name, &account, Entity::Creative)? {
        return Ok(found);
    }
    let facts = c.ad_account(token, &account).await?;
    let post = post(&account, facts.page()?, &spec.creative)?;
    let answer = c
        .call(
            Method::POST,
            c.rest_url(
                &["adAccounts", &account, "creatives"],
                Some("action=createInline"),
            ),
            Auth::Bearer(token),
            &Body::Json(json!({"creative": {
                "inlineContent": {"post": post},
                "campaign": format!("{CAMPAIGN_URN}{campaign}"),
                "intendedStatus": "DRAFT",
                "name": spec.name,
            }})),
            Endpoint::Rest,
        )
        .await?;
    Ok(id_of(
        &account,
        Entity::Creative,
        &created(&answer, CREATIVE_URN)?,
    ))
}

/// Switches the campaign group, the campaign or the creative `entity_id` names on or off.
pub(crate) async fn set_status(
    c: &LinkedinConnector,
    cred: &Credential,
    entity_id: &str,
    status: AdStatus,
) -> Result<(), ConnectorError> {
    let (account, entity, number) = parse(entity_id).ok_or_else(|| {
        ConnectorError::permanent("not a LinkedIn ad object of the expected kind")
    })?;
    let word = match status {
        AdStatus::Active => "ACTIVE",
        AdStatus::Paused => "PAUSED",
    };
    let token = token_of(cred, "change an ad's status")?;
    match entity {
        Entity::Group => {
            c.patch(
                token,
                &["adAccounts", account, "adCampaignGroups", number],
                json!({ "status": word }),
            )
            .await
        }
        Entity::Campaign => {
            c.patch(
                token,
                &["adAccounts", account, "adCampaigns", number],
                json!({ "status": word }),
            )
            .await
        }
        Entity::Creative => {
            let urn = pct(&format!("{CREATIVE_URN}{number}"));
            c.patch(
                token,
                &["adAccounts", account, "creatives", &urn],
                json!({ "intendedStatus": word }),
            )
            .await
        }
    }
}

/// The campaigns of campaign group `group` (its number) in account `account`, as their numbers.
async fn campaigns_of(
    c: &LinkedinConnector,
    token: &str,
    account: &str,
    group: &str,
) -> Result<Vec<String>, ConnectorError> {
    let query = format!(
        "q=search&search=(campaignGroup:(values:List({})),status:(values:{THERE}))",
        pct(&format!("{GROUP_URN}{group}"))
    );
    let rows = c
        .elements(token, &["adAccounts", account, "adCampaigns"], &query, None)
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| text(&row["id"]))
        .filter(|id| digits(id))
        .collect())
}

/// How a creative stands: what LinkedIn's review said first (a rejected creative is that
/// whatever its switch says), then its own status; a creative whose review is not over is in
/// review.
fn creative_status(row: &Value) -> ProviderAdStatus {
    let review = row["review"]["status"].as_str().unwrap_or_default();
    match row["intendedStatus"].as_str().unwrap_or_default() {
        _ if review == "REJECTED" => ProviderAdStatus::Disapproved,
        "PAUSED" | "DRAFT" => ProviderAdStatus::Paused,
        // LinkedIn spells it both ways across its pages.
        "ARCHIVED" | "CANCELED" | "CANCELLED" | "PENDING_DELETION" | "REMOVED" => {
            ProviderAdStatus::Archived
        }
        "ACTIVE" if review == "APPROVED" => ProviderAdStatus::Active,
        "ACTIVE" => ProviderAdStatus::InReview,
        other => ProviderAdStatus::Other(other.to_owned()),
    }
}

/// What LinkedIn's review says of a creative, for a person to act on: its rejection reasons.
fn feedback(row: &Value) -> Option<String> {
    // LinkedIn types the reasons only as an array: a reason is taken as its text, or, should it
    // be an object, as what the object names itself.
    let reasons: Vec<String> = row["review"]["rejectionReasons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|reason| match reason {
            Value::Object(fields) => ["rejectionReason", "reason", "name", "code"]
                .iter()
                .find_map(|key| text(&fields[*key])),
            other => text(other),
        })
        .collect();
    (!reasons.is_empty()).then(|| reasons.join(", "))
}

pub(crate) async fn campaign_state(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
) -> Result<CampaignProviderState, ConnectorError> {
    let account = account_of(public)?;
    let group = owned(campaign_id, Entity::Group, &account)?;
    let token = token_of(cred, "read a campaign")?;
    let answer = c
        .call(
            Method::GET,
            c.rest_url(&["adAccounts", &account, "adCampaignGroups", group], None),
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await?;
    let campaign = match answer.json()?["status"].as_str().unwrap_or_default() {
        "ACTIVE" => ProviderAdStatus::Active,
        "PAUSED" | "DRAFT" => ProviderAdStatus::Paused,
        "ARCHIVED" | "CANCELED" | "CANCELLED" | "PENDING_DELETION" | "REMOVED" => {
            ProviderAdStatus::Archived
        }
        other => ProviderAdStatus::Other(other.to_owned()),
    };
    let mut ads = Vec::new();
    for number in campaigns_of(c, token, &account, group).await? {
        for row in creatives(c, token, &account, &number).await? {
            let Some(creative) = text(&row["id"])
                .map(|id| id.strip_prefix(CREATIVE_URN).unwrap_or(&id).to_owned())
                .filter(|id| digits(id))
            else {
                return Err(missing("creative id"));
            };
            ads.push(ProviderAd {
                ad_id: id_of(&account, Entity::Creative, &creative),
                name: text(&row["name"]).unwrap_or_default(),
                status: creative_status(&row),
                feedback: feedback(&row),
            });
        }
    }
    Ok(CampaignProviderState { campaign, ads })
}

/// A day as LinkedIn takes it in a date range.
fn day(date: Date) -> String {
    format!(
        "(year:{},month:{},day:{})",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// A whole number LinkedIn gives for a day; `None` when the row carries none.
fn count(row: &Value, name: &str) -> Result<Option<i64>, ConnectorError> {
    match &row[name] {
        Value::Null => Ok(None),
        value => {
            value.as_i64().filter(|n| *n >= 0).map(Some).ok_or_else(|| {
                ConnectorError::permanent(format!("LinkedIn's {name} is not a count"))
            })
        }
    }
}

pub(crate) async fn ad_days(
    c: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
    objective: AdObjective,
    since: Date,
    until: Date,
) -> Result<Vec<AdDay>, ConnectorError> {
    let account = account_of(public)?;
    let group = owned(campaign_id, Entity::Group, &account)?;
    if objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a LinkedIn campaign here brings visits to a website only",
        ));
    }
    let token = token_of(cred, "read a campaign's numbers")?;
    let facts = c.ad_account(token, &account).await?;
    let exponent = exponent(&facts.currency)?;
    let campaigns = campaigns_of(c, token, &account, group).await?;
    if campaigns.is_empty() {
        return Ok(Vec::new());
    }
    let list = campaigns
        .iter()
        .map(|number| pct(&format!("{CAMPAIGN_URN}{number}")))
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "q=analytics&pivot=CREATIVE&timeGranularity=DAILY&dateRange=(start:{},end:{})&campaigns=List({list})&fields=dateRange,pivotValues,impressions,clicks,landingPageClicks,costInLocalCurrency",
        day(since),
        day(until)
    );
    let answer = c
        .call(
            Method::GET,
            c.rest_url(&["adAnalytics"], Some(&query)),
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await?;
    let json = answer.json()?;
    let rows = match &json["elements"] {
        Value::Array(rows) => rows.clone(),
        Value::Null => Vec::new(),
        _ => return Err(missing("elements")),
    };
    rows.iter()
        .map(|row| {
            let creative = row["pivotValues"][0]
                .as_str()
                .and_then(|urn| urn.strip_prefix(CREATIVE_URN))
                .filter(|id| digits(id))
                .ok_or_else(|| missing("creative"))?;
            let start = &row["dateRange"]["start"];
            let day = (|| {
                let month = Month::try_from(u8::try_from(start["month"].as_u64()?).ok()?).ok()?;
                Date::from_calendar_date(
                    i32::try_from(start["year"].as_i64()?).ok()?,
                    month,
                    u8::try_from(start["day"].as_u64()?).ok()?,
                )
                .ok()
            })()
            .ok_or_else(|| missing("day"))?;
            let spend_minor = match &row["costInLocalCurrency"] {
                Value::Null => None,
                value => Some(
                    text(value)
                        .or_else(|| value.as_f64().map(|n| n.to_string()))
                        .and_then(|amount| minor_of(&amount, exponent))
                        .ok_or_else(|| {
                            ConnectorError::permanent("LinkedIn's cost is not an amount")
                        })?,
                ),
            };
            let visits = count(row, "landingPageClicks")?;
            Ok(AdDay {
                ad_id: id_of(&account, Entity::Creative, creative),
                day,
                spend_minor,
                impressions: count(row, "impressions")?,
                clicks: count(row, "clicks")?,
                // What the campaign is for: a visit to the address.
                results: visits,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_their_account_and_kind_or_are_nothing() {
        assert_eq!(id_of("512", Entity::Campaign, "77"), "li:512:campaign:77");
        assert_eq!(parse("li:512:group:9"), Some(("512", Entity::Group, "9")));
        assert_eq!(
            parse("li:512:creative:120491345"),
            Some(("512", Entity::Creative, "120491345"))
        );
        for bad in [
            "",
            "512",
            "li:512:campaign",
            "li:512:campaign:7:x",
            "li:5a2:campaign:7",
            "li:512:adset:7",
            "li:512:campaign:-7",
            "urn:li:sponsoredCampaign:7",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(owned("li:512:group:9", Entity::Group, "512").unwrap(), "9");
        assert_eq!(
            owned("li:999:group:9", Entity::Group, "512")
                .unwrap_err()
                .reason(),
            Some("the object is of another LinkedIn ad account")
        );
        assert!(owned("li:512:campaign:9", Entity::Group, "512").is_err());
    }

    #[test]
    fn amounts_go_out_as_decimals_and_come_back_as_minor_units() {
        assert_eq!(decimal(50_000, 2).unwrap(), "500.00");
        assert_eq!(decimal(5, 2).unwrap(), "0.05");
        assert_eq!(decimal(1_500, 0).unwrap(), "1500");
        assert_eq!(decimal(1_500, 3).unwrap(), "1.500");
        assert!(decimal(0, 2).is_err());
        assert_eq!(minor_of("142.00", 2), Some(14_200));
        assert_eq!(minor_of("12.3456", 2), Some(1_235));
        assert_eq!(minor_of("12.344", 2), Some(1_234));
        assert_eq!(minor_of("7", 2), Some(700));
        assert_eq!(minor_of("7.5", 0), Some(8));
        assert_eq!(minor_of("-1", 2), None);
        assert_eq!(minor_of("1e3", 2), None);
        assert_eq!(minor_of("", 2), None);
    }

    #[test]
    fn a_creatives_state_is_the_review_first_then_its_switch() {
        let row = |status: &str, review: &str| json!({"intendedStatus": status, "review": {"status": review}});
        for (status, review, expected) in [
            ("ACTIVE", "APPROVED", ProviderAdStatus::Active),
            ("ACTIVE", "PENDING", ProviderAdStatus::InReview),
            ("ACTIVE", "NEEDS_REVIEW", ProviderAdStatus::InReview),
            ("ACTIVE", "REJECTED", ProviderAdStatus::Disapproved),
            ("PAUSED", "REJECTED", ProviderAdStatus::Disapproved),
            ("PAUSED", "APPROVED", ProviderAdStatus::Paused),
            ("DRAFT", "", ProviderAdStatus::Paused),
            ("ARCHIVED", "APPROVED", ProviderAdStatus::Archived),
        ] {
            assert_eq!(
                creative_status(&row(status, review)),
                expected,
                "{status} {review}"
            );
        }
        let rejected = json!({"review":{"status":"REJECTED",
            "rejectionReasons":["IMAGE_QUALITY","MISLEADING_CLAIM"]}});
        assert_eq!(
            feedback(&rejected).as_deref(),
            Some("IMAGE_QUALITY, MISLEADING_CLAIM")
        );
        assert_eq!(feedback(&json!({"review":{"status":"APPROVED"}})), None);
    }

    #[test]
    fn an_image_is_known_by_its_first_bytes() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF....WEBP"), None);
        assert_eq!(image_mime(&[]), None);
    }

    #[test]
    fn linkedin_has_a_button_for_seven_of_the_nine_calls_to_action() {
        assert_eq!(label(CallToAction::GetQuote), Some("VIEW_QUOTE"));
        assert_eq!(label(CallToAction::ApplyNow), Some("APPLY"));
        assert_eq!(label(CallToAction::ContactUs), None);
        assert_eq!(label(CallToAction::BookNow), None);
    }

    #[test]
    fn a_day_is_written_as_linkedin_takes_it() {
        let date = Date::from_calendar_date(2026, Month::November, 3).unwrap();
        assert_eq!(day(date), "(year:2026,month:11,day:3)");
    }
}
