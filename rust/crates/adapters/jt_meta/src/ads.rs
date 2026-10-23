//! Ad budgets and results: an ad account's ad sets (`GET /act_{id}/adsets`), a daily budget
//! (`POST /{entity} {daily_budget}`), and results per campaign and day
//! (`GET /act_{id}/insights?level=campaign&time_increment=1&limit=500`, following `paging.next`).
//!
//! The ad account is `public["external_id"]` (its number, `act_` optional). Budgets are in the
//! account currency's minor units, as Meta takes and gives them; a budget of `0` reads as none.
//! Spend uses the verified account currency exponent. Unsupported currencies and malformed
//! money refuse; absent ad-set counters stay absent. Campaign reads require complete counters.

use jt_app::ports::connectors::{AdAccountContext, AdInsights, AdSet, AdSetInsights, AdStatus};
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};
use time::Date;
use time::macros::format_description;

use crate::MetaConnector;
use crate::credential::{MetaCred, account_of};
use crate::graph::{integer, missing, node, text};

/// The fields read for an ad set.
const ADSET_FIELDS: &str = "id,name,status,campaign_id,daily_budget,lifetime_budget";

/// The fields read for a campaign's day.
const INSIGHT_FIELDS: &str = "campaign_id,campaign_name,spend,impressions,clicks,date_start";

/// The user token of an ads credential.
fn ads_token(cred: &Credential) -> Result<&str, ConnectorError> {
    match MetaCred::of(cred, "manage ads")? {
        MetaCred::User { token } => Ok(token),
        _ => Err(ConnectorError::permanent(
            "ads are reached with a user token",
        )),
    }
}

/// `act_<number>` of the capability's ad account.
fn act(public: &Value) -> Result<String, ConnectorError> {
    let account = account_of(public).ok_or_else(|| {
        ConnectorError::permanent("the capability names no ad account (external_id)")
    })?;
    let number = account.strip_prefix("act_").unwrap_or(account);
    Ok(format!("act_{}", node(number)?))
}

/// Sets the daily budget of ad set or campaign `entity_id` to `minor`.
pub(crate) async fn set_daily_budget(
    connector: &MetaConnector,
    cred: &Credential,
    entity_id: &str,
    minor: i64,
) -> Result<(), ConnectorError> {
    if minor <= 0 {
        return Err(ConnectorError::permanent(
            "a daily budget must be above zero",
        ));
    }
    let token = ads_token(cred)?;
    let app = connector.graph_app()?;
    let answer = connector
        .graph_post(
            &app,
            token,
            &[node(entity_id)?],
            &[],
            json!({ "daily_budget": minor }),
        )
        .await?;
    if answer["success"] != true {
        return Err(ConnectorError::permanent(
            "the budget change was not accepted",
        ));
    }
    Ok(())
}

/// A budget in minor units; `0` and an absent one read as none.
fn budget(value: &Value) -> Result<Option<i64>, ConnectorError> {
    Ok(optional_counter(value)?.filter(|b| *b > 0))
}

/// The ad account's ad sets.
pub(crate) async fn list_adsets(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Vec<AdSet>, ConnectorError> {
    let token = ads_token(cred)?;
    let account = act(public)?;
    let app = connector.graph_app()?;
    let rows = connector
        .graph_pages(
            &app,
            token,
            &[&account, "adsets"],
            &[("fields", ADSET_FIELDS), ("limit", "200")],
        )
        .await?;
    rows.iter()
        .map(|row| {
            Ok(AdSet {
                id: text(&row["id"]).ok_or_else(|| missing("ad set id"))?,
                name: row["name"].as_str().unwrap_or_default().to_owned(),
                status: row["status"].as_str().unwrap_or_default().to_owned(),
                campaign_id: text(&row["campaign_id"]),
                daily_budget_minor: budget(&row["daily_budget"])?,
                lifetime_budget_minor: budget(&row["lifetime_budget"])?,
            })
        })
        .collect()
}

/// A decimal amount in major units (`"12.34"`, `"12.3"`, `"12"`) as minor units (×100), exactly;
/// `None` for anything else (more than two decimals included).
#[cfg(test)]
pub(crate) fn minor_units(value: &Value) -> Option<i64> {
    let raw = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let (whole, fraction) = match raw.split_once('.') {
        Some((whole, fraction)) => (whole, fraction),
        None => (raw.as_str(), ""),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if fraction.len() > 2 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let cents = format!("{fraction:0<2}");
    whole
        .parse::<i64>()
        .ok()?
        .checked_mul(100)?
        .checked_add(cents.parse::<i64>().ok()?)
}

/// The ad account's results per campaign and day from `since` to `until`.
pub(crate) async fn insights(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    since: Date,
    until: Date,
) -> Result<Vec<AdInsights>, ConnectorError> {
    if until < since {
        return Err(ConnectorError::permanent("the range ends before it starts"));
    }
    let context = account_context(connector, cred, public).await?;
    let token = ads_token(cred)?;
    let account = act(public)?;
    let app = connector.graph_app()?;
    let day = format_description!("[year]-[month]-[day]");
    let format = |d: Date| {
        d.format(&day)
            .map_err(|_| ConnectorError::permanent("a date cannot be written"))
    };
    let range = json!({ "since": format(since)?, "until": format(until)? }).to_string();
    let rows = connector
        .graph_pages(
            &app,
            token,
            &[&account, "insights"],
            &[
                ("level", "campaign"),
                ("time_increment", "1"),
                ("limit", "500"),
                ("fields", INSIGHT_FIELDS),
                ("time_range", &range),
            ],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let date = row["date_start"]
                .as_str()
                .and_then(|d| Date::parse(d, &day).ok())
                .ok_or_else(|| missing("result date"))?;
            Ok(AdInsights {
                campaign_id: text(&row["campaign_id"]).ok_or_else(|| missing("campaign id"))?,
                campaign_name: row["campaign_name"].as_str().map(str::to_owned),
                date,
                spend_minor: optional_money(&row["spend"], context.minor_unit_exponent)?
                    .ok_or_else(|| missing("spend"))?,
                impressions: optional_counter(&row["impressions"])?
                    .ok_or_else(|| missing("impressions"))?,
                clicks: optional_counter(&row["clicks"])?.ok_or_else(|| missing("clicks"))?,
            })
        })
        .collect()
}

/// Safety pause/resume is a status write, never a zero budget or a create operation.
pub(crate) async fn set_status(
    connector: &MetaConnector,
    cred: &Credential,
    entity_id: &str,
    status: AdStatus,
) -> Result<(), ConnectorError> {
    let token = ads_token(cred)?;
    let app = connector.graph_app()?;
    let status = match status {
        AdStatus::Paused => "PAUSED",
        AdStatus::Active => "ACTIVE",
    };
    let answer = connector
        .graph_post(
            &app,
            token,
            &[node(entity_id)?],
            &[],
            json!({"status":status}),
        )
        .await?;
    if answer["success"] != true {
        return Err(ConnectorError::permanent(
            "the status change was not confirmed",
        ));
    }
    Ok(())
}

/// Explicit supported currency units; unknown currencies refuse instead of assuming cents.
fn exponent(currency: &str) -> Result<u8, ConnectorError> {
    match currency {
        "JPY" | "KRW" | "VND" | "CLP" | "PYG" => Ok(0),
        "TRY" | "EUR" | "USD" | "GBP" | "CAD" | "AUD" | "CHF" => Ok(2),
        _ => Err(ConnectorError::permanent("unsupported ad account currency")),
    }
}
pub(crate) async fn account_context(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AdAccountContext, ConnectorError> {
    let account = act(public)?;
    let app = connector.graph_app()?;
    let row = connector
        .graph_get(
            &app,
            ads_token(cred)?,
            &[&account],
            &[("fields", "account_id,currency,timezone_name")],
        )
        .await?;
    let account_id = text(&row["account_id"]).ok_or_else(|| missing("account id"))?;
    if format!("act_{account_id}") != account {
        return Err(ConnectorError::permanent(
            "ad account does not match capability",
        ));
    }
    let currency = text(&row["currency"]).ok_or_else(|| missing("currency"))?;
    let timezone = text(&row["timezone_name"])
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| missing("account timezone"))?;
    Ok(AdAccountContext {
        account_id,
        minor_unit_exponent: exponent(&currency)?,
        currency,
        timezone,
    })
}

fn optional_counter(value: &Value) -> Result<Option<i64>, ConnectorError> {
    if value.is_null() {
        return Ok(None);
    }
    integer(value)
        .filter(|n| *n >= 0)
        .map(Some)
        .ok_or_else(|| ConnectorError::permanent("invalid ad insight counter"))
}
fn optional_money(value: &Value, exponent: u8) -> Result<Option<i64>, ConnectorError> {
    if value.is_null() {
        return Ok(None);
    }
    let invalid = || ConnectorError::permanent("invalid provider money");
    let raw = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err(invalid()),
    };
    let (whole, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > usize::from(exponent)
    {
        return Err(invalid());
    }
    let factor = 10_i64
        .checked_pow(u32::from(exponent))
        .ok_or_else(invalid)?;
    let whole = whole
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_mul(factor))
        .ok_or_else(invalid)?;
    let fraction = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<i64>()
            .map_err(|_| invalid())?
            .checked_mul(10_i64.pow(u32::from(exponent) - fraction.len() as u32))
            .ok_or_else(invalid)?
    };
    Ok(Some(whole.checked_add(fraction).ok_or_else(invalid)?))
}

pub(crate) async fn adset_insights(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    since: Date,
    until: Date,
) -> Result<Vec<AdSetInsights>, ConnectorError> {
    if until < since {
        return Err(ConnectorError::permanent("the range ends before it starts"));
    }
    let context = account_context(connector, cred, public).await?;
    let account = act(public)?;
    let app = connector.graph_app()?;
    let day = format_description!("[year]-[month]-[day]");
    let range = json!({"since":since.format(&day).map_err(|_| missing("date"))?, "until":until.format(&day).map_err(|_| missing("date"))?}).to_string();
    let rows = connector
        .graph_pages(
            &app,
            ads_token(cred)?,
            &[&account, "insights"],
            &[
                ("level", "adset"),
                ("time_increment", "1"),
                ("limit", "500"),
                (
                    "fields",
                    "account_id,adset_id,campaign_id,date_start,spend,impressions,clicks",
                ),
                ("time_range", &range),
            ],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let account_id =
                text(&row["account_id"]).ok_or_else(|| missing("insight account id"))?;
            if account_id != context.account_id {
                return Err(ConnectorError::permanent("insight account mismatch"));
            }
            let date = row["date_start"]
                .as_str()
                .and_then(|s| Date::parse(s, &day).ok())
                .ok_or_else(|| missing("result date"))?;
            if date < since || date > until {
                return Err(ConnectorError::permanent(
                    "insight date outside requested range",
                ));
            }
            Ok(AdSetInsights {
                account_id,
                adset_id: text(&row["adset_id"]).ok_or_else(|| missing("ad set id"))?,
                campaign_id: text(&row["campaign_id"]),
                date,
                spend_minor: optional_money(&row["spend"], context.minor_unit_exponent)?,
                impressions: optional_counter(&row["impressions"])?,
                clicks: optional_counter(&row["clicks"])?,
            })
        })
        .collect()
}
pub(crate) async fn resolve_adset(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    ad_id: &str,
) -> Result<Option<String>, ConnectorError> {
    let account = act(public)?;
    let app = connector.graph_app()?;
    let row = connector
        .graph_get(
            &app,
            ads_token(cred)?,
            &[node(ad_id)?],
            &[("fields", "account_id,adset_id")],
        )
        .await?;
    let account_id = text(&row["account_id"]).ok_or_else(|| missing("ad account id"))?;
    if format!("act_{account_id}") != account {
        return Err(ConnectorError::permanent("ad belongs to another account"));
    }
    Ok(text(&row["adset_id"]))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::minor_units;

    #[test]
    fn spend_converts_to_minor_units_exactly() {
        for (spend, minor) in [
            (json!("12.34"), Some(1234)),
            (json!("12.3"), Some(1230)),
            (json!("12"), Some(1200)),
            (json!("0.07"), Some(7)),
            (json!(5), Some(500)),
            (json!("1.234"), None),
            (json!("-1"), None),
            (json!("abc"), None),
            (json!(null), None),
        ] {
            assert_eq!(minor_units(&spend), minor, "{spend}");
        }
    }
}
