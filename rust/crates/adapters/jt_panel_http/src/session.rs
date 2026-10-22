//! The panel session: the `jt_session` cookie and the extractors that turn it into a caller.
//!
//! The cookie holds the plaintext session token (only its hash is stored) and is `HttpOnly`,
//! `SameSite=Strict`, `Path=/`, lives as long as the session, and is `Secure` when
//! [`AppState::cookie_secure`] is set.

use axum::extract::{FromRequestParts, MatchedPath};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, header};
use jt_app::catalog::{CATALOG, UseCase};
use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::gate::{StrategyGate, check_gate};
use jt_app::usecases::auth::{self, Principal, SESSION_LIFETIME};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

use crate::error::ApiError;
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

/// The context of a call in the signed-in user's current workspace, admitted by the gate.
///
/// `401` without a valid session; `409 CONFLICT` ("no current workspace") when the session has
/// none. The route's use case is looked up in [`CATALOG`] by method and path and must pass
/// [`check_gate`] (with the workspace's status and [`AppState::gate`]); a route missing from the
/// catalog is refused as `INTERNAL`.
#[derive(Clone, Debug)]
pub struct WorkspaceCtx(pub Ctx);

impl FromRequestParts<AppState> for WorkspaceCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let Authed(principal) = Authed::from_request_parts(parts, state).await?;
        // `resolve_session` keeps a current workspace only while it is one of the memberships.
        let (ws, status) = principal
            .current_workspace
            .and_then(|ws| principal.memberships.iter().find(|m| m.workspace_id == ws))
            .map(|m| (m.workspace_id, m.workspace_status))
            .ok_or_else(|| AppError::conflict("no current workspace"))?;
        let ctx = auth::ctx_for(&principal, ws, state.deps.clock.now())?;
        let path = parts
            .extensions
            .get::<MatchedPath>()
            .map(MatchedPath::as_str);
        gate_route(
            CATALOG,
            &parts.method,
            path,
            status,
            state.gate.as_ref(),
            ws,
        )
        .await?;
        Ok(WorkspaceCtx(ctx))
    }
}

/// Runs [`check_gate`] for the use case whose panel route is `method path` in `catalog`.
async fn gate_route(
    catalog: &[UseCase],
    method: &Method,
    path: Option<&str>,
    status: WorkspaceStatus,
    gate: &dyn StrategyGate,
    ws: WorkspaceId,
) -> Result<(), AppError> {
    let route = path.unwrap_or("<unmatched>");
    let use_case = catalog
        .iter()
        .find(|uc| uc.panel_route == Some((method.as_str(), route)))
        .ok_or_else(|| {
            AppError::internal(format!(
                "route {method} {route} has no use case in the catalog"
            ))
        })?;
    check_gate(use_case, status, gate, ws).await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use jt_app::catalog::{GateMode, Risk};
    use jt_app::error::ErrorCode;
    use jt_app::gate::NoStrategyYet;

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

    /// A gate under which every workspace has an approved strategy.
    struct Approved;

    #[async_trait]
    impl StrategyGate for Approved {
        async fn has_approved_strategy(&self, _ws: WorkspaceId) -> Result<bool, AppError> {
            Ok(true)
        }
    }

    const GATED: UseCase = UseCase {
        id: "demo.run",
        gate: GateMode::Gated,
        mcp_tool: Some("jeeta.demo.run"),
        panel_route: Some(("POST", "/api/demo")),
        panel_only: false,
        risk: Risk::Write,
    };
    const EXEMPT: UseCase = UseCase {
        id: "demo.read",
        gate: GateMode::Exempt,
        mcp_tool: Some("jeeta.demo.read"),
        panel_route: Some(("GET", "/api/demo")),
        panel_only: false,
        risk: Risk::Read,
    };

    #[tokio::test]
    async fn routes_pass_the_gate_of_their_use_case() {
        let catalog = [GATED, EXEMPT];
        let ws = WorkspaceId::new_v7();
        let code = |r: Result<(), AppError>| r.unwrap_err().code;
        let post = Method::POST;
        let get = Method::GET;
        let path = Some("/api/demo");

        let r = gate_route(
            &catalog,
            &post,
            path,
            WorkspaceStatus::Active,
            &NoStrategyYet,
            ws,
        );
        assert_eq!(code(r.await), ErrorCode::StrategyRequired);
        let r = gate_route(
            &catalog,
            &post,
            path,
            WorkspaceStatus::PendingPayment,
            &Approved,
            ws,
        );
        assert_eq!(code(r.await), ErrorCode::WorkspaceInactive);
        let r = gate_route(
            &catalog,
            &post,
            path,
            WorkspaceStatus::Active,
            &Approved,
            ws,
        );
        assert!(r.await.is_ok());
        let r = gate_route(
            &catalog,
            &get,
            path,
            WorkspaceStatus::PendingPayment,
            &NoStrategyYet,
            ws,
        );
        assert!(r.await.is_ok(), "exempt use cases skip the gate");

        // A route the catalog does not know fails closed.
        for (method, path) in [
            (&Method::DELETE, path),
            (&get, Some("/api/other")),
            (&get, None),
        ] {
            let r = gate_route(
                &catalog,
                method,
                path,
                WorkspaceStatus::Active,
                &Approved,
                ws,
            );
            assert_eq!(code(r.await), ErrorCode::Internal);
        }
    }
}
