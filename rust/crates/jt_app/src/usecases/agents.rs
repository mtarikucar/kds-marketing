//! Agents acting through API keys: recording the clients that connect (`register_initialize`),
//! counting their tool calls, `agents.list`, and `whoami`, the twin of `auth.me` for agents.
//!
//! A connection is one agent client seen through one key: the same key, client name and client
//! version are the same connection however often the client initialises. The first sight of a
//! connection is ledgered as `agent.connected`; later ones only refresh it.

use std::collections::BTreeMap;

use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, ApiKeyId, Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use super::api_keys::{AgentPrincipal, ctx_for_agent};
use super::{Deps, ledger_entry, permission_keys};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::AgentConnectionRow;

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

/// Records that the client `client` initialised at `now` with the key behind `principal`, and
/// returns its connection.
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

/// The caller as its context describes it. Reads nothing.
pub fn whoami(ctx: &Ctx) -> WhoAmI {
    WhoAmI {
        actor: ctx.actor.clone(),
        workspace_id: ctx.workspace_id,
        role_key: ctx.role_key.clone(),
        permissions: permission_keys(&ctx.permissions)
            .into_iter()
            .map(str::to_owned)
            .collect(),
    }
}
