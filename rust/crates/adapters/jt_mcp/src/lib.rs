//! MCP adapter: the agent gate. An rmcp server over streamable HTTP ([`http_service`]) and
//! stdio ([`run_stdio`]), authenticated by bearer API keys ([`auth`]), exposing one tool per
//! use case of the catalog that has an MCP tool ([`registry()`]).
//!
//! Each HTTP session is bound to the key that created it ([`sessions`]).
//!
//! Every tool call goes through the same path ([`handler`]): the strategy gate and the
//! workspace's status (`check_gate`), the tool's permission, the use case, and a ledger entry
//! `mcp.tool_call`. Every error is structured: `{ "code", "message", "details" }` ([`errors`]).
//!
//! This crate depends on the application core only; it has no HTTP client and no database.

pub mod auth;
pub mod errors;
pub mod handler;
pub mod http;
pub mod registry;
pub mod sessions;
mod state;
pub mod stdio;
mod tools;

pub use http::{MCP_PATH, http_service};
pub use registry::{
    NOT_YET_DEFINED, ToolFuture, ToolRun, ToolSpec, registry, registry_with, risk_tag,
};
pub use state::{LOOPBACK_HOSTS, McpState};
pub use stdio::{run_io, run_stdio};
