//! The policy's own opening, notice and phrases (owner decisions of 2026-10-29).
use jt_calls::{BridgePhrases, CLOSING, CallPlan, CallPolicy, TRANSCRIPT_NOTICE};
use serde_json::json;

#[test]
fn the_workspace_fills_only_what_the_owner_left_unwritten() {
    let p = CallPolicy::default().with_workspace("Acme");
    assert_eq!(
        p.opening_outbound.as_deref(),
        Some("Merhaba, ben Acme'nin dijital asistanıyım.")
    );
    assert_eq!(p.transcript_notice.as_deref(), Some(TRANSCRIPT_NOTICE));
    assert_eq!(p.closing.as_deref(), Some(CLOSING));
    assert_eq!(p.disclosure_sentence, "ben Acme'nin dijital asistanıyım");
    assert_eq!(
        p.greeting_inbound,
        "Merhaba, ben Acme'nin dijital asistanıyım. Size nasıl yardımcı olabilirim?"
    );
    let own = CallPolicy {
        opening_outbound: Some("Merhaba, Acme asistanı ben.".into()),
        transcript_notice: Some(String::new()),
        closing: Some("Hoşça kalın.".into()),
        disclosure_sentence: "Acme asistanı".into(),
        ..CallPolicy::default()
    }
    .with_workspace("Acme");
    assert_eq!(
        own.opening_outbound.as_deref(),
        Some("Merhaba, Acme asistanı ben.")
    );
    assert_eq!(own.transcript_notice.as_deref(), Some(""));
    assert_eq!(own.closing.as_deref(), Some("Hoşça kalın."));
    assert_eq!(own.disclosure_sentence, "Acme asistanı");
    // An empty closing is the owner's "none", not "unwritten".
    let none = CallPolicy {
        closing: Some(String::new()),
        ..CallPolicy::default()
    }
    .with_workspace("Acme");
    assert_eq!(none.closing.as_deref(), Some(""));
}

#[test]
fn the_spoken_opening_is_the_workspaces_then_the_notice_then_the_plans() {
    let p = CallPolicy::default().with_workspace("Acme");
    let spoken = p.spoken_opening("Ada Hanım ile mi görüşüyorum?");
    assert_eq!(
        spoken,
        format!(
            "Merhaba, ben Acme'nin dijital asistanıyım. {TRANSCRIPT_NOTICE} Ada Hanım ile mi görüşüyorum?"
        )
    );
    assert!(p.discloses(&spoken));
    assert_eq!(
        p.opening_lines(None),
        [
            "Merhaba, ben Acme'nin dijital asistanıyım.",
            TRANSCRIPT_NOTICE
        ]
    );
    let bare = CallPolicy {
        opening_outbound: Some(String::new()),
        transcript_notice: Some(String::new()),
        ..CallPolicy::default()
    }
    .with_workspace("Acme");
    assert_eq!(bare.spoken_opening("Ada Hanım?"), "Ada Hanım?");
    assert!(!bare.discloses(&bare.spoken_opening("Ada Hanım?")));
}

#[test]
fn openings_and_phrases_are_validated_and_read_tolerantly() {
    assert_eq!(CallPolicy::default().validate(), Ok(()));
    let mut p = CallPolicy::default();
    p.phrases.fillers.push("   ".into());
    assert_eq!(p.validate().unwrap_err().field, "phrases.fillers");
    let mut p = CallPolicy::default();
    p.phrases.acknowledgements = vec!["Tamam.".into(); 6];
    assert_eq!(p.validate().unwrap_err().field, "phrases.acknowledgements");
    let p = CallPolicy {
        opening_outbound: Some("x".repeat(601)),
        ..CallPolicy::default()
    };
    assert_eq!(p.validate().unwrap_err().field, "opening_outbound");
    let p = CallPolicy {
        closing: Some("x".repeat(601)),
        ..CallPolicy::default()
    };
    assert_eq!(p.validate().unwrap_err().field, "closing");
    let p = CallPolicy {
        closing: Some(String::new()),
        ..CallPolicy::default()
    };
    assert_eq!(p.validate(), Ok(()));
    let p: CallPolicy = serde_json::from_value(json!({})).unwrap();
    assert_eq!(
        (p.opening_outbound, p.transcript_notice, p.closing),
        (None, None, None)
    );
    assert_eq!(p.phrases, BridgePhrases::default());
}

#[test]
fn a_plan_may_leave_its_closing_to_the_policy() {
    let mut plan: CallPlan = serde_json::from_value(json!({
        "opening": "Ada Hanım ile mi görüşüyorum?",
        "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."],
        "max_duration_s": 60,
    }))
    .unwrap();
    assert_eq!(plan.closing, "");
    assert_eq!(plan.validate(), Ok(()));
    // The closing is played when there is one: an empty one is not a sentence the plan authors.
    assert_eq!(
        plan.playable().collect::<Vec<_>>(),
        ["Ada Hanım ile mi görüşüyorum?", "Bir saniye."]
    );
    plan.closing = "Hoşça kalın.".into();
    assert_eq!(plan.playable().last(), Some("Hoşça kalın."));
    plan.closing = "   ".into();
    assert!(plan.validate().is_err());
    plan.closing = "x".repeat(601);
    assert!(plan.validate().is_err());
}

#[test]
fn a_stored_plan_reads_a_field_a_later_release_added() {
    let mut value = json!({
        "opening": "Ada Hanım ile mi görüşüyorum?", "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."], "max_duration_s": 60,
    });
    value["spoken_by"] = json!("a later release");
    assert!(serde_json::from_value::<CallPlan>(value).is_ok());
}

#[test]
fn the_plans_field_list_is_every_field_it_writes() {
    let p: CallPlan = serde_json::from_value(json!({
        "opening": "a", "goal": "b", "holding": ["c"], "fallback": ["d"], "closing": "e",
        "max_duration_s": 60, "hotwords": ["Ada"],
    }))
    .unwrap();
    let mut written: Vec<String> = serde_json::to_value(&p)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    written.sort();
    let mut fields: Vec<String> = CallPlan::FIELDS.iter().map(|f| (*f).to_owned()).collect();
    fields.sort();
    assert_eq!(written, fields);
}
