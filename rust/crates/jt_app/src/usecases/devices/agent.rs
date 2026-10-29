//! What a connected agent, or a person in the panel, does with the workspace's phones (spec
//! `2026-10-28-device-bridge-design.md` §5.4): lists them ([`list`]), reads a screen ([`observe`]),
//! queues a command for one and waits for its result ([`act`]), follows one command
//! ([`command_get`]) and reads a phone's log ([`commands`]). Every one needs `devices.work`; the
//! owner and the manager hold it, a rep does not (a phone reaches everything on it).
//!
//! **A queued command is not a done command.** [`act`] answers with the command's state: `done` or
//! `failed` (with the bridge's result or the reason) when its bridge answered within the wait,
//! else `queued` (no bridge took it yet) or `leased` (a bridge has it on the phone), and the
//! caller follows it with [`command_get`]. A wait is at most [`MAX_WAIT_S`] seconds, which is also
//! what an absent `wait_s` waits; 0 answers at once. A result its bridge reports wakes the wait at
//! once (the devices' signals, [`super::signal_key`]); one another server instance applied is seen
//! within `kernel::FALLBACK_TICK`. A command no bridge took within
//! `jt_devices::DEFAULT_EXPIRES_IN` (five minutes) is never handed out (it ends `expired`).
//!
//! **Before anything is queued** [`act`] checks, in this order: the command's own bounds
//! (`DeviceCommand::validate`, `VALIDATION` naming the field); for a `push_file`, that its file is
//! stored (`VALIDATION` naming `file_id`, `details.reason = "file_not_found"`); that the phone is
//! one of the workspace's (`NOT_FOUND`), not retired (`CONFLICT`, `details.reason =
//! "phone_retired"`) and online ([`online`]: a registration within [`ONLINE_FOR`] that lists it,
//! else `CONFLICT`, `details.reason = "device_offline"`); and that the phone's bridge lists what
//! the command needs (`jt_devices::required_features`): a kind it does not run is `VALIDATION` with
//! `details.reason = "unsupported_by_bridge"` and the `kind`, text outside ASCII without
//! `text.unicode` is `VALIDATION` with `details.reason = "unicode_unsupported"` and the
//! [`UNICODE_HINT`] (ADBKeyBoard). Nothing else is checked: there is no app allowlist, no rate
//! cap, no approval per command and no address filter (spec §1, owner); a later security layer
//! wraps [`act`], the single way a command is queued.
//!
//! **Logging.** Every queued command writes `devices.command.queued` with the whole command
//! (`command_id`, `phone`, `kind`, `command`: typed text and shell arguments included, and
//! `expires_at`), by the caller, in the transaction that queues it; how it ended is the bridge
//! surface's `devices.command.finished`, and its result stays on the command, which
//! [`command_get`] and [`commands`] read. `tracing` carries the command's id, kind, phone and
//! status only: never its arguments, its result, a failure's detail or a file address.

use std::time::Duration as StdDuration;

use jt_capability::{Capability, CapabilityId, EffectiveStatus, StoredStatus, effective_status};
use jt_device_protocol::PHONE_RETIRED;
use jt_ledger::Actor;
use jt_studio::FileId;
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::bridge::{HELD_FOR, device_of, features_of, is_listed};
use super::{PHONE_KIND, signal_key};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::devices::{
    CommandError, CommandStatus, DEFAULT_EXPIRES_IN, DeviceCommand, DeviceCommandRow, FailReason,
    MAX_DEVICE_COMMAND_PAGE, NewDeviceCommand, TEXT_UNICODE, required_features,
};
use crate::usecases::bridges::kernel;
use crate::usecases::capabilities::{append, version_in_force};
use crate::usecases::{Deps, invalid};

/// The longest an agent's call waits for a command to end, in seconds; also what an absent
/// `wait_s` waits. Below the bridge's own long-poll (`bridge::MAX_WAIT_S`, 25), so a tool call
/// answers well within an MCP client's patience.
pub const MAX_WAIT_S: u32 = 20;
/// How long a phone counts as online after the last registration that listed it: the spec's
/// stale clock for a bridge (four missed heartbeats), as long as a bridge holds a phone it stopped
/// registering.
pub const ONLINE_FOR: Duration = HELD_FOR;
/// How long the address of a file a result names (a screenshot, a pulled file) lives in an
/// answer.
pub const FILE_URL_LIFETIME: Duration = Duration::minutes(10);
/// How many commands a phone's log shows when the caller names no `limit`.
pub const DEFAULT_LOG_LIMIT: u32 = 50;
/// What a phone needs to type text outside ASCII: `adb shell input text` types it wrong, so the
/// bridge types it through ADBKeyBoard, and lists `text.unicode` only when that is installed and
/// enabled.
pub const UNICODE_HINT: &str = "install ADBKeyBoard (com.android.adbkeyboard) on the phone and \
                                enable it as an input method; the bridge then lists text.unicode";

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

/// `devices.act`: the command for the phone, and how long to wait for it to end (at most
/// [`MAX_WAIT_S`] seconds, which is also what an absent `wait_s` waits; more is cut to it).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActInput {
    pub command: DeviceCommand,
    #[serde(default)]
    pub wait_s: Option<u32>,
}

/// `devices.observe`: whether to take a screenshot with the elements, and how long to wait, as
/// for [`ActInput`].
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObserveInput {
    #[serde(default)]
    pub screenshot: bool,
    #[serde(default)]
    pub wait_s: Option<u32>,
}

/// `devices.command_get`: how long to wait for the command to end, as for [`ActInput`].
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitQuery {
    #[serde(default)]
    pub wait_s: Option<u32>,
}

/// `devices.commands`: how many of the phone's most recent commands (1 to 200; 50 when left out;
/// out-of-range values are cut to the range).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogQuery {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A phone as [`list`] shows it: its capability, whether a command can be queued for it now, and
/// what its bridge reported of it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PhoneOut {
    pub capability_id: CapabilityId,
    pub name: String,
    /// Whether [`act`] queues a command for it now ([`online`]).
    pub online: bool,
    /// The capability's status as it reads now.
    pub status: EffectiveStatus,
    pub platform: Option<String>,
    pub serial: Option<String>,
    pub model: Option<String>,
    pub os_version: Option<String>,
    /// `{w, h, rotation}` as the bridge last reported it.
    pub screen: Option<Value>,
    /// What its bridge runs on it: command kinds, and `text.unicode`.
    pub features: Vec<String>,
    /// Whether it types text outside ASCII (its bridge lists `text.unicode`).
    pub unicode: bool,
    /// The bridge program that holds it, and that program's version.
    pub bridge_id: Option<String>,
    pub bridge_version: Option<String>,
    /// Its last registration.
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_seen_at: Option<OffsetDateTime>,
}

/// A command as the agent use cases show it: what was asked, by whom, and where it stands.
///
/// It carries the command's arguments and its result (typed text, shell arguments, screen
/// text): never log one.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CommandOut {
    pub command_id: Uuid,
    /// The phone.
    pub capability_id: CapabilityId,
    pub kind: &'static str,
    pub command: DeviceCommand,
    /// `queued` and `leased` are not done: follow the command with `devices.command_get`.
    pub status: CommandStatus,
    /// How many times a bridge was handed it.
    pub attempts: u32,
    /// What a `done` command produced, as its bridge reported it (`kind`: `observation`, `done`,
    /// `shell` or `file`).
    pub result: Option<Value>,
    /// Why a `failed` command failed, and the line reported with it.
    pub reason: Option<FailReason>,
    pub detail: Option<String>,
    /// An address the file the result names (a screenshot, a pulled file) is read from, for
    /// [`FILE_URL_LIFETIME`]; only in the answers of `act`, `observe` and `command_get`.
    pub file_url: Option<String>,
    pub requested_by: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// No bridge is handed it from then on.
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub leased_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub done_at: Option<OffsetDateTime>,
}

// ---------------------------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------------------------

/// Whether phone `c` takes a command at `now`: verified (not retired, not marked unreachable), by
/// a registration at most [`ONLINE_FOR`] ago, of the bridge that holds it and still lists it. A
/// phone its bridge leaves out of its latest registration (a stuck phone, one unplugged) is not
/// online, however recent that registration.
pub fn online(c: &Capability, now: OffsetDateTime) -> bool {
    c.status == StoredStatus::Verified
        && c.last_verified_at.is_some_and(|at| now - at <= ONLINE_FOR)
        && is_listed(c)
}

/// The string fact `key` of phone `c`'s `connector_public.device`.
fn fact(device: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    device?.get(key)?.as_str().map(str::to_owned)
}

fn phone_out(c: &Capability, now: OffsetDateTime) -> PhoneOut {
    let device = device_of(c);
    let features = features_of(c);
    PhoneOut {
        capability_id: c.id,
        name: c.name.clone(),
        online: online(c, now),
        status: effective_status(c, now),
        platform: fact(device, "platform"),
        serial: fact(device, "serial"),
        model: fact(device, "model"),
        os_version: fact(device, "os_version"),
        screen: device.and_then(|d| d.get("screen")).cloned(),
        unicode: features.iter().any(|f| f == TEXT_UNICODE),
        features,
        bridge_id: fact(device, "bridge_id"),
        bridge_version: fact(device, "version"),
        last_seen_at: c.last_verified_at,
    }
}

/// `devices.list`: the workspace's phones that are not retired, oldest first (see [`PhoneOut`]).
/// Needs `devices.work`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<PhoneOut>, AppError> {
    ctx.require(Permission::DevicesWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let phones = kernel::of_kind(r.as_mut(), PHONE_KIND).await?;
    r.commit().await?;
    Ok(phones
        .iter()
        .filter(|c| c.status != StoredStatus::Retired)
        .map(|c| phone_out(c, ctx.now))
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/// `CONFLICT` with `details.reason = reason`: a phone that cannot take a command now.
fn not_ready(reason: &str, message: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: message.to_owned(),
        details: json!({ "reason": reason }),
    }
}

/// `VALIDATION` naming `command`, with `details.reason = reason` and `extra`: a command the
/// phone's bridge cannot run.
fn unrunnable(reason: FailReason, message: String, extra: Value) -> AppError {
    let mut details = json!({ "field": "command", "reason": reason.key() });
    if let (Some(details), Value::Object(extra)) = (details.as_object_mut(), extra) {
        details.extend(extra);
    }
    AppError {
        code: ErrorCode::Validation,
        message,
        details,
    }
}

/// `Ok` when phone `c` takes command `cmd` at `now` (see the module docs).
fn ready(c: &Capability, cmd: &DeviceCommand, now: OffsetDateTime) -> Result<(), AppError> {
    if c.status == StoredStatus::Retired {
        return Err(not_ready(PHONE_RETIRED, "the phone is retired"));
    }
    if !online(c, now) {
        return Err(not_ready(
            FailReason::DeviceOffline.key(),
            "the phone is offline: no bridge listed it within the last minute",
        ));
    }
    let features = features_of(c);
    let Some(missing) = required_features(cmd)
        .into_iter()
        .find(|needed| !features.iter().any(|f| f == needed))
    else {
        return Ok(());
    };
    if missing == TEXT_UNICODE {
        return Err(unrunnable(
            FailReason::UnicodeUnsupported,
            format!(
                "the phone cannot type text outside ASCII (its bridge does not list \
                 {TEXT_UNICODE}): {UNICODE_HINT}"
            ),
            json!({ "hint": UNICODE_HINT }),
        ));
    }
    Err(unrunnable(
        FailReason::UnsupportedByBridge,
        format!("the phone's bridge does not run `{missing}`"),
        json!({ "kind": missing }),
    ))
}

/// `VALIDATION` naming the field `cmd` breaks a bound with, if it does.
fn bounded(cmd: &DeviceCommand) -> Result<(), AppError> {
    cmd.validate().map_err(|e| match e {
        CommandError::Invalid { field, reason } => invalid(field, &format!("{field}: {reason}")),
    })
}

/// `Ok` unless the file a `push_file` names is not in the workspace's file store (`VALIDATION`
/// naming `file_id`, `details.reason = "file_not_found"`). A store that cannot answer now does not
/// refuse it: the bridge's lease checks the file again.
async fn pushable(deps: &Deps, ws: WorkspaceId, file_id: Uuid) -> Result<(), AppError> {
    let probe = deps
        .files
        .provider_url(ws, FileId(file_id), deps.clock.now() + Duration::minutes(1))
        .await;
    match probe {
        Err(e) if e.code == ErrorCode::NotFound => Err(AppError {
            code: ErrorCode::Validation,
            message: "the file to push is not stored in the workspace".into(),
            details: json!({ "field": "file_id", "reason": FailReason::FileNotFound.key() }),
        }),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// How long a call waits: `wait_s` seconds, at most [`MAX_WAIT_S`], which is also what `None`
/// waits.
fn wait_of(wait_s: Option<u32>) -> StdDuration {
    StdDuration::from_secs(u64::from(wait_s.unwrap_or(MAX_WAIT_S).min(MAX_WAIT_S)))
}

/// `devices.act`: queues `input.command` for phone `phone` and waits up to `input.wait_s` seconds
/// for it to end (see the module docs for what is checked and refused first, and what is
/// ledgered). The command expires `jt_devices::DEFAULT_EXPIRES_IN` after it was queued. Answers
/// the command as it then stands, with an address for the file its result names. Needs
/// `devices.work`.
pub async fn act(
    deps: &Deps,
    ctx: &Ctx,
    phone: CapabilityId,
    input: ActInput,
) -> Result<CommandOut, AppError> {
    ctx.require(Permission::DevicesWork)?;
    let ActInput { command, wait_s } = input;
    bounded(&command)?;
    let ws = ctx.workspace_id;
    if let DeviceCommand::PushFile { file_id, .. } = &command {
        pushable(deps, ws, *file_id).await?;
    }
    let mut r = deps.uow.tenant(ws).await?;
    let c = r
        .capabilities()
        .find(phone)
        .await?
        .filter(|c| c.kind_key == PHONE_KIND)
        .ok_or_else(|| AppError::not_found("no such phone"))?;
    ready(&c, &command, ctx.now)?;
    let id = deps.ids.uuid();
    let payload = json!({
        "command_id": id,
        "phone": phone,
        "kind": command.kind(),
        "command": serde_json::to_value(&command)
            .map_err(|_| AppError::internal("a device command cannot be encoded"))?,
        "expires_at": rfc3339(ctx.now + DEFAULT_EXPIRES_IN),
    });
    let row = r
        .device_commands()
        .enqueue(NewDeviceCommand {
            id,
            capability_id: phone,
            command,
            requested_by: ctx.actor.clone(),
            created_at: ctx.now,
            expires_at: ctx.now + DEFAULT_EXPIRES_IN,
        })
        .await?;
    let in_force = version_in_force(r.as_mut()).await?;
    let queued = append(
        r.as_mut(),
        ctx,
        "devices.command.queued",
        "device_command",
        id,
        in_force,
        payload,
    );
    queued.await?;
    r.commit().await?;
    deps.bridge_signals.notify(signal_key(ws));
    tracing::info!(
        command_id = %id,
        capability_id = %phone,
        kind = row.command.kind(),
        "device command queued"
    );
    let row = settle(deps, ws, row, wait_of(wait_s)).await?;
    Ok(answer(deps, ctx, row).await)
}

/// `devices.observe`: [`act`] with an `observe` command (with a screenshot when
/// `input.screenshot`); a `done` answer's result is the observation (`kind: "observation"`: the
/// screen, the foreground app and the elements), and its `file_url` the screenshot's address.
pub async fn observe(
    deps: &Deps,
    ctx: &Ctx,
    phone: CapabilityId,
    input: ObserveInput,
) -> Result<CommandOut, AppError> {
    let ObserveInput { screenshot, wait_s } = input;
    let command = DeviceCommand::Observe { screenshot };
    act(deps, ctx, phone, ActInput { command, wait_s }).await
}

/// `devices.command_get`: command `id` of the workspace, after waiting up to `query.wait_s`
/// seconds (as for [`act`]) for it to end; at once when it has. An unknown command is
/// `NOT_FOUND`. Needs `devices.work`.
pub async fn command_get(
    deps: &Deps,
    ctx: &Ctx,
    id: Uuid,
    query: WaitQuery,
) -> Result<CommandOut, AppError> {
    ctx.require(Permission::DevicesWork)?;
    let ws = ctx.workspace_id;
    let row = current(deps, ws, id)
        .await?
        .ok_or_else(|| AppError::not_found("no such device command"))?;
    let row = settle(deps, ws, row, wait_of(query.wait_s)).await?;
    Ok(answer(deps, ctx, row).await)
}

/// `devices.commands`: phone `phone`'s most recent commands, newest first, at most
/// `query.limit` (see [`LogQuery`]), with their arguments and results; a retired phone's too. An
/// unknown phone is `NOT_FOUND`. Needs `devices.work`.
pub async fn commands(
    deps: &Deps,
    ctx: &Ctx,
    phone: CapabilityId,
    query: LogQuery,
) -> Result<Vec<CommandOut>, AppError> {
    ctx.require(Permission::DevicesWork)?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_DEVICE_COMMAND_PAGE);
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.capabilities()
        .find(phone)
        .await?
        .filter(|c| c.kind_key == PHONE_KIND)
        .ok_or_else(|| AppError::not_found("no such phone"))?;
    let rows = r.device_commands().list(phone, limit).await?;
    r.commit().await?;
    Ok(rows.into_iter().map(|row| view(row, None)).collect())
}

/// Command `id` of workspace `ws` as it stands, in a read of its own.
async fn current(
    deps: &Deps,
    ws: WorkspaceId,
    id: Uuid,
) -> Result<Option<DeviceCommandRow>, AppError> {
    let mut r = deps.uow.tenant(ws).await?;
    let row = r.device_commands().get(id).await?;
    r.commit().await?;
    Ok(row)
}

/// Command `id` once it has ended (`done`, `failed`, `expired`, `canceled`), `None` before.
async fn ended(
    deps: &Deps,
    ws: WorkspaceId,
    id: Uuid,
) -> Result<Option<DeviceCommandRow>, AppError> {
    Ok(current(deps, ws, id)
        .await?
        .filter(|row| row.status.is_final()))
}

/// Command `row` once it has ended, or as it stands after `wait` (at once when it has ended
/// already, or `wait` is zero).
async fn settle(
    deps: &Deps,
    ws: WorkspaceId,
    row: DeviceCommandRow,
    wait: StdDuration,
) -> Result<DeviceCommandRow, AppError> {
    if row.status.is_final() || wait.is_zero() {
        return Ok(row);
    }
    let id = row.id;
    let started = tokio::time::Instant::now();
    let end = kernel::wait_for(
        deps.bridge_signals.as_ref(),
        signal_key(ws),
        wait,
        move |_| Box::pin(ended(deps, ws, id)),
    )
    .await?;
    let row = match end {
        Some(ended) => ended,
        None => current(deps, ws, id).await?.unwrap_or(row),
    };
    tracing::info!(
        command_id = %id,
        kind = row.command.kind(),
        status = row.status.key(),
        waited_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "device command waited on"
    );
    Ok(row)
}

/// Row `row` as an answer, with `file_url` the address of the file its result names.
fn view(row: DeviceCommandRow, file_url: Option<String>) -> CommandOut {
    CommandOut {
        command_id: row.id,
        capability_id: row.capability_id,
        kind: row.command.kind(),
        command: row.command,
        status: row.status,
        attempts: row.attempts,
        result: row.result,
        reason: row.reason,
        detail: row.detail,
        file_url,
        requested_by: row.requested_by,
        created_at: row.created_at,
        expires_at: row.expires_at,
        leased_at: row.leased_at,
        done_at: row.done_at,
    }
}

/// The file a stored result names: a `file` result's `file_id`, an observation's
/// `screenshot_file_id`.
fn named_file(result: &Value) -> Option<Uuid> {
    let field = match result.get("kind")?.as_str()? {
        "file" => "file_id",
        "observation" => "screenshot_file_id",
        _ => return None,
    };
    result.get(field)?.as_str()?.parse().ok()
}

/// Row `row` as an agent's answer: with an address, signed for [`FILE_URL_LIFETIME`], for the
/// file its result names; without one when the store cannot sign it (a file purged after its
/// seven days, say).
async fn answer(deps: &Deps, ctx: &Ctx, row: DeviceCommandRow) -> CommandOut {
    let Some(file) = row.result.as_ref().and_then(named_file) else {
        return view(row, None);
    };
    let expires_at = deps.clock.now() + FILE_URL_LIFETIME;
    let url = match deps
        .files
        .provider_url(ctx.workspace_id, FileId(file), expires_at)
        .await
    {
        Ok(url) => Some(url.to_string()),
        Err(e) => {
            tracing::warn!(
                command_id = %row.id,
                kind = row.command.kind(),
                code = e.code.as_str(),
                "the file a device command's result names could not be signed"
            );
            None
        }
    };
    view(row, url)
}

/// `at` as RFC 3339 text.
fn rfc3339(at: OffsetDateTime) -> Option<String> {
    at.format(&time::format_description::well_known::Rfc3339)
        .ok()
}
