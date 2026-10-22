//! The M0 tool definitions: per use case, its description, the permission it needs, the schema
//! of its arguments and how to run it. [`crate::registry`] joins them with the catalog.
//!
//! Every tool takes a JSON object of arguments (unknown fields are `VALIDATION`) and answers with
//! a JSON object: an object output as it is, a list under a named key (e.g. `{"members": […]}`)
//! and an output-less operation as a confirmation (e.g. `{"role_id": …, "deleted": true}`).

mod agents;
mod api_keys;
mod ledger;
mod roles;
mod team;
mod workspace;

use jt_app::error::AppError;
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::registry::ToolRun;

/// One tool's definition, keyed by its use case id.
pub(crate) struct ToolDef {
    pub use_case: &'static str,
    pub description: &'static str,
    pub permission: Permission,
    pub schema: fn() -> Schema,
    pub run: ToolRun,
}

/// Every tool definition.
pub(crate) fn definitions() -> Vec<ToolDef> {
    [
        agents::definitions(),
        workspace::definitions(),
        team::definitions(),
        roles::definitions(),
        api_keys::definitions(),
        ledger::definitions(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// A tool that takes no arguments: an empty object (or none at all).
#[derive(Debug, serde::Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoArgs {}

/// The arguments of a call as `T`; malformed ones are `VALIDATION`.
pub(crate) fn args<T: DeserializeOwned>(raw: Value) -> Result<T, AppError> {
    Ok(serde_json::from_value(raw)?)
}

/// `value` as JSON.
pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|e| AppError::internal(format!("cannot serialise a tool output: {e}")))
}

/// `{ key: items }`, for a tool whose output is a list.
pub(crate) fn listed<T: Serialize>(key: &str, items: &[T]) -> Result<Value, AppError> {
    Ok(json!({ key: to_json(&items)? }))
}

/// The JSON Schema of a list of permission keys, naming every key there is.
pub(crate) fn permission_keys_schema(_: &mut schemars::SchemaGenerator) -> Schema {
    let keys: Vec<&str> = Permission::all().iter().map(Permission::key).collect();
    schemars::json_schema!({
        "type": "array",
        "items": { "type": "string", "enum": keys },
    })
}
