//! The MCP server handler, the same over streamable HTTP and stdio.
//!
//! Who calls is an [`AgentPrincipal`]: over HTTP the one [`crate::auth`] put into the request's
//! extensions (re-authenticated on every request), over stdio the one fixed at startup.
//!
//! **Connections.** `initialize` records the client as an agent connection
//! (`agents::register_initialize`) and keeps its id in the session: rmcp builds one handler per
//! HTTP session (and one for the whole stdio stream), so the handler's own state is the
//! session's (and [`crate::sessions`] keeps every other key out of it). A tool call from a key
//! that has no connection in this handler yet (a stateless client that never initialises) is
//! registered first, with the client info the request itself carries in its `_meta`, else
//! `"unknown"`: never with the session's handshake info, which belongs to the key that made it.
//!
//! **Tool calls** run: tool lookup (unknown: `NOT_FOUND`) → its catalog use case → the
//! workspace's current status → `check_gate` → the tool's permission → arguments → the use
//! case. Every call that reached a connection, failed or not, is counted on the connection and
//! ledgered as `mcp.tool_call` (`agents::record_tool_call`). Success answers the output as
//! structured content and as text; failure answers `is_error: true` with the structured error
//! (see [`crate::errors`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::gate::check_gate;
use jt_app::usecases::agents::{self, ClientInfo, ToolCall, UNKNOWN};
use jt_app::usecases::api_keys::{AgentPrincipal, ctx_for_agent};
use jt_tenancy::{AgentConnectionId, ApiKeyId};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, Implementation,
    InitializeRequestParams, InitializeResult, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::McpState;
use crate::auth::INVALID_KEY;
use crate::errors::{public, tool_error};
use crate::state::Registered;

/// The most characters of a client-sent tool name echoed in an error or a log line.
const NAME_ECHO_MAX: usize = agents::CLIENT_FIELD_MAX;

/// Serves MCP requests for one session (or one stdio stream).
#[derive(Clone)]
pub struct McpHandler {
    state: McpState,
    /// The principal of every request, for stdio; `None` reads it from each HTTP request.
    fixed: Option<AgentPrincipal>,
    /// This session's agent connection per key.
    connections: Arc<Mutex<HashMap<ApiKeyId, AgentConnectionId>>>,
}

impl McpHandler {
    /// A handler for one session. `fixed` is the principal of every request (stdio), or `None`
    /// to take it from each HTTP request's extensions.
    pub fn new(state: McpState, fixed: Option<AgentPrincipal>) -> McpHandler {
        McpHandler {
            state,
            fixed,
            connections: Arc::default(),
        }
    }

    /// Who makes this request.
    fn principal(&self, ctx: &RequestContext<RoleServer>) -> Result<AgentPrincipal, AppError> {
        if let Some(fixed) = &self.fixed {
            return Ok(fixed.clone());
        }
        ctx.extensions
            .get::<http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<AgentPrincipal>())
            .cloned()
            .ok_or_else(|| AppError::unauthenticated(INVALID_KEY))
    }

    fn known_connection(&self, key: ApiKeyId) -> Option<AgentConnectionId> {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .copied()
    }

    fn remember(&self, key: ApiKeyId, connection: AgentConnectionId) {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, connection);
    }

    /// The connection of `principal`'s key in this session, registered now if there is none.
    async fn connection(
        &self,
        principal: &AgentPrincipal,
        ctx: &RequestContext<RoleServer>,
        now: OffsetDateTime,
    ) -> Result<AgentConnectionId, AppError> {
        if let Some(id) = self.known_connection(principal.api_key_id) {
            return Ok(id);
        }
        // The request's own metadata only: `ctx.client_info()` would fall back to the session's
        // handshake, made by the key that created the session.
        let client = ctx.meta.client_info();
        let info = ClientInfo {
            name: client
                .as_ref()
                .map_or(UNKNOWN, |c| c.name.as_str())
                .to_owned(),
            version: client
                .as_ref()
                .map_or(UNKNOWN, |c| c.version.as_str())
                .to_owned(),
            protocol_version: ctx
                .meta
                .protocol_version()
                .map_or_else(|| UNKNOWN.to_owned(), |v| v.to_string()),
        };
        let id = agents::register_initialize(&self.state.deps, principal, info, now).await?;
        self.remember(principal.api_key_id, id);
        Ok(id)
    }

    /// Gate, permission, arguments and use case of `tool` for the agent of `ctx`.
    async fn run(&self, tool: &Registered, ctx: &Ctx, arguments: Value) -> Result<Value, AppError> {
        let status = {
            let mut repos = self.state.deps.uow.tenant(ctx.workspace_id).await?;
            repos.workspace().get().await?.status
        };
        check_gate(
            tool.use_case,
            status,
            self.state.gate.as_ref(),
            ctx.workspace_id,
        )
        .await?;
        ctx.require(tool.spec.permission)?;
        (tool.spec.run)(&self.state.deps, ctx, arguments).await
    }

    async fn call(
        &self,
        request: CallToolRequestParams,
        context: &RequestContext<RoleServer>,
    ) -> CallToolResult {
        let started = Instant::now();
        let principal = match self.principal(context) {
            Ok(principal) => principal,
            Err(err) => return tool_error(err),
        };
        let now = self.state.deps.clock.now();
        // Without a connection there is no agent to ledger the call for: answer only.
        let connection = match self.connection(&principal, context, now).await {
            Ok(id) => id,
            Err(err) => return tool_error(err),
        };
        let ctx = ctx_for_agent(&principal, connection, now);
        let CallToolRequestParams {
            name, arguments, ..
        } = request;
        let tool = self.state.tool(&name);
        let outcome = match tool {
            Some(tool) => {
                let arguments = Value::Object(arguments.unwrap_or_default());
                self.run(tool, &ctx, arguments).await
            }
            None => Err(no_such_tool(&name)),
        };

        let call = ToolCall {
            tool: &name,
            risk: tool.map(|t| t.spec.risk),
            ok: outcome.is_ok(),
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            error_code: outcome.as_ref().err().map(|e| e.code),
        };
        if let Err(err) = agents::record_tool_call(&self.state.deps, &ctx, call).await {
            // The call itself has happened; its answer stands.
            let tool = echo(&name);
            tracing::error!(%tool, error = %err, "could not ledger a tool call");
        }
        match outcome {
            Ok(output) => CallToolResult::structured(output),
            Err(err) => tool_error(err),
        }
    }
}

/// A tool name as sent by the client, cut to [`NAME_ECHO_MAX`] characters for errors and logs.
fn echo(name: &str) -> String {
    name.chars().take(NAME_ECHO_MAX).collect()
}

/// `NOT_FOUND` for a tool that does not exist, naming it (cut short) in `details.tool`.
fn no_such_tool(name: &str) -> AppError {
    AppError {
        details: json!({ "tool": echo(name) }),
        ..AppError::not_found("no such tool")
    }
}

/// A protocol-level error for a request that is not a tool call.
fn protocol_error(err: AppError) -> ErrorData {
    let err = public(err);
    ErrorData::invalid_request(err.message.clone(), serde_json::to_value(&err).ok())
}

impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("jeeta", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Jeeta workspace tools. Every tool acts in the workspace of the API key, with \
                 the key's permissions; each description ends with the tool's risk.",
            )
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        let result = self.negotiate_initialize(&request)?;
        let principal = self.principal(&context).map_err(protocol_error)?;
        let client = ClientInfo {
            name: request.client_info.name.clone(),
            version: request.client_info.version.clone(),
            protocol_version: result.protocol_version.to_string(),
        };
        let now = self.state.deps.clock.now();
        let id = agents::register_initialize(&self.state.deps, &principal, client, now)
            .await
            .map_err(|err| ErrorData::internal_error(public(err).message, None))?;
        self.remember(principal.api_key_id, id);
        context.peer.set_peer_info(request);
        Ok(result)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let principal = self.principal(&context).map_err(protocol_error)?;
        let tools: Vec<Tool> = self
            .state
            .tools()
            .filter(|t| principal.permissions.contains(&t.spec.permission))
            .map(|t| t.tool.clone())
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        Ok(self.call(request, &context).await.into())
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.state.tool(name).map(|t| t.tool.clone())
    }
}
