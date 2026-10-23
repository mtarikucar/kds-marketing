//! Public counters of posts and of the account (see the crate docs, "Counters").

use std::collections::BTreeMap;

use jt_app::ports::connectors::{AccountMetrics, PostMetrics};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;

use crate::XConnector;
use crate::account::me;
use crate::client::{Auth, Body, Endpoint, missing};
use crate::credential::{kind_of, token_of};
use crate::publish::post_id;

/// Every whole-number field of `object["public_metrics"]`, by X's name; `Permanent` when the
/// answer has none.
fn counters(object: &Value) -> Result<BTreeMap<String, i64>, ConnectorError> {
    let metrics = object["public_metrics"]
        .as_object()
        .ok_or_else(|| missing("public metrics"))?;
    Ok(metrics
        .iter()
        .filter_map(|(name, value)| value.as_i64().map(|v| (name.clone(), v)))
        .collect())
}

/// The counters of post `post_id`.
pub(crate) async fn post_metrics(
    connector: &XConnector,
    cred: &Credential,
    public: &Value,
    post: &str,
) -> Result<PostMetrics, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read counters")?;
    let id = post_id(post)?;
    let url = connector.api_url(&["2", "tweets", id], &[("tweet.fields", "public_metrics")]);
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Api,
        )
        .await?;
    Ok(PostMetrics {
        metrics: counters(&answer["data"])?,
    })
}

/// The counters of the account itself.
pub(crate) async fn account_metrics(
    connector: &XConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AccountMetrics, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read counters")?;
    let me = me(connector, token, Some("public_metrics")).await?;
    Ok(AccountMetrics {
        metrics: counters(&me)?,
    })
}
