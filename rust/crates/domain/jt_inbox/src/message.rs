//! Message records and delivery outcomes, including uncertain provider acceptance.

use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{ConversationId, MessageId, epoch};

/// Which side sent a message, relative to the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// A message arriving from the person.
    Inbound,
    /// A message sent by the workspace.
    Outbound,
}

/// The message's author, independent of the conversation's current executor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Author {
    /// The person on the other side of the conversation.
    Customer,
    /// An agent acting for the workspace.
    Agent,
    /// A specific workspace user.
    Human(UserId),
    /// A system-produced message; the default when old storage omits the author.
    #[default]
    System,
}

/// The known delivery state; uncertain delivery must never trigger a blind resend.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MsgStatus {
    /// An inbound message received from the provider.
    Received,
    /// An outbound message waiting to be sent.
    Queued,
    /// The provider accepted an outbound message.
    Sent,
    /// The provider confirmed delivery.
    Delivered,
    /// A definite delivery failure.
    Failed,
    /// Acceptance or delivery is uncertain; also the safe default for missing stored status.
    #[default]
    Unknown,
    /// A send fence refused the message before provider I/O.
    Refused {
        /// The domain refusal reason, without personal message bodies or secrets.
        reason: String,
    },
}

/// One message in a tenant's conversation, preserving the original author and delivery result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    /// The message's id.
    pub id: MessageId,
    /// The tenant that owns the message.
    pub workspace_id: WorkspaceId,
    /// The conversation containing the message.
    pub conversation_id: ConversationId,
    /// Whether the message arrived or was sent.
    pub direction: Direction,
    /// Who authored it; missing reads as `System`.
    #[serde(default)]
    pub author: Author,
    /// The message body; missing reads as empty.
    #[serde(default)]
    pub body: String,
    /// The provider message id, if known; missing reads as `None`.
    #[serde(default)]
    pub external_id: Option<String>,
    /// The delivery state; missing reads as `Unknown`, never an instruction to resend.
    #[serde(default)]
    pub status: MsgStatus,
    /// Cost in minor currency units, if known; missing reads as `None`, not zero.
    #[serde(default)]
    pub cost_minor: Option<i64>,
    /// When the message occurred; missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}
