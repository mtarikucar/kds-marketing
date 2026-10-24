//! Strict request schemas shared by the two surfaces.
use serde_json::{Value, json};
pub fn input(action: &str) -> Value {
    if action == "hypothesis_propose" {
        return crate::usecases::strategy::hypotheses_schema()["items"].clone();
    }
    let revision = json!({"type":"integer","minimum":0,"maximum":18446744073709551615_u64});
    let lane = json!({"type":"string","enum":["organic","paid"]});
    let (properties, required) = match action {
        "pending" => (json!({}), vec![]),
        "slot_get" => (
            json!({"slot_id":{"type":"string","format":"uuid"}}),
            vec!["slot_id"],
        ),
        "slot_cancel" => (
            json!({"slot_id":{"type":"string","format":"uuid"},"expected_revision":revision,"reason":{"type":"string","minLength":1,"maxLength":2000}}),
            vec!["slot_id", "expected_revision", "reason"],
        ),
        "trend_record" => (
            json!({"hypothesis_id":{"type":"string","format":"uuid"},"channel":{"type":"string"},"summary":{"type":"string","minLength":1,"maxLength":4000},"source_url":{"type":["string","null"],"format":"uri"},"observed_at":{"type":"string","format":"date-time"},"request_key":{"type":"string","minLength":1,"maxLength":200}}),
            vec![
                "hypothesis_id",
                "channel",
                "summary",
                "observed_at",
                "request_key",
            ],
        ),
        "brake" => (
            json!({"engaged":{"type":"boolean"},"lane":{"enum":["organic","paid",null]},"expected_revision":revision}),
            vec!["engaged", "expected_revision"],
        ),
        "policy_set" => (
            json!({"lane":lane,"requires_human_approval":{"type":"boolean"},"expected_revision":revision}),
            vec!["lane", "requires_human_approval", "expected_revision"],
        ),
        "approve" => (
            json!({"target":{"oneOf":[{"type":"object","additionalProperties":false,"required":["slot"],"properties":{"slot":{"type":"string","format":"uuid"}}},{"type":"object","additionalProperties":false,"required":["budget_move"],"properties":{"budget_move":{"type":"string","format":"uuid"}}}]},"expected_revision":revision}),
            vec!["target", "expected_revision"],
        ),
        _ => panic!("unknown Studio action"),
    };
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}

/// HTTP path parameters are excluded from the JSON body.
pub fn panel_input(action: &str) -> Value {
    let mut schema = input(action);
    if matches!(action, "slot_get" | "slot_cancel") {
        schema["properties"]
            .as_object_mut()
            .expect("object")
            .remove("slot_id");
        schema["required"]
            .as_array_mut()
            .expect("required")
            .retain(|v| v != "slot_id");
    }
    schema
}
