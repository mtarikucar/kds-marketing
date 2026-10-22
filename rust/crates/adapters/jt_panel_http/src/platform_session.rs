//! The platform operator's session: the `jt_platform` cookie and the extractor that turns it
//! into a [`PlatformCtx`].
//!
//! The cookie holds the plaintext operator session token (only its hash is stored) and carries
//! the same attributes as the panel's `jt_session` cookie: `HttpOnly`, `SameSite=Strict`,
//! `Path=/`, a `Max-Age` of the session's life (12 hours), and `Secure` when
//! [`AppState::cookie_secure`] is set. It is a separate cookie over a separate table, so a
//! user's session never passes as an operator's, nor the other way round.

use axum::extract::FromRequestParts;
use axum::http::HeaderValue;
use axum::http::request::Parts;
use jt_app::ctx::PlatformCtx;
use jt_app::error::AppError;
use jt_app::usecases::platform::{self, PLATFORM_SESSION_LIFETIME};

use crate::error::ApiError;
use crate::session::{read_cookie, set_cookie};
use crate::state::AppState;

/// The name of the platform operator's session cookie.
pub const PLATFORM_COOKIE: &str = "jt_platform";

/// The `Set-Cookie` value that hands a new operator session's token to the browser.
pub fn platform_cookie(token: &str, secure: bool) -> Result<HeaderValue, AppError> {
    set_cookie(
        PLATFORM_COOKIE,
        token,
        PLATFORM_SESSION_LIFETIME.whole_seconds(),
        secure,
    )
}

/// The signed-in platform operator behind the request's `jt_platform` cookie. A missing,
/// unknown or expired operator session is `401 UNAUTHENTICATED`.
#[derive(Clone, Copy, Debug)]
pub struct PlatformAuthed(pub PlatformCtx);

impl FromRequestParts<AppState> for PlatformAuthed {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = read_cookie(&parts.headers, PLATFORM_COOKIE)
            .ok_or_else(|| AppError::unauthenticated("not signed in as a platform operator"))?;
        Ok(PlatformAuthed(platform::resolve(&state.deps, token).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_platform_cookie_carries_the_panel_attributes_for_twelve_hours() {
        assert_eq!(
            platform_cookie("abc-_123", false).unwrap(),
            "jt_platform=abc-_123; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"
        );
        assert_eq!(
            platform_cookie("abc", true).unwrap(),
            "jt_platform=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure"
        );
    }
}
