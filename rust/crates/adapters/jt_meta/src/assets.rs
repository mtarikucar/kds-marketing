//! What a signed-in account can reach: its Pages (and their Messenger inboxes and linked
//! Instagram accounts), its ad accounts and its WhatsApp numbers; or, for an Instagram Login
//! token, its Instagram account.

use jt_app::ports::connectors::Asset;
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};

use crate::MetaConnector;
use crate::credential::MetaCred;
use crate::graph::{GraphApp, missing, node, text};

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
/// token itself, its id being the account's `user_id` (the id webhooks name).
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
    Ok(vec![Asset {
        kind_key: "instagram".into(),
        external_id: id,
        name: username.clone(),
        credential: cred.clone(),
        public: json!({ "username": username, "login": "instagram" }),
    }])
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
