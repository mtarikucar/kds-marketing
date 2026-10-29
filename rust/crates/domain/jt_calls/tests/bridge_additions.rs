//! What the free-path bridge adds to the protocol (design addendum §4): the dial's script, the
//! plan's hotwords, the bridge's own phrases in the turn log, and the turns' traces.
mod support;

use jt_calls::{
    AgentReply, BridgeEvent, BridgePhrases, Command, DialScript, MAX_TRACES, PhraseSet, PlanError,
    TimerAction, TurnKind, TurnTrace, call_hotwords, next_timer, reduce, say,
};
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};

fn at(ms: i64) -> OffsetDateTime {
    T0 + Duration::milliseconds(ms)
}

fn utterance() -> BridgeEvent {
    BridgeEvent::Utterance {
        text: "evet".into(),
        is_final: true,
        confidence: None,
        stt_ms: Some(40),
    }
}

#[test]
fn a_bridge_filler_is_logged_with_the_dialled_text_and_counts_as_this_waits_holding() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::Filler,
            index: 0,
        },
        at(7_700),
        &p,
    );
    assert_eq!(step.turns.len(), 1);
    assert_eq!(step.turns[0].kind, TurnKind::Holding);
    assert_eq!(step.turns[0].text, s.phrases.fillers[0]);
    assert!(step.commands.is_empty());
    // The core's own first holding phrase (4 s after the words) is covered already.
    assert_eq!(next_timer(&s, at(9_000), &p), TimerAction::None);
    reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::LongWait,
            index: 0,
        },
        at(13_000),
        &p,
    );
    assert_eq!(next_timer(&s, at(15_000), &p), TimerAction::None);
    // The plan's fallback line still comes at 20 s.
    assert_eq!(next_timer(&s, at(25_000), &p), TimerAction::PlayFallback);
}

#[test]
fn a_phrase_the_dial_lacks_logs_no_text() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(1_000), &p);
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::Filler,
            index: 9,
        },
        at(3_700),
        &p,
    );
    assert!(step.turns.is_empty());
    assert_eq!(s.clock.holding_in_turn, 1);
}

#[test]
fn a_phrase_is_logged_with_the_text_dialled_for_this_call_not_the_policys_current_one() {
    // The call was dialled with the approved phrases; the owner then rewrites the fillers.
    let mut p = policy();
    p.phrases.fillers = vec!["Hemen dönüyorum.".into()];
    let mut s = agent_session();
    assert_eq!(s.phrases, BridgePhrases::default());
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::Filler,
            index: 0,
        },
        at(7_700),
        &p,
    );
    assert_eq!(step.turns[0].text, "Bir saniye, hemen bakıyorum.");
    // Index 1 is in the dialled set but no longer in the policy's: still the dialled text.
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::Filler,
            index: 1,
        },
        at(8_000),
        &p,
    );
    assert_eq!(step.turns[0].text, "Kontrol ediyorum, kısa bir an.");
    // A phrase the dial carried none of logs nothing, whatever the policy has now.
    s.phrases.long_wait.clear();
    p.phrases.long_wait = vec!["Çok sürdü.".into()];
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::LongWait,
            index: 0,
        },
        at(9_000),
        &p,
    );
    assert!(step.turns.is_empty());
}

#[test]
fn a_session_stored_without_dialled_phrases_reads_the_approved_set() {
    let mut value = serde_json::to_value(agent_session()).unwrap();
    value.as_object_mut().unwrap().remove("phrases");
    let back: jt_calls::CallSession = serde_json::from_value(value).unwrap();
    assert_eq!(back.phrases, BridgePhrases::default());
}

#[test]
fn an_acknowledgement_is_logged_but_covers_nothing() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(1_000), &p);
    let step = reduce(
        &mut s,
        &BridgeEvent::Phrase {
            set: PhraseSet::Acknowledgement,
            index: 1,
        },
        at(1_600),
        &p,
    );
    assert_eq!(step.turns[0].text, "Anladım.");
    assert_eq!(s.clock.holding_in_turn, 0);
}

#[test]
fn traces_are_kept_up_to_the_limit() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    for i in 0..(MAX_TRACES + 5) {
        let trace = TurnTrace {
            endpoint_ms: i as u32,
            ..TurnTrace::default()
        };
        reduce(&mut s, &BridgeEvent::Trace { trace }, at(1_000), &p);
    }
    assert_eq!(s.metrics.traces.len(), MAX_TRACES);
    assert_eq!(s.metrics.traces[0].endpoint_ms, 0);
}

#[test]
fn an_agents_say_records_its_seq_with_its_latency_up_to_the_limit() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance(), at(5_000), &p);
    let step = say(&mut s, "Perşembe uygun.", true, true, at(8_000)).unwrap();
    let Command::Say { seq, .. } = step.commands[0] else {
        panic!("a say")
    };
    assert_eq!(
        s.metrics.agent_replies,
        [AgentReply {
            seq,
            latency_ms: 3_000
        }]
    );
    assert_eq!(s.metrics.agent_latency_ms, [3_000]);
    // A sentence said when nothing was owed ends no wait: no latency, so no reply either.
    say(&mut s, "Devam ediyorum.", true, true, at(9_000)).unwrap();
    assert_eq!(s.metrics.agent_replies.len(), 1);
    // The list is capped like the traces, keeping the first ones.
    for i in 0..(MAX_TRACES + 5) as i64 {
        reduce(&mut s, &utterance(), at(10_000 + i * 10), &p);
        say(&mut s, "Tamam.", true, true, at(10_005 + i * 10)).unwrap();
    }
    assert_eq!(s.metrics.agent_replies.len(), MAX_TRACES);
    assert_eq!(s.metrics.agent_replies[0].seq, seq);
}

#[test]
fn a_dial_without_a_script_reads_the_approved_phrases() {
    let dial: Command = serde_json::from_value(json!({
        "kind": "dial",
        "to_e164": "+905321234567",
        "plan": serde_json::to_value(plan()).unwrap(),
    }))
    .unwrap();
    let Command::Dial { script, .. } = dial else {
        panic!("a dial")
    };
    assert_eq!(script, DialScript::default());
    assert_eq!(script.phrases, BridgePhrases::default());
}

#[test]
fn the_new_events_read_from_the_wire() {
    let phrase: BridgeEvent =
        serde_json::from_value(json!({ "kind": "phrase", "set": "filler", "index": 1 })).unwrap();
    assert_eq!(
        phrase,
        BridgeEvent::Phrase {
            set: PhraseSet::Filler,
            index: 1
        }
    );
    let trace: BridgeEvent = serde_json::from_value(
        json!({ "kind": "trace", "trace": { "endpoint_ms": 250, "stt_final_ms": 300 } }),
    )
    .unwrap();
    assert!(matches!(trace, BridgeEvent::Trace { trace } if trace.endpoint_ms == 250));
}

#[test]
fn plan_hotwords_are_bounded_and_the_workspace_name_joins_them() {
    let mut p = plan();
    p.hotwords = (0..20).map(|i| format!("ürün{i}")).collect();
    assert_eq!(p.validate(), Ok(()));
    p.hotwords.push("bir fazla".into());
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["   ".into()];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["x".repeat(41)];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    assert_eq!(
        call_hotwords(
            &["Ada".into(), "ada".into(), " Figurunica ".into()],
            "Figurunica"
        ),
        ["Ada", "Figurunica"]
    );
}
