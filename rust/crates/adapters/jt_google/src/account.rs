//! The Google Ads accounts of a sign-in: listing them, reading one's facts, the probe, and the
//! search call every read goes through.

use std::time::Instant;

use jt_app::ports::connectors::Asset;
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Value, json};

use crate::client::{Auth, Body, Endpoint, missing, text};
use crate::{GoogleConnector, MAX_ACCOUNTS, MAX_PAGES};

/// The one kind Google serves.
pub(crate) const KIND: &str = "google_ads";

/// What a probe of an account that is not enabled says.
const NOT_ENABLED: &str = "the Google Ads account is not enabled";

/// `id` as a customer id: 1 to 12 digits, hyphens (as the Google Ads screens write it) dropped;
/// `None` for anything else, so that it can never change the path or the query it is put in.
pub(crate) fn customer_id(id: &str) -> Option<String> {
    let digits: String = id.trim().chars().filter(|c| *c != '-').collect();
    (!digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then_some(digits)
}

/// The customer id of the capability whose public fields are `public`; `Permanent` for another
/// kind or a malformed id.
pub(crate) fn account_of(public: &Value) -> Result<String, ConnectorError> {
    match public["kind_key"].as_str() {
        Some(KIND) => {}
        Some(_) => return Err(ConnectorError::permanent("not a Google Ads account")),
        None => return Err(ConnectorError::permanent("kind_key missing")),
    }
    public["external_id"]
        .as_str()
        .and_then(customer_id)
        .ok_or_else(|| ConnectorError::permanent("the Google Ads customer id is missing"))
}

/// What Google says of one account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Customer {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    pub(crate) currency: String,
    pub(crate) time_zone: String,
    pub(crate) status: String,
    pub(crate) manager: bool,
    pub(crate) test_account: bool,
}

impl Customer {
    /// Whether campaigns can be built in the account: it is enabled, or it is a test account,
    /// which Google reports as `CLOSED` ("Test account will also have CLOSED status") although
    /// the API works on it.
    pub(crate) fn usable(&self) -> bool {
        self.status == "ENABLED" || (self.test_account && self.status == "CLOSED")
    }
}

impl GoogleConnector {
    /// Every row of `query` on customer `customer`, read page by page (at most [`MAX_PAGES`]
    /// pages; an answer that still has more is refused rather than cut short).
    pub(crate) async fn search(
        &self,
        token: &str,
        customer: &str,
        query: &str,
    ) -> Result<Vec<Value>, ConnectorError> {
        let url = self.api_url(&["customers", customer, "googleAds:search"]);
        let mut rows = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut body = json!({ "query": query });
            if let Some(page_token) = &page_token {
                body["pageToken"] = json!(page_token);
            }
            let answer = self
                .call(
                    Method::POST,
                    url.clone(),
                    Auth::Bearer(token),
                    &Body::Json(body),
                    Endpoint::Read,
                )
                .await?;
            match &answer["results"] {
                Value::Array(results) => rows.extend(results.iter().cloned()),
                Value::Null => {}
                _ => return Err(missing("results")),
            }
            match text(&answer["nextPageToken"]) {
                Some(next) => page_token = Some(next),
                None => return Ok(rows),
            }
        }
        Err(ConnectorError::permanent(
            "Google's answer has more pages than are read",
        ))
    }

    /// The facts of customer `customer`, as this token reads them.
    pub(crate) async fn customer(
        &self,
        token: &str,
        customer: &str,
    ) -> Result<Customer, ConnectorError> {
        let rows = self
            .search(
                token,
                customer,
                "SELECT customer.id, customer.descriptive_name, customer.currency_code, \
                 customer.time_zone, customer.status, customer.manager, customer.test_account \
                 FROM customer LIMIT 1",
            )
            .await?;
        let row = rows.first().ok_or_else(|| missing("customer"))?;
        let c = &row["customer"];
        let id = text(&c["id"])
            .and_then(|id| customer_id(&id))
            .ok_or_else(|| missing("customer id"))?;
        // The account the token reads is the one that was asked for, never another.
        if id != customer {
            return Err(ConnectorError::permanent(
                "Google answered for another account",
            ));
        }
        Ok(Customer {
            id,
            name: text(&c["descriptiveName"]),
            currency: text(&c["currencyCode"]).ok_or_else(|| missing("currency"))?,
            time_zone: text(&c["timeZone"]).ok_or_else(|| missing("time zone"))?,
            status: text(&c["status"]).unwrap_or_default(),
            manager: c["manager"].as_bool().unwrap_or(false),
            test_account: c["testAccount"].as_bool().unwrap_or(false),
        })
    }
}

/// The ad accounts the sign-in reaches directly: every accessible customer that is enabled (or
/// is a test account) and is not a manager account, with its currency and time zone. An account whose facts cannot be
/// read (its sign-up is not finished, the user lost access) is left out; a failure that is not
/// the account's (the token, a throttle, the platform's project) fails the listing.
pub(crate) async fn list_assets(
    connector: &GoogleConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = connector.access_token(cred).await?;
    let answer = connector
        .call(
            Method::GET,
            connector.api_url(&["customers:listAccessibleCustomers"]),
            Auth::Bearer(&token),
            &Body::Empty,
            Endpoint::Read,
        )
        .await?;
    let names = match &answer["resourceNames"] {
        Value::Array(names) => names.clone(),
        Value::Null => Vec::new(),
        _ => return Err(missing("resourceNames")),
    };
    let ids: Vec<String> = names
        .iter()
        .filter_map(|name| name.as_str()?.strip_prefix("customers/"))
        .filter_map(customer_id)
        .take(MAX_ACCOUNTS)
        .collect();
    let mut assets = Vec::new();
    for id in ids {
        let customer = match connector.customer(&token, &id).await {
            Ok(customer) => customer,
            // This account's own trouble: the others are still offered.
            Err(ConnectorError::Permission { .. }) => continue,
            Err(e) => return Err(e),
        };
        if customer.manager || !customer.usable() {
            continue;
        }
        assets.push(Asset {
            kind_key: KIND.to_owned(),
            name: customer.name.clone().unwrap_or_else(|| customer.id.clone()),
            external_id: customer.id,
            credential: cred.clone(),
            public: json!({
                "currency": customer.currency,
                "time_zone": customer.time_zone,
                "test_account": customer.test_account,
            }),
        });
    }
    Ok(assets)
}

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is a failed probe).
pub(crate) async fn probe(
    connector: &GoogleConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = facts(connector, cred, public).await;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

/// `{account_id, name, currency, time_zone, test_account}` of the account the credential itself
/// reaches (see the crate docs, "The probe").
async fn facts(
    connector: &GoogleConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let wanted = account_of(public)?;
    let token = connector.access_token(cred).await?;
    let customer = connector.customer(&token, &wanted).await?;
    if !customer.usable() {
        return Err(ConnectorError::permission(NOT_ENABLED));
    }
    if customer.manager {
        return Err(ConnectorError::permanent(
            "a manager account holds no campaigns of its own",
        ));
    }
    Ok(json!({
        "account_id": customer.id,
        "name": customer.name,
        "currency": customer.currency,
        "time_zone": customer.time_zone,
        "test_account": customer.test_account,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn customer_ids_are_digits_with_or_without_hyphens() {
        assert_eq!(customer_id("123-456-7890").as_deref(), Some("1234567890"));
        assert_eq!(customer_id(" 42 ").as_deref(), Some("42"));
        for bad in ["", "-", "12a", "1234567890123", "1/2", "customers/1", "1 2"] {
            assert_eq!(customer_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_a_google_ads_capability_names_an_account() {
        let ok = json!({"kind_key":"google_ads","external_id":"123-456-7890"});
        assert_eq!(account_of(&ok).unwrap(), "1234567890");
        for (public, reason) in [
            (
                json!({"kind_key":"meta_ads","external_id":"1"}),
                "not a Google Ads account",
            ),
            (json!({"external_id":"1"}), "kind_key missing"),
            (
                json!({"kind_key":"google_ads"}),
                "the Google Ads customer id is missing",
            ),
            (
                json!({"kind_key":"google_ads","external_id":"1 OR 1=1"}),
                "the Google Ads customer id is missing",
            ),
        ] {
            assert_eq!(account_of(&public).unwrap_err().reason(), Some(reason));
        }
    }
}
