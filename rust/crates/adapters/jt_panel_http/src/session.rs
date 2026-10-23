//! The panel session: the `jt_session` cookie and the extractors that turn it into a caller.
//!
//! The cookie holds the plaintext session token (only its hash is stored) and is `HttpOnly`,
//! `SameSite=Strict`, `Path=/`, lives as long as the session, and is `Secure` when
//! [`AppState::cookie_secure`] is set.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::auth::{self, Principal, SESSION_LIFETIME};

use crate::error::ApiError;
use crate::gate::current_workspace;
use crate::state::AppState;

/// The name of the panel session cookie.
pub const SESSION_COOKIE: &str = "jt_session";

/// A `Set-Cookie` value for cookie `name` holding `value` for `max_age_secs` seconds, with the
/// panel's attributes: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` when `secure`.
///
/// `INTERNAL` when `value` is not a plain cookie value (printable ASCII without whitespace, `"`,
/// `,`, `;` or `\`).
pub fn set_cookie(
    name: &str,
    value: &str,
    max_age_secs: i64,
    secure: bool,
) -> Result<HeaderValue, AppError> {
    let plain = |b: u8| b.is_ascii_graphic() && !matches!(b, b'"' | b',' | b';' | b'\\');
    if !value.bytes().all(plain) {
        return Err(AppError::internal(
            "cookie value has characters a cookie cannot hold",
        ));
    }
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age_secs}{secure}"
    ))
    .map_err(|e| AppError::internal(format!("cookie header is invalid: {e}")))
}

/// The `Set-Cookie` value that hands a new session's token to the browser.
pub fn session_cookie(token: &str, secure: bool) -> Result<HeaderValue, AppError> {
    set_cookie(
        SESSION_COOKIE,
        token,
        SESSION_LIFETIME.whole_seconds(),
        secure,
    )
}

/// The `Set-Cookie` value that removes the session cookie.
pub fn clear_session_cookie(secure: bool) -> Result<HeaderValue, AppError> {
    set_cookie(SESSION_COOKIE, "", 0, secure)
}

/// The non-empty value of the first cookie called `name` in the request's `Cookie` headers.
pub fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
}

/// The signed-in user behind the request's session cookie. A missing, unknown, revoked or
/// expired session is `401 UNAUTHENTICATED`.
#[derive(Clone, Debug)]
pub struct Authed(pub Principal);

/// The principal already resolved for this request, so several extractors share one lookup.
#[derive(Clone)]
struct Resolved(Principal);

impl FromRequestParts<AppState> for Authed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        if let Some(Resolved(principal)) = parts.extensions.get::<Resolved>() {
            return Ok(Authed(principal.clone()));
        }
        let token = read_cookie(&parts.headers, SESSION_COOKIE)
            .ok_or_else(|| AppError::unauthenticated("not signed in"))?;
        let principal = auth::resolve_session(&state.deps, token).await?;
        parts.extensions.insert(Resolved(principal.clone()));
        Ok(Authed(principal))
    }
}

/// The context of a call in the signed-in user's current workspace.
///
/// `401` without a valid session; `409 CONFLICT` ("no current workspace") when the session has
/// none. The gate is not this extractor's: the per-route layer of [`crate::gate`] has already
/// admitted the request by the time a handler runs, whatever it extracts.
#[derive(Clone, Debug)]
pub struct WorkspaceCtx(pub Ctx);

impl FromRequestParts<AppState> for WorkspaceCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let Authed(principal) = Authed::from_request_parts(parts, state).await?;
        let (ws, _status) = current_workspace(&principal)?;
        Ok(WorkspaceCtx(auth::ctx_for(
            &principal,
            ws,
            state.deps.clock.now(),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use jt_app::error::ErrorCode;

    use super::*;

    #[test]
    fn cookies_carry_the_panel_attributes() {
        let cookie = session_cookie("abc-_123", false).unwrap();
        assert_eq!(
            cookie,
            "jt_session=abc-_123; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
        );
        let cookie = session_cookie("abc", true).unwrap();
        assert_eq!(
            cookie,
            "jt_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure"
        );
        assert_eq!(
            clear_session_cookie(true).unwrap(),
            "jt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure"
        );
        for bad in ["a b", "a;b", "a,b", "a\"b", "a\\b", "ä"] {
            let err = set_cookie("x", bad, 1, false).unwrap_err();
            assert_eq!(err.code, ErrorCode::Internal, "{bad:?}");
        }
    }

    #[test]
    fn the_session_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        assert_eq!(read_cookie(&headers, SESSION_COOKIE), None);
        headers.append(header::COOKIE, HeaderValue::from_static("theme=dark"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=1;  jt_session=tok-1 ; jt_session=tok-2"),
        );
        assert_eq!(read_cookie(&headers, SESSION_COOKIE), Some("tok-1"));
        assert_eq!(read_cookie(&headers, "theme"), Some("dark"));
        assert_eq!(read_cookie(&headers, "jt"), None);

        let mut empty = HeaderMap::new();
        empty.insert(header::COOKIE, HeaderValue::from_static("jt_session="));
        assert_eq!(read_cookie(&empty, SESSION_COOKIE), None);
    }
}
