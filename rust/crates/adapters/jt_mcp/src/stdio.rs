//! The same handler over stdin/stdout, for an agent that runs Jeeta as a local process.
//!
//! There is no HTTP request to authenticate: the binary resolves the principal once, from the
//! key in `JEETA_STDIO_API_KEY`, and every request of the stream acts as it.

use jt_app::usecases::api_keys::AgentPrincipal;
use rmcp::ServiceExt;
use rmcp::transport::stdio;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::McpState;
use crate::handler::McpHandler;

/// Serves MCP over this process's stdin and stdout until the client closes the stream.
pub async fn run_stdio(state: McpState, principal: AgentPrincipal) -> std::io::Result<()> {
    run_io(state, principal, stdio()).await
}

/// Serves MCP over any byte stream pair (stdin/stdout, a pipe in a test) as `principal`, until
/// the client closes it.
pub async fn run_io<R, W>(
    state: McpState,
    principal: AgentPrincipal,
    io: (R, W),
) -> std::io::Result<()>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let running = McpHandler::new(state, Some(principal))
        .serve(io)
        .await
        .map_err(std::io::Error::other)?;
    running.waiting().await.map_err(std::io::Error::other)?;
    Ok(())
}
