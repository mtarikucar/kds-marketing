//! `jeeta mcp-stdio`: the MCP tools over stdin/stdout, for an agent that runs Jeeta as a local
//! process.
//!
//! The key in [`config::STDIO_API_KEY`] is authenticated once, at start; the process then acts
//! with the permissions the key had at that moment until it exits, so revoking the key or
//! demoting its issuer takes effect at the next start. Stdout carries the MCP stream and logs go
//! to stderr. This mode serves no HTTP and applies no migrations: the database must already have
//! been migrated by `jeeta serve`. Like `serve`, it refuses a database role that row-level
//! security does not bind (`serve::check_database_role`).

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use jt_app::error::ErrorCode;
use jt_app::gate::NoStrategyYet;
use jt_app::usecases::api_keys;
use jt_mcp::McpState;

use crate::config::{self, Config};
use crate::serve;

/// Serves MCP over stdin/stdout as the configured key until the client closes the stream.
pub async fn run(config: Config) -> Result<()> {
    let Some(key) = config.stdio_api_key.as_deref() else {
        bail!(
            "{}: must be set to an API key (jt_live_...) for `jeeta mcp-stdio`",
            config::STDIO_API_KEY
        );
    };
    let pool = serve::connect(&config).await?;
    serve::check_database_role(&pool, config.allow_superuser).await?;
    let deps = serve::deps(pool.clone(), &config.secret_key);
    let principal = match api_keys::authenticate(&deps, key).await {
        Ok(principal) => principal,
        Err(e) if e.code == ErrorCode::Unauthenticated => bail!(
            "{}: the key is unknown or revoked, or its issuer is no longer an active member",
            config::STDIO_API_KEY
        ),
        Err(e) => {
            return Err(e).with_context(|| format!("cannot check {}", config::STDIO_API_KEY));
        }
    };
    tracing::info!(
        workspace = %principal.workspace_id,
        api_key = %principal.api_key_id,
        "serving MCP over stdio"
    );

    let state = McpState::new(deps, Arc::new(NoStrategyYet));
    jt_mcp::run_stdio(state, principal)
        .await
        .context("the MCP stdio stream failed")?;
    pool.close().await;
    Ok(())
}
