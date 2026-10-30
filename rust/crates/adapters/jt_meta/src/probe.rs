//! Probes (read-only) and the connection step (`on_connected`: webhook subscriptions, WhatsApp
//! registration).
//!
//! **Which account a probe names** (`facts.account_id`, see
//! [`jt_app::ports::connectors::Connector::probe`]), by kind and credential:
//!
//! | Kind | Credential | Call | `account_id` |
//! |---|---|---|---|
//! | `facebook_page`, `messenger` | Page or pasted token | `GET /me?fields=id,name` | the page (the token's own identity) |
//! | `instagram`, `instagram_dm` | Page or pasted token | `GET /me?fields=id,instagram_business_account{id,username}` | the Instagram account linked to the token's own page |
//! | any | Instagram Login token | `GET graph.instagram.com/me?fields=user_id,username` | the token's own account (`user_id`) |
//! | `whatsapp_cloud` | WhatsApp Cloud | `GET /{phone_number_id}?fields=id,verified_name,quality_rating,display_phone_number` | the number, as Graph names it |
//! | `meta_ads` | user token | `GET /act_{external_id}?fields=id,account_id,name,account_status,currency` | the ad account's number, without `act_` |
//! | others | user token | `GET /me?fields=id,name` | the user (the token's own identity) |
//!
//! A WhatsApp number and an ad account are not a token's own identity, so the id the probe asks
//! about comes from the credential (the number) or `public["external_id"]` (the ad account):
//! Graph serves those nodes only to a token with access to them (neither is public), so the
//! answer's id proves the token reaches that account. A Page, which Graph serves to anyone, is
//! always read as `/me`. A Page's probe also reads `/me/subscribed_apps` (best effort) and reports
//! whether the platform app is subscribed (`subscribed`).
//!
//! An ad account without `public["external_id"]` is the token's only active ad account, when it
//! has exactly one; otherwise the probe fails `Permanent` ("name the ad account").
//!
//! The kind is never guessed: without a Meta kind in `public["kind_key"]`, the probe and the
//! connection step fail `Permanent` ("kind_key missing") and call nothing.

use std::time::Instant;

use jt_connector::{ConnectorError, Credential, ProbeResult};
use serde_json::{Map, Value, json};

use crate::MetaConnector;
use crate::assets::ad_account_number;
use crate::credential::{MetaCred, account_of, kind_of};
use crate::graph::{GraphApp, integer, missing, node, text};
use crate::oauth::{LEADS_RETRIEVAL, PAGE_LEADGEN_FIELD, PAGE_MESSAGING_FIELDS};

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &MetaConnector,
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

/// The facts of a successful probe (see the module docs).
async fn facts(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let kind = kind_of(public)?;
    let cred = MetaCred::of(cred, "be probed")?;
    if let MetaCred::Instagram { token } = cred {
        let me = connector
            .instagram_get(token, &["me"], &[("fields", "user_id,username")])
            .await?;
        let id = text(&me["user_id"])
            .or_else(|| text(&me["id"]))
            .ok_or_else(|| missing("Instagram account id"))?;
        return Ok(json!({ "account_id": id, "username": me["username"] }));
    }
    let app = connector.graph_app()?;
    match (cred, kind) {
        (
            MetaCred::WhatsApp {
                phone_number_id,
                token,
                ..
            },
            _,
        ) => {
            let number = connector
                .graph_get(
                    &app,
                    token,
                    &[node(phone_number_id)?],
                    &[(
                        "fields",
                        "id,verified_name,quality_rating,display_phone_number",
                    )],
                )
                .await?;
            let id = text(&number["id"]).ok_or_else(|| missing("phone number id"))?;
            Ok(json!({
                "account_id": id,
                "verified_name": number["verified_name"],
                "quality_rating": number["quality_rating"],
                "display_phone_number": number["display_phone_number"],
            }))
        }
        (_, "instagram" | "instagram_dm") => {
            let me = connector
                .graph_get(
                    &app,
                    cred.token(),
                    &["me"],
                    &[("fields", "id,instagram_business_account{id,username}")],
                )
                .await?;
            let account = &me["instagram_business_account"];
            let id = text(&account["id"]).ok_or_else(|| {
                ConnectorError::permanent("no Instagram account is linked to the page")
            })?;
            Ok(json!({
                "account_id": id,
                "username": account["username"],
                "page_id": text(&me["id"]),
            }))
        }
        (MetaCred::User { token }, "meta_ads") => {
            ad_account_facts(connector, &app, token, account_of(public)).await
        }
        (MetaCred::Page { token, .. } | MetaCred::User { token }, kind) => {
            let me = connector
                .graph_get(&app, token, &["me"], &[("fields", "id,name")])
                .await?;
            let id = text(&me["id"]).ok_or_else(|| missing("account id"))?;
            let mut facts = Map::new();
            facts.insert("account_id".into(), json!(id));
            facts.insert("name".into(), me["name"].clone());
            let page_kind = matches!(kind, "facebook_page" | "messenger");
            if page_kind && let Some(subscribed) = subscribed(connector, &app, token).await {
                facts.insert("subscribed".into(), json!(subscribed));
            }
            Ok(Value::Object(facts))
        }
        // Answered above, before the Meta app is read.
        (MetaCred::Instagram { .. }, _) => Err(ConnectorError::permanent(
            "an Instagram Login token is probed on the Instagram Graph API",
        )),
    }
}

/// Whether the platform app is among the apps `/me/subscribed_apps` lists for the page behind
/// `token`; `None` when that cannot be read (a token without the permission, a user token).
async fn subscribed(connector: &MetaConnector, app: &GraphApp, token: &str) -> Option<bool> {
    let app_id = connector.meta_app().ok()?.app_id;
    let rows = connector
        .graph_pages(app, token, &["me", "subscribed_apps"], &[])
        .await
        .ok()?;
    Some(
        rows.iter()
            .any(|row| text(&row["id"]).as_deref() == Some(app_id.as_str())),
    )
}

/// The facts of the ad account `account` (its number, `act_` optional), or of the token's only
/// active ad account when none is named.
async fn ad_account_facts(
    connector: &MetaConnector,
    app: &GraphApp,
    token: &str,
    account: Option<&str>,
) -> Result<Value, ConnectorError> {
    let account = match account {
        Some(account) => account.strip_prefix("act_").unwrap_or(account).to_owned(),
        None => {
            let rows = connector
                .graph_pages(
                    app,
                    token,
                    &["me", "adaccounts"],
                    &[("fields", "account_id,account_status"), ("limit", "100")],
                )
                .await?;
            let active: Vec<String> = rows
                .iter()
                .filter(|row| integer(&row["account_status"]) == Some(1))
                .filter_map(ad_account_number)
                .collect();
            match active.as_slice() {
                [only] => only.clone(),
                _ => {
                    return Err(ConnectorError::permanent(
                        "name the ad account: the token reaches more than one, or none",
                    ));
                }
            }
        }
    };
    let act = format!("act_{}", node(&account)?);
    let row = connector
        .graph_get(
            app,
            token,
            &[&act],
            &[("fields", "id,account_id,name,account_status,currency")],
        )
        .await?;
    let number = ad_account_number(&row).ok_or_else(|| missing("ad account id"))?;
    Ok(json!({
        "account_id": number,
        "name": row["name"],
        "account_status": row["account_status"],
        "currency": row["currency"],
    }))
}

/// The connection step (see [`jt_app::ports::connectors::Connector::on_connected`]):
/// - `facebook_page`, `messenger`, `instagram_dm` (a Page token, or a pasted one): subscribes the
///   page (`POST /{page}/subscribed_apps`; Instagram messages arrive through the linked page's
///   subscription) to [`PAGE_MESSAGING_FIELDS`], and to [`PAGE_LEADGEN_FIELD`] too when the
///   grant holds [`LEADS_RETRIEVAL`] ([`grants_leads`]), and reports
///   `{"subscribed": true, "leadgen": bool}`. Meta refuses the whole subscription when one field
///   lacks its permission, so a refusal of the lead-gen field ([`refuses_leadgen`]) is asked
///   again once without it (`"leadgen": false`): the messages arrive whatever becomes of the
///   leads. Any other failure is the error;
/// - `whatsapp_cloud`: subscribes the WhatsApp Business Account when its id is known
///   (`POST /{waba}/subscribed_apps`) and registers the number for the Cloud API
///   (`POST /{phone_number_id}/register`), each best effort, and reports
///   `{"subscribed": bool, "registered": bool}`;
/// - any other Meta kind: nothing (`Null`);
/// - no Meta kind in `public["kind_key"]`: `Permanent` ("kind_key missing"), nothing called.
pub(crate) async fn on_connected(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let kind = kind_of(public)?;
    let leads = grants_leads(cred, public);
    let cred = MetaCred::of(cred, "be connected")?;
    match (kind, cred) {
        ("facebook_page" | "messenger" | "instagram_dm", MetaCred::Page { page_id, token }) => {
            subscribe_page(connector, node(page_id)?, token, leads).await
        }
        ("facebook_page" | "messenger" | "instagram_dm", MetaCred::User { token }) => {
            subscribe_page(connector, "me", token, leads).await
        }
        (
            "whatsapp_cloud",
            MetaCred::WhatsApp {
                phone_number_id,
                token,
                waba_id,
            },
        ) => {
            let app = connector.graph_app()?;
            let subscribed = match waba_id {
                Some(waba) => connector
                    .graph_post(
                        &app,
                        token,
                        &[node(waba)?, "subscribed_apps"],
                        &[],
                        json!({}),
                    )
                    .await
                    .map_err(|e| {
                        tracing::warn!(error_kind = e.kind(), "WhatsApp subscription failed")
                    })
                    .is_ok(),
                None => false,
            };
            let registered = connector
                .graph_post(
                    &app,
                    token,
                    &[node(phone_number_id)?, "register"],
                    &[],
                    json!({ "messaging_product": "whatsapp", "pin": "000000" }),
                )
                .await
                .map_err(|e| tracing::warn!(error_kind = e.kind(), "WhatsApp registration failed"))
                .is_ok();
            Ok(json!({ "subscribed": subscribed, "registered": registered }))
        }
        _ => Ok(Value::Null),
    }
}

/// Whether the grant behind `cred` holds [`LEADS_RETRIEVAL`]: a Facebook Login token's own
/// scopes; a Page token's are those of the grant it came from, which the use cases record with it
/// in `public["access"]["scopes"]` (written anew with every credential sealed). A pasted token's
/// grant is not known, so it does not hold it; nor do an earlier connection's scopes kept in
/// `public["asset"]`, which outlive the token they came with.
fn grants_leads(cred: &Credential, public: &Value) -> bool {
    match cred {
        Credential::OAuth { scopes, .. } => scopes.iter().any(|s| s == LEADS_RETRIEVAL),
        _ => public["access"]["scopes"]
            .as_array()
            .is_some_and(|scopes| scopes.iter().any(|s| s.as_str() == Some(LEADS_RETRIEVAL))),
    }
}

/// Whether `e` is Meta refusing the lead-gen field for want of its permission: a `Permission`
/// error whose reason names [`PAGE_LEADGEN_FIELD`] or [`LEADS_RETRIEVAL`] (Graph `(#200) To
/// subscribe to the leadgen field, one of these permissions is needed: leads_retrieval`).
fn refuses_leadgen(e: &ConnectorError) -> bool {
    matches!(
        e,
        ConnectorError::Permission { reason, .. }
            if reason.contains(PAGE_LEADGEN_FIELD) || reason.contains(LEADS_RETRIEVAL)
    )
}

/// Subscribes `page` (an id, or `me` for the token's own page) to the platform app's webhooks,
/// its lead-gen submissions included when `leads` (see [`on_connected`]).
async fn subscribe_page(
    connector: &MetaConnector,
    page: &str,
    token: &str,
    leads: bool,
) -> Result<Value, ConnectorError> {
    let app = connector.graph_app()?;
    if leads {
        let fields = format!("{PAGE_MESSAGING_FIELDS},{PAGE_LEADGEN_FIELD}");
        match subscribe_fields(connector, &app, page, token, &fields).await {
            Ok(()) => return Ok(json!({ "subscribed": true, "leadgen": true })),
            Err(e) if refuses_leadgen(&e) => tracing::warn!(
                error_kind = e.kind(),
                "Meta refused the lead-gen webhook field; the page is subscribed without it"
            ),
            Err(e) => return Err(e),
        }
    }
    subscribe_fields(connector, &app, page, token, PAGE_MESSAGING_FIELDS).await?;
    Ok(json!({ "subscribed": true, "leadgen": false }))
}

/// `POST /{page}/subscribed_apps` with `fields`; an answer saying it did not succeed is
/// `Permanent`.
async fn subscribe_fields(
    connector: &MetaConnector,
    app: &GraphApp,
    page: &str,
    token: &str,
    fields: &str,
) -> Result<(), ConnectorError> {
    let answer = connector
        .graph_post(
            app,
            token,
            &[page, "subscribed_apps"],
            &[("subscribed_fields", fields)],
            json!({}),
        )
        .await?;
    if answer["success"] == false {
        return Err(ConnectorError::permanent(
            "the page subscription was not accepted",
        ));
    }
    Ok(())
}
