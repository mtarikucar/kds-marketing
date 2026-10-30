//! The wire between the Jeeta server and a device bridge (spec `2026-10-28-device-bridge-design.md`
//! §2 and §5): the bodies the bridge sends and receives, and the limits the server holds them to.
//! The server and the bridge program compile against these same types, so they cannot drift. Pure:
//! no platform, database, HTTP or clock I/O, and no workspace crate but `jt_devices`, whose
//! vocabulary is re-exported here: a bridge has one import path for it.
//!
//! # Versions
//!
//! [`PROTOCOL_VERSION`] counts the shapes of the structs and enums here. The bridge sends its
//! protocol in [`RegisterIn`]; the server answers its own in [`RegisterOut`] and shapes every body
//! it sends afterwards to the bridge's protocol.
//!
//! - Register is tolerant: [`RegisterIn`] and [`PhoneReport`] ignore unknown fields, because the
//!   first register goes out before the bridge knows the server's protocol. What is ignored is
//!   not written back.
//! - After it, each side sends only the fields and kinds that the LOWER of the two protocol
//!   versions defines: every other struct and tagged enum refuses unknown fields, on both sides.
//!   The exceptions are [`Observation`], [`Screen`] and [`Element`], which are shared with the
//!   tolerant handshake and ignore unknown fields too; tolerance when an observation is read back
//!   is intended.
//! - A platform this version does not know makes a register unreadable: [`Platform`] is a stored
//!   key, not a label, so it has no catch-all variant and a new platform needs a protocol bump.
//!   The first register goes out before the bridge knows the server's protocol, so it lists only
//!   phones of the platforms protocol 1 defines: phones of newer platforms are listed only once
//!   [`RegisterOut::protocol`] shows that the server defines them.
//!
//! What each protocol added:
//!
//! - 2: the bridge's run ([`RegisterIn::instance`], [`CommandsQuery::instance`]): a random id a
//!   bridge program draws when it starts, so that the server tells the polls of a run that
//!   stopped (behind a proxy a held poll outlives its program) from the next run's, which holds
//!   the same key. Every register carries it (a server of protocol 1 ignores it); a poll carries
//!   it only to a server of protocol 2 or later, as a poll of protocol 1 refuses what it does not
//!   know.
//!
//! Growing the vocabulary:
//!
//! - A new [`FailReason`] needs no bump: an older reader takes it as [`FailReason::Unknown`] (see
//!   `jt_devices`).
//! - A new command kind, a new field, or a new VALUE of an existing enum field (a new
//!   [`DeviceKey`] or [`ElementTarget`] variant) needs a feature name (for example `key.camera`)
//!   that [`supports`] checks: a bridge reports what it runs, and the server queues a command only
//!   for a bridge that lists what it needs. It also needs a protocol bump when it changes a struct
//!   or enum here.
//!
//! # A command a bridge cannot read
//!
//! A command that a newer server queued but this build cannot decode must not make the whole poll
//! unreadable: see [`CommandsOut`] and [`CommandsOut::decode_lenient`]. That reads the readable
//! commands, names the unreadable ones by id so that the bridge fails them, and counts the ones it
//! had to leave out because they carry no id to fail them by (`dropped`: log the count at warn
//! level). A body that is not a poll at all is an error, not an empty poll: the bridge treats it as
//! a failed poll, backs off and polls again.
//!
//! # Bodies that break a limit
//!
//! The server refuses a body that breaks a limit with a [`ProtocolError`] (HTTP 422). A bridge
//! builds what it sends to be valid: [`Outcome::failed`] and [`CommandResult::shell`] clean and cap
//! what they are given, and `Observation::cap_elements` caps a screen. A refused results batch is
//! refused for good: the bridge must not retry it as it is, because the same body is refused
//! again and every result behind it waits.
//!
//! # Logging
//!
//! These bodies carry commands, typed text, shell output, screen text and a signed download
//! address. Log counts, ids and [`DeviceCommand::kind`], never the `{:?}` of a body or of any
//! field of one ([`LeasedCommand`]'s own `Debug` masks the download address, but shows the
//! command). A failure's detail can carry on-screen labels, so it is not logged either. An HTTP
//! client's error carries the request URL, which for a download is the signed address: a bridge
//! strips it (the client error's `without_url`) before it logs the error.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

pub use jt_devices::{
    CommandError, DeviceCommand, DeviceKey, Element, ElementTarget, FailReason, KEY_WAKEUP,
    MAX_ELEMENTS, MAX_TEXT_CHARS, Observation, Platform, Screen, TEXT_UNICODE, required_features,
    supports,
};

/// The protocol this build speaks (see the crate's notes for what each added).
pub const PROTOCOL_VERSION: u32 = 2;
/// How often a bridge registers, in seconds. The server's answer repeats it.
pub const HEARTBEAT_S: u32 = 15;
/// The longest a command poll may wait, in seconds. The server's answer repeats it.
pub const MAX_WAIT_S: u32 = 25;
/// The most commands one poll returns.
pub const MAX_COMMANDS: u32 = 20;
/// The most results one batch carries.
pub const MAX_RESULTS: usize = 100;
/// The most bytes of a results request body: 2 MiB, the body limit the results route is set to. A
/// bridge splits a batch by its serialized size to stay under it, as well as by [`MAX_RESULTS`]. A
/// single result that is over it alone cannot be sent: the bridge fails that command instead.
pub const MAX_RESULTS_BODY_BYTES: usize = 2 * 1024 * 1024;
/// The most characters in the detail of a failure.
pub const MAX_DETAIL_CHARS: usize = 300;
/// The most bytes in one stream (`stdout`, `stderr`) of a shell result.
pub const MAX_OUTPUT_BYTES: usize = 65_536;
/// The most characters in a bridge id, and in a phone's serial, model or OS version.
pub const MAX_ID_CHARS: usize = 128;
/// The most characters in a bridge's version.
pub const MAX_VERSION_CHARS: usize = 64;
/// The most phones one registration reports.
pub const MAX_PHONES: usize = 16;
/// The most features one phone reports.
pub const MAX_FEATURES: usize = 64;
/// The most characters in one feature name.
pub const MAX_FEATURE_CHARS: usize = 64;
/// The most pixels along either side of a phone's screen (`jt_devices`', which also holds a
/// command's coordinates to it).
pub use jt_devices::MAX_SCREEN_PX;
/// The [`RefusedPhone::reason`] of a phone that was retired and is still plugged in. Unlike any
/// other refusal it is final: a bridge stops listing the phone until it restarts.
pub const PHONE_RETIRED: &str = "phone_retired";
/// The [`RefusedPhone::reason`] of a phone another bridge of the workspace holds: that bridge's
/// latest registration lists it, and is recent. Not final: the bridge keeps listing the phone,
/// and it registers once the other bridge leaves it out or stops registering (two PCs can see a
/// phone of the same serial: every emulator is `emulator-5554`).
pub const PHONE_HELD_BY_ANOTHER_BRIDGE: &str = "phone_held_by_another_bridge";

/// A body that breaks a limit, or that is not the shape the protocol gives it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

impl ProtocolError {
    /// The field that breaks a limit, e.g. `"serial"`.
    pub fn field(&self) -> &'static str {
        match self {
            ProtocolError::Invalid { field, .. } => field,
        }
    }
}

fn invalid(field: &'static str, reason: &'static str) -> ProtocolError {
    ProtocolError::Invalid { field, reason }
}

/// A string with no NUL character.
fn no_nul(field: &'static str, value: &str) -> Result<(), ProtocolError> {
    if value.contains('\0') {
        return Err(invalid(field, "must not contain a NUL character"));
    }
    Ok(())
}

/// Text the server keeps: no NUL character, at most `max` characters.
fn text(
    field: &'static str,
    value: &str,
    max: usize,
    too_long: &'static str,
) -> Result<(), ProtocolError> {
    no_nul(field, value)?;
    if value.chars().count() > max {
        return Err(invalid(field, too_long));
    }
    Ok(())
}

/// [`text`] for a name or an id, which must also carry something.
fn name(
    field: &'static str,
    value: &str,
    max: usize,
    too_long: &'static str,
) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(invalid(field, "must not be blank"));
    }
    text(field, value, max, too_long)
}

/// A screen that is plausible: both sides 1 to [`MAX_SCREEN_PX`] pixels, rotated a quarter turn
/// at a time. `side` and `rotation` are the refusals, worded for what holds the screen.
fn check_screen(
    field: &'static str,
    screen: &Screen,
    side: &'static str,
    rotation: &'static str,
) -> Result<(), ProtocolError> {
    if [screen.w, screen.h]
        .iter()
        .any(|side| !(1..=MAX_SCREEN_PX).contains(side))
    {
        return Err(invalid(field, side));
    }
    if !matches!(screen.rotation, 0 | 90 | 180 | 270) {
        return Err(invalid(field, rotation));
    }
    Ok(())
}

/// What a bridge sends to say it is alive and which phones it sees (every [`HEARTBEAT_S`]).
///
/// Unknown fields are ignored (so are those of [`PhoneReport`]): this is the first thing a bridge
/// sends, before it knows the server's protocol, and a newer bridge's extra optional fields must
/// not make an older server refuse it. Ignored fields are not written back.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegisterIn {
    pub bridge_id: String,
    /// The bridge program's version.
    pub version: String,
    /// The protocol the bridge speaks.
    pub protocol: u32,
    pub phones: Vec<PhoneReport>,
    /// The bridge program's run: drawn at random when it starts, the same on each of its
    /// registers (protocol 2; a bridge of protocol 1 sends none). A phone the latest registration
    /// of a run listed is that run's alone: it is leased to that run's polls only, and only that
    /// run's registers leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<Uuid>,
}

impl RegisterIn {
    /// Whether the body itself respects its limits: the protocol, the bridge id and version, how
    /// many phones, and that no serial appears twice (the bridge routes commands by serial alone,
    /// whatever the platform). A newer `protocol` is not refused: the server answers its own and
    /// decides what to send.
    ///
    /// A phone's own faults are not checked here: they would refuse the whole heartbeat for one
    /// bad phone. The server runs [`PhoneReport::validate`] on each phone and lists the ones it
    /// refuses in [`RegisterOut::refused`].
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol < 1 {
            return Err(invalid("protocol", "must be at least 1"));
        }
        name(
            "bridge_id",
            &self.bridge_id,
            MAX_ID_CHARS,
            "is longer than 128 characters",
        )?;
        name(
            "version",
            &self.version,
            MAX_VERSION_CHARS,
            "is longer than 64 characters",
        )?;
        if self.phones.len() > MAX_PHONES {
            return Err(invalid("phones", "has more than 16 phones"));
        }
        let mut serials = HashSet::new();
        for phone in &self.phones {
            if !serials.insert(phone.serial.as_str()) {
                return Err(invalid("phones", "lists a serial more than once"));
            }
        }
        Ok(())
    }
}

/// One phone a bridge sees. Whatever the bridge cannot tell is left out or `null`. Unknown fields
/// are ignored, as in [`RegisterIn`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PhoneReport {
    pub platform: Platform,
    /// The platform's own id of the phone. Within one registration it names the phone.
    pub serial: String,
    pub model: Option<String>,
    pub os_version: Option<String>,
    pub screen: Option<Screen>,
    /// What the bridge can run on this phone: command kinds and extras such as `text.unicode` (see
    /// [`supports`]).
    pub features: Vec<String>,
}

impl PhoneReport {
    /// Whether the phone respects its limits: a serial, no NUL and at most [`MAX_ID_CHARS`]
    /// characters in the serial, model and OS version (the last two may be blank), a plausible
    /// screen, and at most [`MAX_FEATURES`] named features of [`MAX_FEATURE_CHARS`] characters.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        name(
            "serial",
            &self.serial,
            MAX_ID_CHARS,
            "is longer than 128 characters",
        )?;
        if let Some(model) = &self.model {
            text(
                "model",
                model,
                MAX_ID_CHARS,
                "is longer than 128 characters",
            )?;
        }
        if let Some(os_version) = &self.os_version {
            text(
                "os_version",
                os_version,
                MAX_ID_CHARS,
                "is longer than 128 characters",
            )?;
        }
        if let Some(screen) = &self.screen {
            check_screen(
                "screen",
                screen,
                "has a side outside 1 to 20000 pixels",
                "has a rotation other than 0, 90, 180 or 270",
            )?;
        }
        if self.features.len() > MAX_FEATURES {
            return Err(invalid("features", "has more than 64 features"));
        }
        for feature in &self.features {
            name(
                "features",
                feature,
                MAX_FEATURE_CHARS,
                "has a feature longer than 64 characters",
            )?;
        }
        Ok(())
    }
}

/// The server's answer to a registration, shaped to the protocol the bridge sent.
///
/// A phone that is not in `phones` was not registered, and `refused` says why. No command is
/// queued for it and the bridge does not poll for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterOut {
    /// The phones that registered, each with the capability commands for it are addressed to.
    pub phones: Vec<RegisteredPhone>,
    /// The phones that did not register, each with the reason.
    #[serde(default)]
    pub refused: Vec<RefusedPhone>,
    pub heartbeat_s: u32,
    pub max_wait_s: u32,
    /// The server's protocol, which may be newer than the bridge's.
    pub protocol: u32,
}

impl RegisterOut {
    /// The answer for these phones, with the heartbeat, the longest wait and the protocol this
    /// build owns.
    #[must_use]
    pub fn new(phones: Vec<RegisteredPhone>, refused: Vec<RefusedPhone>) -> RegisterOut {
        RegisterOut {
            phones,
            refused,
            heartbeat_s: HEARTBEAT_S,
            max_wait_s: MAX_WAIT_S,
            protocol: PROTOCOL_VERSION,
        }
    }
}

/// A registered phone: its serial and the capability its commands carry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredPhone {
    pub serial: String,
    pub capability_id: Uuid,
}

/// A phone the server did not register, and why. One phone's refusal never refuses the register:
/// the other phones of the bridge register as usual.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefusedPhone {
    pub platform: Platform,
    pub serial: String,
    /// The refusal in words, e.g. a [`ProtocolError`]'s text, or [`PHONE_RETIRED`] for a phone
    /// that was retired and is still plugged in.
    pub reason: String,
}

/// The query of a command poll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsQuery {
    /// How long the server may hold the poll open when nothing is queued, in seconds.
    pub wait_s: u32,
    /// The most commands to hand out.
    pub limit: u32,
    /// The run of the bridge that polls ([`RegisterIn::instance`]): sent to a server of protocol
    /// 2 or later only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<Uuid>,
}

impl CommandsQuery {
    /// The query within bounds: `wait_s` in `0..=`[`MAX_WAIT_S`] and `limit` in
    /// `1..=`[`MAX_COMMANDS`].
    #[must_use]
    pub fn clamped(self) -> CommandsQuery {
        CommandsQuery {
            wait_s: self.wait_s.min(MAX_WAIT_S),
            limit: self.limit.clamp(1, MAX_COMMANDS),
            instance: self.instance,
        }
    }
}

/// A value `Debug` does not show.
struct Masked;

impl fmt::Debug for Masked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

/// A command handed to a bridge. It may be handed out again (see `jt_devices::REDELIVER_AFTER`):
/// the bridge tells a redelivery from a new command by `id`.
///
/// `Debug` masks the download address, which is signed; it still shows the command, so log
/// [`DeviceCommand::kind`], not this.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeasedCommand {
    pub id: Uuid,
    pub capability_id: Uuid,
    /// The phone the command is for.
    pub serial: String,
    pub command: DeviceCommand,
    /// When the command expires (see `jt_devices::DEFAULT_EXPIRES_IN`). The server decides when a
    /// command is over: the bridge does not compare this with its own clock, which may be wrong.
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    /// Where a `push_file` command's file is downloaded from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
}

impl fmt::Debug for LeasedCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LeasedCommand")
            .field("id", &self.id)
            .field("capability_id", &self.capability_id)
            .field("serial", &self.serial)
            .field("command", &self.command)
            .field("expires_at", &self.expires_at)
            .field("download_url", &self.download_url.as_ref().map(|_| Masked))
            .finish()
    }
}

/// The answer to a command poll.
///
/// A bridge does not decode this body as one value: a command it cannot read (a kind, or a value
/// of a field, that a newer server knows) would make the whole poll unreadable, and the commands
/// beside it with it, on every redelivery. It reads each command apart, with
/// [`CommandsOut::decode_lenient`], runs the readable ones and fails each unreadable one by its id
/// with [`FailReason::UnsupportedByBridge`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsOut {
    pub commands: Vec<LeasedCommand>,
}

/// A poll read one command at a time, by [`CommandsOut::decode_lenient`].
#[derive(Clone, Debug, PartialEq)]
pub struct LenientCommands {
    /// The commands that decode, in the order the server sent them.
    pub commands: Vec<LeasedCommand>,
    /// The id and the message of each command that does not decode but has a readable id, in
    /// order: the bridge fails each one by its id. The message names the problem and can quote a
    /// value from the command: it belongs in a failure's detail (see [`Outcome::failed`]), not in a
    /// log.
    pub unreadable: Vec<(Uuid, String)>,
    /// How many commands were left out because they do not decode and carry no readable id (it is
    /// missing, is not a string or is not a UUID), so there is nothing to fail them by. The
    /// bridge logs the count at warn level.
    pub dropped: usize,
}

impl CommandsOut {
    /// Reads the JSON body of a poll one command at a time: see [`LenientCommands`].
    ///
    /// A body that is not an object with a `commands` array is not a poll: it is an error, not an
    /// empty poll, so that a malformed answer does not look like an idle server. The bridge treats
    /// it as a failed poll, backs off and polls again. Other fields of the body are ignored.
    pub fn decode_lenient(value: serde_json::Value) -> Result<LenientCommands, ProtocolError> {
        let serde_json::Value::Object(mut body) = value else {
            return Err(invalid("body", "is not a JSON object"));
        };
        let Some(serde_json::Value::Array(items)) = body.remove("commands") else {
            return Err(invalid("commands", "is missing or is not an array"));
        };
        let mut read = LenientCommands {
            commands: Vec::new(),
            unreadable: Vec::new(),
            dropped: 0,
        };
        for item in items {
            let id = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok());
            match serde_json::from_value::<LeasedCommand>(item) {
                Ok(command) => read.commands.push(command),
                Err(error) => match id {
                    Some(id) => read.unreadable.push((id, error.to_string())),
                    None => read.dropped += 1,
                },
            }
        }
        Ok(read)
    }
}

/// How a bridge finished a command.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultIn {
    pub command_id: Uuid,
    pub outcome: Outcome,
    /// How long the bridge worked on the command.
    pub duration_ms: u32,
}

/// Done with a result, or failed with a reason. On the wire an object tagged by `status`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Outcome {
    Done {
        result: CommandResult,
    },
    Failed {
        reason: FailReason,
        /// What went wrong, in words: at most [`MAX_DETAIL_CHARS`] characters, no NUL.
        detail: String,
    },
}

impl Outcome {
    /// A failure that is valid by construction: a NUL character in `detail` becomes U+FFFD, and
    /// only its first [`MAX_DETAIL_CHARS`] characters are kept. The detail can carry on-screen
    /// labels, so keep it out of logs.
    #[must_use]
    pub fn failed(reason: FailReason, detail: &str) -> Outcome {
        Outcome::Failed {
            reason,
            detail: detail
                .chars()
                .map(|c| if c == '\0' { '\u{FFFD}' } else { c })
                .take(MAX_DETAIL_CHARS)
                .collect(),
        }
    }
}

/// What a command that was done leaves. On the wire an object tagged by `kind`; an observation
/// carries its own fields next to the tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommandResult {
    /// The screen, for `observe`.
    Observation(Observation),
    /// Nothing to report, e.g. for `tap`. An empty struct variant rather than a unit one: serde
    /// ignores unknown fields on a unit variant of a tagged enum, and this one must refuse them.
    Done {},
    /// A program's exit code and output, for `shell`: at most [`MAX_OUTPUT_BYTES`] bytes a stream,
    /// no NUL. `truncated` says that an output was cut to fit.
    Shell {
        exit_code: i32,
        stdout: String,
        stderr: String,
        #[serde(default)]
        truncated: bool,
    },
    /// A Jeeta file the bridge uploaded, for `screenshot` and `pull_file`.
    File { file_id: Uuid },
}

impl CommandResult {
    /// A shell result that is valid by construction, from the raw output of the program: bytes
    /// that are not UTF-8 and NUL characters become U+FFFD, and each stream is cut to
    /// [`MAX_OUTPUT_BYTES`] bytes on a character boundary: a character that the cap would cut in
    /// two is dropped whole, not left as U+FFFD. `truncated` is set when either was cut.
    #[must_use]
    pub fn shell(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> CommandResult {
        let (stdout, out_cut) = stream_text(stdout);
        let (stderr, err_cut) = stream_text(stderr);
        CommandResult::Shell {
            exit_code,
            stdout,
            stderr,
            truncated: out_cut || err_cut,
        }
    }
}

/// `bytes` without a character that is cut short at its end: the first bytes of a multi-byte
/// character, whose other bytes are missing. A lossy conversion would turn them into a stray
/// U+FFFD. Bytes that are invalid in themselves are kept, so they are replaced as everywhere else.
fn without_partial_char(bytes: &[u8]) -> &[u8] {
    let Some(last) = bytes.utf8_chunks().last() else {
        return bytes;
    };
    let tail = last.invalid();
    match std::str::from_utf8(tail) {
        Err(error) if error.error_len().is_none() => &bytes[..bytes.len() - tail.len()],
        _ => bytes,
    }
}

/// The text of one output stream, and whether it was cut.
fn stream_text(bytes: &[u8]) -> (String, bool) {
    // Turning bytes into text never makes them shorter (a bad byte or a NUL becomes three), so
    // the first `MAX_OUTPUT_BYTES` bytes are all that can be kept: no need to convert the rest.
    let mut cut = bytes.len() > MAX_OUTPUT_BYTES;
    let mut head = &bytes[..bytes.len().min(MAX_OUTPUT_BYTES)];
    if cut {
        // The cap may fall inside a character: drop the bytes of that character that fit, rather
        // than let the conversion leave a U+FFFD for them.
        head = without_partial_char(head);
    }
    let mut text = String::from_utf8_lossy(head).replace('\0', "\u{FFFD}");
    if text.len() > MAX_OUTPUT_BYTES {
        let mut end = MAX_OUTPUT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        cut = true;
    }
    (text, cut)
}

/// A batch of results (at most [`MAX_RESULTS`], and [`MAX_RESULTS_BODY_BYTES`] serialized).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultsIn {
    pub results: Vec<ResultIn>,
}

impl ResultsIn {
    /// Whether the batch respects its limits: one to [`MAX_RESULTS`] results, a command once, and
    /// in each result no NUL character in a string and
    ///
    /// - a failure's detail within [`MAX_DETAIL_CHARS`] characters,
    /// - each shell stream within [`MAX_OUTPUT_BYTES`] bytes,
    /// - an observation within [`MAX_ELEMENTS`] elements, with a plausible screen and every string
    ///   (the app, an element's text, id, description and class) within [`MAX_TEXT_CHARS`]
    ///   characters.
    ///
    /// The size of the body is the transport's limit, [`MAX_RESULTS_BODY_BYTES`]. A batch refused
    /// here is refused for good: do not retry it as it is.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.results.is_empty() {
            return Err(invalid("results", "must have at least one result"));
        }
        if self.results.len() > MAX_RESULTS {
            return Err(invalid("results", "has more than 100 results"));
        }
        let mut commands = HashSet::new();
        for result in &self.results {
            if !commands.insert(result.command_id) {
                return Err(invalid("command_id", "appears more than once in the batch"));
            }
            match &result.outcome {
                Outcome::Failed { detail, .. } => text(
                    "detail",
                    detail,
                    MAX_DETAIL_CHARS,
                    "is longer than 300 characters",
                )?,
                Outcome::Done { result } => match result {
                    CommandResult::Shell { stdout, stderr, .. } => {
                        stream("stdout", stdout)?;
                        stream("stderr", stderr)?;
                    }
                    CommandResult::Observation(seen) => check_observation(seen)?,
                    CommandResult::Done {} | CommandResult::File { .. } => {}
                },
            }
        }
        Ok(())
    }
}

/// One shell output stream: no NUL character, at most [`MAX_OUTPUT_BYTES`] bytes.
fn stream(field: &'static str, value: &str) -> Result<(), ProtocolError> {
    no_nul(field, value)?;
    if value.len() > MAX_OUTPUT_BYTES {
        return Err(invalid(field, "is longer than 65536 bytes"));
    }
    Ok(())
}

/// An observation a server can keep: [`MAX_ELEMENTS`] elements at most, a plausible screen, and
/// every string within [`MAX_TEXT_CHARS`] characters with no NUL character.
fn check_observation(seen: &Observation) -> Result<(), ProtocolError> {
    if seen.elements.len() > MAX_ELEMENTS {
        return Err(invalid("observation", "has more than 300 elements"));
    }
    check_screen(
        "observation",
        &seen.screen,
        "has a screen with a side outside 1 to 20000 pixels",
        "has a screen with a rotation other than 0, 90, 180 or 270",
    )?;
    let element_strings = seen
        .elements
        .iter()
        .flat_map(|e| [&e.text, &e.id, &e.desc, &e.class])
        .flatten();
    for value in seen.foreground_app.iter().chain(element_strings) {
        text(
            "observation",
            value,
            MAX_TEXT_CHARS,
            "has a text longer than 4000 characters",
        )?;
    }
    Ok(())
}

/// How the server took a batch: results applied, results it already had, and results naming a
/// command it does not know. The three counts add up to the number of results in the batch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultsOut {
    pub applied: u32,
    pub duplicates: u32,
    pub unknown: u32,
}

/// The answer to a file upload: the Jeeta file it became.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileOut {
    pub file_id: Uuid,
}
