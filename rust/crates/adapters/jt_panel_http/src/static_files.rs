//! The built panel: files from [`AppState::panel_dir`](crate::AppState::panel_dir), with
//! `index.html` answering every other page path so the panel can route on the client.
//!
//! - `index.html` and other files outside `/assets/` are sent with [`PAGE_CACHE`]
//!   (`no-cache`: revalidated on every load, so a new release shows at once).
//! - Files under `/assets/` carry content hashes in their names and are sent with
//!   [`ASSET_CACHE`]; a missing asset is a `404`, never the index, so a stale page cannot cache
//!   HTML under a script's name.
//! - Paths of the API, MCP and health endpoints ([`is_reserved`]) never reach the panel: they
//!   are a structured `404` when no route matched them.

use std::path::Path;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jt_app::error::AppError;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::error::ApiError;

/// `Cache-Control` of `index.html` and every other file outside `/assets/`.
pub const PAGE_CACHE: &str = "no-cache";
/// `Cache-Control` of the content-hashed files under `/assets/`.
pub const ASSET_CACHE: &str = "public, max-age=31536000, immutable";
/// Where the content-hashed files live.
pub const ASSETS_PREFIX: &str = "/assets/";
/// Path prefixes that belong to the server, not the panel.
const RESERVED: &[&str] = &["/api", "/mcp", "/healthz"];

/// The file services over one panel directory.
#[derive(Clone, Debug)]
pub struct Panel {
    /// Files, with `index.html` for anything missing.
    pages: ServeDir<ServeFile>,
    /// Files only.
    assets: ServeDir,
}

impl Panel {
    pub fn new(dir: &Path) -> Panel {
        Panel {
            pages: ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))),
            assets: ServeDir::new(dir),
        }
    }
}

/// Whether `path` is, or lies under, one of the server's own prefixes.
pub fn is_reserved(path: &str) -> bool {
    RESERVED.iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// Answers a request no route matched: from the panel when there is one and the path is not
/// reserved, else a structured `404`.
pub async fn serve(panel: Option<Panel>, req: Request) -> Response {
    let path = req.uri().path();
    let asset = path.starts_with(ASSETS_PREFIX);
    let panel = match panel {
        Some(panel) if !is_reserved(path) => panel,
        _ => return not_found(),
    };
    let served = if asset {
        panel.assets.oneshot(req).await
    } else {
        panel.pages.oneshot(req).await
    };
    let mut resp = match served {
        Ok(resp) => resp,
        Err(never) => match never {},
    };
    if resp.status() == StatusCode::NOT_FOUND {
        return not_found();
    }
    if resp.status().is_success() || resp.status() == StatusCode::NOT_MODIFIED {
        let cache = if asset { ASSET_CACHE } else { PAGE_CACHE };
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    resp.map(Body::new)
}

fn not_found() -> Response {
    ApiError(AppError::not_found("no such route")).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_paths_are_reserved_and_lookalikes_are_not() {
        for path in [
            "/api",
            "/api/",
            "/api/x",
            "/mcp",
            "/mcp/x",
            "/healthz",
            "/healthz/x",
        ] {
            assert!(is_reserved(path), "{path}");
        }
        for path in ["/", "/apis", "/team", "/mcpx", "/healthzz", "/assets/api"] {
            assert!(!is_reserved(path), "{path}");
        }
    }
}
