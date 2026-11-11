//! The agent's turns on its call (spec §7): `calls.say` queues a sentence for the voice bridge to
//! speak, and with `wait_reply_s` then waits for the caller's reply (say and listen merged);
//! `calls.transfer` hands the caller over to a rep's extension and ends the agent's part. The
//! sentence is the agent's own, played as it is: the server neither writes nor rewrites it.

use jt_calls::{CallError, CallId, CallState, Turn, TurnKind};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::session::Pending;
use super::{CallOut, MAX_WAIT_S, extension_is_valid, ledger, reveals, signal_key, view};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::calls::MAX_CALL_PAGE;
use crate::usecases::{Deps, invalid};

/// `calls.say`: the sentence (1 to 600 characters), whether the caller is expected to answer it
/// (by default; without, the agent says it will go on and its silence is covered from the
/// sentence's end), whether the caller may cut it by speaking (by default), and how long to wait
/// for the caller's reply after queuing it.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SayInput {
    pub text: String,
    #[serde(default = "yes")]
    pub expect_reply: bool,
    #[serde(default = "yes")]
    pub allow_barge_in: bool,
    /// After queuing, wait up to this many seconds (at most 25) for the caller's reply and return
    /// it; absent or 0: answer at once, as before.
    #[serde(default)]
    pub wait_reply_s: Option<u32>,
}

fn yes() -> bool {
    true
}

/// What a sentence queued answers: its turn's number and the call's state; with `wait_reply_s`,
/// also the turns after the sentence and whether the whole wait passed without a reply.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SayOut {
    pub call_id: CallId,
    pub seq: u32,
    pub state: CallState,
    /// With `wait_reply_s`: the turns after the sentence, up to the caller's reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Turn>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

/// Whether `turns` hold the caller's reply: words, a key, or the line reporting the caller's
/// silence, a hang-up or a transfer (a phrase the bridge played is not a reply).
fn holds_reply(turns: &[Turn]) -> bool {
    turns.iter().any(|t| match &t.kind {
        TurnKind::Utterance | TurnKind::Dtmf => true,
        TurnKind::Event { name } => {
            matches!(name.as_str(), "caller_silence" | "hangup" | "transferred")
        }
        _ => false,
    })
}

/// `calls.transfer`: the rep's PBX extension (1 to 16 digits); the policy's `handoff_extension`
/// when left out.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferInput {
    #[serde(default)]
    pub to_extension: Option<String>,
}

/// The error for an action the call refuses: `CONFLICT` with `details.reason` `not_live` (and
/// the call's state) or `not_agent_call`; a sentence out of bounds is `VALIDATION` naming `text`.
fn refused(e: CallError, state: CallState) -> AppError {
    match e {
        CallError::EmptyText | CallError::TextTooLong => invalid("text", &e.to_string()),
        CallError::NotLive => AppError {
            code: ErrorCode::Conflict,
            message: e.to_string(),
            details: json!({ "reason": "not_live", "state": state }),
        },
        CallError::NotAgentCall => AppError {
            code: ErrorCode::Conflict,
            message: e.to_string(),
            details: json!({ "reason": "not_agent_call" }),
        },
    }
}

/// Queues `input.text` on call `id` for the voice bridge to speak (`jt_calls::say`): a `say`
/// command and the agent's turn, which records how long the agent took since the caller's words.
/// Refused while the call is not live (`CONFLICT`, `details.reason = "not_live"`): before the
/// answer and once it ended (the caller hung up, the script closed it). An unknown call is
/// `NOT_FOUND`. With `wait_reply_s` it then waits for the caller's reply, as `calls.listen` after
/// the sentence's turn would (at most 25 s; a phrase the bridge played is not a reply), and returns
/// it. Writes no ledger entry (spec §12: never per turn). Needs `calls.work`.
pub async fn say(deps: &Deps, ctx: &Ctx, id: CallId, input: SayInput) -> Result<SayOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such call"))?;
    let state = session.state;
    let step = jt_calls::say(
        &mut session,
        &input.text,
        input.allow_barge_in,
        input.expect_reply,
        ctx.now,
    )
    .map_err(|e| refused(e, state))?;
    let seq = step
        .turns
        .first()
        .map(|t| t.seq)
        .ok_or_else(|| AppError::internal("a sentence without its turn"))?;
    let mut pending = Pending::default();
    pending.add(step);
    pending.store(deps, r.as_mut(), id, ctx.now).await?;
    let state = session.state;
    r.calls().update(session, ctx.now).await?;
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    let Some(wait_s) = input.wait_reply_s.filter(|s| *s > 0) else {
        return Ok(SayOut {
            call_id: id,
            seq,
            state,
            events: None,
            timed_out: None,
        });
    };
    let wait = std::time::Duration::from_secs(u64::from(wait_s.min(MAX_WAIT_S)));
    let (state, events, timed_out) =
        super::listen::wait_turns(deps, ctx, id, Some(seq), wait, holds_reply).await?;
    Ok(SayOut {
        call_id: id,
        seq,
        state,
        events: Some(events),
        timed_out: Some(timed_out),
    })
}

/// Hands the caller on call `id` over to `input.to_extension` (else the policy's
/// `handoff_extension`; neither is `VALIDATION` naming `to_extension`): the voice bridge is asked
/// to transfer the line, and the agent's part ends at once (`transferred`) and is settled
/// (`CallMade`, spend, `calls.ended`). Writes `calls.transferred` (the call and the extension).
/// Refused like [`say`] while the call is not live, or not an agent's. Needs `calls.work`.
pub async fn transfer(
    deps: &Deps,
    ctx: &Ctx,
    id: CallId,
    input: TransferInput,
) -> Result<CallOut, AppError> {
    ctx.require(Permission::CallsWork)?;
    if let Some(ext) = &input.to_extension
        && !extension_is_valid(ext)
    {
        return Err(invalid("to_extension", "an extension is 1 to 16 digits"));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut session = r
        .calls()
        .lock(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such call"))?;
    let to = match input.to_extension {
        Some(ext) => ext,
        None => r.calls().policy().await?.handoff_extension.ok_or_else(|| {
            invalid(
                "to_extension",
                "name to_extension: the call policy has no handoff_extension",
            )
        })?,
    };
    let state = session.state;
    let step = jt_calls::transfer(&mut session, &to, ctx.now).map_err(|e| refused(e, state))?;
    let mut pending = Pending::default();
    pending.add(step);
    pending.store(deps, r.as_mut(), id, ctx.now).await?;
    super::settle(deps, ctx, r.as_mut(), &mut session).await?;
    r.calls().update(session.clone(), ctx.now).await?;
    ledger(
        r.as_mut(),
        ctx,
        "calls.transferred",
        id,
        json!({ "call_id": id, "to_extension": to }),
    )
    .await?;
    let turns = r.calls().turns(id, None, MAX_CALL_PAGE).await?;
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    Ok(CallOut {
        call: view(&session, reveals(ctx)),
        turns,
    })
}
