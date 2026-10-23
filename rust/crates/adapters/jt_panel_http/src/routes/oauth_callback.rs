//! `GET /api/connectors/oauth/callback/{provider}?state=&code=`: completing an OAuth flow, the
//! panel's only (`connector.complete_oauth` has no MCP tool: an agent never holds the owner's
//! browser session).
//!
//! The provider sends the owner's browser back to the panel's page
//! (`/oauth/callback/{provider}`, `connector::OAUTH_CALLBACK_PATH`), not here: that cross-site
//! redirect carries no `SameSite=Strict` session cookie. The page reads `state` and `code` from its
//! address and calls this route itself, a same-site request with the session. The route's gate
//! needs that session (`401` without it) and an active current workspace (`423` otherwise); the
//! use case then needs the state to be signed for that workspace and this provider, unexpired and
//! unused (`403` otherwise, whatever the reason).
//!
//! The query takes exactly `state` and `code` (anything else, or one missing, is `422`), and an
//! unknown provider is `422`. The answer is the assets the flow found, for the owner to choose
//! from (`{pending_id, assets: [{kind_key, external_id, name, public}]}`), never a credential,
//! marked `Cache-Control: no-store`.

use axum::Json;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use jt_app::usecases::connector::{self, CompleteOAuth};
use jt_connector::Provider;
use serde::Deserialize;

use crate::error::{ApiError, ApiPath, ApiQuery};
use crate::session::Authed;
use crate::state::AppState;

/// The provider's answer as the page passes it on. No `Debug`: both values are secrets until the
/// flow is completed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallbackQuery {
    pub state: String,
    pub code: String,
}

/// `200` with the assets of the completed flow.
pub async fn callback(
    State(state): State<AppState>,
    Authed(principal): Authed,
    ApiPath(provider): ApiPath<Provider>,
    ApiQuery(query): ApiQuery<CallbackQuery>,
) -> Result<Response, ApiError> {
    let input = CompleteOAuth {
        provider,
        state: query.state,
        code: query.code,
        principal: &principal,
    };
    let out = connector::complete_oauth(&state.deps, input).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(out)).into_response())
}
