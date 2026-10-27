//! Strict request schemas shared by the two surfaces.
use serde_json::{Value, json};
pub fn input(action: &str) -> Value {
    if action == "ledger_export" {
        return object(json!({"filter":input("ledger")}), &["filter"]);
    }
    if action == "ledger" {
        let mut schema = input("overview");
        schema["properties"]["before"] =
            json!({"type":["integer","null"],"minimum":1,"maximum":9223372036854775807_i64});
        schema["properties"]["limit"] = json!({"type":"integer","minimum":1,"maximum":500});
        return schema;
    }
    if action == "hypothesis_propose" {
        return crate::usecases::strategy::hypotheses_schema()["items"].clone();
    }
    let revision = json!({"type":"integer","minimum":0,"maximum":18446744073709551615_u64});
    let lane = json!({"type":"string","enum":["organic","paid"]});
    let (properties, required) = match action {
        "adsets_list" => (
            json!({"capability_id":{"type":"string","format":"uuid"}}),
            vec!["capability_id"],
        ),
        "adset_bind" => (
            json!({"hypothesis_id":{"type":"string","format":"uuid"},"arm_id":{"type":"string","format":"uuid"},"capability_id":{"type":"string","format":"uuid"},"adset_id":{"type":"string","minLength":1,"maxLength":200},"request_key":{"type":"string","minLength":1,"maxLength":200}}),
            vec![
                "hypothesis_id",
                "arm_id",
                "capability_id",
                "adset_id",
                "request_key",
            ],
        ),
        "budget_move" => (
            json!({"binding_id":{"type":"string","format":"uuid"},"daily_budget_minor":{"type":"integer","minimum":1,"maximum":9223372036854775807_i64},"currency":{"type":"string","pattern":"^[A-Z]{3}$"},"request_key":{"type":"string","minLength":1,"maxLength":200}}),
            vec![
                "binding_id",
                "daily_budget_minor",
                "currency",
                "request_key",
            ],
        ),
        "learned" | "overview" => (
            json!({"hypothesis_id":{"type":["string","null"],"format":"uuid"},"lane":{"enum":["organic","paid",null]},"from":{"type":"string","format":"date-time"},"until":{"type":"string","format":"date-time"}}),
            vec!["from", "until"],
        ),
        "judgment_record" => (
            json!({"hypothesis_id":{"type":"string","format":"uuid"},"evidence_ids":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"string","format":"uuid"}},"text":{"type":"string","minLength":1,"maxLength":4000},"request_key":{"type":"string","minLength":1,"maxLength":200}}),
            vec!["hypothesis_id", "evidence_ids", "text", "request_key"],
        ),
        "file_upload" => (
            json!({"request_key":{"type":"string","minLength":1,"maxLength":200},"filename":{"type":"string","minLength":1,"maxLength":255},"mime":mime(),"content":{"oneOf":[object(json!({"kind":{"const":"bytes_base64"},"data":{"type":"string"}}),&["kind","data"]),object(json!({"kind":{"const":"source_url"},"url":{"type":"string","format":"uri"}}),&["kind","url"]) ]}}),
            vec!["request_key", "filename", "mime", "content"],
        ),
        "piece_submit" => (
            json!({"slot_id":{"type":"string","format":"uuid"},"expected_revision":revision,"request_key":{"type":"string","minLength":1,"maxLength":200},"text":{"type":"string"},"media":{"type":"array","items":media()},"adaptations":{"type":"object","additionalProperties":object(json!({"text":{"type":"string"},"media":{"type":"array","items":media()},"link":{"type":["string","null"],"format":"uri"},"privacy":privacy()}),&["text","media"])}}),
            vec![
                "slot_id",
                "expected_revision",
                "request_key",
                "text",
                "media",
                "adaptations",
            ],
        ),
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
    if matches!(action, "slot_get" | "slot_cancel" | "piece_submit") {
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

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
/// Who may see a post on the adapted account (TikTok's `privacy_level` names); absent or null:
/// public.
fn privacy() -> Value {
    let mut levels: Vec<Value> = jt_studio::PRIVACY_LEVELS
        .iter()
        .map(|level| json!(level))
        .collect();
    levels.push(Value::Null);
    json!({ "enum": levels })
}
fn mime() -> Value {
    json!({"type":"string","enum":["image/jpeg","image/png","image/webp","image/gif","video/mp4"]})
}
fn media() -> Value {
    json!({"oneOf":[
     object(json!({"kind":{"const":"file"},"id":{"type":"string","format":"uuid"}}),&["kind","id"]),
     object(json!({"kind":{"const":"hosted_url"},"url":{"type":"string","format":"uri"},"mime":mime(),"size_bytes":{"type":"integer","minimum":1,"maximum":200000000}}),&["kind","url","mime","size_bytes"]),
     object(json!({"kind":{"const":"bytes"},"data":{"type":"string"},"mime":mime(),"filename":{"type":"string","minLength":1,"maxLength":255}}),&["kind","data","mime","filename"])
    ]})
}
