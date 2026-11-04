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
//! | any | Instagram Login token | `GET graph.instagram.com/me?fields=user_id,username` | the token's own account (`user_id`); `insights`: whether the grant holds `instagram_business_manage_insights` |
//! | `whatsapp_cloud` | WhatsApp Cloud | `GET /{phone_number_id}?fields=id,verified_name,quality_rating,display_phone_number` | the number, as Graph names it |
//! | `meta_ads` | user token | `GET /act_{external_id}?fields=id,account_id,name,account_status,currency` | the ad account's number, without `act_` |
//! | others | user token | `GET /me?fields=id,name` | the user (the token's own identity) |
//!
//! A WhatsApp number and an ad account are not a token's own identity, so the id the probe asks
//! about comes from the credential (the number) or `public["external_id"]` (the ad account):
//! Graph serves those nodes only to a token with access to them (neither is public), so the
//! answer's id proves the token reaches that account. A Page, which Graph serves to anyone, is
//! always read as `/me`. A Page's probe also reads `/me/subscribed_apps` (best effort) and reports
//! whether the platform app is subscribed (`subscribed`). A `facebook_page` or `instagram`
//! capability whose grant enables comments also reports what it allows on them (`comments`).
//!
//! An ad account without `public["external_id"]` is the token's only active ad account, when it
//! has exactly one; otherwise the probe fails `Permanent` ("name the ad account").
//!
//! The kind is never guessed: without a Meta kind in `public["kind_key"]`, the probe and the
//! connection step fail `Permanent` ("kind_key missing") and call nothing.

use std::time::Instant;

use jt_app::ports::connectors::OAuthFlow;
use jt_app::usecases::webhook::META_HOOK_PATH;
use jt_connector::{ConnectorError, Credential, ProbeResult, comment_grant};
use jt_outbound::Method;
use serde_json::{Map, Value, json};

use crate::MetaConnector;
use crate::assets::ad_account_number;
use crate::credential::{MetaCred, account_of, granted_scopes, kind_of};
use crate::graph::{Auth, Body, GraphApp, integer, missing, node, text};
use crate::oauth::{
    INSTAGRAM_COMMENT_FIELDS, INSTAGRAM_INSIGHTS_SCOPE, LEADS_RETRIEVAL, PAGE_FEED_FIELD,
    PAGE_LEADGEN_FIELD, PAGE_MESSAGING_FIELDS,
};

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = facts(connector, cred, public)
        .await
        .map(|facts| with_comment_facts(facts, cred, public));
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

/// `facts` with, for a `facebook_page` or `instagram` capability whose grant enables comments,
/// what it allows on them (`comments: {read, reply, hide, delete_others, private_reply}`); as they
/// were otherwise.
fn with_comment_facts(mut facts: Value, cred: &Credential, public: &Value) -> Value {
    let Ok(kind @ ("facebook_page" | "instagram")) = kind_of(public) else {
        return facts;
    };
    let grant = comment_grant(kind, &granted_scopes(cred, public));
    if let (true, Value::Object(map)) = (grant.enabled(), &mut facts) {
        map.insert(
            "comments".into(),
            json!({
                "read": grant.read,
                "reply": grant.reply,
                "hide": grant.hide,
                "delete_others": grant.delete_others,
                "private_reply": grant.private_reply,
            }),
        );
    }
    facts
}

/// The facts of a successful probe (see the module docs).
async fn facts(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let kind = kind_of(public)?;
    let insights = matches!(cred, Credential::OAuth { scopes, .. }
        if scopes.iter().any(|s| s == INSTAGRAM_INSIGHTS_SCOPE));
    let cred = MetaCred::of(cred, "be probed")?;
    if let MetaCred::Instagram { token } = cred {
        let me = connector
            .instagram_get(token, &["me"], &[("fields", "user_id,username")])
            .await?;
        let id = text(&me["user_id"])
            .or_else(|| text(&me["id"]))
            .ok_or_else(|| missing("Instagram account id"))?;
        // Whether the grant reads the account's insights (an Instagram Login grant of before
        // spec D29 does not: reconnecting asks for them).
        return Ok(json!({ "account_id": id, "username": me["username"], "insights": insights }));
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
///   subscription) to [`PAGE_MESSAGING_FIELDS`], to [`PAGE_LEADGEN_FIELD`] too when the grant
///   holds [`LEADS_RETRIEVAL`] ([`grants_leads`]) and to [`PAGE_FEED_FIELD`] when it enables
///   comments: one union, whatever kind asks ([`subscribe_page`]). Meta refuses the whole
///   subscription when one field lacks its permission, so a refusal naming an optional field
///   ([`refuses_field`]) is asked again without it: the messages arrive whatever becomes of the
///   leads and comments. Any other failure is the error;
/// - `instagram` with an Instagram Login token whose grant enables comments: subscribes the
///   account to its comments ([`subscribe_instagram`]), best effort;
/// - `whatsapp_cloud`: subscribes the WhatsApp Business Account when its id is known
///   (`POST /{waba}/subscribed_apps`); once subscribed, sends that account's webhooks to this
///   instance ([`override_callback`]: Meta's webhook override,
///   <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/>,
///   so each deployment receives the events of its own customers' accounts whatever the app's
///   callback URL is); asks whether the number is on the WhatsApp Business app
///   ([`on_business_app`]); and registers the number for the Cloud API
///   (`POST /{phone_number_id}/register`) only when it is not on the app: as Graph says, or, when
///   Graph does not tell, unless it was connected through the WhatsApp Business app's sign-in
///   (`public["asset"]["onboarding"]`), since Meta's onboarding page says to skip registering
///   such a number. Each step best effort; reports
///   `{"subscribed": bool, "callback_override": bool, "on_business_app": bool or null,
///   "registered": bool}`;
/// - any other Meta kind: nothing (`Null`);
/// - no Meta kind in `public["kind_key"]`: `Permanent` ("kind_key missing"), nothing called.
pub(crate) async fn on_connected(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let kind = kind_of(public)?;
    let leads = grants_leads(cred, public);
    let scopes = granted_scopes(cred, public);
    // One subscription for the page, whatever kind asks: the same union from the same grant.
    let feed = comment_grant("facebook_page", &scopes).enabled();
    let cred = MetaCred::of(cred, "be connected")?;
    match (kind, cred) {
        ("facebook_page" | "messenger" | "instagram_dm", MetaCred::Page { page_id, token }) => {
            subscribe_page(connector, node(page_id)?, token, leads, feed).await
        }
        ("facebook_page" | "messenger" | "instagram_dm", MetaCred::User { token }) => {
            subscribe_page(connector, "me", token, leads, feed).await
        }
        ("instagram", MetaCred::Instagram { token }) => {
            subscribe_instagram(connector, public, token, &scopes).await
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
            let callback_override = match waba_id {
                Some(waba) if subscribed => override_callback(connector, &app, waba, token).await,
                _ => false,
            };
            let on_business_app = on_business_app(connector, &app, phone_number_id, token).await;
            // Meta's own answer wins: a number it says is not on the app is registered, however
            // it was connected; one it says nothing about is registered unless it came through
            // the app's sign-in.
            let through_app = public["asset"]["onboarding"] == OAuthFlow::WhatsappBusinessApp.key();
            let on_app = match on_business_app {
                Some(known) => known,
                None => through_app,
            };
            let registered = if on_app {
                false
            } else {
                connector
                    .graph_post(
                        &app,
                        token,
                        &[node(phone_number_id)?, "register"],
                        &[],
                        json!({ "messaging_product": "whatsapp", "pin": "000000" }),
                    )
                    .await
                    .map_err(|e| {
                        tracing::warn!(error_kind = e.kind(), "WhatsApp registration failed")
                    })
                    .is_ok()
            };
            Ok(json!({
                "subscribed": subscribed,
                "callback_override": callback_override,
                "on_business_app": on_business_app,
                "registered": registered,
            }))
        }
        _ => Ok(Value::Null),
    }
}

/// The longest override callback URI Meta takes (its webhook override page: at most 200
/// characters).
const MAX_OVERRIDE_URI_CHARS: usize = 200;

/// Sends the WhatsApp Business Account `waba`'s webhooks to this instance (see
/// [`on_connected`]): `POST /{waba}/subscribed_apps` with `override_callback_uri` = the platform's
/// public base URL (its path kept, without a trailing slash) followed by the Meta hook path, and
/// `verify_token` = the Meta app's verify token (which `GET /hooks/meta` answers Meta's challenge
/// for), sent as form fields so that neither is repeated in a refusal's reason. Best effort:
/// `false`, logged, when there is no public base URL or verify token, when the URI is longer
/// than Meta takes, or when Meta refuses.
async fn override_callback(
    connector: &MetaConnector,
    app: &GraphApp,
    waba: &str,
    token: &str,
) -> bool {
    let Some(mut uri) = connector.apps.public_base_url() else {
        tracing::warn!("no public base URL: the WhatsApp webhooks keep the app's callback");
        return false;
    };
    let verify_token = match connector.meta_app() {
        Ok(meta) if !meta.verify_token.trim().is_empty() => meta.verify_token,
        _ => {
            tracing::warn!("no verify token: the WhatsApp webhooks keep the app's callback");
            return false;
        }
    };
    let base = uri.path().trim_end_matches('/').to_owned();
    uri.set_path(&format!("{base}{META_HOOK_PATH}"));
    uri.set_query(None);
    uri.set_fragment(None);
    let uri = uri.to_string();
    if uri.chars().count() > MAX_OVERRIDE_URI_CHARS {
        tracing::warn!(
            "the webhook address is longer than Meta takes: the WhatsApp webhooks keep the app's callback"
        );
        return false;
    }
    let Ok(waba) = node(waba) else {
        return false;
    };
    let url = connector.graph_url(&app.version, &[waba, "subscribed_apps"], &[]);
    let form = vec![
        ("override_callback_uri".to_owned(), uri),
        ("verify_token".to_owned(), verify_token),
    ];
    match connector
        .call(Method::POST, url, app.auth(token), Body::Form(form))
        .await
    {
        Ok(answer) if answer["success"] != false => true,
        Ok(_) => {
            tracing::warn!("Meta did not accept the WhatsApp webhook override");
            false
        }
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the WhatsApp webhook override failed"
            );
            false
        }
    }
}

/// Whether the WhatsApp number `phone_number_id` is on the WhatsApp Business app (Meta's
/// onboarding page: `GET /{phone_number_id}?fields=is_on_biz_app,platform_type`, `true` once it
/// is onboarded beside the app); `None` when Graph does not tell.
async fn on_business_app(
    connector: &MetaConnector,
    app: &GraphApp,
    phone_number_id: &str,
    token: &str,
) -> Option<bool> {
    let number = node(phone_number_id).ok()?;
    match connector
        .graph_get(
            app,
            token,
            &[number],
            &[("fields", "is_on_biz_app,platform_type")],
        )
        .await
    {
        Ok(answer) => answer["is_on_biz_app"].as_bool(),
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "whether a WhatsApp number is on the business app could not be read"
            );
            None
        }
    }
}

/// Whether the grant behind `cred` holds [`LEADS_RETRIEVAL`]: a Facebook Login token's own
/// scopes; a Page token's are those of the grant it came from, which the use cases record with it
/// in `public["access"]["scopes"]` (written anew with every credential sealed). A pasted token's
/// grant is not known, so it does not hold it; nor do an earlier connection's scopes kept in
/// `public["asset"]`, which outlive the token they came with.
fn grants_leads(cred: &Credential, public: &Value) -> bool {
    granted_scopes(cred, public).contains(&LEADS_RETRIEVAL)
}

/// Whether `e` is Meta refusing the optional webhook field `field` for want of its permission: a
/// `Permission` error whose reason names the field (Graph `(#200) To subscribe to the leadgen
/// field, one of these permissions is needed: leads_retrieval`); for the lead-gen field, one
/// naming [`PAGE_LEADGEN_FIELD`] or [`LEADS_RETRIEVAL`] anywhere.
fn refuses_field(e: &ConnectorError, field: &str) -> bool {
    let ConnectorError::Permission { reason, .. } = e else {
        return false;
    };
    if field == PAGE_LEADGEN_FIELD {
        return reason.contains(PAGE_LEADGEN_FIELD) || reason.contains(LEADS_RETRIEVAL);
    }
    reason.contains(&format!("the {field} field"))
}

/// Subscribes `page` (an id, or `me` for the token's own page) to the platform app's webhooks:
/// [`PAGE_MESSAGING_FIELDS`], with its lead-gen submissions when `leads` and its feed (comments)
/// when `feed` (see [`on_connected`]). A refusal naming one of the optional fields drops it and
/// asks again; any other failure is the error. Reports `{"subscribed": true, "leadgen": bool}`,
/// with `"feed": bool` when it was asked for.
async fn subscribe_page(
    connector: &MetaConnector,
    page: &str,
    token: &str,
    leads: bool,
    feed: bool,
) -> Result<Value, ConnectorError> {
    let app = connector.graph_app()?;
    let mut optional: Vec<&str> = Vec::new();
    if leads {
        optional.push(PAGE_LEADGEN_FIELD);
    }
    if feed {
        optional.push(PAGE_FEED_FIELD);
    }
    loop {
        let fields = std::iter::once(PAGE_MESSAGING_FIELDS)
            .chain(optional.iter().copied())
            .collect::<Vec<_>>()
            .join(",");
        match subscribe_fields(connector, &app, page, token, &fields).await {
            Ok(()) => break,
            Err(e) => match optional.iter().position(|field| refuses_field(&e, field)) {
                Some(refused) => {
                    tracing::warn!(
                        error_kind = e.kind(),
                        field = optional[refused],
                        "Meta refused a webhook field; the page is subscribed without it"
                    );
                    optional.remove(refused);
                }
                None => return Err(e),
            },
        }
    }
    let mut facts = json!({
        "subscribed": true,
        "leadgen": optional.contains(&PAGE_LEADGEN_FIELD),
    });
    if feed {
        facts["feed"] = json!(optional.contains(&PAGE_FEED_FIELD));
    }
    Ok(facts)
}

/// Subscribes an Instagram Login account to its comments (and, with
/// `instagram_business_manage_messages`, its messages) when its grant enables comments:
/// `POST graph.instagram.com/{account}/subscribed_apps?subscribed_fields=...` (Meta's Instagram
/// webhook setup, <https://developers.facebook.com/documentation/instagram-platform/webhooks/setup>).
/// Best effort: `{"subscribed": bool}`, a failure logged; without the grant nothing is asked
/// (`Null`).
async fn subscribe_instagram(
    connector: &MetaConnector,
    public: &Value,
    token: &str,
    scopes: &[&str],
) -> Result<Value, ConnectorError> {
    if !comment_grant("instagram", scopes).enabled() {
        return Ok(Value::Null);
    }
    let account = match account_of(public) {
        Some(account) => node(account)?,
        None => "me",
    };
    let mut fields = INSTAGRAM_COMMENT_FIELDS.to_owned();
    if scopes.contains(&"instagram_business_manage_messages") {
        fields.push_str(",messages");
    }
    let url = connector.instagram_url(
        &[account, "subscribed_apps"],
        &[("subscribed_fields", &fields)],
    );
    let subscribed = match connector
        .call(Method::POST, url, Auth::Bearer(token), Body::Empty)
        .await
    {
        Ok(answer) => answer["success"] != false,
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the Instagram comment subscription failed"
            );
            false
        }
    };
    Ok(json!({ "subscribed": subscribed }))
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
