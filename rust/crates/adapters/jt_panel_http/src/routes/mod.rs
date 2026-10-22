//! The route table: [`ROUTES`] lists every method and path the router serves, and the router
//! registers exactly the entries of [`api_routes`] and [`root_routes`], whose methods and paths
//! must equal it (pinned by `router_matches_routes_table`).

pub mod auth;
pub mod workspace;

use axum::Json;
use axum::handler::Handler;
use axum::http::Method;
use axum::routing::{MethodFilter, MethodRouter, on};
use serde_json::{Value, json};

use crate::state::AppState;

/// Every route the panel HTTP adapter serves, as (method, path), in axum's path syntax as
/// `CATALOG.panel_route` writes it. The twin-rule test compares it with the catalog.
pub const ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/switch-workspace"),
    ("GET", "/api/workspace"),
    ("GET", "/healthz"),
];

/// One route to register: its method, its path (relative to its router) and its handler.
pub struct RouteDef {
    pub method: &'static str,
    pub path: &'static str,
    pub handler: MethodRouter<AppState>,
}

/// A route answering only `method` (a standard method name) at `path`.
fn route<H, T>(method: &'static str, path: &'static str, handler: H) -> RouteDef
where
    H: Handler<T, AppState>,
    T: 'static,
{
    let filter = Method::from_bytes(method.as_bytes())
        .ok()
        .and_then(|m| MethodFilter::try_from(m).ok())
        .unwrap_or_else(|| panic!("route method {method} is not a standard method"));
    RouteDef {
        method,
        path,
        handler: on(filter, handler),
    }
}

/// The JSON API's routes, with paths relative to [`crate::API_PREFIX`].
pub fn api_routes() -> Vec<RouteDef> {
    vec![
        route("POST", "/auth/register", auth::register),
        route("POST", "/auth/login", auth::login),
        route("POST", "/auth/logout", auth::logout),
        route("GET", "/auth/me", auth::me),
        route("POST", "/auth/switch-workspace", auth::switch_workspace),
        route("GET", "/workspace", workspace::info),
    ]
}

/// The routes outside the API.
pub fn root_routes() -> Vec<RouteDef> {
    vec![route("GET", "/healthz", healthz)]
}

/// `200 {"ok":true}` while the process serves requests.
async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use jt_app::gate::NoStrategyYet;
    use jt_app::usecases::Deps;
    use jt_testkit::fakes::{FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, SeqIdGen};
    use time::macros::datetime;
    use tower::ServiceExt;

    use super::*;
    use crate::{API_PREFIX, router};

    fn registered() -> Vec<(&'static str, String)> {
        let api = api_routes()
            .into_iter()
            .map(|r| (r.method, format!("{API_PREFIX}{}", r.path)));
        let root = root_routes()
            .into_iter()
            .map(|r| (r.method, r.path.to_owned()));
        api.chain(root).collect()
    }

    #[tokio::test]
    async fn router_matches_routes_table() {
        // The router registers exactly the table's entries, each once.
        let table: Vec<(&str, String)> =
            ROUTES.iter().map(|(m, p)| (*m, (*p).to_owned())).collect();
        assert_eq!(registered(), table);
        let unique: BTreeSet<_> = table.iter().collect();
        assert_eq!(unique.len(), table.len(), "no route is listed twice");

        // And each entry is really served with its method: no 404 or 405 from the fallbacks.
        let state = AppState {
            deps: Deps {
                uow: Arc::new(InMemoryUow::new()),
                clock: Arc::new(FixedClock(datetime!(2026-10-22 09:00 UTC))),
                ids: Arc::new(SeqIdGen::new()),
                tokens: Arc::new(FixedTokenGen::new(["t1", "t2", "t3"])),
                hasher: Arc::new(PlainHasher),
            },
            gate: Arc::new(NoStrategyYet),
            cookie_secure: false,
            panel_dir: None,
        };
        let app = router(state);
        for (method, path) in ROUTES {
            let req = Request::builder()
                .method(*method)
                .uri(*path)
                .header("x-requested-with", "jeeta-panel")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap();
            let status = app.clone().oneshot(req).await.unwrap().status();
            assert!(
                status != StatusCode::NOT_FOUND && status != StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path} answered {status}"
            );
        }
    }
}
