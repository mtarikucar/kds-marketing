//! The wire between the Jeeta server and a device bridge (spec `2026-10-28-device-bridge-design.md`
//! §2 and §5): the bodies the bridge sends and receives, and the limits the server holds them to.
//! The server and the bridge program compile against these same types, so they cannot drift. Pure:
//! no platform, database, HTTP or clock I/O, and no workspace crate but `jt_devices` (whose
//! vocabulary is re-exported, so a bridge has one import path for it).
//!
//! # Versions
//!
//! [`PROTOCOL_VERSION`] counts the shapes of the structs here. The bridge sends its protocol in
//! [`RegisterIn`] and the server answers its own in [`RegisterOut`]. Every struct refuses unknown
//! fields, on both sides, so each side sends only the fields and kinds that the LOWER of the two
//! protocol versions defines.
//!
//! - A new [`FailReason`] needs no bump: an older reader takes it as [`FailReason::Unknown`] (see
//!   `jt_devices`).
//! - A new command kind or field needs a feature name (a bridge reports what it runs, and the
//!   server queues a kind only for a bridge that lists it), and a protocol bump when it changes a
//!   struct here.
//!
//! # Logging
//!
//! These bodies carry commands, typed text, shell output, screen text and a signed download
//! address. Log counts, ids and [`DeviceCommand::kind`], never the `{:?}` of a body or of any
//! field of one.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

pub use jt_devices::{DeviceCommand, FailReason, Observation, Platform, Screen};

/// The protocol this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// How often a bridge registers, in seconds. The server's answer repeats it.
pub const HEARTBEAT_S: u32 = 15;
/// The longest a command poll may wait, in seconds. The server's answer repeats it.
pub const MAX_WAIT_S: u32 = 25;
/// The most commands one poll returns.
pub const MAX_COMMANDS: u32 = 20;
/// The most results one batch carries.
pub const MAX_RESULTS: usize = 100;
/// The most characters in the detail of a failure.
pub const MAX_DETAIL_CHARS: usize = 300;
/// The most bytes in one stream (`stdout`, `stderr`) of a shell result.
pub const MAX_OUTPUT_BYTES: usize = 65_536;
/// The most characters in a bridge id or a phone's serial.
pub const MAX_ID_CHARS: usize = 128;
/// The most characters in a bridge's version.
pub const MAX_VERSION_CHARS: usize = 64;
/// The most phones one registration reports.
pub const MAX_PHONES: usize = 16;
/// The most features one phone reports.
pub const MAX_FEATURES: usize = 64;
/// The most characters in one feature name.
pub const MAX_FEATURE_CHARS: usize = 64;

/// A body that breaks a limit.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

fn invalid(field: &'static str, reason: &'static str) -> ProtocolError {
    ProtocolError::Invalid { field, reason }
}

/// A name or an id the server keeps: not blank, no NUL character, at most `max` characters.
fn name(
    field: &'static str,
    value: &str,
    max: usize,
    too_long: &'static str,
) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(invalid(field, "must not be blank"));
    }
    if value.contains('\0') {
        return Err(invalid(field, "must not contain a NUL character"));
    }
    if value.chars().count() > max {
        return Err(invalid(field, too_long));
    }
    Ok(())
}

/// What a bridge sends to say it is alive and which phones it sees (every [`HEARTBEAT_S`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterIn {
    pub bridge_id: String,
    /// The bridge program's version.
    pub version: String,
    /// The protocol the bridge speaks.
    pub protocol: u32,
    pub phones: Vec<PhoneReport>,
}

impl RegisterIn {
    /// Whether the registration respects its limits. A newer `protocol` is not refused here: the
    /// server answers its own and decides what to send.
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
        let mut seen = HashSet::new();
        for phone in &self.phones {
            name(
                "serial",
                &phone.serial,
                MAX_ID_CHARS,
                "is longer than 128 characters",
            )?;
            if !seen.insert((phone.platform.key(), phone.serial.as_str())) {
                return Err(invalid("phones", "lists a phone more than once"));
            }
            if phone.features.len() > MAX_FEATURES {
                return Err(invalid("features", "has more than 64 features"));
            }
            for feature in &phone.features {
                name(
                    "features",
                    feature,
                    MAX_FEATURE_CHARS,
                    "has a feature longer than 64 characters",
                )?;
            }
        }
        Ok(())
    }
}

/// One phone a bridge sees. Whatever the bridge cannot tell is left out or `null`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhoneReport {
    pub platform: Platform,
    /// The platform's own id of the phone; with the platform it names the phone.
    pub serial: String,
    pub model: Option<String>,
    pub os_version: Option<String>,
    pub screen: Option<Screen>,
    /// What the bridge can run on this phone: command kinds and extras such as `text.unicode` (see
    /// `jt_devices::supports`).
    pub features: Vec<String>,
}

/// The server's answer to a registration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterOut {
    /// The phones that registered, each with the capability commands for it are addressed to.
    pub phones: Vec<RegisteredPhone>,
    pub heartbeat_s: u32,
    pub max_wait_s: u32,
    /// The server's protocol, which may be newer than the bridge's.
    pub protocol: u32,
}

/// A registered phone: its serial and the capability its commands carry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredPhone {
    pub serial: String,
    pub capability_id: Uuid,
}

/// The query of a command poll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsQuery {
    /// How long the server may hold the poll open when nothing is queued, in seconds.
    pub wait_s: u32,
    /// The most commands to hand out.
    pub limit: u32,
}

impl CommandsQuery {
    /// The query within bounds: `wait_s` in `0..=`[`MAX_WAIT_S`] and `limit` in
    /// `1..=`[`MAX_COMMANDS`].
    #[must_use]
    pub fn clamped(self) -> CommandsQuery {
        CommandsQuery {
            wait_s: self.wait_s.min(MAX_WAIT_S),
            limit: self.limit.clamp(1, MAX_COMMANDS),
        }
    }
}

/// A command handed to a bridge. It may be handed out again (see `jt_devices::REDELIVER_AFTER`):
/// the bridge tells a redelivery from a new command by `id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeasedCommand {
    pub id: Uuid,
    pub capability_id: Uuid,
    /// The phone the command is for.
    pub serial: String,
    pub command: DeviceCommand,
    /// When the command expires (see `jt_devices::DEFAULT_EXPIRES_IN`).
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    /// Where a `push_file` command's file is downloaded from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
}

/// The answer to a command poll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsOut {
    pub commands: Vec<LeasedCommand>,
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
        /// What went wrong, in words: at most [`MAX_DETAIL_CHARS`] characters.
        detail: String,
    },
}

/// What a command that was done leaves. On the wire an object tagged by `kind`; an observation
/// carries its own fields next to the tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommandResult {
    /// The screen, for `observe`.
    Observation(Observation),
    /// Nothing to report, e.g. for `tap`. An empty struct variant rather than a unit one: serde ignores unknown
    /// fields on a unit variant of a tagged enum, and this one must refuse them.
    Done {},
    /// A program's exit code and output, for `shell`: at most [`MAX_OUTPUT_BYTES`] bytes a stream.
    Shell {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    /// A Jeeta file the bridge uploaded, for `screenshot` and `pull_file`.
    File { file_id: Uuid },
}

/// A batch of results (at most [`MAX_RESULTS`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultsIn {
    pub results: Vec<ResultIn>,
}

impl ResultsIn {
    /// Whether the batch respects its limits: one to [`MAX_RESULTS`] results, a command once, a
    /// failure's detail within [`MAX_DETAIL_CHARS`] characters and each shell stream within
    /// [`MAX_OUTPUT_BYTES`] bytes.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.results.is_empty() {
            return Err(invalid("results", "must have at least one result"));
        }
        if self.results.len() > MAX_RESULTS {
            return Err(invalid("results", "has more than 100 results"));
        }
        let mut seen = HashSet::new();
        for result in &self.results {
            if !seen.insert(result.command_id) {
                return Err(invalid("command_id", "appears more than once in the batch"));
            }
            match &result.outcome {
                Outcome::Failed { detail, .. } => {
                    if detail.chars().count() > MAX_DETAIL_CHARS {
                        return Err(invalid("detail", "is longer than 300 characters"));
                    }
                }
                Outcome::Done {
                    result: CommandResult::Shell { stdout, stderr, .. },
                } => {
                    if stdout.len() > MAX_OUTPUT_BYTES {
                        return Err(invalid("stdout", "is longer than 65536 bytes"));
                    }
                    if stderr.len() > MAX_OUTPUT_BYTES {
                        return Err(invalid("stderr", "is longer than 65536 bytes"));
                    }
                }
                Outcome::Done { .. } => {}
            }
        }
        Ok(())
    }
}

/// How the server took a batch: results applied, results it already had, and results naming a
/// command it does not know.
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
