//! Panel HTTP adapter: axum JSON API, session cookie, request-header check and static panel files.
//!
//! [`router`] serves:
//! - `/api/*`: the JSON API of [`ROUTES`]. Every mutating request must carry
//!   `X-Requested-With: jeeta-panel` ([`csrf`]), checked before authentication and body
//!   parsing. Errors, including bad bodies and unknown paths, are structured:
//!   `{ "code", "message", "details" }`.
//! - `/healthz`: `200 {"ok":true}`.
//! - Everything else: the built panel from [`AppState::panel_dir`] ([`static_files`]), or a
//!   structured `404` when there is none.

pub mod csrf;
pub mod error;
pub mod routes;
pub mod session;
pub mod state;
pub mod static_files;

use axum::Router;
use axum::extract::Request;
use axum::middleware;

pub use error::{ApiError, ApiJson};
pub use routes::ROUTES;
pub use session::{Authed, WorkspaceCtx};
pub use state::AppState;

/// The path under which the JSON API lives.
pub const API_PREFIX: &str = "/api";

/// The panel's HTTP service: the routes of [`ROUTES`], the request-header check on the API and
/// the static panel (see the crate docs).
pub fn router(state: AppState) -> Router {
    let mut api = Router::new();
    for route in routes::api_routes() {
        api = api.route(route.path, route.handler);
    }
    let api = api
        .fallback(error::not_found)
        .method_not_allowed_fallback(error::not_found)
        // Wraps every API route and the API fallbacks, so it runs before any extractor
        // (authentication, body parsing) and also covers unknown API paths.
        .layer(middleware::from_fn(csrf::require_requested_with));

    let mut app = Router::new();
    for route in routes::root_routes() {
        app = app.route(route.path, route.handler);
    }
    let panel = state.panel_dir.as_deref().map(static_files::Panel::new);
    app.method_not_allowed_fallback(error::not_found)
        .nest(API_PREFIX, api)
        .fallback(move |req: Request| static_files::serve(panel.clone(), req))
        .with_state(state)
}
