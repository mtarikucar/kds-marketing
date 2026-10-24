//! The streamable HTTP endpoint: rmcp's service at [`MCP_PATH`], behind the bearer-key check.

use std::sync::Arc;

use axum::Router;
use axum::middleware;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};

use crate::McpState;
use crate::auth::require_api_key;
use crate::handler::McpHandler;

/// Where the MCP endpoint is served.
pub const MCP_PATH: &str = "/mcp";

/// The MCP endpoint at [`MCP_PATH`]: every request is authenticated by its bearer key first
/// ([`crate::auth`]), then served by rmcp's streamable HTTP transport, with a session per
/// client that initialises (and stateless serving for clients that do not). The router has no
/// fallback, so the binary can merge it with the panel's.
pub fn http_service(state: McpState) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_max_request_body_bytes(280_000_000)
        .with_allowed_hosts(state.allowed_hosts().iter().cloned());
    let handler_state = state.clone();
    let service = StreamableHttpService::new(
        move || Ok(McpHandler::new(handler_state.clone(), None)),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new()
        .route_service(MCP_PATH, service)
        .route_layer(middleware::from_fn_with_state(state, require_api_key))
}
