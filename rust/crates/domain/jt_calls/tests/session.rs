//! The session reducer, event by event, the agent's sentences and the scripted ending; every
//! played text is authored; every record round-trips through serde.
mod support;

use jt_calls::{
    BridgeEvent, CallError, CallOutcome, CallPolicy, CallSession, CallState, Command, EndCause,
    PlayKind, RecordingState, RefusalReason, Speaker, Step, TimerAction, TurnKind, apply_timer,
    close, end, mask_e164, next_timer, reduce, say, transfer,
};
use serde::{Serialize, de::DeserializeOwned};
use support::*;
use time::{Duration, OffsetDateTime};

fn at(s: i64) -> OffsetDateTime {
    T0 + Duration::seconds(s)
}

fn utterance(text: &str) -> BridgeEvent {
    BridgeEvent::Utterance {
        text: text.into(),
        is_final: true,
        confidence: Some(0.8),
        stt_ms: Some(150),
    }
}

#[test]
fn ringing_answered_utterance_say_hangup() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Ringing, at(0), &p);
    assert_eq!(s.state, CallState::Ringing);
    let step = reduce(&mut s, &BridgeEvent::Answered, at(2), &p);
    assert_eq!(s.state, CallState::Live);
    assert_eq!(s.answered_at, Some(at(2)));
    // The opening is played at once, by script.
    assert!(matches!(
        &step.commands[..],
        [Command::Play { clip: PlayKind::Opening, text, .. }] if *text == plan().opening
    ));
    assert!(matches!(
        step.turns[1].kind,
        TurnKind::Say {
            by: Speaker::Script
        }
    ));
    // A partial utterance is not logged; a final one is, and the agent owes a reply.
    assert!(
        reduce(
            &mut s,
            &BridgeEvent::Utterance {
                text: "Ev".into(),
                is_final: false,
                confidence: None,
                stt_ms: None
            },
            at(5),
            &p
        )
        .turns
        .is_empty()
    );
    let step = reduce(&mut s, &utterance("Evet, uygun"), at(6), &p);
    assert_eq!(step.turns[0].kind, TurnKind::Utterance);
    assert_eq!(s.clock.owed_since, Some(at(6)));
    let step = say(&mut s, "Harika, teşekkürler.", true, true, at(9)).unwrap();
    assert_eq!(step.turns[0].meta.latency_ms, Some(3_000));
    assert_eq!(s.metrics.agent_latency_ms, [3_000]);
    assert!(matches!(
        &step.commands[..],
        [Command::Say {
            allow_barge_in: true,
            ..
        }]
    ));
    // Turn numbers increase.
    assert!(step.turns[0].seq > 2);
    let step = reduce(
        &mut s,
        &BridgeEvent::Hangup {
            cause: "normal".into(),
        },
        at(20),
        &p,
    );
    assert_eq!(s.state, CallState::Ended);
    assert_eq!(s.end_cause, Some(EndCause::CallerHangup));
    assert_eq!(s.duration_s, Some(18));
    assert!(matches!(&step.turns[0].kind, TurnKind::Event { name } if name == "hangup"));
    // An ended session takes nothing more.
    assert_eq!(
        reduce(&mut s, &utterance("Alo?"), at(21), &p),
        Step::default()
    );
    assert_eq!(
        say(&mut s, "Alo", true, true, at(21)),
        Err(CallError::NotLive)
    );
}

#[test]
fn agent_timeout() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance("Kimsiniz?"), at(1), &p);
    let mut t = 1;
    loop {
        t += 1;
        let action = next_timer(&s, at(t), &p);
        if let TimerAction::Close(cause) = &action {
            assert_eq!(*cause, EndCause::AgentTimeout);
            apply_timer(&mut s, &action, at(t), &p);
            break;
        }
        apply_timer(&mut s, &action, at(t), &p);
        assert!(t < 200, "the script always ends the call");
    }
    // Two fallback lines of 20 s each, then the closing at the third 20 s.
    assert_eq!(t, 61);
    assert_eq!(s.state, CallState::Ending);
    assert_eq!(s.end_cause, Some(EndCause::AgentTimeout));
}

#[test]
fn transferred_no_answer_busy_and_failure() {
    let p = policy();
    // Never answered: a busy or unanswered line, by the bridge's word.
    for (cause, expected) in [
        ("busy", EndCause::Busy),
        ("no_answer", EndCause::NoAnswer),
        ("whatever", EndCause::NoAnswer),
    ] {
        let mut s = agent_session();
        reduce(&mut s, &BridgeEvent::Ringing, at(0), &p);
        reduce(
            &mut s,
            &BridgeEvent::Hangup {
                cause: cause.into(),
            },
            at(30),
            &p,
        );
        assert_eq!(s.end_cause, Some(expected), "{cause}");
        assert_eq!(s.duration_s, None);
    }
    // A transfer ends the agent's part at once with no closing.
    let mut s = human_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    let step = end(&mut s, EndCause::Transferred, at(40));
    assert!(
        step.commands.is_empty(),
        "a rep's call is not hung up by the server"
    );
    assert_eq!(s.state, CallState::Ended);
    assert_eq!(s.end_cause, Some(EndCause::Transferred));
    // A bridge error hangs up and keeps the line, single-line and bounded.
    let mut s = agent_session();
    let step = reduce(
        &mut s,
        &BridgeEvent::Error {
            failure_line: format!("permanent: bridge: {}\nsecond", "x".repeat(400)),
        },
        at(1),
        &p,
    );
    assert_eq!(step.commands, [Command::Hangup]);
    let Some(EndCause::Failed(line)) = &s.end_cause else {
        panic!("a failure")
    };
    assert_eq!(line.chars().count(), 300);
    assert!(!line.contains('\n'));
    // A planned call ends without a command.
    let mut s = agent_session();
    s.state = CallState::Planned;
    assert!(
        end(
            &mut s,
            EndCause::Refused(RefusalReason::ConsentMissing),
            at(0)
        )
        .commands
        .is_empty()
    );
    assert_eq!(s.state, CallState::Ended);
}

#[test]
fn recording_starts_only_after_the_whole_announcement() {
    let p = policy();
    let mut s = agent_session();
    s.recording = RecordingState::Pending;
    let step = reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    let Command::Play {
        seq,
        clip: PlayKind::Announcement,
        text,
        ..
    } = &step.commands[0]
    else {
        panic!("the announcement first: {:?}", step.commands)
    };
    assert_eq!(*text, p.recording_announcement);
    // Interrupted: no recording.
    let cut = reduce(
        &mut s,
        &BridgeEvent::Said {
            seq: *seq,
            interrupted_at_char: Some(4),
            tts_ms: None,
        },
        at(2),
        &p,
    );
    assert_eq!(cut.interrupted, Some((*seq, 4)));
    assert!(!cut.commands.contains(&Command::Record { start: true }));
    assert_eq!(s.recording, RecordingState::Pending);
    // Heard to its end: recording starts.
    let mut s2 = agent_session();
    s2.recording = RecordingState::Pending;
    let step = reduce(&mut s2, &BridgeEvent::Answered, at(0), &p);
    let Command::Play { seq, .. } = step.commands[0] else {
        unreachable!()
    };
    let done = reduce(
        &mut s2,
        &BridgeEvent::Said {
            seq,
            interrupted_at_char: None,
            tts_ms: Some(400),
        },
        at(3),
        &p,
    );
    assert_eq!(done.commands, [Command::Record { start: true }]);
    reduce(
        &mut s2,
        &BridgeEvent::Recording {
            file_ref: "calls/ws/call.wav".into(),
        },
        at(30),
        &p,
    );
    assert_eq!(
        s2.recording,
        RecordingState::Recording {
            file_ref: Some("calls/ws/call.wav".into())
        }
    );
    // Without an announcement in the policy nothing is announced, nothing recorded.
    let mut s3 = agent_session();
    s3.recording = RecordingState::Pending;
    let silent = CallPolicy {
        recording_announcement: String::new(),
        ..policy()
    };
    let step = reduce(&mut s3, &BridgeEvent::Answered, at(0), &silent);
    assert!(step.commands.iter().all(|c| !matches!(
        c,
        Command::Play {
            clip: PlayKind::Announcement,
            ..
        }
    )));
}

#[test]
fn say_is_refused_off_agent_calls_and_out_of_bounds() {
    let p = policy();
    let mut human = human_session();
    reduce(&mut human, &BridgeEvent::Answered, at(0), &p);
    assert_eq!(
        say(&mut human, "Merhaba", true, true, at(1)),
        Err(CallError::NotAgentCall)
    );
    let mut s = agent_session();
    assert_eq!(
        say(&mut s, "Merhaba", true, true, at(0)),
        Err(CallError::NotLive)
    );
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    assert_eq!(
        say(&mut s, "  ", true, true, at(1)),
        Err(CallError::EmptyText)
    );
    assert_eq!(
        say(&mut s, &"a".repeat(601), true, true, at(1)),
        Err(CallError::TextTooLong)
    );
    assert!(say(&mut s, &"a".repeat(600), false, true, at(1)).is_ok());
}

#[test]
fn every_played_text_is_authored() {
    let p = policy();
    let mut s = agent_session();
    s.recording = RecordingState::Pending;
    let mut authored: Vec<String> = plan().playable().map(str::to_owned).collect();
    authored.push(p.recording_announcement.clone());
    authored.extend(p.holding_default.iter().cloned());
    let agent_lines = ["Randevunuz yarın 14:00.", "Görüşmek üzere."];
    authored.extend(agent_lines.iter().map(|l| (*l).to_owned()));
    let mut played = Vec::new();
    let mut take = |step: Step| {
        played.extend(
            step.commands
                .iter()
                .filter_map(|c| c.text().map(str::to_owned)),
        );
    };
    take(reduce(&mut s, &BridgeEvent::Answered, at(0), &p));
    take(reduce(&mut s, &utterance("Evet"), at(1), &p));
    for t in 2..30 {
        let action = next_timer(&s, at(t), &p);
        take(apply_timer(&mut s, &action, at(t), &p));
    }
    take(say(&mut s, agent_lines[0], true, true, at(30)).unwrap());
    take(reduce(&mut s, &utterance("Tamam"), at(31), &p));
    take(say(&mut s, agent_lines[1], true, true, at(33)).unwrap());
    take(end(&mut s, EndCause::AgentEnded, at(34)));
    assert!(played.len() >= 6, "{played:?}");
    for text in &played {
        assert!(authored.contains(text), "the server composed {text:?}");
    }
}

fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(value: &T) {
    let wire = serde_json::to_value(value).unwrap();
    let back: T = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(&back, value, "{wire}");
}

#[test]
fn every_record_round_trips() {
    let p = policy();
    let mut s = agent_session();
    s.recording = RecordingState::Pending;
    let mut turns = reduce(&mut s, &BridgeEvent::Answered, at(0), &p).turns;
    turns.extend(reduce(&mut s, &utterance("Evet"), at(1), &p).turns);
    turns.extend(say(&mut s, "Peki.", true, true, at(2)).unwrap().turns);
    round_trip(&s);
    for turn in &turns {
        round_trip(turn);
    }
    let wire = serde_json::to_value(&s).unwrap();
    assert_eq!(wire["started_at"], "2026-10-27T10:00:00Z");
    assert_eq!(wire["mode"], serde_json::json!({ "kind": "agent" }));
    round_trip(&plan());
    round_trip(&p);
    round_trip(&human_session());
    for cause in EndCause::samples() {
        round_trip(&cause);
        assert_eq!(
            EndCause::from_parts(cause.key(), cause.detail().as_deref()),
            Some(cause.clone())
        );
    }
    for reason in RefusalReason::ALL {
        assert_eq!(RefusalReason::from_key(reason.key()), Some(reason));
        assert_eq!(serde_json::to_value(reason).unwrap(), reason.key());
    }
    for state in CallState::ALL {
        assert_eq!(CallState::from_key(state.key()), Some(state));
    }
    for outcome in [
        CallOutcome::Connected,
        CallOutcome::Other,
        CallOutcome::Voicemail,
    ] {
        assert_eq!(CallOutcome::from_key(outcome.key()), Some(outcome));
    }
    for event in [
        BridgeEvent::Ringing,
        BridgeEvent::Answered,
        utterance("Evet"),
        BridgeEvent::Dtmf { digit: "1".into() },
        BridgeEvent::Silence { ms: 6_000 },
        BridgeEvent::Hangup {
            cause: "busy".into(),
        },
    ] {
        round_trip(&event);
    }
    // A stored policy missing fields reads as the defaults (tolerant decode).
    let old: CallPolicy =
        serde_json::from_value(serde_json::json!({ "greeting_inbound": "Merhaba" })).unwrap();
    assert_eq!(old.slow_agent_s, 4);
    assert!(old.disclose_assistant);
}

#[test]
fn plan_and_policy_bounds_and_disclosure() {
    let mut p = plan();
    assert_eq!(p.validate(), Ok(()));
    p.holding.clear();
    assert!(p.validate().is_err());
    let mut p = plan();
    p.fallback = vec!["a".into(); 4];
    assert!(p.validate().is_err());
    let mut p = plan();
    p.max_duration_s = 901;
    assert!(p.validate().is_err());
    let mut p = plan();
    p.opening = "x".repeat(601);
    assert_eq!(p.validate().unwrap_err().field(), "plan.opening");

    let policy = policy();
    assert_eq!(policy.validate(), Ok(()));
    assert!(policy.discloses(&plan().opening));
    assert!(!policy.discloses("Merhaba, ben Ayşe."));
    // Asked for, but no sentence set: nothing discloses (fail closed).
    let empty = CallPolicy {
        disclosure_sentence: String::new(),
        ..policy.clone()
    };
    assert!(!empty.discloses(&plan().opening));
    let off = CallPolicy {
        disclose_assistant: false,
        ..empty
    };
    assert!(off.discloses("Merhaba"));
    for bad in [
        CallPolicy {
            slow_agent_s: 10,
            ..policy.clone()
        },
        CallPolicy {
            caller_silence_close_s: 5,
            ..policy.clone()
        },
        CallPolicy {
            handoff_extension: Some("10/1".into()),
            ..policy.clone()
        },
        CallPolicy {
            estimated_minor_per_minute: -1,
            ..policy.clone()
        },
        CallPolicy {
            max_duration_s: 0,
            ..policy.clone()
        },
    ] {
        assert!(bad.validate().is_err(), "{bad:?}");
    }
    assert_eq!(mask_e164("+905321234567"), "+90 5** *** ** 67");
}

#[test]
fn transfer_ends_the_agent_part_without_closing() {
    let p = policy();
    let mut s = agent_session();
    // Not before the call is answered, and never a rep's call.
    assert_eq!(transfer(&mut s, "102", at(0)), Err(CallError::NotLive));
    assert_eq!(
        transfer(&mut human_session(), "102", at(0)),
        Err(CallError::NotAgentCall)
    );
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(
        &mut s,
        &utterance("Bir yetkiliyle görüşmek istiyorum"),
        at(3),
        &p,
    );
    let step = transfer(&mut s, "102", at(5)).unwrap();
    assert_eq!(step.commands, [Command::Transfer { to: "102".into() }]);
    assert!(matches!(&step.turns[0].kind, TurnKind::Event { name } if name == "transferred"));
    assert_eq!(s.state, CallState::Ended);
    assert_eq!(s.end_cause, Some(EndCause::Transferred));
    assert_eq!(s.duration_s, Some(5));
    // The line goes on with the rep: nothing the agent says is played any more.
    assert_eq!(
        say(&mut s, "Alo", true, true, at(6)),
        Err(CallError::NotLive)
    );
    assert_eq!(
        reduce(
            &mut s,
            &BridgeEvent::Hangup {
                cause: "normal".into()
            },
            at(90),
            &p
        ),
        Step::default()
    );
    assert_eq!(s.duration_s, Some(5));
}

#[test]
fn a_sentence_expecting_no_reply_keeps_the_agent_owing() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    reduce(&mut s, &utterance("Fiyat nedir?"), at(2), &p);
    let step = say(&mut s, "Bir saniye, bakıyorum.", true, false, at(4)).unwrap();
    let Command::Say { seq, .. } = step.commands[0] else {
        panic!("a say command")
    };
    // Played: the agent owes its next sentence from its end, so the holding phrase comes 4 s
    // later; the caller is not waited for.
    reduce(
        &mut s,
        &BridgeEvent::Said {
            seq,
            interrupted_at_char: None,
            tts_ms: None,
        },
        at(6),
        &p,
    );
    assert_eq!(s.clock.owed_since, Some(at(6)));
    assert_eq!(s.clock.awaiting_caller_since, None);
    assert_eq!(next_timer(&s, at(9), &p), TimerAction::None);
    assert_eq!(next_timer(&s, at(10), &p), TimerAction::PlayHolding);
    // A sentence expecting a reply waits for the caller once played.
    let step = say(&mut s, "Fiyatı 450 lira.", true, true, at(11)).unwrap();
    let Command::Say { seq, .. } = step.commands[0] else {
        panic!("a say command")
    };
    reduce(
        &mut s,
        &BridgeEvent::Said {
            seq,
            interrupted_at_char: None,
            tts_ms: None,
        },
        at(13),
        &p,
    );
    assert_eq!(s.clock.owed_since, None);
    assert_eq!(s.clock.awaiting_caller_since, Some(at(13)));
}

#[test]
fn close_keeps_a_scripted_cause() {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    let step = end(&mut s, EndCause::AgentTimeout, at(30));
    assert_eq!(step.commands.len(), 2);
    assert_eq!(s.state, CallState::Ending);
    assert_eq!(s.clock.closing_since, Some(at(30)));
    close(&mut s, EndCause::BridgeOffline, at(95));
    assert_eq!(s.state, CallState::Ended);
    assert_eq!(s.end_cause, Some(EndCause::AgentTimeout));
    assert_eq!(s.ended_at, Some(at(95)));
    assert_eq!(s.duration_s, Some(95));
    // A live call closed is ended with the cause given; an ended one is left alone.
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(0), &p);
    close(&mut s, EndCause::BridgeOffline, at(10));
    assert_eq!(s.end_cause, Some(EndCause::BridgeOffline));
    close(&mut s, EndCause::AgentEnded, at(20));
    assert_eq!(s.ended_at, Some(at(10)));
}

/// Keeps `CallSession` constructible for the shared builders.
#[allow(dead_code)]
fn _session(s: CallSession) -> CallSession {
    s
}
