//! Ad budgets and results: an ad account's ad sets (`GET /act_{id}/adsets`), a daily budget
//! (`POST /{entity} {daily_budget}`), and results per campaign and day
//! (`GET /act_{id}/insights?level=campaign&time_increment=1&limit=500`, following `paging.next`).
//!
//! The ad account is `public["external_id"]` (its number, `act_` optional). Budgets are in the
//! account currency's minor units, as Meta takes and gives them; a budget of `0` reads as none.
//! Meta gives `spend` in major units with two decimals: `spend_minor` is it times 100, which is
//! exact for currencies with two decimals (TRY, EUR, USD); currencies with another exponent are
//! M3's to handle.

use jt_app::ports::connectors::{AdInsights, AdSet};
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
    if answer["success"] == false {
        return Err(ConnectorError::permanent(
            "the budget change was not accepted",
        ));
    }
    Ok(())
}

/// A budget in minor units; `0` and an absent one read as none.
fn budget(value: &Value) -> Option<i64> {
    integer(value).filter(|b| *b > 0)
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
                daily_budget_minor: budget(&row["daily_budget"]),
                lifetime_budget_minor: budget(&row["lifetime_budget"]),
            })
        })
        .collect()
}

/// A decimal amount in major units (`"12.34"`, `"12.3"`, `"12"`) as minor units (×100), exactly;
/// `None` for anything else (more than two decimals included).
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
                spend_minor: minor_units(&row["spend"]).unwrap_or(0),
                impressions: integer(&row["impressions"]).unwrap_or(0),
                clicks: integer(&row["clicks"]).unwrap_or(0),
            })
        })
        .collect()
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
