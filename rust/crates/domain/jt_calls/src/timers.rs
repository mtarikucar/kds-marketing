//! The timers of an agent-driven call (spec §3.3): while the agent owes a reply, a holding phrase
//! at `slow_agent_s` and again at `holding_again_s`, the next fallback line at `fallback_after_s`
//! and, once the fallback lines are spent, the closing (`agent_timeout`); while the caller is
//! waited for, the agent is told at `caller_silence_s` and the call is closed at
//! `caller_silence_close_s` (`caller_silent`); and the call never outlasts its maximum duration.
//! A rep's call has no timers. [`next_timer`] says what is due; [`apply_timer`] does it.

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::policy::CallPolicy;
use crate::session::{
    CallMode, CallSession, CallState, Command, EndCause, PlayKind, Step, TurnKind, TurnMeta, end,
};

/// What is due on a call now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "cause", rename_all = "snake_case")]
pub enum TimerAction {
    None,
    PlayHolding,
    PlayFallback,
    /// The caller has been silent since the agent spoke: logged so a waiting agent wakes up.
    CallerSilence,
    Close(EndCause),
}

fn secs(s: u16) -> Duration {
    Duration::seconds(i64::from(s))
}

/// What is due on `session` at `now` under `policy` (see the module docs).
pub fn next_timer(session: &CallSession, now: OffsetDateTime, policy: &CallPolicy) -> TimerAction {
    if session.mode != CallMode::Agent
        || !matches!(session.state, CallState::Live | CallState::Holding)
    {
        return TimerAction::None;
    }
    let max = policy.max_duration(session.plan.as_ref().map(|p| p.max_duration_s));
    if let Some(answered) = session.answered_at
        && now - answered >= secs(max)
    {
        return TimerAction::Close(EndCause::MaxDuration);
    }
    let fallback_lines = session.plan.as_ref().map_or(0, |p| p.fallback.len());
    if let Some(owed) = session.clock.owed_since {
        let waited = now - owed;
        if waited >= secs(policy.fallback_after_s) {
            return if usize::from(session.metrics.fallback_played) < fallback_lines {
                TimerAction::PlayFallback
            } else {
                TimerAction::Close(EndCause::AgentTimeout)
            };
        }
        let holdings = session.clock.holding_in_turn;
        if (waited >= secs(policy.holding_again_s) && holdings < 2)
            || (waited >= secs(policy.slow_agent_s) && holdings < 1)
        {
            return TimerAction::PlayHolding;
        }
        return TimerAction::None;
    }
    if let Some(waiting) = session.clock.awaiting_caller_since {
        let waited = now - waiting;
        if waited >= secs(policy.caller_silence_close_s) {
            return TimerAction::Close(EndCause::CallerSilent);
        }
        if waited >= secs(policy.caller_silence_s) && !session.clock.silence_noted {
            return TimerAction::CallerSilence;
        }
    }
    TimerAction::None
}

/// Does `action` on `session` at `now`. A holding phrase is the plan's (else the policy's
/// defaults), rotating; with none to play, nothing is played. A fallback line is the plan's next
/// one, and the agent's wait starts again from it.
pub fn apply_timer(
    session: &mut CallSession,
    action: &TimerAction,
    now: OffsetDateTime,
    policy: &CallPolicy,
) -> Step {
    let mut step = Step::default();
    match action {
        TimerAction::None => {}
        TimerAction::PlayHolding => {
            let phrases: Vec<String> = match &session.plan {
                Some(plan) if !plan.holding.is_empty() => plan.holding.clone(),
                _ => policy.holding_default.clone(),
            };
            session.clock.holding_in_turn = session.clock.holding_in_turn.saturating_add(1);
            if phrases.is_empty() {
                return step;
            }
            let index = usize::from(session.metrics.holding_played) % phrases.len();
            let text = phrases[index].clone();
            let turn = session.turn(now, TurnKind::Holding, text.clone(), TurnMeta::default());
            session.metrics.holding_played = session.metrics.holding_played.saturating_add(1);
            session.state = CallState::Holding;
            step.commands.push(Command::Play {
                seq: turn.seq,
                clip: PlayKind::Holding,
                index: u8::try_from(index).unwrap_or(u8::MAX),
                text,
            });
            step.turns.push(turn);
        }
        TimerAction::PlayFallback => {
            let index = usize::from(session.metrics.fallback_played);
            let Some(text) = session
                .plan
                .as_ref()
                .and_then(|p| p.fallback.get(index))
                .cloned()
            else {
                return end(session, EndCause::AgentTimeout, now);
            };
            let turn = session.turn(now, TurnKind::Fallback, text.clone(), TurnMeta::default());
            session.metrics.fallback_played = session.metrics.fallback_played.saturating_add(1);
            session.clock.owed_since = Some(now);
            session.clock.holding_in_turn = 0;
            session.state = CallState::Live;
            step.commands.push(Command::Play {
                seq: turn.seq,
                clip: PlayKind::Fallback,
                index: u8::try_from(index).unwrap_or(u8::MAX),
                text,
            });
            step.turns.push(turn);
        }
        TimerAction::CallerSilence => {
            session.clock.silence_noted = true;
            step.turns.push(session.turn(
                now,
                TurnKind::Event {
                    name: "caller_silence".into(),
                },
                "",
                TurnMeta::default(),
            ));
        }
        TimerAction::Close(cause) => return end(session, cause.clone(), now),
    }
    step
}
