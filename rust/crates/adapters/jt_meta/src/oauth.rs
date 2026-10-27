//! Facebook Login and Instagram Login: authorize URLs, code exchanges (long-lived tokens) and
//! token refresh.

use jt_app::ports::connectors::{InstagramApp, MetaApp, OAuthApp};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::MetaConnector;
use crate::graph::{Auth, Body, GraphApp, graph_version, integer, join, missing};

/// The scopes Facebook Login asks for when the Meta app has no login configuration: Pages
/// (listing, posting, engagement, messaging, webhooks), Instagram through the Page (basic,
/// messages, publishing, insights), WhatsApp Business, ads (reading, and managing: budgets),
/// insights, lead-gen submissions (`leads_retrieval`) and business management.
pub const FACEBOOK_SCOPES: &[&str] = &[
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "business_management",
    "pages_messaging",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
    "instagram_content_publish",
    "whatsapp_business_management",
    "whatsapp_business_messaging",
    "ads_read",
    "read_insights",
    "instagram_manage_insights",
    "leads_retrieval",
    "ads_management",
];

/// The scopes Instagram Login asks for.
pub const INSTAGRAM_SCOPES: &[&str] = &[
    "instagram_business_basic",
    "instagram_business_content_publish",
];

/// The webhook fields a Facebook Page is always subscribed to when it is connected: its messages,
/// the echoes of its own replies, postbacks and reactions (Instagram messages arrive through the
/// linked page's subscription).
pub const PAGE_MESSAGING_FIELDS: &str =
    "messages,message_echoes,messaging_postbacks,message_reactions";

/// The webhook field of a Page's lead-gen submissions, subscribed besides
/// [`PAGE_MESSAGING_FIELDS`] only when the grant holds `leads_retrieval`: Meta refuses the whole
/// subscription when one of its fields lacks its permission.
pub const PAGE_LEADGEN_FIELD: &str = "leadgen";

/// The permission Meta requires of a [`PAGE_LEADGEN_FIELD`] subscription.
pub(crate) const LEADS_RETRIEVAL: &str = "leads_retrieval";

/// How close to its expiry a long-lived token is renewed.
const REFRESH_WINDOW: Duration = Duration::days(7);

/// Whether `access_token` with `scopes` is an Instagram Login token (see the crate docs).
pub(crate) fn is_instagram_login(access_token: &str, scopes: &[String]) -> bool {
    scopes.iter().any(|s| s.starts_with("instagram_business_")) || access_token.starts_with("IG")
}

/// Where to send the owner's browser for `app`: Facebook Login's dialog (with the scopes, or the
/// app's login configuration) or Instagram Login's. Holds no secret. Another provider's app is
/// refused (`Permanent`): the use cases never hand one to this adapter.
pub(crate) fn authorize_url(
    connector: &MetaConnector,
    app: &OAuthApp,
    redirect: &Url,
    state: &str,
    pkce_challenge: Option<&str>,
) -> Result<Url, ConnectorError> {
    match app {
        OAuthApp::Meta(meta) => {
            // An invalid configured version falls back to the default here; every Graph call
            // refuses it.
            let version =
                graph_version(meta).unwrap_or_else(|_| crate::DEFAULT_GRAPH_VERSION.to_owned());
            let mut url = join(
                &connector.bases().facebook_dialog,
                &[&version, "dialog", "oauth"],
                &[],
            );
            {
                let mut q = url.query_pairs_mut();
                q.append_pair("client_id", &meta.app_id)
                    .append_pair("redirect_uri", redirect.as_str())
                    .append_pair("state", state)
                    .append_pair("response_type", "code");
                match meta
                    .login_config_id
                    .as_deref()
                    .filter(|c| !c.trim().is_empty())
                {
                    Some(config) => q.append_pair("config_id", config.trim()),
                    None => q.append_pair("scope", &FACEBOOK_SCOPES.join(",")),
                };
                if let Some(challenge) = pkce_challenge {
                    q.append_pair("code_challenge", challenge)
                        .append_pair("code_challenge_method", "S256");
                }
            }
            Ok(url)
        }
        OAuthApp::Instagram(instagram) => {
            let mut url = join(
                &connector.bases().instagram_dialog,
                &["oauth", "authorize"],
                &[],
            );
            url.query_pairs_mut()
                .append_pair("client_id", &instagram.app_id)
                .append_pair("redirect_uri", redirect.as_str())
                .append_pair("response_type", "code")
                .append_pair("scope", &INSTAGRAM_SCOPES.join(","))
                .append_pair("state", state);
            Ok(url)
        }
        OAuthApp::X(_) => Err(ConnectorError::permanent("an X app cannot sign in to Meta")),
        OAuthApp::Tiktok(_) | OAuthApp::Linkedin(_) => Err(ConnectorError::permanent(
            "only a Meta or Instagram app signs in to Meta",
        )),
    }
}

/// The long-lived credential the code is exchanged for under `app`.
pub(crate) async fn exchange(
    connector: &MetaConnector,
    app: &OAuthApp,
    redirect: &Url,
    code: &str,
    pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    match app {
        OAuthApp::Meta(meta) => {
            facebook_exchange(connector, meta, redirect, code, pkce_verifier).await
        }
        OAuthApp::Instagram(instagram) => {
            instagram_exchange(connector, instagram, redirect, code).await
        }
        OAuthApp::X(_) => Err(ConnectorError::permanent("an X app cannot sign in to Meta")),
        OAuthApp::Tiktok(_) | OAuthApp::Linkedin(_) => Err(ConnectorError::permanent(
            "only a Meta or Instagram app signs in to Meta",
        )),
    }
}

/// `now + expires_in` seconds, when the answer names a positive one that `now` can be moved by;
/// `None` otherwise (never a panic, whatever the provider says).
fn expiry(answer: &Value, now: OffsetDateTime) -> Option<OffsetDateTime> {
    integer(&answer["expires_in"])
        .filter(|s| *s > 0)
        .and_then(|s| now.checked_add(Duration::seconds(s)))
}

/// The access token of an answer.
fn token_of(answer: &Value) -> Result<String, ConnectorError> {
    answer["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| missing("access token"))
}

/// Facebook Login: the code for a short-lived user token, that for a long-lived one (about 60
/// days), and the scopes it was granted (best effort: none when they cannot be read).
async fn facebook_exchange(
    connector: &MetaConnector,
    meta: &MetaApp,
    redirect: &Url,
    code: &str,
    pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    let app = GraphApp::of(meta)?;
    let mut query = vec![
        ("client_id", meta.app_id.as_str()),
        ("client_secret", meta.app_secret.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code", code),
    ];
    if let Some(verifier) = pkce_verifier {
        query.push(("code_verifier", verifier));
    }
    let url = connector.graph_url(&app.version, &["oauth", "access_token"], &query);
    let short = connector
        .call(Method::GET, url, Auth::None, Body::Empty)
        .await?;
    let short = token_of(&short)?;
    let long = long_lived(connector, meta, &app, &short).await?;
    let token = token_of(&long)?;
    let scopes = granted_scopes(connector, &app, &token).await;
    Ok(Credential::OAuth {
        expires_at: expiry(&long, OffsetDateTime::now_utc()),
        access_token: token,
        refresh_token: None,
        scopes,
    })
}

/// The answer of exchanging `token` for a long-lived user token (`fb_exchange_token`).
async fn long_lived(
    connector: &MetaConnector,
    meta: &MetaApp,
    app: &GraphApp,
    token: &str,
) -> Result<Value, ConnectorError> {
    let url = connector.graph_url(
        &app.version,
        &["oauth", "access_token"],
        &[
            ("grant_type", "fb_exchange_token"),
            ("client_id", &meta.app_id),
            ("client_secret", &meta.app_secret),
            ("fb_exchange_token", token),
        ],
    );
    connector
        .call(Method::GET, url, Auth::None, Body::Empty)
        .await
}

/// The scopes `token` was granted (`/me/permissions`, status `granted`); none when they cannot be
/// read.
async fn granted_scopes(connector: &MetaConnector, app: &GraphApp, token: &str) -> Vec<String> {
    match connector
        .graph_pages(app, token, &["me", "permissions"], &[])
        .await
    {
        Ok(rows) => rows
            .iter()
            .filter(|row| row["status"] == "granted")
            .filter_map(|row| row["permission"].as_str().map(str::to_owned))
            .collect(),
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the granted Meta scopes could not be read"
            );
            Vec::new()
        }
    }
}

/// Instagram Login: the code (without the `#_` Instagram appends) for a short-lived token at
/// `api.instagram.com`, then that for a long-lived one (about 60 days) at `graph.instagram.com`.
async fn instagram_exchange(
    connector: &MetaConnector,
    instagram: &InstagramApp,
    redirect: &Url,
    code: &str,
) -> Result<Credential, ConnectorError> {
    let code = code.strip_suffix("#_").unwrap_or(code);
    let url = join(
        &connector.bases().instagram_api,
        &["oauth", "access_token"],
        &[],
    );
    let form = vec![
        ("client_id".to_owned(), instagram.app_id.clone()),
        ("client_secret".to_owned(), instagram.app_secret.clone()),
        ("grant_type".to_owned(), "authorization_code".to_owned()),
        ("redirect_uri".to_owned(), redirect.to_string()),
        ("code".to_owned(), code.to_owned()),
    ];
    let answer = connector
        .call(Method::POST, url, Auth::None, Body::Form(form))
        .await?;
    // The answer is the token itself, or (newer) a `data` array holding it.
    let short = match answer["data"].as_array().and_then(|d| d.first()) {
        Some(first) => first.clone(),
        None => answer,
    };
    let short_token = token_of(&short)?;
    let mut scopes = permissions(&short["permissions"]);
    if scopes.is_empty() {
        scopes = INSTAGRAM_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    }
    let url = connector.instagram_url(
        &["access_token"],
        &[
            ("grant_type", "ig_exchange_token"),
            ("client_secret", &instagram.app_secret),
            ("access_token", &short_token),
        ],
    );
    // The short-lived token goes in the query, where this endpoint takes it.
    let long = connector
        .call(Method::GET, url, Auth::None, Body::Empty)
        .await?;
    Ok(Credential::OAuth {
        expires_at: expiry(&long, OffsetDateTime::now_utc()),
        access_token: token_of(&long)?,
        refresh_token: None,
        scopes,
    })
}

/// Instagram's granted permissions: an array of names or one comma-separated string.
fn permissions(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Value::String(text) => text
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

/// A renewed credential, when `cred` should be renewed now:
/// - an Instagram Login token expiring within seven days: `refresh_access_token`;
/// - a Facebook user token expiring within seven days: `fb_exchange_token`;
/// - a WhatsApp Cloud token from a Facebook Login user (it has an `expires_at`) expiring within
///   seven days: `fb_exchange_token` too, the number and its account kept;
/// - anything else (a token not expiring soon, one without a known expiry, a Page token, which
///   does not expire when it comes from a long-lived user token, a system user's WhatsApp token,
///   which has no expiry): `None`.
pub(crate) async fn refresh(
    connector: &MetaConnector,
    cred: &Credential,
) -> Result<Option<Credential>, ConnectorError> {
    let now = OffsetDateTime::now_utc();
    match cred {
        Credential::OAuth {
            access_token,
            scopes,
            ..
        } if cred.expires_soon(now, REFRESH_WINDOW) => {
            let answer = if is_instagram_login(access_token, scopes) {
                let url = connector.instagram_url(
                    &["refresh_access_token"],
                    &[
                        ("grant_type", "ig_refresh_token"),
                        ("access_token", access_token),
                    ],
                );
                // The token goes in the query, where this endpoint takes it.
                connector
                    .call(Method::GET, url, Auth::None, Body::Empty)
                    .await?
            } else {
                let meta = connector.meta_app()?;
                let app = GraphApp::of(&meta)?;
                long_lived(connector, &meta, &app, access_token).await?
            };
            Ok(Some(Credential::OAuth {
                expires_at: expiry(&answer, OffsetDateTime::now_utc()),
                access_token: token_of(&answer)?,
                refresh_token: None,
                scopes: scopes.clone(),
            }))
        }
        Credential::WhatsAppCloud {
            phone_number_id,
            token,
            waba_id,
            ..
        } if cred.expires_soon(now, REFRESH_WINDOW) => {
            let meta = connector.meta_app()?;
            let app = GraphApp::of(&meta)?;
            let answer = long_lived(connector, &meta, &app, token).await?;
            Ok(Some(Credential::WhatsAppCloud {
                phone_number_id: phone_number_id.clone(),
                token: token_of(&answer)?,
                waba_id: waba_id.clone(),
                expires_at: expiry(&answer, OffsetDateTime::now_utc()),
            }))
        }
        Credential::OAuth { .. }
        | Credential::PageToken { .. }
        | Credential::WhatsAppCloud { .. } => Ok(None),
        other => Err(crate::graph::wrong_credential(other, "be refreshed")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    #[test]
    fn expiry_never_panics() {
        let now = datetime!(2026-10-23 12:00:00 UTC);
        assert_eq!(
            expiry(&json!({ "expires_in": 60 }), now),
            Some(datetime!(2026-10-23 12:01:00 UTC))
        );
        assert_eq!(
            expiry(&json!({ "expires_in": "3600" }), now),
            Some(datetime!(2026-10-23 13:00:00 UTC))
        );
        for absurd in [
            json!({ "expires_in": i64::MAX }),
            json!({ "expires_in": 0 }),
            json!({ "expires_in": -5 }),
            json!({ "expires_in": "soon" }),
            json!({}),
        ] {
            assert_eq!(expiry(&absurd, now), None, "{absurd}");
        }
    }
}
