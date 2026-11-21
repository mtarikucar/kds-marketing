//! The workspace's own shop, reached over MCP (`Provider::Mcp`, capability kind `shop_mcp`): the
//! port the inbox's automatic replies create an order draft through (`usecases::inbox::autoreply`,
//! migration `0050_auto_reply_orders`).
//!
//! The shop is a tenant-named endpoint (`connector_public.endpoint`, `https` only) reached with a
//! bearer token ([`Credential::Bearer`]) under the workspace's tenant egress scope. Every detail of
//! MCP (the JSON-RPC envelope, `initialize`, the session header, SSE answers) stays in its adapter;
//! here are only a tool name, its arguments and the tool's result. The order a call carries holds
//! a customer's details: a [`ShopCall`] is held in memory for the one call and never stored,
//! logged or shown (its `Debug` names the tool alone).

use std::fmt;

use async_trait::async_trait;
use jt_connector::Credential;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use url::Url;

/// One tool call: the tool's name and its arguments. The arguments may hold a customer's
/// details, so `Debug` prints the tool's name alone.
#[derive(Clone, PartialEq)]
pub struct ShopCall {
    pub tool: String,
    pub arguments: Value,
}

impl fmt::Debug for ShopCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ShopCall")
            .field("tool", &self.tool)
            .field("arguments", &Hidden)
            .finish()
    }
}

/// What a hidden field prints as.
struct Hidden;

impl fmt::Debug for Hidden {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

/// Why a shop call gave no result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShopError {
    /// The token was refused (`401`, `403`).
    Auth,
    /// The shop refused the request (another `4xx`, or a JSON-RPC error, its code when it gave
    /// one): nothing was done.
    Rejected { code: Option<String> },
    /// The shop could not be reached before the call itself was sent (the host, the connection,
    /// `initialize`): nothing was done.
    Unavailable,
    /// The call was sent but its outcome is not known (a timeout, a broken connection, a `5xx`):
    /// the shop may have acted on it. Never retried automatically.
    Unknown,
    /// The shop answered something that is not an MCP answer.
    Malformed,
}

impl ShopError {
    /// The stable code, e.g. `"rejected"`.
    pub fn key(&self) -> &'static str {
        match self {
            ShopError::Auth => "auth",
            ShopError::Rejected { .. } => "rejected",
            ShopError::Unavailable => "unavailable",
            ShopError::Unknown => "unknown",
            ShopError::Malformed => "malformed",
        }
    }
}

/// A shop's MCP endpoint.
#[async_trait]
pub trait ShopClient: Send + Sync {
    /// The names of the tools the endpoint lists for `cred`.
    async fn list_tools(
        &self,
        ws: WorkspaceId,
        endpoint: &Url,
        cred: &Credential,
    ) -> Result<Vec<String>, ShopError>;
    /// Calls tool `call.tool` with `call.arguments` once (never retried) and answers the tool's
    /// result object as the endpoint gave it (`content`, `structuredContent`, `isError`): a tool
    /// that reports an error (`isError: true`) is an `Ok` answer the caller reads.
    async fn call_tool(
        &self,
        ws: WorkspaceId,
        endpoint: &Url,
        cred: &Credential,
        call: &ShopCall,
    ) -> Result<Value, ShopError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_call_prints_its_tool_alone() {
        let call = ShopCall {
            tool: "create".into(),
            arguments: json!({"email": "someone@example.com"}),
        };
        let printed = format!("{call:?}");
        assert!(printed.contains("create"), "{printed}");
        assert!(!printed.contains("example.com"), "{printed}");
    }
}
