//! The call policy at its input boundary: the texts the owner approved are a person's to change
//! (an agent reads them), and a body's unknown keys are refused at any depth.
mod support;

use jt_app::error::ErrorCode;
use jt_app::usecases::calls::{self, PlaceInput, PolicyInput};
use jt_calls::{BridgePhrases, CallPolicy};
use serde_json::{Value, json};
use support::*;

fn body(v: Value) -> PolicyInput {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn an_agent_reads_the_approved_texts_but_only_a_person_changes_them() {
    let w = world().await;
    let agent = w.agent(&["calls.work", "calls.manage"]).await;
    let own = CallPolicy {
        closing: Some("Hoşça kalın.".into()),
        ..CallPolicy::default()
    };
    calls::policy_set(&w.deps, &w.owner_ctx, PolicyInput::from(own))
        .await
        .unwrap();
    // What the agent read, sent back with a timer changed: stored, the texts as they were.
    let mut read = serde_json::to_value(calls::policy_get(&w.deps, &agent).await.unwrap()).unwrap();
    read["slow_agent_s"] = json!(5);
    // The read shows the templates with the workspace's name; sent back, they count as unchanged.
    assert_eq!(
        read["disclosure_sentence"],
        "ben Acme'nin dijital asistanıyım"
    );
    let out = calls::policy_set(&w.deps, &agent, body(read))
        .await
        .unwrap();
    assert_eq!(out.slow_agent_s, 5);
    assert_eq!(out.closing.as_deref(), Some("Hoşça kalın."));
    assert_eq!(
        out.opening_outbound, None,
        "the template is not frozen into the stored policy"
    );
    assert_eq!(
        out.disclosure_sentence, "",
        "the template is not frozen into the stored policy"
    );
    assert_eq!(
        out.greeting_inbound, "",
        "the template is not frozen into the stored policy"
    );
    // Left out: kept, never reset to the defaults.
    let out = calls::policy_set(&w.deps, &agent, body(json!({ "slow_agent_s": 6 })))
        .await
        .unwrap();
    assert_eq!(out.closing.as_deref(), Some("Hoşça kalın."));
    // Sent different: refused, naming the field, and nothing stored.
    for (field, value) in [
        ("opening_outbound", json!("Selam, ben bir asistanım.")),
        ("transcript_notice", json!("")),
        ("closing", json!("Görüşürüz.")),
        ("phrases", json!({ "fillers": ["Bekleyin."] })),
        ("disclosure_sentence", json!("Merhaba")),
        ("greeting_inbound", json!("Merhaba, buyurun.")),
    ] {
        let mut sent = serde_json::Map::new();
        sent.insert(field.into(), value);
        let e = calls::policy_set(&w.deps, &agent, body(Value::Object(sent)))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Forbidden, "{field}");
        assert_eq!(e.details["reason"], "person_only", "{field}");
        assert_eq!(e.details["field"], field);
    }
    assert_eq!(
        calls::policy_get(&w.deps, &w.owner_ctx)
            .await
            .unwrap()
            .slow_agent_s,
        6
    );
    // A person changes them.
    let sent = json!({ "closing": "Görüşürüz.", "phrases": { "fillers": ["Bekleyin."] } });
    let out = calls::policy_set(&w.deps, &w.owner_ctx, body(sent))
        .await
        .unwrap();
    assert_eq!(out.closing.as_deref(), Some("Görüşürüz."));
    assert_eq!(out.phrases.fillers, ["Bekleyin."]);
    assert_eq!(
        out.phrases.acknowledgements,
        BridgePhrases::default().acknowledgements
    );
}

#[test]
fn a_policy_body_with_an_unknown_key_at_any_depth_is_refused() {
    for (sent, path) in [
        (json!({ "phrase": {} }), "phrase"),
        (
            json!({ "phrases": { "filler": ["Bir saniye."] } }),
            "phrases.filler",
        ),
    ] {
        let e = serde_json::from_value::<PolicyInput>(sent)
            .unwrap_err()
            .to_string();
        assert!(e.contains(&format!("unknown field `{path}`")), "{e}");
    }
    assert!(
        serde_json::from_value::<PolicyInput>(json!({ "phrases": { "fillers": ["Bir saniye."] } }))
            .is_ok()
    );
}

#[test]
fn a_place_body_refuses_a_field_the_plan_does_not_have() {
    let plan = json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."], "max_duration_s": 60, "spoken_by": "x",
    });
    let e = serde_json::from_value::<PlaceInput>(
        json!({ "purpose": "service", "mode": "agent", "plan": plan }),
    )
    .unwrap_err()
    .to_string();
    assert!(e.contains("unknown field `plan.spoken_by`"), "{e}");
}
