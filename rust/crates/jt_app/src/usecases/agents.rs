//! Agents acting through API keys: recording the clients that connect (`register_initialize`),
//! counting their tool calls, `agents.list`, and `agents.whoami`, which tells any caller, a
//! signed-in user or an agent, who it is in its workspace.
//!
//! A connection is one agent client seen through one key: the same key, client name and client
//! version are the same connection however often the client initialises. The first sight of a
//! connection is ledgered as `agent.connected`; later ones only refresh it. What a client says
//! about itself is bounded before it is stored (see [`register_initialize`]).
//!
//! Every tool call an agent makes is counted on its connection and ledgered as `mcp.tool_call`
//! ([`record_tool_call`]).

use std::collections::BTreeMap;

use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, ApiKeyId, Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use super::api_keys::{AgentPrincipal, ctx_for_agent};
use super::{Deps, ledger_entry, permission_keys};
use crate::catalog::Risk;
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::AgentConnectionRow;

/// The most characters kept of each string a client reports about itself, and of a tool name
/// in the ledger.
pub const CLIENT_FIELD_MAX: usize = 128;
/// What a client field that is blank (or only control characters) is stored as.
pub const UNKNOWN: &str = "unknown";

/// What an agent client says about itself when it initialises.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    /// The protocol version the session runs.
    pub protocol_version: String,
}

/// A connection as the agents list shows it, with the name of the key it came through.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentConnectionOut {
    pub id: AgentConnectionId,
    pub api_key_id: ApiKeyId,
    pub api_key_name: String,
    pub client_name: String,
    pub client_version: String,
    pub protocol_version: String,
    #[serde(with = "time::serde::rfc3339")]
    pub first_seen_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_seen_at: OffsetDateTime,
    pub tool_calls: i64,
}

/// Who the caller is, where, and what it may do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WhoAmI {
    pub actor: Actor,
    pub workspace_id: WorkspaceId,
    /// The key of the role behind the caller: their own, or for an agent, its issuer's.
    pub role_key: Option<String>,
    /// The caller's permission keys (for an agent: its key's effective scopes).
    pub permissions: Vec<String>,
}

/// One tool call an agent made, as the ledger records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCall<'a> {
    /// The tool's name as the agent sent it (cut to [`CLIENT_FIELD_MAX`] characters).
    pub tool: &'a str,
    /// The tool's risk; `None` when no such tool exists.
    pub risk: Option<Risk>,
    pub ok: bool,
    pub duration_ms: u64,
    /// The error's code when the call failed.
    pub error_code: Option<ErrorCode>,
}

/// Records that the client `client` initialised at `now` with the key behind `principal`, and
/// returns its connection.
///
/// Each of the client's strings is bounded first: control characters are dropped, surrounding
/// whitespace trimmed, anything beyond [`CLIENT_FIELD_MAX`] characters cut, and a string left
/// empty becomes [`UNKNOWN`].
///
/// A new (key, client name, client version) becomes a connection first and last seen at `now`
/// and writes `agent.connected` (actor: the agent on the issuer's authority; payload
/// `client_name`, `client_version`, `protocol_version`, `api_key_prefix`). A known one keeps its
/// id and gets `now` as last seen and the client's protocol version, without a ledger entry.
pub async fn register_initialize(
    deps: &Deps,
    principal: &AgentPrincipal,
    client: ClientInfo,
    now: OffsetDateTime,
) -> Result<AgentConnectionId, AppError> {
    let client = ClientInfo {
        name: bounded(&client.name),
        version: bounded(&client.version),
        protocol_version: bounded(&client.protocol_version),
    };
    let payload = json!({
        "client_name": client.name,
        "client_version": client.version,
        "protocol_version": client.protocol_version,
    });
    let mut repos = deps.uow.tenant(principal.workspace_id).await?;
    let (id, created) = repos
        .agent_connections()
        .upsert_on_initialize(AgentConnectionRow {
            id: AgentConnectionId(deps.ids.uuid()),
            workspace_id: principal.workspace_id,
            api_key_id: principal.api_key_id,
            client_name: client.name,
            client_version: client.version,
            protocol_version: client.protocol_version,
            first_seen_at: now,
            last_seen_at: now,
            tool_calls: 0,
        })
        .await?;
    if created {
        let prefix = repos
            .api_keys()
            .list()
            .await?
            .into_iter()
            .find(|k| k.id == principal.api_key_id)
            .map(|k| k.prefix)
            .ok_or_else(|| AppError::internal("the connection's API key is missing"))?;
        let mut payload = payload;
        payload["api_key_prefix"] = json!(prefix);
        let ctx = ctx_for_agent(principal, id, now);
        repos
            .ledger()
            .append(ledger_entry(
                &ctx,
                "agent.connected",
                "agent_connection",
                id,
                payload,
            )?)
            .await?;
    }
    repos.commit().await?;
    Ok(id)
}

/// Counts one tool call on connection `connection_id` of workspace `workspace_id`, last seen at
/// `now`.
pub async fn touch_tool_call(
    deps: &Deps,
    workspace_id: WorkspaceId,
    connection_id: AgentConnectionId,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut repos = deps.uow.tenant(workspace_id).await?;
    repos
        .agent_connections()
        .touch_tool_call(connection_id, now)
        .await?;
    repos.commit().await
}

/// Counts the tool call `call` on the agent connection of `ctx` and ledgers it as
/// `mcp.tool_call`, in one transaction, at `ctx.now`.
///
/// The entry's actor is the agent, its subject the connection, and its payload `tool`, `risk`
/// (`null` for an unknown tool), `ok`, `duration_ms` and, for a failure, `error_code`. A context
/// that is not an agent's is `INTERNAL`.
pub async fn record_tool_call(deps: &Deps, ctx: &Ctx, call: ToolCall<'_>) -> Result<(), AppError> {
    let connection_id = ctx
        .agent_connection_id
        .ok_or_else(|| AppError::internal("only an agent's tool call can be recorded"))?;
    let tool: String = call.tool.chars().take(CLIENT_FIELD_MAX).collect();
    let mut payload = json!({
        "tool": tool,
        "risk": call.risk,
        "ok": call.ok,
        "duration_ms": call.duration_ms,
    });
    if let Some(code) = call.error_code {
        payload["error_code"] = json!(code);
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos
        .agent_connections()
        .touch_tool_call(connection_id, ctx.now)
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "mcp.tool_call",
            "agent_connection",
            connection_id,
            payload,
        )?)
        .await?;
    repos.commit().await
}

/// The workspace's agent connections, first seen first, with the names of their keys. Needs
/// `workspace.read`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<AgentConnectionOut>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let names: BTreeMap<ApiKeyId, String> = repos
        .api_keys()
        .list()
        .await?
        .into_iter()
        .map(|k| (k.id, k.name))
        .collect();
    repos
        .agent_connections()
        .list()
        .await?
        .into_iter()
        .map(|c| {
            let api_key_name = names
                .get(&c.api_key_id)
                .cloned()
                .ok_or_else(|| AppError::internal("a connection refers to a missing API key"))?;
            Ok(AgentConnectionOut {
                id: c.id,
                api_key_id: c.api_key_id,
                api_key_name,
                client_name: c.client_name,
                client_version: c.client_version,
                protocol_version: c.protocol_version,
                first_seen_at: c.first_seen_at,
                last_seen_at: c.last_seen_at,
                tool_calls: c.tool_calls,
            })
        })
        .collect()
}

/// `agents.whoami`: the caller as its context describes it, the same for a user in the panel
/// and an agent over MCP (only the actor differs: the human, or the agent on its issuer's
/// authority). Reads nothing. Needs `workspace.read`.
pub fn whoami(ctx: &Ctx) -> Result<WhoAmI, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    Ok(WhoAmI {
        actor: ctx.actor.clone(),
        workspace_id: ctx.workspace_id,
        role_key: ctx.role_key.clone(),
        permissions: permission_keys(&ctx.permissions)
            .into_iter()
            .map(str::to_owned)
            .collect(),
    })
}

/// `raw` without control characters, trimmed, cut to [`CLIENT_FIELD_MAX`] characters; or
/// [`UNKNOWN`] when nothing is left.
fn bounded(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let kept: String = cleaned.trim().chars().take(CLIENT_FIELD_MAX).collect();
    match kept.trim_end() {
        "" => UNKNOWN.to_owned(),
        text => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_trims_cuts_and_fills_in_unknown() {
        assert_eq!(bounded(" acme-agent "), "acme-agent");
        assert_eq!(bounded(""), UNKNOWN);
        assert_eq!(bounded("\u{0}\t\n"), UNKNOWN);
        assert_eq!(bounded("a\u{7}b"), "ab");
        assert_eq!(bounded(&"x".repeat(500)).len(), CLIENT_FIELD_MAX);
        // A cut that ends in whitespace drops it.
        let raw = format!("{} tail", "y".repeat(CLIENT_FIELD_MAX - 1));
        assert_eq!(bounded(&raw), "y".repeat(CLIENT_FIELD_MAX - 1));
    }
}
