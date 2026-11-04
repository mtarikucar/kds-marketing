//! What a signed-in account can reach: its Pages (and their Messenger inboxes and linked
//! Instagram accounts), its ad accounts and its WhatsApp numbers; or, for an Instagram Login
//! token, its Instagram account; or, for the WhatsApp Business app's sign-in, the numbers it
//! shared ([`business_app_numbers`]).

use jt_app::ports::connectors::{Asset, OAuthFlow};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::MetaConnector;
use crate::credential::MetaCred;
use crate::graph::{Body, GraphApp, missing, node, text};
use crate::messaging::INSTAGRAM_MESSAGES_SCOPE;

/// The `account_status` of an active ad account.
const ACTIVE_AD_ACCOUNT: i64 = 1;

/// The assets `cred` reaches (see [`jt_app::ports::connectors::OAuthProvider::list_assets`]).
pub(crate) async fn list_assets(
    connector: &MetaConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    match MetaCred::of(cred, "list assets")? {
        MetaCred::Instagram { token } => instagram_login_assets(connector, cred, token).await,
        MetaCred::User { token } => facebook_assets(connector, cred, token).await,
        MetaCred::Page { .. } | MetaCred::WhatsApp { .. } => Err(ConnectorError::permanent(
            "assets are listed with a user token from a sign-in",
        )),
    }
}

/// An Instagram Login token reaches one Instagram professional account: `instagram`, with the
/// token itself, its id being the account's `user_id` (the id webhooks name); and, when the grant
/// holds `instagram_business_manage_messages`, its direct messages as `instagram_dm` (so a
/// private reply's answer has a surface).
async fn instagram_login_assets(
    connector: &MetaConnector,
    cred: &Credential,
    token: &str,
) -> Result<Vec<Asset>, ConnectorError> {
    let me = connector
        .instagram_get(token, &["me"], &[("fields", "user_id,username")])
        .await?;
    let id = text(&me["user_id"])
        .or_else(|| text(&me["id"]))
        .ok_or_else(|| missing("Instagram account id"))?;
    let username = me["username"].as_str().unwrap_or_default().to_owned();
    let messages = matches!(cred, Credential::OAuth { scopes, .. }
        if scopes.iter().any(|s| s == INSTAGRAM_MESSAGES_SCOPE));
    let kinds: &[&str] = if messages {
        &["instagram", "instagram_dm"]
    } else {
        &["instagram"]
    };
    Ok(kinds
        .iter()
        .map(|kind| Asset {
            kind_key: (*kind).into(),
            external_id: id.clone(),
            name: username.clone(),
            credential: cred.clone(),
            public: json!({ "username": username, "login": "instagram" }),
        })
        .collect())
}

/// A Facebook Login user token: Pages, ad accounts, WhatsApp numbers.
async fn facebook_assets(
    connector: &MetaConnector,
    cred: &Credential,
    token: &str,
) -> Result<Vec<Asset>, ConnectorError> {
    let app = connector.graph_app()?;
    let mut assets = pages(connector, &app, token).await?;
    assets.extend(ad_accounts(connector, &app, cred, token).await?);
    assets.extend(whatsapp_numbers(connector, &app, cred, token).await?);
    Ok(assets)
}

/// Whether the part `part` of the listing may be left out after `e`: the user did not grant its
/// permission (or the account has no such thing to list). Every other failure fails the listing.
/// A part left out is logged at `debug`, with the error's kind and its reason (redacted when the
/// error was built), so nothing goes missing without a trace.
fn skippable(e: &ConnectorError, part: &'static str) -> bool {
    let skip = matches!(
        e,
        ConnectorError::Permission { .. } | ConnectorError::Permanent { .. }
    );
    if skip {
        tracing::debug!(
            part,
            error_kind = e.kind(),
            reason = e.reason().unwrap_or_default(),
            "a part of the Meta asset listing was left out"
        );
    }
    skip
}

/// Each Page (`/me/accounts`) as `facebook_page` and `messenger`, with its Page token; and its
/// linked Instagram business account (`/{page}?fields=instagram_business_account{id,username}`,
/// read with the Page token) as `instagram` and `instagram_dm`, with the same Page token.
async fn pages(
    connector: &MetaConnector,
    app: &GraphApp,
    token: &str,
) -> Result<Vec<Asset>, ConnectorError> {
    let rows = connector
        .graph_pages(
            app,
            token,
            &["me", "accounts"],
            &[("fields", "id,name,access_token"), ("limit", "100")],
        )
        .await?;
    let mut assets = Vec::new();
    for row in rows {
        let (Some(page_id), Some(page_token)) = (text(&row["id"]), row["access_token"].as_str())
        else {
            continue;
        };
        let name = row["name"].as_str().unwrap_or_default().to_owned();
        let credential = Credential::PageToken {
            page_id: page_id.clone(),
            token: page_token.to_owned(),
        };
        for kind in ["facebook_page", "messenger"] {
            assets.push(Asset {
                kind_key: kind.into(),
                external_id: page_id.clone(),
                name: name.clone(),
                credential: credential.clone(),
                public: json!({ "page_id": page_id }),
            });
        }
        let linked = connector
            .graph_get(
                app,
                page_token,
                &[node(&page_id)?],
                &[("fields", "instagram_business_account{id,username}")],
            )
            .await;
        let linked = match linked {
            Ok(linked) => linked,
            Err(e) if skippable(&e, "instagram_account") => continue,
            Err(e) => return Err(e),
        };
        let account = &linked["instagram_business_account"];
        let Some(ig_id) = text(&account["id"]) else {
            continue;
        };
        let username = account["username"].as_str().unwrap_or_default().to_owned();
        for kind in ["instagram", "instagram_dm"] {
            assets.push(Asset {
                kind_key: kind.into(),
                external_id: ig_id.clone(),
                name: if username.is_empty() {
                    name.clone()
                } else {
                    username.clone()
                },
                credential: credential.clone(),
                public: json!({ "username": username, "page_id": page_id, "login": "facebook" }),
            });
        }
    }
    Ok(assets)
}

/// Each active ad account (`/me/adaccounts`, `account_status == 1`) as `meta_ads`, with the user
/// credential `user` (whose token is `token`). Its external id is the ad account's number without
/// the `act_` prefix (`account_id`).
async fn ad_accounts(
    connector: &MetaConnector,
    app: &GraphApp,
    user: &Credential,
    token: &str,
) -> Result<Vec<Asset>, ConnectorError> {
    let rows = match connector
        .graph_pages(
            app,
            token,
            &["me", "adaccounts"],
            &[
                ("fields", "id,account_id,name,account_status,currency"),
                ("limit", "100"),
            ],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) if skippable(&e, "ad_accounts") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(rows
        .iter()
        .filter(|row| crate::graph::integer(&row["account_status"]) == Some(ACTIVE_AD_ACCOUNT))
        .filter_map(|row| {
            let account = ad_account_number(row)?;
            Some(Asset {
                kind_key: "meta_ads".into(),
                name: row["name"].as_str().unwrap_or(&account).to_owned(),
                public: json!({
                    "account_id": account,
                    "currency": row["currency"],
                    "account_status": ACTIVE_AD_ACCOUNT,
                }),
                external_id: account,
                credential: user.clone(),
            })
        })
        .collect())
}

/// An ad account's number: its `account_id`, else its `id` without `act_`.
pub(crate) fn ad_account_number(row: &Value) -> Option<String> {
    text(&row["account_id"])
        .or_else(|| text(&row["id"]).map(|id| id.strip_prefix("act_").unwrap_or(&id).to_owned()))
}

/// Each WhatsApp number of each WhatsApp Business Account of each business the user manages
/// (`/me/businesses` → `/{business}/owned_whatsapp_business_accounts` → `/{waba}/phone_numbers`)
/// as `whatsapp_cloud`, with the user token (and its expiry, from the user credential `user`, so
/// it is renewed as the user's is) and the account's id.
async fn whatsapp_numbers(
    connector: &MetaConnector,
    app: &GraphApp,
    user: &Credential,
    token: &str,
) -> Result<Vec<Asset>, ConnectorError> {
    let expires_at = match user {
        Credential::OAuth { expires_at, .. } => *expires_at,
        _ => None,
    };
    let businesses = match connector
        .graph_pages(app, token, &["me", "businesses"], &[("fields", "id,name")])
        .await
    {
        Ok(rows) => rows,
        Err(e) if skippable(&e, "businesses") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut assets = Vec::new();
    for business in businesses {
        let Some(business_id) = text(&business["id"]) else {
            continue;
        };
        let wabas = match connector
            .graph_pages(
                app,
                token,
                &[node(&business_id)?, "owned_whatsapp_business_accounts"],
                &[("fields", "id,name")],
            )
            .await
        {
            Ok(rows) => rows,
            Err(e) if skippable(&e, "whatsapp_business_accounts") => continue,
            Err(e) => return Err(e),
        };
        for waba in wabas {
            let Some(waba_id) = text(&waba["id"]) else {
                continue;
            };
            let numbers = match connector
                .graph_pages(
                    app,
                    token,
                    &[node(&waba_id)?, "phone_numbers"],
                    &[(
                        "fields",
                        "id,display_phone_number,verified_name,quality_rating",
                    )],
                )
                .await
            {
                Ok(rows) => rows,
                Err(e) if skippable(&e, "phone_numbers") => continue,
                Err(e) => return Err(e),
            };
            for number in numbers {
                let Some(phone_id) = text(&number["id"]) else {
                    continue;
                };
                let display = number["display_phone_number"].as_str().unwrap_or_default();
                let verified = number["verified_name"].as_str().unwrap_or_default();
                assets.push(Asset {
                    kind_key: "whatsapp_cloud".into(),
                    external_id: phone_id.clone(),
                    name: if verified.is_empty() {
                        display
                    } else {
                        verified
                    }
                    .to_owned(),
                    credential: Credential::WhatsAppCloud {
                        phone_number_id: phone_id,
                        token: token.to_owned(),
                        waba_id: Some(waba_id.clone()),
                        expires_at,
                    },
                    public: json!({
                        "waba_id": waba_id,
                        "display_phone_number": display,
                        "verified_name": verified,
                        "quality_rating": number["quality_rating"],
                    }),
                });
            }
        }
    }
    Ok(assets)
}

/// The assets `cred` reaches when the sign-in variant `flow` issued it: without one, exactly
/// [`list_assets`]; for the WhatsApp Business app's sign-in, its numbers ([`business_app_numbers`]).
pub(crate) async fn list_assets_for(
    connector: &MetaConnector,
    cred: &Credential,
    flow: Option<OAuthFlow>,
) -> Result<Vec<Asset>, ConnectorError> {
    match flow {
        None => list_assets(connector, cred).await,
        Some(OAuthFlow::WhatsappBusinessApp) => business_app_numbers(connector, cred).await,
    }
}

/// The numbers the WhatsApp Business app's sign-in shared, as `whatsapp_cloud`, each with the
/// business's token (and its expiry) and its account's id, its public facts saying
/// `onboarding: whatsapp_business_app` (unless Graph says the number is not on the app: then
/// `null`, and it is connected as a plain Cloud API number) and, when Graph tells them,
/// `is_on_biz_app` and `platform_type`:
///
/// 1. the WhatsApp Business Accounts the token was granted: `GET /debug_token?input_token=`
///    (with the Meta app's access token, `{app_id}|{app_secret}`, which Graph's `debug_token`
///    reference accepts, <https://developers.facebook.com/docs/graph-api/reference/debug_token/>;
///    the token inspected travels in the query, the one place the endpoint takes it, and is taken
///    out of any refusal's reason), the
///    `target_ids` of its `whatsapp_business_management` granular scope, then of
///    `whatsapp_business_messaging`, each once, in their order (Meta's "manage accounts" page:
///    the most recently onboarded first,
///    <https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-accounts>);
///    the token's own `expires_at` when the exchange named none;
/// 2. each account's numbers, `GET /{waba}/phone_numbers` (an account that cannot be read is
///    left out, logged);
/// 3. each number's `GET /{phone_number_id}?fields=is_on_biz_app,platform_type` (Meta's
///    onboarding page names these fields), best effort: unknown when they cannot be read.
///
/// No account, or no number, is `Permanent`: the owner is told the sign-in shared nothing.
pub(crate) async fn business_app_numbers(
    connector: &MetaConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let MetaCred::User { token } = MetaCred::of(cred, "list assets")? else {
        return Err(ConnectorError::permanent(
            "assets are listed with a user token from a sign-in",
        ));
    };
    let meta = connector.meta_app()?;
    let app = GraphApp::of(&meta)?;
    // The app's own access token, with its proof as every Graph call's.
    let app_token = format!("{}|{}", meta.app_id, meta.app_secret);
    let url = connector.graph_url(&app.version, &["debug_token"], &[("input_token", token)]);
    let debugged = connector
        .call(Method::GET, url, app.auth(&app_token), Body::Empty)
        .await?;
    let data = &debugged["data"];
    let wabas = shared_accounts(data);
    if wabas.is_empty() {
        return Err(ConnectorError::permanent(
            "the sign-in shared no WhatsApp Business Account",
        ));
    }
    let expires_at = match cred {
        Credential::OAuth {
            expires_at: Some(at),
            ..
        } => Some(*at),
        _ => crate::graph::integer(&data["expires_at"])
            .filter(|at| *at > 0)
            .and_then(|at| OffsetDateTime::from_unix_timestamp(at).ok()),
    };
    let mut assets = Vec::new();
    for waba_id in wabas {
        let numbers = match connector
            .graph_pages(
                &app,
                token,
                &[node(&waba_id)?, "phone_numbers"],
                &[(
                    "fields",
                    "id,display_phone_number,verified_name,quality_rating",
                )],
            )
            .await
        {
            Ok(rows) => rows,
            Err(e) if skippable(&e, "phone_numbers") => continue,
            Err(e) => return Err(e),
        };
        for number in numbers {
            let Some(phone_id) = text(&number["id"]) else {
                continue;
            };
            let on_app = connector
                .graph_get(
                    &app,
                    token,
                    &[node(&phone_id)?],
                    &[("fields", "is_on_biz_app,platform_type")],
                )
                .await
                .unwrap_or_else(|e| {
                    tracing::debug!(
                        error_kind = e.kind(),
                        "whether a WhatsApp number is on the business app could not be read"
                    );
                    Value::Null
                });
            let display = number["display_phone_number"].as_str().unwrap_or_default();
            let verified = number["verified_name"].as_str().unwrap_or_default();
            assets.push(Asset {
                kind_key: "whatsapp_cloud".into(),
                external_id: phone_id.clone(),
                name: if verified.is_empty() {
                    display
                } else {
                    verified
                }
                .to_owned(),
                credential: Credential::WhatsAppCloud {
                    phone_number_id: phone_id,
                    token: token.to_owned(),
                    waba_id: Some(waba_id.clone()),
                    expires_at,
                },
                public: json!({
                    "waba_id": waba_id,
                    "display_phone_number": display,
                    "verified_name": verified,
                    "quality_rating": number["quality_rating"],
                    // Tagged as onboarded beside the app unless Graph says it is not on it.
                    "onboarding": (on_app["is_on_biz_app"].as_bool() != Some(false))
                        .then_some(OAuthFlow::WhatsappBusinessApp.key()),
                    "is_on_biz_app": on_app["is_on_biz_app"].as_bool(),
                    "platform_type": on_app["platform_type"].as_str(),
                }),
            });
        }
    }
    if assets.is_empty() {
        return Err(ConnectorError::permanent(
            "the shared WhatsApp Business Account has no phone number",
        ));
    }
    Ok(assets)
}

/// The WhatsApp Business Accounts a `debug_token` answer's `data` grants: the `target_ids` of
/// `whatsapp_business_management`, then of `whatsapp_business_messaging`, each once, in order.
fn shared_accounts(data: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for scope in [
        "whatsapp_business_management",
        "whatsapp_business_messaging",
    ] {
        let granted = data["granular_scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|g| g["scope"] == scope);
        for grant in granted {
            for id in grant["target_ids"].as_array().into_iter().flatten() {
                if let Some(id) = text(id)
                    && !out.contains(&id)
                {
                    out.push(id);
                }
            }
        }
    }
    out
}
