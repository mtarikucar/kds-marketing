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
//! (a model `adb` could not read) is kept. Only this surface writes `connector_public.device`
//! (`jt_capability::RESERVED_PUBLIC_KEYS`). Beside the phone's facts (`platform`, `serial`,
//! `model`, `os_version`, `screen`, `features`) and the bridge's (`bridge_id`, `version`,
//! `protocol`), it keeps which bridge holds the phone: `listed_by`, that bridge's key id, and
//! `listed`, whether that bridge's latest registration lists it (`false` once one leaves it out);
//! and `instance`, the run of the bridge program that registration came from
//! (`RegisterIn::instance`, protocol 2; `null` from a bridge of protocol 1). A restarted bridge
//! holds the same key: the run tells it from the one that stopped, whose poll the server may
//! still hold (behind a proxy a poll outlives its program). A phone whose latest listing names a
//! run is that run's alone: it is leased to that run's polls only, and only that run's
//! registrations leave it out (two runs of one bridge at once, one starting while the other
//! stops: the latest to list a phone holds it). A phone whose latest listing names none is any
//! poll's and any registration's of its bridge, as before protocol 2.
//! The `phone` kind has a heartbeat (`jt_capability::Heartbeat`): only these registrations verify
//! a phone (`capability.verify` refuses one), it reads stale a minute after the last one that
//! listed it, and the `device_bridge_health` job marks it unreachable ten minutes after
//! (`devices.bridge.offline`).
//!
//! A phone is one bridge's at a time. Another bridge that lists it while the holder lists it and
//! registered it within [`HELD_FOR`] is refused with [`PHONE_HELD_BY_ANOTHER_BRIDGE`] (two PCs
//! can see a phone of the same serial: every emulator is `emulator-5554`); once the holder leaves
//! it out or stops registering, the next bridge to list it holds it. A phone that fails its own
//! checks is refused with the reason, a retired one that is still plugged in with
//! [`PHONE_RETIRED`] (nothing is declared or merged for any refused phone), and one phone never
//! refuses the registration: the others register as usual. Protocol 2 added only what a bridge
//! sends (its run), so every body sent back is the same to a bridge of either protocol.
//!
//! **Commands.** A poll leases to the bridge the due commands
//! (`ports::devices::DeviceCommandRepo::pick_due`) of exactly the phones it holds and its latest
//! registration lists (of those a run holds, only to that run's polls), oldest first, at most the
//! poll's limit; one handed out and not answered
//! within [`REDELIVER_AFTER`] is handed out again, and the bridge acts on a command id once. Each
//! read checks every command it picked against what the phone's bridge lists now (the command's
//! `jt_devices::required_features` against the phone's current `features`): one it does not list
//! any more is failed `unsupported_by_bridge`, never leased. A read that failed all it picked and
//! leased nothing reads again at once. A `push_file` command carries the address its file is
//! downloaded from, signed for [`DOWNLOAD_URL_LIFETIME`] after the read committed; one whose file
//! is not stored is failed `file_not_found`, and one the store cannot sign now is not handed out
//! this time (its lease runs out and it is handed out again). While nothing is due the poll
//! waits: a command queued in this server wakes it at once (the devices' signals,
//! [`super::signal_key`]), and it looks again at least every [`kernel::FALLBACK_TICK`].
//!
//! A command redelivered after its lease went unanswered can be failed at its redelivery (its
//! phone's bridge stopped listing what it needs); a result its bridge then sends for the first
//! delivery is a duplicate: the command already ended.
//!
//! **Results.** A batch is checked whole first: one that breaks a limit
//! (`jt_device_protocol::ResultsIn::validate`), or that names a file that is not a device file
//! this bridge uploaded, is refused (`VALIDATION` naming the field) and nothing of it is applied.
//! Then each result is applied once, by command id, when the bridge may report it: the command
//! was last leased to it (a late result from a phone it has left out since still counts, since the
//! command really ran), or the bridge holds the command's phone now (`listed_by`, whether or not
//! its latest registration lists the phone: a bridge whose key was replaced reports for the old
//! key's leases). A result for any other command (unknown, leased to another bridge, or never
//! handed out) changes nothing and is counted `unknown`, never refused.
//!
//! **Replacing a bridge's key.** Start the bridge with the new key, stop the old program cleanly
//! (it posts what it finished, with the old key), then revoke the old key. The new bridge is
//! refused each phone the old one held while the old one lists it; a clean stop ends with a
//! registration that lists no phone, which leaves them out at once, so the new bridge takes each
//! over at its next registration (`devices.phone.holder_changed`). An old program that stopped
//! without it (a crash) holds them until it has not registered them for [`HELD_FOR`] (up to a
//! minute). The old key's leases of a phone taken over are the new bridge's to answer.
//!
//! **Files.** An upload is the file's bytes, `image/png` (a screenshot) or
//! `application/octet-stream` (a file pulled off a phone), streamed into the file store and
//! recorded as the workspace's, uploaded by the bridge, for [`FILE_RETENTION`], after which the
//! `device_file_purge` job deletes it (`super::sweeps`). Each upload is a new file, a retried one
//! included. Each workspace uploads a few files at a time, screenshots and
//! pulled files apart (`super::uploads`); one that waits too long for its turn is answered `503`
//! (the bridge tries again), and a body that stalls is refused.
//!
//! **Logging.** Every command that ends through this surface writes `devices.command.finished`
//! (`command_id`, `kind`, `status`, `reason`, `duration_ms`: the bridge's, `null` for a failure the
//! server decided; `leased_by`: the key id of the bridge last handed it, `null` for none;
//! `result_sha256`: the hash of the result a done command keeps, [`result_sha256`]); its result
//! stays on the command. One the expiry sweep ends writes the same entry (`super::sweeps`), and a
//! late result that replaces the expiry writes a second one. A phone that passes from one bridge
//! to another writes `devices.phone.holder_changed` (`capability_id`, `from`, `to`: key ids).
//! `tracing` carries ids, kinds, statuses and counts only: never a command's payload, a result, a
//! failure's detail or a file's bytes.

use std::collections::{HashMap, HashSet};
use std::time::Duration as StdDuration;

use jt_capability::{Capability, CapabilityId, MAX_NAME_CHARS, StoredStatus, validate_external_id};
use jt_device_protocol::{
    CommandResult, LeasedCommand, Outcome, PHONE_HELD_BY_ANOTHER_BRIDGE, PHONE_RETIRED,
    PhoneReport, ProtocolError, RefusedPhone, RegisteredPhone,
};
use jt_strategy::StrategyVersionId;
use jt_studio::FileId;
use jt_tenancy::{ApiKeyId, Permission};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::uploads::UploadKind;
use super::{PHONE_KIND, signal_key};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::devices::{
    CommandStatus, DeviceCommand, DeviceCommandRow, DeviceFile, FailReason, Finish, Finished,
    REDELIVER_AFTER, required_features, supports,
};
use crate::ports::files::ByteSource;
use crate::usecases::api_keys::AgentPrincipal;
use crate::usecases::bridges::kernel::{self, Beat, BridgeSpec, FactsMerge, Held, Lease};
use crate::usecases::capabilities::{append, locked, version_in_force};
use crate::usecases::files::{DEVICE_FILE_LIMIT, OCTET_STREAM, PNG};
use crate::usecases::studio::files::IMAGE_LIMIT;
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
/// How long a phone a bridge lists stays that bridge's when the bridge stops registering it: the
/// spec's stale clock for a bridge, four missed heartbeats, which is the `phone` kind's heartbeat
/// `stale_after` too (pinned by `held_for_is_the_phone_kinds_stale_clock`). Another bridge can
/// take it over after.
pub const HELD_FOR: Duration = Duration::seconds(60);
/// How long the download address of a `push_file` command lives: long enough for the bridge to
/// start the download after the command waited its turn on the phone (the bridge fails a command
/// that waited longer than `jt_devices::DEFAULT_EXPIRES_IN`, five minutes), short enough that an
/// address that leaked soon stops working. The download itself may run past it.
pub const DOWNLOAD_URL_LIFETIME: Duration = Duration::minutes(10);
/// How long a device file is kept (spec §5.6).
pub const FILE_RETENTION: Duration = Duration::days(7);

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
/// the bridge's component (else `FORBIDDEN` with `details.reason = "bridge_key_only"`). An adapter
/// may check it before reading a request's body; every use case here checks it again.
pub fn authorize(b: &BridgeCaller) -> Result<(), AppError> {
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
pub(super) fn device_of(c: &Capability) -> Option<&Map<String, Value>> {
    c.connector_public.get("device")?.as_object()
}

/// Whether the latest registration of the bridge that holds phone `c` lists it (`listed`).
pub(super) fn is_listed(c: &Capability) -> bool {
    device_of(c)
        .and_then(|d| d.get("listed"))
        .and_then(Value::as_bool)
        == Some(true)
}

/// The key id of the bridge that holds phone `c` (`listed_by`), listed or not.
fn holder_of(c: &Capability) -> Option<String> {
    device_of(c)?.get("listed_by")?.as_str().map(str::to_owned)
}

/// Whether bridge `bridge` holds phone `c` (`listed_by`), listed or not.
fn held_by(c: &Capability, bridge: ApiKeyId) -> bool {
    device_of(c).is_some_and(|d| {
        d.get("listed_by").and_then(Value::as_str) == Some(bridge.to_string().as_str())
    })
}

/// Whether bridge `bridge` holds phone `c` and its latest registration lists it.
fn listed_by(c: &Capability, bridge: ApiKeyId) -> bool {
    held_by(c, bridge) && is_listed(c)
}

/// The run of the bridge program whose registration listed phone `c` last (`instance`), if it
/// named one.
fn instance_of(c: &Capability) -> Option<Uuid> {
    device_of(c)?.get("instance")?.as_str()?.parse().ok()
}

/// Whether run `instance` of the bridge that holds phone `c` may act on it (be leased its
/// commands, leave it out): the phone's latest listing named no run, or this one.
fn of_this_run(c: &Capability, instance: Option<Uuid>) -> bool {
    instance_of(c).is_none_or(|listed| Some(listed) == instance)
}

/// Whether a bridge other than `bridge` holds phone `c` at `now`: it lists it, and registered it
/// at most [`HELD_FOR`] ago.
fn held_by_another(c: &Capability, bridge: ApiKeyId, now: OffsetDateTime) -> bool {
    let listed = is_listed(c);
    let holder = device_of(c)
        .and_then(|d| d.get("listed_by"))
        .and_then(Value::as_str);
    let recent = c.last_verified_at.is_some_and(|at| now - at <= HELD_FOR);
    listed && recent && holder.is_some_and(|holder| holder != bridge.to_string())
}

/// What phone `c`'s bridge lists it can run, as its latest registration reported.
pub(super) fn features_of(c: &Capability) -> Vec<String> {
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
/// kept stays), the bridge's own facts, and that bridge `b` holds it and lists it now.
fn device_facts(b: &BridgeCaller, input: &RegisterIn, phone: &PhoneReport) -> Map<String, Value> {
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
    device.insert("listed_by".into(), json!(b.bridge.to_string()));
    device.insert("listed".into(), json!(true));
    // `null` from a bridge that names no run, in place of a run named before.
    device.insert("instance".into(), json!(input.instance));
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
/// `external_id`, `bridge_id`, `version`, `declared`) when it did not read verified until now; a
/// retired phone, or one another bridge holds, is refused, read under its lock. Each phone this
/// bridge's previous registration listed and this one leaves out reads as left out, unless
/// another run of the bridge listed it since (see the module docs). Only the bridge's key.
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
    let refusal = |platform, serial: &str, reason: &str| RefusedPhone {
        platform,
        serial: serial.to_owned(),
        reason: reason.to_owned(),
    };
    let mut refused_phones = Vec::new();
    let mut steps: Vec<(CapabilityId, Step)> = Vec::new();
    for (index, phone) in input.phones.iter().enumerate() {
        if let Some(fault) = phone_fault(phone) {
            refused_phones.push(refusal(phone.platform, &phone.serial, &fault));
            continue;
        }
        let external_id = external_id(phone);
        let (id, declared) = match kernel::held(&phones, &external_id) {
            Held::Live(c) => (c.id, false),
            Held::Retired => {
                refused_phones.push(refusal(phone.platform, &phone.serial, PHONE_RETIRED));
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
    let listing: HashSet<CapabilityId> = steps.iter().map(|(id, _)| *id).collect();
    for c in &phones {
        if c.status != StoredStatus::Retired
            && listed_by(c, b.bridge)
            && of_this_run(c, input.instance)
            && !listing.contains(&c.id)
        {
            steps.push((c.id, Step::LeaveOut(c.id)));
        }
    }
    // Locked in the order of their ids: two registrations that share phones lock them in the
    // same order.
    steps.sort_by_key(|(id, _)| *id);
    let mut registered = Vec::new();
    for (id, step) in steps {
        match step {
            Step::Beat {
                index,
                platform,
                serial,
                beat,
            } => {
                let current = locked(r.as_mut(), id).await?;
                if current.status == StoredStatus::Retired {
                    // Retired since it was read.
                    refused_phones.push(refusal(platform, &serial, PHONE_RETIRED));
                    continue;
                }
                if held_by_another(&current, b.bridge, ctx.now) {
                    refused_phones.push(refusal(platform, &serial, PHONE_HELD_BY_ANOTHER_BRIDGE));
                    continue;
                }
                let before = holder_of(&current);
                kernel::heartbeat(r.as_mut(), ctx, &DEVICE_BRIDGE, in_force, beat).await?;
                let to = b.bridge.to_string();
                if let Some(from) = before.filter(|from| *from != to) {
                    let payload = json!({ "capability_id": id, "from": from, "to": to });
                    let holder_changed = append(
                        r.as_mut(),
                        ctx,
                        "devices.phone.holder_changed",
                        "capability",
                        id,
                        in_force,
                        payload,
                    );
                    holder_changed.await?;
                }
                registered.push((
                    index,
                    RegisteredPhone {
                        serial,
                        capability_id: id.as_uuid(),
                    },
                ));
            }
            Step::LeaveOut(id) => {
                leave_out(r.as_mut(), ctx, id, b.bridge, input.instance).await?;
            }
        }
    }
    r.commit().await?;
    registered.sort_by_key(|(index, _)| *index);
    let registered = registered.into_iter().map(|(_, phone)| phone).collect();
    Ok(RegisterOut::new(registered, refused_phones))
}

/// Marks phone `id` as left out of the latest registration of bridge `bridge`, which listed it
/// before: no command is leased for it from the next poll on, and another bridge may take it
/// over. Read under the lock, so a phone that another bridge took over, another run of this one
/// listed (run `instance`'s registration leaves it out), or that was retired since, is left as it
/// stands.
async fn leave_out(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: CapabilityId,
    bridge: ApiKeyId,
    instance: Option<Uuid>,
) -> Result<(), AppError> {
    let mut c = locked(r, id).await?;
    if c.status == StoredStatus::Retired || !listed_by(&c, bridge) || !of_this_run(&c, instance) {
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
/// [`MAX_WAIT_S`]) for one; out-of-range values are cut to the range. A poll of run
/// `query.instance` is leased nothing for a phone another run listed last, also when that run
/// registered while the poll waits. Only the bridge's key.
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
        move |waited| Box::pin(read(deps, b, limit, query.instance, waited)),
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
    instance: Option<Uuid>,
    waited: StdDuration,
) -> Result<Option<Vec<LeasedCommand>>, AppError> {
    let bridge = b.bridge;
    loop {
        let taken = kernel::lease(deps, &b.ctx, &DEVICE_BRIDGE, waited, move |r, ctx, at| {
            Box::pin(take(r, ctx, bridge, instance, limit, at))
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
        // Nothing this read picked can be handed out now: the next due ones, if any, are read at
        // once rather than at the next signal.
    }
}

/// The lease of one read (in its transaction): picks the due commands of the phones bridge
/// `bridge` holds and lists now (and run `instance` of it may act on: [`of_this_run`]), at most `limit`, fails those their phone's bridge does not list
/// what they need for (ledgered), and leases the rest to it. The phones and their features are
/// read before anything is picked, so nothing waits on another read while rows are locked.
async fn take(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    bridge: ApiKeyId,
    instance: Option<Uuid>,
    limit: u32,
    at: Lease,
) -> Result<Vec<Taken>, AppError> {
    let phones: HashMap<CapabilityId, (String, Vec<String>)> = kernel::of_kind(r, PHONE_KIND)
        .await?
        .iter()
        .filter(|c| {
            c.status != StoredStatus::Retired && listed_by(c, bridge) && of_this_run(c, instance)
        })
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
    for row in r
        .device_commands()
        .mark_leased(&ids, bridge, at.now)
        .await?
    {
        let serial = phones
            .get(&row.capability_id)
            .map(|(serial, _)| serial.clone())
            .unwrap_or_default();
        taken.push(Taken::Leased(Box::new(row), serial));
    }
    Ok(taken)
}

/// The first feature `cmd` needs ([`required_features`]) that a bridge listing `features` lacks.
fn missing(features: &[String], cmd: &DeviceCommand) -> &'static str {
    required_features(cmd)
        .into_iter()
        .find(|needed| !features.iter().any(|f| f == needed))
        .unwrap_or_else(|| cmd.kind())
}

/// The commands `leased`, as the bridge takes them, each `push_file` with its download address
/// signed at `now`, after the lease committed (signing may reach the file store). One whose file
/// is not stored is failed `file_not_found` in a transaction of its own, ledgered, and not handed
/// out; one the store cannot sign now is not handed out either, and stays leased until its lease
/// runs out and it is handed out again.
async fn hand_out(
    deps: &Deps,
    ctx: &Ctx,
    leased: Vec<(DeviceCommandRow, String)>,
    now: OffsetDateTime,
) -> Result<Vec<LeasedCommand>, AppError> {
    let ws = ctx.workspace_id;
    let mut handed = Vec::new();
    let mut not_stored = Vec::new();
    for (row, serial) in leased {
        let download_url = match &row.command {
            DeviceCommand::PushFile { file_id, .. } => {
                let expires_at = now + DOWNLOAD_URL_LIFETIME;
                match deps
                    .files
                    .device_url(ws, FileId(*file_id), expires_at)
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
                        if e.code == ErrorCode::NotFound {
                            not_stored.push(row.id);
                        }
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
    if !not_stored.is_empty() {
        let at = Ctx { now, ..ctx.clone() };
        let mut r = deps.uow.tenant(ws).await?;
        let in_force = version_in_force(r.as_mut()).await?;
        let failed = r
            .device_commands()
            .fail_pending(
                &not_stored,
                FailReason::FileNotFound,
                "the file to push is not stored: it was removed, or never uploaded",
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

/// The lowercase hex SHA-256 of `result` as compact JSON text (`serde_json::to_vec`: no
/// whitespace), every object's keys in sorted order at every depth, which
/// `devices.command.finished` carries as `result_sha256`: the result kept on the command can be
/// checked against the ledger, whose entries are never changed. To check one, read the command's
/// result, write it the same way and hash it. The key order holds while `serde_json`'s
/// `preserve_order` feature is off, as it is in this workspace (pinned by
/// `result_sha256_hashes_compact_json_with_sorted_keys`): with it, keys would keep the order they
/// were read in, and a result read back from Postgres (`jsonb` orders keys its own way) would hash
/// otherwise.
pub fn result_sha256(result: &Value) -> String {
    use sha2::{Digest, Sha256};
    let text = serde_json::to_vec(result).unwrap_or_default();
    Sha256::digest(&text)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What `devices.command.finished` says of a command that just ended ([`write_finished`]).
pub(super) struct Ended<'a> {
    pub id: Uuid,
    /// The command's kind, e.g. `"tap"`.
    pub kind: &'a str,
    pub status: CommandStatus,
    pub reason: Option<FailReason>,
    /// The bridge's, `None` for an end the server decided (a failure, an expiry).
    pub duration_ms: Option<u32>,
    /// The bridge (its key) the command was last handed, `None` for none.
    pub leased_by: Option<ApiKeyId>,
    /// The result a done command keeps, `None` for any other.
    pub result: Option<&'a Value>,
}

/// Writes `devices.command.finished` for the command that just ended as `ended` says, under the
/// version in force `in_force`: `command_id`, `kind`, `status`, `reason`, `duration_ms`,
/// `leased_by` (the key id) and `result_sha256` ([`result_sha256`] of the result, `null` without
/// one). Every end of a command writes one, whoever decided it: the bridge's result, a failure
/// the server decided, the expiry sweep (`super::sweeps`), and a late result that replaced an
/// expiry, after it.
pub(super) async fn write_finished(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    in_force: Option<StrategyVersionId>,
    ended: Ended<'_>,
) -> Result<(), AppError> {
    append(
        r,
        ctx,
        "devices.command.finished",
        "device_command",
        ended.id,
        in_force,
        json!({
            "command_id": ended.id,
            "kind": ended.kind,
            "status": ended.status.key(),
            "reason": ended.reason.map(FailReason::key),
            "duration_ms": ended.duration_ms,
            "leased_by": ended.leased_by.map(|by| by.to_string()),
            "result_sha256": ended.result.map(result_sha256),
        }),
    )
    .await
}

/// [`write_finished`] for command `row`, which just ended: `duration_ms` is the bridge's, `None`
/// for a failure the server decided.
async fn finished(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    in_force: Option<StrategyVersionId>,
    row: &DeviceCommandRow,
    duration_ms: Option<u32>,
) -> Result<(), AppError> {
    let ended = Ended {
        id: row.id,
        kind: row.command.kind(),
        status: row.status,
        reason: row.reason,
        duration_ms,
        leased_by: row.leased_by,
        result: row.result.as_ref(),
    };
    write_finished(r, ctx, in_force, ended).await
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/// `devices.bridge.results`: a batch of the bridge's results (see the module docs), at most 100.
/// A batch that breaks a limit (`ResultsIn::validate`) is `VALIDATION` naming the field
/// (`results`, `command_id`, `detail`, ...); one that names a file (a `file` result's `file_id`,
/// an observation's `screenshot_file_id`) that is not a device file this bridge uploaded is
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
    let holding: Vec<CapabilityId> = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        own_files_only(r.as_mut(), b.bridge, &input).await?;
        kernel::of_kind(r.as_mut(), PHONE_KIND)
            .await?
            .iter()
            .filter(|c| held_by(c, b.bridge))
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
        let answer = r
            .device_commands()
            .finish(b.bridge, &holding, result.command_id, finish, ctx.now)
            .await?;
        match answer {
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

/// `Ok` when every file the results of `input` name is a device file of the workspace that
/// bridge `bridge` uploaded; else `VALIDATION` naming the field of the first that is not.
async fn own_files_only(
    r: &mut dyn TenantRepos,
    bridge: ApiKeyId,
    input: &ResultsIn,
) -> Result<(), AppError> {
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
    let own: HashSet<Uuid> = r
        .device_commands()
        .files(&ids)
        .await?
        .into_iter()
        .filter(|f| f.uploaded_by == bridge)
        .map(|f| f.id)
        .collect();
    match named.iter().find(|(id, _)| !own.contains(id)) {
        Some((_, field)) => Err(invalid(
            field,
            "names a file that is not a device file this bridge uploaded",
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

/// `VALIDATION` naming `body`: a file over its type's limit.
fn too_large(limit: u64) -> AppError {
    invalid(
        "body",
        &format!("a device file of this type is at most {limit} bytes"),
    )
}

/// `VALIDATION` naming `body`: a body that sent nothing for `idle`.
fn stalled(idle: StdDuration) -> AppError {
    invalid(
        "body",
        &format!("the body sent nothing for {} seconds", idle.as_secs()),
    )
}

/// `source`, refused once it yields more than `limit` bytes, or sends nothing for `idle`.
struct Bounded<'a> {
    source: &'a mut dyn ByteSource,
    read: u64,
    limit: u64,
    idle: StdDuration,
    over: bool,
    stalled: bool,
}

#[async_trait::async_trait]
impl ByteSource for Bounded<'_> {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        let Ok(next) = tokio::time::timeout(self.idle, self.source.next_chunk()).await else {
            self.stalled = true;
            return Err(stalled(self.idle));
        };
        let Some(chunk) = next? else {
            return Ok(None);
        };
        self.read += chunk.len() as u64;
        if self.read > self.limit {
            self.over = true;
            return Err(too_large(self.limit));
        }
        Ok(Some(chunk))
    }
}

/// `devices.bridge.files`: stores the file `source` yields, uploaded as `content_type`, as a device
/// file of the workspace uploaded by the bridge (see the module docs), kept for
/// [`FILE_RETENTION`]; its id. A type that is neither `image/png` nor `application/octet-stream`
/// is `VALIDATION` naming `content_type`; a body over its type's limit ([`IMAGE_LIMIT`] for a PNG,
/// [`DEVICE_FILE_LIMIT`] for a pulled file; `declared_len` is the length the request announces,
/// refused before anything is read), a body that sends nothing for the upload turns'
/// `chunk_idle`, or a PNG that is not one, `VALIDATION` naming `body`. The body is read only once
/// the upload has its turn (`Deps::device_uploads`, a pool per workspace for screenshots and
/// another for pulled files); one that gets none within `turn_wait` is `UPSTREAM_UNAVAILABLE`
/// (`503`, retryable), its body not read. The body is streamed into the file store; the bytes are
/// written before the file is recorded, and removed again when it cannot be. Only the bridge's
/// key.
pub async fn files(
    deps: &Deps,
    b: &BridgeCaller,
    content_type: Option<&str>,
    declared_len: Option<u64>,
    source: &mut dyn ByteSource,
) -> Result<FileOut, AppError> {
    authorize(b)?;
    let ws = b.ctx.workspace_id;
    let (mime, limit, kind) = match content_type.map(media_type).as_deref() {
        Some(PNG) => (PNG, IMAGE_LIMIT, UploadKind::Screenshot),
        Some(OCTET_STREAM) => (OCTET_STREAM, DEVICE_FILE_LIMIT, UploadKind::PulledFile),
        _ => {
            return Err(invalid(
                "content_type",
                "a device file is image/png or application/octet-stream",
            ));
        }
    };
    if declared_len.is_some_and(|len| len > limit) {
        return Err(too_large(limit));
    }
    let _turn = deps.device_uploads.take(ws, kind).await?;
    let idle = deps.device_uploads.limits().chunk_idle;
    let id = deps.ids.uuid();
    let extension = if mime == PNG { "png" } else { "bin" };
    let filename = format!("{id}.{extension}");
    let mut bounded = Bounded {
        source,
        read: 0,
        limit,
        idle,
        over: false,
        stalled: false,
    };
    let stored = deps
        .files
        .put_stream(ws, FileId(id), mime, &filename, &mut bounded)
        .await;
    let stored = match stored {
        Ok(stored) => stored,
        Err(_) if bounded.over => return Err(too_large(limit)),
        Err(_) if bounded.stalled => return Err(stalled(idle)),
        Err(e)
            if e.code == ErrorCode::Validation
                && e.details.get("field") == Some(&json!("media")) =>
        {
            return Err(invalid(
                "body",
                &format!("an image/png file is a PNG image of at most {IMAGE_LIMIT} bytes"),
            ));
        }
        Err(e) => return Err(e),
    };
    let file = DeviceFile {
        id,
        mime: mime.to_owned(),
        size_bytes: stored.size_bytes,
        sha256: stored.sha256,
        uploaded_by: b.bridge,
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

#[cfg(test)]
mod tests {
    use jt_capability::CapabilityKind;
    use serde_json::{Value, json};
    use time::Duration;

    use super::{HEARTBEAT_S, HELD_FOR, PHONE_KIND, result_sha256};

    #[test]
    fn held_for_is_the_phone_kinds_stale_clock() {
        // A phone reads stale, and so offline, when its bridge's hold on it lapses, and that is
        // four missed registrations.
        let beat = CapabilityKind::parse(PHONE_KIND)
            .and_then(|k| k.heartbeat())
            .expect("a phone is verified by its heartbeat");
        assert_eq!(beat.stale_after, HELD_FOR);
        assert_eq!(HELD_FOR, Duration::seconds(4 * i64::from(HEARTBEAT_S)));
        assert_eq!(beat.unreachable_after, Duration::minutes(10));
    }

    #[test]
    fn result_sha256_hashes_compact_json_with_sorted_keys() {
        use sha2::{Digest, Sha256};
        let result = json!({
            "stdout": "x",
            "kind": "shell",
            "exit_code": 0,
            "nested": { "b": 1, "a": [2, 1] },
        });
        // Keys sorted at every depth, no whitespace: `serde_json` without `preserve_order`, which
        // would keep the order above.
        let text = r#"{"exit_code":0,"kind":"shell","nested":{"a":[2,1],"b":1},"stdout":"x"}"#;
        assert_eq!(serde_json::to_string(&result).unwrap(), text);
        let expected: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(result_sha256(&result), expected);
        // The same result read in another key order (as `jsonb` hands it back) hashes the same.
        let reordered: Value = serde_json::from_str(
            r#"{"stdout":"x","nested":{"b":1,"a":[2,1]},"exit_code":0,"kind":"shell"}"#,
        )
        .unwrap();
        assert_eq!(result_sha256(&reordered), expected);
    }
}
