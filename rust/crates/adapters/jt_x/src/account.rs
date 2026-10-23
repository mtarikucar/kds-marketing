//! The account behind a credential (`GET /2/users/me`): the asset an OAuth flow offers, and the
//! probe.

use std::time::Instant;

use jt_app::ports::connectors::Asset;
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Map, Value, json};

use crate::XConnector;
use crate::client::{Auth, Body, Endpoint, missing, text};
use crate::credential::{kind_of, token_of};

/// The account `token` authenticates as: the `data` of `GET /2/users/me`, with the user fields
/// `fields` when given.
pub(crate) async fn me(
    connector: &XConnector,
    token: &str,
    fields: Option<&str>,
) -> Result<Value, ConnectorError> {
    let query: Vec<(&str, &str)> = fields.map(|f| ("user.fields", f)).into_iter().collect();
    let url = connector.api_url(&["2", "users", "me"], &query);
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Api,
        )
        .await?;
    match answer.get("data") {
        Some(data) if data.is_object() => Ok(data.clone()),
        _ => Err(missing("account")),
    }
}

/// The one account an X credential reaches, as the asset kind `x`: its id, `@username` as its
/// name, and its username and display name as public facts.
pub(crate) async fn list_assets(
    connector: &XConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list accounts")?;
    let me = me(connector, token, None).await?;
    let id = text(&me["id"]).ok_or_else(|| missing("account id"))?;
    let username = text(&me["username"]);
    let mut public = Map::new();
    if let Some(username) = &username {
        public.insert("username".to_owned(), json!(username));
    }
    if let Some(name) = text(&me["name"]) {
        public.insert("name".to_owned(), json!(name));
    }
    Ok(vec![Asset {
        kind_key: "x".to_owned(),
        name: username.map_or_else(|| id.clone(), |u| format!("@{u}")),
        external_id: id,
        credential: cred.clone(),
        public: Value::Object(public),
    }])
}

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &XConnector,
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

/// `{account_id, username}` of the account the credential itself authenticates as (never the id
/// `public` claims).
async fn facts(
    connector: &XConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "be probed")?;
    let me = me(connector, token, None).await?;
    let id = text(&me["id"]).ok_or_else(|| missing("account id"))?;
    Ok(json!({ "account_id": id, "username": text(&me["username"]) }))
}
