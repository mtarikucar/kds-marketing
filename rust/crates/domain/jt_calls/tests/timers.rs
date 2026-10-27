//! The timers of an agent-driven call, on a scripted clock (spec §3.3).
mod support;

use jt_calls::{
    BridgeEvent, CallSession, CallState, Command, EndCause, PlayKind, TimerAction, TurnKind,
    apply_timer, next_timer, reduce, say,
};
use support::*;
use time::{Duration, OffsetDateTime};

fn at(s: i64) -> OffsetDateTime {
    T0 + Duration::seconds(s)
}

/// An answered agent call whose caller has just finished speaking at second 0.
fn owing() -> CallSession {
    let p = policy();
    let mut s = agent_session();
    reduce(&mut s, &BridgeEvent::Answered, at(-5), &p);
    reduce(
        &mut s,
        &BridgeEvent::Utterance {
            text: "Evet, buyurun".into(),
            is_final: true,
            confidence: Some(0.9),
            stt_ms: Some(120),
        },
        at(0),
        &p,
    );
    s
}

/// Applies whatever is due at second `t`; the played texts.
fn tick(s: &mut CallSession, t: i64) -> (TimerAction, Vec<Command>) {
    let p = policy();
    let action = next_timer(s, at(t), &p);
    let step = apply_timer(s, &action, at(t), &p);
    (action, step.commands)
}

#[test]
fn holding_at_4s() {
    let mut s = owing();
    assert_eq!(tick(&mut s, 3).0, TimerAction::None);
    let (action, commands) = tick(&mut s, 4);
    assert_eq!(action, TimerAction::PlayHolding);
    assert!(matches!(
        &commands[..],
        [Command::Play { clip: PlayKind::Holding, text, .. }] if text == "Bir saniye, kontrol ediyorum."
    ));
    assert_eq!(s.state, CallState::Holding);
    // Not again before 10 s.
    assert_eq!(tick(&mut s, 9).0, TimerAction::None);
}

#[test]
fn holding_again_at_10s() {
    let mut s = owing();
    tick(&mut s, 4);
    let (action, commands) = tick(&mut s, 10);
    assert_eq!(action, TimerAction::PlayHolding);
    // The phrases rotate.
    assert!(matches!(
        &commands[..],
        [Command::Play { text, .. }] if text == "Hemen bakıyorum."
    ));
    assert_eq!(s.metrics.holding_played, 2);
    assert_eq!(tick(&mut s, 19).0, TimerAction::None);
}

#[test]
fn fallback_at_20s() {
    let mut s = owing();
    tick(&mut s, 4);
    tick(&mut s, 10);
    let (action, commands) = tick(&mut s, 20);
    assert_eq!(action, TimerAction::PlayFallback);
    assert!(matches!(
        &commands[..],
        [Command::Play { clip: PlayKind::Fallback, index: 0, text, .. }]
            if text == "Bağlantıda bir gecikme var, lütfen bekleyin."
    ));
    // The agent's wait starts again from the fallback line: holding at +4.
    assert_eq!(tick(&mut s, 23).0, TimerAction::None);
    assert_eq!(tick(&mut s, 24).0, TimerAction::PlayHolding);
}

#[test]
fn closing_when_fallbacks_exhausted() {
    let mut s = owing();
    for t in [4, 10, 20, 24, 30, 40, 44, 50] {
        tick(&mut s, t);
    }
    assert_eq!(s.metrics.fallback_played, 2);
    let (action, commands) = tick(&mut s, 60);
    assert_eq!(action, TimerAction::Close(EndCause::AgentTimeout));
    assert!(matches!(
        &commands[..],
        [Command::Play { clip: PlayKind::Closing, text, .. }, Command::Hangup]
            if text == "Teşekkürler, iyi günler."
    ));
    assert_eq!(s.state, CallState::Ending);
    // The bridge confirms the hangup: ended, the cause kept.
    reduce(
        &mut s,
        &BridgeEvent::Hangup {
            cause: "normal".into(),
        },
        at(61),
        &policy(),
    );
    assert_eq!(s.state, CallState::Ended);
    assert_eq!(s.end_cause, Some(EndCause::AgentTimeout));
    assert_eq!(s.duration_s, Some(66));
    // A plan without fallback lines closes at the first 20 s.
    let mut bare = owing();
    bare.plan.as_mut().unwrap().fallback.clear();
    assert_eq!(
        tick(&mut bare, 20).0,
        TimerAction::Close(EndCause::AgentTimeout)
    );
}

#[test]
fn caller_silence_reprompt() {
    let p = policy();
    let mut s = owing();
    let step = say(&mut s, "Randevunuz yarın 14:00, uygun mu?", true, at(3)).unwrap();
    let Command::Say { seq, .. } = step.commands[0] else {
        panic!("a say command")
    };
    // Waiting for the caller starts when the sentence finished playing.
    reduce(
        &mut s,
        &BridgeEvent::Said {
            seq,
            interrupted_at_char: None,
            tts_ms: Some(300),
        },
        at(5),
        &p,
    );
    assert_eq!(tick(&mut s, 10).0, TimerAction::None);
    let p2 = policy();
    let action = next_timer(&s, at(11), &p2);
    assert_eq!(action, TimerAction::CallerSilence);
    let step = apply_timer(&mut s, &action, at(11), &p2);
    assert!(
        step.commands.is_empty(),
        "the agent is told; nothing is played"
    );
    assert!(matches!(&step.turns[0].kind, TurnKind::Event { name } if name == "caller_silence"));
    // Once only; the caller speaking ends the wait.
    assert_eq!(tick(&mut s, 12).0, TimerAction::None);
    assert_eq!(
        tick(&mut s, 20).0,
        TimerAction::Close(EndCause::CallerSilent)
    );
}

#[test]
fn max_duration_closes() {
    let mut s = owing();
    s.plan.as_mut().unwrap().max_duration_s = 60;
    // The answer was at -5: 55 s later the call is closed, whatever else is due.
    assert_eq!(tick(&mut s, 54).0, TimerAction::PlayFallback);
    assert_eq!(
        tick(&mut s, 55).0,
        TimerAction::Close(EndCause::MaxDuration)
    );
    // The policy's maximum caps the plan's.
    let mut s = owing();
    let mut short = policy();
    short.max_duration_s = 30;
    assert_eq!(
        next_timer(&s, at(25), &short),
        TimerAction::Close(EndCause::MaxDuration)
    );
    // A rep's call has no timers at all.
    let mut human = human_session();
    reduce(&mut human, &BridgeEvent::Answered, at(0), &short);
    assert_eq!(next_timer(&human, at(10_000), &short), TimerAction::None);
    s.state = CallState::Ended;
    assert_eq!(next_timer(&s, at(10_000), &short), TimerAction::None);
}
