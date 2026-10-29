//! The device bridge's surface (spec `2026-10-28-device-bridge-design.md` §5): the program on the
//! PC a workspace's phones are plugged into registers them every [`HEARTBEAT_S`] seconds
//! ([`register`], its heartbeat), takes the commands queued for them ([`commands`], a long-poll of
//! at most [`MAX_WAIT_S`] seconds), reports what each did ([`results`]) and uploads the files a
//! result names ([`files`]). The bodies are `jt_device_protocol`'s, which the bridge program
//! compiles against too. The catalog serves these to the bridge only: no MCP tool, no panel
//! session. What it does as every bridge does (who may call as it, its heartbeat, its long-poll,
//! its leases) is the bridge kernel's ([`kernel`]), with [`DEVICE_BRIDGE`] as its spec; what is
//! the device bridge's own stays here.
//!
//! **Who.** The bridge calls with an API key issued with `devices.bridge` and nothing else
//! ([`ctx_for_bridge`]); every use case here refuses any other caller, a person or an agent whose
//! key holds every permission included (`FORBIDDEN`, `details.reason = "bridge_key_only"`). It
//! acts as the system (`Actor::System { component: "device_bridge" }`). The key is also which
//! bridge calls ([`BridgeCaller::bridge`]): a poll carries nothing else that tells a workspace's
//! bridges apart, so each bridge program holds a key of its own.
//!
//! **Phones.** A registration verifies a `phone` capability for each phone it lists (declaring it
//! on the first one, `{platform}:{serial}` as its external id) and merges what it reported into
//! `connector_public.device` key by key ([`FactsMerge::Deep`]): a fact one registration leaves out
//! (a model `adb` could not read) is kept. Beside the phone's facts (`platform`, `serial`, `model`,
//! `os_version`, `screen`, `features`) and the bridge's (`bridge_id`, `version`, `protocol`), it
//! keeps which bridge listed the phone last (`listed_by`, that bridge's key id), whether that
//! bridge's latest registration lists it (`listed`, made `false` by a registration of that bridge
//! that leaves it out) and every bridge that ever registered it (`registered_by`, each with when it
//! last did). A phone that fails its own checks is refused with the reason, a retired one that is
//! still plugged in with [`PHONE_RETIRED`] (nothing is declared or merged for either), and one
//! phone never refuses the registration: the others register as usual. Only protocol 1 exists, so
//! every body sent back is protocol 1's.
//!
//! **Commands.** A poll leases the due commands (`ports::devices::DeviceCommandRepo::pick_due`)
//! of exactly the phones the bridge's latest registration lists, oldest first, at most the poll's
//! limit; one handed out and not answered within [`REDELIVER_AFTER`] is handed out again, and the
//! bridge acts on a command id once. Each read checks every command it picked against what the
//! phone's bridge lists now (`jt_devices::supports` over the phone's current `features`): one it
//! does not list any more is failed `unsupported_by_bridge`, never leased. A read that failed all
//! it picked and leased nothing reads again at once. A `push_file` command carries the address its
//! file is downloaded from, signed for [`DOWNLOAD_URL_LIFETIME`] (made after the read committed);
//! one whose file cannot be signed is failed `bridge_error` instead of handed out. While nothing
//! is due the poll waits: a command queued in this server wakes it at once (the devices' signals,
//! [`super::signal_key`]), and it looks again at least every [`kernel::FALLBACK_TICK`].
//!
//! A command redelivered after its lease went unanswered can be failed at its redelivery (its
//! phone's bridge stopped listing what it needs); a result its bridge then sends for the first
//! delivery is a duplicate: the command already ended.
//!
//! **Results.** A batch is checked whole first: one that breaks a limit
//! (`jt_device_protocol::ResultsIn::validate`), or that names a file that is not one of the
//! workspace's device files, is refused (`VALIDATION` naming the field) and nothing of it is
//! applied. Then each result is applied once, by command id, to a command of a phone this bridge
//! ever registered: a late one from a phone the bridge has left out since still counts, since the
//! command really ran. A result for any other command (unknown, another bridge's, or one never
//! handed out) changes nothing and is counted `unknown`, never refused.
//!
//! **Files.** An upload is the file's bytes, `image/png` (a screenshot) or
//! `application/octet-stream` (a file pulled off a phone), kept in the file store and recorded as
//! the workspace's for [`FILE_RETENTION`]. Each upload is a new file, a retried one included.
//!
//! **Logging.** Every command that ends through this surface writes `devices.command.finished`
//! (`command_id`, `kind`, `status`, `reason`, `duration_ms`: the bridge's, `null` for a failure the
//! server decided); its result stays on the command. `tracing` carries ids, kinds, statuses and
//! counts only: never a command's payload, a result, a failure's detail or a file's bytes.

use std::collections::{HashMap, HashSet};
use std::time::Duration as StdDuration;

use jt_capability::{Capability, CapabilityId, MAX_NAME_CHARS, StoredStatus, validate_external_id};
use jt_device_protocol::{
    CommandResult, LeasedCommand, Outcome, PHONE_RETIRED, PhoneReport, ProtocolError, RefusedPhone,
    RegisteredPhone,
};
use jt_strategy::StrategyVersionId;
use jt_studio::FileId;
use jt_tenancy::{ApiKeyId, Permission};
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::{PHONE_KIND, signal_key};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::connectors::MediaUpload;
use crate::ports::devices::{
    DeviceCommand, DeviceCommandRow, DeviceFile, FailReason, Finish, Finished, REDELIVER_AFTER,
    TEXT_UNICODE, supports,
};
use crate::usecases::api_keys::AgentPrincipal;
use crate::usecases::bridges::kernel::{self, Beat, BridgeSpec, FactsMerge, Held, Lease};
use crate::usecases::capabilities::{append, locked, version_in_force};
use crate::usecases::files::{DEVICE_FILE_LIMIT, OCTET_STREAM, validate_stored};
use crate::usecases::{Deps, invalid};

/// The device bridge as the bridge kernel knows it: the system component `device_bridge`, its
/// key's one permission `devices.bridge`, a heartbeat every 15 seconds, `devices.bridge.online` /
/// `devices.bridge.offline` as a phone comes back and goes silent, a command handed out again 10
/// seconds after it was leased unanswered, and each phone's facts merged key by key.
pub const DEVICE_BRIDGE: BridgeSpec = BridgeSpec {
    component: "device_bridge",
    name: "device bridge",
    permission: Permission::DevicesBridge,
    heartbeat_s: HEARTBEAT_S,
    online_action: "devices.bridge.online",
    offline_action: "devices.bridge.offline",
    redeliver_after: REDELIVER_AFTER,
    merge: FactsMerge::Deep,
};
/// The bodies of the bridge's routes, and the most bytes of a results batch's body.
pub use jt_device_protocol::{
    CommandsOut, CommandsQuery, FileOut, MAX_RESULTS_BODY_BYTES, RegisterIn, RegisterOut,
    ResultsIn, ResultsOut,
};
/// How often the bridge registers, and the longest a poll for commands waits, in seconds.
pub use jt_device_protocol::{HEARTBEAT_S, MAX_WAIT_S};
/// How long the download address of a `push_file` command lives: long enough for the bridge to
/// start the download after the command waited its turn on the phone (the bridge fails a command
/// that waited longer than `jt_devices::DEFAULT_EXPIRES_IN`, five minutes), short enough that an
/// address that leaked soon stops working. The download itself may run past it.
pub const DOWNLOAD_URL_LIFETIME: Duration = Duration::minutes(10);
/// How long a device file is kept (spec §5.6).
pub const FILE_RETENTION: Duration = Duration::days(7);
/// The type of a screenshot.
const PNG: &str = "image/png";

// ---------------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------------

/// A call the device bridge makes: its context, and which bridge it is.
#[derive(Clone, Debug)]
pub struct BridgeCaller {
    /// The system component `device_bridge` in the key's workspace ([`kernel::ctx_for`]).
    pub ctx: Ctx,
    /// The bridge: the id of its key.
    pub bridge: ApiKeyId,
}

/// The call the device bridge makes at `now` with the key behind `p` (see [`BridgeCaller`]).
pub fn ctx_for_bridge(p: &AgentPrincipal, now: OffsetDateTime) -> BridgeCaller {
    BridgeCaller {
        ctx: kernel::ctx_for(&DEVICE_BRIDGE, p, now),
        bridge: p.api_key_id,
    }
}

/// `Ok` for the bridge's own context: `devices.bridge` (else `FORBIDDEN` naming it), held alone by
/// the bridge's component (else `FORBIDDEN` with `details.reason = "bridge_key_only"`).
fn authorize(b: &BridgeCaller) -> Result<(), AppError> {
    kernel::require_bridge(&DEVICE_BRIDGE, &b.ctx)
}

/// `VALIDATION` naming the field a body breaks a limit with (`details.field` =
/// `ProtocolError::field`, which the bridge logs when it drops what was refused).
fn refused(e: ProtocolError) -> AppError {
    invalid(e.field(), &e.to_string())
}

// ---------------------------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------------------------

/// The external id of a phone: `{platform}:{serial}`.
fn external_id(phone: &PhoneReport) -> String {
    format!("{}:{}", phone.platform.key(), phone.serial)
}

/// What a phone's capability keeps of it (`connector_public.device`).
fn device_of(c: &Capability) -> Option<&Map<String, Value>> {
    c.connector_public.get("device")?.as_object()
}

/// Whether bridge `bridge`'s latest registration lists phone `c`.
fn listed_by(c: &Capability, bridge: ApiKeyId) -> bool {
    device_of(c).is_some_and(|d| {
        d.get("listed_by").and_then(Value::as_str) == Some(bridge.to_string().as_str())
            && d.get("listed").and_then(Value::as_bool) == Some(true)
    })
}

/// Whether bridge `bridge` ever registered phone `c`.
fn registered_by(c: &Capability, bridge: ApiKeyId) -> bool {
    device_of(c)
        .and_then(|d| d.get("registered_by"))
        .and_then(Value::as_object)
        .is_some_and(|by| by.contains_key(&bridge.to_string()))
}

/// What phone `c`'s bridge lists it can run, as its latest registration reported.
fn features_of(c: &Capability) -> Vec<String> {
    device_of(c)
        .and_then(|d| d.get("features"))
        .and_then(Value::as_array)
        .map(|features| {
            features
                .iter()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Phone `c`'s serial: its external id after the platform.
fn serial_of(c: &Capability) -> Option<String> {
    let (_, serial) = c.external_id.as_deref()?.split_once(':')?;
    Some(serial.to_owned())
}

/// Why phone `phone` cannot register, if it cannot: its own limits
/// (`jt_device_protocol::PhoneReport::validate`), or a serial that cannot be part of an external
/// id.
fn phone_fault(phone: &PhoneReport) -> Option<String> {
    if let Err(e) = phone.validate() {
        return Some(e.to_string());
    }
    validate_external_id(&external_id(phone))
        .err()
        .map(|_| "serial: must not contain control characters".to_owned())
}

/// A phone's name when it is declared: its model and serial (its serial alone without a model),
/// control characters blanked, cut to a capability name's length.
fn name_of(phone: &PhoneReport) -> String {
    let serial = phone.serial.trim();
    let label = match phone.model.as_deref().map(str::trim) {
        Some(model) if !model.is_empty() => format!("{model} ({serial})"),
        _ => format!("Phone {serial}"),
    };
    let name: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_NAME_CHARS)
        .collect();
    name.trim_end().to_owned()
}

/// What a registration keeps of phone `phone` under `connector_public.device`: what it reported
/// (a model or an OS version it could not read, left out or blank, is not written, so the one
/// kept stays), the bridge's own facts, and that bridge `b` lists it now.
fn device_facts(b: &BridgeCaller, input: &RegisterIn, phone: &PhoneReport) -> Map<String, Value> {
    let bridge = b.bridge.to_string();
    let mut device = Map::new();
    device.insert("platform".into(), json!(phone.platform.key()));
    device.insert("serial".into(), json!(phone.serial));
    for (key, value) in [("model", &phone.model), ("os_version", &phone.os_version)] {
        if let Some(value) = value.as_deref().filter(|v| !v.trim().is_empty()) {
            device.insert(key.into(), json!(value));
        }
    }
    if let Some(screen) = phone.screen {
        device.insert("screen".into(), json!(screen));
    }
    device.insert("features".into(), json!(phone.features));
    device.insert("bridge_id".into(), json!(input.bridge_id));
    device.insert("version".into(), json!(input.version));
    device.insert("protocol".into(), json!(input.protocol));
    device.insert("listed_by".into(), json!(bridge));
    device.insert("listed".into(), json!(true));
    let at = b.ctx.now.format(&Rfc3339).ok();
    device.insert(
        "registered_by".into(),
        Value::Object(Map::from_iter([(bridge, json!(at))])),
    );
    device
}

/// What one registration does with a phone, in the order the phones are locked.
enum Step {
    /// Its heartbeat; the phone is the `index`-th the bridge listed.
    Beat {
        index: usize,
        platform: jt_device_protocol::Platform,
        serial: String,
        beat: Beat,
    },
    /// A phone the bridge listed before and leaves out now.
    LeaveOut(CapabilityId),
}

/// `devices.bridge.register`: the bridge's heartbeat (see the module docs). A body that breaks a
/// limit (`RegisterIn::validate`) is `VALIDATION` naming the field, and nothing is registered;
/// a phone of its own is refused in [`RegisterOut::refused`], never the registration. Each phone
/// it lists is verified (declared first when the workspace has none of its external id, writing
/// `capability.declare`), its facts merged, and `devices.bridge.online` written (`capability_id`,
/// `external_id`, `bridge_id`, `version`, `declared`) when it did not read verified until now.
/// Each phone this bridge's previous registration listed and this one leaves out reads as left
/// out. Only the bridge's key.
pub async fn register(
    deps: &Deps,
    b: &BridgeCaller,
    input: RegisterIn,
) -> Result<RegisterOut, AppError> {
    authorize(b)?;
    input.validate().map_err(refused)?;
    let ctx = &b.ctx;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let in_force = version_in_force(r.as_mut()).await?;
    let phones = kernel::of_kind(r.as_mut(), PHONE_KIND).await?;
    let refusal = |phone: &PhoneReport, reason: String| RefusedPhone {
        platform: phone.platform,
        serial: phone.serial.clone(),
        reason,
    };
    let mut refused_phones = Vec::new();
    let mut steps: Vec<(CapabilityId, Step)> = Vec::new();
    for (index, phone) in input.phones.iter().enumerate() {
        if let Some(fault) = phone_fault(phone) {
            refused_phones.push(refusal(phone, fault));
            continue;
        }
        let external_id = external_id(phone);
        let (id, declared) = match kernel::held(&phones, &external_id) {
            Held::Live(c) => (c.id, false),
            Held::Retired => {
                refused_phones.push(refusal(phone, PHONE_RETIRED.into()));
                continue;
            }
            Held::Missing => {
                let name = name_of(phone);
                let ids = deps.ids.as_ref();
                let declared = kernel::declare(
                    r.as_mut(),
                    ctx,
                    ids,
                    PHONE_KIND,
                    &name,
                    &external_id,
                    in_force,
                );
                (declared.await?, true)
            }
        };
        let beat = Beat {
            capability_id: id,
            facts: Map::from_iter([(
                "device".to_owned(),
                Value::Object(device_facts(b, &input, phone)),
            )]),
            online: json!({
                "capability_id": id,
                "external_id": external_id,
                "bridge_id": input.bridge_id,
                "version": input.version,
                "declared": declared,
            }),
        };
        steps.push((
            id,
            Step::Beat {
                index,
                platform: phone.platform,
                serial: phone.serial.clone(),
                beat,
            },
        ));
    }
    let listed: HashSet<CapabilityId> = steps.iter().map(|(id, _)| *id).collect();
    for c in &phones {
        if c.status != StoredStatus::Retired && listed_by(c, b.bridge) && !listed.contains(&c.id) {
            steps.push((c.id, Step::LeaveOut(c.id)));
        }
    }
    // Locked in the order of their ids, so two registrations that share phones never wait on
    // each other in a circle.
    steps.sort_by_key(|(id, _)| *id);
    let mut registered = Vec::new();
    for (id, step) in steps {
        match step {
            Step::Beat {
                index,
                platform,
                serial,
                beat,
            } => match kernel::heartbeat(r.as_mut(), ctx, &DEVICE_BRIDGE, in_force, beat).await {
                Ok(_) => registered.push((
                    index,
                    RegisteredPhone {
                        serial,
                        capability_id: id.as_uuid(),
                    },
                )),
                // Retired since it was read: refused as every retired phone is.
                Err(e) if e.code == ErrorCode::Conflict => refused_phones.push(RefusedPhone {
                    platform,
                    serial,
                    reason: PHONE_RETIRED.into(),
                }),
                Err(e) => return Err(e),
            },
            Step::LeaveOut(id) => leave_out(r.as_mut(), ctx, id, b.bridge).await?,
        }
    }
    r.commit().await?;
    registered.sort_by_key(|(index, _)| *index);
    let registered = registered.into_iter().map(|(_, phone)| phone).collect();
    Ok(RegisterOut::new(registered, refused_phones))
}

/// Marks phone `id` as left out of the latest registration of bridge `bridge`, which listed it
/// before: no command is leased for it from the next poll on. Read under the lock, so a phone that
/// another bridge listed or that was retired since is left as it stands.
async fn leave_out(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: CapabilityId,
    bridge: ApiKeyId,
) -> Result<(), AppError> {
    let mut c = locked(r, id).await?;
    if c.status == StoredStatus::Retired || !listed_by(&c, bridge) {
        return Ok(());
    }
    kernel::merge_facts(
        &mut c.connector_public,
        Map::from_iter([("device".to_owned(), json!({ "listed": false }))]),
        FactsMerge::Deep,
    );
    c.updated_at = ctx.now;
    r.capabilities().update(c).await?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// What one read of a poll took.
enum Taken {
    /// Leased, for the phone with this serial.
    Leased(Box<DeviceCommandRow>, String),
    /// Failed, as the phone's bridge does not list what it needs.
    Failed,
}

/// `devices.bridge.commands`: the bridge's poll (see the module docs), leasing at most
/// `query.limit` commands (1 to 20) and waiting up to `query.wait_s` seconds (at most
/// [`MAX_WAIT_S`]) for one; out-of-range values are cut to the range. Only the bridge's key.
pub async fn commands(
    deps: &Deps,
    b: &BridgeCaller,
    query: CommandsQuery,
) -> Result<CommandsOut, AppError> {
    authorize(b)?;
    let query = query.clamped();
    let (limit, wait) = (query.limit, StdDuration::from_secs(u64::from(query.wait_s)));
    let commands = kernel::wait_for(
        deps.bridge_signals.as_ref(),
        signal_key(b.ctx.workspace_id),
        wait,
        move |waited| Box::pin(read(deps, b, limit, waited)),
    )
    .await?;
    Ok(CommandsOut {
        commands: commands.unwrap_or_default(),
    })
}

/// One read of the poll, `waited` into it: the commands handed out, `None` when none was due.
async fn read(
    deps: &Deps,
    b: &BridgeCaller,
    limit: u32,
    waited: StdDuration,
) -> Result<Option<Vec<LeasedCommand>>, AppError> {
    let bridge = b.bridge;
    loop {
        let taken = kernel::lease(deps, &b.ctx, &DEVICE_BRIDGE, waited, move |r, ctx, at| {
            Box::pin(take(r, ctx, bridge, limit, at))
        })
        .await?;
        let Some(taken) = taken else {
            return Ok(None);
        };
        let mut leased = Vec::new();
        let mut failed = 0_usize;
        for t in taken {
            match t {
                Taken::Leased(row, serial) => leased.push((*row, serial)),
                Taken::Failed => failed += 1,
            }
        }
        if failed > 0 {
            deps.bridge_signals.notify(signal_key(b.ctx.workspace_id));
        }
        let now = b.ctx.now + Duration::try_from(waited).unwrap_or(Duration::ZERO);
        let handed = hand_out(deps, &b.ctx, leased, now).await?;
        if !handed.is_empty() {
            tracing::info!(
                component = DEVICE_BRIDGE.component,
                leased = handed.len(),
                failed,
                "device commands handed out"
            );
            return Ok(Some(handed));
        }
        // Every command this read picked was failed: the next due ones, if any, are read at once
        // rather than at the next signal.
    }
}

/// The lease of one read (in its transaction): picks the due commands of the phones bridge
/// `bridge` lists now, at most `limit`, fails those their phone's bridge does not list what they
/// need for (ledgered), and leases the rest. The phones and their features are read before
/// anything is picked, so nothing waits on another read while rows are locked.
async fn take(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    bridge: ApiKeyId,
    limit: u32,
    at: Lease,
) -> Result<Vec<Taken>, AppError> {
    let phones: HashMap<CapabilityId, (String, Vec<String>)> = kernel::of_kind(r, PHONE_KIND)
        .await?
        .iter()
        .filter(|c| c.status != StoredStatus::Retired && listed_by(c, bridge))
        .filter_map(|c| Some((c.id, (serial_of(c)?, features_of(c)))))
        .collect();
    if phones.is_empty() {
        return Ok(Vec::new());
    }
    let caps: Vec<CapabilityId> = phones.keys().copied().collect();
    let picked = r
        .device_commands()
        .pick_due(&caps, at.now, at.redeliver_before, limit)
        .await?;
    let no_features = Vec::new();
    let features = |row: &DeviceCommandRow| {
        phones
            .get(&row.capability_id)
            .map_or(&no_features, |(_, f)| f)
    };
    let (fit, unfit): (Vec<_>, Vec<_>) = picked
        .into_iter()
        .partition(|row| supports(features(row), &row.command));
    let mut taken = Vec::new();
    if !unfit.is_empty() {
        let in_force = version_in_force(r).await?;
        for row in &unfit {
            let detail = format!(
                "the phone's bridge does not list `{}`",
                missing(features(row), &row.command)
            );
            let failed = r
                .device_commands()
                .fail_pending(&[row.id], FailReason::UnsupportedByBridge, &detail, at.now)
                .await?;
            for failed in failed {
                finished(r, ctx, in_force, &failed, None).await?;
                tracing::info!(
                    component = DEVICE_BRIDGE.component,
                    command_id = %failed.id,
                    kind = failed.command.kind(),
                    status = failed.status.key(),
                    "device command refused at lease time"
                );
                taken.push(Taken::Failed);
            }
        }
    }
    let ids: Vec<Uuid> = fit.iter().map(|row| row.id).collect();
    for row in r.device_commands().mark_leased(&ids, at.now).await? {
        let serial = phones
            .get(&row.capability_id)
            .map(|(serial, _)| serial.clone())
            .unwrap_or_default();
        taken.push(Taken::Leased(Box::new(row), serial));
    }
    Ok(taken)
}

/// What a bridge listing `features` lacks for `cmd`: its kind, or [`TEXT_UNICODE`] for text
/// outside ASCII.
fn missing<'a>(features: &[String], cmd: &'a DeviceCommand) -> &'a str {
    if features.iter().any(|f| f == cmd.kind()) {
        TEXT_UNICODE
    } else {
        cmd.kind()
    }
}

/// The commands `leased`, as the bridge takes them, each `push_file` with its download address
/// signed at `now`, after the lease committed (signing may reach the file store). One whose file
/// cannot be signed is failed `bridge_error` in a transaction of its own, ledgered, and not handed
/// out.
async fn hand_out(
    deps: &Deps,
    ctx: &Ctx,
    leased: Vec<(DeviceCommandRow, String)>,
    now: OffsetDateTime,
) -> Result<Vec<LeasedCommand>, AppError> {
    let ws = ctx.workspace_id;
    let mut handed = Vec::new();
    let mut unsigned = Vec::new();
    for (row, serial) in leased {
        let download_url = match &row.command {
            DeviceCommand::PushFile { file_id, .. } => {
                let expires_at = now + DOWNLOAD_URL_LIFETIME;
                match deps
                    .files
                    .provider_url(ws, FileId(*file_id), expires_at)
                    .await
                {
                    Ok(url) => Some(url.to_string()),
                    Err(e) => {
                        tracing::warn!(
                            component = DEVICE_BRIDGE.component,
                            command_id = %row.id,
                            kind = row.command.kind(),
                            code = e.code.as_str(),
                            "the file of a leased command could not be signed for download"
                        );
                        unsigned.push(row.id);
                        continue;
                    }
                }
            }
            _ => None,
        };
        handed.push(LeasedCommand {
            id: row.id,
            capability_id: row.capability_id.as_uuid(),
            serial,
            command: row.command,
            expires_at: row.expires_at,
            download_url,
        });
    }
    if !unsigned.is_empty() {
        let at = Ctx { now, ..ctx.clone() };
        let mut r = deps.uow.tenant(ws).await?;
        let in_force = version_in_force(r.as_mut()).await?;
        let failed = r
            .device_commands()
            .fail_pending(
                &unsigned,
                FailReason::BridgeError,
                "the file to push could not be read for download",
                now,
            )
            .await?;
        for row in &failed {
            finished(r.as_mut(), &at, in_force, row, None).await?;
        }
        r.commit().await?;
        deps.bridge_signals.notify(signal_key(ws));
    }
    Ok(handed)
}

/// Writes `devices.command.finished` for command `row`, which just ended, under the version in
/// force `in_force`: `duration_ms` is the bridge's, `None` for a failure the server decided.
async fn finished(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    in_force: Option<StrategyVersionId>,
    row: &DeviceCommandRow,
    duration_ms: Option<u32>,
) -> Result<(), AppError> {
    append(
        r,
        ctx,
        "devices.command.finished",
        "device_command",
        row.id,
        in_force,
        json!({
            "command_id": row.id,
            "kind": row.command.kind(),
            "status": row.status.key(),
            "reason": row.reason.map(FailReason::key),
            "duration_ms": duration_ms,
        }),
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/// `devices.bridge.results`: a batch of the bridge's results (see the module docs), at most 100.
/// A batch that breaks a limit (`ResultsIn::validate`) is `VALIDATION` naming the field
/// (`results`, `command_id`, `detail`, ...); one that names a file (a `file` result's `file_id`,
/// an observation's `screenshot_file_id`) that is not one of the workspace's device files is
/// `VALIDATION` naming `file_id` or `screenshot_file_id`; either is final, and nothing of it is
/// applied. Each result is then applied in a transaction of its own (writing
/// `devices.command.finished`) and counted `applied`, `duplicates` (the command ended already) or
/// `unknown`; the three add up to the batch. Applying any wakes what waits on the workspace's
/// devices. Only the bridge's key.
pub async fn results(
    deps: &Deps,
    b: &BridgeCaller,
    input: ResultsIn,
) -> Result<ResultsOut, AppError> {
    authorize(b)?;
    input.validate().map_err(refused)?;
    let ctx = &b.ctx;
    let caps: Vec<CapabilityId> = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        device_files_only(r.as_mut(), &input).await?;
        kernel::of_kind(r.as_mut(), PHONE_KIND)
            .await?
            .iter()
            .filter(|c| registered_by(c, b.bridge))
            .map(|c| c.id)
            .collect()
    };
    let mut out = ResultsOut {
        applied: 0,
        duplicates: 0,
        unknown: 0,
    };
    for result in input.results {
        let finish = match result.outcome {
            Outcome::Done { result } => Finish::Done {
                result: serde_json::to_value(result)
                    .map_err(|_| AppError::internal("a device command result cannot be encoded"))?,
            },
            Outcome::Failed { reason, detail } => Finish::failed(reason, &detail),
        };
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        match r
            .device_commands()
            .finish(&caps, result.command_id, finish, ctx.now)
            .await?
        {
            Finished::Applied(row) => {
                let in_force = version_in_force(r.as_mut()).await?;
                finished(r.as_mut(), ctx, in_force, &row, Some(result.duration_ms)).await?;
                r.commit().await?;
                out.applied += 1;
            }
            Finished::Duplicate => out.duplicates += 1,
            Finished::Unknown => out.unknown += 1,
        }
    }
    if out.applied > 0 {
        deps.bridge_signals.notify(signal_key(ctx.workspace_id));
    }
    tracing::info!(
        component = DEVICE_BRIDGE.component,
        applied = out.applied,
        duplicates = out.duplicates,
        unknown = out.unknown,
        "device command results"
    );
    Ok(out)
}

/// `Ok` when every file the results of `input` name is one of the workspace's device files; else
/// `VALIDATION` naming the field of the first that is not.
async fn device_files_only(r: &mut dyn TenantRepos, input: &ResultsIn) -> Result<(), AppError> {
    let named: Vec<(Uuid, &'static str)> = input
        .results
        .iter()
        .filter_map(|result| match &result.outcome {
            Outcome::Done {
                result: CommandResult::File { file_id },
            } => Some((*file_id, "file_id")),
            Outcome::Done {
                result: CommandResult::Observation(seen),
            } => seen.screenshot_file_id.map(|id| (id, "screenshot_file_id")),
            _ => None,
        })
        .collect();
    if named.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = named.iter().map(|(id, _)| *id).collect();
    let known: HashSet<Uuid> = r
        .device_commands()
        .files(&ids)
        .await?
        .into_iter()
        .map(|f| f.id)
        .collect();
    match named.iter().find(|(id, _)| !known.contains(id)) {
        Some((_, field)) => Err(invalid(
            field,
            "names a file that is not one of the workspace's device files",
        )),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/// The media type of a `Content-Type` value, without its parameters, in lowercase.
fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// `devices.bridge.files`: stores `bytes`, uploaded as `content_type`, as a device file of the
/// workspace (see the module docs), kept for [`FILE_RETENTION`]; its id. A type that is neither
/// `image/png` nor `application/octet-stream` is `VALIDATION` naming `content_type`; a PNG that is
/// not one, or over studio's image limit, or a file over [`DEVICE_FILE_LIMIT`] bytes, `VALIDATION`
/// naming `body`. The bytes are written before the file is recorded, and removed again when it
/// cannot be. Only the bridge's key.
pub async fn files(
    deps: &Deps,
    b: &BridgeCaller,
    content_type: Option<&str>,
    bytes: Vec<u8>,
) -> Result<FileOut, AppError> {
    authorize(b)?;
    let ws = b.ctx.workspace_id;
    let mime = match content_type.map(media_type).as_deref() {
        Some(PNG) => PNG,
        Some(OCTET_STREAM) => OCTET_STREAM,
        _ => {
            return Err(invalid(
                "content_type",
                "a device file is image/png or application/octet-stream",
            ));
        }
    };
    if bytes.len() as u64 > DEVICE_FILE_LIMIT {
        return Err(invalid(
            "body",
            &format!("a device file is at most {DEVICE_FILE_LIMIT} bytes"),
        ));
    }
    let id = deps.ids.uuid();
    let extension = if mime == PNG { "png" } else { "bin" };
    let upload = MediaUpload {
        bytes,
        mime: mime.to_owned(),
        filename: format!("{id}.{extension}"),
    };
    validate_stored(&upload).map_err(|_| {
        invalid(
            "body",
            "an image/png file is a PNG image of at most 25000000 bytes",
        )
    })?;
    let stored = deps.files.put(ws, FileId(id), upload).await?;
    let file = DeviceFile {
        id,
        mime: mime.to_owned(),
        size_bytes: stored.size_bytes,
        sha256: stored.sha256,
        created_at: b.ctx.now,
        expires_at: b.ctx.now + FILE_RETENTION,
    };
    let size_bytes = file.size_bytes;
    let recorded = async {
        let mut r = deps.uow.tenant(ws).await?;
        r.device_commands().save_file(file).await?;
        r.commit().await
    };
    if let Err(e) = recorded.await {
        let _ = deps.files.delete(ws, FileId(id)).await;
        return Err(e);
    }
    tracing::info!(
        component = DEVICE_BRIDGE.component,
        file_id = %id,
        size_bytes,
        "device file uploaded"
    );
    Ok(FileOut { file_id: id })
}
