//! The first-message drafts (`usecases::prospects::draft`): the model port the server asks for a
//! draft of the first message to a prospect, for a person to read, change and send.
//!
//! A draft is never sent by the server: it is only text handed to the panel. With no model
//! configured (`ConnectorRegistry::draft_model` is `None`) there is no draft and the message field
//! stays empty. Every detail of a provider's API stays in its adapter; here are only these neutral
//! types. The usage and the errors are the automatic replies' ([`Usage`], [`ModelError`]).

use async_trait::async_trait;

pub use super::reply_model::{ModelError, Usage};

/// The most drafts one workspace may ask for per UTC day.
pub const DRAFTS_PER_WORKSPACE_DAILY: u32 = 100;
/// The most output tokens one draft may take (its thinking included).
pub const DRAFT_MAX_TOKENS: u32 = 1_024;

/// What the draft is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftShape {
    /// An email: a subject and a short body with a greeting and a sign-off.
    Email,
    /// SMS, WhatsApp or a direct message: two or three short sentences, no subject.
    Short,
}

/// What the model is asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftRequest {
    /// The instructions every workspace shares (a constant of the use case).
    pub system_fixed: String,
    /// The workspace's part: who the business is, its cards, its prohibitions as hard rules.
    pub system_workspace: String,
    /// The prospect's stored facts, the channel and the language, as the one user turn.
    pub prospect: String,
    pub shape: DraftShape,
    pub max_tokens: u32,
}

/// The draft: a subject only for an email.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub subject: Option<String>,
    pub body: String,
}

/// The model's answer: a draft only from a clear tool call (none on a refusal or a cut answer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftAnswer {
    pub draft: Option<Draft>,
    pub usage: Usage,
}

/// The model the first-message drafts ask.
#[async_trait]
pub trait DraftModel: Send + Sync {
    /// The model's id, recorded with each call.
    fn model(&self) -> &str;
    async fn draft(&self, request: &DraftRequest) -> Result<DraftAnswer, ModelError>;
}
