//! The voice bridge's HTTP bodies (spec `2026-10-27-agent-voice-calls-design.md` §10, routes
//! `/api/voice/bridge/*`), shared by the server (`jt_app::usecases::calls::bridge`, which re-exports
//! them under these names) and the bridge program (`jeeta-voice-bridge`), so that the two cannot
//! drift. Each type reads and writes both ways: the server reads what the bridge writes and the
//! bridge reads what the server writes. The limits are the server's; these types carry shapes only.

use jt_capability::{CapabilityId, EffectiveStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;

use crate::session::{BridgeEvent, Command};
use crate::{CallCommandId, CallId};

/// The bridge's speech-to-text engine and its model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechToText {
    pub engine: String,
    pub model: String,
}

/// The bridge's text-to-speech engine and its voice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextToSpeech {
    pub engine: String,
    pub voice: String,
}

/// `calls.bridge.register`: what the bridge reports of itself. `extension` is its PBX extension
/// (1 to 16 digits), `codecs` at most 8 names (`[A-Za-z0-9._-]`, 1 to 16 characters each),
/// `max_calls` how many calls it carries at once (1 to 8), the engines' names 1 to 32 characters
/// of `[a-z0-9_-]`, the model, voice and version 1 to 128 characters without control characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterInput {
    pub extension: String,
    #[serde(default)]
    pub codecs: Vec<String>,
    pub max_calls: u8,
    pub stt: SpeechToText,
    pub tts: TextToSpeech,
    pub version: String,
}

/// What a registration answers: the bridge's capability, its status now, and how often to
/// register again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterOut {
    pub capability_id: CapabilityId,
    pub status: EffectiveStatus,
    pub heartbeat_s: u32,
}

/// `calls.bridge.commands`: how long to wait for a command (at most 25 seconds, which is also
/// what an absent `wait_s` waits; more is cut to it), and which bridge is asking (its extension;
/// the workspace's only bridge when left out).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_s: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
}

/// A command as the bridge takes it: `kind` names it (`dial`, `play`, `say`, `hangup`, ...) and
/// `payload` carries the rest of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeCommand {
    pub id: CallCommandId,
    pub call_id: CallId,
    pub bridge_call_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

impl BridgeCommand {
    /// Command `command` (id `id`, of call `call_id`, which the bridge knows as `bridge_call_id`)
    /// as a poll hands it out: its `kind` apart, its other fields in `payload`.
    pub fn of(
        id: CallCommandId,
        call_id: CallId,
        bridge_call_id: Option<String>,
        command: &Command,
    ) -> BridgeCommand {
        let mut payload =
            serde_json::to_value(command).unwrap_or_else(|_| Value::Object(Map::new()));
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("kind");
        }
        BridgeCommand {
            id,
            call_id,
            bridge_call_id,
            kind,
            payload,
        }
    }

    /// The command, read back from its kind and fields; an error for a kind or a field this build
    /// does not know.
    pub fn command(&self) -> Result<Command, serde_json::Error> {
        let mut fields = match &self.payload {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        fields.insert("kind".to_owned(), Value::String(self.kind.clone()));
        serde_json::from_value(Value::Object(fields))
    }
}

/// What a poll answers: the commands now the bridge's, oldest first, and whether it waited its
/// whole time for none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandsOut {
    pub commands: Vec<BridgeCommand>,
    pub timed_out: bool,
}

/// One event the bridge reports: its id of the call, the event's number in that call (the bridge
/// counts up from 1), when it happened, and what it is (`kind` and its fields, as [`BridgeEvent`]
/// reads them).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventIn {
    pub bridge_call_id: String,
    pub bridge_seq: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    #[serde(flatten)]
    pub event: BridgeEvent,
}

/// `calls.bridge.events`: at most 100 events, of any of the bridge's calls.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsInput {
    pub events: Vec<EventIn>,
}

/// What a batch did: the events applied now, those applied before (a retry), and those of a call
/// the bridge has no session for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventsOut {
    pub accepted: u32,
    pub duplicates: u32,
    pub unmatched: u32,
}
