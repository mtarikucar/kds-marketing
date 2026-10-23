//! `jeeta.api_keys.create`, `jeeta.api_keys.list` and `jeeta.api_keys.revoke`.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_tenancy::{ApiKeyId, Permission};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "api_keys.create",
            description: "Issue a new API key for this workspace with a name and scopes the \
                          caller holds itself (none: all of them). Returns the key with its \
                          plaintext, which is shown only this once. [risk: WRITE]",
            permission: Permission::ApiKeysManage,
            schema: schema_for::<CreateArgs>,
            run: create,
        },
        ToolDef {
            use_case: "api_keys.list",
            description: "List the workspace's API keys, active and revoked, with their names, \
                          display prefixes, scopes and last use; never their secrets. Returns \
                          {keys: [...]}. [risk: READ]",
            permission: Permission::ApiKeysManage,
            schema: schema_for::<NoArgs>,
            run: list,
        },
        ToolDef {
            use_case: "api_keys.revoke",
            description: "Revoke an API key by id; it stops authenticating at once, including \
                          the key making this call. [risk: DESTRUCTIVE]",
            permission: Permission::ApiKeysManage,
            schema: schema_for::<KeyArgs>,
            run: revoke,
        },
    ]
}

/// A new key.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    /// A name of at most 64 characters, e.g. "CI".
    name: String,
    /// Permission keys the key may use; omitted or empty: every permission the caller holds.
    #[serde(default)]
    #[schemars(schema_with = "super::permission_keys_schema")]
    scopes: Vec<String>,
}

/// Which key.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct KeyArgs {
    /// The key id, from jeeta.api_keys.list.
    key_id: Uuid,
}

fn create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CreateArgs { name, scopes } = args(raw)?;
        to_json(&api_keys::create(deps, ctx, CreateKey { name, scopes }).await?)
    })
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("keys", &api_keys::list(deps, ctx).await?)
    })
}

fn revoke<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let KeyArgs { key_id } = args(raw)?;
        api_keys::revoke(deps, ctx, ApiKeyId(key_id)).await?;
        Ok(json!({ "key_id": key_id, "revoked": true }))
    })
}
