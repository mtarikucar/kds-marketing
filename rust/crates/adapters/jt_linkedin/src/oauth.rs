//! OAuth 2.0 authorization code (a confidential web client, no PKCE): the authorize URL, the
//! code exchange and the refresh for apps LinkedIn issues refresh tokens to.

use jt_app::ports::connectors::{LinkedinApp, OAuthApp};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::client::{Answer, Auth, Body, Endpoint, Grant, join, missing};
use crate::{LinkedinConnector, MEMBER_SCOPES, ORGANIZATION_SCOPES};

/// `pairs` as a query string, each value percent-encoded, a space as `%20` (not `+`: the
/// serializer encodes a literal `+` as `%2B`, so every `+` it leaves is a space). LinkedIn's
/// `scope` is "URL-encoded, space-delimited".
fn query(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
        .replace('+', "%20")
}

/// The LinkedIn app of an OAuth flow; `Permanent` for another provider's app.
fn linkedin_app_of(app: &OAuthApp) -> Result<&LinkedinApp, ConnectorError> {
    match app {
        OAuthApp::Linkedin(linkedin) => Ok(linkedin),
        OAuthApp::Meta(_) | OAuthApp::Instagram(_) | OAuthApp::X(_) | OAuthApp::Tiktok(_) => Err(
            ConnectorError::permanent("only the LinkedIn app signs in to LinkedIn"),
        ),
    }
}

/// The scopes a flow with `app` asks for: [`MEMBER_SCOPES`], and [`ORGANIZATION_SCOPES`] when
/// the flow's app sets `organization_scopes`.
pub(crate) fn scopes_for(app: &LinkedinApp) -> Vec<String> {
    let mut scopes: Vec<String> = MEMBER_SCOPES.iter().map(|s| (*s).to_owned()).collect();
    if app.organization_scopes {
        scopes.extend(ORGANIZATION_SCOPES.iter().map(|s| (*s).to_owned()));
    }
    scopes
}

/// `value` when it is present and not blank.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// The authorize URL (see the crate docs). Holds no secret; a PKCE challenge is not sent
/// (LinkedIn's PKCE is a native-app flow of its own).
pub(crate) fn authorize_url(
    connector: &LinkedinConnector,
    app: &OAuthApp,
    redirect: &Url,
    state: &str,
    pkce_challenge: Option<&str>,
) -> Result<Url, ConnectorError> {
    let linkedin = linkedin_app_of(app)?;
    if present(pkce_challenge).is_some() {
        tracing::debug!("a PKCE challenge was handed to the LinkedIn web flow; it is not sent");
    }
    let scope = scopes_for(linkedin).join(" ");
    let mut url = join(
        &connector.bases().authorize,
        &["oauth", "v2", "authorization"],
        &[],
    );
    url.set_query(Some(&query(&[
        ("response_type", "code"),
        ("client_id", &linkedin.client_id),
        ("redirect_uri", redirect.as_str()),
        ("state", state),
        ("scope", &scope),
    ])));
    Ok(url)
}

/// The credential the authorization `code` is exchanged for. A PKCE verifier is not sent.
pub(crate) async fn exchange(
    connector: &LinkedinConnector,
    app: &OAuthApp,
    redirect: &Url,
    code: &str,
    _pkce_verifier: Option<&str>,
) -> Result<Credential, ConnectorError> {
    let linkedin = linkedin_app_of(app)?;
    let body = Body::Form(vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
        ("client_id", &linkedin.client_id),
        ("client_secret", &linkedin.client_secret),
    ]);
    let answer = token_call(connector, &body, Grant::Code).await?;
    credential_of(
        &answer,
        None,
        &scopes_for(linkedin),
        OffsetDateTime::now_utc(),
    )
}

/// A renewed credential when `cred` holds a refresh token (LinkedIn issues them only to apps
/// with programmatic refresh); `None` when it holds none: nothing to renew with, and the access
/// token expires into a reconnection.
pub(crate) async fn refresh(
    connector: &LinkedinConnector,
    cred: &Credential,
) -> Result<Option<Credential>, ConnectorError> {
    let Credential::OAuth {
        refresh_token,
        scopes,
        ..
    } = cred
    else {
        return Err(ConnectorError::permanent(format!(
            "a {} credential cannot be refreshed on LinkedIn",
            cred.kind()
        )));
    };
    let Some(refresh_token) = present(refresh_token.as_deref()) else {
        return Ok(None);
    };
    let linkedin = connector.linkedin_app()?;
    let body = Body::Form(vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &linkedin.client_id),
        ("client_secret", &linkedin.client_secret),
    ]);
    let answer = token_call(connector, &body, Grant::Refresh).await?;
    credential_of(
        &answer,
        Some(refresh_token),
        scopes,
        OffsetDateTime::now_utc(),
    )
    .map(Some)
}

/// `POST {oauth}/oauth/v2/accessToken` with `body` (the client in the form, as LinkedIn takes it).
async fn token_call(
    connector: &LinkedinConnector,
    body: &Body<'_>,
    grant: Grant,
) -> Result<Answer, ConnectorError> {
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

/// The credential of a token answer as of `now`: its access token, its refresh token (else
/// `held_refresh`), `now + expires_in` (when it names a positive number of seconds that `now` can
/// be moved by) and the scopes its `scope` grants (space- or comma-separated), else
/// `held_scopes`.
fn credential_of(
    answer: &Answer,
    held_refresh: Option<&str>,
    held_scopes: &[String],
    now: OffsetDateTime,
) -> Result<Credential, ConnectorError> {
    let answer = answer.json()?;
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
    let mut granted: Vec<String> = Vec::new();
    for scope in answer["scope"]
        .as_str()
        .unwrap_or_default()
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
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
        access_token: access_token.to_owned(),
        refresh_token,
        expires_at,
        scopes,
    })
}

impl LinkedinConnector {
    /// The LinkedIn app, read now; `Permanent` when the platform has none.
    pub(crate) fn linkedin_app(&self) -> Result<LinkedinApp, ConnectorError> {
        self.apps
            .linkedin_app()
            .ok_or_else(|| ConnectorError::permanent("the LinkedIn app is not configured"))
    }
}

#[cfg(test)]
mod tests {
    use jt_outbound::header::HeaderMap;
    use serde_json::{Value, json};
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-10-27 12:00:00 UTC);

    fn answer(json: Value) -> Answer {
        Answer {
            headers: HeaderMap::new(),
            json: Some(json),
        }
    }

    #[test]
    fn queries_encode_spaces_as_percent_20() {
        assert_eq!(
            query(&[("scope", "a b"), ("x", "1+2 &=")]),
            "scope=a%20b&x=1%2B2%20%26%3D"
        );
    }

    #[test]
    fn token_answers_become_credentials() {
        let full = answer(json!({
            "access_token": "a", "expires_in": 5_184_000, "refresh_token": "r",
            "refresh_token_expires_in": 31_536_000, "scope": "openid,profile w_member_social",
        }));
        assert_eq!(
            credential_of(&full, Some("old"), &[], NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: Some("r".into()),
                expires_at: Some(datetime!(2026-12-26 12:00:00 UTC)),
                scopes: vec!["openid".into(), "profile".into(), "w_member_social".into()],
            }
        );
        let held = vec!["openid".to_owned()];
        let bare = answer(json!({ "access_token": "a", "expires_in": "60" }));
        assert_eq!(
            credential_of(&bare, None, &held, NOW).unwrap(),
            Credential::OAuth {
                access_token: "a".into(),
                refresh_token: None,
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
            let Credential::OAuth { expires_at, .. } = credential_of(
                &answer(json!({ "access_token": "a", "expires_in": absurd })),
                None,
                &held,
                NOW,
            )
            .unwrap() else {
                unreachable!()
            };
            assert_eq!(expires_at, None);
        }
        assert_eq!(
            credential_of(&answer(json!({ "access_token": "" })), None, &held, NOW)
                .unwrap_err()
                .kind(),
            "permanent"
        );
        let empty = Answer {
            headers: HeaderMap::new(),
            json: None,
        };
        assert_eq!(
            credential_of(&empty, None, &held, NOW).unwrap_err().kind(),
            "permanent"
        );
    }

    #[test]
    fn flows_ask_for_organization_scopes_only_when_their_app_says() {
        let mut app = LinkedinApp {
            client_id: "id".into(),
            client_secret: "s".into(),
            organization_scopes: false,
            api_version: None,
        };
        assert_eq!(scopes_for(&app), MEMBER_SCOPES);
        app.organization_scopes = true;
        assert_eq!(
            scopes_for(&app),
            [MEMBER_SCOPES, ORGANIZATION_SCOPES].concat()
        );
    }
}
