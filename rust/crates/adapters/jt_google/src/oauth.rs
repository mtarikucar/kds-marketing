//! OAuth 2.0 authorization code (a confidential web client with offline access): the authorize
//! URL, the code exchange, the refresh, the access token of a call and the revocation.

use jt_app::ports::connectors::{GoogleApp, OAuthApp};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::client::{Auth, Body, Endpoint, Grant, join, missing};
use crate::{ADS_SCOPE, GoogleConnector, Minted, TOKEN_MARGIN};

/// Why a connection without a refresh token cannot be used: its access token ends within the
/// hour and nothing renews it.
pub(crate) const NO_REFRESH_TOKEN: &str =
    "the Google connection holds no refresh token: reconnect the account";

/// `pairs` as a query string, each value percent-encoded, a space as `%20` (not `+`).
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
        .replace('+', "%20")
}

/// The Google app of an OAuth flow; `Permanent` for another provider's app.
fn google_app_of(app: &OAuthApp) -> Result<&GoogleApp, ConnectorError> {
    match app {
        OAuthApp::Google(google) => Ok(google),
        OAuthApp::Meta(_)
        | OAuthApp::Instagram(_)
        | OAuthApp::X(_)
        | OAuthApp::Tiktok(_)
        | OAuthApp::TiktokAds(_)
        | OAuthApp::Linkedin(_) => Err(ConnectorError::permanent(
            "only the Google app signs in to Google",
        )),
    }
}

/// `value` when it is present and not blank.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The authorize URL (see the crate docs). Holds no secret. A PKCE challenge is not sent: the
/// flow is a confidential client's, authenticated by its secret at the token endpoint.
pub(crate) fn authorize_url(
    connector: &GoogleConnector,
    app: &OAuthApp,
    redirect: &Url,
    state: &str,
    pkce_challenge: Option<&str>,
) -> Result<Url, ConnectorError> {
    let google = google_app_of(app)?;
    if present(pkce_challenge).is_some() {
        tracing::debug!("a PKCE challenge was handed to the Google web flow; it is not sent");
    }
    let mut url = join(&connector.bases().authorize, &["o", "oauth2", "v2", "auth"]);
    url.set_query(Some(&query(&[
        ("client_id", &google.client_id),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", ADS_SCOPE),
        // A refresh token, and one on a reconnection too (see the crate docs).
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "true"),
        ("state", state),
    ])));
    Ok(url)
}

/// The credential the authorization `code` is exchanged for. A PKCE verifier is not sent. An
/// answer without a refresh token is refused: the connection could not outlive its first hour.
pub(crate) async fn exchange(
    connector: &GoogleConnector,
    app: &OAuthApp,
    redirect: &Url,
    code: &str,
    _pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    let google = google_app_of(app)?;
    let body = Body::Form(vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
        ("client_id", &google.client_id),
        ("client_secret", &google.client_secret),
    ]);
    let answer = token_call(connector, &body, Grant::Code).await?;
    let credential = credential_of(
        &answer,
        None,
        &[ADS_SCOPE.to_owned()],
        OffsetDateTime::now_utc(),
    )?;
    match &credential {
        Credential::OAuth {
            refresh_token: Some(_),
            scopes,
            ..
        } if scopes.iter().any(|s| s == ADS_SCOPE) => Ok(credential),
        Credential::OAuth {
            refresh_token: Some(_),
            ..
        } => Err(ConnectorError::permission(
            "the Google sign-in did not grant access to Google Ads",
        )),
        _ => Err(ConnectorError::permanent(
            "Google's token answer has no refresh token",
        )),
    }
}

/// The refresh token of `cred`, when it is an OAuth credential holding one.
fn refresh_token_of(cred: &Credential) -> Result<Option<&str>, ConnectorError> {
    match cred {
        Credential::OAuth { refresh_token, .. } => Ok(present(refresh_token.as_deref())),
        other => Err(ConnectorError::permanent(format!(
            "a {} credential is not a Google connection",
            other.kind()
        ))),
    }
}

/// A renewed credential (a new access token; the refresh token and the scopes held are kept
/// where the answer names none); `None` when `cred` holds no refresh token.
pub(crate) async fn refresh(
    connector: &GoogleConnector,
    cred: &Credential,
) -> Result<Option<Credential>, ConnectorError> {
    let Some(refresh_token) = refresh_token_of(cred)? else {
        return Ok(None);
    };
    let held_scopes = match cred {
        Credential::OAuth { scopes, .. } => scopes.as_slice(),
        _ => &[],
    };
    let answer = refresh_call(connector, refresh_token).await?;
    credential_of(
        &answer,
        Some(refresh_token),
        held_scopes,
        OffsetDateTime::now_utc(),
    )
    .map(Some)
}

/// `POST {oauth}/token` with the refresh grant of `refresh_token`.
async fn refresh_call(
    connector: &GoogleConnector,
    refresh_token: &str,
) -> Result<Value, ConnectorError> {
    let google = connector.google_app()?;
    let body = Body::Form(vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &google.client_id),
        ("client_secret", &google.client_secret),
    ]);
    token_call(connector, &body, Grant::Refresh).await
}

/// `POST {oauth}/token` with `body` (the client in the form).
async fn token_call(
    connector: &GoogleConnector,
    body: &Body<'_>,
    grant: Grant,
) -> Result<Value, ConnectorError> {
    connector
        .call(
            Method::POST,
            connector.token_url(),
            Auth::Anonymous,
            body,
            Endpoint::Token(grant),
        )
        .await
}

/// The access token of a token answer and when it ends as of `now`; `None` for the end when the
/// answer names no positive number of seconds `now` can be moved by.
fn access_of(
    answer: &Value,
    now: OffsetDateTime,
) -> Result<(String, Option<OffsetDateTime>), ConnectorError> {
    let access_token = answer["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| missing("access token"))?;
    let expires_at = answer["expires_in"]
        .as_i64()
        .or_else(|| {
            answer["expires_in"]
                .as_str()
                .and_then(|s| s.trim().parse().ok())
        })
        .filter(|s| *s > 0)
        .and_then(|s| now.checked_add(Duration::seconds(s)));
    Ok((access_token.to_owned(), expires_at))
}

/// The credential of a token answer: its access token, its refresh token (else
/// `held_refresh`) and the scopes its space-delimited `scope` grants, else `held_scopes`. It
/// names no end: a Google connection lives as long as its refresh token, not as long as the
/// access token that came with it (about an hour), and a stored end would make the connection
/// read as expired between two rounds of the refresh job. Every call gets its own access token
/// ([`GoogleConnector::access_token`]).
fn credential_of(
    answer: &Value,
    held_refresh: Option<&str>,
    held_scopes: &[String],
    now: OffsetDateTime,
) -> Result<Credential, ConnectorError> {
    let (access_token, _) = access_of(answer, now)?;
    let refresh_token = answer["refresh_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .or(held_refresh)
        .map(str::to_owned);
    let mut granted: Vec<String> = Vec::new();
    for scope in answer["scope"]
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
    {
        if !granted.iter().any(|g| g == scope) {
            granted.push(scope.to_owned());
        }
    }
    let scopes = if granted.is_empty() {
        held_scopes.to_vec()
    } else {
        granted
    };
    Ok(Credential::OAuth {
        access_token,
        refresh_token,
        expires_at: None,
        scopes,
    })
}

/// Revokes the grant behind `cred` at Google (its refresh token, else its access token): the
/// account is disconnected there too.
pub(crate) async fn revoke(
    connector: &GoogleConnector,
    cred: &Credential,
) -> Result<(), ConnectorError> {
    let token = match (refresh_token_of(cred)?, cred) {
        (Some(refresh_token), _) => refresh_token,
        (None, Credential::OAuth { access_token, .. }) => access_token.as_str(),
        (None, _) => return Ok(()),
    };
    connector
        .call(
            Method::POST,
            connector.revoke_url(),
            Auth::Anonymous,
            &Body::Form(vec![("token", token)]),
            Endpoint::Revoke,
        )
        .await
        .map(|_| ())
}

impl GoogleConnector {
    /// The Google app, read now; `Permanent` when the platform has none.
    pub(crate) fn google_app(&self) -> Result<GoogleApp, ConnectorError> {
        self.apps
            .google_app()
            .ok_or_else(|| ConnectorError::permanent("the Google app is not configured"))
    }

    /// The access token a call with `cred` carries (see the crate docs): the stored one while
    /// it has more than [`TOKEN_MARGIN`] left (one that names no end is taken as ended), else one
    /// the adapter got with the refresh token and still holds, else a new one from the token
    /// endpoint. `Auth` when there is no refresh token to get one with.
    pub(crate) async fn access_token(&self, cred: &Credential) -> Result<String, ConnectorError> {
        let now = OffsetDateTime::now_utc();
        let fresh = |ends: OffsetDateTime| ends - now > TOKEN_MARGIN;
        if let Credential::OAuth {
            access_token,
            expires_at: Some(expires_at),
            ..
        } = cred
            && !access_token.is_empty()
            && fresh(*expires_at)
        {
            return Ok(access_token.clone());
        }
        let refresh_token =
            refresh_token_of(cred)?.ok_or_else(|| ConnectorError::auth(NO_REFRESH_TOKEN))?;
        if let Some(held) = self
            .minted
            .lock()
            .ok()
            .and_then(|minted| minted.get(refresh_token).cloned())
            && fresh(held.expires_at)
        {
            return Ok(held.access_token);
        }
        let answer = refresh_call(self, refresh_token).await?;
        let (access_token, expires_at) = access_of(&answer, now)?;
        if let (Some(expires_at), Ok(mut minted)) = (expires_at, self.minted.lock()) {
            // Tokens that ended are dropped as new ones come: the map holds at most one live
            // token per connection.
            minted.retain(|_, held| held.expires_at > now);
            minted.insert(
                refresh_token.to_owned(),
                Minted {
                    access_token: access_token.clone(),
                    expires_at,
                },
            );
        }
        Ok(access_token)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-11-11 12:00:00 UTC);

    #[test]
    fn queries_encode_spaces_as_percent_20() {
        assert_eq!(
            query(&[("prompt", "a b"), ("x", "1+2 &=")]),
            "prompt=a%20b&x=1%2B2%20%26%3D"
        );
    }

    #[test]
    fn token_answers_become_credentials() {
        let full = json!({"access_token":"a","expires_in":3599,"refresh_token":"r",
            "scope":"openid https://www.googleapis.com/auth/adwords","token_type":"Bearer"});
        assert_eq!(
            credential_of(&full, Some("old"), &[], NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("r".into()),
                // No end: the connection lives as long as its refresh token.
                expires_at: None,
                scopes: vec!["openid".into(), ADS_SCOPE.into()],
            }
        );
        // A refresh answer names no refresh token and may name no scope: what is held stays.
        let held = vec![ADS_SCOPE.to_owned()];
        let bare = json!({"access_token":"b","expires_in":"60"});
        assert_eq!(
            credential_of(&bare, Some("old"), &held, NOW).unwrap(),
            Credential::OAuth {
                access_token: "b".into(),
                refresh_token: Some("old".into()),
                expires_at: None,
                scopes: held.clone(),
            }
        );
        // The access token's own end is what a call goes by.
        assert_eq!(
            access_of(&full, NOW).unwrap(),
            ("a".to_owned(), Some(datetime!(2026-11-11 12:59:59 UTC)))
        );
        for absurd in [
            json!(i64::MAX),
            json!(0),
            json!(-5),
            json!("soon"),
            json!(null),
        ] {
            let (_, ends) =
                access_of(&json!({"access_token":"a","expires_in":absurd}), NOW).unwrap();
            assert_eq!(ends, None);
        }
        assert_eq!(
            credential_of(&json!({"access_token":""}), None, &held, NOW)
                .unwrap_err()
                .kind(),
            "permanent"
        );
    }
}
