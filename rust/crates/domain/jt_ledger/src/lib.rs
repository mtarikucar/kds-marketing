//! Ledger domain: append-only ledger entries, actors and actions. Pure, no I/O.

use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

/// Payload keys whose values `LedgerEntry::redacted` masks (compared case-insensitively).
const SECRET_KEYS: &[&str] = &["password", "token", "secret", "api_key"];

/// What a redacted value is replaced with.
const MASK: &str = "***";

/// A ledger rule refused the input.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LedgerError {
    /// The action name is not lowercase `[a-z0-9_.]` with at least one inner dot.
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
    /// Accepts lowercase ASCII letters, digits, `_` and `.`, with at least one `.` and none at
    /// either end.
    pub fn new(s: &str) -> Result<Action, LedgerError> {
        let allowed =
            |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.';
        let valid =
            s.chars().all(allowed) && s.contains('.') && !s.starts_with('.') && !s.ends_with('.');
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

    /// A copy whose payload has the value of every `password`, `token`, `secret` or `api_key` key
    /// (any case, at any depth, including inside arrays) replaced with `"***"`.
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
