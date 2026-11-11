//! Strict request schemas shared by the two surfaces.
use serde_json::{Value, json};
pub fn input(action: &str) -> Value {
    if action == "project_schedule" {
        return super::project_schedule::schema();
    }
    if let Some(name) = action.strip_prefix("project_") {
        return super::projects::schema(name);
    }
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
    if let Some((properties, required)) = library(action) {
        return object(properties, required);
    }
    if let Some((properties, required)) = posting(action) {
        return object(properties, required);
    }
    let revision = json!({"type":"integer","minimum":0,"maximum":18446744073709551615_u64});
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
            json!({"slot_id":{"type":"string","format":"uuid"},"expected_revision":revision,"request_key":{"type":"string","minLength":1,"maxLength":200},"text":{"type":"string"},"media":{"type":"array","items":media()},"adaptations":{"type":"object","additionalProperties":object(json!({"text":{"type":"string"},"media":{"type":"array","items":media()},"link":{"type":["string","null"],"format":"uri"},"privacy":privacy()}),&["text","media"])},"subject":subject()}),
            vec![
                "slot_id",
                "expected_revision",
                "request_key",
                "text",
                "media",
                "adaptations",
                "subject",
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

/// What a piece speaks about (spec 2026-11-03 D7): one olay (its real date, place, name and client
/// may be stated), an earlier season's olay as last year's (its year stated), or nothing specific.
/// Every medium must be a material eligible for it.
fn subject() -> Value {
    let olay = |kind: &str| {
        object(
            json!({"kind":{"const":kind},"olay_id":{"type":"string","format":"uuid"}}),
            &["kind", "olay_id"],
        )
    };
    json!({"oneOf":[olay("olay"), olay("archive"), object(json!({"kind":{"const":"generic"}}),&["kind"])]})
}

fn uuid() -> Value {
    json!({"type":"string","format":"uuid"})
}
fn keys<T: jt_studio::TagKey>() -> Vec<&'static str> {
    T::ALL.iter().map(|t| t.key()).collect()
}
/// A set of tag keys of one vocabulary.
fn tag_set<T: jt_studio::TagKey>() -> Value {
    json!({"type":"array","uniqueItems":true,"items":{"type":"string","enum":keys::<T>()}})
}
fn quality() -> Value {
    let mut values: Vec<Value> = keys::<jt_studio::Quality>()
        .into_iter()
        .map(Value::from)
        .collect();
    values.push(Value::Null);
    json!({ "enum": values })
}
fn people() -> Value {
    json!({"type":"array","uniqueItems":true,"maxItems":jt_studio::MAX_MATERIAL_PEOPLE,"items":uuid()})
}
fn label(min: u64) -> Value {
    json!({"type":"string","minLength":min,"maxLength":jt_studio::MAX_LABEL_CHARS})
}
fn nullable_label() -> Value {
    json!({"type":["string","null"],"minLength":1,"maxLength":jt_studio::MAX_LABEL_CHARS})
}
fn date() -> Value {
    json!({"type":"string","format":"date"})
}
/// The materials library's tools (spec 2026-11-03 §5.2): their properties and required fields.
fn library(action: &str) -> Option<(Value, &'static [&'static str])> {
    let revision = json!({"type":"integer","minimum":0,"maximum":18446744073709551615_u64});
    let request_key = json!({"type":"string","minLength":1,"maxLength":200});
    let kind = json!({"type":"string","enum":["workshop","order","season","special_day","product_shoot","other"]});
    let client = json!({"type":["object","null"],"additionalProperties":false,"properties":{
        "person_id":{"type":["string","null"],"format":"uuid"},"organization":nullable_label()}});
    let occasion = json!({"type":["string","null"],"pattern":"^[a-z0-9_]{1,40}$"});
    let notes = json!({"type":"string","maxLength":jt_studio::MAX_NOTES_CHARS});
    Some(match action {
        "olays_list" => (
            json!({"status":{"type":"string","enum":["proposed","confirmed"]}}),
            &[],
        ),
        "olay_get" => (json!({"olay_id":uuid()}), &["olay_id"]),
        "olay_create" => (
            json!({"request_key":request_key,"kind":kind,"title":label(1),"starts_on":date(),
                "ends_on":date(),"place":nullable_label(),"client":client,"notes":notes,
                "occasion":occasion}),
            &["request_key", "kind", "title", "starts_on", "ends_on"],
        ),
        "olay_update" => (
            json!({"olay_id":uuid(),"expected_revision":revision,"kind":kind,"title":label(1),
                "starts_on":date(),"ends_on":date(),"place":nullable_label(),"client":client,
                "notes":notes,"occasion":occasion}),
            &["olay_id", "expected_revision"],
        ),
        "materials_list" => (
            json!({"olay_id":uuid(),"state":{"type":"string","enum":["live","erased","needs_review","all"]}}),
            &[],
        ),
        "material_get" => (json!({"material_id":uuid()}), &["material_id"]),
        "material_intelligence_list" => (json!({}), &[]),
        "material_production_list" => (
            json!({"source_material_id":{"type":["string","null"],"format":"uuid"}}),
            &[],
        ),
        "material_production_request" => (
            json!({"request_key":request_key,"kind":{"type":"string","enum":["edit","crop","poster"]},
                "instructions":{"type":"string","minLength":1,"maxLength":2000},
                "sources":{"type":"array","minItems":1,"maxItems":5,"items":object(json!({"material_id":uuid(),"expected_revision":revision}), &["material_id","expected_revision"])}}),
            &["request_key", "kind", "instructions", "sources"],
        ),
        "material_production_claim" => (
            json!({"production_id":uuid(),"expected_revision":revision}),
            &["production_id", "expected_revision"],
        ),
        "material_production_complete" => (
            json!({"production_id":uuid(),"expected_revision":revision,"claim_token":{"type":"string","minLength":1},"output_material_id":uuid()}),
            &[
                "production_id",
                "expected_revision",
                "claim_token",
                "output_material_id",
            ],
        ),
        "material_production_fail" => (
            json!({"production_id":uuid(),"expected_revision":revision,"claim_token":{"type":"string","minLength":1},"error_code":{"type":"string","pattern":"^[a-z0-9_]{1,64}$"}}),
            &[
                "production_id",
                "expected_revision",
                "claim_token",
                "error_code",
            ],
        ),
        "material_intelligence_get" | "material_preview" => {
            (json!({"material_id":uuid()}), &["material_id"])
        }
        "material_analysis_claim" | "material_analysis_retry" => (
            json!({"material_id":uuid(),"expected_revision":revision}),
            &["material_id", "expected_revision"],
        ),
        "material_analysis_complete" => (
            json!({"material_id":uuid(),"expected_revision":revision,
                "claim_token":{"type":"string","minLength":1},
                "title":{"type":["string","null"],"maxLength":120},
                "description":{"type":"string","minLength":1,"maxLength":4000},
                "labels":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":64}},
                "group_name":{"type":["string","null"],"minLength":1,"maxLength":120},
                "captured_at":{"type":["string","null"],"format":"date-time"},
                "date_source":{"type":"string","enum":["unknown","exif","file_modified","agent_inferred"]},
                "quality":quality(),"depicts":{"type":["array","null"],"uniqueItems":true,"items":{"type":"string","enum":keys::<jt_studio::Depicts>()}}}),
            &[
                "material_id",
                "claim_token",
                "expected_revision",
                "description",
                "labels",
                "date_source",
            ],
        ),
        "material_analysis_fail" => (
            json!({"material_id":uuid(),"expected_revision":revision,
                "claim_token":{"type":"string","minLength":1},
                "error_code":{"type":"string","pattern":"^[a-z0-9_]{1,64}$"}}),
            &[
                "material_id",
                "claim_token",
                "expected_revision",
                "error_code",
            ],
        ),

        "material_add" => (
            json!({"request_key":request_key,"file_id":uuid(),
                "olay_id":{"type":["string","null"],"format":"uuid"},"genel":{"type":"boolean"},
                "origin":{"oneOf":[
                    object(json!({"kind":{"const":"real"}}), &["kind"]),
                    object(json!({"kind":{"const":"ai_generated"},
                        "generator":{"type":"string","pattern":"^[a-z0-9_.-]{1,40}$"}}), &["kind","generator"]),
                ]},
                "title":{"type":"string","maxLength":jt_studio::MAX_MATERIAL_TITLE_CHARS},
                "labels":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":64}},
                "product_groups":tag_set::<jt_studio::ProductGroup>(),
                "doors":tag_set::<jt_studio::Door>(),
                "content_types":tag_set::<jt_studio::ContentType>(),
                "quality":quality(),
                "depicts":{"type":["array","null"],"uniqueItems":true,"items":{"type":"string","enum":keys::<jt_studio::Depicts>()}},
                "people":people(),
                "share":{"enum":["shareable","not_shareable","product_only",null]},
                "captured_at":{"type":["string","null"],"format":"date-time"}}),
            &["request_key", "file_id", "origin"],
        ),
        "material_tag" => (
            json!({"material_id":uuid(),"expected_revision":revision,
                "title":{"type":"string","maxLength":jt_studio::MAX_MATERIAL_TITLE_CHARS},
                "labels":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":64}},
                "captured_at":{"type":["string","null"],"format":"date-time"},
                "product_groups":tag_set::<jt_studio::ProductGroup>(),
                "doors":tag_set::<jt_studio::Door>(),
                "content_types":tag_set::<jt_studio::ContentType>(),
                "quality":quality(),"depicts":tag_set::<jt_studio::Depicts>(),"people":people()}),
            &["material_id", "expected_revision"],
        ),
        "slot_materials" => (json!({"slot_id":uuid()}), &["slot_id"]),
        "calendar_list" => (
            json!({"year":{"type":"integer","minimum":2000,"maximum":2100}}),
            &[],
        ),
        "shoot_list" => (
            json!({"status":{"type":"string","enum":["open","done","dismissed","all"]}}),
            &[],
        ),
        "shoot_request" => (
            json!({"request_key":request_key,
                "text":{"type":"string","minLength":1,"maxLength":jt_studio::MAX_SHOOT_TEXT_CHARS},
                "week_start":{"type":["string","null"],"format":"date"}}),
            &["request_key", "text"],
        ),
        "shoot_resolve" => (
            json!({"request_id":uuid(),"status":{"type":"string","enum":["done","dismissed"]}}),
            &["request_id", "status"],
        ),
        _ => return None,
    })
}

/// Olay-driven publishing's tools (spec 2026-11-03 §14.3): their properties and required fields.
fn posting(action: &str) -> Option<(Value, &'static [&'static str])> {
    let instant = json!({"type":"string","format":"date-time"});
    Some(match action {
        "post_requests" => (
            json!({"status":{"type":"string","enum":["open","answered","expired","all"]}}),
            &[],
        ),
        "posts_propose" => {
            let formats: Vec<&str> = jt_studio::PostFormat::ALL.iter().map(|f| f.key()).collect();
            let post = object(
                json!({"format":{"type":"string","enum":formats},"capability_id":uuid(),
                    "publish_at":instant,
                    "material_ids":{"type":"array","minItems":1,"maxItems":jt_studio::MAX_POST_MATERIALS,
                        "uniqueItems":true,"items":uuid()},
                    "subject":subject(),"hypothesis_id":uuid(),
                    "content_type":{"type":"string","minLength":1,"maxLength":200}}),
                &[
                    "format",
                    "capability_id",
                    "publish_at",
                    "material_ids",
                    "subject",
                    "hypothesis_id",
                ],
            );
            (
                json!({"request_id":uuid(),
                    "request_key":{"type":"string","minLength":1,"maxLength":200},
                    "posts":{"type":"array","minItems":1,"maxItems":jt_studio::MAX_PACKAGE_POSTS,
                        "items":post}}),
                &["request_id", "request_key", "posts"],
            )
        }
        "posts_list" => (json!({"from":instant,"until":instant}), &[]),
        "weekly_summary" => (json!({"week":date()}), &[]),
        _ => return None,
    })
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
/// Who may see a post on the adapted account (TikTok's `privacy_level` names); absent or null:
/// public. Not used for TikTok itself, whose posting screen leaves it to a human, with no default
/// (`jt_studio::requires_posting_screen`).
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
/// A medium of a piece: a stored file that is a material (spec 2026-11-03 D2); inline bytes and
/// hosted URLs are refused, since they carry no provenance.
fn media() -> Value {
    object(
        json!({"kind":{"const":"file"},"id":{"type":"string","format":"uuid"}}),
        &["kind", "id"],
    )
}
