//! Login Kit for the web (<https://developers.tiktok.com/doc/login-kit-web>): the authorize URL,
//! the code exchange and the refresh near expiry
//! (<https://developers.tiktok.com/doc/oauth-user-access-token-management>).

use jt_app::ports::connectors::{OAuthApp, TiktokApp};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::client::{Auth, Body, Effect, Endpoint, join, missing};
use crate::{REFRESH_AHEAD, TIKTOK_SCOPES, TiktokConnector};

/// Why a credential without a refresh token cannot be renewed.
const NO_REFRESH_TOKEN: &str = "the TikTok credential has no refresh token: reconnect the account";

/// `pairs` as a query string, each value percent-encoded, a space as `%20` (the serializer
/// encodes a literal `+` as `%2B`, so every `+` it leaves is a space) and a comma kept as is, as
/// TikTok writes its comma-separated scopes (a form decoder reads `,` and `%2C` alike).
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
        .replace('+', "%20")
        .replace("%2C", ",")
}

/// The TikTok app of an OAuth flow; `Permanent` for another provider's app.
fn tiktok_app_of(app: &OAuthApp) -> Result<&TiktokApp, ConnectorError> {
    match app {
        OAuthApp::Tiktok(tiktok) => Ok(tiktok),
        OAuthApp::Meta(_) | OAuthApp::Instagram(_) | OAuthApp::X(_) | OAuthApp::Linkedin(_) => Err(
            ConnectorError::permanent("only the TikTok app signs in to TikTok"),
        ),
    }
}

/// `value` when it is present and not blank.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The authorize URL (see the crate docs). Holds no secret. The web flow takes no PKCE, so a
/// `pkce_challenge` is not put in it.
pub(crate) fn authorize_url(
    connector: &TiktokConnector,
    app: &OAuthApp,
    redirect: &Url,
    state: &str,
    pkce_challenge: Option<&str>,
) -> Result<Url, ConnectorError> {
    let tiktok = tiktok_app_of(app)?;
    let _ = pkce_challenge;
    let scope = TIKTOK_SCOPES.join(",");
    let mut url = join(
        &connector.bases().authorize,
        &["v2", "auth", "authorize", ""],
        &[],
    );
    url.set_query(Some(&query(&[
        ("client_key", &tiktok.client_key),
        ("response_type", "code"),
        ("scope", &scope),
        ("redirect_uri", redirect.as_str()),
        ("state", state),
    ])));
    Ok(url)
}

/// The credential the authorization `code` (as the callback carried it, decoded) is exchanged
/// for. A `pkce_verifier` is not sent: the web flow takes none.
pub(crate) async fn exchange(
    connector: &TiktokConnector,
    app: &OAuthApp,
    redirect: &Url,
    code: &str,
    pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    let tiktok = tiktok_app_of(app)?;
    let _ = pkce_verifier;
    let code = present(Some(code))
        .ok_or_else(|| ConnectorError::permanent("no authorization code to exchange"))?;
    let body = Body::Form(vec![
        ("client_key", &tiktok.client_key),
        ("client_secret", &tiktok.client_secret),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect.as_str()),
    ]);
    let answer = token_call(connector, &body).await?;
    let asked: Vec<String> = TIKTOK_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    credential_of(&answer, None, &asked, OffsetDateTime::now_utc())
}

/// A renewed credential when `cred` expires within [`REFRESH_AHEAD`] (or has expired, or names
/// no expiry), else `None` (see the crate docs).
pub(crate) async fn refresh(
    connector: &TiktokConnector,
    cred: &Credential,
) -> Result<Option<Credential>, ConnectorError> {
    let Credential::OAuth {
        refresh_token,
        expires_at,
        scopes,
        ..
    } = cred
    else {
        return Err(ConnectorError::permanent(format!(
            "a {} credential cannot be refreshed on TikTok",
            cred.kind()
        )));
    };
    let now = OffsetDateTime::now_utc();
    if !due(*expires_at, now) {
        return Ok(None);
    }
    let Some(refresh_token) = present(refresh_token.as_deref()) else {
        return Err(ConnectorError::auth(NO_REFRESH_TOKEN));
    };
    let tiktok = connector.tiktok_app()?;
    let body = Body::Form(vec![
        ("client_key", &tiktok.client_key),
        ("client_secret", &tiktok.client_secret),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ]);
    let answer = token_call(connector, &body).await?;
    credential_of(
        &answer,
        Some(refresh_token),
        scopes,
        OffsetDateTime::now_utc(),
    )
    .map(Some)
}

/// Whether a credential expiring at `expires_at` is renewed as of `now`: no expiry, or one within
/// [`REFRESH_AHEAD`].
fn due(expires_at: Option<OffsetDateTime>, now: OffsetDateTime) -> bool {
    match expires_at {
        None => true,
        Some(at) => at <= now.saturating_add(REFRESH_AHEAD),
    }
}

/// `POST {api}/v2/oauth/token/` with the form `body` (the client in it), sent once: a second
/// exchange or refresh would present a code or a refresh token the first may have spent.
async fn token_call(connector: &TiktokConnector, body: &Body<'_>) -> Result<Value, ConnectorError> {
    let url = connector.api_url(&["v2", "oauth", "token", ""], &[]);
    connector
        .call(
            Method::POST,
            url,
            Auth::Form,
            body,
            Endpoint::Token,
            Effect::Commit,
        )
        .await
}

/// The credential of a token answer as of `now`: its access token, its refresh token (else
/// `held_refresh`), `now + expires_in` (when it names a positive number of seconds that `now` can
/// be moved by) and the scopes its comma-separated `scope` grants (else `held_scopes`).
fn credential_of(
    answer: &Value,
    held_refresh: Option<&str>,
    held_scopes: &[String],
    now: OffsetDateTime,
) -> Result<Credential, ConnectorError> {
    let access_token = answer["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| missing("access token"))?;
    let refresh_token = answer["refresh_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .or(held_refresh)
        .map(str::to_owned);
    let expires_at = answer["expires_in"]
        .as_i64()
        .or_else(|| {
            answer["expires_in"]
                .as_str()
                .and_then(|s| s.trim().parse().ok())
        })
        .filter(|s| *s > 0)
        .and_then(|s| now.checked_add(Duration::seconds(s)));
    let granted: Vec<String> = answer["scope"]
        .as_str()
        .unwrap_or_default()
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let scopes = if granted.is_empty() {
        held_scopes.to_vec()
    } else {
        granted
    };
    Ok(Credential::OAuth {
        access_token: access_token.to_owned(),
        refresh_token,
        expires_at,
        scopes,
    })
}

impl TiktokConnector {
    /// The TikTok app, read now; `Permanent` when the platform has none.
    pub(crate) fn tiktok_app(&self) -> Result<TiktokApp, ConnectorError> {
        self.apps
            .tiktok_app()
            .ok_or_else(|| ConnectorError::permanent("the TikTok app is not configured"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-10-27 12:00:00 UTC);

    #[test]
    fn queries_encode_spaces_as_percent_20_and_keep_commas() {
        assert_eq!(
            query(&[("scope", "a,b"), ("x", "1+2 &=")]),
            "scope=a,b&x=1%2B2%20%26%3D"
        );
    }

    #[test]
    fn a_credential_is_due_within_the_window_or_without_an_expiry() {
        assert!(due(None, NOW));
        assert!(due(Some(NOW - Duration::hours(1)), NOW));
        assert!(due(Some(NOW + Duration::hours(6)), NOW));
        assert!(due(Some(NOW + Duration::hours(5)), NOW));
        assert!(!due(
            Some(NOW + Duration::hours(6) + Duration::seconds(1)),
            NOW
        ));
        assert!(!due(Some(NOW + Duration::hours(23)), NOW));
        assert!(!due(Some(datetime!(9999-12-31 23:59:59 UTC)), NOW));
    }

    #[test]
    fn token_answers_become_credentials() {
        let answer = json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 86400,
            "open_id": "o", "refresh_expires_in": 31536000,
            "scope": "user.info.basic,video.list", "token_type": "Bearer",
        });
        assert_eq!(
            credential_of(&answer, Some("old"), &[], NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("r".into()),
                expires_at: Some(datetime!(2026-10-28 12:00:00 UTC)),
                scopes: vec!["user.info.basic".into(), "video.list".into()],
            }
        );
        let held = vec!["video.publish".to_owned()];
        let bare = json!({ "access_token": "a", "expires_in": "60", "scope": " , " });
        assert_eq!(
            credential_of(&bare, Some("old"), &held, NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("old".into()),
                expires_at: Some(datetime!(2026-10-27 12:01:00 UTC)),
                scopes: held.clone(),
            }
        );
        for absurd in [
            json!(i64::MAX),
            json!(0),
            json!(-5),
            json!("soon"),
            json!(null),
        ] {
            let answer = json!({ "access_token": "a", "expires_in": absurd });
            let Credential::OAuth { expires_at, .. } =
                credential_of(&answer, None, &held, NOW).unwrap()
            else {
                unreachable!()
            };
            assert_eq!(expires_at, None, "{answer}");
        }
        assert_eq!(
            credential_of(&json!({ "access_token": "" }), None, &held, NOW)
                .unwrap_err()
                .kind(),
            "permanent"
        );
    }
}
