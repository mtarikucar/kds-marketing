//! Bearer-key authentication in front of the MCP service.
//!
//! Every request to the MCP endpoint must carry `Authorization: Bearer jt_live_…`. The key is
//! resolved by `api_keys::authenticate` before the request reaches the MCP layer; a missing,
//! malformed, unknown or revoked key is answered `401` with the structured error
//! `{"code":"UNAUTHENTICATED","message":"invalid api key","details":{}}` and nothing else
//! happens. On success the [`AgentPrincipal`] is put into the request's extensions, where the
//! MCP handler finds it (rmcp hands the handler the request's `http::request::Parts`).

use axum::extract::{Request, State};
use axum::http::{HeaderMap, header};
use axum::middleware::Next;
use axum::response::Response;
use jt_app::error::AppError;
use jt_app::usecases::api_keys::{self, AgentPrincipal};

use crate::McpState;
use crate::errors::http_error;

/// The answer to every bearer that cannot be used, so it never tells why.
pub const INVALID_KEY: &str = "invalid api key";

/// Authenticates the request's bearer key and stores the principal in its extensions, or
/// answers `401` (`500` when the key cannot be checked at all).
pub async fn require_api_key(
    State(state): State<McpState>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(bearer) = bearer_token(req.headers()) else {
        return http_error(AppError::unauthenticated(INVALID_KEY));
    };
    match api_keys::authenticate(&state.deps, bearer).await {
        Ok(principal) => {
            req.extensions_mut().insert::<AgentPrincipal>(principal);
            next.run(req).await
        }
        Err(err) => http_error(err),
    }
}

/// The token of an `Authorization: Bearer <token>` header (scheme in any case), if there is a
/// non-empty one.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    match token.trim() {
        "" => None,
        token => Some(token),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn bearer_token_takes_the_token_of_a_bearer_header_only() {
        assert_eq!(
            bearer_token(&headers("Bearer jt_live_x")),
            Some("jt_live_x")
        );
        assert_eq!(
            bearer_token(&headers("bearer  jt_live_x ")),
            Some("jt_live_x")
        );
        assert_eq!(
            bearer_token(&headers("BEARER jt_live_x")),
            Some("jt_live_x")
        );
        for bad in ["Bearer", "Bearer   ", "Basic dXNlcg==", "jt_live_x", ""] {
            assert_eq!(bearer_token(&headers(bad)), None, "{bad:?}");
        }
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }
}
