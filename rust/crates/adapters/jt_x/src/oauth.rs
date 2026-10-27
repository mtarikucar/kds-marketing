//! OAuth 2.0 with PKCE: the authorize URL, the code exchange and the (rotating) refresh.

use jt_app::ports::connectors::{OAuthApp, XApp};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::client::{Auth, Body, Endpoint, Grant, join, missing};
use crate::{X_SCOPES, XConnector};

/// Why a flow without PKCE is refused.
pub(crate) const PKCE_REQUIRED: &str = "pkce required";

/// Why a credential without a refresh token cannot be renewed.
const NO_REFRESH_TOKEN: &str = "the X credential has no refresh token (offline.access was not \
     granted): reconnect the account";

/// `pairs` as a query string, each value percent-encoded, a space as `%20` (not `+`: the
/// serializer encodes a literal `+` as `%2B`, so every `+` it leaves is a space).
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
        .replace('+', "%20")
}

/// The X app of an OAuth flow; `Permanent` for another provider's app.
fn x_app_of(app: &OAuthApp) -> Result<&XApp, ConnectorError> {
    match app {
        OAuthApp::X(x) => Ok(x),
        OAuthApp::Meta(_)
        | OAuthApp::Instagram(_)
        | OAuthApp::Tiktok(_)
        | OAuthApp::Linkedin(_) => Err(ConnectorError::permanent("only the X app signs in to X")),
    }
}

/// `value` when it is present and not blank.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The authorize URL (see the crate docs). Holds no secret.
pub(crate) fn authorize_url(
    connector: &XConnector,
    app: &OAuthApp,
    redirect: &Url,
    state: &str,
    pkce_challenge: Option<&str>,
) -> Result<Url, ConnectorError> {
    let x = x_app_of(app)?;
    let challenge =
        present(pkce_challenge).ok_or_else(|| ConnectorError::permanent(PKCE_REQUIRED))?;
    let scope = X_SCOPES.join(" ");
    let mut url = join(
        &connector.bases().authorize,
        &["i", "oauth2", "authorize"],
        &[],
    );
    url.set_query(Some(&query(&[
        ("response_type", "code"),
        ("client_id", &x.client_id),
        ("redirect_uri", redirect.as_str()),
        ("scope", &scope),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ])));
    Ok(url)
}

/// The credential the authorization `code` is exchanged for, with the PKCE `pkce_verifier`.
pub(crate) async fn exchange(
    connector: &XConnector,
    app: &OAuthApp,
    redirect: &Url,
    code: &str,
    pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    let x = x_app_of(app)?;
    let verifier =
        present(pkce_verifier).ok_or_else(|| ConnectorError::permanent(PKCE_REQUIRED))?;
    let body = Body::Form(vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
        ("client_id", &x.client_id),
        ("code_verifier", verifier),
    ]);
    let answer = token_call(connector, x, &body, Grant::Code).await?;
    let asked: Vec<String> = X_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    credential_of(&answer, None, &asked, OffsetDateTime::now_utc())
}

/// A renewed credential: always, when `cred` has a refresh token (X rotates it on every call;
/// see the crate docs).
pub(crate) async fn refresh(
    connector: &XConnector,
    cred: &Credential,
) -> Result<Option<Credential>, ConnectorError> {
    let Credential::OAuth {
        refresh_token,
        scopes,
        ..
    } = cred
    else {
        return Err(ConnectorError::permanent(format!(
            "a {} credential cannot be refreshed on X",
            cred.kind()
        )));
    };
    let Some(refresh_token) = present(refresh_token.as_deref()) else {
        return Err(ConnectorError::auth(NO_REFRESH_TOKEN));
    };
    let x = connector.x_app()?;
    let body = Body::Form(vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &x.client_id),
    ]);
    let answer = token_call(connector, &x, &body, Grant::Refresh).await?;
    credential_of(
        &answer,
        Some(refresh_token),
        scopes,
        OffsetDateTime::now_utc(),
    )
    .map(Some)
}

/// `POST {api}/2/oauth2/token` with `body`, as the X client `x` (`Basic`).
async fn token_call(
    connector: &XConnector,
    x: &XApp,
    body: &Body<'_>,
    grant: Grant,
) -> Result<Value, ConnectorError> {
    let url = connector.api_url(&["2", "oauth2", "token"], &[]);
    let auth = Auth::Basic {
        client_id: &x.client_id,
        secret: &x.client_secret,
    };
    connector
        .call(Method::POST, url, auth, body, Endpoint::Token(grant))
        .await
}

/// The credential of a token answer as of `now`: its access token, its refresh token (else
/// `held_refresh`), `now + expires_in` (when it names a positive number of seconds that `now` can
/// be moved by) and the scopes its `scope` grants (else `held_scopes`).
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
        .split_whitespace()
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

impl XConnector {
    /// The X app, read now; `Permanent` when the platform has none.
    pub(crate) fn x_app(&self) -> Result<XApp, ConnectorError> {
        self.apps
            .x_app()
            .ok_or_else(|| ConnectorError::permanent("the X app is not configured"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-10-23 12:00:00 UTC);

    #[test]
    fn queries_encode_spaces_as_percent_20() {
        assert_eq!(
            query(&[("scope", "a b"), ("x", "1+2 &=")]),
            "scope=a%20b&x=1%2B2%20%26%3D"
        );
    }

    #[test]
    fn token_answers_become_credentials() {
        let answer = json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 7200,
            "scope": "tweet.read  users.read",
        });
        assert_eq!(
            credential_of(&answer, Some("old"), &[], NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("r".into()),
                expires_at: Some(datetime!(2026-10-23 14:00:00 UTC)),
                scopes: vec!["tweet.read".into(), "users.read".into()],
            }
        );
        let held = vec!["tweet.read".to_owned()];
        let bare = json!({ "access_token": "a", "expires_in": "60" });
        assert_eq!(
            credential_of(&bare, Some("old"), &held, NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("old".into()),
                expires_at: Some(datetime!(2026-10-23 12:01:00 UTC)),
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
