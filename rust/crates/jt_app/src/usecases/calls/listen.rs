//! `calls.listen`: what happened on a call since the turn the agent last saw, long-polled (spec
//! §7). The agent's loop is `listen` → think → `say` → `listen`: a listen answers as soon as a
//! turn follows `after_seq` (the caller's words, a played sentence, a holding phrase, the caller
//! falling silent, the hangup), or the call has ended, and otherwise waits up to `wait_s`
//! (at most [`super::MAX_WAIT_S`]) and answers `timed_out`; the agent listens again. A turn
//! appended in this server wakes a waiting listen at once
//! ([`crate::ports::bridges::BridgeSignals`]); one appended by another instance is seen within
//! [`FALLBACK_TICK`]. `calls.say` with `wait_reply_s` waits the same way for the caller's reply.

use jt_calls::{CallId, CallState, Turn};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};

use super::{MAX_WAIT_S, signal_key};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::calls::MAX_CALL_PAGE;
use crate::usecases::Deps;
use crate::usecases::bridges::kernel::FALLBACK_TICK;

/// `calls.listen`: the turns after `after_seq` (all of them when left out), waiting up to
/// `wait_s` seconds for one (at most 25, which is also what an absent `wait_s` waits; more is cut
/// to it; 0 answers at once).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListenQuery {
    #[serde(default)]
    pub after_seq: Option<u32>,
    #[serde(default)]
    pub wait_s: Option<u32>,
}

/// What a listen answers: the call's state, its turns after `after_seq` in order (at most 200;
/// listen again after the last one's `seq` for more), and whether it waited its whole time for
/// none.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListenOut {
    pub call_id: CallId,
    pub state: CallState,
    pub events: Vec<Turn>,
    pub timed_out: bool,
}

/// Waits on call `id` for the turns after `after_seq`, until `enough` holds for what was read, the
/// call ended, or `wait` passed: the call's state, the turns read, and whether the whole wait
/// passed. Woken by the bridges' signals, read again at least every [`FALLBACK_TICK`]. An unknown
/// call is `NOT_FOUND`.
pub(crate) async fn wait_turns(
    deps: &Deps,
    ctx: &Ctx,
    id: CallId,
    after_seq: Option<u32>,
    wait: std::time::Duration,
    enough: fn(&[Turn]) -> bool,
) -> Result<(CallState, Vec<Turn>, bool), AppError> {
    let started = tokio::time::Instant::now();
    loop {
        // Watching before reading: a turn committed after the read still wakes the wait.
        let watch = deps.bridge_signals.watch(signal_key(ctx.workspace_id));
        let (state, events) = {
            let mut r = deps.uow.tenant(ctx.workspace_id).await?;
            let session = r
                .calls()
                .get(id)
                .await?
                .ok_or_else(|| AppError::not_found("no such call"))?;
            let events = r.calls().turns(id, after_seq, MAX_CALL_PAGE).await?;
            r.commit().await?;
            (session.state, events)
        };
        if enough(&events) || state == CallState::Ended {
            return Ok((state, events, false));
        }
        let waited = started.elapsed();
        if waited >= wait {
            return Ok((state, events, true));
        }
        // Woken, or the fallback tick: read again either way.
        let _ = tokio::time::timeout(FALLBACK_TICK.min(wait - waited), watch).await;
    }
}

/// Listens on call `id` (see the module docs). An unknown call is `NOT_FOUND`. Needs
/// `calls.work`.
pub async fn listen(
    deps: &Deps,
    ctx: &Ctx,
    id: CallId,
    query: ListenQuery,
) -> Result<ListenOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    let wait = std::time::Duration::from_secs(u64::from(
        query.wait_s.unwrap_or(MAX_WAIT_S).min(MAX_WAIT_S),
    ));
    let (state, events, timed_out) =
        wait_turns(deps, ctx, id, query.after_seq, wait, |t| !t.is_empty()).await?;
    Ok(ListenOut {
        call_id: id,
        state,
        events,
        timed_out,
    })
}
