//! The account behind a credential (`GET /v2/user/info/`,
//! <https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info>): the asset an OAuth flow
//! offers, and the probe.

use std::time::Instant;

use jt_app::ports::connectors::Asset;
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Map, Value, json};

use crate::TiktokConnector;
use crate::client::{Auth, Body, Effect, Endpoint, missing, text};
use crate::credential::{kind_of, token_of};
use crate::publish::creator_info;

/// The user fields of the account itself, all under `user.info.basic`.
const IDENTITY_FIELDS: &str = "open_id,display_name";

/// The account `token` authenticates as: the `data.user` of `GET /v2/user/info/?fields=<fields>`.
pub(crate) async fn user_info(
    connector: &TiktokConnector,
    token: &str,
    fields: &str,
) -> Result<Value, ConnectorError> {
    let url = connector.api_url(&["v2", "user", "info", ""], &[("fields", fields)]);
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Api,
            Effect::Read,
        )
        .await?;
    match answer["data"].get("user") {
        Some(user) if user.is_object() => Ok(user.clone()),
        _ => Err(missing("account")),
    }
}

/// The account's username, from `creator_info` (`user/info`'s `username` needs
/// `user.info.profile`, which the app does not ask for); `None` when that call fails, which only
/// leaves the username out.
async fn username(connector: &TiktokConnector, token: &str) -> Option<String> {
    match creator_info(connector, token).await {
        Ok(creator) => creator.username,
        Err(e) => {
            tracing::debug!(
                kind = e.kind(),
                "the TikTok creator info is unavailable; the username is left out"
            );
            None
        }
    }
}

/// The account's `open_id`, `display_name` and (best effort) username.
struct Identity {
    open_id: String,
    display_name: Option<String>,
    username: Option<String>,
}

async fn identity(connector: &TiktokConnector, token: &str) -> Result<Identity, ConnectorError> {
    let user = user_info(connector, token, IDENTITY_FIELDS).await?;
    let open_id = text(&user["open_id"]).ok_or_else(|| missing("open_id"))?;
    Ok(Identity {
        open_id,
        display_name: text(&user["display_name"]),
        username: username(connector, token).await,
    })
}

/// The one account a TikTok credential reaches, as the asset kind `tiktok`: its `open_id`, its
/// display name (else `@username`, else the open id) as its name, and its display name and
/// username as public facts.
pub(crate) async fn list_assets(
    connector: &TiktokConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list accounts")?;
    let me = identity(connector, token).await?;
    let mut public = Map::new();
    if let Some(username) = &me.username {
        public.insert("username".to_owned(), json!(username));
    }
    if let Some(name) = &me.display_name {
        public.insert("display_name".to_owned(), json!(name));
    }
    let name = me
        .display_name
        .clone()
        .or_else(|| me.username.as_ref().map(|u| format!("@{u}")))
        .unwrap_or_else(|| me.open_id.clone());
    Ok(vec![Asset {
        kind_key: "tiktok".to_owned(),
        external_id: me.open_id,
        name,
        credential: cred.clone(),
        public: Value::Object(public),
    }])
}

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &TiktokConnector,
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

/// `{account_id, display_name?, username?}` of the account the credential itself authenticates
/// as (never the id `public` claims).
async fn facts(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "be probed")?;
    let me = identity(connector, token).await?;
    let mut facts = Map::new();
    facts.insert("account_id".to_owned(), json!(me.open_id));
    if let Some(name) = me.display_name {
        facts.insert("display_name".to_owned(), json!(name));
    }
    if let Some(username) = me.username {
        facts.insert("username".to_owned(), json!(username));
    }
    Ok(Value::Object(facts))
}
