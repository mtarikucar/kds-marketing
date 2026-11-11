//! What the free-path bridge adds to the protocol (design addendum §4): the dial's script, the
//! plan's hotwords, the bridge's own phrases in the turn log, and the turns' traces.
mod support;

use jt_calls::{
    AgentReply, BridgeEvent, BridgePhrases, CallPlan, CallState, Command, DialScript, EndCause,
    MAX_HOTWORDS, MAX_PLAN_HOTWORDS, MAX_TRACES, PhraseSet, PlanError, TimerAction, TurnKind,
    TurnTrace, call_hotwords, close, end, next_timer, reduce, say,
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
fn a_trace_reported_after_the_callers_hangup_is_kept() {
    // The bridge times the last turn to its end and reports it after the hangup.
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(
        &mut s,
        &BridgeEvent::Hangup {
            cause: "normal".into(),
        },
        at(9_000),
        &p,
    );
    assert_eq!(s.state, CallState::Ended);
    let trace = TurnTrace {
        endpoint_ms: 250,
        ..TurnTrace::default()
    };
    let step = reduce(&mut s, &BridgeEvent::Trace { trace }, at(9_100), &p);
    assert_eq!(s.metrics.traces.len(), 1);
    assert_eq!(s.metrics.traces[0].endpoint_ms, 250);
    assert_eq!(step, Default::default());
    // Nothing else reaches an ended session.
    let step = reduce(&mut s, &utterance(), at(9_200), &p);
    assert!(step.turns.is_empty());
    assert_eq!(s.metrics.turns, 0);
}

#[test]
fn a_trace_reported_after_the_core_ended_the_call_is_kept() {
    let p = policy();
    // The core closed the call without waiting for the line.
    let mut closed = agent_session();
    reduce(&mut closed, &BridgeEvent::Answered, at(0), &p);
    close(&mut closed, EndCause::AgentEnded, at(5_000));
    assert_eq!(closed.state, CallState::Ended);
    reduce(
        &mut closed,
        &BridgeEvent::Trace {
            trace: TurnTrace::default(),
        },
        at(5_100),
        &p,
    );
    assert_eq!(closed.metrics.traces.len(), 1);
    // The core ended it by script, and the line's hangup came before the trace.
    let mut ended = agent_session();
    reduce(&mut ended, &BridgeEvent::Answered, at(0), &p);
    end(&mut ended, EndCause::AgentEnded, at(5_000));
    reduce(
        &mut ended,
        &BridgeEvent::Hangup {
            cause: "normal".into(),
        },
        at(7_000),
        &p,
    );
    assert_eq!(ended.state, CallState::Ended);
    reduce(
        &mut ended,
        &BridgeEvent::Trace {
            trace: TurnTrace::default(),
        },
        at(7_100),
        &p,
    );
    assert_eq!(ended.metrics.traces.len(), 1);
    assert_eq!(ended.end_cause, Some(EndCause::AgentEnded));
}

#[test]
fn a_plan_without_hotwords_is_written_without_the_key() {
    // A release before hotwords reads plans strictly: one without hotwords must still read there.
    let value = serde_json::to_value(plan()).unwrap();
    assert!(value.get("hotwords").is_none(), "{value}");
    let mut p = plan();
    p.hotwords = vec!["Ada".into()];
    assert_eq!(
        serde_json::to_value(&p).unwrap()["hotwords"],
        json!(["Ada"])
    );
}

#[test]
fn a_plans_hotwords_are_read_trimmed() {
    let mut value = serde_json::to_value(plan()).unwrap();
    value["hotwords"] = json!([" Ada ", "perşembe	", "   "]);
    let p: CallPlan = serde_json::from_value(value).unwrap();
    assert_eq!(p.hotwords, ["Ada", "perşembe", ""]);
    // The blank one is refused, as it was given.
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
}

#[test]
fn plan_hotwords_are_bounded_and_leave_room_for_the_workspace_name() {
    assert_eq!(MAX_PLAN_HOTWORDS, MAX_HOTWORDS - 1);
    let mut p = plan();
    p.hotwords = (0..MAX_PLAN_HOTWORDS).map(|i| format!("ürün{i}")).collect();
    assert_eq!(p.validate(), Ok(()));
    let words = call_hotwords(&p.hotwords, "Figurunica");
    assert_eq!(words.len(), MAX_HOTWORDS);
    assert_eq!(words.last().map(String::as_str), Some("Figurunica"));
    p.hotwords.push("bir fazla".into());
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["   ".into()];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec!["x".repeat(41)];
    assert_eq!(p.validate(), Err(PlanError::Hotwords));
    p.hotwords = vec![format!("  {}  ", "x".repeat(40))];
    assert_eq!(p.validate(), Ok(()));
}

#[test]
fn the_workspace_name_joins_the_plans_hotwords_trimmed_and_once() {
    assert_eq!(
        call_hotwords(&["Ada".into(), "ada".into()], " Figurunica "),
        ["Ada", "Figurunica"]
    );
    // A name the plan already has is not added again.
    assert_eq!(
        call_hotwords(&["figurunica".into()], "Figurunica"),
        ["figurunica"]
    );
    // An unvalidated plan longer than allowed still leaves the name its slot.
    let many: Vec<String> = (0..30).map(|i| format!("w{i}")).collect();
    let words = call_hotwords(&many, "Acme");
    assert_eq!(words.len(), MAX_HOTWORDS);
    assert_eq!(words.last().map(String::as_str), Some("Acme"));
    // Blank words and a blank name are dropped.
    assert_eq!(call_hotwords(&[" ".into(), "Ada".into()], "  "), ["Ada"]);
}

#[test]
fn hotwords_differing_only_in_turkish_case_are_one() {
    // Lowercased the default way, "IŞIK" reads "işik" and would not meet "ışık".
    assert_eq!(
        call_hotwords(&["IŞIK".into(), "ışık".into()], "İzmir Kahve"),
        ["IŞIK", "İzmir Kahve"]
    );
    assert_eq!(
        call_hotwords(&["izmir kahve".into()], "İZMİR KAHVE"),
        ["izmir kahve"]
    );
}
