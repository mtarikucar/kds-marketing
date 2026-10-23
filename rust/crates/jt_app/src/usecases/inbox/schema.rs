//! Shared JSON schemas for the request bodies/queries used on both inbox surfaces.
use serde_json::{Value, json};

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
pub fn input(action: &str) -> Value {
    let identity = object(
        json!({"channel":{"type":"string","enum":["phone","email","instagram_dm","messenger","webchat"]},"value":{"type":"string","minLength":1},"capability_id":{"type":["string","null"],"format":"uuid"}}),
        &["channel", "value"],
    );
    match action {
        "people.search" => object(
            json!({"q":{"type":"string","default":""},"limit":{"type":["integer","null"],"minimum":1,"maximum":500,"default":50}}),
            &[],
        ),
        "people.create" => object(
            json!({"display_name":{"type":"string","minLength":1},"identities":{"type":"array","minItems":1,"items":identity},"source":{"oneOf":[{"type":"string","enum":["meta_ads","import","form","repeat"]},object(json!({"channel":{"type":"string","enum":["whats_app","instagram_dm","messenger","sms","email","webchat","phone"]}}), &["channel"])]}}),
            &["display_name", "identities", "source"],
        ),
        "identities.add" => identity,
        "events.report" => {
            let variants: Vec<Value> = [
                ("call_made", object(json!({"connected":{"type":"boolean"}}), &["connected"])),
                ("appointment_booked",object(json!({}), &[])),
                ("meeting_held",object(json!({}), &[])),
                ("quote_accepted",object(json!({}), &[])),
                ("won",object(json!({"product":{"type":"string","minLength":1},"amount_minor":{"type":"integer","minimum":0},"currency":{"type":"string","pattern":"^[A-Z]{3}$"}}), &["product","amount_minor","currency"])),
                ("lost",object(json!({"reason_key":{"type":"string","minLength":1}}), &["reason_key"])),
                ("snoozed",object(json!({"until":{"type":"string","format":"date-time"}}), &["until"])),
                ("reopened",object(json!({}), &[])),
            ].into_iter().map(|(kind,payload)| json!({"properties":{"kind":{"const":kind},"payload":payload},"required":["kind","payload"]})).collect();
            let mut schema = object(
                json!({"kind":{"type":"string","enum":["call_made","appointment_booked","meeting_held","quote_accepted","won","lost","snoozed","reopened"]},"idempotency_key":{"type":"string","minLength":1},"payload":{"type":"object"}}),
                &["kind", "idempotency_key", "payload"],
            );
            schema["oneOf"] = json!(variants);
            schema
        }
        "lost_reasons.set" => object(
            json!({"key":{"type":"string","minLength":1},"label":{"type":"string","minLength":1},"active":{"type":"boolean"}}),
            &["key", "label", "active"],
        ),
        "journeys.assign_owner" => object(
            json!({"user_id":{"type":["string","null"],"format":"uuid"}}),
            &[],
        ),
        "status_labels.set" => object(
            json!({"labels":{"type":"object","propertyNames":{"enum":["new","contacted","unreachable","appointment","met","quoted","pending","won","lost"]},"additionalProperties":{"type":"string","minLength":1}}}),
            &["labels"],
        ),
        _ => object(json!({}), &[]),
    }
}
/// MCP adds path identifiers to exactly the panel's body/query fields.
pub fn tool(action: &str) -> Value {
    let mut out = input(action);
    let id = match action {
        "people.get" | "identities.add" | "journeys.open" => Some("person_id"),
        "journeys.get" | "journeys.assign_owner" | "events.report" => Some("journey_id"),
        _ => None,
    };
    if let Some(id) = id {
        out["properties"][id] = json!({"type":"string","format":"uuid"});
        out["required"]
            .as_array_mut()
            .expect("object schema")
            .push(json!(id));
    }
    out
}
