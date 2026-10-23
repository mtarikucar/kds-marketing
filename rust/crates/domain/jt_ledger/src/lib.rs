//! Ledger domain: append-only ledger entries, actors and actions. Pure, no I/O.

use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

/// Payload keys whose values `LedgerEntry::redacted` masks. A key matches only by its exact
/// name, compared case-insensitively: `token` is masked, `token_count` is not.
const SECRET_KEYS: &[&str] = &[
    "password",
    "token",
    "secret",
    "api_key",
    "access_token",
    "refresh_token",
    "apikey",
    "authorization",
    "client_secret",
    "key_hash",
    "token_hash",
    "invite_token",
    "plaintext",
];

/// What a redacted value is replaced with.
const MASK: &str = "***";

/// A ledger rule refused the input.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LedgerError {
    /// The action name is not dot-separated, non-empty segments of lowercase `[a-z0-9_]`, with at
    /// least two segments.
    #[error("invalid ledger action: {0:?}")]
    InvalidAction(String),
}

/// Who performed an action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Actor {
    /// A signed-in user acting through the panel.
    Human { user_id: UserId },
    /// An agent acting through a connection; `user_id` is the user who issued that connection, so
    /// the authority behind the action stays auditable.
    Agent {
        connection_id: AgentConnectionId,
        user_id: UserId,
    },
    /// A component of the system itself, e.g. a scheduler.
    System { component: String },
}

/// A dotted action name such as `team.invite` or `mcp.tool_call`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct Action(String);

impl Action {
    /// Accepts two or more `.`-separated segments, each one or more lowercase ASCII letters,
    /// digits or `_`: `team.invite` and `mcp.tool_call`, but not `team`, `.team`, `team.` or
    /// `team..invite`.
    pub fn new(s: &str) -> Result<Action, LedgerError> {
        let segment_ok = |seg: &str| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        let valid = s.contains('.') && s.split('.').all(segment_ok);
        if valid {
            Ok(Action(s.to_owned()))
        } else {
            Err(LedgerError::InvalidAction(s.to_owned()))
        }
    }

    /// The action name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Action {
    type Error = LedgerError;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        Action::new(&s)
    }
}

/// What an action was performed on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subject {
    pub kind: String,
    pub id: String,
}

/// One append-only record of something that happened in a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub workspace_id: WorkspaceId,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub actor: Actor,
    pub action: Action,
    pub subject: Option<Subject>,
    pub payload: Value,
    pub strategy_version_id: Option<Uuid>,
}

impl LedgerEntry {
    /// An entry with no subject and no strategy version; set those fields directly when needed.
    pub fn new(
        workspace_id: WorkspaceId,
        actor: Actor,
        action: Action,
        payload: Value,
        at: OffsetDateTime,
    ) -> Self {
        LedgerEntry {
            workspace_id,
            at,
            actor,
            action,
            subject: None,
            payload,
            strategy_version_id: None,
        }
    }

    /// A copy whose payload has the value of every secret key (`password`, `token`, `secret`,
    /// `api_key`, `access_token`, `refresh_token`, `apikey`, `authorization`, `client_secret`,
    /// `key_hash`, `token_hash`, `invite_token`, `plaintext`; exact name, any case, at any depth,
    /// including inside arrays) replaced with `"***"`.
    pub fn redacted(&self) -> LedgerEntry {
        let mut copy = self.clone();
        redact(&mut copy.payload);
        copy
    }
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if SECRET_KEYS.iter().any(|s| key.eq_ignore_ascii_case(s)) {
                    *v = Value::String(MASK.to_owned());
                } else {
                    redact(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}
