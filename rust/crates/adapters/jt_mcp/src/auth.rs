//! Bearer-key authentication in front of the MCP service.
//!
//! Every request to the MCP endpoint must carry `Authorization: Bearer jt_live_…`. The key is
//! resolved by `api_keys::authenticate` before the request reaches the MCP layer; a missing,
//! malformed, unknown or revoked key is answered `401` with the structured error
//! `{"code":"UNAUTHENTICATED","message":"invalid api key","details":{}}` and nothing else
//! happens. On success the [`AgentPrincipal`] is put into the request's extensions, where the
//! MCP handler finds it (rmcp hands the handler the request's `http::request::Parts`).
//!
//! The same check binds sessions to keys ([`crate::sessions`]): a response that carries a new
//! `Mcp-Session-Id` binds that session to the request's key, a `DELETE` drops the binding, and a
//! request naming a session that is not bound to its own key (bound to another key, or bound to
//! none: never created here, evicted or deleted) is answered `404` "unknown session" before rmcp
//! sees it. The check fails closed: only a binding to the request's own key lets a session id
//! through, so a client whose binding is gone re-initialises.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::Response;
use jt_app::error::AppError;
use jt_app::usecases::api_keys::{self, AgentPrincipal};

use crate::McpState;
use crate::errors::http_error;

/// The answer to every bearer that cannot be used, so it never tells why.
pub const INVALID_KEY: &str = api_keys::INVALID_KEY;

/// The header naming an MCP session.
pub const SESSION_HEADER: &str = "mcp-session-id";
/// The answer to a request naming a session that is not bound to its key: of another key, or
/// unknown.
pub const UNKNOWN_SESSION: &str = "unknown session";

/// Authenticates the request's bearer key, keeps sessions to their own key, and stores the
/// principal in the request's extensions; or answers `401` (`500` when the key cannot be
/// checked at all), or `404` for a session id that is not bound to this key.
pub async fn require_api_key(
    State(state): State<McpState>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(bearer) = bearer_token(req.headers()) else {
        return http_error(AppError::unauthenticated(INVALID_KEY));
    };
    let principal = match api_keys::authenticate(&state.deps, bearer).await {
        Ok(principal) => principal,
        Err(err) => return http_error(err),
    };
    let key = principal.api_key_id;
    let session = session_id(req.headers()).map(str::to_owned);
    // Fail closed: a session id passes only when it is bound to this very key. An id bound to
    // no key (evicted, deleted, or never created here) is refused like another key's, so
    // evicting a binding never opens its session to anyone.
    if let Some(id) = &session
        && state.sessions().owner(id) != Some(key)
    {
        return http_error(AppError::not_found(UNKNOWN_SESSION));
    }
    let deleting = req.method() == Method::DELETE;
    req.extensions_mut().insert::<AgentPrincipal>(principal);

    let resp = next.run(req).await;
    if let Some(created) = session_id(resp.headers()) {
        state.sessions().bind(created, key);
    }
    if deleting && let Some(id) = &session {
        state.sessions().forget(id);
    }
    resp
}

/// The `Mcp-Session-Id` of a request or response, if it names one.
fn session_id(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|id| !id.is_empty())
}

/// The token of an `Authorization: Bearer <token>` header (scheme in any case), if there is a
/// non-empty one (`api_keys::bearer_of`, which the voice bridge's routes read their key with too).
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    api_keys::bearer_of(value)
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
