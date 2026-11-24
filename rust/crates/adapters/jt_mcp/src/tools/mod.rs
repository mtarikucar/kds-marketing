//! The tool definitions: per use case, its description, the permission it needs, the schema
//! of its arguments and how to run it. [`crate::registry`] joins them with the catalog.
//!
//! Every tool takes a JSON object of arguments (unknown fields are `VALIDATION`) and answers with
//! a JSON object: an object output as it is, a list under a named key (e.g. `{"members": […]}`)
//! and an output-less operation as a confirmation (e.g. `{"role_id": …, "deleted": true}`).

mod ads;
mod agents;
mod api_keys;
mod billing;
mod budget;
mod calls;
mod capabilities;
mod connector;
mod content;
mod devices;
mod distribution;
mod events;
mod inbox;
mod ledger;
mod modules;
mod outreach;
mod projects;
mod prospects;
mod research;
mod roles;
mod social;
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
    pub permissions: &'static [Permission],
    pub schema: fn() -> Schema,
    pub run: ToolRun,
}

/// Every tool definition.
pub(crate) fn definitions() -> Vec<ToolDef> {
    [
        studio::definitions(),
        projects::definitions(),
        content::definitions(),
        social::definitions(),
        ads::definitions(),
        agents::definitions(),
        workspace::definitions(),
        modules::definitions(),
        team::definitions(),
        roles::definitions(),
        api_keys::definitions(),
        ledger::definitions(),
        strategy::definitions(),
        capabilities::definitions(),
        budget::definitions(),
        billing::definitions(),
        connector::definitions(),
        calls::definitions(),
        devices::definitions(),
        prospects::definitions(),
        research::definitions(),
        distribution::definitions(),
        outreach::definitions(),
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

/// The key of a tool output under which an image travels to the handler
/// ([`crate::handler`] takes it out of the structured answer and adds it as image content). No
/// use case's output has a key of this shape.
pub(crate) const IMAGE_KEY: &str = "$image";

/// `facts` with an image (`data`, base64, of type `mime_type`) for the handler to hand over as
/// MCP image content beside them.
pub(crate) fn with_image(mut facts: Value, data: String, mime_type: &str) -> Value {
    if let Some(map) = facts.as_object_mut() {
        map.insert(
            IMAGE_KEY.to_owned(),
            json!({ "data": data, "mime_type": mime_type }),
        );
    }
    facts
}

/// The answer of a tool that succeeded with `output`: its structured content and its text, and
/// the image [`with_image`] put in it, as image content (out of the structured answer).
pub(crate) fn success(mut output: Value) -> rmcp::model::CallToolResult {
    let image = output.as_object_mut().and_then(|map| map.remove(IMAGE_KEY));
    let mut result = rmcp::model::CallToolResult::structured(output);
    if let Some(image) = image
        && let (Some(data), Some(mime)) = (image["data"].as_str(), image["mime_type"].as_str())
    {
        result
            .content
            .push(rmcp::model::ContentBlock::image(data, mime));
    }
    result
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
    fn an_image_goes_out_as_image_content_not_as_structured_text() {
        let out = success(with_image(
            json!({"post_id": "1"}),
            "aGk=".into(),
            "image/png",
        ));
        assert_eq!(out.structured_content, Some(json!({"post_id": "1"})));
        assert_eq!(out.content.len(), 2);
        let wire = serde_json::to_value(&out.content).unwrap();
        assert_eq!(wire[1]["type"], "image");
        assert_eq!(wire[1]["data"], "aGk=");
        assert_eq!(wire[1]["mimeType"], "image/png");
        assert!(!wire[0]["text"].as_str().unwrap().contains("aGk="));
        // Without an image, the answer is the structured output alone.
        let plain = success(json!({"ok": true}));
        assert_eq!(plain.content.len(), 1);
    }

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
