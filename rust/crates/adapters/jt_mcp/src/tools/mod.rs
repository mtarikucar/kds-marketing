//! The tool definitions: per use case, its description, the permission it needs, the schema
//! of its arguments and how to run it. [`crate::registry`] joins them with the catalog.
//!
//! Every tool takes a JSON object of arguments (unknown fields are `VALIDATION`) and answers with
//! a JSON object: an object output as it is, a list under a named key (e.g. `{"members": […]}`)
//! and an output-less operation as a confirmation (e.g. `{"role_id": …, "deleted": true}`).

mod agents;
mod api_keys;
mod budget;
mod capabilities;
mod connector;
mod events;
mod inbox;
mod ledger;
mod roles;
mod strategy;
mod studio;
mod team;
mod work;
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
        studio::definitions(),
        agents::definitions(),
        workspace::definitions(),
        team::definitions(),
        roles::definitions(),
        api_keys::definitions(),
        ledger::definitions(),
        strategy::definitions(),
        capabilities::definitions(),
        budget::definitions(),
        connector::definitions(),
        events::definitions(),
        inbox::definitions(),
        work::definitions(),
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

/// `value` as JSON, as the panel writes it: through JSON text, so every number is the one the
/// panel's answer carries. (Converting straight to a `Value` widens an `f32`, such as a
/// hypothesis's confidence 0.6, to 0.6000000238418579.)
pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<Value, AppError> {
    let failed =
        |e: serde_json::Error| AppError::internal(format!("cannot serialise a tool output: {e}"));
    let text = serde_json::to_vec(value).map_err(failed)?;
    serde_json::from_slice(&text).map_err(failed)
}

/// `{ key: items }`, for a tool whose output is a list.
pub(crate) fn listed<T: Serialize>(key: &str, items: &[T]) -> Result<Value, AppError> {
    Ok(json!({ key: to_json(&items)? }))
}

/// The JSON Schema of an RFC 3339 time, or null.
pub(crate) fn optional_date_time_schema(_: &mut schemars::SchemaGenerator) -> Schema {
    schemars::json_schema!({ "type": ["string", "null"], "format": "date-time" })
}

/// The JSON Schema of a list of permission keys, naming every key there is.
pub(crate) fn permission_keys_schema(_: &mut schemars::SchemaGenerator) -> Schema {
    let keys: Vec<&str> = Permission::all().iter().map(Permission::key).collect();
    schemars::json_schema!({
        "type": "array",
        "items": { "type": "string", "enum": keys },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_read_as_the_panel_writes_them() {
        // The panel writes an `f32` 0.6 as `0.6`; a direct conversion to `Value` widens it to
        // 0.6000000238418579.
        #[derive(Serialize)]
        struct Out {
            confidence: f32,
        }
        let value = to_json(&Out { confidence: 0.6 }).unwrap();
        let panel = serde_json::to_string(&Out { confidence: 0.6 }).unwrap();
        assert_eq!(value.to_string(), panel);
        assert_eq!(value, json!({ "confidence": 0.6 }));
    }

    #[test]
    fn an_f64_reads_back_exactly() {
        // Without serde_json's `float_roundtrip`, parsing this number's shortest text lands one
        // unit in the last place away from it.
        #[derive(Serialize)]
        struct Out {
            amount: f64,
        }
        let amount = -1.049_882_427_645_354_5e74_f64;
        let value = to_json(&Out { amount }).unwrap();
        assert_eq!(
            value["amount"].as_f64().unwrap().to_bits(),
            amount.to_bits()
        );
        let panel = serde_json::to_string(&Out { amount }).unwrap();
        assert_eq!(value.to_string(), panel);
    }
}
