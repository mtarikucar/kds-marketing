//! Strict request schemas shared by the two surfaces.
use serde_json::{Value, json};
pub fn input(action: &str) -> Value {
    let revision = json!({"type":"integer","minimum":0,"maximum":18446744073709551615_u64});
    let lane = json!({"type":"string","enum":["organic","paid"]});
    let (properties, required) = match action {
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
