//! What every path moving an agent's call shares: storing what a step of `jt_calls` yielded (its
//! turns, the caller's cut of a played sentence, its commands for the voice bridge: [`Pending`]),
//! and the call's clock ([`tick`]), run once a second by `jobs::run_call_timers` while the call
//! is on the line.
//!
//! **The clock** (spec §3.3; `jt_calls::next_timer`): while the agent owes a reply, the plan's
//! holding phrases at `slow_agent_s` and `holding_again_s`, its next fallback line at
//! `fallback_after_s`, and once those are spent the closing and the hangup (`agent_timeout`);
//! while the caller is waited for, the agent is told at `caller_silence_s` and the call closed at
//! `caller_silence_close_s`; the call never outlasts its maximum duration; a call not answered
//! within `jt_calls::MAX_RING_S` is hung up, and one whose closing was never reported done is
//! ended after `jt_calls::CLOSING_GRACE_S`. A call whose voice bridge stopped reporting (its
//! heartbeat no longer verifies it) is closed `bridge_offline`: its closing and hangup are queued
//! in case the bridge comes back, and the session ends once the grace is over. So an agent that
//! falls silent, or disconnects, never leaves a caller hanging: the session always ends by
//! script, within `fallback_after_s × (fallback lines + 1)` of the caller's words it left
//! unanswered.
//!
//! One timer action per call and tick: two due at once (after a missed tick) are played a second
//! apart, never on top of each other.

use jt_calls::{
    CallCommandId, CallId, CallMode, CallState, Command, EndCause, Step, TimerAction, Turn,
    apply_timer, next_timer,
};
use jt_capability::{EffectiveStatus, effective_status};
use time::OffsetDateTime;

use super::signal_key;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::usecases::Deps;

/// The commands retained after they were queued (spec §9: bridge commands are purged after 7
/// days); the turns and sessions are kept.
pub const COMMAND_RETENTION: time::Duration = time::Duration::days(7);

/// What steps of a call yielded, gathered until they are stored together.
#[derive(Debug, Default)]
pub struct Pending {
    turns: Vec<Turn>,
    commands: Vec<Command>,
    cuts: Vec<(u32, u32)>,
}

impl Pending {
    /// Adds what `step` yielded.
    pub fn add(&mut self, step: Step) {
        self.turns.extend(step.turns);
        self.commands.extend(step.commands);
        self.cuts.extend(step.interrupted);
    }

    /// Stores it for call `call` in the caller's bundle: the turns appended (a cut sentence among
    /// them marked before, one appended earlier marked in place), the commands queued at `at` in
    /// their order. `true` when anything was stored, which a long-poll should hear of once the
    /// bundle commits.
    pub async fn store(
        self,
        deps: &Deps,
        r: &mut dyn TenantRepos,
        call: CallId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let Pending {
            mut turns,
            commands,
            cuts,
        } = self;
        let stored = !turns.is_empty() || !commands.is_empty() || !cuts.is_empty();
        let mut earlier = Vec::new();
        for (seq, at_char) in cuts {
            match turns.iter_mut().find(|t| t.seq == seq) {
                Some(turn) => turn.meta.interrupted_at_char = Some(at_char),
                None => earlier.push((seq, at_char)),
            }
        }
        if !turns.is_empty() {
            r.calls().append_turns(call, turns).await?;
        }
        for (seq, at_char) in earlier {
            r.calls().mark_interrupted(call, seq, at_char).await?;
        }
        if !commands.is_empty() {
            let queued: Vec<(CallCommandId, Command)> = commands
                .into_iter()
                .map(|c| (CallCommandId(deps.ids.uuid()), c))
                .collect();
            r.calls().enqueue_commands(call, queued, at).await?;
        }
        Ok(stored)
    }
}

/// Runs what is due on agent call `id` at `ctx.now` (see the module docs), in a transaction of
/// its own that locks the session; settles the call when this ends it (`calls::settle`).
/// `false` when nothing was due (or the call is no agent's call on the line).
pub async fn tick(deps: &Deps, ctx: &Ctx, id: CallId) -> Result<bool, AppError> {
    let now = ctx.now;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(mut session) = r.calls().lock(id).await? else {
        return Ok(false);
    };
    if session.mode != CallMode::Agent || !session.state.is_live() {
        return Ok(false);
    }
    let online = r
        .capabilities()
        .find(session.capability_id)
        .await?
        .is_some_and(|c| effective_status(&c, now) == EffectiveStatus::Verified);
    let policy = super::policy_of(r.as_mut()).await?;
    let action = if !online && session.state != CallState::Ending {
        TimerAction::Close(EndCause::BridgeOffline)
    } else {
        next_timer(&session, now, &policy)
    };
    if action == TimerAction::None {
        return Ok(false);
    }
    let mut pending = Pending::default();
    pending.add(apply_timer(&mut session, &action, now, &policy));
    pending.store(deps, r.as_mut(), id, now).await?;
    if session.state == CallState::Ended {
        super::settle(deps, ctx, r.as_mut(), &mut session).await?;
    }
    r.calls().update(session, now).await?;
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    Ok(true)
}

/// The agent calls on the line in workspace `ctx.workspace_id`, oldest first, for the timer job.
pub(crate) async fn live_agent_calls(deps: &Deps, ctx: &Ctx) -> Result<Vec<CallId>, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    Ok(r.calls()
        .live()
        .await?
        .into_iter()
        .filter(|s| s.mode == CallMode::Agent)
        .map(|s| s.id)
        .collect())
}

/// Deletes the workspace's bridge commands queued more than [`COMMAND_RETENTION`] before `now`;
/// how many.
pub(crate) async fn purge_commands(
    deps: &Deps,
    ctx: &Ctx,
    now: OffsetDateTime,
) -> Result<u64, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let n = r.calls().purge_commands(now - COMMAND_RETENTION).await?;
    if n > 0 {
        r.commit().await?;
    }
    Ok(n)
}
