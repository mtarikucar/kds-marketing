//! Ad campaigns in an X ads account (design 2026-11-11 §3.4): the campaign that holds the total
//! budget, the line item that says who sees the ads and when, the image, the website card, the
//! promoted-only post, the promoted post that ties it to the line item, their switches, their
//! state and their daily numbers. The crate docs hold the calls and the choices made.

use std::collections::BTreeMap;
use std::time::Instant;

use jt_app::ports::connectors::{
    AdAccountLimits, AdDay, AdLevel, AdObjective, AdSetGoal, AdSetSpec, AdSpec, AdStatus, Asset,
    CampaignProviderState, CampaignSpec, CreativeAction, CreativeSpec, ProviderAd,
    ProviderAdStatus,
};
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::{
    Date, Duration, OffsetDateTime, UtcOffset, format_description::FormatItem,
    macros::format_description,
};

use crate::XConnector;
use crate::client::{Auth, Body, Endpoint, Upload, missing, text};
use crate::credential::token_of;

/// The capability kind of an X ads account.
pub(crate) const ADS_KIND: &str = "x_ads";

/// The version of the Ads API every call names in its path.
pub const ADS_VERSION: &str = "12";

/// The most ads accounts of a sign-in offered for connection.
pub const MAX_AD_ACCOUNTS: usize = 20;

/// The most pages of one list read.
pub const MAX_AD_PAGES: usize = 20;

/// The rows asked for per page of a list (the smallest of the Ads API's page limits).
const PAGE_SIZE: &str = "200";

/// The most promoted posts one analytics call names, and the most days it spans.
const STATS_IDS: usize = 20;
const STATS_DAYS: i64 = 7;

/// The longest text of a post (as X counts it: `crate::publish::weighted_length`), and the
/// longest title of a website card, in characters.
pub(crate) const MAX_TEXT_CHARS: usize = 280;
pub(crate) const MAX_TITLE_CHARS: usize = 70;

/// The longest name of a card and of a post.
const MAX_NAME_CHARS: usize = 80;

/// The longest name of an object of the media library.
const MAX_LIBRARY_NAME_CHARS: usize = 100;

/// The largest image a website card takes, in bytes (3 MB).
pub(crate) const MAX_CARD_IMAGE_BYTES: usize = 3 * 1024 * 1024;

/// The permissions of an ads account one of which lets a user build campaigns in it, and the
/// one that lets them write its promoted-only posts.
const CAMPAIGN_PERMISSIONS: &[&str] = &["ACCOUNT_ADMIN", "AD_MANAGER"];
const POST_PERMISSION: &str = "TWEET_COMPOSER";

/// A time as the Ads API takes it: ISO 8601, in UTC.
const MOMENT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");

/// A day as the analytics take it: read as midnight in the ads account's own time zone.
const DAY: &[FormatItem<'static>] = format_description!("[year]-[month]-[day]");

/// Which object of an ads account an id names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Entity<'a> {
    Campaign(&'a str),
    Line(&'a str),
    /// An ad: the post `tweet` promoted in the line item `line`.
    Ad {
        line: &'a str,
        tweet: &'a str,
    },
}

/// Whether `text` is an id of the Ads API (its ids are short base-36 words): 1 to 20 ASCII
/// lowercase letters or digits.
fn word(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 20
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

/// Whether `text` is a post id: 1 to 20 ASCII digits.
fn digits(text: &str) -> bool {
    !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit())
}

/// The id this adapter gives a campaign of ads account `account`.
pub(crate) fn campaign_id(account: &str, id: &str) -> String {
    format!("xa:{account}:campaign:{id}")
}

/// The id this adapter gives a line item of ads account `account`.
pub(crate) fn line_id(account: &str, id: &str) -> String {
    format!("xa:{account}:line:{id}")
}

/// The id this adapter gives an ad: the post `tweet` promoted in the line item `line`. It names
/// neither of X's own rows for the pair (a promoted post), because pausing an ad deletes that
/// row and resuming it makes another: the ad stays the same ad.
pub(crate) fn ad_id(account: &str, line: &str, tweet: &str) -> String {
    format!("xa:{account}:ad:{line}:{tweet}")
}

/// The ads account and the object of an id of this adapter's shape; `None` for anything else, so
/// that an id can never change the request it is put in.
pub(crate) fn parse(id: &str) -> Option<(&str, Entity<'_>)> {
    let parts: Vec<&str> = id.split(':').collect();
    match parts.as_slice() {
        ["xa", account, "campaign", campaign] if word(account) && word(campaign) => {
            Some((account, Entity::Campaign(campaign)))
        }
        ["xa", account, "line", line] if word(account) && word(line) => {
            Some((account, Entity::Line(line)))
        }
        ["xa", account, "ad", line, tweet] if word(account) && word(line) && digits(tweet) => {
            Some((account, Entity::Ad { line, tweet }))
        }
        _ => None,
    }
}

/// What an id names when it is an object of ads account `account`.
fn owned<'a>(id: &'a str, account: &str) -> Result<Entity<'a>, ConnectorError> {
    match parse(id) {
        Some((owner, entity)) if owner == account => Ok(entity),
        Some(_) => Err(ConnectorError::permanent(
            "the object is of another X ads account",
        )),
        None => Err(ConnectorError::permanent(WRONG_KIND)),
    }
}

/// Why an id that names another kind of object than the call needs is refused.
const WRONG_KIND: &str = "not an X ad object of the expected kind";

/// The campaign `id` names in ads account `account`.
fn owned_campaign<'a>(id: &'a str, account: &str) -> Result<&'a str, ConnectorError> {
    match owned(id, account)? {
        Entity::Campaign(campaign) => Ok(campaign),
        _ => Err(ConnectorError::permanent(WRONG_KIND)),
    }
}

/// The line item `id` names in ads account `account`.
fn owned_line<'a>(id: &'a str, account: &str) -> Result<&'a str, ConnectorError> {
    match owned(id, account)? {
        Entity::Line(line) => Ok(line),
        _ => Err(ConnectorError::permanent(WRONG_KIND)),
    }
}

/// The ads account of the capability whose public fields are `public`; `Permanent` for another
/// kind or a malformed id.
pub(crate) fn account_of(public: &Value) -> Result<String, ConnectorError> {
    match public["kind_key"].as_str() {
        Some(ADS_KIND) => {}
        Some(_) => return Err(ConnectorError::permanent("not an X ads account")),
        None => return Err(ConnectorError::permanent(crate::credential::KIND_MISSING)),
    }
    public["external_id"]
        .as_str()
        .map(str::trim)
        .filter(|id| word(id))
        .map(str::to_owned)
        .ok_or_else(|| ConnectorError::permanent("the X ads account id is missing"))
}

/// The minor unit exponent of `currency`; `Permanent` for one the system does not count in.
fn exponent(currency: &str) -> Result<u8, ConnectorError> {
    jt_connector::currency_minor_exponent(currency)
        .ok_or_else(|| ConnectorError::permanent("unsupported ad account currency"))
}

/// `minor` minor units as X's micros (a millionth of the currency), as text.
fn micros(minor: i64, exponent: u8) -> Result<String, ConnectorError> {
    let not_an_amount = || ConnectorError::permanent("the campaign budget is not an amount");
    if minor <= 0 || exponent > 6 {
        return Err(not_an_amount());
    }
    minor
        .checked_mul(10i64.pow(u32::from(6 - exponent)))
        .map(|micro| micro.to_string())
        .ok_or_else(not_an_amount)
}

/// X's micros as minor units, rounded to the nearest; `None` for a negative amount.
fn minor_of(micro: i64, exponent: u8) -> Option<i64> {
    if micro < 0 || exponent > 6 {
        return None;
    }
    let unit = 10i64.pow(u32::from(6 - exponent));
    Some((micro + unit / 2) / unit)
}

/// `at` as the Ads API takes a time.
fn moment(at: OffsetDateTime) -> Result<String, ConnectorError> {
    at.to_offset(UtcOffset::UTC)
        .format(MOMENT)
        .map_err(|_| ConnectorError::permanent("the campaign's time cannot be written"))
}

/// What X says of an ads account, with what building a campaign in it needs.
struct Account {
    name: Option<String>,
    time_zone: String,
    /// The one funding instrument that can pay, and its currency.
    funding: String,
    currency: String,
    /// The X user the ads account advertises as (its `FULL` promotable user): the author of
    /// its promoted-only posts.
    speaker: String,
    /// Whether the signed-in user is that user; else they write its posts on its behalf.
    own: bool,
}

impl XConnector {
    /// The Ads API URL `{ads}/12/{segments}` with `query`.
    fn ads_url(&self, segments: &[&str], query: &[(&str, &str)]) -> url::Url {
        let mut all = vec![ADS_VERSION];
        all.extend_from_slice(segments);
        crate::client::join(&self.bases().ads, &all, query)
    }

    /// One call of the Ads API: its parameters travel in the query, on a write too.
    async fn ads(
        &self,
        method: Method,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        self.call(
            method,
            self.ads_url(segments, query),
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Api,
        )
        .await
    }

    /// Every row of the list at `segments` with `query`, page by page (at most
    /// [`MAX_AD_PAGES`] pages; a list that still has more is refused, not cut short).
    async fn all(
        &self,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Vec<Value>, ConnectorError> {
        let mut rows = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_AD_PAGES {
            let mut paged = query.to_vec();
            paged.push(("count", PAGE_SIZE));
            if let Some(cursor) = &cursor {
                paged.push(("cursor", cursor));
            }
            let answer = self.ads(Method::GET, token, segments, &paged).await?;
            match &answer["data"] {
                Value::Array(data) => rows.extend(data.iter().cloned()),
                Value::Null => {}
                _ => return Err(missing("data")),
            }
            match text(&answer["next_cursor"]) {
                Some(next) => cursor = Some(next),
                None => return Ok(rows),
            }
        }
        Err(ConnectorError::permanent(
            "X's answer has more pages than are read",
        ))
    }

    /// The ads account `account` as this token may build in it: accepted by X, the signed-in
    /// user allowed to build campaigns and to write its promoted-only posts (they are the user
    /// the account advertises as, or may write on that user's behalf), and exactly one funding
    /// instrument that can pay. Each of them failing is said by name.
    async fn ad_account(&self, token: &str, account: &str) -> Result<Account, ConnectorError> {
        let answer = self
            .ads(Method::GET, token, &["accounts", account], &[])
            .await?;
        let row = &answer["data"];
        // The account the token reads is the one that was asked for, never another.
        if row["id"].as_str() != Some(account) {
            return Err(ConnectorError::permanent(
                "X answered for another ads account",
            ));
        }
        if row["deleted"].as_bool() == Some(true)
            || row["approval_status"].as_str() != Some("ACCEPTED")
        {
            return Err(ConnectorError::permission(
                "the X ads account is not approved for advertising",
            ));
        }
        let access = self
            .ads(
                Method::GET,
                token,
                &["accounts", account, "authenticated_user_access"],
                &[],
            )
            .await?;
        let permissions: Vec<&str> = access["data"]["permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if !permissions.iter().any(|p| CAMPAIGN_PERMISSIONS.contains(p)) {
            return Err(ConnectorError::permission(
                "the X user may not build campaigns in this ads account",
            ));
        }
        // The user the account advertises as writes its posts; anybody else needs X's
        // permission to write them on that user's behalf.
        let promotable = self
            .all(token, &["accounts", account, "promotable_users"], &[])
            .await?;
        let mut full = promotable
            .iter()
            .filter(|row| row["deleted"].as_bool() != Some(true))
            .filter(|row| row["promotable_user_type"].as_str() == Some("FULL"))
            .filter_map(|row| text(&row["user_id"]))
            .filter(|id| digits(id));
        let speaker = match (full.next(), full.next()) {
            (Some(one), None) => one,
            _ => {
                return Err(ConnectorError::permission(
                    "the X ads account names no single user it advertises as",
                ));
            }
        };
        let own = text(&access["data"]["user_id"]).as_deref() == Some(speaker.as_str());
        if !own && !permissions.contains(&POST_PERMISSION) {
            return Err(ConnectorError::permission(
                "the X user may not write promoted-only posts for this ads account",
            ));
        }
        let instruments = self
            .all(token, &["accounts", account, "funding_instruments"], &[])
            .await?;
        let mut usable = instruments.iter().filter(|row| {
            row["able_to_fund"].as_bool() == Some(true)
                && row["deleted"].as_bool() != Some(true)
                && row["entity_status"].as_str() == Some("ACTIVE")
        });
        let funding = match (usable.next(), usable.next()) {
            (Some(one), None) => one,
            (None, _) => {
                return Err(ConnectorError::permission(
                    "the X ads account has no funding instrument that can pay",
                ));
            }
            // Which one pays is the advertiser's choice, never a guess.
            _ => {
                return Err(ConnectorError::permanent(
                    "the X ads account has more than one funding instrument that can pay",
                ));
            }
        };
        Ok(Account {
            name: text(&row["name"]),
            time_zone: text(&row["timezone"]).ok_or_else(|| missing("time zone"))?,
            funding: text(&funding["id"])
                .filter(|id| word(id))
                .ok_or_else(|| missing("funding instrument"))?,
            currency: text(&funding["currency"]).ok_or_else(|| missing("currency"))?,
            speaker,
            own,
        })
    }
}

/// The ads accounts the signed-in user may build campaigns in, with their currency and time
/// zone. An account that cannot be used (not approved, no permission, no single funding
/// instrument) is left out; a failure that is not the account's fails the listing.
pub(crate) async fn list_assets(
    connector: &XConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list ads accounts")?;
    let rows = connector.all(token, &["accounts"], &[]).await?;
    let ids: Vec<String> = rows
        .iter()
        .filter(|row| row["deleted"].as_bool() != Some(true))
        .filter_map(|row| text(&row["id"]))
        .filter(|id| word(id))
        .take(MAX_AD_ACCOUNTS)
        .collect();
    let mut assets = Vec::new();
    for id in ids {
        let account = match connector.ad_account(token, &id).await {
            Ok(account) => account,
            Err(ConnectorError::Permission { .. } | ConnectorError::Permanent { .. }) => continue,
            Err(e) => return Err(e),
        };
        assets.push(Asset {
            kind_key: ADS_KIND.to_owned(),
            name: account.name.clone().unwrap_or_else(|| id.clone()),
            external_id: id,
            credential: cred.clone(),
            public: json!({"currency": account.currency, "time_zone": account.time_zone}),
        });
    }
    Ok(assets)
}

/// The probe of an ads account capability (never fails: a failure is a failed probe).
pub(crate) async fn probe(
    connector: &XConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = async {
        let wanted = account_of(public)?;
        let token = token_of(cred, "be probed")?;
        let account = connector.ad_account(token, &wanted).await?;
        Ok(json!({
            "account_id": wanted,
            "name": account.name,
            "currency": account.currency,
            "time_zone": account.time_zone,
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
    c: &XConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountLimits, ConnectorError> {
    let account = account_of(public)?;
    let token = token_of(cred, "read an ads account")?;
    let facts = c.ad_account(token, &account).await?;
    Ok(AdAccountLimits {
        minor_unit_exponent: exponent(&facts.currency)?,
        currency: facts.currency,
        timezone: facts.time_zone,
        // X documents no least budget.
        min_daily_budget_minor: 0,
        min_total_budget_minor: 0,
    })
}

/// The one row named exactly `name` among `rows` (X matches a name by its beginning), not
/// deleted; `None` when there is none.
fn named<'a>(rows: &'a [Value], name: &str) -> Result<Option<&'a Value>, ConnectorError> {
    let mut found = rows
        .iter()
        .filter(|row| row["name"].as_str() == Some(name))
        .filter(|row| row["deleted"].as_bool() != Some(true));
    match (found.next(), found.next()) {
        (None, _) => Ok(None),
        (Some(row), None) => Ok(Some(row)),
        _ => Err(ConnectorError::permanent(
            "more than one object of the account carries this name",
        )),
    }
}

pub(crate) async fn find_by_name(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    level: AdLevel,
    name: &str,
) -> Result<Option<String>, ConnectorError> {
    let account = account_of(public)?;
    let token = token_of(cred, "search an ads account")?;
    match level {
        AdLevel::Campaign => {
            let rows = c
                .all(token, &["accounts", &account, "campaigns"], &[("q", name)])
                .await?;
            Ok(named(&rows, name)?
                .and_then(|row| text(&row["id"]))
                .filter(|id| word(id))
                .map(|id| campaign_id(&account, &id)))
        }
        AdLevel::Creative => {
            let rows = c
                .all(token, &["accounts", &account, "cards"], &[("q", name)])
                .await?;
            Ok(named(&rows, name)?.and_then(|row| card_uri(&row["card_uri"])))
        }
        // The line item is adopted by its own step, which also makes sure of its countries
        // (a line item without them is shown to everybody, everywhere); the ad by its own
        // step, which looks for the post and for its promotion.
        AdLevel::AdSet | AdLevel::Ad => Ok(None),
    }
}

/// The campaign: the whole budget as its total budget, paused. X asks most accounts for a
/// daily budget too, which may not be above the total: it is the total itself, so that the
/// total is the only limit.
pub(crate) async fn create_campaign(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    spec: &CampaignSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    if spec.objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "an X campaign here brings visits to a website only",
        ));
    }
    let token = token_of(cred, "create a campaign")?;
    let facts = c.ad_account(token, &account).await?;
    let budget = micros(spec.lifetime_budget_minor, exponent(&facts.currency)?)?;
    let answer = c
        .ads(
            Method::POST,
            token,
            &["accounts", &account, "campaigns"],
            &[
                ("funding_instrument_id", &facts.funding),
                ("name", &spec.name),
                ("total_budget_amount_local_micro", &budget),
                ("daily_budget_amount_local_micro", &budget),
                ("entity_status", "PAUSED"),
            ],
        )
        .await?;
    created(&answer["data"]["id"]).map(|id| campaign_id(&account, &id))
}

/// The id X gave what it just created; `Unknown` without a valid one (the object may well
/// exist).
fn created(id: &Value) -> Result<String, ConnectorError> {
    text(id)
        .filter(|id| word(id))
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid id"))
}

/// X's targeting value of the country `code`: the one location of kind `COUNTRIES` it lists
/// for that code.
async fn country(c: &XConnector, token: &str, code: &str) -> Result<String, ConnectorError> {
    let rows = c
        .all(
            token,
            &["targeting_criteria", "locations"],
            &[("location_type", "COUNTRIES"), ("country_code", code)],
        )
        .await?;
    let mut found = rows
        .iter()
        .filter(|row| row["location_type"].as_str() == Some("COUNTRIES"))
        .filter(|row| row["country_code"].as_str() == Some(code))
        .filter_map(|row| text(&row["targeting_value"]));
    match (found.next(), found.next()) {
        (Some(value), None) => Ok(value),
        _ => Err(ConnectorError::permanent(format!(
            "X names no single location for the country {code}"
        ))),
    }
}

/// The line item: when the ads run, with the whole budget once more as its total budget, for
/// clicks to a website, on X itself, paused; and one location criterion for each country. A
/// line item of the campaign that already carries the name is adopted, and its countries are
/// made sure of all the same: the step answers only once every country is there, since a line
/// item without a location is shown to everybody, everywhere.
pub(crate) async fn create_adset(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSetSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let campaign = owned_campaign(&spec.campaign_id, &account)?;
    if spec.goal != AdSetGoal::LinkClicks {
        return Err(ConnectorError::permanent(
            "an X campaign here brings visits to a website only",
        ));
    }
    if spec.audience.countries.is_empty() {
        return Err(ConnectorError::permanent(
            "an X line item needs its countries",
        ));
    }
    if spec.end_at <= spec.start_at {
        return Err(ConnectorError::permanent(
            "the campaign ends before it starts",
        ));
    }
    let token = token_of(cred, "create a line item")?;
    let facts = c.ad_account(token, &account).await?;
    // The countries first: a country X does not know stops the step before anything is made.
    let mut wanted = Vec::new();
    for code in &spec.audience.countries {
        wanted.push(country(c, token, code).await?);
    }
    let existing = c
        .all(
            token,
            &["accounts", &account, "line_items"],
            &[("campaign_ids", campaign), ("q", &spec.name)],
        )
        .await?;
    let line = match named(&existing, &spec.name)? {
        Some(row) => created(&row["id"])?,
        None => {
            let budget = micros(spec.budget_minor, exponent(&facts.currency)?)?;
            let answer = c
                .ads(
                    Method::POST,
                    token,
                    &["accounts", &account, "line_items"],
                    &[
                        ("campaign_id", campaign),
                        ("name", &spec.name),
                        ("objective", "WEBSITE_CLICKS"),
                        ("product_type", "PROMOTED_TWEETS"),
                        // X itself only: what was planned and checked is what runs.
                        ("placements", "ALL_ON_TWITTER"),
                        ("start_time", &moment(spec.start_at)?),
                        ("end_time", &moment(spec.end_at)?),
                        ("total_budget_amount_local_micro", &budget),
                        // X bids by itself for clicks on the link.
                        ("bid_strategy", "AUTO"),
                        ("goal", "LINK_CLICKS"),
                        ("entity_status", "PAUSED"),
                    ],
                )
                .await?;
            created(&answer["data"]["id"])?
        }
    };
    let held = c
        .all(
            token,
            &["accounts", &account, "targeting_criteria"],
            &[("line_item_ids", &line)],
        )
        .await?;
    for value in &wanted {
        let there = held.iter().any(|row| {
            row["targeting_type"].as_str() == Some("LOCATION")
                && row["deleted"].as_bool() != Some(true)
                && text(&row["targeting_value"]).as_deref() == Some(value.as_str())
        });
        if !there {
            c.ads(
                Method::POST,
                token,
                &["accounts", &account, "targeting_criteria"],
                &[
                    ("line_item_id", &line),
                    ("operator_type", "EQ"),
                    ("targeting_type", "LOCATION"),
                    ("targeting_value", value),
                ],
            )
            .await?;
        }
    }
    Ok(line_id(&account, &line))
}

/// The media type of an image by its first bytes: JPG or PNG.
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        _ => None,
    }
}

/// The ad's image: uploaded as a post's image is, then added to the ads account's media
/// library, which is where a card takes its media from. Its media key. When the signed-in user
/// is not the user the account advertises as, that user is named as another owner of the
/// upload, as X asks for a post written on their behalf.
pub(crate) async fn upload_image(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    bytes: &[u8],
    name: &str,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let mime = image_mime(bytes)
        .ok_or_else(|| ConnectorError::permanent("an X ad image is a JPG or a PNG"))?;
    if bytes.len() > MAX_CARD_IMAGE_BYTES {
        return Err(ConnectorError::permanent("an X ad image is at most 3 MB"));
    }
    let token = token_of(cred, "upload an ad image")?;
    let facts = c.ad_account(token, &account).await?;
    let extension = if mime == "image/png" { "png" } else { "jpg" };
    let answer = c
        .call(
            Method::POST,
            c.upload_url(&["2", "media", "upload"]),
            Auth::Bearer(token),
            &Body::Upload(Upload {
                bytes,
                mime,
                filename: format!("{name}.{extension}"),
                category: "tweet_image",
                additional_owners: (!facts.own).then_some(facts.speaker.as_str()),
            }),
            Endpoint::Api,
        )
        .await?;
    let data = &answer["data"];
    let key = text(&data["media_key"])
        // An image's media key is its media id behind `3_`.
        .or_else(|| text(&data["id"]).map(|id| format!("3_{id}")))
        .filter(|key| media_key(key))
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a media key"))?;
    let library_name: String = name.chars().take(MAX_LIBRARY_NAME_CHARS).collect();
    let added = c
        .ads(
            Method::POST,
            token,
            &["accounts", &account, "media_library"],
            &[("media_key", &key), ("name", &library_name)],
        )
        .await?;
    // The library answers the key it holds the media under: the one that was given.
    Ok(text(&added["data"]["media_key"])
        .filter(|held| media_key(held))
        .unwrap_or(key))
}

/// Whether `text` is a media key: a number, an underscore, a number.
fn media_key(text: &str) -> bool {
    matches!(text.split_once('_'), Some((kind, id)) if digits(kind) && digits(id))
}

/// `value` when it is a card's address (`card://` and a number).
fn card_uri(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|uri| uri.strip_prefix("card://").is_some_and(digits))
        .map(str::to_owned)
}

/// What an X ad is made of, once its parts are held: the image, the post's text, the card's
/// title and the address. An X website card has no button.
struct Parts<'a> {
    image: &'a str,
    text: &'a str,
    title: &'a str,
    url: &'a str,
}

/// The parts of `spec` as an X website card ad takes them; `Permanent` for one it cannot show.
fn parts(spec: &CreativeSpec) -> Result<Parts<'_>, ConnectorError> {
    let image = spec
        .image
        .as_deref()
        .filter(|key| media_key(key))
        .ok_or_else(|| ConnectorError::permanent("an X ad needs its image"))?;
    let CreativeAction::Link { url } = &spec.action else {
        return Err(ConnectorError::permanent("an X ad here leads to a website"));
    };
    let text = spec.primary_text.trim();
    if text.is_empty() || crate::publish::weighted_length(text) > MAX_TEXT_CHARS {
        return Err(ConnectorError::permanent(
            "an X ad's text is 1 to 280 characters",
        ));
    }
    // X takes a website card or a link in the post, not both: the card carries the address.
    if crate::publish::has_link(text) {
        return Err(ConnectorError::permanent(
            "an X ad's text carries no link: its card does",
        ));
    }
    if spec.name.chars().count() > MAX_NAME_CHARS {
        return Err(ConnectorError::permanent(
            "an X card or post name is at most 80 characters",
        ));
    }
    let title = spec.headline.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(ConnectorError::permanent(
            "an X ad's card title is 1 to 70 characters",
        ));
    }
    Ok(Parts {
        image,
        text,
        title,
        url: url.as_str(),
    })
}

/// The creative: a website card of the ad's image, its title and its address.
pub(crate) async fn create_creative(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    spec: &CreativeSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let parts = parts(spec)?;
    let token = token_of(cred, "create a card")?;
    let answer = c
        .call(
            Method::POST,
            c.ads_url(&["accounts", &account, "cards"], &[]),
            Auth::Bearer(token),
            &Body::Json(json!({
                "name": spec.name,
                "components": [
                    {"type": "MEDIA", "media_key": parts.image},
                    {"type": "DETAILS", "title": parts.title,
                     "destination": {"type": "WEBSITE", "url": parts.url}},
                ],
            })),
            Endpoint::Api,
        )
        .await?;
    card_uri(&answer["data"]["card_uri"])
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a card"))
}

/// X's rows that promote the post `tweet` in the line item `line`: those that are there now
/// (not deleted), as their ids.
async fn promotions(
    c: &XConnector,
    token: &str,
    account: &str,
    line: &str,
    tweet: &str,
) -> Result<Vec<String>, ConnectorError> {
    let rows = c
        .all(
            token,
            &["accounts", account, "promoted_tweets"],
            &[("line_item_ids", line)],
        )
        .await?;
    Ok(rows
        .iter()
        .filter(|row| row["deleted"].as_bool() != Some(true))
        .filter(|row| text(&row["tweet_id"]).as_deref() == Some(tweet))
        .filter_map(|row| text(&row["id"]))
        .filter(|id| word(id))
        .collect())
}

/// Promotes the post `tweet` in the line item `line`.
async fn promote(
    c: &XConnector,
    token: &str,
    account: &str,
    line: &str,
    tweet: &str,
) -> Result<(), ConnectorError> {
    c.ads(
        Method::POST,
        token,
        &["accounts", account, "promoted_tweets"],
        &[("line_item_id", line), ("tweet_ids", tweet)],
    )
    .await
    .map(|_| ())
}

/// The ad: a promoted-only post of the user the ads account advertises as (X's default for the
/// account, so no user is named), carrying the card. A post that already carries the ad's name
/// is adopted: after a lost answer no second post is written.
///
/// The post is not promoted here. X has no paused promotion (one that exists runs as soon as
/// its line item and campaign do), so an ad is created off, like on every other platform, and
/// it is switching it on ([`set_status`]) that promotes the post in its line item.
pub(crate) async fn create_ad(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    spec: &AdSpec,
) -> Result<String, ConnectorError> {
    let account = account_of(public)?;
    let line = owned_line(&spec.adset_id, &account)?;
    let parts = parts(&spec.creative)?;
    let card = card_uri(&json!(spec.creative_id))
        .ok_or_else(|| ConnectorError::permanent("an X ad needs its card"))?;
    if spec.name.chars().count() > MAX_NAME_CHARS {
        return Err(ConnectorError::permanent(
            "an X card or post name is at most 80 characters",
        ));
    }
    let token = token_of(cred, "create an ad")?;
    let posts = c
        .all(
            token,
            &["accounts", &account, "tweets"],
            &[
                ("tweet_type", "PUBLISHED"),
                ("timeline_type", "NULLCAST"),
                ("name", &spec.name),
            ],
        )
        .await?;
    let post_id = |row: &Value| text(&row["id_str"]).or_else(|| text(&row["id"]));
    let tweet = match named(&posts, &spec.name)? {
        Some(row) => post_id(row),
        None => {
            let answer = c
                .ads(
                    Method::POST,
                    token,
                    &["accounts", &account, "tweet"],
                    &[
                        ("text", parts.text),
                        ("card_uri", &card),
                        ("nullcast", "true"),
                        ("name", &spec.name),
                    ],
                )
                .await?;
            post_id(&answer["data"])
        }
    }
    .filter(|id| digits(id))
    .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid id"))?;
    Ok(ad_id(&account, line, &tweet))
}

/// Switches the campaign, the line item or the ad `entity_id` names on or off.
///
/// A campaign's switch takes its line items with it. X does not say that a campaign's total
/// budget is never exceeded, so the pause Jeeta sends when the budget is reached is the limit
/// itself (design B67): it turns off the campaign and then each of its line items, tries every
/// one of them whatever the others answered (one switch off is better than none), and answers
/// well only once both levels are off. A release turns the line items on first and the campaign
/// last, so nothing runs before the whole of it is on again.
///
/// X has no switch for one promoted post: an ad is switched on by promoting its post in its
/// line item, and off by deleting that promotion (the post itself stays).
pub(crate) async fn set_status(
    c: &XConnector,
    cred: &Credential,
    entity_id: &str,
    status: AdStatus,
) -> Result<(), ConnectorError> {
    let (account, entity) =
        parse(entity_id).ok_or_else(|| ConnectorError::permanent(WRONG_KIND))?;
    let token = token_of(cred, "change an ad's status")?;
    let word = match status {
        AdStatus::Active => "ACTIVE",
        AdStatus::Paused => "PAUSED",
    };
    let switch_line = |line: String| async move {
        c.ads(
            Method::PUT,
            token,
            &["accounts", account, "line_items", &line],
            &[("entity_status", word)],
        )
        .await
        .map(|_| ())
    };
    match entity {
        Entity::Campaign(campaign) => {
            let switch_campaign = || async {
                c.ads(
                    Method::PUT,
                    token,
                    &["accounts", account, "campaigns", campaign],
                    &[("entity_status", word)],
                )
                .await
                .map(|_| ())
            };
            match status {
                AdStatus::Paused => {
                    let mut failed = switch_campaign().await.err();
                    match lines_of(c, token, account, campaign, false).await {
                        Ok(lines) => {
                            for line in lines {
                                if let Err(e) = switch_line(line).await {
                                    failed.get_or_insert(e);
                                }
                            }
                        }
                        Err(e) => {
                            failed.get_or_insert(e);
                        }
                    }
                    failed.map_or(Ok(()), Err)
                }
                AdStatus::Active => {
                    for line in lines_of(c, token, account, campaign, false).await? {
                        switch_line(line).await?;
                    }
                    switch_campaign().await
                }
            }
        }
        Entity::Line(line) => switch_line(line.to_owned()).await,
        Entity::Ad { line, tweet } => {
            let there = promotions(c, token, account, line, tweet).await?;
            match status {
                AdStatus::Active if there.is_empty() => {
                    promote(c, token, account, line, tweet).await
                }
                AdStatus::Active => Ok(()),
                AdStatus::Paused => {
                    for promotion in there {
                        c.ads(
                            Method::DELETE,
                            token,
                            &["accounts", account, "promoted_tweets", &promotion],
                            &[],
                        )
                        .await?;
                    }
                    Ok(())
                }
            }
        }
    }
}

/// The line items of campaign `campaign`, as their ids; with `deleted`, those X no longer
/// shows too (what one of them spent before it was deleted is still spent).
async fn lines_of(
    c: &XConnector,
    token: &str,
    account: &str,
    campaign: &str,
    deleted: bool,
) -> Result<Vec<String>, ConnectorError> {
    let mut query = vec![("campaign_ids", campaign)];
    if deleted {
        query.push(("with_deleted", "true"));
    }
    let rows = c
        .all(token, &["accounts", account, "line_items"], &query)
        .await?;
    Ok(rows
        .iter()
        .filter(|row| deleted || row["deleted"].as_bool() != Some(true))
        .filter_map(|row| text(&row["id"]))
        .filter(|id| word(id))
        .collect())
}

/// Every promotion X ever held for the line items `lines`, deleted ones too: the numbers of an
/// ad that was paused and resumed are spread over several of them.
async fn all_promotions(
    c: &XConnector,
    token: &str,
    account: &str,
    lines: &[String],
) -> Result<Vec<Value>, ConnectorError> {
    let mut rows = Vec::new();
    for line in lines {
        rows.extend(
            c.all(
                token,
                &["accounts", account, "promoted_tweets"],
                &[("line_item_ids", line), ("with_deleted", "true")],
            )
            .await?,
        );
    }
    Ok(rows)
}

/// How a promotion that is there stands: X accepted it, turned it down, or has not said yet.
fn promotion_status(row: &Value) -> ProviderAdStatus {
    match (
        row["entity_status"].as_str().unwrap_or_default(),
        row["approval_status"].as_str().unwrap_or_default(),
    ) {
        (_, "REJECTED") => ProviderAdStatus::Disapproved,
        ("PAUSED", _) => ProviderAdStatus::Paused,
        ("ACTIVE", "ACCEPTED") => ProviderAdStatus::Active,
        ("ACTIVE", "PENDING" | "UNDER_REVIEW" | "") => ProviderAdStatus::InReview,
        (_, other) => ProviderAdStatus::Other(other.to_owned()),
    }
}

pub(crate) async fn campaign_state(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
) -> Result<CampaignProviderState, ConnectorError> {
    let account = account_of(public)?;
    let campaign = owned_campaign(campaign_id, &account)?;
    let token = token_of(cred, "read a campaign")?;
    let answer = c
        .ads(
            Method::GET,
            token,
            &["accounts", &account, "campaigns", campaign],
            &[("with_deleted", "true")],
        )
        .await?;
    let row = &answer["data"];
    let status = match (
        row["deleted"].as_bool() == Some(true),
        row["entity_status"].as_str().unwrap_or_default(),
    ) {
        (true, _) => ProviderAdStatus::Archived,
        (_, "ACTIVE") => ProviderAdStatus::Active,
        (_, "PAUSED" | "DRAFT") => ProviderAdStatus::Paused,
        (_, other) => ProviderAdStatus::Other(other.to_owned()),
    };
    let lines = lines_of(c, token, &account, campaign, false).await?;
    // An ad is a post in a line item: it runs through the promotion that is there now, and is
    // paused when every promotion it had was deleted.
    let mut ads: BTreeMap<(String, String), ProviderAdStatus> = BTreeMap::new();
    for row in all_promotions(c, token, &account, &lines).await? {
        let (Some(line), Some(tweet)) = (
            text(&row["line_item_id"]).filter(|id| word(id)),
            text(&row["tweet_id"]).filter(|id| digits(id)),
        ) else {
            return Err(missing("promoted post"));
        };
        let status = if row["deleted"].as_bool() == Some(true) {
            ProviderAdStatus::Paused
        } else {
            promotion_status(&row)
        };
        ads.entry((line, tweet))
            .and_modify(|held| {
                // The one that is there now speaks for the ad.
                if *held == ProviderAdStatus::Paused {
                    *held = status.clone();
                }
            })
            .or_insert(status);
    }
    Ok(CampaignProviderState {
        campaign: status,
        ads: ads
            .into_iter()
            .map(|((line, tweet), status)| ProviderAd {
                ad_id: ad_id(&account, &line, &tweet),
                name: tweet,
                status,
                feedback: None,
            })
            .collect(),
    })
}

/// The `n`-th number of a metric X gives as one number per day; `None` when the metric has
/// none for the range (X then gives `null` in place of the list).
fn nth(metrics: &Value, name: &str, n: usize) -> Result<Option<i64>, ConnectorError> {
    match &metrics[name] {
        Value::Null => Ok(None),
        Value::Array(days) => match days.get(n) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_i64()
                .filter(|n| *n >= 0)
                .map(Some)
                .ok_or_else(|| ConnectorError::permanent(format!("X's {name} is not a count"))),
        },
        _ => Err(ConnectorError::permanent(format!(
            "X's {name} is not a list of days"
        ))),
    }
}

/// `a` and `b` added, where a missing number adds nothing and two missing ones stay missing.
fn added(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
    }
}

/// One ad's numbers of one day as X gives them, its spend still in micros: the promotions of an
/// ad are added up before the spend is rounded.
#[derive(Default)]
struct Sum {
    micro: Option<i64>,
    impressions: Option<i64>,
    clicks: Option<i64>,
    visits: Option<i64>,
}

impl Sum {
    fn add(&mut self, other: &Sum) {
        self.micro = added(self.micro, other.micro);
        self.impressions = added(self.impressions, other.impressions);
        self.clicks = added(self.clicks, other.clicks);
        self.visits = added(self.visits, other.visits);
    }

    /// Whether nothing was shown, clicked or charged.
    fn nothing(&self) -> bool {
        [self.micro, self.impressions, self.clicks]
            .iter()
            .all(|n| n.unwrap_or(0) == 0)
    }
}

/// The numbers of each ad, by day.
type Sums = BTreeMap<(String, Date), Sum>;

/// The numbers of the promotions `owners` (each with the ad it belongs to) for the days `from`
/// to `last`, a week at most: each promotion's days, added to its ad's.
async fn week(
    c: &XConnector,
    token: &str,
    account: &str,
    owners: &BTreeMap<String, String>,
    from: Date,
    last: Date,
) -> Result<Sums, ConnectorError> {
    let day = |date: Date| {
        date.format(DAY)
            .map_err(|_| ConnectorError::permanent("the day cannot be written"))
    };
    let mut sums = Sums::new();
    // The end of the analytics is the first day left out.
    let Some(end) = last.next_day() else {
        return Ok(sums);
    };
    let ids: Vec<&String> = owners.keys().collect();
    for chunk in ids.chunks(STATS_IDS) {
        let list = chunk
            .iter()
            .map(|id| id.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let answer = c
            .ads(
                Method::GET,
                token,
                &["stats", "accounts", account],
                &[
                    ("entity", "PROMOTED_TWEET"),
                    ("entity_ids", &list),
                    ("start_time", &day(from)?),
                    ("end_time", &day(end)?),
                    ("granularity", "DAY"),
                    ("placement", "ALL_ON_TWITTER"),
                    ("metric_groups", "ENGAGEMENT,BILLING"),
                ],
            )
            .await?;
        for row in answer["data"].as_array().into_iter().flatten() {
            let Some(ad) = text(&row["id"]).and_then(|id| owners.get(&id)) else {
                continue;
            };
            let metrics = &row["id_data"][0]["metrics"];
            let mut at = from;
            let mut n = 0;
            while at <= last {
                let seen = Sum {
                    micro: nth(metrics, "billed_charge_local_micro", n)?,
                    impressions: nth(metrics, "impressions", n)?,
                    // Every click on the post, as X counts them.
                    clicks: nth(metrics, "clicks", n)?,
                    // What the campaign is for: a click on the card's link.
                    visits: nth(metrics, "url_clicks", n)?,
                };
                if seen.micro.is_some() || seen.impressions.is_some() || seen.clicks.is_some() {
                    sums.entry((ad.clone(), at)).or_default().add(&seen);
                }
                n += 1;
                match at.next_day() {
                    Some(next) => at = next,
                    None => break,
                }
            }
        }
    }
    Ok(sums)
}

pub(crate) async fn ad_days(
    c: &XConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
    objective: AdObjective,
    since: Date,
    until: Date,
) -> Result<Vec<AdDay>, ConnectorError> {
    let account = account_of(public)?;
    let campaign = owned_campaign(campaign_id, &account)?;
    if objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "an X campaign here brings visits to a website only",
        ));
    }
    let token = token_of(cred, "read a campaign's numbers")?;
    let facts = c.ad_account(token, &account).await?;
    let exponent = exponent(&facts.currency)?;
    // A line item somebody deleted spent what it spent.
    let lines = lines_of(c, token, &account, campaign, true).await?;
    // Each promotion X ever held, with the ad it belongs to.
    let mut owners: BTreeMap<String, String> = BTreeMap::new();
    for row in all_promotions(c, token, &account, &lines).await? {
        if let (Some(id), Some(line), Some(tweet)) = (
            text(&row["id"]).filter(|id| word(id)),
            text(&row["line_item_id"]).filter(|id| word(id)),
            text(&row["tweet_id"]).filter(|id| digits(id)),
        ) {
            owners.insert(id, ad_id(&account, &line, &tweet));
        }
    }
    // X reads a day as the ads account's own, midnight to midnight in its time zone, while the
    // days asked for are days of UTC. The account's day can be the one before the first (west
    // of UTC) or the one after the last (east of it, where today begins hours before UTC's):
    // one more day is read at each end, so that what is spent in those hours is not read a day
    // late. On X this reading is what stops a campaign at its budget.
    let first = since.previous_day().unwrap_or(since);
    let end = until.next_day().unwrap_or(until);
    let mut sums = Sums::new();
    let mut from = first;
    while from <= end {
        // The analytics take a week at most.
        let last = from
            .checked_add(Duration::days(STATS_DAYS - 1))
            .map_or(end, |day| day.min(end));
        let read = match week(c, token, &account, &owners, from, last).await {
            // X may not take a day that has begun nowhere yet: then the range without it.
            Err(e) if e.kind() == "permanent" && last > until => {
                if from > until {
                    break;
                }
                week(c, token, &account, &owners, from, until).await?
            }
            other => other?,
        };
        for (key, seen) in read {
            sums.entry(key).or_default().add(&seen);
        }
        match last.next_day() {
            Some(next) => from = next,
            None => break,
        }
    }
    let mut days = Vec::new();
    for ((ad, day), sum) in sums {
        // A day outside the ones asked for is told only when something happened on it.
        if (day < since || day > until) && sum.nothing() {
            continue;
        }
        let spend_minor = match sum.micro {
            Some(micro) => Some(
                minor_of(micro, exponent)
                    .ok_or_else(|| ConnectorError::permanent("X's spend is not an amount"))?,
            ),
            None => None,
        };
        days.push(AdDay {
            ad_id: ad,
            day,
            spend_minor,
            impressions: sum.impressions,
            clicks: sum.clicks,
            results: sum.visits,
        });
    }
    Ok(days)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_their_ads_account_and_kind_or_are_nothing() {
        assert_eq!(
            campaign_id("18ce54d4x5t", "hwtbm"),
            "xa:18ce54d4x5t:campaign:hwtbm"
        );
        assert_eq!(
            parse("xa:18ce54d4x5t:campaign:hwtbm"),
            Some(("18ce54d4x5t", Entity::Campaign("hwtbm")))
        );
        assert_eq!(
            parse("xa:18ce54d4x5t:line:8v7jo"),
            Some(("18ce54d4x5t", Entity::Line("8v7jo")))
        );
        assert_eq!(
            parse(&ad_id("18ce54d4x5t", "8v7jo", "822333526255120384")),
            Some((
                "18ce54d4x5t",
                Entity::Ad {
                    line: "8v7jo",
                    tweet: "822333526255120384"
                }
            ))
        );
        for bad in [
            "",
            "hwtbm",
            "xa:18ce54d4x5t:campaign",
            "xa:18ce54d4x5t:campaign:hw/tbm",
            "xa:18CE:campaign:hwtbm",
            "xa:18ce54d4x5t:ad:8v7jo",
            "xa:18ce54d4x5t:ad:8v7jo:notanumber",
            "xa:18ce54d4x5t:creative:1",
            "tt:1:campaign:1",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        assert_eq!(
            owned_campaign("xa:18ce54d4x5t:campaign:hwtbm", "18ce54d4x5t").unwrap(),
            "hwtbm"
        );
        assert_eq!(
            owned_campaign("xa:other:campaign:hwtbm", "18ce54d4x5t")
                .unwrap_err()
                .reason(),
            Some("the object is of another X ads account")
        );
        assert!(owned_line("xa:18ce54d4x5t:campaign:hwtbm", "18ce54d4x5t").is_err());
    }

    #[test]
    fn budgets_go_out_in_micros_and_spend_comes_back_as_minor_units() {
        assert_eq!(micros(10_000, 2).unwrap(), "100000000");
        assert_eq!(micros(550, 2).unwrap(), "5500000");
        assert_eq!(micros(1_500, 0).unwrap(), "1500000000");
        assert!(micros(0, 2).is_err());
        assert_eq!(minor_of(5_500_000, 2), Some(550));
        assert_eq!(minor_of(5_504_999, 2), Some(550));
        assert_eq!(minor_of(5_505_000, 2), Some(551));
        assert_eq!(minor_of(0, 2), Some(0));
        assert_eq!(minor_of(-1, 2), None);
    }

    #[test]
    fn a_moment_is_written_in_utc_as_the_ads_api_takes_it() {
        let at = time::macros::datetime!(2026-11-12 01:30:05 +03:00);
        assert_eq!(moment(at).unwrap(), "2026-11-11T22:30:05Z");
    }

    #[test]
    fn a_promotion_stands_as_x_says() {
        let row = |entity: &str, approval: &str| json!({"entity_status": entity, "approval_status": approval});
        for (entity, approval, expected) in [
            ("ACTIVE", "ACCEPTED", ProviderAdStatus::Active),
            ("ACTIVE", "PENDING", ProviderAdStatus::InReview),
            ("ACTIVE", "", ProviderAdStatus::InReview),
            ("ACTIVE", "REJECTED", ProviderAdStatus::Disapproved),
            ("PAUSED", "ACCEPTED", ProviderAdStatus::Paused),
            (
                "ACTIVE",
                "SOMETHING_NEW",
                ProviderAdStatus::Other("SOMETHING_NEW".into()),
            ),
        ] {
            assert_eq!(
                promotion_status(&row(entity, approval)),
                expected,
                "{entity} {approval}"
            );
        }
    }

    #[test]
    fn media_keys_and_cards_are_known_by_their_shape() {
        assert!(media_key("3_966947208837742592"));
        assert!(media_key("13_1880028106020515840"));
        for bad in ["", "966947208837742592", "3_", "_9", "3_9a", "3_9_1"] {
            assert!(!media_key(bad), "{bad}");
        }
        assert_eq!(
            card_uri(&json!("card://1321554298900107264")).as_deref(),
            Some("card://1321554298900107264")
        );
        for bad in [
            json!("inline"),
            json!("card://"),
            json!("card://x"),
            json!(null),
        ] {
            assert_eq!(card_uri(&bad), None, "{bad}");
        }
    }

    #[test]
    fn a_metric_is_one_number_per_day_or_nothing() {
        let metrics = json!({"impressions": [10, null, 30], "clicks": null,
            "billed_charge_local_micro": [5_500_000]});
        assert_eq!(nth(&metrics, "impressions", 0).unwrap(), Some(10));
        assert_eq!(nth(&metrics, "impressions", 1).unwrap(), None);
        assert_eq!(nth(&metrics, "impressions", 5).unwrap(), None);
        assert_eq!(nth(&metrics, "clicks", 0).unwrap(), None);
        assert_eq!(nth(&metrics, "missing", 0).unwrap(), None);
        assert!(nth(&json!({"impressions": 4}), "impressions", 0).is_err());
        assert_eq!(added(None, None), None);
        assert_eq!(added(Some(2), None), Some(2));
        assert_eq!(added(Some(2), Some(3)), Some(5));
    }
}
